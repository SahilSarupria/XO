# Post-readiness runtime spec: gap audit (RX-0)

**What this is.** A section-by-section map of "XO Post-Readiness Workflow Runtime, Execution and Learning" (spec 1.0, 14 Nov 2026,
with the XO Connect update) against the repository at the top of wave W3 (branch `uw-15/automation-drift-reuse`, 2026-11-22). It is
the spec's own E0/C0 step (sections 19, 9.12) and deliverable 1 (section 21). No code changes. The owner decisions the spec asks for
(section 22) are recorded in ADR 0045.

**Statuses**

- **Done:** in the code, with tests (reference given).
- **Partial:** some of it is in the code; the missing part is named.
- **Planned:** owned by a workstream already in the plan (Revision 4): UW-8, UW-12b (W4); UW-11, UW-16, UW-13 (W5).
- **New (V1):** not in the plan, and needed for the first vertical (certificate distribution). Proposed as **RX-1** in wave W4.
- **Horizontals:** not needed for V1; belongs to the horizontals phase after Studio is production-ready.

**Method.**

- Code and tests were read, not assumed. Where this says "Done", a test that proves it is named.
- R1–R6 follow ADR 0011: R1–R3 live in `@xo/runtime` (the capability port), and R4–R6 are delivered through the canonical engine
  (`@xo/workflow-runtime`).
- Nothing here re-verifies the historical claims about R1–R3 beyond the tests named.

## Summary

| Area                                                                         | Status                                                                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Readiness handoff, start re-verification, pinned versions (sections 1, 3, 5) | Done, except Domain Knowledge Pack digests (New V1, RX-1d)                                                               |
| One engine, IR constructs, loops, waits (section 6)                          | Done for the supported set; parallel branches and subworkflows are unsupported and rejected                              |
| Strategy routing R1–R5 (sections 4, 7)                                       | Partial: strategies declared and checked in readiness; hybrid is not routed as its own strategy                          |
| Authorization at the point of use, approvals (section 8)                     | Done (PX-10, UW-7); separation of duties and batch approval Planned (UW-8); standing approvals Planned (UW-16)           |
| Emergency stop / kill switches (sections 8, 13, 18.20)                       | Partial: workspace pause only. Scoped kill switches New V1 (RX-1a)                                                       |
| Connector framework, OAuth, receipts, delivery states (section 9)            | Done for V1 providers (UW-9, UW-10, UW-12a); registry, event gateway, Composio, sandboxing Horizontals                   |
| Retries, idempotency, unknown outcomes, crash recovery (section 10)          | Done in the engine; connector rate limits not wired in the API (New V1, RX-1c)                                           |
| Compensation and partial success (section 11)                                | Done for declared compensation (UW-7)                                                                                    |
| Human tasks, waits, resume (section 12)                                      | Done; request-changes, delegate and revoke outcomes Planned (UW-8, UW-12b)                                               |
| Observability, audit bundles, runbooks (section 13)                          | Partial: audit log export and metrics exist; signed per-run audit bundle over the API and runbooks New V1 (RX-1b, RX-1g) |
| Outputs and delivery (section 14)                                            | Done for email delivery state; typed output artifacts Planned (UW-12b)                                                   |
| Post-run learning (section 15)                                               | Planned (UW-11); the engine's promotion loop already never auto-applies                                                  |
| API, CLI, Studio parity (section 17)                                         | Partial: API complete, Studio screens Planned (UW-12b), CLI partial                                                      |
| Mandatory scenarios (section 18)                                             | 18 Done, 1 Planned, 1 not applicable after RX-1; see the table and `MANDATORY_SCENARIOS.md`                              |

## Section by section

### 0–2 Mission, invariants, scope

- **Done.** The invariants hold as follows:
  - Certificate re-verified at start: PX-7, `startGeneratedRun` in `apps/api/src/routes/generated-run-routes.ts`.
  - Authorization at each effect: PX-10, ADR 0031; test `generated-run-boundary.test.ts`, "effects are authorized when they happen".
  - Default deny: `RuleBasedPolicy([])` denies.
  - No exactly-once claim: `docs/KNOWN_LIMITATIONS.md`.
  - Intent persisted before effects: the journal in `packages/workflow-runtime/src/journal.ts`.
  - Models have no authority: UW-6, UW-14.
- **Out of scope, as the spec says:** rebuilding ingestion, XOIR, BKB or generation.

### 3 End-to-end architecture

- **Done:** steps 1–9, through the generated-workflow path (`…/generated-workflows/{id}/runs`) on the canonical engine.
- **Planned:** step 10, learning (UW-11).

### 4 Frozen runtime roadmap R1–R6

- **R1, authoritative strategy:** **Done.** `ExecutionStrategy` and `DEFAULT_RUNTIME_SUPPORT` are in `packages/pre-execution/src/capability-inventory.ts`, with four independent readiness answers (eligible, bound, runtime-supported, authorized).
- **R2, input contracts:** **Done.** Run inputs are validated before anything runs, and wrong shapes are refused (PX-10). Typed outputs come from UW-7.
- **R3, confidence and authorization gating:** **Done**, as independent gates (readiness gates `capabilities` and `authorization`; effect authorization).
- **R4, router:** **Partial.**
  - Present: deterministic, human, model-assisted (`extract`) and connector steps route through the engine.
  - Missing: a typed strategy registry with an explicit fail-closed "unsupported strategy" error at the router. Today `runtimeSupport` makes readiness `BLOCKED` instead, so it fails closed, but earlier, not at the router.
- **R5, hybrid:** **Partial.**
  - Present: deterministic plus model steps composed in one workflow (`extract` then `decide`).
  - Missing: no `hybrid` strategy is routed as such (it is not in `DEFAULT_RUNTIME_SUPPORT`).
  - Proposal: keep it unsupported for V1 (ADR 0045, envelope).
- **R6, production semantics:** **Done** in the engine:
  - durable ids and journal;
  - idempotency (`supports_key`, `supports_lookup`);
  - cancellation (UW-7);
  - timeouts (approval timeouts escalate; `wait` has `onTimeout`);
  - retries with declared backoff and jitter (IR `retry`, `packages/workflow-ir/src/schema.ts`);
  - replay (`replayRun`, `explain.ts`) and shadow simulation (`shadow.ts`).
- Still in R6:
  - Replay is not exposed over the API (RX-1e).
  - Collision handling is covered by the capability inventory's id and contract-hash checks.

### Domain Knowledge Pack pinning at runtime

- **Partial.**
  - Present: packs are pinned by digest in packages (PX-4), and the certificate binds the knowledge state (`CertificateBindings.knowledgeState` in `packages/pre-execution/src/readiness.ts`).
  - Missing: the certificate does not list pack digests, so a pack upgrade is not a certificate change by itself.
- **New V1 (RX-1d):** add `packs: [{ id, namespace, version, digest }]` to the certificate bindings and the run manifest. Admission refuses a missing, revoked or changed pack. Replay is marked non-reproducible without the pinned packs.

### 5 Run identity, manifest, lifecycle

- **Done:**
  - Stable run ids, and the workflow and version recorded before the first journal entry (UW-2).
  - The certificate binds:
    - the source-set, artifact and XOIR digests;
    - the knowledge state;
    - the inventory and contract hashes;
    - the definition, goal and bindings digests.
  - Lifecycle derived, never stored twice (UW-2, `docs/WORKFLOWS.md`).
  - Effect states mapped onto six O-3 states (UW-7, `docs/EFFECTS.md`).
- **Partial:** there is no single immutable run-manifest document that gathers all of the spec's fields (connection ids, runtime version, budget) in one place.
  - **New V1 (RX-1b):** a manifest record written at admission, built from what is already bound.
- **Vocabulary:** the spec's state names map onto the repository's lifecycle as follows:
  - `needs_attention` covers unknown_outcome and reconciliation_required;
  - `partially_completed` covers partially_succeeded;
  - `timed_out` is an escalation.
- No parallel state machine is to be added.

### 6 Workflow orchestration and IR

- **Done:** one IR and one engine (ADR 0011, ADR 0035).
- **Supported constructs:**
  - `extract`, `decide` (tree, rules, formula, lookup), `act`, `approve`, `branch`;
  - `wait` (timer, event, approval), `compensate`, `escalate`;
  - `forEach`, bounded; the bounds are checked before start (PX-10).
- **Persistence and recovery:** durable timers and leases (`lease.ts`), and conformance vectors in `packages/workflow-ir/conformance`.
- **Not supported:** parallel branches and subworkflows. The IR has no such step types, and unknown types fail schema validation (rejected before start). Recorded as outside the envelope (ADR 0045).

### 7 Invocation envelopes and strategies

- **Done:**
  - Connector actions go through `ConnectorHost` with declared side effects, idempotency attestations and receipts (`effects.ts`, `reconcile.ts`).
  - Secrets reach adapters only through the UW-9 broker (`use`, wrapped secrets).
- **Partial:** there are no formally versioned invocation and result envelope types shared by every strategy. That is the typed-registry part of R4.
  - Not needed for V1. **Horizontals**, together with the connector contracts (section 9.3).

### 8 Authorization, approvals, policy

- **Done:**
  - One authorization point (UW-1).
  - Re-authorization at each effect: starter role, pause, binding, capability (PX-10).
  - Approvals are signed, identity- and role-checked, expire, single use (`packages/workflow-runtime/src/approvals.ts`: `expiresAt`, `ApprovalError('EXPIRED')`), and payload-bound (`payload-approval.ts`).
  - Step-up sign-in within 15 minutes for decisions (UW-1).
  - Secrets never in prompts, logs or audit (UW-9, UW-14).
- **Planned:**
  - Batch-bound approval and the separation-of-duties decision (UW-8).
  - Standing approvals (UW-16).
  - Delegation and quorum (UW-8, by ADR 0045's default: single approver).
- **Emergency stop:**
  - **Partial.** The workspace pause is enforced at start, at schedule slots and at every effect (PX-10).
  - The engine has a `killSwitch` hook (`runner.ts`, escalating `KILL_SWITCH`), but the API does not pass it.
  - There are no workflow-, capability-, provider- or instance-scoped switches.
  - **New V1 (RX-1a).**

### 9 Connectors (with XO Connect 9.1–9.12)

- **Done for V1:**
  - The UW-9 broker: OAuth code with PKCE, sealed per workspace, scopes by capability, refresh and revocation, no `get`.
  - Pinned egress with DNS-rebinding protection.
  - Email in three tiers, with delivery state and lookup before any decision (UW-10).
  - Drives and the local agent (UW-12a).
  - Two providers behind one contract (Gmail and Graph, and SMTP for `message.send`), which is the 9.11 "two independent providers" proof.
  - Receipts and reconciliation by a person (UW-7).
  - Read and write scopes separate (`files.read`, `mail.lookup` and `message.send` are distinct capabilities).
  - Multiple accounts are explicit credentials, and a binding names one; the account is never inferred.
- **Partial:**
  - **Rate limits and circuit breakers.**
    - The engine has `CircuitBreakers` (per connector, per process, default 5 failures and 30 s) and optional `RateLimiters`; the API wires only the breakers' defaults.
    - Email pacing and daily caps are in the email connector.
    - **New V1 (RX-1c):** wire the rate limiters from the settings registry, per connector.
- **Horizontals:**
  - A formal Connector Registry, with manifests, operation declarations and versioned deprecation (9.2.1, 9.3).
  - An Event Gateway for provider webhooks and polling, with signature checks, a durable inbox and subscriptions (9.6, C4).
  - The Composio adapter (9.5, C5).
  - Sandboxing, signing and supply-chain records for third-party adapters (9.7, 9.9).
  - Slack, Teams, GitHub, CRM, ERP, database and generic OpenAPI connectors (9.11).
  - Conformance items 1, 16 and 18 (9.10).
  - XO's own inbound webhook is an authenticated API route (API key), not a provider webhook.

### 10 Reliability

- **Done:**
  - Retry only when declared safe.
  - Idempotency keys derived by the server.
  - Unknown outcomes escalate and are never retried blindly (PX-10, UW-7).
  - Cancellation is recorded first.
  - Run leases across processes (PX-10).
  - Crash injection at every journal boundary: `packages/workflow-runtime/test/duplicate-window.test.ts`, "a process that dies at EVERY journal boundary".
  - Durable evidence across restarts: `apps/api/test/external-effect-durable-m4.test.ts`, "crash window … blocked until reconciled".
- **Partial:** provider rate limiting and backoff in the API (RX-1c).

### 11 Compensation and partial success

- **Done:**
  - `compensate` steps exist only where a binding declares a compensation operation (PX-9).
  - `onCancel` policy is abandon or compensate (UW-7).
  - Batches report `partially_completed`.
  - The six effect states separate completed, failed, compensated and unknown effects.
- Compensation is never called a rollback (`docs/EFFECTS.md`).

### 12 Human tasks, waits, resume

- **Done:**
  - Approvals and escalations are durable nodes.
  - Resume uses the pinned run and recorded decisions.
  - Stale approvals fail closed (`approval-binding.ts`).
  - Effect-time re-authorization covers changes while paused.
- **Planned:** request-changes, delegate and revoke outcomes, and an assignment queue in Studio (UW-8, UW-12b).

### 13 Observability, audit, operations

- **Done:**
  - Hash-chained, externally anchored workspace audit logs (UW-1).
  - `/metrics`, `/readyz`, JSON logs (UW-17).
  - The audit log export route (`exportAudit`, `apps/api/src/routes/workspace-admin-routes.ts`).
  - The run explanation (`explain.ts`).
  - The exceptions queue over the API (UW-15).
- **Partial:**
  - The engine can build a signed per-run audit bundle (`AuditBundle` in `packages/workflow-runtime/src/audit.ts`: Merkle root, Ed25519 signature), but the API does not export it for generated runs. **New V1 (RX-1b).**
  - Operator tools exist for pause, cancel and reconcile over the API; Studio screens are Planned (UW-12b).
- **New V1 (RX-1g):** runbooks for incident, provider outage, credential revocation, unknown side effect, recovery, deletion and emergency stop. Today there are `docs/AUTOMATION_OPERATIONS.md`, `docs/audit-operations.md` and `docs/package-trust-operations.md`, but none of the seven.
- **SLOs:** none defined, as the spec asks (baseline first).

### 14 Outputs and delivery

- **Done:** internal completion is kept apart from delivery for email ("accepted" is not "delivered", UW-10). Attachments are content-addressed workspace sources.
- **Planned:** typed output artifacts with access policy and expiry shown to users (UW-12b).

### 15 Post-run learning

- **Planned (UW-11):** change sets from run corrections, bound to the run, never auto-applied.
- **Already true:** the engine's promotion loop never auto-applies (`promote.ts`), and knowledge changes go only through reviewed change sets (UW-4). Knowledge change management is done (ADR 0050): preview, rollback, dependency-scoped certificates.

### 16 Security and multi-tenancy

- **Done:**
  - Cross-tenant matrices (UW-9).
  - Outsiders get 404 everywhere.
  - Sealed per-workspace secrets.
  - The residency guard and leak guard (UW-14).
  - The injection corpus (UW-6, UW-13).
  - Egress pinning.
- **Horizontals:** sandboxing third-party adapter code.

### 17 API, CLI, Studio

- **Done:**
  - The API covers create, inspect, cancel, approve, reconcile and the change feed with long-poll (UW-2).
  - Conversations link to workflows (UW-2).
- **Partial:**
  - Studio: the pre-start check, runs and approvals are present; the cancel and reconcile screens and the run timeline are Planned (UW-12b).
  - CLI: generation and local runs only.

### 18 Mandatory scenarios

| #   | Scenario                                                      | Status         | Evidence or owner                                                                                                        |
| --- | ------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Deterministic workflow, no model call                         | Done           | Generated-run tests run with no provider (`generated-workflow-runs.test.ts`)                                             |
| 2   | Invalid input rejected before any effect                      | Done           | PX-10: wrong shapes and oversize items refused before anything runs                                                      |
| 3   | Default deny                                                  | Done           | `RuleBasedPolicy([])` in scheduler and run tests                                                                         |
| 4   | Permission revoked during a paused run                        | Done           | `generated-run-boundary.test.ts`: "a pause, a lost role or a changed binding while a run waits stops the effect"         |
| 5   | Approval digest mismatch or expiry blocks resume              | Done           | `approvals.ts` (`EXPIRED`, signature, single use); `payload-approval.ts`                                                 |
| 6   | Model proposes an unauthorized action                         | Done           | UW-6 injection corpus (`intent-injection-corpus.test.ts`); proposals have no authority                                   |
| 7   | Timeout before vs after dispatch                              | Done           | `duplicate-window.test.ts` ("in-process ambiguity")                                                                      |
| 8   | Crash after acceptance, before receipt                        | Done           | `external-effect-durable-m4.test.ts` ("crash window … blocked until reconciled")                                         |
| 9   | Duplicate start requests                                      | Done           | PX-10: retried requests are the same run; webhook replay returns the same `runId` (`composed-runner-retirement.test.ts`) |
| 10  | Parallel branch failure policy                                | Not applicable | Parallel branches are not an IR construct; unknown step types are rejected (ADR 0045)                                    |
| 11  | Loop exceeds bounds                                           | Done           | PX-10 forEach bounds; `packages/workflow-ir/conformance` vectors                                                         |
| 12  | Cancellation in deterministic, human-wait and connector steps | Done           | UW-7 (`cancel.test.ts`, ADR 0033)                                                                                        |
| 13  | Compensation succeeds, fails, partly succeeds                 | Done           | UW-7 and RX-1h; see `MANDATORY_SCENARIOS.md`                                                                             |
| 14  | Provider rate limit, bounded backoff, deadline                | Done           | RX-1c end to end (`rate-limits.test.ts`); see `MANDATORY_SCENARIOS.md`                                                   |
| 15  | OAuth revoked or expired blocks and asks to reconnect         | Done           | UW-9 (`invalid_grant` ends the credential); readiness blocks an inactive credential (`readiness.ts`, UW-10)              |
| 16  | Tenant isolation                                              | Done           | UW-9 cross-tenant matrix; 404 for outsiders                                                                              |
| 17  | Replay uses pinned versions                                   | Done           | RX-1d and RX-1e (`pack-pinning.test.ts`); see `MANDATORY_SCENARIOS.md`                                                   |
| 18  | Post-run correction proposes, never activates                 | Planned        | UW-11 (UW-4 change sets already require approval)                                                                        |
| 19  | Accepted but delivery unknown is not "delivered"              | Done           | UW-10 delivery projection                                                                                                |
| 20  | Kill switch stops new dispatch, handles in-flight work        | Done           | RX-1a (`emergency-stop.test.ts`); see `MANDATORY_SCENARIOS.md`                                                           |

### 19–21 Work plan, execution model, deliverables

- **E0 and C0:** this document.
- **Parallel agents:** the spec's parallel-agent model (section 20) is not used. One stacked PR per workstream fits the owner's usage budget, as decided on 2026-11-21.
- **Deliverables 2–12:** they exist as ADRs and guides:
  - ADR 0011 and 0031–0044;
  - `docs/WORKFLOWS.md`, `docs/EFFECTS.md`, `docs/CREDENTIALS.md`, `docs/EMAIL.md`, `docs/SOURCE_CONNECTIONS.md`, `docs/RESIDENCY.md`;
  - the IR conformance vectors.
- **Gaps in deliverables:** the runbooks (11) and a production readiness report per R milestone (12) are missing. The runbooks are RX-1g; the readiness report is due at V1 exit (UW-13).

### 22 Owner decisions

- Recorded in ADR 0045 with conservative defaults, under the owner's delegation.

### 23 Definition of done

- Met for the V1 envelope except the RX-1 items and the Planned items above.
- Not met for the horizontals (registry, event gateway, Composio, sandboxing), which are outside the V1 envelope by ADR 0045.

## Update, 2026-11-23: RX-1 delivered

RX-1a to RX-1h are implemented (ADR 0048, PRs #48 to #50): scoped emergency stops that hold work, the run manifest and signed audit bundle, connector rate limits and provider pauses, pack pinning, replay and explain over the API, the seven runbooks (`docs/runbooks/`), and the scenario index (`docs/runtime/MANDATORY_SCENARIOS.md`, checked by `apps/api/test/scenario-index.test.ts`). 18 of the 20 mandatory scenarios are Done; scenario 10 is not applicable and scenario 18 (post-run correction) is Planned for UW-11. UW-12b (minimal, ADR 0047) added the Studio cancel and reconcile screens and the approval inbox. The rows above keep their original wording where nothing changed.

## Proposed RX-1 (wave W4, beside UW-8 and UW-12b)

1. **RX-1a Scoped emergency stop.**
   - Switches by workspace (exists), workflow, capability, connector and instance.
   - Set with the manage role and a recent sign-in; audited.
   - Checked at admission, at schedule slots and through the engine's `killSwitch` before every dispatch.
   - In-flight calls follow UW-7 (an in-flight call becomes `outcome_unknown`).
2. **RX-1b Run manifest and audit bundle.**
   - A manifest written at admission from the bound digests.
   - `GET …/runs/{runId}/audit-bundle` returns the engine's signed `AuditBundle`, plus a verify route.
3. **RX-1c Connector rate limits** from the settings registry, wired into the runner, with deadline-aware backoff; scenario 14 end to end.
4. **RX-1d Pack pinning.** Pack digests in the certificate bindings and the manifest; admission refuses a missing, revoked or changed pack.
5. **RX-1e Replay and explain over the API** (read role), marked non-reproducible when a pinned artifact is missing.
6. **RX-1g Runbooks:** the seven named in section 21.11.
7. **RX-1h Scenario index.** A test per mandatory scenario that applies, named in one index file. It adds the failing-compensation case (13) and the end-to-end rate-limit (14), replay (17) and kill-switch (20) cases.

Separation of duties, batch approval and delegation stay with UW-8. Learning stays with UW-11.
