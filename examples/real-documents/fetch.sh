#!/bin/sh
# Downloads the public documents listed in manifest.json into ./downloads and records sha256 + size.
# Run this on a machine with open internet access (the cloud sandbox this was written in blocks insurer sites).
# Usage: sh fetch.sh
set -u
cd "$(dirname "$0")"
mkdir -p downloads
: > downloads/FETCHED.tsv
python3 - <<'PY' | while IFS="$(printf '\t')" read -r id url; do
import json
for d in json.load(open('manifest.json'))['documents']:
    print(d['id'] + '\t' + d['url'])
PY
  out="downloads/$id.pdf"
  if curl -fsSL --max-time 120 -A "Mozilla/5.0 (xo-wild-run)" -o "$out" "$url"; then
    if head -c 4 "$out" | grep -q '%PDF'; then
      printf '%s\t%s\t%s\t%s\n' "$id" "$(sha256sum "$out" | cut -d' ' -f1)" "$(wc -c < "$out")" "$url" >> downloads/FETCHED.tsv
      echo "ok   $id"
    else
      rm -f "$out"; echo "FAIL $id (not a PDF)"
    fi
  else
    echo "FAIL $id (download)"
  fi
done
