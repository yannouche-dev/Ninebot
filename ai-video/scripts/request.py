"""Read a video request from the GitHub event.

    python request.py parse --out request.json   # workflow_dispatch inputs or issue

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


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("parse")
    p.add_argument("--out", required=True)
    p.add_argument("--json", help="request as JSON (tests)")
    p.set_defaults(func=cmd_parse)
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
