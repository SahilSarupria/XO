# XO Studio — Product & Architecture (Foundation milestone)

Status: foundation + first vertical slice (Studio Work Package 1, against real platform contracts).
This document is Studio-specific. It does not amend the XO roadmap, `@xo/api`, or any shared contract.

## 1. Evidence base

Verified on branch `studio/foundation` (from `main` @ `b2192bd`) by reading code and by running the API:

- Baseline before any change: `npm run typecheck` exit 0; `@xo/api` `npm test` 199/199 pass.
- `apps/studio/scripts/live-smoke.mjs` drives Studio's real client and parsers against a real running `@xo/api` with the real `XO_Commercial_Property_Test_Policy_Compatible.pdf`: **18/18 checks pass**.
- P1.0: `main` contains **M1 only** (principal foundation). M2 (authorization) exists on `origin/feat/p10-m2-authorization` and is **not merged**; nothing here assumes it.

## 2. Platform capability map

| Class                           | Capability                                                                                                              | Evidence                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Implemented & usable**        | API-key authentication resolving a human/service principal                                                              | `apps/api/src/http/auth.ts`; 401 observed live                              |
|                                 | Workspaces (create/list/get), owner-scoped; foreign ids return 404                                                      | `workspace-routes.ts`; foreign-id 404 checked in smoke                      |
|                                 | Source upload (raw bytes, extension allowlist, SHA-256)                                                                 | `source-routes.ts`; real PDF uploaded                                       |
|                                 | Compile a source (synchronous): 33 capabilities from the real PDF                                                       | `source-compilation-routes.ts`; ~0.4 s                                      |
|                                 | Capability projection: name, source clause, status, execution class, confidence, page provenance, `approved`            | live response parsed                                                        |
|                                 | Approve a capability (an approval _record_)                                                                             | `approve` route; live                                                       |
|                                 | Execute an approved capability; failures persisted as records                                                           | `execution-routes.ts`; live (refused 403 unapproved; `failed` on bad input) |
|                                 | Human-in-the-loop pause and resolve (`approve`/`reject`)                                                                | live: `waiting_for_human` → `rejected`                                      |
|                                 | Execution list                                                                                                          | live                                                                        |
|                                 | Workflow catalog (read-only): executable flag, reasons, gaps                                                            | live: 3 workflows, 1 executable                                             |
| **Implemented, not integrated** | Workflow start/resume execution                                                                                         | `workflow-routes.ts`, README P0.8 — deferred (see §8)                       |
|                                 | Source delete; registry / package / benchmark / licence routes; `/openapi.json`                                         | present, not needed for the slice                                           |
| **Partial**                     | Approval: single self-approval record. No independent reviewer, no revocation, no binding to content (P1.0 M3)          | `approval.ts` doc comment                                                   |
|                                 | Authorization: ownership + approval record only; permission gate empty/allow-all on compiled capabilities (M2 unmerged) | `apps/api/README.md`                                                        |
|                                 | Confidence: XO's own estimate, `basis: self_reported`                                                                   | live `declaredConfidence`                                                   |
| **Not available**               | AI/model execution (deliberately `501`)                                                                                 | `runtime-routes.ts`                                                         |
|                                 | Durable audit log (M4); idempotency (M6); package trust (M5)                                                            | `P10_ENTERPRISE_TRUST_DECISIONS.md`                                         |
|                                 | Human login, sessions, SSO, roles/RBAC, key expiry                                                                      | API README "Known limitations"                                              |
|                                 | Capability input contract endpoint; per-capability validation results; async compile/progress; "goal" concept           | no route exists                                                             |

## 3. Personas and modes

- **A. Business user (default, built first).** Plain-language goal → context → understanding → review → run. No XOIR, passes, manifests or graph terms in default flows.
- **B. Builder.** Same product, more depth: raw ids, resolver reasons, confidence basis, full JSON records, execution records, platform error codes, and a read-only Processes view.
- **C. Administrator.** Not built. No platform contract exists for it (no roles, no org membership). Introduced when those contracts do.

**Mode is presentation only.** `Mode` selects how much is _rendered_. It never changes which requests are made, which controls are enabled, or authority. Tested: switching mode issues zero requests and leaves the set of Approve/Run actions identical. Authority comes only from the API key the backend authenticates.

## 4. Journey mapped to real capabilities

| Step                    | Studio                  | Platform                            | Status                                                     |
| ----------------------- | ----------------------- | ----------------------------------- | ---------------------------------------------------------- |
| Create/select workspace | `WorkspaceHome`         | `POST/GET /workspaces`              | Real                                                       |
| Describe outcome        | Goal note               | —                                   | **Local note only**, labelled "XO does not receive it yet" |
| Provide context         | `ContextSection` upload | `POST .../sources`                  | Real                                                       |
| Analyse                 | "Analyse"               | `POST .../sources/:id/compile`      | Real (synchronous)                                         |
| Review discoveries      | `ReviewSection`         | `GET .../capabilities`              | Real                                                       |
| Validate                | —                       | no per-capability validation result | **Missing**; confidence labelled as an unverified estimate |
| Approve                 | confirm → `approve`     | `POST .../approve`                  | Real, with the limits above                                |
| Execute                 | `RunPanel`              | `POST .../executions`               | Real                                                       |
| Human decision          | `ExecutionOutcome`      | `POST .../resolve`                  | Real                                                       |
| Learn / monitor         | Activity                | `GET .../executions`                | Execution history only; not an audit log                   |

## 5. State model (derived, never invented)

`ReviewState` is computed from exactly two platform facts, binding `status` and `approved` (`src/domain/review.ts`):

- `needs_attention` — status is unresolved/ambiguous/denied. Cannot be approved from Studio.
- `ready_for_review` — resolved, no approval record.
- `approved` — resolved **and** approval record present.

Deliberately absent: "validated" and "authorized". There is no platform contract for either today, and Studio will not invent them. An approval record on an unresolved capability can exist server-side; Studio shows that as `needs_attention` (unit-tested).

Executions use the platform's own statuses. A `failed` run is "Did not complete" with the platform message — never success. 403, 501, network and malformed responses each have distinct, tested wording (`ProblemKind`).

## 6. Architecture

```
src/platform/wire.ts    typed wire models + runtime parsers (untrusted input → typed or rejected)
src/platform/client.ts  XoClient: only place that does HTTP; Result<T> with classified problems
src/domain/review.ts    pure logic: states, wording, next-step; no React, no fetch
src/ui/*                React components; talk to the client via session context only
src/styles/tokens.css   design tokens;  app.css = components using only tokens
```

- **One-way dependencies:** `ui → domain, platform`; `domain → platform types`; `platform` imports nothing from the app.
- **No platform packages imported.** Studio is a browser bundle; it talks to `@xo/api` over HTTP only, so it cannot fork XOIR, permission rules or execution policy.
- **No in-app fixtures.** The shipped app has no mock mode; with no API it shows "Cannot reach XO". The stateful fake (`test/fakeXo.ts`) exists only in tests, and `live-smoke.mjs` re-checks the same shapes against the real service.
- **Stack:** Vite + React 18 + TypeScript. The repo had no frontend framework (verified). Chosen for ubiquity, small footprint (182 KB / 57 KB gz built), and no routing/state/UI libraries — plain CSS tokens. Strict TS, `noUncheckedIndexedAccess`; no `any`.
- **CORS:** `@xo/api` sends no CORS headers (verified). Studio calls same-origin `/api/*`; Vite proxies in dev (verified live). Production needs the same reverse-proxy shape. No API change made.
- **Dependencies:** only React, Vite, Vitest, Testing Library, jsdom. `package-lock.json` gains 220 new package entries; a package-by-package comparison found 0 existing entries removed and 0 existing resolved versions changed. The textual diff is larger than that (it also shows npm metadata/flag churn on existing entries), so review the lockfile diff rather than trusting this summary.

## 7. Security and trust

- Backend authorization is authoritative. UI conditions (e.g. hiding Approve on unresolved rules) are guidance, not control; the server enforces independently.
- The access key lives in React memory only: never `localStorage`, `sessionStorage` or cookies; dropped on sign-out/reload (tested). The limit is real: a durable human login needs backend sessions (gap G4).
- Identity is never sent by Studio. Execution bodies carry only `compilationId`, `capabilityId`, `input` (tested). Principals/grants are never constructed client-side.
- All responses parsed before use; unexpected shapes become `malformed` problems, not UI.
- Uploaded files are never executed or rendered; the client allowlist mirrors the server's and is a convenience only. All output is rendered through React text nodes (no `dangerouslySetInnerHTML`).
- AI execution is not wired and nothing enables it; Studio's 501 handling is tested.
- No fake audit/metrics. Activity and Review carry explicit notices about what the platform does and does not guarantee yet.
- Approving does not run anything; running is a separate, explicit, labelled-as-real action.

## 8. Scope of this milestone

**In:** shell, tokens, connect, workspaces, upload, analyse, review/evidence, approve, run, human decision, activity, Builder detail layer, read-only processes, tests.
**Deferred (needs its own review):** workflow _execution_ (segmented HITL pause/resume and persistence semantics deserve a dedicated design); administration; guided input forms; validation views; multi-document comparison.

## 9. Platform gaps — proposals, not changes

None of these were implemented. Each is a request for a contract change owned by the platform workstream.

- **G1 Input contract — resolved for newly compiled documents.** The capability projection now publishes `inputContract` (the same schema execution enforces; absent = no published contract) and Studio shows a guided form from it, falling back to free-form entry otherwise. Older stored compilations need a recompile. Still open: structured validation `issues[]`, and whether to validate before persisting an execution record (every failed attempt currently persists a record). See `WP2_FINDINGS.md`.
- **G2 Approve non-executable capability.** _Confirmed and fixed in WP2-A_ (approve now refuses non-resolved capabilities; see `WP2_FINDINGS.md`). It was a correctness gap, not an execution bypass.
- **G3 Same-origin hosting.** Document/ship a supported reverse-proxy or opt-in CORS allowlist.
- **G4 Human sessions.** API-key-only auth; needs login/session for people (P1.0 identity follow-ups).
- **G5 Approval integrity.** A user can approve their own upload; independent approval and content-binding are P1.0 M3. Studio's notice says so.
- **G6 Compile progress.** Synchronous only; no progress/cancel for large documents.
- **G7 Validation result.** No per-capability validation/evaluation output exists to show; `confidence` is self-reported.

## 10. Known limitations of this milestone

- `.tsx` files are not covered by the root ESLint config (it matches `*.ts` only). Studio relies on strict `tsc` and tests for `.tsx`. Not changed, to avoid touching shared config.
- Visual QA in a real browser was not performed in this environment; verified instead: production build, dev server, proxy, and DOM-level tests. Contrast ratios were chosen to meet WCAG AA but not measured with a tool.
- The golden path was verified against the real PDF fixture only (one domain), consistent with the repo's existing source-independence caveat.

---

## Home / Work / Tasks (workflow start, discover, resume)

**Navigation:** Home · Work · Tasks · Activity · Setup (Setup holds the former Context and Review as _Documents_ and _Rules_). Builder Mode adds a read-only _Processes_ tab with technical detail. Nothing in the shell names an industry; process and step names come from the user's own documents.

**Where the logic lives**

- `src/platform/wire.ts`, `client.ts` — `WorkflowRun` parser; `startWorkflow`, `listWorkflowRuns`, `getWorkflowRun`, `resumeWorkflowRun`; `ApiProblem` now carries `reason` and `denials` from the platform's `error.context`.
- `src/domain/work.ts` — pure derivations: display-only name tidying, active-run lookup, start readiness (advisory), 403/409 wording, run state wording.
- `src/ui/HomeSection.tsx`, `WorkSection.tsx`, `TasksSection.tsx`, `RunCard.tsx` — screens. `ActivitySection.tsx` now lists process runs and hides step executions that already belong to a run.

**Start.** Studio re-reads the platform's runs immediately before a start and refuses to start if an active run for the same process and analysis exists. The button is locked while a request is in flight. After a network/5xx failure Studio does not resend; it re-reads runs and reports whether a run now exists.

**Resume.** A decision is sent with `expectedStepExecutionId` and `expectedRevision` taken from a run record fetched immediately beforehand. If the fetched run is no longer waiting at the step the person was shown, nothing is sent. A 409 is shown as "This process has changed", the run is refreshed, and the person chooses again. After a failure with no response Studio never resends. After a successful decision the buttons are held for a moment so one double click cannot decide the next step.

**Known limits (do not remove without changing the platform)**

1. **Duplicate-start protection is a browser-side guard, not exactly-once.** `POST /workflows/:id/executions` has no idempotency key. Two tabs, two people, a refresh mid-request, or a client outside Studio can still create two runs. A backend idempotency key is the real fix and is out of scope here.
2. There is no list-of-runs filter on the API; Studio fetches all runs in the workspace and filters in the browser.
3. `interrupted` runs are displayed as such; the platform's recovery resume is not offered in Studio.
4. Approval of a step's rule is per capability; Studio shows which steps lack approval, but the server remains the authority (403 on start).
5. Decisions carry no free-text payload; the API's optional `data` field is not used.
