# Running the desk unattended — operations guide

Applies to `@xo/automation` and `xo desk`. Everything here is implemented and tested unless marked **not provided**.

## 1. Process model and the state directory

One engine owns one state directory (`ledger.jsonl`, `state/pending/`, `outbox/`). It takes an exclusive `engine.lock`; a second engine
on the same directory is refused (`EngineLockedError`). A lock left by a process that died **on the same host** is taken over automatically;
a lock from another host, or an unreadable one, is never taken over (fail closed).

- **Multi-host / HA dedupe: not provided.** The lock and the idempotency keys are per directory. Two hosts must not share one directory
  (especially a network filesystem — the lock and the ledger append are not safe there). To run more than one instance, partition the input
  (different inboxes/webhook paths, each with its own state directory) or put a shared queue in front. A shared-store dedupe backend is future work.
- **Delivery semantics:** a claim key is accepted at most once per state directory, including across crashes; execution is at-least-once
  (a job interrupted by a crash is re-run), so **handlers must be idempotent** in their external side effects. The crash soak below counts how often that happens.

## 2. Network exposure and TLS

- The webhook binds to **loopback** by default. Binding anything else over plain HTTP is **refused** unless you either
  - serve HTTPS from the desk: `XO_WEBHOOK_TLS_KEY=/path/key.pem XO_WEBHOOK_TLS_CERT=/path/cert.pem`, or
  - confirm a TLS-terminating reverse proxy (nginx, Caddy, a cloud load balancer) sits in front: `XO_WEBHOOK_BEHIND_TLS_PROXY=1`, with `--webhook-host` set to the interface the proxy reaches.
- Requests are authenticated by HMAC (`X-XO-Timestamp`, `X-XO-Signature`) with a replay window; TLS adds confidentiality and server authentication. Use both.
- Recommended shape: proxy terminates TLS 1.2+ and forwards to `127.0.0.1:<port>`; do not expose `--metrics-port` (loopback only) — scrape it through the proxy or a sidecar.
- Certificate rotation: restart the desk (it reads the files at start). In-place reload is **not provided**.

## 3. Sandbox network modes (`XO_SANDBOX_NETWORK`)

| value                | what runs                                                                                                               | what it proves                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `required` (default) | worker in a Linux network namespace (`unshare -rn`) + Node permission model                                             | network is **isolated**; refuses to start if the namespace is unavailable                                  |
| `guard`              | namespace if available; otherwise Node permission model + an in-worker guard that makes every network entry point throw | network entry points are **blocked in-process — this is not isolation**; the startup banner says `GUARDED` |
| `none`               | permission model only                                                                                                   | no network measure; banner says `NOT blocked`                                                              |

macOS and Windows have no rootless network namespace, so `guard` is the available fallback there. The tree evaluator itself performs no I/O; the sandbox is
defense in depth for untrusted packages and webhook payloads. Windows has not been exercised in this repository's tests.

## 4. Tamper evidence: ledger anchoring

The ledger is a hash chain: editing or deleting a middle entry is detected. Someone who can rewrite the **whole** file can rebuild a consistent chain, so publish the head elsewhere:

```
xo desk --state ./state --inbox ./inbox --anchor-file /mnt/worm/desk-anchors.jsonl      # file OUTSIDE --state (enforced)
XO_ANCHOR_URL=https://anchors.example/ingest XO_ANCHOR_SECRET=…                          # HMAC-signed POST of {seq, hash, at}
xo ledger-verify ./state/ledger.jsonl --anchors /mnt/worm/desk-anchors.jsonl
```

Anchors are published every 100 ledger entries and on stop. Verification fails if the ledger is **truncated** below an anchor or its history was **rebuilt** (hash at an
anchored position differs). A failing sink is recorded as `anchor.failed` and counted in `xo_*`/`counters.anchorFailures`; it never stops the desk. An anchor is only as
trustworthy as its sink: use an append-only mount, an object store with retention, or an external service you do not administer from the same account.

## 5. Escalations reach people

`needs-human` and `dead-letter` outbox items are delivered at-least-once by `deliverOutbox` (the desk runs it every 30 s when `XO_DELIVERY_URL` is set):

- `WebhookDelivery` — HTTPS (or loopback) POST, `X-XO-Delivery-Signature: sha256=<HMAC>`, `Idempotency-Key: <runId>`; point it at a Slack/Teams relay, a ticketing system or an on-call bridge.
- `DirectoryDelivery` — atomic copy into another directory (a shared inbox, a mounted queue folder).

Per-adapter `*.sent.<adapter>` markers mean a retry re-sends only to adapters that have not accepted the item; `*.delivered` is written once all have. Email/SMS adapters are **not provided**
(use a webhook relay); delivery success is recorded in the ledger (`delivery.sent` / `delivery.failed`).

## 6. Scheduling

`--cron "m h dom mon dow"` (UTC, five fields; lists, ranges, steps; `7` = Sunday; day-of-month and day-of-week are OR-ed when both are restricted). The idempotency key is the scheduled
minute, so a restart inside the minute cannot double-fire. **Missed ticks are not replayed** after downtime (no catch-up). Time-zone-aware schedules and named months/days are **not provided**.

## 7. Metrics

`--metrics-port <n>` serves Prometheus text on `127.0.0.1:<n>/metrics`: `xo_jobs_accepted_total`, `xo_jobs_completed_total`, `xo_jobs_failed_total`, `xo_jobs_retried_total`, `xo_jobs_duplicate_total`,
`xo_queue_depth`, `xo_jobs_active`, `xo_ledger_entries`. No latency histograms yet.

## 8. Soak results (measured, one run)

`node scripts/soak-desk.mjs --events 20000 --kills 12` — 20,000 claims plus ~10 % duplicate re-drops, the engine process `SIGKILL`ed 12 times at random points and restarted, on the 2-core sandbox used for the other benchmarks:

| check                                               | result                                             |
| --------------------------------------------------- | -------------------------------------------------- |
| ledger hash chain verifies after all crashes        | pass (62,978 entries)                              |
| every claim accepted exactly once                   | pass (20,000 distinct keys, 20,000 accept entries) |
| no accepted job left unsettled / no pending files   | pass                                               |
| every claim's handler ran at least once             | pass (20,000 / 20,000)                             |
| claims re-executed because a crash interrupted them | 41 (0.2 %) — the at-least-once cost                |
| wall time                                           | 20.9 s (≈ 960 claims/s end to end incl. restarts)  |

**Known limit found by the soak:** the ledger keeps every entry in memory (RSS grew 71 → 136 MB over 63k entries, roughly 1 KB per entry and ~3 entries per job). At 1,000 jobs/day that is ~3 MB/day;
at sustained high volume it is not bounded. Rotating/streaming the ledger is **not provided**. The soak is a seconds-long crash/recovery test, **not** a multi-hour endurance run — that has not been done.
