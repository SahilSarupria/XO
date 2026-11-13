#!/usr/bin/env bash
# UW-3c — derive the format variants of the real-document corpus from the originals in sources/.
#
# The originals are public-domain or CC0 documents written by US federal teams (see SOURCES.md). Nothing here edits their
# content; this script only changes their FORMAT, the way they travel in practice: Markdown rendered to a web page or a Word
# file, a Word file exported to PDF or to HTML, and a printed page that comes back as a scan.
#
# Tools: pandoc, LibreOffice (soffice), poppler (pdftoppm), ImageMagick (convert). The derived files are committed; tests never
# run this script. Re-running it can change bytes (LibreOffice stamps dates), so the evaluation set records content hashes.
set -euo pipefail
cd "$(dirname "$0")"
S=sources
OUT=.
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

lo() { # $1 = target format, $2 = input, $3 = output path
  local work="$TMP/lo-$RANDOM"
  mkdir -p "$work"
  soffice --headless --convert-to "$1" --outdir "$work" "$2" > /dev/null 2>&1
  mv "$work/$(basename "${2%.*}").${1%%:*}" "$3"
}

# Markdown -> web page (pandoc, standalone HTML5; front matter title becomes the page title and heading)
for d in cisa-onboarding cisa-branch-protection cisa-skeletonize usds-play-01 cisa-style-guide; do
  pandoc -f gfm+yaml_metadata_block -s "$S/$d.md" -o "$OUT/$d.html" --metadata pagetitle="$d"
done
# Markdown -> Word (pandoc: real Word numbering, task-list check boxes as ☐ / ☒)
for d in cisa-onboarding cisa-branch-protection cisa-skeletonize usds-play-04 usds-play-01 18f-out-of-office cisa-style-guide usds-play-12; do
  pandoc -f gfm+yaml_metadata_block "$S/$d.md" -o "$TMP/$d.docx"
done
cp "$TMP/cisa-onboarding.docx" "$TMP/cisa-branch-protection.docx" "$TMP/cisa-skeletonize.docx" "$TMP/usds-play-04.docx" "$OUT/"
cp "$TMP/18f-out-of-office.docx" "$TMP/usds-play-12.docx" "$OUT/"
# Word -> PDF (LibreOffice)
lo pdf "$S/18f-weekly-ship.docx" "$OUT/18f-weekly-ship.pdf"
lo pdf "$S/18f-kickoff-agenda.docx" "$OUT/18f-kickoff-agenda.pdf"
lo pdf "$OUT/cisa-skeletonize.docx" "$OUT/cisa-skeletonize.pdf"
lo pdf "$TMP/usds-play-01.docx" "$TMP/usds-play-01.pdf"
lo pdf "$OUT/usds-play-04.docx" "$TMP/usds-play-04.pdf"
lo pdf "$S/18f-project-readme.docx" "$OUT/18f-project-readme.pdf"
lo pdf "$TMP/cisa-style-guide.docx" "$OUT/cisa-style-guide.pdf"
lo pdf "$OUT/18f-out-of-office.docx" "$TMP/18f-out-of-office.pdf"
# Word -> HTML (LibreOffice "Save as HTML": the markup a Word export produces)
lo 'html:HTML (StarWriter)' "$OUT/usds-play-04.docx" "$OUT/usds-play-04.word.html"
lo 'html:HTML (StarWriter)' "$OUT/usds-play-12.docx" "$OUT/usds-play-12.word.html"

# Print and scan: 150 dpi greyscale, a slight skew, sensor noise and blur, JPEG pages in an image-only PDF (no text layer).
scan() { # $1 = input pdf, $2 = output pdf
  local stem="$TMP/scan-$(basename "$2" .pdf)"
  pdftoppm -r 150 -gray "$1" "$stem"
  local pages=()
  for p in "$stem"-*.pgm; do
    convert "$p" -seed 7 -background white -rotate 0.6 -attenuate 0.35 +noise Gaussian -blur 0x0.5 -level 4%,96% -quality 72 "${p%.pgm}.jpg"
    pages+=("${p%.pgm}.jpg")
  done
  convert "${pages[@]}" -density 150 -units PixelsPerInch "$2"
}
scan "$OUT/18f-weekly-ship.pdf" "$OUT/18f-weekly-ship.scan.pdf"
scan "$OUT/18f-kickoff-agenda.pdf" "$OUT/18f-kickoff-agenda.scan.pdf"
scan "$TMP/usds-play-01.pdf" "$OUT/usds-play-01.scan.pdf"
scan "$TMP/usds-play-04.pdf" "$OUT/usds-play-04.scan.pdf"
scan "$TMP/18f-out-of-office.pdf" "$OUT/18f-out-of-office.scan.pdf"
echo "derived files written"
