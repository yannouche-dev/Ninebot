"""Inspect Hugging Face Spaces usable for text-to-video.

Prints, for each candidate Space, its runtime status, hardware and the
parameters of its Gradio API endpoints. Run it when a Space stops working to
find a replacement and check its parameter names.

    python ai-video/scripts/probe_spaces.py Lightricks/ltx-2-distilled ...
    python ai-video/scripts/probe_spaces.py --discover
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request

HF_API = "https://huggingface.co/api"


def hf_get(path: str):
    req = urllib.request.Request(f"{HF_API}{path}")
    token = os.environ.get("HF_TOKEN")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def discover(limit: int) -> list[str]:
    found: dict[str, int] = {}
    for term in ("text-to-video", "ltx", "wan2", "video generation"):
        query = urllib.parse.urlencode(
            {"search": term, "sort": "likes", "direction": "-1", "limit": limit}
        )
        try:
            for space in hf_get(f"/spaces?{query}"):
                found[space["id"]] = space.get("likes", 0)
        except Exception as exc:  # noqa: BLE001
            print(f"discover '{term}' failed: {exc}")
    return [sid for sid, _ in sorted(found.items(), key=lambda kv: -kv[1])]


def runtime(space_id: str) -> str:
    try:
        info = hf_get(f"/spaces/{space_id}")
    except Exception as exc:  # noqa: BLE001
        return f"? ({exc})"
    rt = info.get("runtime") or {}
    hw = (rt.get("hardware") or {}).get("current")
    return f"stage={rt.get('stage')} hardware={hw} likes={info.get('likes')}"


def probe(space_id: str) -> None:
    from gradio_client import Client

    print(f"\n===== {space_id}: {runtime(space_id)}")
    try:
        client = Client(space_id, token=os.environ.get("HF_TOKEN") or None, verbose=False)
        info = client.view_api(print_info=False, return_format="dict")
    except Exception as exc:  # noqa: BLE001
        print(f"  cannot load API: {type(exc).__name__}: {exc}")
        return
    for name, ep in (info.get("named_endpoints") or {}).items():
        params = ep.get("parameters", [])
        returns = ep.get("returns", [])
        print(f"  endpoint {name}")
        for p in params:
            enum = (p.get("type") or {}).get("enum")
            print(
                "    - {name} [{comp}] {ptype} default={default!r}{enum}".format(
                    name=p.get("parameter_name") or p.get("label"),
                    comp=p.get("component"),
                    ptype=(p.get("python_type") or {}).get("type"),
                    default=p.get("parameter_default"),
                    enum=f" choices={enum}" if enum else "",
                )
            )
        for r in returns:
            print(f"    -> {r.get('label')} [{r.get('component')}]")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("spaces", nargs="*")
    parser.add_argument("--discover", action="store_true")
    parser.add_argument("--limit", type=int, default=15)
    args = parser.parse_args()
    spaces = list(args.spaces)
    if args.discover:
        discovered = discover(args.limit)
        print("Discovered:", ", ".join(discovered))
        spaces += [s for s in discovered if s not in spaces][: args.limit]
    for space in spaces:
        probe(space)
    return 0


if __name__ == "__main__":
    sys.exit(main())
