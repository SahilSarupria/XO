# Studio WP2 — Real Integration Hardening: Findings

Scope: Studio and its necessary platform integration dependencies. Verified against `main` + this branch, **before** the M2 authorization work merges. Everything under "workflows" and "execution" below must be re-verified after M2 lands, because that work changes `apps/api/src/executions/*`, `routes/execution-routes.ts`, `routes/workflow-routes.ts` and `workflows/workflow-runner.ts`.

## WP2-A — Approval of unresolved capabilities

**Verdict: confirmed as a correctness gap; disproved as an execution bypass.**

Capability binding states that exist in code and are returned by the API: `resolved | unresolved | ambiguous | denied` (`status` on the capability projection). Execution classes seen: `deterministic_rule`, `human_in_the_loop` (only on resolved capabilities).

Lifecycle, traced in source and exercised through real routes:

1. Compile lowers the graph and projects each capability with its binding `status` (`compilations/compile-source.ts`).
2. `GET .../capabilities` returns the projection plus `approved` (from the approval store).
3. **`POST .../approve` previously checked only that the capability exists in the compilation.** It then persisted an approval record. Evidence: a new route test (`NEGATIVE`) returned **200** on the unmodified route for an unresolved capability, and the existing suite had two tests that encoded this as intended (approve → 200, then execution refuses).
4. `POST .../executions` checks (a) approval record present, else 403 with no record created, then (b) **re-derives the binding from the stored graph** and refuses a non-resolved one with a persisted `failed` record and `XO_BINDING_UNRESOLVED`. This second check is what made this a correctness gap, not an exploit: an approval for an unresolved capability could never execute. Verified by test.
5. Runtime failure handling: failures are persisted structured records (HTTP 200), consistent with the rest of the API.

Why it was still worth fixing: an `approved: true` on a capability XO cannot carry out is a misleading acknowledgement, and it was recorded durably. If resolver behaviour ever changed for a stored compilation, a stale approval would silently become effective for something nobody reviewed in its executable form.

**Fix** (`apps/api/src/approvals/approval-eligibility.ts`, wired in `routes/source-compilation-routes.ts`): approval is refused unless binding status is `resolved`. The refusal uses the same error code execution reports for that status (`XO_BINDING_UNRESOLVED`/`AMBIGUOUS` → 422, `XO_BINDING_DENIED` → 403), records nothing, and fails closed on unknown statuses. The message deliberately omits the resolver's internal `reason` (it stays in the projection, visible in Builder Mode). Approval and execution remain separate; execution's own re-derivation and approval check are unchanged and still tested. No authorization mechanism was added; this is an eligibility filter, not M2.

**Tests** (`apps/api/test/approval-eligibility.test.ts`, real HTTP routes, real Commercial Property PDF):

| Test                                                           | Purpose                                                                           | Before fix       | After fix |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------- | --------- |
| NEGATIVE: approve unresolved                                   | 422 `XO_BINDING_UNRESOLVED`; stays unapproved; execution 403; no execution record | **FAILED (200)** | pass      |
| POSITIVE CONTROL: approve resolved                             | 200, recorded, nothing executed                                                   | pass             | pass      |
| DEFENCE IN DEPTH: seeded legacy approval record for unresolved | execution still `failed` `XO_BINDING_UNRESOLVED`                                  | pass             | pass      |
| Unknown capability → 404                                       | ordering unchanged                                                                | pass             | pass      |
| `approvalBlockedCode` mapping, unknown status fails closed     | unit                                                                              | pass             | pass      |

Two existing tests that approved an unresolved capability to prove the execution boundary now seed an approval record directly (same intent, same assertion). Four other tests that approved `capabilities[0]` of the markdown fixture (all unresolved) now use a resolved capability from the PDF fixture so they still test what they claim. OpenAPI now documents the 422/403.

Not changed: legacy approval records for unresolved capabilities (if any exist in a deployment) are not deleted. The projection reports them truthfully (`approved: true`, `status: unresolved`); Studio shows such a rule as "Needs more information", never as approved (unit-tested).

## WP2-B — Capability input contract: investigation and proposal (not implemented)

### What exists

- **Authoritative type:** `CapabilityInputSchema` (`@xo/types`): flat object, `properties: { name: { type: 'string' | 'number' | 'boolean' } }`, `required: string[]`. Deliberately not JSON Schema (no nesting, arrays, ranges, patterns, descriptions).
- **Where declared:** produced during lowering into the capability's manifest declaration, `declaration.execution.inputSchema` (`@xo/capability-contract` lowering; read by `findInputSchema` in `apps/api/src/executions/execute-capability.ts:78`).
- **Where enforced:** one function, `validateCapabilityInput` (`@xo/capability-contract/src/input-schema.ts`), used by the API single-execution path (`execute-capability.ts:135`), the runtime pipeline (`execution-pipeline.ts:749`) and the workflow runner. API and runtime are therefore consistent by construction.
- **Semantics it represents accurately:** required vs optional (optional = declared but not in `required`); primitive types; **unknown properties are rejected**; non-object input rejected. It cannot represent nesting, arrays, enums or ranges.
- **Important caveat:** if a declaration has **no** `inputSchema`, no structural validation happens at the API/runtime boundary (execution may still fail inside the binding). "No schema" must not be presented as "no inputs needed".
- **Exposed today?** Not on the capability projection. A _different_ representation is exposed on workflow **steps**: `steps[].inputs[] { name, runtimeKey, semanticType, required }`. `runtimeKey` is the property key; `semanticType` is a contract-level name whose mapping to the primitive `type` was **not** verified, so the two must not be merged by assumption.
- **Validation failure shape today:** a persisted `failed` execution record, `errorCode: XO_RUNTIME_CAPABILITY_INPUT_INVALID`, and one concatenated message (`input validation failed: a: missing required property; b: ...`). The structured `issues[]` exist inside the validator but are flattened into the message. Each failed attempt persists a record.

### Proposal

1. **Source of truth:** `declaration.execution.inputSchema` (existing). No new schema format.
2. **API representation:** additive optional field on the capability projection:
   `inputContract?: { source: 'lowered_declaration'; type: 'object'; required: string[]; properties: Record<string, { type: 'string'|'number'|'boolean' }> }`.
   Present only when the declaration has a schema. **Absent means "no authoritative contract"**, documented as such in OpenAPI; clients must not infer one.
3. **Validation boundary:** unchanged and server-side. Studio's guided form would be advisory and must not re-implement validation; the server's verdict is authoritative.
4. **Error representation:** keep the existing message; add structured `issues: [{ property, message }]` to the failed record (additive, e.g. alongside `errorCode`). Separately for owner decision: validate input _before_ persisting (as workflows already do, "validated before anything is persisted") so malformed attempts do not create execution records.
5. **Compatibility:** purely additive; old clients ignore it; Studio's parser treats absence as "no contract". No change to execution semantics, M2, or the frozen benchmarks.
6. **Tests required:** projection equals the lowered declaration's schema for resolved capabilities and is absent for unresolved/none; property test that omitting each `required` key yields `INPUT_INVALID` and supplying exactly the projected contract passes validation; unknown-property rejection; OpenAPI test; Studio parser/guided-form tests; live smoke assertion on the real PDF.
7. **Files/packages:** `apps/api/src/compilations/compile-source.ts` + `compilation.ts` (projection), `apps/api/src/openapi.ts`, `apps/api/test/*`; Studio `platform/wire.ts`, `ui/runs.tsx`. To avoid a merge conflict with M2 (which edits `execute-capability.ts`), reuse `findInputSchema` only after extracting it post-M2, or compute the projection from the same lowering outcome inside `compile-source.ts`. No changes to `@xo/types` or `@xo/capability-contract`.

### Status: item 2 of the proposal is now implemented (additive)

- **API:** `inputContract` is published on the capability projection, populated from the same lowered `declaration.execution.inputSchema` that execution enforces, typed with the existing `CapabilityInputSchema` (no new format). Absent means "no published contract". Compilations stored before this change do not have it; recompile to obtain it. Documented in OpenAPI.
- **Tests that tie the published contract to enforcement** (`apps/api/test/input-contract.test.ts`, real PDF, real routes): omitting each required property is rejected as `INPUT_INVALID` naming it; input built exactly from the contract is not rejected; undeclared and wrongly typed properties are rejected; unresolved capabilities publish none. A mutation check (publishing a contract with `required: []`) fails 3 of the 5 tests.
- **Studio:** a guided form is used only when a contract is published (typed fields, required/optional, no free-form extras because undeclared properties are rejected). It is advisory: the server still validates and its verdict is shown unchanged. Without a contract the honest free-form fallback below is used. A malformed contract is rejected as untrusted instead of driving a form.
- **Real-data note:** on the Commercial Property PDF, 19 of 33 capabilities publish a contract, and its fields are flat strings (for example `claim`, `lossadjuster_assessment` are `string`), so the previous free-form entry could not have been typed correctly without guessing.
- **Not done (owner decision):** structured `issues[]` on failed records, and validating input before persisting an execution record. Both change execution behaviour and were left as proposals.

### Studio fallback in the meantime (implemented)

Inferred names are labelled "hint from XO's last error", the panel states that XO does not publish the required details and that Studio cannot show a verified form, and numbers/booleans/quoted-text behaviour is explained. Nothing implies a validated schema.

## WP2-C — Workflow execution capability matrix

Verified from route code, runner code and the existing ~27 workflow API tests (all passing in the 204/204 run). **Studio does not wire any of this yet; it remains read-only.**

| Behaviour                       | Platform support                                                                                                                                                                                           | Evidence                                           | Studio                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------ |
| Discovery / listing             | Yes: `GET /workspaces/:ws/workflows[?compilationId]`, verbatim executability status, ordered steps, `approved` per step, data-flow bindings, `unavailableCompilations`                                     | route + discovery test                             | Listed (Builder)               |
| Eligibility                     | `executable` = audit status `executable_candidate` AND every step bound; else start is 422 `XO_WORKFLOW_NOT_EXECUTABLE` and nothing persisted                                                              | test "not_executable_yet ... rejected with 422"    | Shown with reasons             |
| Start                           | Yes: `POST .../workflows/:id/executions` `{compilationId, input?}`; strict body (unknown fields 400)                                                                                                       | route + tests                                      | **Not wired**                  |
| Start preconditions             | Every step capability approved and contract permissions granted else 403 `XO_RUNTIME_PERMISSION_DENIED`, fail-closed, nothing created                                                                      | test "required permissions and approvals enforced" | n/a                            |
| Input requirements              | Validated against every step's declared schema before persisting; step `inputs[]` exposed on the workflow view (see WP2-B caveat)                                                                          | test "workflow input is validated ..."             | not used                       |
| Running steps                   | Sequential through the same runtime path; producer→consumer data transferred only for proven bindings                                                                                                      | tests                                              | n/a                            |
| Pause on human step             | Yes: stops at HITL step (`waiting_for_human`), later steps never run while waiting                                                                                                                         | test                                               | n/a                            |
| Human approve/reject            | Via `POST .../workflow-executions/:id/resume {decision, data?}` or P0.7 `/executions/:id/resolve` then decision-less resume                                                                                | tests                                              | Single-capability resolve only |
| Resume                          | Yes; `expectedStepExecutionId` required for multi-step with pending HITL; `expectedRevision` optional CAS; concurrent resumes → one wins, others 409; duplicate resume after success → terminal 409        | tests                                              | n/a                            |
| Rejection                       | Step rejected, later steps skipped, workflow rejected, terminal, no compensation                                                                                                                           | test                                               | n/a                            |
| Failure                         | A failing step fails the workflow; failed run is a 200 persisted record                                                                                                                                    | runner + route comment                             | n/a                            |
| Retry                           | **No general retry.** Only recovery of an `interrupted` step (re-executes that one step under a new execution id; adopts a completed outcome instead of re-running). No retry-a-failed-step contract found | runner doc + recovery tests                        | unavailable                    |
| Status / provenance             | Records persisted with revision, step execution ids, graph hash; survive restart                                                                                                                           | restart tests                                      | n/a                            |
| Authorization re-check per step | Yes (approval removed mid-wait fails later step closed)                                                                                                                                                    | test                                               | n/a                            |

Missing contracts to request before Studio can start workflows: a per-workflow input contract that is explicit about required vs injected inputs (step `inputs[]` + the single-capability gap above), an explicit retry/abort contract for failed workflows, and a pagination/filter contract for workflow-execution listing. Studio keeps workflow starting unavailable; a design for pause/resume UX (step identity, revision handling, 409 conflict presentation) is the recommended next bounded item.

## WP2-D/E — Studio semantics changes (small, tested)

- Error wording is code-aware: binding codes → "cannot carry this rule out yet" (nothing recorded or run; internal resolver text never shown in User Mode). 403 no longer claims a single cause (approval vs permission). 404 no longer asserts non-existence (the API hides inaccessible resources). Credentials and raw platform text never appear in wording for non-`rejected` kinds (tested).
- Failed executions carry guidance only for codes the platform defines; others show the platform's own message.
- Review state label is **"Approval recorded"**, with text that it is not a guarantee of a successful run; the filter chip matches.
- Unchanged and still true: no "validated" or "authorized" state is claimed; confidence is labelled as XO's own estimate; Activity states it is not an audit log.

## Remaining gaps and dependencies

- Input contract: exposure is implemented (see WP2-B status); structured `issues[]` and validate-before-persist remain owner decisions.
- Workflow start/resume UX — needs a design pass; blocked on re-verification after M2.
- Approval is still a self-recorded acknowledgement (P1.0 M3); API-key-only auth (no human login); durable audit (M4); no per-capability validation output.
- Legacy approval records for unresolved capabilities, if present in a deployment, are left as-is (displayed truthfully).
- `.tsx` is not covered by the root ESLint config; pre-existing lint findings in `fs-approval-store.ts` (type-only import) and one `console.log` in `execution-routes.test.ts` were not touched.
