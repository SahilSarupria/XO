# Runbook: recovery

**Use when** a process crashed, the machine restarted, an instance moved, or data must be restored from a backup.

## After a crash or restart

Nothing needs replaying by hand. Every run is a hash-chained journal on disk, and every write to a run holds its lease, so:

1. Start the instance (`xo up`, or the container). `GET $B/readyz` returns 200 when storage, schema, lock and scheduler are fine.
2. Runs waiting for a timer, an approval deadline, or left `running` when the process stopped carry on at the next minute tick, or when someone reads them.
3. A call that was in flight when the process died has no outcome in the journal. On resume XO settles it before going on: a destination that deduplicates or can be looked up is checked; otherwise the item stops as **unknown** for a person ([Unknown side effect](unknown-side-effect.md)). It is never sent twice.
4. Check `GET $B/workspaces/$WS/control/inbox` for anything that now needs a person.

Scheduled slots missed while the instance was down follow `XO_SCHEDULE_MISSED_SLOTS` (`run_latest`: only the most recent missed slot, if it ended within 24 hours; `skip`: none).

## Restore from a backup

```bash
xo instance verify-backup backup.tar.gz
xo instance restore backup.tar.gz --data /var/lib/xo [--force]
```

The archive is verified before anything is written; `--force` moves the existing folder aside rather than deleting it. Put the secrets key back at `XO_SECRETS_KEY_FILE` if the secrets file needs it.

**Before letting work run after a restore,** engage the instance stop:

```bash
xo instance emergency-stop --data /var/lib/xo --reason "restored from backup; checking before work resumes"
```

A backup is older than the world: messages sent after it was taken are not in its journals, so runs restored mid-batch could prepare them again. Check, for each run in progress in the backup:

- `GET …/runs/{runId}/replay`: `reproducible` and the replayed state;
- the destination (Sent folder, provider dashboard) for the items sent after the backup time;
- cancel runs whose later items were already handled (`POST …/runs/{runId}/cancel`).

Then release the stop.

## Verify the evidence survived

For a sample of runs: `GET …/audit-bundle` then `POST …/audit-bundles/verify` returns `ok: true`. The approval keyring (`<data>/approval-keys/`) is in the backup, so decisions signed before still verify.

## Done when

`/readyz` is 200, the inbox has no unexplained items, sampled bundles verify, and any stop engaged for the recovery is released.
