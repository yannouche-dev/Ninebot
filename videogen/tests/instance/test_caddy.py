"""Teste le vrai Caddyfile avec le vrai binaire Caddy (variable CADDY_BIN), devant de faux ComfyUI/agent.

Vérifie : 401 sans jeton, pré-requête CORS limitée à l'origine, jeton en en-tête ou en paramètre (WebSocket),
retrait du jeton/Origin/Sec-Fetch-*/cookies avant ComfyUI, un seul en-tête CORS, jeton masqué dans le journal.
"""
import json
import os
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CADDY = os.environ.get("CADDY_BIN")
TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"
ORIGIN = "https://utilisateur.github.io"


class Echo(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        body = json.dumps({"path": self.path, "headers": dict(self.headers)}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        # ComfyUI (--enable-cors-header) ajoute ses propres en-têtes : Caddy doit les retirer.
        self.send_header("Access-Control-Allow-Origin", ORIGIN)
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.end_headers()
        self.wfile.write(body)

    do_POST = do_GET


def req(path, headers=None, method="GET"):
    r = urllib.request.Request("http://127.0.0.1:28080" + path, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(r, timeout=5) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


@unittest.skipUnless(CADDY, "CADDY_BIN non défini")
class CaddyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.logs = tempfile.mkdtemp()
        cls.servers = []
        for port in (28188, 28189):
            s = ThreadingHTTPServer(("127.0.0.1", port), Echo)
            threading.Thread(target=s.serve_forever, daemon=True).start()
            cls.servers.append(s)
        env = dict(os.environ, COMFY_ACCESS_TOKEN=TOKEN, ALLOWED_ORIGIN=ORIGIN, VG_LOG_DIR=cls.logs)
        cls.caddy = subprocess.Popen([CADDY, "run", "--config", os.path.join(ROOT, "instance", "Caddyfile"), "--adapter", "caddyfile"],
                                     env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                urllib.request.urlopen("http://127.0.0.1:28080/", timeout=1)
            except urllib.error.HTTPError:
                break
            except Exception:
                time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.caddy.terminate()
        cls.caddy.wait(5)
        for s in cls.servers:
            s.shutdown()

    def test_requires_token(self):
        self.assertEqual(req("/object_info")[0], 401)
        self.assertEqual(req("/object_info", {"Authorization": "Bearer mauvais"})[0], 401)
        self.assertEqual(req("/object_info?token=")[0], 401)
        code, headers, _ = req("/object_info", {"Origin": ORIGIN})
        self.assertEqual(code, 401)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), ORIGIN)

    def test_preflight_only_for_origin(self):
        code, headers, _ = req("/prompt", {"Origin": ORIGIN, "Access-Control-Request-Method": "POST"}, "OPTIONS")
        self.assertEqual(code, 204)
        self.assertIn("Authorization", headers.get("Access-Control-Allow-Headers", ""))
        self.assertEqual(req("/prompt", {"Origin": "https://evil.example"}, "OPTIONS")[0], 401)

    def test_bearer_strips_sensitive_headers(self):
        code, headers, body = req("/object_info?x=1", {"Authorization": "Bearer " + TOKEN, "Origin": ORIGIN,
                                                        "Sec-Fetch-Site": "cross-site", "Cookie": "a=b"})
        self.assertEqual(code, 200)
        seen = json.loads(body)
        self.assertEqual(seen["path"], "/object_info?x=1")
        lower = {k.lower(): v for k, v in seen["headers"].items()}
        for h in ("authorization", "origin", "sec-fetch-site", "cookie"):
            self.assertNotIn(h, lower)
        self.assertEqual(lower["host"], "127.0.0.1:28188")
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), ORIGIN)
        self.assertNotIn("Access-Control-Allow-Credentials", headers)

    def test_query_token_removed_and_agent_route(self):
        code, _, body = req("/ws?clientId=abc&token=" + TOKEN)
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)["path"], "/ws?clientId=abc")
        code, _, body = req("/videogen/status", {"Authorization": "Bearer " + TOKEN})
        self.assertEqual(code, 200)
        self.assertNotIn("Authorization", json.loads(body)["headers"])

    def test_token_never_logged(self):
        self.servers[0].shutdown()  # ComfyUI indisponible -> 502 -> journal d'erreur de Caddy
        self.servers[0].server_close()
        self.assertEqual(req("/ws?clientId=z&token=" + TOKEN)[0], 502)
        time.sleep(0.5)
        text = open(os.path.join(self.logs, "caddy.log")).read()
        self.assertIn("REDACTED", text)
        self.assertNotIn(TOKEN, text)


if __name__ == "__main__":
    unittest.main()
