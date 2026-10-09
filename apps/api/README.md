# @xo/api

HTTP service exposing `@xo/registry`, `@xo/package-sdk`, and `@xo/runtime`
over the network, plus an isolated adapter over the compiler pipeline. This
is the first service surface in the repo — everything before this was a
library (`packages/*`) or a CLI (`apps/cli`).

It has no `bin` entry, isn't the compiler, isn't the runtime, and doesn't
implement business logic of its own: every route is a thin translation from
an HTTP request to a call against an already-stable library, the same
`validate-input → call-the-library → map-result` shape `apps/cli`'s
commands already use (`apps/cli/src/commands/registry/publish.ts` and
`search.ts` were the direct templates for `routes/registry-routes.ts`).

## Framework choice: `node:http`, not a framework

The brief asked for a deliberate choice among lightweight, ESM-native
options (Fastify and similar were suggested). The actual constraint turned
out to be harder than "pick a light one": **this sandbox has zero
`node_modules` and no network access** — there was nothing to `npm install`
Fastify (or anything else) from. This isn't a hypothetical workaround;
`packages/package-sdk/README.md`'s own "Known limitations" section
documents hitting the identical wall (written against `tar-stream`, had to
fall back to a hand-rolled `node:zlib`-based codec because the sandbox it
was built in had no network access either).

So `apps/api` is built directly on `node:http`: a ~100-line method+`:param`
router (`src/http/router.ts`) with composable middleware, request/response
types, and a body reader — no routing DSL, no plugin system, because
nothing this service exposes needs one (every route here is a fixed shape
with at most two `:param` segments). If a real deployment target has actual
network access, swapping the transport layer for Fastify (or anything else)
later is a contained, single-directory change — `src/http/*` is the entire
surface that would need to change; `src/routes/*` only ever sees the
framework-agnostic `ApiRequest`/`ApiResponse` types from `src/http/types.ts`.

## Route map

Every route below except `/health` and `/openapi.json` requires
`Authorization: Bearer <key>` — see "Auth" below for the full scheme.

All registry/package/runtime routes take the local directory they operate
against as a `?registry=`/`?store=` query parameter, mirroring the CLI's
own `--registry <dir>`/`--store <dir>` flags exactly — see "Why no global
`--registry`/`--store` config" below for why that's a deliberate match, not
an oversight.

| Method | Path | Mirrors |
|---|---|---|
| GET | `/health` | — |
| GET | `/openapi.json` | this document, machine-readable |
| POST | `/registry/packages` | `RegistryClient.publish` / `xo publish` |
| GET | `/registry/packages?creator=` | `RegistryClient.listByCreator` |
| GET | `/registry/packages/:id` | `RegistryClient.get` |
| GET | `/registry/packages/:id/inspect` | `xo registry inspect` |
| GET | `/registry/search?q=` | `RegistryClient.search` / `xo search` |
| POST | `/registry/packages/:id/benchmarks` | `RegistryClient.recordBenchmark` |
| GET | `/registry/packages/:id/benchmarks` | `RegistryClient.listBenchmarksForPackage` |
| GET | `/registry/benchmarks/:benchmarkId` | `RegistryClient.getBenchmark` |
| POST | `/registry/licenses` | `RegistryClient.createLicense` |
| GET | `/registry/licenses/:id` | `RegistryClient.getLicense` |
| GET | `/registry/ledger/:entryHash/verify` | `RegistryClient.verifyLedgerEntry` |
| POST | `/packages/validate` | `PackageValidator` / `xo verify` (read-only) |
| POST | `/packages/resolve` | `resolveDependencies` dry-run (nothing written) |
| POST | `/packages/lock` | `xo lock` exactly (writes `xo.lock`) |
| GET | `/packages/:name/:version/manifest` | `PackageInstaller.getManifest` |
| GET | `/runtime/context` | `Runtime.bootstrap()` + `.context()` |
| POST | `/runtime/execute` | `xo run` |
| POST | `/compiler/compile` | `compileXoir` (isolated — see below) |

`build`/`pack` stay CLI-only, per the brief — they take local source
directories as input, which has no natural HTTP request shape without
inventing a file-upload protocol nothing else in this repo uses.

## The compiler isolation boundary

`packages/compiler/src/pipeline/compile.ts` is, per the task brief, "the
one genuinely volatile surface in this task" — a concurrently-running chat
(Compiler Stage 6) is specifically changing what it returns. Every byte of
that volatility is contained to **one file**: `src/routes/compiler/compile-adapter.ts`.

Nothing else in `apps/api` — not `compiler-routes.ts`, not the OpenAPI doc,
not the router, not error-mapping — imports `@xo/compiler` or knows
anything about `PipelineInput`/`CompiledXoirResult`'s shape.
`compile-adapter.ts` exports exactly one function, `compileViaHttp`, and
one response type, `HttpCompileResponse`, that everything else depends on
instead. When Stage 6 lands and changes what `compileXoir` returns,
updating `compile-adapter.ts`'s two conversions (`parseInput`/the
`CompiledXoirResult → HttpCompileResponse` mapping in `compileViaHttp`) is
the entire blast radius.

**Scope, narrower than the full `PipelineInput` union**: only
`kind: 'xoir'` is accepted over HTTP today. `@xo/xoir` ships a tested, safe
JSON boundary for `XoirGraph` (`fromJson`/`toJson` in `serialization.ts`).
`KnowledgeGraph` and `CapabilityGraph` (the pipeline's other two input
kinds) have **no equivalent safe parser anywhere in this codebase** —
neither type exposes a `fromJson`. Casting arbitrary client JSON straight
into either interface would risk an uncaught `TypeError` deep inside
`compileXoir` instead of a clean 4xx response. `'knowledge'`/`'capability'`/
`'combined'` return a deliberate `501 Unimplemented` instead of attempting
that cast. This is a scoping decision, not an oversight — it's the natural
place for Stage 6, or a follow-up to this task, to add real JSON schemas
for those two graph types and widen the adapter accordingly. See the doc
comment at the top of `compile-adapter.ts` for the same reasoning in
context, and `test/compile-adapter.test.ts` for direct coverage of both the
xoir-input success path and the three `UNIMPLEMENTED` scoping cases.

## Auth

`checklist.txt` item 16 (Accounts/Login/Sessions/OAuth/API Keys) is now
partially built: **API key authentication**. `src/http/auth.ts` no longer
exports the old no-op `passThroughAuth` — it exports
`createApiKeyAuth(store)`, a real `Middleware` that `buildRouter()`
(`src/server.ts`) registers via `router.use(...)`, in exactly the seam
the old no-op described. Nothing about routing, error-mapping, or any
individual route handler's signature changed to make this drop-in
possible.

### Scheme: static, hashed, revocable API keys — not sessions/OAuth/JWT

This is the simplest scheme that's actually useful for a service other
tools/scripts call programmatically, and it deliberately excludes:

- **User accounts, passwords, login sessions** — a human-facing concern;
  this API has no UI in front of it.
- **OAuth / third-party identity providers** — no external IdP
  relationship needed for machine-to-machine calls.
- **JWT or any expiring/refreshing token** — a static, hashed, revocable
  key is simpler and easier to reason about correctly than a token
  lifecycle (refresh flows, clock skew, key rotation for signing) for
  this stage. Expiry is a real gap this leaves open — see "Known
  limitations" below.
- **Role-based access control** — entirely `@xo/permissions`' job (see
  "Auth vs. permissions" below), not this middleware's.

**Header**: `Authorization: Bearer <key>` — the conventional HTTP bearer
scheme, matching how most API-key-authenticated HTTP services (Stripe,
GitHub, ...) do it; there was no reason to invent a custom header
(`X-Api-Key` etc.) instead.

**Storage**: `src/auth/fs-api-key-store.ts`'s `FsApiKeyStore`, built on
`@xo/storage`'s `LocalFsBlobStore` — the same repository pattern
`@xo/registry`'s `FsLicenseRepository` uses (`Result`-returning,
`BlobStore`-backed, one JSON record per key, keyed by content hash so
lookup-by-hash is a direct read). Only the key's SHA-256 hash
(`@xo/crypto`'s `Sha256Hasher`, via `src/auth/api-key.ts#hashApiKey`) is
ever persisted — the raw key is generated once
(`generateApiKey()`, 256 bits of `node:crypto` randomness, `xoak_`
prefix), handed to whoever issued it, and never stored or logged again.
Same principle as password hashing: hash what's stored, compare hashes.

### API key identity vs. `creatorDid`

Investigated before assuming either way (per the brief): **these are
kept as genuinely separate concerns**, not unified. `@xo/registry-core`'s
`creatorDid` (`PackageRepository.listByCreator`, `LicenseRecord`'s
implicit tie to a package's publishing identity) identifies *who
authored/owns a published XO package* — a DID-shaped identity meant to
anchor signature verification and royalty attribution
(`SPECIFICATION.md` §1.2's `creator.id`, `did:xo:...`). An API key
identifies *what's calling this HTTP service right now* — a CI script
hitting `/runtime/execute`, a monitoring job polling `/registry/search`,
neither of which has or needs a publishing identity at all.

Rather than forcing every API key to carry a `creatorDid` (most won't
have one) or forbidding the association entirely (some legitimately
will — a publisher's own automation calling `/registry/packages` on
their behalf), `ApiKeyIdentity` (`src/auth/identity.ts`) carries
`creatorDid` as an **optional** field, set only when a key is explicitly
issued to/associated with a publishing identity (`--creator-did` on the
issuance script — see below). Nothing in this pass *uses* that field
yet (no route currently checks `req.identity.creatorDid` against
anything) — it's plumbed through so a future pass (e.g. auto-scoping
`/registry/packages` writes to the calling key's own `creatorDid`) has
somewhere to read it from, without a second identity concept needing to
be invented later.

### Key issuance and revocation: a script, not an HTTP route

`apps/api/scripts/manage-keys.ts`:

```
node --import tsx scripts/manage-keys.ts issue <identityId> [--creator-did <did>] [--dir <dir>]
node --import tsx scripts/manage-keys.ts revoke <identityId> [--dir <dir>]
```

(`npm run keys -- issue ...` also works — see `package.json`.)

Chose a script over `POST /admin/keys` deliberately, not by default: an
admin HTTP route that mints new keys has to itself be reachable to
bootstrap the very first key, and before any key exists there's nothing
to authenticate that request with. The two ways out — exempting
`/admin/keys` from auth (which means anyone who can reach the server at
all can mint themselves a valid key, making the "protected" surface
pointless), or gating it behind some *other* secret (a bootstrap token,
mTLS...) — are both worse than just not putting key issuance on the
network at all. Operating directly on the `ApiKeyStore` from a script
run by whoever already has filesystem/deploy access to `API_KEYS_DIR`
sidesteps the bootstrap problem entirely: that person already has the
trust level needed to configure and start the server, so a script
writing into the same store isn't a new trust boundary. This mirrors how
`apps/cli`'s commands operate directly on local registry/store
directories rather than going through HTTP.

`issue` prints the raw key to stdout exactly once — same practice as
GitHub/Stripe token issuance, and consistent with `ApiKeyStore` itself
never persisting or returning the raw key again after creation.

### Where the key store lives: `API_KEYS_DIR`

`src/config.ts`'s `loadConfig()` gained one new field, `apiKeysDir`
(env var `API_KEYS_DIR`, default `.xo-data/api-keys`). This is a
deliberate, narrow exception to "Why no global `--registry`/`--store`
config" below: every other directory this service touches (`?registry=`,
`?store=`) is *data the request is about*, and can legitimately differ
per call. The API key store is the server's own identity/credential
infrastructure — who's allowed to talk to this process at all — which
is inherently one directory per running server process, the same
category of setting as `PORT`/`HOST`, not a per-request parameter. A
real deployment should point `API_KEYS_DIR` at a persistent volume (and,
per "Known limitations", eventually a real database rather than
`LocalFsBlobStore`).

### Exempt routes

Two routes are reachable with no credential at all, via an explicit
allowlist in `auth.ts` (`EXEMPT_PATHS`) — anything not listed requires a
valid key, so a newly added route defaults to auth-protected rather than
accidentally public:

| Route | Why exempt |
|---|---|
| `GET /health` | Uptime monitors/orchestrators routinely poll liveness checks and shouldn't need a credential just to do that. |
| `GET /openapi.json` | The machine-readable doc describing how to authenticate has to be readable before you have credentials to authenticate with. |

Every other route in the table above requires `Authorization: Bearer
<key>`.

### Auth vs. permissions

`@xo/permissions` (`packages/permissions/src/`) is not touched by this
pass and is not a second auth system — it answers "is this
already-authenticated caller allowed to do X" (grants, scopes, consent,
policy, audit), which is a genuinely different question from "who is
this caller", the only thing `src/http/auth.ts` resolves. The boundary
as built: auth resolves an identity and attaches it to
`req.identity`; nothing downstream of that — no route handler, no
`permissions` call — currently reads `req.identity` for an authorization
decision. Wiring `req.identity` into a `permissions` check (e.g. scoping
which packages a given API key can publish/read) is real design work
deliberately left to a future pass rather than improvised here, per the
brief's own instruction not to touch `packages/permissions`.

## Error mapping

Every `XoError` code (`packages/errors/src/error-codes.ts`) is mapped to an
HTTP status in `src/http/error-mapping.ts`'s `STATUS_BY_CODE` table.
`test/error-mapping.test.ts`'s first test asserts every current
`ErrorCode` value has an explicit entry — a code added to `@xo/errors`
without a corresponding mapping decision fails that test immediately,
rather than silently falling through to the generic 500 default forever.

The status choices themselves are judgment calls — these codes predate
this HTTP layer and were never designed with a status in mind. General
shape: generic codes map the obvious way (`NOT_FOUND`→404,
`ALREADY_EXISTS`→409, `INVALID_ARGUMENT`→400); domain-validation failures
(`PACKAGE_VALIDATION_FAILED`, `XOIR_VALIDATION_FAILED`, ...) use 422, not
400, since the request itself was well-formed and the *domain object it
describes* is what failed a check; genuinely internal problems (DI
failures, a tampered ledger, storage write failures) map to 500/502
regardless of what triggered them, since they're never the caller's fault.
The full reasoning per code group is inline in `error-mapping.ts` itself.

## Runtime execution — provider configuration

`apps/cli/src/commands/runtime/provider-factory.ts` resolves a
`ModelProvider` from CLI flags (`--provider`, `--api-key`, ...) with an
env-var fallback per provider. `src/routes/runtime/provider-factory.ts` is
the same logic, adapted for HTTP: flags become headers (`x-xo-provider`,
`x-xo-api-key`, `x-xo-base-url`, `x-xo-endpoint`, `x-xo-api-version`) —
the idiomatic place for this kind of per-call configuration in HTTP,
the same way a flag is the idiomatic place for it on a command line. It's
adapted rather than imported because `apps/cli`'s `package.json` only
declares a `bin` entry (no `exports`) — it isn't set up to be depended on
by another app, so this is a deliberate, small, documented duplication
rather than a cross-app dependency between two apps that should otherwise
evolve independently.

## Why no global `--registry`/`--store` config

`src/config.ts` only holds server-bind settings (`PORT`/`HOST`).
Deliberately no service-wide default registry/store directory: every route
that needs one takes it as a per-request `?registry=`/`?store=` query
parameter instead, exactly mirroring the CLI (every `xo` command that
touches a registry or store takes its own `--registry`/`--store` flag per
invocation, never a single global one baked into process startup). A
long-running service is far more likely than a one-shot CLI invocation to
need to serve multiple registries/stores from the same process — baking
one in at boot would have been a real behavior regression relative to the
CLI, not just a naming difference.

## Testing

All 86 tests in `test/` (69 pre-existing + 17 new in `test/auth.test.ts`)
run against **real library calls and, for most of them, a real loopback
HTTP listener** (`test/test-helpers.ts`'s `TestServer` binds `node:http`
to `127.0.0.1:0` and issues genuine `http.request` calls) — not an
in-process "inject" shim. The brief anticipated this sandbox might block
that (recommending a framework's built-in inject utility as a fallback),
but loopback networking works here even though outbound network access is
blocked, so real end-to-end HTTP requests were used throughout instead — a
strictly better test than calling a handler function directly, since it
also exercises the router, body parsing, and response serialization.

**Auth and the existing 69 tests**: `TestServer.start()` now provisions
its own temp-dir-backed `FsApiKeyStore` and issues itself one active key
at startup, and `request()` attaches `Authorization: Bearer <that key>`
to every call by default. That meant real auth could replace
`passThroughAuth` without touching any of the ~47 pre-existing
`.request(...)` call sites across `registry-routes.test.ts`/
`package-routes.test.ts`/`runtime-routes.test.ts`/
`compiler-routes.test.ts` — none of them were testing auth itself, so
they shouldn't have needed to know it now exists. Tests that *do* need
to exercise auth failure paths (`auth.test.ts`) opt out per-call via
`request(..., { skipAuth: true })` (omit the header) or
`request(..., { authorization: '...' })` in `extraHeaders` (override it
with something malformed/unknown/revoked).

Fixture packages are built via `@xo/package-sdk`'s real `ManifestBuilder`
+ `packBundle` (`test/fixtures.ts`), the same construction
`packages/registry/test/manifest-fixtures.ts` uses — kept as a local copy
rather than a cross-package import, matching that file's own stated reason
for not being imported elsewhere (test directories aren't a package's
public surface).

`node --import tsx --test test/**/*.test.ts` is the package's own `test`
script. In this sandbox specifically (no `node_modules` at all, since
there's no network access to `npm install` anything), tests were actually
run via `scripts/sandbox-verify-tests.sh` at the repo root, which points
Node at a global `tsx` install instead — see that script's own header
comment and `docs/TECH_STACK.md` for why. That script already globs
`apps/*` for any directory with a `test/`, so `apps/api` needed no changes
to it to be picked up.

## Workflow execution (P0.8)

Persistent, step-aware, restart-recoverable execution of the existing sequential
`CandidateWorkflow`s. Routes (all workspace-bound; see `/openapi.json` for the full contract):

| Method | Path |
|---|---|
| GET | `/workspaces/:workspaceId/workflows` |
| POST | `/workspaces/:workspaceId/workflows/:workflowId/executions` |
| GET | `/workspaces/:workspaceId/workflow-executions` |
| GET | `/workspaces/:workspaceId/workflow-executions/:workflowExecutionId` |
| POST | `/workspaces/:workspaceId/workflow-executions/:workflowExecutionId/resume` |

How it works (code: `src/workflows/`, `src/routes/workflow-routes.ts`):

- **Authority.** A workflow is always re-derived from the stored compilation:
  `composeWorkflows` -> `auditWorkflowExecutability` -> `prepareCandidateWorkflowForExecution`
  (all unmodified). Only `executable_candidate` workflows whose every step binds can start; anything
  else is `422 XO_WORKFLOW_NOT_EXECUTABLE`. The request body is strictly validated: any field other
  than `compilationId`, `workflowId`, `input` (start) or `decision`, `data`, `expectedStepExecutionId`,
  `expectedRevision` (resume) is a `400`.
- **Runtime reuse.** Each step is one real P0.5 `ExecutionRecord` executed by the unmodified
  `RuntimeCapabilityExecutor`, wrapped (not subclassed) by `RecordingStepExecutor`, which re-checks
  approval + permissions, validates input, creates/completes the execution record, and persists step
  state. The unmodified `WorkflowExecutor` runs each *segment* and the bridge's unmodified proven
  data-flow injection transfers producer values into consumer inputs.
- **HITL pause.** `WorkflowExecutor` has no pause primitive (a HITL node is just a completed node).
  The API layer therefore runs the engine in segments that end at the first pending
  `human_in_the_loop` step, persists `waiting_for_human`, and returns. `resume` applies the human
  decision through the same shared function P0.7's `/resolve` uses
  (`executions/resolve-human-task.ts`), then continues from the next step, re-seeding earlier steps'
  persisted outputs into the engine state so cross-pause data flow still works.
- **Persistence.** `<WORKSPACE_DATA_DIR>/<workspaceId>/workflow-executions/<id>/metadata.json` via the
  existing `BlobStore`. Every update is compare-and-swap on `revision`.
- **Guarantees (filesystem level).** Completed steps are at-most-once under normal continuation. A step
  left `running` by a vanished process is reported `interrupted` (or its already-completed execution
  outcome is adopted); only an explicit `resume` re-executes it, under a new execution id
  (at-least-once for that one step). **Exactly-once is not provided.** No automatic retries, no
  timeouts/cancellation, no distributed locking (in-process serialization only). `LocalFsBlobStore.put`
  is a plain `writeFile`, so a crash *during* a write can leave a truncated record.
- **Tests.** `test/workflow-executions.test.ts` (real HTTP + real filesystem stores). The multi-step
  cases use a hand-built XOIR fixture (`test/workflow-fixtures.ts`) stored through the real
  `FsCompilationStore`, because no real fixture currently compiles to a multi-step
  `executable_candidate` workflow — see that file's header. The Commercial Property PDF is exercised
  end to end for its one executable (single-step HITL) workflow.

## Known limitations

- **API keys have no expiry or rotation policy.** A key is valid forever
  until explicitly revoked (`manage-keys.ts revoke`) — there's no TTL,
  no automatic rotation, and no "issue a replacement, keep the old one
  valid for a grace period" flow. Real key-rotation UX (multiple active
  keys per identity with staggered expiry) is a reasonable next step but
  wasn't built here, per the brief's explicit scope.
- **No scoping/RBAC on top of auth yet.** `req.identity` is resolved and
  attached, but nothing currently reads it to decide what a given key is
  *allowed* to do — every valid key can call every non-exempt route.
  Wiring `req.identity` into `@xo/permissions` (or a registry-specific
  policy, e.g. "this key's `creatorDid` may only publish packages under
  its own namespace") is real design work intentionally left to a future
  pass — see "Auth vs. permissions" above for why it wasn't improvised
  here.
- **No rate limiting.** An authenticated caller can call any route as
  fast as the server can serve it; nothing here throttles per-key.
- **`FsApiKeyStore` is a local-filesystem implementation**, same
  single-instance/local-dev/CI role `LocalFsBlobStore` already plays for
  the registry — a real multi-instance deployment needs a real database
  behind the `ApiKeyStore` interface, not a new interface.
- **`/runtime/execute`'s happy path against a live model provider isn't
  tested here.** Everything this layer is actually responsible for —
  bootstrap, request validation, provider *resolution* (missing keys,
  unknown provider ids, missing endpoints, the "no model configured and
  the provider advertises none of its own" check) — is tested with real
  logic and no network calls. A response actually coming back from
  Anthropic/OpenAI/Gemini/Azure/Ollama needs a real network call this
  sandbox can't make; that's `@xo/ai-core`'s own test surface, not this
  layer's.
- **`/compiler/compile` only accepts `kind: 'xoir'`** — see "The compiler
  isolation boundary" above. This is deliberate, not a gap to close
  casually; closing it needs a real JSON schema for `KnowledgeGraph`/
  `CapabilityGraph` first, which doesn't exist anywhere in this codebase
  yet.
- **When Stage 4 (durable persistence) lands under `Runtime`**, nothing
  here should need to change shape — no persistence-aware endpoints
  (explicit checkpoint/resume routes) were added ahead of time, per the
  brief. Extending `runtime-routes.ts` with new capabilities once Stage 4
  ships should be additive.
- **When Stage 6 (XOIR-first compiler pipeline) lands**, the entire blast
  radius is `compile-adapter.ts` — see above.
- **A pre-existing gap noticed, not touched**: `packages/runtime`'s own
  `tsconfig.json` imports from `@xo/permissions` in source
  (`src/loader/package-loader.ts`, `src/permissions/permission-manager-gate.ts`)
  but never declares `packages/permissions` as a TypeScript project
  reference. It only surfaces as a build failure on a truly from-scratch
  build with zero pre-existing `dist` output anywhere to fall back on
  (building `packages/permissions` once first works around it). Flagged
  here rather than fixed, since `packages/runtime` is explicitly off
  limits for this task.
