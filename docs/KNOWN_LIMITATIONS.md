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

## Known test failures not caused by this work

- `packages/benchmark` `p09c-closure` (#147) and `baseline.test` (#35) fail at the branch's starting commit; `apps/api` tests exceed the 40 s cap.
