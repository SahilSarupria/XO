# 0048: Runtime operations for the first vertical (RX-1)

## Status

Accepted under the owner's delegation, 2026-11-23. Implements the RX-1 items proposed in `docs/runtime/RUNTIME_SPEC_GAP_AUDIT.md` (ADR 0045 support envelope). Each part lands in its own stacked PR; this record grows with them.

## RX-1a: Scoped emergency stop

### Context

- Only a workspace pause existed. It refuses starts and refuses each call at the effect gate. A refused call fails its step for good (`DENIED`), so a pause during a batch turns the rest of the batch into failures for a person.
- The engine had a `killSwitch`, which _escalates_ the run, but nothing in the API wired it.
- There was no instance-wide switch and no switch for one workflow, one connector or one operation.

### Decision

1. **Scopes:**
   - **instance:** set only by an operator on the machine (`xo instance emergency-stop --reason …`, `--release`, `--status`), as a file in the data directory. No workspace role is an instance role, and the switch must work when the API does not answer. Every API process sharing the directory sees it at its next check.
   - **workspace:** the existing pause, unchanged.
   - **workflow:** a `wfl_` workflow (every version) or a `gwf_` generated workflow.
   - **connector:** a connector bound in the workspace.
   - **capability:** `<connector>.<operation>`, bound in the workspace.
   - The last three are set over the API (`POST /workspaces/{id}/emergency-stops`, `…/release`), with the manage role and a recent sign-in. They are audited as `emergency-stop.engaged` and `emergency-stop.released`. A stop on a target that does not exist is refused (404): it would look engaged and hold nothing.
2. **A stop holds; it does not end work.** A new engine option, `hold`, is checked before every step, before every item of a batch, and for an `act` step with its connector and operation. While it holds:
   - the run stays where it is, and nothing is journaled, escalated or failed;
   - a call already in flight finishes and is recorded;
   - once the stop is released, the run carries on at the next resume (the minute tick, or a read of the run). Each item still acts once, under its own key.
   - The engine's `killSwitch`, which escalates, is unchanged and not used by the API.
3. **Three checks:**
   - **Admission:** a start or preview of a workflow that is stopped, or that declares a stopped connector or operation, is refused (412, reason `emergency_stop`, audited as `emergency-stop.refused`). Schedules and webhooks start through the same function.
   - **Hold:** described in 2.
   - **Effect gate:** a call that races the hold is refused at the gate and never sent.
4. **Failing closed:**
   - An instance-stop file that cannot be read counts as engaged.
   - A workspace stop record that cannot be read stops everything in the workspace, and is never overwritten by the API.
5. **Visibility:** the run view carries `held` (which stop). `GET /workspaces/{id}/emergency-stops` (read role) lists the instance stop, the pause and the scoped stops.

### Consequences

- Mandatory scenario 20 holds end to end: no call starts after the stop; the call in flight finishes; after release every item is sent exactly once (`emergency-stop.test.ts`).
- A held run still ages toward its run timeout.
- Studio has no screen for the stops yet: use the API or the CLI. The emergency-stop runbook covers both (RX-1g).

## RX-1b: Run manifest and audit bundle

### Context

- The engine can build and verify a signed `AuditBundle` (Merkle root over hash-chained journals, Ed25519). The API did not export one for generated runs.
- What a run was bound to was spread across the run record, the certificate, the bindings and the batch approval.

### Decision

1. **A manifest per run**, written once at admission, before the run's first journal entry (a retried start keeps the first). It holds:
   - the definition and its component digest, and the workflow and version;
   - the certificate and its digest;
   - per connector, the digest of its bindings and sending account;
   - the input digest and the batch approval;
   - the pinned packs (RX-1d);
   - the initiator and the admission time.
   - It holds digests and ids, never the input. Its own digest is stored beside it, and a read reports `digestOk`.
   - Route: `GET …/runs/{runId}/manifest` (read role).
2. **The audit bundle:** `GET …/runs/{runId}/audit-bundle` (audit role) returns the engine's bundle of the run and, for a batch, every item. It includes the component bytes' digest, the connector grants and the manifest, and is signed with the instance's approval key (`signer` = key id). It is audited as `generated-workflow.audit-bundle.exported`. The bundle holds the journals in full, arguments included, hence the audit role.
3. **Verification:** `POST /workspaces/{id}/audit-bundles/verify` (read role) checks:
   - the signature, under every key ever active on the instance;
   - the Merkle root;
   - every hash chain;
   - the manifest's digest.
   - The same check runs offline with the public key (`verifyAuditBundle`).

### Consequences

- Runs admitted before this change have no manifest (404); their bundle has no `manifest`.
- An item of a batch has no manifest of its own: its batch's manifest covers it.

## RX-1c: Connector rate limits

### Context

- The engine had a per-connector token bucket (`RateLimiters`), but the API never set one.
- A provider's "slow down" stopped work. Gmail's `rateLimitExceeded` and every Graph 429 were treated as the daily quota: every later send that day was refused untried (UW-10). The engine also had no way to honour a requested pause.

### Decision

1. **`XO_CONNECTOR_RATE_LIMITS`** (settings registry): `<connector>=<perSecond>[/<burst>]`, comma-separated, with `*` as the default. Unset means no XO limit. An invalid value stops start-up.
   - One limiter set per workspace for the life of the process, shared by every runner, so the pace holds across requests and batches.
   - A call whose slot would come after its step deadline fails `RATE_LIMITED` without being sent (the engine's existing check).
2. **A provider's "slow down" is a pause, not a stop.**
   - `ConnectorError` gains the code `RATE_LIMITED` and `retryAfterMs`. The adapter contract's `confirmed_failure_no_effect` gains `retryAfterMs` (code `rate_limited`).
   - The mail connectors map Gmail 429, `rateLimitExceeded` and `userRateLimitExceeded`, and Graph throttling, to it, with the `Retry-After` the provider sent (bounded to 1 s to 10 min; 2 s when absent).
   - The daily quota (Gmail `dailyLimitExceeded`/`quotaExceeded`, Graph message-limit errors) still stops the day's sends, as UW-10 decided.
3. **The engine honours the pause.** A refused call that provably did nothing:
   - records the pause in the limiter (`backoff`), so every later call to that connector queues behind it;
   - is made again after the pause, at most 5 times, while that fits the step deadline;
   - otherwise fails `RATE_LIMITED`, provably not sent.
   - A "slow down" does not count toward opening the circuit breaker.

### Consequences

- Mandatory scenario 14 holds end to end (`rate-limits.test.ts`): pacing across a batch, a requested pause honoured with each item sent once, and a pause past the deadline failing without sending. Calls that already held a slot when the pause began may still go; none starts after it.
- Limits are per process, as `RateLimiters` documents. Several processes sharing a provider each keep their own pace.
- This supersedes UW-10's "never retried automatically" for short-term throttling only.

## RX-1d: Domain Knowledge Pack pinning

### Context

A certificate bound the knowledge state, and the state pins the packs it was built with. A pack installed later was not a new state, so it did not make a certificate stale.

### Decision

- The certificate bindings gain `packs`: every Domain Knowledge Pack installed in the workspace, as `packId`, `namespace`, `version` and `digest`. At admission, a pack removed, added or changed makes the certificate stale, so the start is refused, naming the pack.
- The run manifest records the pinned packs.
- Certificates issued before RX-1d carry no `packs` and are not checked for them.
- There is no pack revocation in the knowledge base. Removing a pack is how it stops being trusted, and that refuses the start.

## RX-1e: Replay and explain over the API

### Decision

- **Replay:** `GET …/runs/{runId}/replay` (read role) rebuilds the run, or an item, from its verified journal under the stored definition. Nothing runs or is sent.
  - It reports `reproducible: false`, with reasons, when:
    - there is no manifest;
    - the manifest does not match its digest;
    - the stored definition is not the one admitted;
    - the journal names another workflow version;
    - a pinned pack was removed or changed (a pack added since does not matter).
  - An item is checked against its batch's manifest.
- **Explain:** `GET …/runs/{runId}/explain` (read role) returns the engine's explanation, plus the same in plain lines.

### Consequences

- Mandatory scenario 17 holds: replay uses the pinned versions and says when it cannot (`pack-pinning.test.ts`).

## RX-1g: Runbooks

`docs/runbooks/` holds the seven runbooks the specification names (section 21.11): emergency stop, incident, provider outage, credential revocation, unknown side effect, recovery and deletion. Each says what to check first, what to do with today's API, CLI and Studio, what never to do, and when it is done. Two rules run through all of them: never re-send to find out whether something happened, and keep the evidence (the audit bundle) before changing anything.

## RX-1h: Mandatory scenario index

`docs/runtime/MANDATORY_SCENARIOS.md` lists the twenty scenarios with the tests that prove each. `apps/api/test/scenario-index.test.ts` checks that every scenario appears once, that every Done scenario names evidence, and that each named test file exists and has a test with that title, so the index cannot drift. A failing-compensation engine test was added for scenario 13. Result: 18 Done, scenario 10 not applicable (ADR 0045), scenario 18 Planned (UW-11).
