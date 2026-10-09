# XOIR — Experience Object Intermediate Representation

XOIR is **the single canonical semantic representation of a compiled
Experience Object.** Think of it the way you'd think of LLVM IR: every
compiler frontend/extraction stage compiles *into* XOIR, every
optimization/analysis pass transforms XOIR, every XO package is generated
*from* XOIR, and every runtime ultimately consumes data produced from
XOIR. Stage-specific extraction models (Stage 4's `KnowledgeGraph`, Stage
5's `CapabilityGraph`, both in `@xo/compiler`) are useful
*extraction-domain* models, not competing canonical representations —
they convert into XOIR through an explicit boundary (see "Stage 4/5
mapping" below), and nothing downstream of that boundary should ever
target anything other than XOIR.

Nothing in this package depends on the Compiler, Runtime, or Registry —
it depends only on this repo's foundation packages (`@xo/types`,
`@xo/errors`, `@xo/crypto`, `@xo/serialization`, `@xo/logger`), the same
dependency direction every other foundation package in this monorepo
follows. `@xo/compiler` depends on `@xo/xoir`, never the other way
around — this package must remain a foundation package with zero
knowledge of any specific frontend.

## Design philosophy

- **A typed property graph, not a generic object tree.** Every entity is a
  node; every relationship is a typed edge. There is no
  `Record<string, unknown>` escape hatch for "I don't know what this is
  yet" — a frontend that needs a new kind of node mints a `custom:<name>`
  kind (see below) rather than reaching for an untyped blob.
- **Immutable values, mutable container.** A `XoirNode`/`XoirEdge` is a
  frozen-by-convention value: every field is `readonly`, and nothing in
  this package mutates one in place. `XoirGraph` itself is a mutable
  *builder* — nodes and edges are added/removed incrementally as a
  compiler frontend or pass runs — the same split LLVM draws between an
  immutable `Instruction` and a mutable `BasicBlock`/`Module`.
- **Content-addressable identity.** Every node and edge carries a
  `hash` — a SHA-256 digest over its own canonically-serialized content
  (see §13). A whole graph's hash is a Merkle root over every node/edge
  hash. Change any property, and the hash changes predictably; keep the
  content identical, and the hash is stable no matter what order things
  were inserted in.
- **Fail loud on the unexpected, not silently.** Structural problems
  (duplicate ids, dangling edge references, an unsupported schema
  version) surface as a `Result` error or a `ValidationReport` issue —
  never a silent best-effort guess. The one deliberate exception is
  cycles — see §8.
- **`unknown` is preferable to fabricated certainty.** Every field this
  package or an adapter cannot honestly determine from source material —
  a capability's determinism, a confidence's evidentiary basis — has an
  explicit `'unknown'` value, never a guessed default presented as fact.

## 1. Purpose

XOIR exists so that N extraction frontends (a PDF adapter, a Git-history
adapter, a future Slack adapter, ...) and M downstream consumers
(optimization passes, the Linker, Benchmark Synthesis, the Packager) meet
at one typed, versioned, content-addressed graph instead of needing
N×M bespoke translations. It represents *the semantics of compiled
expertise* — what a professional knows, how they decide, where they've
been wrong before — never package/registry/marketplace metadata (§16,
§18) and never live runtime state (§17).

## 2. Canonical node taxonomy

Every node (`XoirNode<K, P>` in `node-kinds.ts`) has `id`, `kind`,
`properties` (typed, kind-specific), `version`, `hash`, and a `metadata`
envelope (§5–6).

The **canonical** semantic node kinds — each answering "what semantic
role does this piece of expertise play?" — are:

| Kind | Represents |
|---|---|
| `concept` | A domain entity or term |
| `fact` | A stated, source-grounded claim |
| `heuristic` | A rule of thumb, with exception conditions |
| `decision_node` | One branch point in a decision graph |
| `reasoning_step` | One step in an ordered reasoning chain |
| `preference` | A stable stylistic/communication choice |
| `risk_policy` | A risk-tolerance rule |
| `escalation_rule` | When to defer to a human or another capability |
| `failure_case` | A known bad outcome and its cause |
| `success_pattern` | A known good outcome and what produced it |
| `capability` | A named, invokable unit of skill (absorbs the full `CapabilitySignature` — §4) |
| `constraint` | A hard limit a capability must respect |
| `safety_policy` | A rule the compiled XO must never violate |
| `memory_unit` | A durable fact/episode for the runtime's memory graph |
| `evaluation_artifact` | A test case or benchmark item derived from evidence |

`capability`, `constraint`, and `safety_policy` predate the taxonomy
reconciliation and needed no rename — they were already exactly what a
canonical kind should be.

This list is not closed: canonical kinds, legacy kinds (§3), and
`custom:<name>` kinds together form `XoirNodeKind`, and every core
operation (hashing, serialization, visiting, most of validation) works
structurally rather than switching exhaustively over every known kind.

## 3. Legacy kinds and migration

Pre-reconciliation, XOIR had a flatter kind list that mixed semantic
roles with package-layer concerns: `knowledge`, `reasoning`, `decision`,
`memory`, `evaluation`, `benchmark`, `prompt_strategy`, `case_study`,
`metadata`, `provenance`, `license`, `identity`, `version` (plus
`capability`/`constraint`/`safety_policy`, already canonical). These are
**not deleted** — they remain valid, loadable, and structurally-validated
`LegacyXoirNodeKind`s indefinitely, so no previously-serialized graph is
stranded. `LEGACY_NODE_KIND_MIGRATION` (`node-kinds.ts`) is the explicit,
documented mapping a pass uses to upgrade one:

| Legacy kind | Canonical target |
|---|---|
| `reasoning` | `reasoning_step` |
| `decision` | `decision_node` |
| `memory` | `memory_unit` |
| `evaluation` | `evaluation_artifact` |
| `benchmark` | `evaluation_artifact` |
| `knowledge` | *(ambiguous — content-dependent: `concept`/`fact`/`heuristic`)* |
| `case_study` | *(ambiguous — content-dependent: `failure_case`/`success_pattern`/`evaluation_artifact`)* |
| `prompt_strategy` | *(not a semantic node — derive from `reasoning_step`/`preference` subgraphs at packaging time)* |
| `metadata`, `provenance`, `license`, `identity`, `version` | *(not semantic nodes — package/manifest/registry layer; see §16–18)* |

New code should always mint canonical kinds. `migrateLegacyNodeKind(kind)`
returns `undefined` for the ambiguous/package-layer cases rather than
guessing — a caller migrating one of those must inspect the node's own
`properties`/`metadata.subtype`.

## 4. The kind/subtype split, and Capability's absorbed signature

`kind` is the semantic-role axis (§2); `metadata.subtype` (§5) is the
domain/entity classification *within* that role — e.g. `kind: 'concept',
subtype: 'organization'` or `kind: 'fact', subtype: 'metric'`. XOIR's
core operations never switch on `subtype`; it is a free-form string, not
a second closed enum, because domain classification is a profession
concern XOIR itself is agnostic to.

`capability` absorbs Stage 5's full `CapabilitySignature`:
`CapabilityNodeProps` carries `name`, `description`, `category`,
`inputs`/`outputs`, `sideEffects`, `requiredResources`, `determinism`
(`'deterministic' | 'non_deterministic' | 'unknown'`), `idempotent`
(`boolean | 'unknown'`), `executionMode` (`'sync' | 'async' |
'unknown'`), `estimatedCost` (`'low' | 'medium' | 'high' | 'unknown'`),
`requiredPermissions`, `invocationHints`, and `dependencies`. Every field
an extractor cannot honestly infer is `'unknown'`, never guessed — see
`@xo/compiler`'s capability adapter test for `UNKNOWN_SIGNATURE`'s
round-trip.

## 5. Node metadata, provenance, and confidence

`XoirNodeMetadata` (`node-kinds.ts`): `confidence` (0–1, the always-present
backward-compatible numeric field), `confidenceDetail` (optional — the
canonical confidence model, §6), `sourceRefs` (`XoirSourceRef[]` —
provenance, below), `tags`, `createdAt`/`updatedAt`, `custom` (a free-form
extension bag distinct from `properties`), and `subtype` (§4).

`XoirSourceRef` answers "where did this claim come from": `documentPath`
(the only field required for backward compatibility), plus
`experienceUnitId`, `pages`, `sectionPath`, `charOffsetRange`, and
`sourceConfidence` (that *source's* confidence, distinct from the
node/edge's own overall `confidence`, which may combine several
sources). Provenance is **additive**: when a node is corroborated by
multiple sources, `sourceRefs` carries every one of them — merging is
never allowed to silently overwrite or pick one (see "Merge engine"
below; `mergeGraphs` itself resolves *id* conflicts, it does not
auto-union differently-sourced duplicate claims — an adapter converting
multiple raw sources into one canonical node is expected to union
`sourceRefs` *before* constructing that node, exactly as
`@xo/compiler`'s Stage 4/5 adapters do).

Edges carry the identical `sourceRefs`/`confidence`/`confidenceDetail`
shape (`XoirEdgeMetadata` in `edge-kinds.ts`) — a relationship is itself
an extracted claim ("clause A requires clause B") with its own
provenance, distinct from either endpoint's.

## 6. Confidence model (`confidence.ts`)

A bare `number` says "how sure," not "sure *how*." `XoirConfidence` makes
that explicit: `score` (0–1, mirrored by `metadata.confidence`), `basis`
(`'stated' | 'observed' | 'inferred' | 'hybrid_extraction' |
'expert_provided' | 'unknown'`), `evidenceStrength` (`'weak' | 'moderate'
| 'strong' | 'unknown'` — deliberately coarse, not a second fake-precise
float), `corroboration` (a real count of independent supporting sources),
and `calibrated` (almost always `false` — true only if `score` is an
actually back-tested probability, which nothing in this repo does yet).

`confidenceFromScore(score, overrides?)` is the compatibility bridge every
caller with only a bare number goes through, defaulting everything else
to the conservative "unknown" values (`UNKNOWN_CONFIDENCE_BASIS_DETAIL`).
`scoreOf(confidence)` extracts the numeric score uniformly whether given
a bare number or a full `XoirConfidence`. When both `confidence` and
`confidenceDetail` are supplied to `createNode`/`createEdge`, the explicit
`confidence` wins (documented, not silent); when only `confidenceDetail`
is given, `metadata.confidence` is derived from `confidenceDetail.score`
so the two never disagree.

## 7. Canonical edge taxonomy

`CoreXoirEdgeKind` — relationships that express how expertise *behaves*
(dependency, conflict, derivation, composition): `REQUIRES`,
`CONTRADICTS`, `SUPPORTS`, `REFINES`, `SUPERSEDES`, `ESCALATES_TO`,
`TRIGGERED_BY`, `CO_OCCURS_WITH`, `DERIVED_FROM`, `COMPOSES_INTO`. The
first five predate the reconciliation; the rest are new.

`ExtendedXoirEdgeKind` — domain/structural relationships ("X defines Y",
"X is part of Y"), genuinely useful across the platform but not
expertise-behavior in the core sense: `DEPENDS_ON`, `IMPLEMENTS`,
`REFERENCES`, `VALIDATES`, `USES`, `LINKS_TO`, `INHERITS`,
`GENERATED_BY` (all pre-existing), plus `DEFINES`, `PART_OF`,
`PRODUCES`, `CONSUMES`, `EXTENDS`, `COMPLEMENTS`, `INVOKES`, `ENABLES`,
`CONFLICTS_WITH`, `GOVERNS`, `CAUSES`, `MITIGATES`, `MEASURES`,
`OWNED_BY`, `LOCATED_IN`, `BELONGS_TO`, `VERSION_OF`, `ALTERNATIVE_TO`
(added by Stage 7 — see below) — the direct,
total migration target for Stage 4's `KnownKnowledgeEdgeType` and Stage
5's `KnownCapabilityRelationType` (see `@xo/compiler`'s
`src/xoir/edge-mapping.ts` for the exact 1:1 table). `DEPENDS_ON` is kept
distinct from `REQUIRES`: prefer `REQUIRES` for expertise dependencies,
`DEPENDS_ON` for structural/build-order dependencies — both remain fully
supported. `CONFLICTS_WITH` is deliberately **not** folded into
`CONTRADICTS`: a logical contradiction between two claims and two
capabilities that can't both run in the same session are different
relationships. `ALTERNATIVE_TO` is Stage 7's one genuine taxonomy
addition (reasoning/decision extraction, `@xo/compiler`'s
`src/reasoning/`): "Option A instead of Option B" needs a mutually-
exclusive-choice relationship no existing edge kind covers without a
real semantic stretch — `COMPOSES_INTO`/`COMPLEMENTS` both mean
"combines with" (the opposite), and `CONTRADICTS` is for two claims that
logically disagree, not two options a decision-maker is choosing between
(both can be independently true — only one gets *chosen*). Symmetric by
convention: producers only need to emit one direction.

Both are open-ended via `custom:<name>`, same convention as nodes.

A small, explicit edge/endpoint-kind compatibility table
(`validation.ts#EDGE_ENDPOINT_KIND_CONSTRAINTS`) rejects only genuinely
impossible combinations — e.g. `COMPOSES_INTO` must run
capability→capability (the Linker's composition edge), `ESCALATES_TO`
must terminate at an `escalation_rule` or `capability`. This is
deliberately not a full ontology validator — everything not explicitly
listed is unconstrained by design.

## 8. Cycle semantics

**The whole semantic XOIR graph is not required to be a DAG.**
`A CONTRADICTS B` and `B CONTRADICTS A` are both individually legitimate
— `validateGraph` never treats a cycle as a structural error, and
`hasCycle()` is purely informational. `topologicalOrder(edgeKinds?)`
fails cleanly with `XOIR_CYCLE_DETECTED` — never a silent partial order —
whenever the *selected* edges aren't acyclic. A pass that needs a DAG
view of one specific relationship (an execution-dependency graph, a
decision-dependency graph, a compiler-pass-dependency graph) restricts
the walk to just that edge kind: `graph.topologicalOrder(['REQUIRES'])`.
See `test/cycle-semantics.test.ts` for a worked example where a
`REQUIRES`-only projection orders correctly even while the whole graph
(via an unrelated `CONTRADICTS` cycle) is cyclic.

## 9. Identity vs content hash vs graph hash

Three distinct concepts, never conflated:

- **Semantic identity** (`id`) — identifies the conceptual entity (e.g.
  Stage 4/5's deterministic match-key-derived ids, reused verbatim as
  XOIR node ids by the adapters — §14–15).
- **Content hash** (`hash`) — identifies the exact content/version of
  that node/edge (`hashing.ts#hashNode`/`hashEdge`).
- **Graph hash** (`XoirGraph#contentHash()`) — identifies the exact
  compiled graph via a Merkle root over every node/edge hash.

Identical content hashes identically regardless of insertion order;
changing content changes the hash predictably; `createdAt`/`updatedAt`
timestamps and manifest pass-history timestamps never affect any hash
(§11, §13).

## 10. Manifest (`manifest.ts`)

Package/compilation-level bookkeeping, deliberately **kept out of the
semantic node graph** (§16 — "do NOT represent license/identity/version/
provenance as ordinary semantic XOIR nodes"). `XoirManifest`:
`schemaVersion`, `compilerVersion`, `professionTags`,
`sourceManifestRefs`, `passHistory` (`PassHistoryEntry[]`, §11), an
optional cached `graphHash`, and `createdAt`. A `XoirGraph` may
optionally carry a manifest (`XoirGraph.create(id, schemaVersion,
manifest)` / `graph.setManifest(...)`); it round-trips through
`toJson`/`fromJson` additively — absent entirely on graphs that never set
one, exactly like every schema-version-1 graph before this
reconciliation.

## 11. Pass history

`PassHistoryEntry`: `passId`, `passVersion`, `inputHash`, `outputHash`,
`timestamp`, optional `summary`. `appendPassHistory(manifest, entry)`
returns a new manifest value (immutable, same convention as
node/edge/manifest values throughout this package). Pass-history
timestamps are bookkeeping only — like `metadata.updatedAt`, they never
feed into any node/edge/graph content hash.

## 12. Validation (`validation.ts`)

`validateGraph(graph)` never throws — it returns a `ValidationReport`
(`{ valid, issues }`). Checks, expanded by this reconciliation:

- **Structural**: unique node/edge ids (enforced at insertion by
  `XoirGraph`), no dangling edge references, valid/supported schema
  version.
- **Integrity**: node/edge hash matches a fresh recomputation.
- **Confidence**: both `metadata.confidence` and, when present,
  `metadata.confidenceDetail.score` are in `[0, 1]`.
- **Provenance**: every `sourceRef` has a non-empty `documentPath`.
- **Semantic structure**: missing required properties for known node
  kinds (both canonical and legacy — a `custom:*` kind has no
  required-property list, that's the frontend's own contract), and the
  small explicit edge/endpoint-kind compatibility table (§7).

Cycle-checking is never part of `validateGraph` — see §8.

## 13. Serialization and hashing

`toJson`/`fromJson` (`serialization.ts`) define the canonical wire shape:
nodes and edges sorted by `id`, manifest carried additively when present.
`fromJson` checks `schemaVersion` against
`versioning.ts#isSchemaVersionSupported` and fails clearly rather than
guessing at an unknown version's shape.

`canonicalStringify` (`hashing.ts`) is the one function every hash goes
through: object keys sorted, arrays order-preserved (order is meaningful
data), exactly one textual form per value. `hashNode`/`hashEdge` hash
everything about a node/edge *except* its own `hash` field (circular) and
`updatedAt`/`createdAt` bookkeeping timestamps — including, as of this
reconciliation, `subtype` and `confidenceDetail`. `hashGraphContents`
builds a Merkle root over every node/edge hash, sorted first so it's
insertion-order-independent.

## 14. Stage 4 → XOIR mapping (`@xo/compiler`'s `src/xoir/`)

`knowledgeGraphToXoir(graph, options?)` (`knowledge-to-xoir.ts`) converts
a Stage 4 `KnowledgeGraph` losslessly:

- **Identity**: `KnowledgeNode.id`/`KnowledgeEdge.id` reused verbatim.
- **Kind + subtype**: every one of Stage 4's 22
  `KnownKnowledgeNodeType`s maps to a canonical `(kind, subtype)` pair
  via `node-kind-mapping.ts#KNOWLEDGE_NODE_TYPE_TO_CANONICAL_KIND` — e.g.
  `organization`/`technology` → `concept`, `metric`/`event` → `fact`,
  `obligation` → `constraint` — with `semanticType` always preserved
  verbatim as `metadata.subtype`, regardless of which kind it landed on.
- **Provenance**: every `KnowledgeProvenance` → `XoirSourceRef` 1:1
  (`provenance.ts#provenanceToSourceRefs`).
- **Confidence**: the bare number is kept, *and* a full `XoirConfidence`
  is derived with real corroboration (`provenance.length`) and an
  evidence-strength bucket from that count — never a fabricated basis.
- **Edges**: all 21 `KnownKnowledgeEdgeType`s map 1:1 to XOIR edge kinds
  (`edge-mapping.ts`); an edge whose endpoint isn't present in the graph
  is skipped, not a hard failure.

## 15. Stage 5 → XOIR mapping

`capabilityGraphToXoir(graph, options?)` (`capability-to-xoir.ts`)
converts a Stage 5 `CapabilityGraph` losslessly:

- **Identity + the "Send Email" convergence**: `Capability.id` is reused
  verbatim. Stage 5's own `computeCapabilityId` (word-stemming +
  synonym-folding match key) already merges "Send Email" / "Email
  Sending" / "Mail Sender" into one `Capability` with three aliases
  *before* this adapter ever runs — converting that one already-merged
  `Capability` yields exactly one XOIR `capability` node, with all three
  surface forms retained in `properties.aliases`. See
  `@xo/compiler`'s `test/xoir/capability-to-xoir.test.ts`'s worked
  example.
- **The full `CapabilitySignature`**: every field, including `'unknown'`
  values verbatim (§4).
- **Dependencies**: `Capability.dependencies` becomes both a
  `properties.dependencies` mirror and real `REQUIRES` edges (built in a
  second pass so declaration order doesn't matter).
- **Required knowledge**: `Capability.requiredKnowledgeNodeIds` becomes
  `REQUIRES` edges to the corresponding Stage-4-derived nodes *when*
  converting into a graph that already has them (`options.into` — see
  "Combining Stage 4 and Stage 5 output" below); silently skipped
  otherwise, same policy as Stage 4's edge handling.
- **Relationships**: all 9 `KnownCapabilityRelationType`s map 1:1
  (`edge-mapping.ts`), with `conflicts_with` → `CONFLICTS_WITH` kept
  distinct from `CONTRADICTS` (§7).
- **Provenance/confidence**: identical treatment to Stage 4 — genuinely
  shared code (`provenance.ts`), since Stage 5 reuses Stage 4's
  `KnowledgeProvenance` shape verbatim.

**Combining Stage 4 and Stage 5 output**: pass the `XoirGraph` a prior
`knowledgeGraphToXoir(...)` call produced as
`capabilityGraphToXoir(cGraph, { into: thatGraph })`'s `into` option to
get one combined graph where `Capability → Concept/Fact/...` `REQUIRES`
edges actually resolve.

## 16. XOIR vs XO Package

XOIR is the canonical **semantic compiler representation** — sufficient
to *generate* an XO package (each `manifest.json`/`knowledge/graph.json`/
`reasoning/*`/`safety/rules.json`/etc. component is a projection of some
typed view over the graph), but it does not itself absorb every package
concern: licensing terms, publisher identity, marketplace listing state,
and signing all live at the package/registry layer, never as XOIR nodes.

## 17. XOIR vs Runtime

XOIR describes what a capability requires, what it can produce, how it
behaves (statically) — never live execution state. Current
execution/workflow instances, checkpoints, runtime memory state, the
current process, secrets, tokens, or machine-specific state all belong to
the Runtime, never to `@xo/xoir`. This package has no dependency on any
runtime package, and none should ever be added.

## 18. XOIR vs Registry/Marketplace

Marketplace listing state, seller accounts, royalty settlement, current
price, download counts, ratings, and registry availability are Registry/
Marketplace concerns, never semantic XOIR nodes. XOIR may carry
provenance/identity information necessary to establish authorship or
compilation history (via `sourceRefs`/the manifest's `compilerVersion`),
but that is evidentiary metadata, not marketplace state.

## 19. Migration/compatibility summary

- **Additive, not breaking.** Every change in this reconciliation is
  additive: new canonical kinds/edges alongside preserved legacy ones,
  new optional metadata fields (`confidenceDetail`, `subtype`,
  `sourceRefs` on edges), a new optional `manifest`. `XOIR_SCHEMA_VERSION`
  was **not** bumped — nothing here breaks a schema-version-1
  deserializer, per this repo's own EIR versioning rule that MINOR/
  additive changes don't require a MAJOR bump.
- **Nothing is silently deleted.** Every legacy node kind remains valid
  and validated; `LEGACY_NODE_KIND_MIGRATION` documents where each one
  goes, including the package-layer kinds (`metadata`/`provenance`/
  `license`/`identity`/`version`) that leave semantic XOIR entirely in
  favor of the manifest/registry layers.
- **Full backward compatibility for the numeric confidence accessor.**
  `metadata.confidence` remains the single, always-present numeric field
  every existing caller already uses; `confidenceDetail` is additive.

## Graph API (`graph.ts`)

`XoirGraph` provides: `createAndAddNode`/`addNode`, `removeNode`
(cascades to touching edges), `getNode`/`hasNode`/`allNodes`,
`createAndAddEdge`/`addEdge`, `removeEdge`, `getEdge`/`allEdges`,
`neighbors` (direction + edge-kind filterable), `dependenciesOf`,
`subgraph` (induced-subgraph extraction), `hasCycle`, `topologicalOrder`
(optionally restricted to specific edge kinds — see §8), `stats` (counts
by kind), `manifest`/`setManifest` (§10), and `contentHash`.

## Query engine (`query.ts`)

A purely in-memory engine: `filterNodes`/`filterEdges` (by kind, tag,
confidence, or a custom predicate), `nodesOfKind`/`byTag`/
`relationshipsOfKind` convenience wrappers, and `findPath` (breadth-first,
optionally restricted to one edge kind, with a `maxDepth`).

## Diff engine (`diff.ts`)

`diffGraphs(before, after)` is an **identity-preserving** diff, keyed by
`id`: a node whose `id` is present in both graphs but whose `hash`
differs is "modified" (with a property-level `propertyChanges` list), not
"removed then added." Two different-id nodes with identical content are
never matched to each other — that's `merge.ts`'s concern, not diff's.

## Merge engine (`merge.ts`)

`mergeGraphs(graphs, newGraphId, strategy)` unions multiple graphs,
preserving identity by `id`. Two nodes sharing an id with identical
content merge silently; two nodes sharing an id with *different* content
are a reported conflict, resolved per `strategy` (`prefer_first` /
`prefer_last` / `prefer_higher_confidence` (default) /
`error_on_conflict`), always reported in `MergeResult.conflicts`
regardless of which strategy resolved it. `mergeGraphs` does not union
provenance across differently-sourced duplicate claims on its own — an
adapter combining multiple raw sources into one canonical node (§14, §15)
is expected to union `sourceRefs` *before* constructing that node.

## Visitor / Pass frameworks

Unchanged by this reconciliation — see `visitor.ts` (`GraphVisitor`,
`traverseGraph`) and `pass.ts` (`Pass`, `PassContext`, `PassManager`).
This package implements no optimization passes, only the infrastructure
future ones plug into.

## Versioning (`versioning.ts`)

Two distinct version concepts, kept separate on purpose:
`XOIR_SCHEMA_VERSION` (the shape of the serialized envelope itself —
bump on a structural break, unaffected by this reconciliation) and
`NodeVersion` (a per-node revision counter, independent of schema
version).

## Example

```ts
import {
  XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId,
  validateGraph, confidenceFromScore, createManifest,
} from '@xo/xoir';

const graph = XoirGraph.create(
  XoirGraphId('nda-lawyer-v1'),
  1,
  createManifest({ schemaVersion: 1, professionTags: ['corporate-law'] }),
);

graph.createAndAddNode({
  id: XoirNodeId('cap-draft-nda'),
  kind: 'capability',
  properties: { name: 'Draft NDA', description: 'Drafts a mutual NDA' },
});
graph.createAndAddNode({
  id: XoirNodeId('f-nda-duration'),
  kind: 'fact',
  subtype: 'metric',
  properties: { statement: 'NDAs typically run 2-5 years', domain: 'contract-law' },
  confidenceDetail: confidenceFromScore(0.9, { basis: 'stated', evidenceStrength: 'strong', corroboration: 3 }),
});
graph.createAndAddEdge({
  id: XoirEdgeId('e1'),
  kind: 'REQUIRES',
  fromId: XoirNodeId('cap-draft-nda'),
  toId: XoirNodeId('f-nda-duration'),
});

const report = validateGraph(graph); // { valid: true, issues: [] }
console.log(graph.contentHash());    // sha256:...
```

## Extension points for future modules

- **New node/edge kinds**: add a known kind to `node-kinds.ts`/
  `edge-kinds.ts` (additive, non-breaking), or use `custom:<name>`
  immediately without touching this package at all.
- **Real optimization passes**: implement `Pass` from `pass.ts`,
  register with a `PassManager`. Nothing here needs to change.
- **A Neo4j-backed query engine**: implement the same function
  signatures in `query.ts` against a real graph database.
- **A real ontology-level semantic validator**: `validation.ts`'s
  edge/endpoint-kind table is deliberately small and explicit today
  (§7/§12) — a future pass could grow it, or replace it with something
  more systematic, without touching the rest of this package.
