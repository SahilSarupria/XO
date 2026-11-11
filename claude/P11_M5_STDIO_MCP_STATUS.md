# P1.1 M5 — stdio MCP adapter: implementation status

Branch `p11/m5-stdio-mcp` (local only, cut from `p11/m4-external-tool` @ `3807805`). Not pushed. No PR opened or modified.

**Status: IMPLEMENTED (focused verification passed locally). NOT ACCEPTED.** Implementation completion is not milestone acceptance: no remote CI has run on this
branch, no independent review has happened, and the owner decisions in §9 are open.

Evidence tags: VERIFIED (ran in this session) · NOT RUN · OWNER-DECIDED (recovered decisions supplied with the M5 task) · PROPOSED (my choice, awaiting owner).

## 1. Scope

Binding decisions as recovered by the owner (OWNER-DECIDED): M5 is the stdio MCP adapter; official MCP SDK preferred with an explicitly pinned version; location
`apps/mcp`; reuse the M3 procedure contracts and existing API behaviour; **the XO API is the sole authority** for capability resolution, permissions, approval and
audit; tool names are lookup keys, not authority; `XO_API_KEY` from the environment only; stdio only (no remote transport, OAuth, resources, prompts, approve tool);
M4 external-effect, approval-mode, durable-ledger and unknown-outcome safeguards preserved; discovery never authorizes.

The M5 owner-decision record itself is **still not in the repository**; the above comes from the task text. Nothing here claims more than that.

## 2. What was built

| Area                                          | Change                                                                                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/mcp` (new, `@xo/mcp`)                   | `config.ts`, `api-client.ts`, `tools.ts`, `call.ts`, `server.ts`, `stdio.ts`, `main.ts` (bin `xo-mcp`), `logger.ts`                                                  |
| `apps/api/src/procedures/procedure-runner.ts` | `deriveStartInputSchema` / `procedureStartInputSchema`: the start-input JSON Schema, derived from the SAME server-side sources `validateStartInput` uses             |
| `apps/api/src/routes/procedure-routes.ts`     | `GET /workspaces/:ws/procedures/:id` adds `inputSchema` **only** when the version's computed lifecycle is `approved` and the schema is derivable; read-only metadata |
| `apps/api/src/openapi.ts`                     | description text only                                                                                                                                                |
| `apps/api/test/test-helpers.ts`               | `TestServer.baseUrl` getter (additive, used by the end-to-end test)                                                                                                  |
| `tsconfig.json`, `package-lock.json`          | `apps/mcp` reference; lockfile for the new workspace and its SDK dependencies                                                                                        |

Untouched: M3/M4 records, `P11_M4_O7_CORE_IMPLEMENTATION_STATUS.md`, `@xo/adapters`, `@xo/runtime`, `@xo/permissions`, `@xo/audit`, the runtime and master roadmaps, PR #6/#7.

## 3. Dependency and version choice

- **SDK: `@modelcontextprotocol/sdk` pinned exactly to `1.32.1`** (published 2026-10-05). `1.32.2` exists (2026-10-23, one day old when chosen) and was not taken: no
  review time had passed. The version is a PROPOSAL: the owner has not approved a version (M0 O-8 called the earlier snapshot "not an approved selection").
- **`zod` pinned exactly to `4.6.7`** (SDK peer range `^3.25 || ^4.0`). A scratch install with `zod@3.25.76` reproduced `npm audit` advisory GHSA-mrhx-c7xc-m3w5
  (high, fixed from 4.6.6), so the 4.x line was chosen. Zod is used only by the SDK; this package writes no zod schemas.
- Node: SDK `engines >=18`; repo `>=22.15.0`; CI runs `22.x` (single entry). Verified locally on Node `v22.22.0`.
- Review actually performed (not a source audit): protocol constants in the installed package, declared dependencies, `npm audit` before/after, behaviour under the tests below.
- **Dependency weight (honest cost):** the SDK declares `express`, `hono`, `cors`, `jose`, `eventsource`, `express-rate-limit`, … although only the low-level `Server` and
  `StdioServerTransport` are used. A scratch install of the SDK + zod resolved ~96 packages. `npm audit` after the workspace install lists three high advisories (`adm-zip`, `brace-expansion`, `js-yaml`); the same three are reported on the base commit (VERIFIED by stashing this work); none is in the SDK or zod.
- **Rejected alternative:** a hand-written JSON-RPC/stdio implementation (no dependency, ~300 lines, but we would own protocol-revision tracking, initialize/version
  negotiation, cancellation, and error semantics). Per the decisions it remains the documented fallback if the owner objects to the SDK's transitive footprint.

## 4. Protocol revision

- Installed SDK: `LATEST_PROTOCOL_VERSION = 2025-11-25`; `SUPPORTED_PROTOCOL_VERSIONS = [2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07]` (read from `dist/esm/types.js`).
- **PROPOSED M5 target: `2025-11-25`** (the SDK's latest). **No owner-approved revision exists** and none is claimed. Basis: it is what the pinned SDK negotiates by default.
  Older revisions are accepted only through the SDK's own negotiation; they are not separately tested here.
- Choosing a different revision is a decision for the owner (§9-2). Nothing protocol-specific beyond `tools/list` and `tools/call` was implemented, so a revision change would be
  an SDK-version question, not a code rewrite.
- **Conformance claim: none beyond the tests listed.** The official MCP conformance suite was NOT run (not provided by the repository).

## 5. API authority boundary

What a tool is: one **approved procedure version**, named `<procedureId>.v<N>`. The name is a lookup key.

Discovery (`tools/list`), read-only: `GET /procedures` then, for each version the API reports `approved`, `GET /procedures/:id?version=N`; a tool is advertised only if that
second read again says `approved` and carries a well-formed schema (fail closed). Nothing is started. Cap: 100 tools (`MAX_TOOLS`); truncation is logged to stderr.

Invocation (`tools/call`), in fixed order, every early exit before anything is sent to the start route:

1. Tool-name grammar (otherwise JSON-RPC `-32602`).
2. **Fresh API read** of that exact version: not approved now, or no schema → `not_started`. A 404 → unknown tool.
3. Closed argument validation against the API-derived schema (`validateCapabilityInput` from `@xo/capability-contract`). Unrecognized properties — including anything shaped like
   `permissions`, `approvalMode`, `executionStrategy`, or a credential — are rejected without echoing the name or value. The schema has no authority-bearing field.
4. One `POST …/versions/N/executions` with `{input}` and an `Idempotency-Key` of `mcp-<sessionNonce>-<jsonrpcRequestId>`.

The API's existing start route then re-checks lifecycle against the current registry, `procedure.execute`, every step's authorization, input validation, idempotency, audit, and (M4)
approval modes, the durable ledger, fresh-approval and unknown-outcome blocking. The adapter has **no** import of runtime, adapters, stores or the dispatcher — the only egress is HTTP to the API.
The adapter never reads a permission, approval mode, or execution strategy from a client, and exposes **no** approve / resume / reconcile / payload-approval tool (test-enforced).

## 6. Credentials, errors, timeouts, cancellation, unknown outcomes

- `XO_API_KEY`, `XO_API_URL`, `XO_WORKSPACE_ID` come from the environment only (`XO_MCP_REQUEST_TIMEOUT_MS` optional, 1 000–900 000, default 120 000). Missing/malformed → exit code `2`, **nothing on
  stdout**, a message that names the variable and never a value. `http://` is accepted only for loopback hosts; URLs with credentials, path, query or fragment are refused; redirects are refused (`redirect: 'error'`) so the bearer token cannot be forwarded.
  The key is non-enumerable on the config object (not visible via JSON/inspect/spread) and is never logged.
- stdout carries MCP frames only; `console.*` is redirected to stderr; diagnostics are single-line JSON on stderr (event names, tool name, counts) and never include arguments, results or headers.
- API errors are passed through as the API's own `code`/`message` (truncated), never `context`.
- **No usable answer** (timeout, client cancellation, network error, unreadable/oversized/garbled reply, any 5xx, an idempotency-state error) **on the start request is reported as `outcome: unknown`, `retrySafe: false`** —
  never as failed and never as success. No answer on a _read_ means nothing was sent and is reported as `not_started`.
- **M4 unknown outcome:** a step or procedure failure code `XO_EXTERNAL_EFFECT_OUTCOME_UNKNOWN` is reported as `outcome: unknown, outcomeUnknown: true, retrySafe: false` with text that says it must be reconciled by an
  authorized human in XO. A confirmed no-effect failure is reported as a plain `failed`. `waiting_for_human` (including payload/fresh-approval pauses) is not an error and states that approval cannot be done through MCP.
- Cancellation (`notifications/cancelled`) aborts the in-flight HTTP request. Because the API executes the procedure synchronously inside the start request, **cancelling cannot stop server-side work**;
  the adapter therefore reports unknown rather than "cancelled".
- The adapter never retries any request.

## 7. Audit behaviour and taxonomy

No audit event type was added or changed (the closed list from M3/M4 is intact; `procedure-execution.test.ts` still asserts it). All audit is written by the API on the calls the adapter makes
(`access.attempted` per protected read, `procedure.attempted` / `procedure.execution.*` / `procedure.step.*` on start). Consequence, **unresolved**: the audit trail cannot distinguish an MCP-originated start from any other API call by the same
principal, and `tools/list` produces one protected-read audit record per advertised tool plus one for the listing. Whether an MCP-origin marker or a dedicated event is wanted is an owner decision (§9-4); the minimal
proposal would be one optional origin attribute on existing events, not a new event type.

## 8. Verification (all local; remote CI NOT run)

Environment: Node `v22.22.0`, branch `p11/m5-stdio-mcp`.

| Command (from repo root unless noted)                                                                                                                                                                                                                                                                                                              | Result                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `cd apps/mcp && npm test`                                                                                                                                                                                                                                                                                                                          | 45 tests, 45 pass, 0 fail |
| `cd apps/api && node --import tsx --test test/procedure-routes.test.ts test/procedure-execution.test.ts test/procedure-closeout.test.ts test/procedure-review-resume-approval.test.ts test/external-tool-procedure-m4.test.ts test/payload-approval-m4.test.ts test/procedure-input-schema-m5.test.ts` (plus `openapi*` glob that matched no file) | 80 tests, 80 pass, 0 fail |
| `cd apps/api && node --import tsx --test test/procedure-execution.test.ts test/procedure-routes.test.ts test/workflow-executions.test.ts` (the files that import `openApiDocument`)                                                                                                                                                                | 64 tests, 64 pass, 0 fail |
| `npx tsc -b tsconfig.json`                                                                                                                                                                                                                                                                                                                         | exit 0                    |
| `npx eslint apps/mcp apps/api/src apps/api/test/procedure-input-schema-m5.test.ts apps/api/test/test-helpers.ts --max-warnings=0`                                                                                                                                                                                                                  | clean                     |
| `npx prettier --check apps/mcp apps/api/src apps/api/test/procedure-input-schema-m5.test.ts apps/api/test/test-helpers.ts tsconfig.json`                                                                                                                                                                                                           | clean                     |

**Not run:** the full `apps/api` suite, CLI, compiler, Studio and other workspaces, the repo-wide lint, the official MCP conformance suite, any remote CI, any load or soak test.

`apps/mcp` tests by file: `config` (env-only credential, missing/malformed key, URL rules, timeout bounds, non-leaking config), `tools` (name grammar, strict schema re-check, argument validation, discovery filtering, cap, discovery
issues no start), `call` (order of checks, not-approved → nothing sent, API denial, unknown/5xx/idempotency states, M4 unknown outcome, waiting, cancellation), `http-api` (bearer header, routes, idempotency header, error passthrough,
timeout/abort/network/redirect/oversize/garbled), `protocol` (SDK client over in-memory transport: initialize at `2025-11-25`, capabilities exactly `tools`, list/call, `-32602` unknown tool, `-32601` for resources/prompts/logging/completion,
no approval tool, discovery failure = error, mid-call cancellation), `stdio` (real child process: missing/malformed key exit 2 with empty stdout, full session with every stdout line a JSON-RPC frame and no secret on either stream,
malformed input does not crash, EOF and SIGTERM → exit 0), `e2e-api` (real MCP client → real adapter process → **real API** with registry validation, approvals, authorization and the M4 dispatcher against the in-process reference service:
only approved versions listed, draft callable by name but not started, execute denial → 403 and zero executions/adapter calls, unknown key → 401, completed run with the server-derived dispatch key, drop-after-effect → unknown then blocked second
attempt with the effect applied exactly once, confirmed rejection → plain failure, adapter timeout → unknown while the server-side effect still happened).

The end-to-end test uses `InMemoryDispatchLedger` with `unsafeAllowVolatileLedger` (test wiring, as in the M4 tests). The production durable-ledger guard is unchanged and is not re-tested here.

## 9. Open owner decisions and limitations

1. **SDK and version:** is `@modelcontextprotocol/sdk@1.32.1` (+ `zod@4.6.7`) approved, given the transitive footprint, or is the hand-written fallback preferred?
2. **Protocol revision:** is `2025-11-25` the target? (No owner-approved revision was recovered.)
3. **Tool granularity:** one tool per approved procedure _version_ (`id.vN`) was chosen so a call names exactly what was approved. A "latest approved version" alias was not built.
4. **Audit origin:** add an MCP-origin attribute (or accept that MCP calls are indistinguishable in audit)? No new event type was added.
5. **Idempotency across client retries:** the key is per JSON-RPC request id. A client that times out and re-calls sends a _new_ request and therefore starts a _new_ execution (M4's ledger blocks a second dispatch only
   while an earlier one is unreconciled/unknown). A client-supplied idempotency token would need an argument the closed schema does not have today; deriving a key from the input would silently suppress legitimate repeats. Left to the owner.
6. **Single workspace per process** (`XO_WORKSPACE_ID`); one credential per process; a rotated key needs a restart.
7. **Synchronous start:** a long procedure holds the tool call open until the API returns or `XO_MCP_REQUEST_TIMEOUT_MS` expires (then: unknown).
8. **SDK behaviour observed, not changed:** a non-JSON line is dropped without a JSON-RPC parse-error reply; a schema-invalid `tools/call` params object returns `-32603` rather than `-32602`.
9. Tool results include the execution's `outputs` verbatim (what the same principal could read from the API). No `tools/list` pagination or `listChanged` notifications.
10. Only procedures whose _every_ input-bound parameter has a declared scalar contract schema are advertised (string/number/boolean); the rest are silently not exposed (fail closed).
11. Still outstanding from earlier milestones and not affected by M5: O-2, O-3/Review §5.3, N-3, E-1–E-9, O-4 specifications; M3 and M4 acceptance; remote CI evidence; single-host atomicity and the audit/ledger atomicity gap from M4.

**M5 acceptance requires:** owner approval of §9-1/2; a pushed branch with remote CI on Node 22.x (needs push authorization); independent review of the diff; the owner's decision on §9-4/5.
