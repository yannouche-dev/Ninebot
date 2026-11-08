"""Merge every videos/<id>.json into videos/index.json (newest first).

    python build_index.py SITE/videos
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    folder = Path(sys.argv[1] if len(sys.argv) > 1 else "videos")
    folder.mkdir(parents=True, exist_ok=True)
    items = []
    for meta_file in folder.glob("*.json"):
        if meta_file.name == "index.json":
            continue
        try:
            meta = json.loads(meta_file.read_text())
        except json.JSONDecodeError:
            print(f"ignoré (JSON invalide): {meta_file.name}")
            continue
        if (folder / meta.get("file", "")).exists():
            items.append(meta)
    items.sort(key=lambda m: m.get("created", ""), reverse=True)
    (folder / "index.json").write_text(json.dumps({"videos": items}, ensure_ascii=False, indent=1))
    total = sum(m.get("size", 0) for m in items)
    print(f"{len(items)} vidéo(s), {total / 1e6:.1f} Mo")
    if total > 800e6:
        print("::warning::Les vidéos approchent la limite de 1 Go de GitHub Pages : supprime les plus anciennes de la branche ai-videos.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
