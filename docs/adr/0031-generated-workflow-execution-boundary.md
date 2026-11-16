# 0031: The execution boundary of generated workflows, and the knowledge-store transition

## Status

Accepted under owner delegation, 2026-11-16 (PX-10). It answers the review of PX-9 (ADR 0030): authorization at the
side-effect boundary, the approval signing key's lifetime, whether Studio uses the Workflow IR path, and the validations
the review listed (hostile loops, connector outcomes, approval timeouts across instances, SQLite restore, Postgres clean
start, the file-store transition). It amends ADR 0030 decisions 3 and 4.

## Decisions

1. **Every connector call is authorized when it is made, not only at start.** A certificate proves readiness at start; a
   run can then wait hours for a person or a timer while the world changes. Immediately before each call the platform
   re-reads, from current records, nothing cached:
   - the person who started the run is still a member with `author` under the operator policy (`PermissionManager`);
   - the workspace is not paused;
   - the workspace still binds this connector operation to the same host adapter with the same side effect, for the same
     capability;
   - the step's capability is still approved for its current contract.

   A refusal is `DENIED` with nothing sent, journaled as the call's outcome, audited as `generated-workflow.effect.denied`,
   and the run fails closed (escalates, or compensates the steps that did complete). An undo (`compensate`) is checked
   only against the binding: the revocation that stopped a run must not also stop it from being undone, but an undo still
   goes only where the operator's binding says. Who started a run is recorded before its first effect
   (`generated-runs/<id>/meta/<runId>.json`; the run id is fixed before the start); a `for_each` item acts for its parent
   run's starter. A start in a paused workspace is refused (412).

2. **Approval decisions are signed with a durable, governed key.** `XO_APPROVAL_SIGNING_KEY` (an Ed25519 PKCS#8 key,
   base64) is a secret, required in production, shared by every instance. In development a key is generated once into
   `<data>/approval-keys/generated.key` (owner-only) and reused across restarts. Every public key ever active is kept,
   write-once, in the keyring (`<data>/approval-keys/<keyId>.pub.pem`, `keyId` = the key's SHA-256). Rotation is setting a
   new key and restarting; decisions signed before it keep verifying. Each run view re-verifies every journaled decision
   against the keyring (`signatureVerified`, `keyId`). A pending approval needs no key until it is decided, so it survives
   any restart; a decision is signed and verified in the same request.
3. **One driver per run, across instances.** Every write to a generated run is fenced by the run's lease (fencing tokens).
   `LeaseAuthority` gains `crossProcess`: its critical sections also hold a per-run `O_EXCL` lock file, so instances
   sharing the data volume arbitrate the same runs. Each runner is its own lease owner; operations of one runner share
   its lease and the last releases it. A decision that meets a busy run waits for the lease; a tick skips a run another
   instance holds. Approval timeouts and timers are advanced by whichever instance holds the run.
4. **An unknown outcome is never failed or compensated** (a `@xo/workflow-runtime` rule). A connector call sent with no
   recorded outcome may have taken effect, so the run escalates (`EFFECT_UNKNOWN`) whatever `onError` says. A definite
   refusal with no effect is not retried; a retried request (same `Idempotency-Key`) is the same run.
5. **One certificate, one meaning: Studio's start is routed by what the definition needs.** The composed-workflow
   runner executes human tasks and rules. A certificate whose definition uses anything else (act, wait, branch,
   compensate, for_each, extract) is refused there with `XO_WORKFLOW_REQUIRES_IR_RUNTIME` (409, naming the definition and
   constructs), and Studio then starts it on the Workflow IR runtime with the same certificate, shows it in the pre-start
   check, and lets a reviewer decide its approvals there. Unifying both runners into one engine remains UW-7.
6. **Loops are bounded against hostile input** at three layers: the request body (1 MiB), the input declaration
   (`maxBytes` 1 MiB) and the runtime (`maxItems` 1000, concurrency 1). Too many items, too many bytes, the wrong shape and
   unknown inputs are refused before anything runs.
7. **Knowledge store transition and recovery.**
   - The first time a workspace's knowledge is opened on SQLite or PostgreSQL, knowledge it kept in the file store is
     copied in (`copyKnowledge`): every row through both stores' integrity checks, the event chain replayed digest for
     digest. The files stay, marked `MIGRATED.json`, and are never read again. A SQL store that already holds knowledge
     for the workspace is never merged into; that is reported as an error for the operator to resolve.
   - `restoreSqliteKnowledge` verifies a backup completely (schema, every row's digest, every event chain) before it
     replaces the live database atomically; a damaged backup changes nothing.
   - PostgreSQL: concurrent first starts against an empty database create the schema once (migrations run under the
     schema advisory lock); `verifySqlKnowledge` checks a whole database.

## Consequences

- Production needs `XO_APPROVAL_SIGNING_KEY` (start-up refuses without it); `deploy/instance.env.example` says how to
  make one.
- Mid-run changes to roles, policy, pause, bindings or approvals take effect at the next effect of every running workflow.
- The runtime's `escalated` (not `failed`) for an exhausted step with an unknown last outcome is a behaviour change; two
  runtime tests now say so.
