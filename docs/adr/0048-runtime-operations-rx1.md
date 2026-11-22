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
