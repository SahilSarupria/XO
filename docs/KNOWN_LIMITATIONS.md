# Known limitations (read before relying on this baseline)

This is the single list of what is **not** true or **not** verified. Detail lives in `docs/ROADMAP.md`, `docs/ACCEPTANCE_CRITERIA.md`, `docs/SERVER_HARDENING.md`, `docs/CONNECTORS.md` and `docs/WORKFLOW_RUNTIME.md`.

## Measurement

- Nothing about accuracy, latency, cost, CPU or RAM is measured on real traffic or a live model. The only measured results are freight claims on one model and one offline second-domain run (ROADMAP section A).
- Efficiency controls (request coalescing, prompt budget, layer reuse, `--low-resource`, agent wall-clock cap) are tested as mechanisms only. Savings are **not yet measured**. Token counts default to an estimate (characters / 4).
- Every row in `ACCEPTANCE_CRITERIA.md` is a proposal, unmeasured.
- Deferred by instruction: live evals, a second domain or provider, cost and hardware benchmarks.

## Reliability and duplicates

- XO is **not** an exactly-once system. A duplicate external effect is still possible when a destination lies about idempotency, a lookup lags, two runners share one run directory (guarded on one host, advisory only), or an effect happens outside a connector.
- The single-writer guard is advisory, single-host, and not a distributed lease. A reused pid can make a stale lock look live.
- The journal detects tampering, not whole-directory deletion. Anchors cover only entries up to the last anchor, and the sink must be outside an attacker's reach.
- Rate limits are per process. forEach conformance vectors are not written.

## Security

- `xo serve` has had no independent security review and is **not** claimed ready for the public internet: per-address (not per-client) limits, no certificate hot-reload, no log rotation or signing, bearer-token replay if TLS is defeated.
- MCP stdio servers are confined by default on Linux. The bubblewrap path has not run on a real host here (its adversarial tests are skipped without bubblewrap). macOS and Windows have no confinement.
- The older `http` connector resolves DNS and then connects by name (DNS-rebinding race not closed; the webhook connectors close it for themselves). The SQLite driver is synchronous. SMTP is tested only against a fake server.
- Quoted source sentences are scrubbed only in the workflows component and report.

## Automation reach

- Reading approval documents works only for the few sentence shapes the extractor recognises; most policies still need a person to review what was compiled.
- `LayerCache` reuses a loaded package by object identity; mutating a bundle after load is not detected.
- An abandoned model call at the wall-clock cap is not cancelled and may still be billed. A running tool is not interrupted.

## Found in UW-0 (main `26f0052`; see `docs/baseline/UW0_BASELINE.md`)

Each item names the workstream that owns the fix. None is fixed by UW-0 except where stated.

- **XOIR node hashes include `createdAt`** (`packages/xoir/src/hashing.ts`), so two nodes with identical content created a millisecond apart hash differently. This made a `@xo/xoir` test fail intermittently in CI; the test now uses a fixed clock. Whether `createdAt` belongs in the content hash is UW-1 (deterministic hashing, verify-on-load). `fromJson` does not re-verify node hashes (by design; `validateGraph` does).
- **Orphaned workflow runs** (`@xo/workflow-runtime`): a crash after a run's directory is created and before its first journal entry is durable leaves the run id unusable; `resume` and a second `start` both fail with `unknown run`. No effect has happened in that window. UW-7.
- **Batch status**: a `forEach` run with one failed item reports the parent as `failed` even when the other items completed. UW-7 (partial completion).
- **No cancel operation**: Workflow IR declares `cancellation.onCancel`, but the runner cannot cancel a run. UW-7 (ADR 0024).
- **`workflow-runtime` approvals are not bound to the action's content**: a signed decision covers run, step and approval id only. Inside an instance only the digest-bound primitive grants authority (ADR 0014). UW-8.
- **Two authorization systems in `apps/api`** (workspace roles and `PermissionManager`); the permission store is in-memory; API keys are revocable but never expire. UW-1 (ADR 0010).
- **`.xlsx` is not accepted by the API upload list**, and the merged XLSX reader flattens rows to text (no header detection, column types, dates or cell provenance). CSV has no quoted-field support (documented choice). UW-3.
- **`cht_` chat routes have no client** and are deprecated (ADR 0013); workflows have no conversation link yet. UW-2.
- **Five workflow execution paths and two trigger designs** exist side by side until UW-7 and UW-15 (ADRs 0011, 0025).
- **`@xo/intelligence-c6` is merged but not wired**; the API chat uses its own knowledge port. UW-4c.
- **Capability contracts have no typed outputs or effect class**: extractors emit `outputs: []`. UW-7.

## Known test failures

- None on `26f0052` locally (7,145 tests, 0 failures, 4 opt-in skips; by-name list in `docs/baseline/tests-26f0052.tsv`). The earlier `packages/benchmark` `p09c-closure` (#147) and `baseline.test` (#35) failures and the `apps/api` 40 s cap no longer reproduce.
- GitHub CI on `26f0052` failed on formatting, one flaky `@xo/xoir` test and the Studio visual path filters; all three are fixed on the UW-0 branch.
