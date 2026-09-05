#!/usr/bin/env bash
# Write webapp.json: the list of files the game is made of, each with its
# hash. The packaged app compares this against the copy on the web to work out
# what, if anything, needs downloading.
#
# It lives in the repository (not just in the build) because the app fetches it
# over the network. CI regenerates it and fails if the committed one is stale,
# so a new module cannot be added without this noticing.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
out="${1:-$repo/webapp.json}"

cd "$repo"
files=$( { echo index.html; find js css shaders -type f \
    \( -name '*.js' -o -name '*.css' -o -name '*.shdr' -o -name '*.html' \) ; } | sort )

{
  echo '{'
  echo "  \"commit\": \"$(git rev-parse --short HEAD 2>/dev/null || echo unknown)\","
  echo "  \"files\": ["
  first=1
  for f in $files; do
    sha=$(sha256sum "$f" | cut -d' ' -f1)
    [ $first -eq 1 ] || echo ','
    first=0
    printf '    { "path": "%s", "sha256": "%s" }' "$f" "$sha"
  done
  echo
  echo '  ]'
  echo '}'
} > "$out"

echo "manifest: $(grep -c '"path"' "$out") files -> $out"
