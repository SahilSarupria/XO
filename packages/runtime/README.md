# @xo/runtime

**Stage 1: Package Mounting & Execution Pipeline.** Discovers installed
`.xo` packages, verifies them, mounts them as executable capabilities,
and deterministically *plans* requests against them — the "operating
system loading applications" analogy the original brief described.

**Stage 2: executing an installed Experience Object.** Takes a planned
request the rest of the way: retrieves a mounted package's components,
merges knowledge graphs across packages, assembles context and a prompt,
calls into `@xo/ai-core`'s provider-agnostic `ModelProvider` (the *only*
integration point with that package), and produces a structured
response, execution receipt, and session — with cancellation, timeouts,
streaming, budgets, safety, hooks, and middleware. See "Stage 2" below
for the full writeup.

**Stage 3: Workflow Execution Engine.** Executes a `WorkflowGraph` —
sequential chains, parallel fan-out/fan-in, conditional branches,
bounded loops, nested subworkflows — with retries, timeouts,
cancellation, in-memory checkpointing, and resume. A `capability` node's
entire implementation is "call back into Stage 2's `ExecutionPipeline.run`
again" — zero duplicated negotiation/retrieval/prompt/AI-calling logic.
See "Stage 3" below.

**Stage 4: Durable Runtime State & Persistence.** An optional,
additive `RuntimeStore` abstraction (sessions, executions, checkpoints,
receipts) so process-local Stage 1-3 state can survive process
termination and restart — an `InMemoryRuntimeStore` default and a local,
atomic, checksummed `FileRuntimeStore` for XO Studio / desktop use. No
database, no distributed anything, no change to Stage 1-3 behavior when
no store is configured. See "Stage 4" below, including the honest
at-least-once crash-consistency semantics.

Still **not** in scope (Stage 2/3/4's own explicit non-goals): long-term
memory, shared memory, learning, optimization, Experience Graph
mutation, or distributed execution/storage. Those are later stages; see
`@xo/runtime-core`'s `Mounter`/`Retriever`/`Merger`/`Budgeter`/
`SafetyChecker`/`ContextAssembler` interfaces for the frozen contracts
this package's own types are conceptually aligned with (see "Why several
Stage 2 types don't reuse `@xo/runtime-core`'s interfaces directly"
below for why they aren't implemented verbatim).

## Why this isn't built on `@xo/runtime-core`'s `Mounter` interface

`@xo/runtime-core` already declares a `Mounter` interface with
`mount(packageId, hostFamily) -> MountedPackage`. This package
deliberately doesn't implement it. `runtime-core`'s `MountedPackage` bakes
a specific host's resolved compatibility level into the mount itself —
appropriate for a later stage where mounting *is* a per-request,
per-host operation. Stage 1's mount is host-agnostic: a package is loaded
once, and any number of different `ExecutionRequest`s (each with its own
`HostProfile`) can be planned against it afterward, each resolving its
own compatibility level via `CapabilityNegotiator`. Reusing `runtime-core`'s
narrower interface here would have meant mounting once per host a
package might ever be asked to serve, which doesn't match "discovering,
validating, mounting, and exposing packages as executable capabilities"
as a host-independent step. `runtime-core`'s interfaces remain the
contract a later stage (real per-host mounting, retrieval, execution)
should implement.

## Module map

| Module | Responsibility |
|---|---|
| `ids.ts` | Branded operational identifiers (`MountId`, `RequestId`, `PlanId`, `ReceiptId`, `SessionId`, `EnvironmentId`) — runtime-local, distinct from `@xo/types`' package-format identifiers. |
| `registry/mounted-package.ts` | `MountedPackage` (immutable mount record) and `PackageRegistry` (immutable, copy-on-write, name→version→`MountedPackage`, multiple versions coexist). |
| `capability/capability-descriptor.ts` | `CapabilityDescriptor`: a package's declared `CapabilityDeclaration` paired with which package offers it. |
| `capability/capability-registry.ts` | Derived index over every mounted package's capabilities: exact-id `find`, deterministic substring `search`. |
| `capability/capability-negotiator.ts` | `CapabilityNegotiator.plan`: discover → filter incompatible → resolve duplicates → rank. Pure deterministic planning, no AI reasoning. |
| `runtime-context.ts` | `RuntimeContext`: an immutable snapshot pairing a `PackageRegistry` with its derived `CapabilityRegistry`. |
| `execution/execution-request.ts` | `ExecutionEnvironment` (host profile, provider, token budget) and `ExecutionRequest` (capability id or free-text query, against an environment). |
| `execution/execution-plan.ts` | `RankedCandidate` and `ExecutionPlan` — the negotiator's deterministic output. |
| `session/execution-receipt.ts` | `ExecutionReceipt` (immutable per-attempt record) and `buildReceipt`. |
| `session/execution-session.ts` | `ExecutionSession` (immutable, per-request lifecycle tracker) and `createSession`/`withPlan`/`withReceipt`. |
| `loader/package-loader.ts` | `PackageLoader`: `discover`, `mount`, `unmount`, `reload`, `mountAllDiscovered` — wraps `@xo/package-sdk`'s `PackageInstaller` for discovery and verification rather than reimplementing hash/Merkle/signature checking. |
| `observability/instrumentation.ts` | `RuntimeInstrumentation`: mount time, verification failures, planning latency, mounted package/component counts, via `@xo/observability`'s `Meter`/`Tracer` ports. |
| `runtime.ts` | `Runtime`: the stateful facade holding "the current registry" and swapping it atomically on mount/unmount/reload — everything else here is a pure value type or a pure function over one. |

## Design choices worth knowing about

- **Functional core, imperative shell.** Every domain object
  (`MountedPackage`, `PackageRegistry`, `ExecutionPlan`, `ExecutionReceipt`,
  `ExecutionSession`) is immutable and `Object.freeze`d; every mutating
  operation (`PackageLoader.mount`, `PackageRegistry.withMounted`, ...)
  returns a *new* value rather than mutating in place, mirroring
  `@xo/package-sdk`'s `ManifestBuilder`. `Runtime` is the one stateful
  piece — the "process table" that holds the current immutable snapshot
  and swaps it — matching the OS-loading-applications analogy without
  making the underlying data model itself mutable.
- **Capabilities come from the manifest, never from `metadata.json`.**
  `PackageLoader.mount` reads `manifest.capabilities` (`@xo/types`,
  `@xo/package-sdk`'s `ManifestBuilder.setCapabilities`) directly — a
  package that declares no capabilities exposes none, regardless of what
  its `metadata.json` `domain`/`scope` says about itself. See
  `@xo/package-sdk`'s README for the manifest-format side of this.
- **Verification is entirely `@xo/package-sdk`'s job.** `PackageLoader`
  never re-implements hash/Merkle/signature checking; `mount` calls
  `PackageInstaller.verifyInstallation` and refuses to mount anything that
  fails it. Two small `PackageInstaller` additions were needed for this
  (see `@xo/package-sdk`'s README): `listAllInstalledRecords()` (every
  installed version, not just each package's single "active" one — Stage
  1 needs "support multiple versions simultaneously") and `getManifest()`
  (read a specific installed version's manifest without needing its
  component bytes).
- **Compatibility resolution happens at plan time, not mount time.**
  `resolveCompatibility` (`@xo/package-sdk`) is only ever called from
  `CapabilityNegotiator`, against a specific `ExecutionRequest`'s
  `HostProfile` — never from `PackageLoader`. A mounted package doesn't
  have "a compatibility level"; it has one *per request*.
- **`fallbackPolicy` decides whether `L0` excludes a candidate.**
  `resolveCompatibility` returning `L0` (host family not declared, or its
  capabilities fall short) doesn't automatically disqualify a candidate —
  `CapabilityNegotiator.filterIncompatible` only excludes it if that
  package's own `compatibility.fallbackPolicy` is `'reject'`. A package
  declaring `'degrade_gracefully'` stays in the running even at `L0`,
  because its creator explicitly opted into being usable in a degraded
  form.
- **Search is substring matching, not semantic matching.**
  `CapabilityRegistry.search` is a deterministic, case-insensitive
  substring match over `id`/`name`/`description` — "pure deterministic
  planning" per the Stage 1 brief, explicitly excluding embedding-based
  or reasoning-based matching. A later runtime stage can layer semantic
  search on top without changing this method's contract (same query
  always returns the same results in the same order).
- **`tokenUsage` in every `ExecutionReceipt` is a real, honest zero, not
  an omitted field.** Stage 1 never makes an AI provider call, so there's
  nothing to have consumed tokens. The field is present now (rather than
  optional/absent) so a later stage that adds real execution can start
  populating it without changing `ExecutionReceipt`'s shape or any
  existing reader of it.

## What "execution" meant in Stage 1 (superseded by Stage 2)

Stage 1 had no prompt assembly, retrieval, or provider call for a
receipt to describe. `buildReceipt` (Stage 1) records the outcome of the
mount-verification + deterministic-planning pipeline alone —
`packagesUsed`/`componentHashes`/`capabilitiesInvoked` describe what
planning *selected*, not what a model did with it, and `tokenUsage` is a
fixed `{0, 0}` placeholder. `buildExecutionReceipt` (Stage 2) is the real
thing: the same `ExecutionReceipt` shape, but `tokenUsage`/`estimatedCost`
come from an actual `StructuredResponse` and `degraded` reflects what
`ExecutionPipeline` actually observed. Both functions still exist
side by side, unmodified from how each was written — `buildReceipt` for
planning-only callers (`Runtime.plan`), `buildExecutionReceipt` for
`ExecutionPipeline`.

## Known limitations (stated honestly, not smoothed over)

- **`@xo/ai-core` is the real package, integrated at the `ModelProvider`
  layer, not `AiCapabilityLayer`.** See "What integrating at the
  `ModelProvider` layer costs" in the Stage 2 section above for exactly
  what that trades away (tool-calling, retry/circuit-breaking, cost/cache
  accounting, real request cancellation) and why.
- **No long-term memory, shared memory, learning, optimization,
  Experience Graph mutation, or distributed execution**, by design —
  Stage 2's explicit non-goals, not missing features. `MemoryManager` is
  working memory only (in-process, per-session, bounded, never
  persisted); see its own doc comment for the precise boundary.
- **`SafetyPipeline` is a best-effort JSON parser, not a defined
  component schema.** It doesn't assume a canonical `safety_rules` wire
  format (none is defined anywhere in this repo) — it parses a
  reasonable shape (`{ rules: [...] }`) and silently contributes nothing
  for anything else, rather than throwing. A real fixed schema, if one
  gets defined, would let it be stricter.
- **`estimateTokens` is a rough approximation** (4 characters/token), not
  a real tokenizer — `@xo/runtime` has no tokenizer dependency. It's only
  ever used pre-call for budgeting; a real `ProviderResponse.usage` from
  an actual provider is always the authoritative figure that ends
  up in a receipt.
- **Instrumented counts use histograms, not gauges.** `@xo/observability`'s
  `Meter` only exposes `Counter` (monotonic) and `Histogram`, no
  gauge/up-down-counter primitive. A mounted-package count that both
  rises (mount) and falls (unmount) doesn't fit a monotonic counter, so
  `RuntimeInstrumentation.recordCounts` records observed counts as
  histogram samples — the closest fit available without extending that
  port.
- **`ExecutionRequest`'s "at least one of `capabilityId`/`query`"
  constraint isn't type-level.** Both fields are plain optional
  properties, validated (as "no candidates") by `CapabilityNegotiator`
  at plan time rather than by a discriminated union at the type level —
  simpler call sites, at the cost of the constraint only being enforced
  at runtime. The same is true of `ExecutionEngine.execute`'s requirement
  that `input` be set — it's a plain optional field, checked (and
  rejected with `RUNTIME_INVALID_REQUEST`) at the start of `prepare()`.

## Stage 2: executing an installed Experience Object

Stage 2 adds the ability to actually run a mounted package's capability
against an AI provider: "the runtime should now be capable of executing
an installed Experience Object," integrating with `@xo/ai-core` without
exposing any provider-specific API. Nothing in Stage 1 was rewritten —
every Stage 2 addition below is either a new module or a strictly
additive change to an existing one (new optional fields, new exported
functions alongside existing ones left untouched). See `CHANGES.md` at
the repo root for the exact list.

### `@xo/ai-core` is now the real package

Stage 2 was originally built against a small provisional stand-in for
`@xo/ai-core` (no real one existed yet). That stand-in has since been
fully replaced by the real `@xo/ai-core` you provided — nothing
provisional remains in this repo.

The real package's public surface turned out to be shaped differently
than the stand-in assumed, in one important way: `@xo/ai-core`'s
`AiCapabilityLayer` (`router.ts`) is not a general chat/completion
interface — its entire public surface is six fixed, document-extraction-
shaped capabilities (`extractEntities`, `extractKnowledge`,
`extractReasoning`, `extractCapabilities`, `extractDecisionGraph`,
`extractConstraints`) built for **the compiler's** Stage 4-9 extractors.
None of the six is "run this mounted XO's arbitrary declared capability
against arbitrary input," which is what Stage 2 actually needs — a
mounted package's capability (e.g. `contract_analysis`) isn't one of
those six, so `AiCapabilityLayer` has nothing to call for it.

`@xo/runtime` therefore integrates one layer down, against `ModelProvider`
(`provider-types.ts`) — still entirely provider-agnostic (that file's own
doc comment confirms it's the one boundary in the package that knows
about vendors; everything built on top of it, including
`AiCapabilityLayer`, is vendor-neutral) and exactly the plain
`complete`/optional-`completeStream` shape Stage 2's `CapabilityExecutor`
needs. See that class's doc comment for the full reasoning, and "What
integrating at the `ModelProvider` layer costs" below for what this
means Stage 2 does *not* get for free.

### Execution flow

`ExecutionRequest` → Capability Negotiation (Stage 1, unmodified) → Load
Installed XO → Retrieve Required Components → Knowledge Retrieval
(merge) → Context Assembly → Prompt Assembly → AI Capability Layer →
Structured Response → Execution Receipt → Execution Session, exactly as
specified. `ExecutionPipeline.prepare()` runs everything through Prompt
Assembly once; `run()` (non-streaming) and `runStreaming()` share that
same `prepare()` and only diverge on how they call the AI Capability
Layer and assemble the final response.

### Module map (Stage 2 additions)

| Module | Responsibility |
|---|---|
| `retrieval/retrieved-slice.ts` | `RetrievedSlice` (package-attributed, superset of `@xo/runtime-core`'s `RetrievedSlice`) and a documented, approximate `estimateTokens`. |
| `retrieval/knowledge-graph-merge.ts` | `mergeKnowledgeGraphs`: deterministic dedup-by-id merge across every mounted package's `knowledge_graph` component, with conflict detection. |
| `retrieval/knowledge-retriever.ts` | `KnowledgeRetriever`: fetches component bytes via `PackageInstaller.getComponent` (new in `@xo/package-sdk`, see below), wraps them as slices. |
| `context/context-assembler.ts` | `ContextAssembler`: builds the system prompt from slices. |
| `prompt/prompt-assembler.ts` | `PromptAssembler`: builds the exact `ProviderRequest` `@xo/ai-core`'s `ModelProvider` expects, folding in working-memory turns. |
| `ai/capability-executor.ts` | `CapabilityExecutor`: **the only place this package calls `@xo/ai-core`.** Talks to `ModelProvider`, not `AiCapabilityLayer` (see above). Translates failures to `RuntimeError`; passes success through unchanged; falls back to a single `complete()` call for a provider without `completeStream`. |
| `response/response-assembler.ts` | `ResponseAssembler`: `StructuredResponse` — the AI response, attributed and degradation-flagged, with `@xo/ai-core`'s field names (`inputTokens`/`outputTokens`, `finishReason`) translated to this package's own stable vocabulary (`promptTokens`/`completionTokens`, `stopReason`). |
| `memory/working-memory.ts` | `MemoryManager`: bounded, in-process, per-session turn history. **Working memory only** — see its own doc comment for exactly what that excludes. |
| `budget/budget-manager.ts` | `BudgetManager`: priority-ordered slice trimming to fit a token budget; `safety_rules` is never dropped. |
| `safety/safety-pipeline.ts` | `SafetyPipeline`: deterministic pattern-matching allow/block/redact against a package's own `safety_rules` component. |
| `cancellation/execution-cancellation.ts` | `ExecutionCancellation`: wraps `AbortController`, doubles as the timeout mechanism. Enforced at the pipeline level only — see below. |
| `hooks/execution-hooks.ts` | `ExecutionHooks` (per-stage lifecycle callbacks) + `runHook` (a throwing hook never fails the execution it's observing). |
| `hooks/execution-middleware.ts` | `ExecutionMiddleware` + `composeMiddleware` — onion-model wrapping of the whole execution, distinct from per-stage hooks. |
| `streaming/streaming-response.ts` | `StreamingResponse`: `events` (live `ProviderStreamEvent`s) + `result` (a `Promise<ExecutionResult>` resolved once the stream ends). |
| `session/session-manager.ts` | `SessionManager`: the stateful, `Map`-based counterpart to Stage 1's pure session functions. |
| `engine/execution-id.ts` | `deriveExecutionId`: pure, deterministic `RequestId -> ExecutionId`. |
| `engine/execution-pipeline.ts` | `ExecutionPipeline`: the orchestrator described above. |
| `engine/execution-engine.ts` | `ExecutionEngine`: the top-level facade — middleware composition, the live cancellation registry, `execute`/`executeWithCancellation`/`executeStreaming`/`cancel`. Takes a `ModelProvider` and defaults `options.model` from it if not given explicitly. |

### What integrating at the `ModelProvider` layer costs

Going one layer below `AiCapabilityLayer` means Stage 2 doesn't get
several real things `@xo/ai-core` provides at that higher layer, for
free:

- **No tool/function calling.** `ProviderRequest`/`ProviderResponse` have
  no tool-schema or tool-call fields at all — only `responseSchema`-driven
  structured output. An earlier version of this package (built against
  the provisional stand-in) had invented a tool-calling abstraction;
  that was this package's own invention, not something either the
  stand-in or the real `@xo/ai-core` actually provides, so it's gone.
- **No retry, circuit-breaking, or rate-limiting at this layer.** Those
  are real, tested mechanisms in `@xo/ai-core` (`retry.ts`,
  `circuit-breaker.ts`, `rate-limiter.ts`) — but they live inside
  `router.ts`'s `AiCapabilityLayer`, wired to its six extraction
  capabilities, not exposed as something a `ModelProvider` caller can use
  directly. A caller wanting retry around the `ModelProvider` Stage 2 is
  given would need to wrap it themselves.
- **No cost/cache accounting from `@xo/ai-core`.** `cost.ts`/`cache.ts`
  exist and work, but again as part of `AiCapabilityLayer`'s machinery.
  Stage 2's own cost figure in a receipt (`estimatedCost`) still comes
  from the *capability's own declaration* in the manifest, same as
  before — not from `@xo/ai-core`.
- **No `AbortSignal` on `ProviderRequest`.** There's no cancellation
  field on the request at all, so an in-flight provider call can't
  actually be aborted at the network/HTTP level. `ExecutionCancellation`
  and `raceCancellation` still guarantee the *pipeline* stops waiting and
  returns promptly on cancel/timeout — but the underlying call (if the
  concrete `ModelProvider` implementation made a real HTTP request) keeps
  running in the background until it naturally resolves or errors; its
  result is simply discarded rather than used.

None of this blocks Stage 2's own requirements (which don't call for
tool-calling, and implement their own deterministic
budget/safety/cancellation mechanisms independent of `@xo/ai-core`'s),
but it's a real, deliberate trade-off worth stating plainly rather than
leaving implicit.

### Two small, justified `@xo/package-sdk` additions

Both are the same kind of minimal, documented extension Stage 1 already
made to this package (`listAllInstalledRecords`, `getManifest`) — see
`packages/package-sdk/README.md`:

- **`PackageInstaller.getComponent(name, version, kind)`** — Stage 1
  only ever needed a package's *manifest*; Stage 2's retrieval needs
  actual component *content* (a knowledge graph's JSON, safety rules'
  JSON, ...), which nothing in the SDK previously exposed a way to read.

### Why several Stage 2 types don't reuse `@xo/runtime-core`'s interfaces directly

`@xo/runtime-core` already declares `Retriever`/`RetrievedSlice`,
`ContextAssembler`/`AssembledContext`, `Budgeter`, and `SafetyChecker`
interfaces. Stage 2's concrete classes are conceptually aligned with all
of them (see each module's own doc comments for the specific mapping)
but don't implement them verbatim, for the same reason Stage 1's README
gives for not implementing `Mounter`: `runtime-core`'s `Retriever` keys a
request by a single `packageId: string`, which forces composite-string
package identity (`"name@version"` or similar) — a real correctness risk
this package's `MountedPackage`/`PackageRegistry` deliberately avoid by
using plain `name`/`version` fields throughout. `SafetyChecker`'s
`'allow' | 'block' | 'redact'` verdict vocabulary *is* reused directly
(`SafetyVerdict` in `safety-pipeline.ts`) — it's a plain string union
with no such mismatch to work around.

### Deterministic execution ids

`deriveExecutionId(requestId) = ExecutionId("exec_" + requestId")` — pure,
no clock, no randomness. The same `RequestId` always derives the same
`ExecutionId`, satisfying the brief's explicit requirement and letting a
caller compute one before `ExecutionEngine.execute` returns (e.g. to
correlate logs, or to call `cancel()` using an id derived from a request
they haven't awaited the result of yet).

### Cancellation and timeouts are the same mechanism

`ExecutionCancellation` wraps one `AbortController`; constructing it with
a `timeoutMs` schedules an automatic `cancel('timeout')`.
`@xo/ai-core`'s `ProviderRequest` has no `AbortSignal`/cancellation field
at all (see "What integrating at the `ModelProvider` layer costs"
above), so cancellation can't be threaded down into the provider call
itself — `ExecutionPipeline.raceCancellation` is the *only* enforcement
point: it races the AI call against the cancellation signal and returns
as soon as either settles, guaranteeing the pipeline stops waiting
promptly on cancel/timeout, but the underlying provider call (if it made
a real network request) keeps running in the background until it
naturally resolves; its result is simply discarded rather than used.

### Hooks vs. middleware

`ExecutionHooks` are per-stage observers (`onPlanned`, `onRetrieved`,
...) that can never affect the execution — a throwing hook is caught and
logged, never propagated. `ExecutionMiddleware` wraps the *entire*
execution in an onion model and genuinely can affect it (modify the
request, short-circuit by never calling `next`, inspect/replace the
final `ExecutionResult`) — the two are deliberately different tools for
deliberately different jobs, not two names for the same thing.

### Graceful degradation, concretely

Three independent things can each set `degraded: true` on the session
and receipt, and none of them fail the execution outright: a `SafetyPipeline`
redaction, `BudgetManager` dropping lower-priority slices to fit a token
budget, and (already true since Stage 1) a negotiator selecting an `L0`
candidate under `fallbackPolicy: 'degrade_gracefully'`. A safety **block**
(as opposed to a redact) is the one thing that does fail the execution —
degradation is for content that had to be trimmed or altered, not for
content that should never have been processed at all.



```
npm test              # node --test, 176 tests
npm run test:coverage # line/branch/function coverage report
```

Tests cover: mounting a valid package (and its declared capabilities
appearing verbatim), rejecting a package corrupted on disk after install
(hash failure), rejecting an invalid/forged signature, rejecting a
duplicate mount, mounting multiple versions of the same package
simultaneously, unmount/reload, batch discovery+mount with per-package
failure collection, capability discovery (exact id and free-text search),
compatibility-based filtering (including the `fallbackPolicy` distinction),
duplicate-version resolution, deterministic ranking, deterministic
planning (repeated runs produce identical output), receipt/session
construction, immutability (`Object.isFrozen` + mutation-attempt checks),
JSON round-trip serialization, and end-to-end integration against a real
`@xo/package-sdk` `PackageInstaller` over a real `LocalFsBlobStore`.

Stage 2 adds: knowledge-graph merging (dedup, conflict detection,
malformed-input tolerance), budget-driven degradation (priority-ordered
trimming, `safety_rules` never dropped), the safety pipeline's
allow/block/redact paths, context/prompt assembly, `CapabilityExecutor`'s
success/failure translation against a scripted `ModelProvider`
test double, working memory bounds and per-session isolation,
`SessionManager` CRUD, `ExecutionCancellation` (manual cancel, timeout,
idempotency, disposal), deterministic `ExecutionId` derivation, middleware
composition and short-circuiting, and full end-to-end `ExecutionEngine`
integration: happy path with real token/cost accounting in the receipt,
missing-input/no-candidate/safety-block/timeout/cancellation failure
paths, multi-package knowledge merging via `auxiliaryCapabilityIds`,
graceful degradation under a tiny token budget, streaming (including a
mid-stream provider failure), hook ordering (including a throwing hook
not affecting the outcome), and middleware wrapping.

Stage 3 adds: every readiness rule in `WorkflowScheduler` (sequential
single-predecessor gating, parallel fan-out, AND-join at `merge`,
OR-join with decision-skip propagation, declaration-order determinism
independent of `Map`/`Set` iteration), condition evaluation (every
`ConditionOperator`, dot-path resolution, the `predicate` escape hatch),
retries (transient-then-success, exhausted-retries failure with the
*actual* failing error surfaced — not a generic one), per-node timeouts,
mid-run cancellation (including the specific "a node failing due to
cancellation must not become permanently un-resumable" case), failure
propagation to downstream nodes, `loop` (iteration counting, the
`maxIterations` termination guard), `subworkflow` (nested output
propagation), `delay` (via injectable `sleep`), `custom:<name>` dispatch
(both a registered handler and the clear-failure case for an
unregistered one), checkpoint-and-resume (verifying already-completed
nodes are never re-run), workflow events (documented ordering, a
throwing listener not affecting execution), immutability, deterministic
re-runs of the same graph, `WorkflowReceipt` aggregation, and — the
whole point of Stage 3's integration story — real end-to-end tests
routing `capability` nodes through actual mounted packages and a real
(scripted) `ModelProvider`, proving zero duplicated Stage 2 logic.

## Stage 3: Workflow Execution Engine

Executes a `WorkflowGraph` — a directed graph of typed nodes — to
completion: sequential chains, parallel fan-out/fan-in, conditional
branches, bounded loops, nested subworkflows, retries, timeouts,
cancellation, checkpointing, and resume. Built entirely on top of Stage
1/2 without modifying either: a `capability` node's entire implementation
is "build a synthetic per-node `ExecutionRequest` and call
`ExecutionPipeline.run` again" (see `workflow/workflow-node-handlers.ts`'s
`makeCapabilityNodeHandler`) — zero duplicated negotiation, retrieval,
context/prompt assembly, or AI-calling logic.

### The `WorkflowGraph` contract is this package's own, like Stage 2's `@xo/ai-core` stand-in was

Nothing in this repo's compiler emits a `WorkflowGraph` yet — the brief
was explicit that `WorkflowExecutor` "should NOT know how the
`WorkflowGraph` is produced," only consume it. `workflow/workflow-graph.ts`
defines that consumed contract: plain, JSON-serializable data (node
list, edge list, a `startNodeId`), no closures anywhere in it except the
one deliberately-non-serializable `WorkflowCondition` escape hatch (see
its own doc comment for why a real compiler-produced graph should never
use it). Expect this shape to be reconciled against whatever the
compiler's own `WorkflowGraph` output type turns out to be once that
stage exists — the same relationship Stage 2's provisional `@xo/ai-core`
had to the real one, and the same reason it's kept as a small, isolated,
clearly-documented module rather than woven throughout the codebase.

### Node types are handled generically, not switch-cased

Every node type — the nine fixed ones (`start`, `end`, `capability`,
`decision`, `parallel`, `sequence`, `merge`, `loop`, `delay`,
`subworkflow`) and any `custom:<name>` — dispatches through the same
`NodeHandler` registry (`workflow/workflow-node-handlers.ts`). A
`custom:<name>` node with no registered handler fails clearly
(`RUNTIME_INVALID_REQUEST`) rather than silently no-op-ing.

### The scheduler: one readiness rule handles sequential, parallel, AND-join, and OR-join

`WorkflowScheduler.computeCursor` (see its own extensive doc comment) is
the entire scheduling algorithm, and it's one rule: a node is `ready`
once every incoming edge's source has reached a terminal state
(`completed`/`failed`/`skipped`) *and* at least one of them is
`completed`; if every incoming source is terminal but *none* is
`completed`, the node resolves to `skipped` instead (propagating forward
without ever reaching a handler). This one rule is what makes:

- a **sequential** chain (single predecessor) gate correctly,
- **parallel** fan-out require no special handling at all (multiple
  nodes just end up simultaneously `ready`),
- a **`merge`** node behave as an AND-join (multiple predecessors, all
  must be terminal), and
- an ordinary reconvergence node after a **`decision`** behave as an
  OR-join (multiple predecessors, but only the taken branch actually
  completes)

...fall out of the *same* rule, with `merge`/`sequence` staying pure
documentation markers rather than scheduler-special-cased node types.

The one subtlety this requires: a `decision` node "completing" doesn't
mean *every* outgoing edge is satisfied — only the one it selected.
`WorkflowState.takenEdges` tracks exactly which edges were actually
traversed (every outgoing edge, by default, for an ordinary node; only
the selected one for `decision`/`loop`), and the scheduler treats an
edge whose source completed but wasn't taken exactly like an edge from a
`skipped` source. This is also what makes `decision`-then-reconverge
work: the untaken branch's target resolves to `skipped`, and a
downstream OR-join becomes ready anyway once the taken branch completes.

### `loop` doesn't use graph cycles

A literal back-edge in the main graph would break the "visit each node
once" assumption the scheduler above relies on. Instead, `loop` runs its
`config.bodyGraph` — a nested `WorkflowGraph` — internally, in a plain
sequential JS loop, checking `exitCondition` (and a hard
`maxIterations` cap, default 1000, regardless of what the condition
says) between iterations. From the outer graph's perspective, a `loop`
node is just one node that happens to take a while, the same way a slow
`capability` node does — not a scheduling special case. `subworkflow`
uses the same nested-execution mechanism for a single (non-repeating)
nested graph.

### Retries, timeouts, and cancellation

- **Retries**: `node.retryPolicy` (`maxAttempts`, `backoffMs`,
  optional `backoffMultiplier`) — deterministic, attempt-indexed
  backoff, **no jitter**, per the brief's "no randomness" constraint.
- **Timeouts**: `node.timeoutMs` races the node's handler against a
  timer; exceeding it fails that attempt with `RUNTIME_EXECUTION_TIMEOUT`
  (subject to the same retry policy as any other failure).
- **Cancellation**: reuses Stage 2's `ExecutionCancellation` directly —
  one shared instance across the whole workflow run, threaded into every
  `capability` node's synthetic `ExecutionRequest` too. Every node
  dispatch races against it (`WorkflowExecutor.runWithTimeout`, despite
  the name, always listens for cancellation even when no `timeoutMs` is
  set — an earlier version of this only raced when a timeout was
  configured, which let cancellation race behind an in-flight untimed
  node's completion; fixed before this delivery, see the test
  "cancellation: cancelling mid-run..."). A node that fails specifically
  *because* the workflow was cancelled is deliberately **not** recorded
  as a permanent `failedNodes` entry — it stays unvisited, so a
  subsequent `resume()` can retry it cleanly rather than finding it
  permanently blocked.

### Checkpointing (in-memory only)

`WorkflowCheckpoint` is a fully self-contained snapshot (the whole
`WorkflowInstance`, including its `graph` — a caller never needs to
re-supply it to `resume()`). `CheckpointStore` is the same
functional-core (`createCheckpoint`, a pure function) / imperative-shell
(the `Map`-based store) split as `SessionManager`/`PackageRegistry`
elsewhere in this package. **No persistence** — nothing here is written
to a `BlobStore` or any durable storage; that's explicitly future scope,
per the brief. `WorkflowExecutorOptions.checkpointEveryRound` (default
`false`) auto-checkpoints after every round; `createCheckpoint(instance)`
is also callable directly at any point a caller has an instance in hand.

### Integration with `ExecutionPipeline`

`ExecutionRequest` gained one new optional field, `workflowGraph`.
`ExecutionPipeline.run()` checks it as the *very first thing it does* —
set, the request is delegated entirely to an internal `WorkflowExecutor`
(constructed once, in the constructor, wired to call back into `run()`
itself for `capability` nodes); absent, every line below that check is
completely unchanged from Stage 2. This is the literal meaning of "if no
`WorkflowGraph` exists, execution should continue exactly as before" —
not "behaviorally equivalent," but the same code path, untouched.
`ExecutionResult` gained one new optional field, `workflowResult`,
carrying the full per-node `WorkflowResult`; `response`/`receipt` are
still populated for a workflow request too (a JSON summary of the
workflow's outputs), so a caller that only ever reads
`result.response.content` — ignorant of Stage 3 entirely — still gets
something sensible back. Streaming a workflow is explicitly out of
scope for this stage; `runStreaming` doesn't inspect `workflowGraph` at
all (documented at its call site, not silently unsupported).

### Observability

`WorkflowEventEmitter` is a small synchronous fan-out emitter for the
nine documented event types (`started`, `completed`, `failed`,
`cancelled`, `checkpoint`, `resumed`, `node_started`, `node_completed`,
`node_failed`) — deliberately not async, and a throwing listener never
affects execution (same principle as Stage 2's `ExecutionHooks`). There's
no dedicated event for a node resolving to `skipped` — outside the nine
specified types, so it's left silent (visible in `WorkflowState.skippedNodes`
and the receipt's `skippedNodeCount` instead) rather than inventing a
tenth type. Node-level outcomes also feed Stage 2's existing
`RuntimeInstrumentation.recordExecutionOutcome` (no new instrumentation
methods were needed).

### Known limitations (Stage 3, stated honestly)

- **No distributed execution.** Everything runs in one process, in
  memory. "Parallel" branches means concurrent `Promise.all` dispatch
  within a single Node.js process, not multi-machine execution.
- **No checkpoint persistence**, per the brief — in-memory only. A
  process restart loses every checkpoint.
- **`loop`/`subworkflow` require an embedded nested `WorkflowGraph`** in
  `config` (`bodyGraph`/`graph`) — there's no mechanism yet for
  referencing a graph by id and having something else resolve it (e.g.
  a graph registry). A real compiler-integrated version would likely
  want that.
- **No graph validation.** `WorkflowScheduler`/`WorkflowExecutor` don't
  check that a `WorkflowGraph` is well-formed (reachable `startNodeId`,
  no orphaned nodes, valid node-type/config combinations) before running
  it — a malformed graph surfaces as a stalled `waiting` set (reported
  as a clear failure) or a node handler's own validation error
  (`RUNTIME_INVALID_REQUEST` for a `capability`/`loop`/`subworkflow`
  node missing required config), not a dedicated upfront validation
  pass.
- **Workflow-level timeout is via `ExecutionCancellation`'s constructor
  `timeoutMs`, same as Stage 2** — there's no separate "whole workflow
  must finish within N ms regardless of per-node timeouts" concept
  beyond that.


## Stage 4: Durable Runtime State & Persistence

Everything Stage 1-3 produces — sessions, workflow execution state,
checkpoints, receipts — was process-local: gone the moment the process
exits. Stage 4 adds an optional, additive persistence layer so that
state can survive process termination, application restart, and
interrupted workflow execution, **without changing anything about how
the runtime behaves when no persistence is configured** — every Stage
1-3 test still passes unmodified, and every existing caller that never
mentions a `store` continues to run entirely in memory, exactly as
before.

### The abstraction wraps existing types; it doesn't redefine them

`RuntimeStore` (`persistence/runtime-store.interface.ts`) has four
sub-stores — `sessions`, `executions`, `checkpoints`, `receipts` — and
every one of them stores the *actual* Stage 1-3 types
(`ExecutionSession`, `WorkflowInstance`, `WorkflowCheckpoint`,
`ExecutionReceipt`/`WorkflowReceipt`) wrapped in a small versioned
envelope (`{ version, persistedAt, data }`), not a redesigned schema.
"Persist the existing runtime receipt model without creating a second
receipt format" applies to every record type here, not only receipts.

The one sub-store name that needed disambiguating: the interface's
`checkpoints` field is typed `CheckpointRecordStore`, not
`CheckpointStore` — that name already belongs to Stage 3's in-memory,
non-durable checkpoint cache (`workflow/workflow-checkpoint.ts`), which
this does not replace or wrap. A `sequence` number (0, 1, 2, ... per
execution) is assigned by the store itself at the record/envelope level,
not added to `WorkflowCheckpoint`, so that type stays untouched too.

### Two implementations, same interface

- **`InMemoryRuntimeStore`** — the default in every sense that matters:
  constructing a `WorkflowExecutor` without a `store` option uses no
  persistence at all (not even this one); `InMemoryRuntimeStore` exists
  for a caller who wants `RuntimeStore`'s uniform get/list/delete
  semantics without committing to durability, or for testing.
- **`FileRuntimeStore`** — the durable option, for XO Studio / local
  desktop execution: one JSON file per record under a `rootDir` the
  caller owns, no database, no external process. Every write is atomic
  (serialize to a temp file in the same directory, then `rename` —
  same-filesystem renames are atomic on every platform Node supports, so
  a reader never observes a half-written file) and checksummed (a
  content hash alongside the payload, verified on every read, so a
  truncated or tampered file is reported as `corrupt`, not silently
  misread or crashed on). Serialization is deterministic (object keys
  sorted recursively before `JSON.stringify`), so the same data always
  produces the same bytes. No SQLite — a directory of small, independent
  JSON files, each safely and atomically replaceable, is a better fit
  for "minimal reliable local persistence that can later be replaced" than
  a single shared database file would be for this stage's scope.

  Layout:
  ```
  sessions/<sessionId>.json
  executions/<executionId>.json
  checkpoints/<executionId>/<seq>__<checkpointId>.json  (+ _by-id/ for O(1) get-by-id)
  receipts/execution/<receiptId>.json
  receipts/workflow/<receiptId>.json
  receipts/_by-execution/<executionId>/<kind>__<receiptId>.json
  ```

### Concurrency: per-key locking, not a global lock

`KeyedAsyncLock` (`persistence/file/atomic-file-io.ts`) serializes
operations that touch the *same* record (e.g. two writes to the same
session id racing each other) while letting operations on *different*
records run fully concurrently — "avoid global locks that unnecessarily
serialize unrelated executions." This is purely in-process ordering
(chained promises per key); the atomic rename is what actually protects
against a torn write, independent of any lock.

### `WorkflowExecutor` integration: additive, opt-in, same resume path

One new constructor option, `store?: RuntimeStore`. With no store:
`WorkflowExecutor` behaves exactly as Stage 3 always did — confirmed by
every pre-existing Stage 1-3 test still passing unmodified. With a
store, a top-level `run()`/`resume()` persists its execution record
after every round and at completion (see "What gets persisted, and
when" below), and every produced receipt is saved once the workflow
completes successfully.

Nested executions (a `loop` body, a `subworkflow`) are **never**
separately persisted — only the top-level `run()`/`resume()` call
persists (`runToCompletion`'s new `isTopLevel` parameter, threaded
through internally; `runNested` always passes `false`). A loop that runs
50 internal iterations doesn't produce 50 execution records; it produces
one, updated as the outer round loop advances.

**No second resume implementation.** `resumeFromStore(executionId,
environment)` is sugar built entirely on Stage 3's existing `resume()`:
it looks up the latest persisted checkpoint for `executionId` and calls
`resume()` with it; if no checkpoint was ever taken but the execution
record itself was persisted (which happens automatically whenever a
`store` is configured, checkpoints or not), it falls back to wrapping
that record in a checkpoint via `createCheckpoint` — the exact same
function `WorkflowExecutor.createCheckpoint` itself uses — and calls the
exact same `resume()`. There is only one code path that actually resumes
a workflow; `resumeFromStore` never duplicates it.

`createCheckpoint` (Stage 3) stays synchronous and completely unchanged
— existing callers and tests keep working. A new, separate,
async `persistCheckpoint` method wraps it for the durable case
(`checkpointEveryRound` now calls this instead when a store is
configured).

### What gets persisted, and when

```
execution created           -> persisted (before the round loop starts)
   |
round: nodes dispatched, results folded, state updated
   |
state updated                -> persisted (every round, unconditionally)
   |
(if checkpointEveryRound)   -> checkpoint persisted
   |
... repeat until terminal ...
   |
completed / failed / cancelled -> persisted (final status)
   |
(if completed)              -> workflow + node receipts persisted
```

Deliberately **not** persisted: anything inside a single round before it
folds (no "node dispatched, not yet resolved" marker) — "do not persist
every internal micro-operation unnecessarily," and see "Crash
consistency" below for exactly what this trades away.

### Crash consistency: at-least-once, stated plainly

If the process dies **between** a node's own execution and the next
persistence point (i.e. mid-round, before that round's state update is
persisted), that node's result is lost. On resume, the scheduler sees
that node as still unvisited (its predecessor, if any, is whatever the
*last persisted* state says) and dispatches it again. This is
**at-least-once execution, not exactly-once** — a node whose side effect
isn't naturally idempotent (e.g. a `capability` node that sends an
email) could genuinely run twice across a crash-and-resume. This runtime
does not claim otherwise anywhere, and callers whose node handlers have
non-idempotent side effects should account for this explicitly (e.g. via
their own idempotency keys derived from `NodeId` + `WorkflowInstanceId`).

A node that fails specifically *because* the workflow was cancelled
(Stage 3's existing distinction — see "Retries, timeouts, and
cancellation" above) is, as before, excluded from `failedNodes` so it
remains eligible for a clean retry on resume, rather than being
permanently blocked. This Stage 3 behavior is unchanged and is exactly
what makes at-least-once actually work in the cancellation/restart case,
not just the crash case.

### A real bug Stage 4's own tests found and fixed

`WorkflowCheckpoint.checkpointId` was generated from `workflowInstanceId`
+ wall-clock milliseconds alone. Two checkpoints for the same execution
created within the same millisecond — entirely possible for a fast,
unthrottled workflow, and something Stage 4's own `checkpointEveryRound`
tests hit directly — would collide and silently overwrite each other in
any `Map`/file keyed by checkpoint id. Fixed by adding a module-scoped
monotonic counter to the id (`workflow/workflow-checkpoint.ts`) — a
plain incrementing counter, not randomness, so it stays consistent with
this whole subsystem's "no randomness" constraint. This is a Stage 3
file with a Stage 3 bug, found while building Stage 4; fixing it there
(rather than working around it only in the new persistence layer) was
the correct fix regardless of which stage's tests happened to catch it.

### Versioning and migration

Every persisted record carries `version: number` (currently always `1`,
`persistence/versioning.ts`'s `CURRENT_RUNTIME_STORE_VERSION`).
`FileRecordStore`'s `migrate` hook is where a future version bump plugs
in: `(storedVersion, raw) => T` advances one old record to the current
shape. With no migrations registered yet, encountering any version other
than the current one is treated as a hard, clearly-reported error — not
silently accepted as-is — since that would be a real data-integrity risk
for the very first future record shape change to slip past unnoticed.

### Known limitations (Stage 4, stated honestly)

- **At-least-once, not exactly-once** — see "Crash consistency" above.
  This is a stated design trade-off, not an oversight.
- **No distributed locking, no remote stores, no database** — explicitly
  out of scope per the brief. `FileRuntimeStore` assumes a single
  process (or single machine with external file-level coordination) has
  exclusive access to `rootDir`; nothing here coordinates two processes
  writing to the same directory concurrently beyond what atomic renames
  already provide for individual records.
- **Workflow-level "waiting" nodes are a persisted snapshot, not a
  source of truth.** `ExecutionRecord.waitingNodeIds` is computed once,
  at save time, via `WorkflowScheduler.computeCursor` — useful for
  inspection/debugging a persisted record without re-deriving it, but
  `resume()` itself never reads it; only `instance` (graph + state) is
  trusted for actually continuing execution.
- **No automatic cleanup/retention policy.** Nothing here deletes old
  sessions, executions, checkpoints, or receipts on its own — `delete`
  methods exist on every store, but calling them is entirely up to the
  caller.
- **`FileRuntimeStore`'s checkpoint sequence counter is a small
  in-memory cache**, refreshed from disk on first use per execution (not
  read eagerly at construction) — verified by Stage 4's own restart
  tests to continue numbering correctly across separate store instances
  pointed at the same directory, but worth knowing it isn't purely
  stateless.

## Stage 5: Durable Runtime Memory & Context

Stage 4 answered "where is execution/workflow state stored?" Stage 5
answers a different question: "what does the runtime *remember* across
executions, how is it scoped, how is it retrieved, and how is it
persisted safely?" It is additive on top of Stage 4's persistence
boundary, not a replacement for anything Stage 1-4 built.

### The three-way split this stage insists on

```text
                    Runtime
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
 Execution State     Memory        Receipts
        │              │              │
 checkpoints       durable         immutable
 workflow state     knowledge        evidence
 sessions           context
```

Stage 5 memory is *not* a replacement for checkpoints, `ExecutionRecord`,
`WorkflowState`, or receipts, and does not merge with any of them. It
also isn't a replacement for the pre-existing `MemoryManager`
(`memory/working-memory.ts`) — that class is unchanged and still owns
exactly what it always owned: per-session conversational *turn history*
(user/assistant/tool messages), transient, in-process only, feeding
`PromptAssembler`. Stage 5's `RuntimeMemory` is durable, structured,
scoped, and explicitly written — a different thing serving a different
purpose. A capability's turn history and a fact it decided to remember
past this conversation are not the same kind of information, and keeping
them as two systems (rather than generalizing working memory into
"everything is memory now") is a deliberate Stage 5 decision, not an
oversight.

### The memory model

```text
current execution context
        ↓
working memory (unchanged, Stage 1-era MemoryManager)
        ↓
durable runtime memory (Stage 5 — this section)
        ↓
retrieval (query / queryAcrossScopes)
        ↓
future execution context
```

A `MemoryEntry` (`memory/memory-types.ts`) is:

```ts
interface MemoryEntry {
  id: MemoryEntryId;
  scope: MemoryScope;
  type: 'fact' | 'preference' | 'result' | 'context';
  key?: string;               // upsert identity within a scope
  value: unknown;
  provenance?: MemoryProvenance;
  metadata?: Readonly<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;         // TTL — absent means "never expires"
}
```

Every field answers a concrete question this stage's brief asked for;
nothing was added because it "sounded useful." `type` is deliberately a
small, closed set (§5 of the brief explicitly warns against inventing
categories) — every value maps to a concrete example the brief itself
names (user preference → `preference`, workflow fact/learned context →
`fact`/`context`, previous result → `result`).

### Scopes: the isolation invariant, enforced structurally

```ts
type MemoryScopeKind = 'execution' | 'session' | 'workflow' | 'runtime';
interface MemoryScope { kind: MemoryScopeKind; scopeId: string; }
```

A closed set, matching `@xo/permissions`' closed-domain pattern for the
same reason: an open-ended scope string would let a bug (or a hostile
package) mint a scope no isolation code was ever reviewed against.
`capability` and `package` scopes (mentioned as *candidates* in the
brief) were deliberately **not** added — nothing in this codebase
currently identifies "the current capability" or "the current package"
as a durable, addressable scope root the way it does `WorkflowInstanceId`
and `SessionId`. A future stage that needs one adds it as a new union
member and a new directory-name mapping in `FileMemoryRecordStore`,
never a change to how the existing kinds behave.

The isolation invariant — "memory from one scope must not accidentally
leak into another scope" — is enforced *structurally*, not by a filter a
caller could forget:

- `InMemoryDurableMemoryStore` partitions by a `Map` keyed on
  `scopeKey(scope)` (`"<kind>:<scopeId>"`) at the outer level; there is
  no code path that reads across that outer key.
- `FileMemoryRecordStore` partitions by directory:
  `memory/<kind>/<scopeId>/<entryId>.json`. A bug in this class could at
  worst corrupt one scope's files, never read across the directory
  boundary into another scope's.
- Every `MemoryRecordStore` method takes `(scope, ...)` explicitly —
  never a bare id — so a store implementation cannot even be asked "get
  this id" without also being told which scope it's supposed to live in.

Tested directly (`test/memory-record-store.test.ts`,
`test/runtime-memory.test.ts`): execution-vs-execution,
session-vs-session, and workflow-vs-execution isolation *even when the
underlying scopeId string is identical* — `executionScope('x')` and
`workflowScope('x')` derive different deterministic ids and never see
each other's entries, on both the in-memory and file-backed stores.

The one **intentional** broader-scope read is
`RuntimeMemory.queryAcrossScopes(scopes, ...)` — e.g. "this new
execution should see its session's memory." It never happens implicitly;
a caller must name every scope it wants merged, and (per §7 below) each
additional scope beyond the first is checked against the `'share'`
permission action specifically, distinct from plain `'read'`.

### Persistence: composed on Stage 4, not a new mechanism

```text
RuntimeMemory (memory/runtime-memory.ts)
    ↓
MemoryRecordStore (persistence/runtime-store.interface.ts — additive
                    member of RuntimeStore, alongside sessions/
                    executions/checkpoints/receipts)
    ↓
InMemoryDurableMemoryStore   |   FileMemoryRecordStore
                                     ↓
                              FileRecordStore (Stage 4, reused verbatim —
                              same atomic writes, checksums, versioned
                              envelope, and per-key locking every other
                              Stage 4 store already gets)
```

`FileMemoryRecordStore` doesn't reimplement any Stage 4 guarantee; it
gives every scope its own `FileRecordStore` instance (its own directory)
and adds scope-partitioning, TTL filtering, and query filtering on top.
`RuntimeStore.memory` is populated identically in both
`InMemoryRuntimeStore` and `FileRuntimeStore`, so an existing caller
building either store gets Stage 5 memory automatically, with zero other
changes to how they construct or use `sessions`/`executions`/
`checkpoints`/`receipts`.

### Permissions: reused, not reinvented

Per the brief's explicit instruction, this stage does not invent a new
authorization framework. `memory/memory-permission-gate.interface.ts` is
a minimal *port* (no `@xo/permissions` import, mirroring
`permissions/permission-gate.interface.ts`'s existing pattern for
capability execution) with four independently-checked actions — `read`,
`write`, `delete`, `share` — and a default,
`allowAllMemoryPermissionGate`, that permits everything (memory access is
unrestricted unless a host explicitly wires in a real gate, exactly like
every other permission port in this package).

`memory/memory-permission-manager-gate.ts` is the one file that imports
`@xo/permissions` (now a proper declared dependency — see "The
`@xo/permissions` dependency" below), mapping each action to a
`runtime.memory-<action>` permission id (`runtime` is an existing,
already-registered permission domain — no `@xo/permissions` change
needed) and checking it as a `resource` scope
(`memory:<scopeKind>:<scopeId>`), so an enterprise policy can grant/deny
memory access down to one specific execution or session, not only "all
memory" or "none." Tested against a real `PermissionManager` +
`RuleBasedPolicy`, including: a denied write never reaches the store, a
grant scoped to one resource doesn't leak to a different one, and a
`queryAcrossScopes` call with one scope denied `'share'` silently omits
that scope from the merged result rather than failing the whole call.

### Provenance and confidence

Per the brief's explicit instruction (§0, §8, §9), this is **not**
imported from `@xo/xoir` or `@xo/compiler` — `packages/runtime` still
does not depend on `@xo/xoir`, and this stage did not add that
dependency (verified by diff, not just checklist — see the final report
for this session). `@xo/compiler`'s own reasoning module doesn't pull
its `KnowledgeProvenance` from `@xo/xoir` either; it defines that type
locally in `packages/compiler/src/knowledge/types.ts` and references it
by shape. Stage 5 does the runtime-specific equivalent, locally, in
`memory/memory-types.ts`:

```ts
interface MemoryProvenance {
  sourceType: 'capability_output' | 'user_input' | 'system' | 'inferred';
  executionId?: string;
  capabilityId?: string;
  sessionId?: string;
  recordedAt: string;
  confidence: number;   // 0-1, required — never silently "certain" by omission
}
```

Shape-consistent with `KnowledgeProvenance` (structured origin fields
plus a single `confidence: number`), but the origin fields describe
*where in a runtime this memory came from* (which execution, which
capability, which session) rather than *where in a source document* —
`KnowledgeProvenance`'s `documentPath`/`pages`/`sectionPath`/
`charOffsetRange` have no meaning for something a capability generated
at runtime. `confidence` deliberately lives only on `provenance`, not as
a second, separate top-level scale on `MemoryEntry` — one number, one
place, matching how `KnowledgeProvenance` itself keeps confidence
alongside origin rather than as an independent field elsewhere. It is
`required`, not `optional`, on `MemoryProvenance` specifically so a
caller can never omit it and have it silently read as "certain" (§9's
"do not silently promote uncertain information to high confidence").
Both provenance and confidence are verified, across both store
implementations, to survive a put → get roundtrip and a full
file-store restart.

### Deterministic vs. random identity

`memory/memory-id.ts` draws the line the brief asks for (§14) explicitly:

- **`deriveMemoryEntryId(scope, key)`** — a pure `sha256(scopeKey +
  "::" + key)`-derived id. The same `(scope, key)` always derives the
  same id, so `RuntimeMemory.put` with a `key` is an *upsert*: writing
  `preference.language` twice replaces the same entry (preserving its
  original `createdAt`, updating `updatedAt`) rather than creating a
  duplicate. Plain `node:crypto`, the same primitive
  `persistence/file/atomic-file-io.ts` already uses for checksums — not
  `@xo/crypto`, since pulling in a whole extra package dependency for
  one hash call isn't warranted (consistent with this stage's "don't add
  dependencies you don't need" posture, the same posture behind not
  depending on `@xo/xoir`).
- **`generateMemoryEntryId()`** — `node:crypto`'s `randomUUID()`, for
  memory with no semantic key: an inherently unique event instance (one
  capability call's result), where forcing deterministic identity would
  silently collapse distinct events into one record.

### TTL

`memory/memory-ttl.ts`: `resolveExpiresAt` (absolute `expiresAt` wins
over a relative `ttlSeconds` if both are given) and `isExpired` (an
entry expiring at exactly `now` counts as expired — tested explicitly as
a boundary case on both stores). Enforced at the *store* layer, not only
in `RuntimeMemory`, so any caller reading a `RuntimeStore.memory`
directly — not just one going through the `RuntimeMemory` facade — gets
correct expiration semantics. `query(..., { includeExpired: true })` is
the one explicit escape hatch, for inspection/debugging tooling that
deliberately wants to see everything.

### Execution/workflow context integration

`WorkflowContext` (`workflow/workflow-context.ts`) gained one additive,
optional field:

```ts
interface WorkflowContext {
  workflowInstanceId: WorkflowInstanceId;
  graph: WorkflowGraph;
  state: WorkflowState;
  environment: ExecutionEnvironment;
  cancellation: ExecutionCancellation;
  memory?: ScopedRuntimeMemory;   // Stage 5
}
```

`WorkflowExecutorOptions` gained a matching optional `runtimeMemory?:
RuntimeMemory`. Omitted (as in every pre-Stage-5 caller), `context.memory`
is `undefined` — not a no-op stub — so a node handler can tell "no
memory configured" apart from "memory configured but empty," and every
pre-existing `WorkflowExecutor` test (and consumer) is byte-for-byte
unaffected. Configured, every `WorkflowContext` this executor builds
(there is exactly one construction site,
`WorkflowExecutor.buildContext`, shared by the top-level round loop and
every nested `loop`/`subworkflow` run via `runNested`) carries a
`memory` pre-bound to that run's own `workflow` scope
(`workflowScope(workflowInstanceId)`) — this is the
`context.memory.get(...)`/`.put(...)` shape the brief's §17 sketches.
Because nested executions get their own `workflowInstanceId`, a
`loop`/`subworkflow` body's memory is correctly its own workflow scope,
isolated from its parent's — tested directly.

`ScopedRuntimeMemory` (`memory/runtime-memory.ts`) never exposes the
underlying `MemoryRecordStore` or lets a holder name a different scope —
a capability holding one structurally cannot escalate to a broader
scope, which is what the brief's "do NOT expose the underlying
persistence store directly to capabilities" actually requires in code.

**Deliberately not done in this stage:** wiring memory automatically
into `ContextAssembler`/`PromptAssembler` so retrieved memories are
injected into a capability's prompt without being asked. The brief's
own diagram (execution → memory query → relevant memories → context
assembly → capability execution) describes a *contract*, and Stage 5
establishes exactly that contract (`RuntimeMemory`, `ScopedRuntimeMemory`,
`queryAcrossScopes`) without prematurely picking how/when a host chooses
to fold query results into an assembled prompt — see §13's explicit
instruction not to "prematurely choose a production search engine [or
integration point]." A future stage is free to wire this in once there's
a concrete need driving the design, rather than this stage guessing.

### Receipts: not merged with memory, on purpose

Per §19, memory operations do **not** produce a receipt of their own —
this codebase's existing security model doesn't require read/write
auditing at that granularity, and turning every memory read into a
receipt would be exactly the kind of unrequested complexity this brief
repeatedly warns against. Attribution, where useful, already lives on
`MemoryProvenance.executionId`/`capabilityId`/`sessionId` — enough to
answer "which execution/capability produced this memory" without a
second logging system.

### The `@xo/permissions` dependency

`packages/runtime`'s `permission-manager-gate.ts` (pre-existing, Stage
2-era) has always imported `@xo/permissions`, but `package.json` never
listed it as a dependency — masked by npm workspaces hoisting every
workspace package into the root `node_modules` regardless of whether a
package declares it needs one. This stage's own
`memory-permission-manager-gate.ts` needs the same import, so the gap
was fixed as part of this session (declared dependency in
`package.json`, project reference in `tsconfig.json`) — entirely inside
`packages/runtime`, touching nothing off-limits. This is the same gap
`apps/api`'s chat correctly flagged and declined to touch earlier, since
`packages/runtime` was off-limits to it at the time.

### What Stage 5 intentionally does not implement

Per §24 of the brief, none of the following exist here, and none were
added because "it might be useful later": Redis, Postgres, MongoDB, any
vector database, embeddings, a semantic search engine, distributed
memory, cloud storage, cross-machine synchronization, external memory
services, LLM-driven memory summarization, autonomous memory formation,
a memory marketplace, or automatic `ContextAssembler` wiring (see above).
Nothing here does automatic garbage collection beyond TTL-based
exclusion from reads — `clear(scope)` exists but is never called
implicitly by anything in this stage.

### Known limitations (Stage 5, stated honestly)

- **No cross-process locking beyond what `FileRecordStore` already
  provides per key** — same single-process-or-coordinated-filesystem
  assumption Stage 4 states for every other store.
- **`queryAcrossScopes` has no pagination beyond a flat `limit`** applied
  to the merged, sorted result — fine for the scope counts this stage
  anticipates (a handful of scopes per call), not designed for merging
  hundreds.
- **No automatic promotion from working memory to durable memory.** A
  capability/host must explicitly call `context.memory.put(...)`; nothing
  in `MemoryManager` (working memory) automatically persists a turn into
  `RuntimeMemory`, by design (§18: "memory writes should be intentional").
- **`ExecutionPipeline` (Stage 2's single-capability path, as opposed to
  `WorkflowExecutor`) has no `runtimeMemory` wiring in this stage.**
  Stage 5 focused its context-integration work on `WorkflowContext`,
  the integration point the brief's §17 example syntax most directly
  matches; a Stage 2-only caller can still construct and use
  `RuntimeMemory` directly (see `test/memory-workflow-integration.test.ts`'s
  `RuntimeStore.memory` test), just not via an injected `context.memory`
  on that path yet.
