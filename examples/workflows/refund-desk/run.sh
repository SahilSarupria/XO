#!/bin/sh
# Runs the refund desk with no network and no API key. Usage: sh run.sh   (after `npm run build` at the repo root)
set -e
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
mkdir -p "$work/out"
printf '{"connectors":{"desk_out":{"grant":["write_record"]}},"fileRoots":{"desk_out":{"out":"%s/out"}}}' "$work" > "$work/policy.json"
xo() { node "$here/../../../apps/cli/bin/xo.js" "$@"; }
xo flow validate "$here/workflows.json"
xo flow report "$here/workflows.json"
echo "--- small refund: approved by rule"
xo flow run "$here/workflows.json" --workflow refund_desk --input '{"order_id":"o-1","amount":40}' --runs "$work/runs" --policy "$work/policy.json" --dedupe evt-1 || true
echo "--- same event again: accepted:false, nothing re-executed"
xo flow run "$here/workflows.json" --workflow refund_desk --input '{"order_id":"o-1","amount":40}' --runs "$work/runs" --policy "$work/policy.json" --dedupe evt-1 || true
echo "--- mid-size refund: the rules cannot decide, so it escalates (exit 2)"
xo flow run "$here/workflows.json" --workflow refund_desk --input '{"order_id":"o-2","amount":500}' --runs "$work/runs" --policy "$work/policy.json" --dedupe evt-2 || true
