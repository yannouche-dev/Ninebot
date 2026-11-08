#!/usr/bin/env python3
"""Agent videogen exécuté sur l'instance GPU (bibliothèque standard uniquement).

Sous-commandes :
  serve          serveur HTTP local (127.0.0.1:28189, derrière Caddy) + watchdog
  mark STEP STATE [MSG]   enregistre l'état d'une étape de démarrage
  fetch-models   télécharge les poids manquants via `hf download` et publie la progression

Routes (préfixe /videogen, jeton vérifié par Caddy) :
  GET  /videogen/status         étapes, progression des modèles, tunnel, watchdog, disque
  GET  /videogen/log?tail=N     fin du journal de démarrage (secrets masqués)
  POST /videogen/files/delete   {"files":[{"filename","subfolder","type"}]} supprime des sorties
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VG_HOME = os.environ.get("VG_HOME", "/workspace/videogen")
SRC = os.path.join(VG_HOME, "src")
RUN = os.path.join(VG_HOME, "run")
LOGS = os.path.join(VG_HOME, "logs")
COMFY_DIR = os.environ.get("COMFY_DIR", os.path.join(VG_HOME, "ComfyUI"))
COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:28188")
VAST_API_BASE = os.environ.get("VAST_API_BASE", "https://console.vast.ai")
HF_BASE = os.environ.get("HF_BASE", "https://huggingface.co")
AGENT_PORT = int(os.environ.get("AGENT_PORT", "28189"))
DRY_RUN = os.environ.get("VG_DRY_RUN") == "1"

STEPS = ["tools", "tunnel", "comfy_install", "comfy_start", "models", "ready"]


def env_int(name, default):
    try:
        return int(float(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


IDLE_MINUTES = float(os.environ.get("IDLE_MINUTES", "20") or 20)
MAX_HOURS = float(os.environ.get("MAX_HOURS", "4") or 4)
OUTPUT_TTL_MIN = env_int("OUTPUT_TTL_MINUTES", 120)
WATCHDOG_PERIOD = env_int("WATCHDOG_PERIOD_SECONDS", 30)


def secrets():
    vals = []
    for k in ("COMFY_ACCESS_TOKEN", "HF_TOKEN", "CONTAINER_API_KEY"):
        v = os.environ.get(k, "")
        if len(v) >= 8:
            vals.append(v)
    return vals


def mask(text):
    for s in secrets():
        text = text.replace(s, s[:3] + "…" + s[-4:] if len(s) > 12 else "***")
    return text


def now():
    return time.time()


def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp%d" % os.getpid()
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def read_text(path, default=""):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return default


def publish(line):
    """Écrit une ligne lisible par l'interface dans les logs du conteneur (docker logs)."""
    line = mask(line)
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    try:
        os.makedirs(LOGS, exist_ok=True)
        with open(os.path.join(LOGS, "onstart.log"), "a", encoding="utf-8") as f:
            f.write("%s %s\n" % (stamp, line))
    except OSError:
        pass
    try:
        with open(os.environ.get("VG_PUBLISH_TO", "/proc/1/fd/1"), "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


# --------------------------------------------------------------------------- étapes

def mark(step, state, msg=""):
    path = os.path.join(RUN, "steps.json")
    steps = read_json(path, {})
    steps[step] = {"state": state, "msg": msg, "ts": now()}
    write_json(path, steps)


# --------------------------------------------------------------------------- modèles

def load_weights():
    return read_json(os.path.join(SRC, "weights.json"), {"families": {}})


def enabled_families():
    raw = os.environ.get("MODELS", "ltx25")
    return [f.strip() for f in raw.split(",") if f.strip()]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def hf_file_size(repo, path):
    """Taille attendue d'un fichier HF (HEAD sans suivre la redirection). Retourne (taille, erreur)."""
    url = "%s/%s/resolve/main/%s" % (HF_BASE, repo, path)
    req = urllib.request.Request(url, method="HEAD")
    tok = os.environ.get("HF_TOKEN", "")
    if tok:
        req.add_header("Authorization", "Bearer " + tok)
    opener = urllib.request.build_opener(NoRedirect)
    try:
        resp = opener.open(req, timeout=30)
        headers = resp.headers
        status = resp.status
    except urllib.error.HTTPError as e:
        headers = e.headers
        status = e.code
    except Exception as e:  # réseau
        return None, "réseau : %s" % e
    if status in (401, 403):
        return None, ("accès refusé à %s : accepte la licence sur %s/%s avec le compte du token "
                      "Hugging Face (HTTP %d)" % (repo, HF_BASE, repo, status))
    if status == 404:
        return None, "fichier introuvable : %s/%s" % (repo, path)
    size = headers.get("X-Linked-Size") or headers.get("Content-Length")
    try:
        return int(size), None
    except (TypeError, ValueError):
        return None, None


def dir_bytes(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def fetch_models():
    weights = load_weights()
    fams = enabled_families()
    files = []
    for fam in fams:
        spec = weights.get("families", {}).get(fam)
        if not spec:
            continue
        for item in spec.get("files", []):
            files.append(dict(item, family=fam))
    state = {"state": "running", "families": fams, "files": [], "total_bytes": 0, "done_bytes": 0,
             "started": now(), "error": None}
    out_path = os.path.join(RUN, "models.json")
    for f in files:
        dest = os.path.join(COMFY_DIR, "models", f["dir"], os.path.basename(f["path"]))
        state["files"].append({"family": f["family"], "repo": f["repo"], "path": f["path"],
                               "name": os.path.basename(f["path"]), "dest": dest, "size": None,
                               "done": 0, "state": "pending", "error": None})
    write_json(out_path, state)

    # Tailles attendues (et détection précoce d'un dépôt protégé non accepté).
    for f in state["files"]:
        size, err = hf_file_size(f["repo"], f["path"])
        f["size"] = size
        if os.path.exists(f["dest"]) and os.path.getsize(f["dest"]) > 0 and \
                (size is None or os.path.getsize(f["dest"]) == size):
            f["state"] = "done"
            f["done"] = os.path.getsize(f["dest"])
        elif err:
            f["state"] = "error"
            f["error"] = err
    state["total_bytes"] = sum(f["size"] or f["done"] for f in state["files"])
    write_json(out_path, state)

    missing = [f for f in state["files"] if f["state"] == "pending"]
    need = sum(f["size"] or 0 for f in missing)
    os.makedirs(os.path.join(COMFY_DIR, "models"), exist_ok=True)
    free = shutil.disk_usage(os.path.join(COMFY_DIR, "models")).free
    if need and free < need + 2 * 1024 ** 3:
        state["state"] = "error"
        state["error"] = ("disque insuffisant : %.1f Go nécessaires, %.1f Go libres — augmente la taille "
                          "du disque ou désactive une famille de modèles" % (need / 1e9, free / 1e9))
        write_json(out_path, state)
        return 2

    hf_bin = os.environ.get("HF_BIN") or shutil.which("hf") or "hf"
    staging_root = os.path.join(VG_HOME, "staging")
    env = dict(os.environ, HF_XET_HIGH_PERFORMANCE="1", HF_HUB_DISABLE_TELEMETRY="1",
               HF_HUB_DISABLE_PROGRESS_BARS="1")

    for f in missing:
        f["state"] = "downloading"
        staging = os.path.join(staging_root, f["repo"].replace("/", "__"))
        os.makedirs(staging, exist_ok=True)
        ok = False
        for attempt in range(1, 4):
            stop = threading.Event()

            def progress(fref=f, sdir=staging, ev=stop):
                while not ev.wait(2):
                    fref["done"] = min(dir_bytes(sdir), fref["size"] or 1 << 62)
                    state["done_bytes"] = sum(x["done"] for x in state["files"])
                    write_json(out_path, state)

            t = threading.Thread(target=progress, daemon=True)
            t.start()
            cmd = [hf_bin, "download", f["repo"], f["path"], "--local-dir", staging]
            proc = subprocess.run(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                  text=True)
            stop.set()
            t.join()
            src = os.path.join(staging, f["path"])
            if proc.returncode == 0 and os.path.exists(src):
                os.makedirs(os.path.dirname(f["dest"]), exist_ok=True)
                shutil.move(src, f["dest"])
                f["done"] = os.path.getsize(f["dest"])
                f["size"] = f["size"] or f["done"]
                f["state"] = "done"
                f["error"] = None
                ok = True
                break
            tail = mask((proc.stdout or "")[-600:])
            f["error"] = "échec du téléchargement (tentative %d/3) : %s" % (attempt, tail)
            publish("VIDEOGEN_MODEL_ERROR=%s %s" % (f["name"], f["error"][:200].replace("\n", " ")))
            write_json(out_path, state)
            time.sleep(5 * attempt)
        if not ok:
            f["state"] = "error"
        shutil.rmtree(staging, ignore_errors=True)
        state["total_bytes"] = sum(x["size"] or x["done"] for x in state["files"])
        state["done_bytes"] = sum(x["done"] for x in state["files"])
        write_json(out_path, state)

    errors = [f for f in state["files"] if f["state"] == "error"]
    state["state"] = "error" if errors else "done"
    if errors:
        state["error"] = "; ".join("%s : %s" % (f["name"], (f["error"] or "")[:160]) for f in errors)[:1500]
    state["finished"] = now()
    write_json(out_path, state)
    return 1 if errors else 0


# --------------------------------------------------------------------------- watchdog

class Watchdog:
    def __init__(self):
        self.idle_since = None
        self.stop_at = None
        self.reason = None
        self.triggered = False
        self.last_error = None
        self.lock = threading.Lock()

    def boot_ts(self):
        try:
            return float(read_text(os.path.join(RUN, "boot_ts"), str(now())))
        except ValueError:
            return now()

    def counting(self):
        steps = read_json(os.path.join(RUN, "steps.json"), {})
        models = steps.get("models", {}).get("state")
        if models in ("done", "error"):
            return True
        return any(v.get("state") == "error" for v in steps.values())

    def queue_busy(self):
        try:
            with urllib.request.urlopen(COMFY_URL + "/queue", timeout=10) as r:
                q = json.load(r)
            return bool(q.get("queue_running")) or bool(q.get("queue_pending"))
        except Exception:
            return False

    def snapshot(self):
        boot = self.boot_ts()
        max_at = boot + MAX_HOURS * 3600 if MAX_HOURS > 0 else None
        idle_at = self.idle_since + IDLE_MINUTES * 60 if (self.idle_since and IDLE_MINUTES > 0) else None
        candidates = [t for t in (max_at, idle_at) if t]
        return {"idle_minutes": IDLE_MINUTES, "max_hours": MAX_HOURS, "boot_ts": boot,
                "idle_since": self.idle_since, "stop_at": min(candidates) if candidates else None,
                "triggered": self.triggered, "reason": self.reason, "error": self.last_error,
                "dry_run": DRY_RUN}

    def tick(self):
        t = now()
        if MAX_HOURS > 0 and t - self.boot_ts() >= MAX_HOURS * 3600:
            return self.trigger("durée maximale atteinte (%g h)" % MAX_HOURS)
        purge_old_files(OUTPUT_TTL_MIN)
        if not self.counting():
            self.idle_since = None
            return
        if self.queue_busy():
            self.idle_since = None
        elif self.idle_since is None:
            self.idle_since = t
        if IDLE_MINUTES > 0 and self.idle_since and t - self.idle_since >= IDLE_MINUTES * 60:
            self.trigger("file vide depuis %g min" % IDLE_MINUTES)

    def trigger(self, reason):
        with self.lock:
            if self.triggered:
                return
            self.triggered = True
            self.reason = reason
        publish("VIDEOGEN_STEP=auto_stop:%s" % reason)
        purge_old_files(0)
        if DRY_RUN:
            return
        ok = stop_self()
        if not ok:
            # Dernier recours : extinction du conteneur (PID 1). Voir README, section Watchdog.
            publish("VIDEOGEN_STEP=auto_stop:fallback_kill")
            try:
                os.kill(1, signal.SIGTERM)
            except OSError as e:
                self.last_error = "extinction impossible : %s" % e

    def run(self):
        while True:
            time.sleep(WATCHDOG_PERIOD)
            try:
                self.tick()
            except Exception as e:  # le watchdog ne doit jamais mourir
                self.last_error = str(e)


def stop_self():
    """Arrête l'instance via la clé restreinte injectée par Vast (CONTAINER_API_KEY)."""
    key = os.environ.get("CONTAINER_API_KEY", "")
    cid = os.environ.get("CONTAINER_ID", "")
    if not key or not cid:
        publish("VIDEOGEN_STEP=auto_stop:no_container_key")
        return False
    url = "%s/api/v0/instances/%s/" % (VAST_API_BASE, cid)
    body = json.dumps({"state": "stopped"}).encode()
    for attempt in range(1, 6):
        req = urllib.request.Request(url, data=body, method="PUT")
        req.add_header("Authorization", "Bearer " + key)
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.load(r)
            if data.get("success", True):
                publish("VIDEOGEN_STEP=auto_stop:requested")
                return True
        except urllib.error.HTTPError as e:
            publish("VIDEOGEN_STEP=auto_stop:http_%d" % e.code)
        except Exception as e:
            publish("VIDEOGEN_STEP=auto_stop:error %s" % str(e)[:120])
        time.sleep(10 * attempt)
    return False


# --------------------------------------------------------------------------- fichiers

FILE_TYPES = {"output": "output", "input": "input", "temp": "temp"}


def safe_path(ftype, subfolder, filename):
    base = os.path.realpath(os.path.join(COMFY_DIR, FILE_TYPES[ftype]))
    target = os.path.realpath(os.path.join(base, subfolder or "", filename))
    if os.path.commonpath([base, target]) != base or target == base:
        raise ValueError("chemin refusé")
    return target


def purge_old_files(ttl_minutes):
    limit = now() - ttl_minutes * 60
    for sub in ("output", "temp", "input/videogen"):
        root = os.path.join(COMFY_DIR, sub)
        for dirpath, _dirs, files in os.walk(root):
            for name in files:
                p = os.path.join(dirpath, name)
                try:
                    if os.path.getmtime(p) <= limit:
                        os.remove(p)
                except OSError:
                    pass


# --------------------------------------------------------------------------- serveur

WATCHDOG = Watchdog()


def comfy_ready():
    try:
        with urllib.request.urlopen(COMFY_URL + "/system_stats", timeout=5) as r:
            return r.status == 200
    except Exception:
        return False


def status():
    steps = read_json(os.path.join(RUN, "steps.json"), {})
    models = read_json(os.path.join(RUN, "models.json"), None)
    if models:
        models = dict(models, files=[{k: v for k, v in f.items() if k != "dest"} for f in models["files"]])
    try:
        du = shutil.disk_usage(COMFY_DIR if os.path.isdir(COMFY_DIR) else VG_HOME)
        disk = {"free_bytes": du.free, "total_bytes": du.total}
    except OSError:
        disk = None
    return {
        "version": 1,
        "now": now(),
        "steps": {s: steps.get(s, {"state": "pending"}) for s in STEPS},
        "models": models,
        "tunnel_url": read_text(os.path.join(RUN, "tunnel_url")) or None,
        "comfy_ready": comfy_ready(),
        "comfy_version": os.environ.get("COMFY_VERSION"),
        "watchdog": WATCHDOG.snapshot(),
        "disk": disk,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "videogen-agent"

    def log_message(self, *args):  # pas de journal d'accès (pas de fuite d'URL)
        pass

    def send_json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path == "/videogen/status":
            return self.send_json(200, status())
        if path == "/videogen/log":
            tail = 200
            for part in query.split("&"):
                if part.startswith("tail="):
                    try:
                        tail = max(1, min(2000, int(part[5:])))
                    except ValueError:
                        pass
            text = read_text(os.path.join(LOGS, "onstart.log"))
            return self.send_json(200, {"lines": [mask(l) for l in text.splitlines()[-tail:]]})
        return self.send_json(404, {"error": "not_found"})

    def do_POST(self):
        path = self.path.partition("?")[0]
        if path != "/videogen/files/delete":
            return self.send_json(404, {"error": "not_found"})
        try:
            length = min(int(self.headers.get("Content-Length", "0")), 65536)
            data = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, OSError):
            return self.send_json(400, {"error": "bad_json"})
        deleted, missing, refused = [], [], []
        for f in data.get("files", [])[:100]:
            name = str(f.get("filename", ""))
            try:
                p = safe_path(str(f.get("type", "output")), str(f.get("subfolder", "")), name)
            except (KeyError, ValueError):
                refused.append(name)
                continue
            try:
                os.remove(p)
                deleted.append(name)
            except FileNotFoundError:
                missing.append(name)
            except OSError:
                refused.append(name)
        return self.send_json(200, {"deleted": deleted, "missing": missing, "refused": refused})


def serve():
    threading.Thread(target=WATCHDOG.run, daemon=True).start()
    httpd = ThreadingHTTPServer(("127.0.0.1", AGENT_PORT), Handler)
    httpd.serve_forever()


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 1
    cmd = argv[1]
    if cmd == "serve":
        serve()
        return 0
    if cmd == "mark" and len(argv) >= 4:
        mark(argv[2], argv[3], " ".join(argv[4:]))
        return 0
    if cmd == "fetch-models":
        return fetch_models()
    if cmd == "publish":
        publish(" ".join(argv[2:]))
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
