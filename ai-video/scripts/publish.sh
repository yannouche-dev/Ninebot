#!/usr/bin/env bash
# Commit OUT_DIR/{video.mp4,poster.jpg,meta.json} to the videos branch.
# Usage: publish.sh OUT_DIR
# The branch (default "ai-videos") holds only the videos, so the main
# branch history stays small; delete old files there to free space.
set -euo pipefail

OUT="$1"
BRANCH="${AI_VIDEO_BRANCH:-ai-videos}"
ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$OUT/meta.json")"
STORE="${RUNNER_TEMP:-/tmp}/ai-video-store"

BOT=(-c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com")

for attempt in 1 2 3 4 5 6; do
  rm -rf "$STORE"
  git worktree prune
  if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
    git fetch --depth=1 origin "$BRANCH"
    git worktree add --force -B "$BRANCH" "$STORE" FETCH_HEAD
  else
    git worktree add --force --detach "$STORE"
    git -C "$STORE" checkout --orphan "$BRANCH"
    git -C "$STORE" rm -rfq . || true
    git -C "$STORE" clean -fdxq
    printf '# Vidéos IA\n\nBranche de stockage des vidéos générées par le workflow « Vidéo IA ».\nSupprimez des fichiers de `videos/` pour libérer de la place.\n' > "$STORE/README.md"
  fi

  mkdir -p "$STORE/videos"
  cp "$OUT/video.mp4" "$STORE/videos/$ID.mp4"
  cp "$OUT/meta.json" "$STORE/videos/$ID.json"
  [ -f "$OUT/poster.jpg" ] && cp "$OUT/poster.jpg" "$STORE/videos/$ID.jpg"

  git -C "$STORE" add -A
  git -C "$STORE" "${BOT[@]}" commit -qm "Vidéo IA : $ID" || echo "Rien de nouveau à committer."
  if git -C "$STORE" push origin "HEAD:refs/heads/$BRANCH"; then
    echo "Publié sur la branche $BRANCH : videos/$ID.mp4"
    [ -n "${GITHUB_OUTPUT:-}" ] && echo "published=true" >> "$GITHUB_OUTPUT"
    exit 0
  fi
  echo "Push refusé (essai $attempt), nouvelle tentative…"
  sleep $((attempt * 5))
done

echo "::error::Impossible de publier la vidéo sur la branche $BRANCH"
exit 1
