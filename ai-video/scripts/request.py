"""Read a video request from the GitHub event and optionally improve its prompt.

    python request.py parse   --out request.json   # workflow_dispatch inputs or issue
    python request.py enhance --file request.json  # translate/enrich with GitHub Models

`parse` also writes `id`, `engine`, `enhance` and `issue` to $GITHUB_OUTPUT.
Nothing from the request is ever interpolated into a shell command: the
workflow only passes file paths around.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path

ENGINES = ("auto", "hf", "cpu")
FORMATS = ("landscape", "portrait", "square")
FORMAT_ALIASES = {
    "16:9": "landscape", "paysage": "landscape", "horizontal": "landscape",
    "9:16": "portrait", "vertical": "portrait",
    "1:1": "square", "carre": "square", "carré": "square",
}
MAX_PROMPT = 2000
TITLE_PREFIX = "[video]"


# --------------------------------------------------------------------------- parse
def _truthy(value, default: bool) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "oui", "on", "x")


def _slug(text: str, length: int = 40) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text[:length].strip("-") or "video"


def _from_issue(issue: dict) -> dict:
    title = (issue.get("title") or "").strip()
    body = (issue.get("body") or "").strip()

    # 1) JSON block written by the GitHub Pages form.
    match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", body, re.S)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass

    # 2) "### Heading" sections (issue form style).
    sections = dict(
        (h.strip().lower(), v.strip())
        for h, v in re.findall(r"^###\s*(.+?)\s*\n(.*?)(?=^###|\Z)", body, re.S | re.M)
    )
    if sections:
        def pick(*keys):
            for key in keys:
                for heading, value in sections.items():
                    if key in heading and value and value != "_No response_":
                        return value
            return None
        return {
            "prompt": pick("prompt", "description"),
            "engine": pick("engine", "moteur"),
            "format": pick("format"),
            "duration": pick("dur"),
            "seed": pick("seed", "graine"),
        }

    # 3) Free text: the body, or the title after "[video]".
    if title.lower().startswith(TITLE_PREFIX):
        title = title[len(TITLE_PREFIX):]
    return {"prompt": body or title}


def normalize(raw: dict) -> dict:
    prompt = re.sub(r"\s+", " ", str(raw.get("prompt") or "")).strip()
    if not prompt:
        raise SystemExit("La demande ne contient pas de prompt.")
    prompt = prompt[:MAX_PROMPT]

    engine = str(raw.get("engine") or "auto").strip().lower()
    engine = engine if engine in ENGINES else "auto"

    fmt = str(raw.get("format") or "landscape").strip().lower()
    fmt = FORMAT_ALIASES.get(fmt, fmt)
    fmt = fmt if fmt in FORMATS else "landscape"

    try:
        duration = float(str(raw.get("duration") or 4).replace(",", "."))
    except ValueError:
        duration = 4.0
    duration = min(max(duration, 1.0), 10.0)

    seed = raw.get("seed")
    try:
        seed = int(seed) if seed not in (None, "") else None
    except (TypeError, ValueError):
        seed = None

    negative = re.sub(r"\s+", " ", str(raw.get("negative_prompt") or "")).strip()[:500]

    now = dt.datetime.now(dt.timezone.utc)
    return {
        "id": f"{now:%Y%m%d-%H%M%S}-{_slug(prompt)}",
        "created": now.isoformat(timespec="seconds"),
        "prompt": prompt,
        "negative_prompt": negative,
        "engine": engine,
        "format": fmt,
        "duration": duration,
        "seed": seed,
        "enhance": _truthy(raw.get("enhance"), True),
    }


def cmd_parse(args) -> int:
    event_name = os.environ.get("GITHUB_EVENT_NAME", "")
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    event = json.loads(Path(event_path).read_text()) if event_path else {}

    if args.json:
        raw = json.loads(args.json)
    elif event_name == "issues":
        raw = _from_issue(event.get("issue") or {})
    else:
        raw = dict(event.get("inputs") or {})

    req = normalize(raw)
    if event_name == "issues":
        req["issue"] = (event.get("issue") or {}).get("number")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(req, ensure_ascii=False, indent=2))
    print(json.dumps(req, ensure_ascii=False, indent=2))

    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a") as fh:
            fh.write(f"id={req['id']}\n")
            fh.write(f"engine={req['engine']}\n")
            fh.write(f"enhance={'true' if req['enhance'] else 'false'}\n")
            fh.write(f"issue={req.get('issue') or ''}\n")
    return 0


# ------------------------------------------------------------------------- enhance
MODELS_API = "https://models.github.ai"
PREFERRED_MODELS = (
    "openai/gpt-4.1-mini",
    "openai/gpt-4o-mini",
    "openai/gpt-5-mini",
    "openai/gpt-4.1",
    "openai/gpt-4o",
)
SYSTEM_PROMPT = """You turn a short video idea (any language) into prompts for AI video models.
Answer with JSON only: {"video_prompt": "...", "short_prompt": "..."}
- video_prompt: one English paragraph (50-90 words) for a modern text-to-video model:
  main subject, action and motion, setting, camera movement, lighting, mood, style.
  Describe what is visible; no lists, no quotes, no meta comments.
- short_prompt: English comma-separated keywords (max 35 words) for a Stable Diffusion 1.5
  animation model: subject, action, setting, lighting, style, quality tags.
Keep the user's intent; never add text overlays, logos or watermarks."""


def _gh_request(url: str, token: str, payload: dict | None = None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read()
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            raise RuntimeError(
                f"réponse non JSON (HTTP {resp.status}, {resp.headers.get('Content-Type')}, "
                f"{resp.geturl()}): {raw[:200]!r}"
            ) from None


def _choose_model(token: str) -> list[str]:
    wanted = [m.strip() for m in os.environ.get("AI_VIDEO_LLM", "").split(",") if m.strip()]
    wanted += [m for m in PREFERRED_MODELS if m not in wanted]
    try:
        catalog = {m.get("id") for m in _gh_request(f"{MODELS_API}/catalog/models", token)}
        available = [m for m in wanted if m in catalog]
        return available or wanted[:2]
    except Exception as exc:  # noqa: BLE001
        print(f"Catalogue GitHub Models indisponible ({exc}), on tente quand même.")
        return wanted[:2]


def _parse_llm_json(text: str) -> dict:
    text = text.strip()
    match = re.search(r"\{.*\}", text, re.S)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass
    return {"video_prompt": text}


def cmd_enhance(args) -> int:
    path = Path(args.file)
    req = json.loads(path.read_text())
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        print("Pas de GITHUB_TOKEN : prompt laissé tel quel.")
        return 0

    for model in _choose_model(token):
        try:
            res = _gh_request(
                f"{MODELS_API}/inference/chat/completions",
                token,
                {
                    "model": model,
                    "messages": [
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": req["prompt"]},
                    ],
                    "temperature": 0.6,
                    "max_tokens": 500,
                },
            )
            content = res["choices"][0]["message"]["content"]
        except urllib.error.HTTPError as exc:
            print(f"{model}: HTTP {exc.code} {exc.read()[:300]!r}")
            continue
        except Exception as exc:  # noqa: BLE001
            print(f"{model}: {exc}")
            continue

        parsed = _parse_llm_json(content)
        video_prompt = re.sub(r"\s+", " ", str(parsed.get("video_prompt") or "")).strip()
        short_prompt = re.sub(r"\s+", " ", str(parsed.get("short_prompt") or "")).strip()
        if not video_prompt:
            continue
        req["prompt_en"] = video_prompt[:MAX_PROMPT]
        req["prompt_short"] = (short_prompt or video_prompt)[:400]
        req["enhanced_by"] = model
        path.write_text(json.dumps(req, ensure_ascii=False, indent=2))
        print(f"Prompt amélioré par {model}:\n  {req['prompt_en']}\n  [court] {req['prompt_short']}")
        return 0

    print("Aucun modèle GitHub Models n'a répondu : prompt laissé tel quel.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("parse")
    p.add_argument("--out", required=True)
    p.add_argument("--json", help="request as JSON (tests)")
    p.set_defaults(func=cmd_parse)
    e = sub.add_parser("enhance")
    e.add_argument("--file", required=True)
    e.set_defaults(func=cmd_enhance)
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
