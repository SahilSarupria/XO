# 0030: Pre-execution launch completion: every construct, the IR as the engine, production knowledge stores, and measured gates

## Status

Accepted under owner delegation, 2026-11-16 (PX-9). The owner gave Claude authority to decide everything needed to make
the pre-execution pipeline final for launch as a service. This is a delegated sign-off, not an independent review. It
closes the four limits the PX-8 hardening report stated (generation emitted `approve`/`decide` only; the Workflow IR was
not what ran; the knowledge base was plain files; the real-document benchmark is below its proposed bar) and settles
the four decisions ADR 0029 left to the owner. It amends ADR 0029 decisions 12, 14, 16 and 17 as written below.

Amended 2026-11-16 by [ADR 0031](0031-generated-workflow-execution-boundary.md): connector calls are authorized again at
the moment they are made, approval signing uses a durable governed key, runs are leased across instances, and file-store
knowledge moves into SQL on first use.

## Decisions

1. **Generation emits every Workflow IR construct, each only on its own evidence** (amends 0029 decision 12).
   - `approve`: a step under a human task contract. A deadline the source states (`within 2 days`) becomes the timeout;
     a timeout escalates and never approves.
   - `decide`: a rule-bound step, rules rendered from the stated conditions. When a later step names one of its
     outcomes, a `branch` on the decision routes to it.
   - `wait`: a delay the source states (`wait 24 hours`, `wait for at least 2 days`). No stated delay, no wait.
   - `act`: a declared operation (OpenAPI, JSON, CSV) **with a connector binding** in the workspace. The binding is the
     operator's statement of the connector, operation, side effect and host adapter; sources say an operation exists,
     only the operator knows where it goes and what it changes. An effectful act carries the server-derived idempotency
     key `{{workflow.id}}:{{run.id}}:{{step.id}}` (plus `{{run.index}}` inside a loop). Input and output names keep the
     contract's own names, so the adapter's request and result match.
   - `compensate`: only when the binding names an undo operation. A read has nothing to undo, and a binding that says
     so is refused.
   - `extract`: when the goal says runs receive free text (`intake: "text"`), a leading extract step fills the
     workflow's inputs.
   - `for_each`: when the goal names the list the workflow repeats over (`forEach`). The list is a bounded JSON input
     (1 MiB).
   - Anything without its evidence is reported and blocks; nothing is invented to make a definition complete.
2. **Connector bindings are workspace data, governed like every other decision.** `PUT /workspaces/{ws}/connector-bindings`
   needs the manage role and a recent sign-in, is revision-guarded and audited (`connector-bindings.updated`). One
   parser (`parseConnectorBindings`, `@xo/pre-execution`) validates them for the API and the CLI. A certificate binds
   the digest of the bindings its steps use, so changing a binding makes it stale.
3. **The Workflow IR is the execution engine for generated workflows** (amends 0029 decision 12).
   `POST /workspaces/{ws}/generated-workflows/{id}/runs` runs the stored, certified IR through `@xo/workflow-runtime`:
   act/compensate go through `ConnectorHost` to the host adapter the binding names, approvals wait for a reviewer whose
   decision the server signs, and waits and timeouts are advanced by the server. This path **always** requires a
   current READY or READY_WITH_CONDITIONS certificate; there is no setting that turns it off. The composed-candidate
   runner stays for authored Studio workflows.
4. **Knowledge stores for production** (amends 0029 decision 16). `KnowledgeStore` gains `exclusive()` (one writer at a
   time, across processes) and `close()`.
   - `sqlite` (default): one database per instance at `<data>/knowledge.sqlite`, WAL, write-once rows checked by
     digest, a hash-chained event log, a schema version guard, online backup (`backupSqliteKnowledge`, `VACUUM INTO`).
   - `postgres` (`@xo/knowledge-store-postgres`, `XO_KNOWLEDGE_STORE=postgres` + `XO_KNOWLEDGE_DATABASE_URL`): for
     several API instances; writers serialise on a transaction-scoped advisory lock per tenant; backup and restore are
     the database's own (`pg_dump`/PITR).
   - `file`: development only; refused in production.
   - Tenants are isolated by key in every store. A stale write (`stale_base`) is refused, never merged.
5. **The certificate is required by default in production.** `XO_READINESS_CERTIFICATE=required` is the production
   default; `workspace` (the per-workspace trust setting decides) is allowed in production only with
   `XO_ALLOW_UNCERTIFIED_STARTS=1`. Studio, on `XO_READINESS_CERTIFICATE_REQUIRED`, asks for the workflow's
   certificate and starts with it when it is READY; otherwise it says what stands in the way.
6. **Allowed READY_WITH_CONDITIONS conditions are exactly two, both explicitly bounded** (settles 0029 decision 14):
   an unstated step order the owner accepted, and a source-quality finding a reviewer waived (one condition per waiver,
   naming it). 0029's "ambiguous-precedence tie-break" is **not** a condition: a tie the goal does not decide asks a
   question (NEEDS_REVIEW). Mandatory gates never degrade.
7. **The scope ambiguity margin stays 15%, validated, not assumed.** `goal-selection-labelled.test.ts` holds labelled
   goal-selection cases (select, clarify, no match); the margin decides every one as an operator would, and never
   selects between equal scores. A labelled case that fails is the evidence for changing it.
8. **Benchmark methodology: floors gate now, targets stay targets** (settles 0029 decision 17). The 90 / 90 / 0
   real-document targets are not met (blind: 114/143 read right, 114/168 output precise, 7 silent losses) and are not
   ratified as gates; ratifying them now would block every run, ratifying lower ones would be choosing thresholds after
   seeing numbers. Instead each real-document threshold carries a **ratified non-regression floor** at the value
   measured at UW-3c, which fails `npm run eval -- --check` on any regression. The targets become gates only when a
   fresh blind set, never used for tuning, meets them; that is a launch criterion in the register, not a code change.

## Consequences

- `READINESS_POLICY_VERSION` is `xo.readiness-policy.v2`; v1 certificates are stale and are reissued.
- The pre-execution side is complete: every construct the runtime executes can be generated from evidence, the IR that
  is certified is the IR that runs, and the knowledge base has production storage. What remains is measurement (the
  blind-set targets), not missing pipeline.
- The frozen roadmaps (`specs/`, `docs/ROADMAP.md`) are not edited.
