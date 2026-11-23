# Review: UW-12b3 remove the composed runner (branch `uw-12b3/remove-composed-runner`)

For the Opus review of ADR 0052 decision 6. Code: `apps/api/src/routes/removed-stub.ts`, `workflow-controls/*`, `routes/workflow-controls-routes.ts`,
`workflows/workflow-read.ts`, `packages/instance/src/composed-executions.ts`, `apps/cli/src/commands/instance/index.ts`, Studio `useStartWorkflow.ts`.

## What to check first

1. **No start path reaches a runner other than the canonical engine.** The composed start, resume, draft launch and practice review routes
   are `registerRemovedStub`. The scheduler and the webhook have no composed branch left: an uncertified slot is `skipped`, an uncertified
   webhook is 409 `XO_WORKFLOW_REQUIRES_IR_RUNTIME` in every workspace. Test `composed-runner-removed.test.ts` (4).
2. **The 410 stubs leak nothing.** They authenticate, check membership and the route's permission first, then answer with the replacement
   path only; they never echo the request. A non-member does not get a 410. Test 1.
3. **Historic data.** Executions stay readable (`workflow-read.ts` replaces the runner's read helpers). Daily-cap counting still reads them.
4. **Stored practice mode.** `fs-controls-store.ts` `deployment()` reads `shadow` (and `modeBeforePause: shadow`) as `draft`, drops stored
   shadow reviews, and does not rewrite on read. Test 3.
5. **Upgrade check.** `xo instance upgrade` counts unfinished composed executions per workspace (ids and counts only) and refuses without
   `--accept-unfinished-composed`; API start-up logs `composed_executions_unfinished`. An unreadable record counts as unfinished. Test 5.
6. **The retired list** (`docs/baseline/retired-tests.tsv`, 135 rows): every row starts with `ADR 0052`; the compare script fails on a retired
   name that is still present and on a missing replacement (`scripts/test-names.mjs`, tests in `apps/api/test/test-names-script.test.ts`).

## Things I would look at critically

- **Retired tests that guarded properties which still matter** on the runtime path: keyed idempotent start, OIDC revoke then replay,
  audit outage before and after a start, cross-workspace 404, input validation before persisting, authorization re-checked per step, and
  empty-policy denial. Replacements are named only where I rewrote the test (transitions, pause, schedule, webhook). For the rest the row says
  `none:` and I did **not** verify equivalent runtime-path coverage test by test. This is the first thing to check.
- UAC-10 evidence in `docs/runtime/V1_ACCEPTANCE.md` was re-pointed from the deleted `authorization.test.ts` empty-policy workflow test to the
  remaining declared-permission test, which is weaker for the HTTP start path.
- Studio: composed human-task decisions are read-only with a hint; Home may still list a historic waiting run that can no longer be decided.
- The "request key for starts" Studio tests were retired; the runtime start has 4 new tests but not the unclear-failure retry cases.

## Not covered by tests

- PostgreSQL (no run); a real upgrade of an instance with unfinished executions (the counter is tested, the CLI path is not).
- API clients still calling the composed routes now get 410: a breaking change.

## Review outcome (W5 review, 2026-11-23)

The retired properties were checked against the canonical start path one by one.

| Property guarded by the retired tests                                         | Runtime path before the review                                                        | Now                                                                                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Keyed start: same key, same run; a different input is 422                     | Same run held; a different input silently returned the first run                      | Refused with 422 `XO_IDEMPOTENCY_KEY_REUSED` (the run record keeps its input digest)                          |
| Audit outage before a start blocks it (503)                                   | The start used best-effort audit and went ahead                                       | `requireDurable` of `generated-workflow.run.requested` before the run record is written; 503 and nothing sent |
| Authorization re-checked before every call (approval withdrawn while waiting) | Checked by the effect gate, not tested                                                | Tested (case 5 of `effects are authorized when they happen`)                                                  |
| Cross-workspace and cross-identity 404                                        | Not tested for runs                                                                   | Tested (`cross-workspace: another workspace's member gets 404…`)                                              |
| Lost role, pause, changed binding, removed member while waiting               | Tested                                                                                | Unchanged                                                                                                     |
| Input validated before anything is persisted                                  | for_each shapes tested                                                                | Unchanged                                                                                                     |
| OIDC revoke then replay                                                       | Authentication runs before every route, including a keyed retry (`oidc-auth.test.ts`) | Unchanged                                                                                                     |
| Empty policy denies                                                           | Role ceiling plus capability approval plus the effect gate                            | UAC-10 evidence adds the two runtime tests                                                                    |

Six retired rows now name these tests as replacements, so the compare script checks they pass. The Workflow-entity start swap in Studio stays
a follow-up (same engine, a different route).
