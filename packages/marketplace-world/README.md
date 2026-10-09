# @xo/marketplace-world

Translates the actual XO ecosystem into [`@xo/atlas`](../atlas)'s
spatial model. Sits **above** Atlas (the generic interaction engine)
and **below** the marketplace UI. This package knows what an XO,
Capability, and Workflow are; Atlas never does.

---

## Before you read the API: what this package assumes about the repo

Per the brief that produced this package, the repository was inspected
for an existing graph model, XOIR, `graph-engine`, `graph-ui`,
runtime, and compiler packages before any code was written. **None of
these exist in this repository.** The only domain data anywhere in the
codebase is a hardcoded five-item `experiences` array (plus a parallel
`lines` array implying edges) inline inside `app/page.tsx` — not
exported, not reusable as a module.

Two consequences follow directly from that:

1. **`source-graph.ts` defines a new contract, not a duplication of
   anything.** `SourceGraph` is the minimal shape this package needs
   from *something* that produces real XO data. It is deliberately the
   seam a future graph-engine/XOIR is expected to satisfy or be
   adapted into — wiring a real source later means writing an adapter
   that returns a `SourceGraph`, not changing this package.
2. **`fixtures/sample-graph.ts` is a faithful, literal mapping of
   `app/page.tsx`'s `experiences`/`lines` arrays** into that contract
   — used only by this package's tests, never imported by or wired
   into the actual page. `app/page.tsx` was not modified.

If a real graph-engine, XOIR, or runtime package is added to this
repository later, the correct integration point is a new adapter
module that reads from it and returns a `SourceGraph` — everything
downstream of `projectWorld()` stays as-is.

---

## Data flow

```
SourceGraph (XOs, relationships, publishers, capabilities,
             workflows, communities — whatever produces this
             today is app-specific test fixtures; tomorrow, a
             real graph-engine/XOIR adapter)
        │
        ▼
projectWorld()                    deterministic projection
        │                         (src/projection.ts)
        ▼
MarketplaceWorld                  resolved XOs, capabilities, workflows,
        │                         communities, relationships, AND a
        │                         computed position for every XO
        │
        ├──▶ MarketplaceNeighborhoods   (near, ecosystemMembers, ...)
        ├──▶ buildMarketplaceSemanticZoom  (what's visible at what depth)
        ├──▶ MarketplaceIntent            (candidates → camera target)
        └──▶ MarketplaceWorldSession      (enter/leave/install, wraps
                                            a generic @xo/atlas Camera)
                    │
                    ▼
        UI consumes camera state, session events, and
        semantic-zoom emergence — this package renders nothing.
```

Nothing downstream of `MarketplaceWorld` ever looks at `SourceGraph`
again — the projection is the one and only place domain data touches
Atlas's coordinate space.

---

## The altitude model

Built directly on `@xo/atlas`'s `AltitudeModel` (`src/altitude.ts`),
using the eight levels already discussed for the interaction
philosophy. Not every level implies UI — each level's `description`
states only what *becomes available to know*, leaving whether/how to
render it entirely to the consumer:

| Order | id | What becomes available |
|---|---|---|
| 0 | `ecosystem` | Aggregate shape only — communities as clusters. |
| 1 | `community` | Communities distinguishable; member XOs start to resolve. |
| 2 | `experience` | An XO's identity, current signal, and relationships. |
| 3 | `capability` | What the XO can do. |
| 4 | `workflow` | How it carries out its capabilities. |
| 5 | `reasoning` | How it currently approaches a task. *No runtime exists yet to populate this with real data.* |
| 6 | `memory` | What it currently holds in memory. *Same caveat.* |
| 7 | `execution` | Live, in-progress work. *Requires a runtime this repo doesn't have.* |

Levels 5–7 are defined so the model is complete and so
`SemanticZoomRegistry` rules exist for them, but they're explicitly
documented as provisional — there's nothing in this repository yet to
back them with real data.

---

## The spatial positioning algorithm

**Requirement: position must emerge from relationships, never a random
scatter or a category grid — with a stable, explainable fallback.**

`src/internal/layout.ts` implements a small, dependency-free,
deterministic force-directed layout:

1. **Deterministic initial placement.** Every XO starts at a point on
   a ring, derived from an FNV-1a hash of its id
   (`src/internal/hash.ts`) — never `Math.random()`. This is also the
   fallback position for an XO with zero relationships: openly
   derived from its id, stable across runs, and easy to explain
   ("your position starts from your id, then relationships pull you
   from there").
2. **Relaxation.** A fixed number of iterations (300 by default) of
   classic force-directed layout: every pair of XOs repels, every
   relationship attracts its two endpoints toward a rest length,
   scaled by that relationship's weight. All forces for a step are
   computed into a delta map from the *current* positions and applied
   simultaneously at the end of the step — so JS iteration/object-key
   order can never influence the result, only the (already
   deterministic) physics and a fixed, explicit sort by id.
3. **Normalization.** Final positions are min-max scaled into the
   configured area (default 100×100, matching the percentage
   coordinates already used in `app/page.tsx`) with a small margin.

**Relationships come from two sources**, both handled in
`src/projection.ts`:

- **Explicit** — whatever the `SourceGraph` states directly
  (`relationships: [...]`), typically `dependsOn`.
- **Implicit, derived from structure already on the graph** — two XOs
  that share a capability id, share a workflow id, or belong to the
  same declared community automatically get an implicit relationship
  (`sharesCapability`, `workflowLink`, `communityLink` respectively).
  This is what makes "shared capabilities" and "ecosystem/community
  relationships" affect layout even when nobody declared an explicit
  edge for them.

Each relationship kind has a default weight (`dependsOn` pulls
hardest, `communityLink` softest) so different *kinds* of connection
read as different strengths of spatial pull, not just presence/absence
of a line.

**Determinism is tested directly**: the same `SourceGraph`, even with
its arrays in a different order, produces byte-identical serialized
output (`tests/determinism.test.ts`).

---

## What's implemented, by requirement

- **World model** (`src/types.ts`) — `XOEntity`, `Capability`,
  `Workflow`, `Relationship`, `Publisher`, `Community`, `InstallState`,
  `MarketplaceMetadata`, all domain-neutral enough to not assume a
  marketplace is the only consumer.
- **Projection** (`src/projection.ts`) — deterministic
  `SourceGraph → MarketplaceWorld`, described above.
- **Altitude model** (`src/altitude.ts`) — described above.
- **Semantic emergence** (`src/semantic.ts`) — one
  `SemanticZoomRegistry` rule per (XO, field) pair, reusing Atlas's
  registry directly rather than a second visibility system. Fields:
  `identity` (appears 0→2), `capabilities` (2→3), `workflows` (3→4),
  `reasoning` (4→5), `memory` (5→6), `execution` (6→7).
- **Intent → world** (`src/intent.ts`) — `MarketplaceIntent` wraps
  Atlas's `IntentFocus`; the consumer supplies already-resolved
  `{ xoId, score }` candidates. No language resolution happens in this
  package.
- **Neighborhoods** (`src/neighborhoods.ts`) — `near()`,
  `within()`, `ecosystemMembers()`, `capabilitiesSurrounding()`,
  `relatedWorkflows()`, `nearestTo()` — all built on Atlas's
  `NeighborhoodEngine`, adding only vocabulary.
- **Enter/install semantics** (`src/session.ts`) —
  `MarketplaceWorldSession` wraps a generic `@xo/atlas` `Camera`.
  `enterXO()` calls the camera's generic `enter()` and emits an
  `xo:entered` domain event; install state is a validated state
  machine (`available → installing → installed → available`, etc.)
  entirely local to this package. Atlas's `Camera` never sees install
  state.
- **Serialization** (`src/serialization.ts`) — `serializeWorld()` /
  `deserializeWorld()`, JSON-safe (optional fields are omitted rather
  than set to `undefined`, which JSON would silently drop), sorted so
  output is deterministic across calls.

## What isn't here, deliberately

- No mock marketplace, card grid, catalog, or visualization of any
  kind — this is the world model the real UI will consume, not a
  preview of it.
- No modification to `app/page.tsx` or anything under `app/`,
  `components/`, or `lib/`.
- No LLM or search implementation — `MarketplaceIntent` only accepts
  already-resolved candidates.
- No real `Workflow`/reasoning/memory/execution structure — there's
  nothing in the repository yet to model those against honestly, so
  they're kept minimal rather than guessed at.

---

## Local dependency wiring (temporary, until a real workspace exists)

This repository isn't currently a pnpm/npm workspace (no
`pnpm-workspace.yaml`, no `workspaces` field in the root
`package.json`). `package.json` here declares
`"@xo/atlas": "workspace:*"` as the intended dependency, but nothing
in this change modifies the root package.json to wire that up — per
the brief's instruction to avoid modifying existing packages unless
necessary.

For this package to actually build and test today, a `node_modules/@xo/atlas`
symlink pointing at `../../atlas` was created **locally inside this
package's own directory** (`packages/marketplace-world/node_modules/`,
gitignored) — the same resolution result a real workspace tool would
produce, without touching anything outside `packages/marketplace-world`.
Once a real `pnpm-workspace.yaml` is added, that manual symlink becomes
redundant and can simply be deleted; `pnpm install` will replace it
with its own.

**Build order matters until then:** `@xo/atlas` must be built
(`npm run build` inside `packages/atlas`) before this package's build
or tests will resolve its types/`dist` output.

---

## Development

```bash
# from packages/atlas — build the dependency first
npm run build

# from packages/marketplace-world
npm run build   # type-check and emit dist/
npm test        # type-check src + tests + fixtures, run via node:test
```

40 tests across 8 suites: projection, determinism, altitude, semantic
zoom, neighborhoods, intent, session (enter/leave/install), and
serialization — including an explicit "unchanged source graph produces
identical world state" regression test.

---

## What's still required before graph-ui can render the real marketplace world

- **A real source of XO/graph data.** Nothing produces a `SourceGraph`
  today except the test fixture. The next real step is either a
  graph-engine/XOIR package that this repo doesn't have yet, or a
  hand-written adapter over whatever does hold real XO data, that
  returns a `SourceGraph`.
- **A real workspace.** `pnpm-workspace.yaml` (or equivalent) so
  `@xo/atlas` and `@xo/marketplace-world` resolve normally instead of
  via the manual symlink described above.
- **A UI binding for `@xo/atlas`'s `Camera`.** Nothing in this
  package or Atlas renders anything — a React (or other) binding that
  calls `camera.tick()` per frame and reads `camera.position` /
  `camera.altitude` doesn't exist yet.
- **Real content for the deepest altitude levels.** `reasoning`,
  `memory`, and `execution` have semantic-zoom rules and altitude
  levels defined, but nothing produces real values for them without a
  runtime.
