# Local-first runner with server backup (`xo serve`, `@xo/sdk`)

Same signed bundle, same workflow runner, two places to run it. The local runner is primary; the server is the backup and the arbiter of who owns a run.
**Not measured:** failover time, throughput, replication lag. Everything below describes mechanisms and what tests show, not performance.

## Local runner (offline)

`xo flow run` loads the signed workflows and runs deterministic workflows with **zero model calls and zero network calls** unless a granted connector needs the
network (`http`). A workflow with a model-assisted `extract` step is refused whole on a runner without an extractor. A local Ollama-backed `Extractor` adapter
is **not built**; the interface exists. The refund-desk example runs fully offline.

## Server runner

`XO_SERVER_TOKEN=<24+ chars> xo serve --workflows w.json --runs ./data [--policy p.json] [--trees t.json] [--approvers reviewers.json]` or
`docker build -f Dockerfile.server -t xo-server .`. The token comes from the environment only. Routes (all JSON, all need `Authorization: Bearer`, except health):
`GET /v1/health`, `POST /v1/decide`, `POST|GET /v1/workflows/{id}/runs`, `GET /v1/runs/{id}`, `POST /v1/runs/{id}/lease`, `GET|POST /v1/ledger/{id}`,
`GET /v1/approvals`, `GET /v1/approvals/{id}`, `POST /v1/approvals/{id}/decision`, `POST /v1/loader/resolve`, `GET /v1/receipts`.
`/v1/loader/resolve` and `/v1/receipts` need a package bundle configured on the server (library option); the `xo serve` command does **not** load one yet.

### Hardening note

See `docs/SERVER_HARDENING.md` for the full model. In short: loopback by default; any other address needs `--allow-remote`, per-client scoped tokens (`--tokens`; the single shared `XO_SERVER_TOKEN` is
refused off loopback) and either built-in TLS (`--tls-cert/--tls-key`, optional mutual TLS) or an explicit `--behind-tls-proxy`. Tokens are hashed, scoped (read, run, approve, lease, ledger-sync, admin), expiring and
revocable on a running server; unmapped routes are admin-only; refusals are audited without credentials. Constant-time comparison; no CORS; 1 MiB body cap (413), JSON only (415), strict ids, per-address rate limit
(429) before authentication, failed-login lockout, request/header deadlines, generic 500s, `no-store` and security headers. Adversarial tests: `packages/server/test/hardening.test.ts` (real sockets and TLS),
`apps/cli/test/token-serve.test.ts` (real `xo serve` processes), `packages/sdk/test/api.test.ts` (auth bypass variants, traversal, oversized body, content type, approval replay, stale-token fencing).
SSRF protection lives in the HTTP connector, not the API surface (the API makes no outbound requests on behalf of callers).

## Lease protocol

A run is owned by one runner at a time. `acquire(run, owner, ttl)` returns a lease with a **fencing token**: strictly larger for every new owner or epoch, unchanged
when the same owner re-acquires a live lease. A live lease held by someone else is `HELD`. `heartbeat` extends it only for the current (owner, token), else `LOST`.
Expiry is the takeover signal: after it, another runner acquires with a larger token and continues from the last durable journal entry.

Fencing is enforced where the authoritative journal lives:

- On the server, runner writes go through `LeasedRunStore`; each append re-checks owner, token and expiry in the same critical section as the write.
- A local runner replicates its hash-chained ledger with `POST /v1/ledger/{id}` carrying (owner, token). A stale token is refused (`409 LEASE_LOST`); `replicateRun` always
  sends at least one batch so a runner that lost its lease learns it even with nothing new to push. It must then stop and reconcile from the server's journal.
- The local runner's own local journal is **not** fenced by the server (it cannot be). After losing the lease it can still write locally; those entries never reach the
  authoritative ledger, and a divergent chain pushed later is a fork.

Takeover is exercised end to end in tests (`packages/sdk/test/api.test.ts`, `packages/workflow-runtime/test/lease.test.ts`): the local runner freezes mid-call, its lease expires, the
server resumes from the replicated journal, and the returning runner is fenced out.

### Ledger sync and forks

The server verifies every link (sequence, previous hash, own hash). Identical re-pushes are no-ops; a gap asks for the missing range; an entry that conflicts with one already
held (same sequence, different hash) is a **fork**: never merged, recorded durably, the run is quarantined until an operator clears it, and `onFork` fires so it can be escalated.
Anchoring of the ledger (the existing automation anchor) is not wired to this journal yet.

## Exact guarantees

- At most one owner can append to the authoritative journal at a time (token plus expiry check under one lock).
- Acceptance is at-most-once per run id or dedupe key.
- After a takeover, every external call that is repeated uses the **same idempotency key** (derived from workflow, step and the rendered business key).
- A stale runner's fenced writes and replication pushes are refused.

## NOT guaranteed

- **Not exactly-once.** A call in flight when the lease is lost completes at the external system. The takeover finds an intent with no outcome and **settles it by the
  destination's attested capability** (`WORKFLOW_RUNTIME.md`, "Duplicate-call window"): same key for destinations that dedupe, a lookup first for those that can answer, and an
  `AMBIGUOUS_EFFECT` escalation (never a silent second write) for those that can do neither or are unattested. A crash at the wrong instant on one runner can do the same (see `WORKFLOW_RUNTIME.md`).
- Clock skew between runner and server can shorten or lengthen a lease from the runner's point of view; the server's clock decides expiry. Keep heartbeats well inside the TTL.
- The authority is a single process with file-backed state: it is a single point of failure, and two server processes on one directory are unsupported.
- A fully offline local runner holds no server lease. If the server also runs that run (for example a duplicate trigger), the two can diverge; that shows up as a fork or a `HELD`
  refusal when they reconnect, not as silent agreement.
- Offline operation means local runs are visible to the server only after replication.
