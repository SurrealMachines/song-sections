#!/bin/sh
# Regenerate every committed fixture. Later tasks add tools/golden/fixtures_*.py; this script needs no edit.
set -e
cd "$(dirname "$0")/../.."
SONG_SECTIONS_SPIKE="${SONG_SECTIONS_SPIKE:-/Users/mja/Dev/extensions/song-sections/tools/onnx-spike}"
export SONG_SECTIONS_SPIKE
export PYTHONDONTWRITEBYTECODE=1 # the spike checkout is read-only for us
for f in tools/golden/fixtures_*.py; do
  [ -e "$f" ] || continue
  echo "== $f"
  "$SONG_SECTIONS_SPIKE/.venv/bin/python" "$f"
done
