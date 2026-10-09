#!/usr/bin/env bash
# NOT part of the shipped tooling. In a real environment with registry
# access, `npm install && npm test` resolves each workspace's own `tsx`
# devDependency normally. This script exists only to self-verify the repo
# in a sandbox without network access, by pointing Node at a global tsx
# install instead. See docs/TECH_STACK.md.
set -uo pipefail
cd "$(dirname "$0")/.."

TSX_LOADER=$(node -e "console.log(require.resolve('tsx/dist/loader.mjs'))" 2>/dev/null)
if [ -z "$TSX_LOADER" ]; then
  for candidate in /home/claude/.npm-global/lib/node_modules/tsx/dist/loader.mjs; do
    if [ -f "$candidate" ]; then TSX_LOADER="$candidate"; fi
  done
fi
if [ -z "$TSX_LOADER" ]; then
  echo "Could not locate tsx's loader; run 'npm install' in a networked environment instead." >&2
  exit 1
fi

FAIL=0
for dir in packages/* apps/*; do
  if [ -d "$dir/test" ]; then
    echo "== $dir =="
    (cd "$dir" && node --import "$TSX_LOADER" --test 'test/**/*.test.ts') || FAIL=1
    echo
  fi
done

exit $FAIL
