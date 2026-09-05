#!/usr/bin/env bash
# Copy the game as it stands in this checkout into the APK's assets, and record
# exactly which commit was taken. Run from anywhere; paths are worked out from
# the script's own location.
#
# This is what makes the APK play offline: after this runs, everything the game
# loads is inside the package, and the app never asks the network for anything.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
out="$here/app/src/main/assets/www"

rm -rf "$out"
mkdir -p "$out"

# Everything index.html actually pulls in. Listed rather than globbed so a new
# top-level folder cannot be left out of the build without anyone noticing -
# the check below fails loudly instead.
cp "$repo/index.html" "$out/"
for d in js css shaders; do
  if [ -d "$repo/$d" ]; then
    cp -r "$repo/$d" "$out/"
  else
    echo "snapshot: missing $repo/$d" >&2
    exit 1
  fi
done

sha="$(git -C "$repo" rev-parse --short HEAD 2>/dev/null || echo unknown)"
date="$(date -u +%Y-%m-%d)"
count="$(find "$out" -type f | wc -l | tr -d ' ')"

cat > "$out/build.json" <<JSON
{
  "commit": "$sha",
  "built": "$date",
  "files": $count
}
JSON

echo "snapshot: $count files from $sha ($date) -> $out"

# Nothing in the bundle may point back at the network: a single absolute http
# reference would be a file the game cannot load with the phone offline.
if grep -rInE '(src|href)="https?://' "$out" --include=*.html --include=*.js --include=*.css; then
  echo "snapshot: the bundle references the network - it would not run offline" >&2
  exit 1
fi
