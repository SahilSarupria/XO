# @xo/compiler — Experience Compiler Frontend

The first real implementation of an Experience Compiler frontend:
**PDF → Corporate Contract Lawyer XOIR graph.** This package implements
`@xo/compiler-core`'s `Compiler` interface (Module 1) and produces
`@xo/xoir` graphs (Module 2) — it does not optimize, package, benchmark,
or talk to a runtime. Per the pipeline this module was scoped to:

```
PDF → Plain text → Structured sections → Semantic chunks →
Legal entities → Concepts → Capabilities → Knowledge →
Reasoning → Decisions → Constraints → XOIR Graph
```

## Status

| Stage | Responsibility | Status |
|---|---|---|
| 1. PDF Loader | PDF → plain text + provenance | **Implemented** (`src/pdf/`) |
| 2. Document Parser | headings/sections/lists/tables/hierarchy | **Implemented** (`src/document/`) — table detection is conservative/single-line-cell only, see "Known limitations" |
| 3. Semantic Chunker | idea-sized chunks with provenance | **Implemented** (`src/semantic/`) — see "Known limitations" |
| 4. Experience Knowledge Extractor | typed Knowledge Graph (concepts, entities, obligations, ...) | **Implemented** (`src/knowledge/`) — supersedes the original separate "Legal Entity Extractor" stage; see "Pipeline note," below |
| 5. Capability Extractor | professional capabilities demonstrated | **Implemented** (`src/capabilities/`) — see "Known limitations" |
| 6. Reasoning Extractor *(original numbering)* | decision logic, tradeoffs, heuristics | **Implemented** — see `src/reasoning/`, folded into "XOIR-First Compilation Pipeline Integration → Stage 7" below |
| 7. Decision Graph Generator *(original numbering)* | decision/branch/escalation nodes | **Implemented** — see `src/reasoning/`, same section |
| 8. Constraint Extractor *(original numbering)* | jurisdiction/safety/regulatory constraints | **Implemented** — see `src/reasoning/`, same section |
| 9. XOIR Generator *(original numbering)* | assemble the validated graph | **Implemented** — see "XOIR-First Compilation Pipeline Integration" below (superseded/subsumed by Stage 5.5 + Stage 6, not a separate module) |
| 8 *(new numbering track)*. Multi-Source Frontends | normalize PDF/document/image/HTML/structured input into one shared pipeline entry point | **Implemented** (`src/sources/`, `src/pipeline/compile-sources.ts`) — PDF and Document/HTML/Structured are fully supported end-to-end; Image is extensibility-only (no OCR/vision in this repo) — see "Stage 8," below |

**Roadmap numbering, resolved:** the table above is the *original*
per-extractor plan, written before XOIR existed as a canonical
representation. Two independently-numbered, cross-cutting stages were
built on top of it afterward and use their own numbering:

```text
Stage 5.5 = XOIR Reconciliation
Stage 6   = XOIR-First Compilation Pipeline Integration
Stage 7   = Reasoning & Decision Extraction  (src/reasoning/)
```

Current status of this numbering track:

```text
Stage 1   PDF ingestion                        COMPLETE
Stage 2   Document parsing                      COMPLETE
Stage 3   Semantic chunking                      COMPLETE
Stage 4   Knowledge extraction                    COMPLETE
Stage 5   Capability extraction                    COMPLETE
Stage 5.5 XOIR reconciliation                       COMPLETE
Stage 6   XOIR-first pipeline integration            COMPLETE
Stage 7   Reasoning & decision extraction             COMPLETE
          (including semantic reasoning validation —
          see "Semantic reasoning validation" below)
Stage 8   Multi-source frontends & source              COMPLETE
          normalization (src/sources/) — see
          "Stage 8," below
```

`Stage 7` (this numbering) is what actually implements the original
table's Stage 6/7/8 responsibilities (reasoning, decisions, constraints)
— as one module, through XOIR, rather than three separate ones — and
Stage 6 subsumed the original table's Stage 9 (XOIR Generator: there is
no separate "generator" step, because every extractor converts directly
into canonical XOIR via an explicit adapter — see
`src/xoir/reasoning-to-xoir.ts`, `knowledge-to-xoir.ts`,
`capability-to-xoir.ts`). Historical Stage 1-6 implementation is
unchanged by this; only the table's status column and this note are new.

**Pipeline note:** the original 10-stage plan had a separate "Legal Entity
Extractor" stage before knowledge extraction. That was superseded before
Stage 4 was built: entity extraction is not a distinct pipeline stage —
`entity`/`organization` are two node types among the many a
`KnowledgeGraph` node can be (see "Stage 4," below), extracted in the same
pass as everything else. Nothing about Stages 1-3 changed; this is a
refinement of the stage list from 4 onward, made explicit here rather
than left as a silent inconsistency with the table above.

This README is updated as each stage lands.

**Cross-cutting architectural work, outside this table's numbering:**
XOIR Reconciliation, XOIR-First Compilation Pipeline Integration, and
Reasoning & Decision Extraction (`src/xoir/`, `src/pipeline/`,
`src/reasoning/`) — see "Roadmap numbering, resolved" immediately below,
and the two sections of these names after Stage 5.

## Stage 1: PDF Loader (`src/pdf/`)

### Why a hand-written parser instead of a library

This package takes **zero external runtime dependencies** for PDF
parsing — everything is built on Node's built-in `zlib` (for
`FlateDecode`, the near-universal stream compression filter) and `Buffer`.
This is a deliberate architectural choice, not a limitation worked around:
a production compiler frontend that will eventually ship as open
infrastructure shouldn't carry an opaque, version-pinned third-party PDF
library as its foundation for parsing untrusted binary input — the parser
here is fully auditable, and every module is small and independently
testable (see `test/pdf/`).

### Architecture

```
lexer.ts           byte-level tokenizer (numbers, names, strings, delimiters, keywords)
object-parser.ts   recursive-descent parser: tokens -> PdfValue tree (dict/array/stream/ref/scalar)
types.ts           the PdfValue object model (types.ts)
filters.ts         stream filter decoding (FlateDecode via node:zlib)
xref.ts            classic xref table + trailer parsing, /Prev chain support
rebuild-xref.ts     fallback: full-file "<n> <g> obj" scan when xref parsing fails
text-decoder.ts    PDF "text string" decoding (Info dict metadata: UTF-16BE or Latin-1)
content-stream.ts  content-stream operator interpreter -> positioned TextRun[]
text-runs-to-plain-text.ts   TextRun[] -> a page's flattened plain text
document.ts        PdfDocument: reference resolution + page-tree walk with inherited attributes
pdf-loader.ts       public API: NodePdfLoader implements PdfLoader
```

Each module is intentionally narrow: `lexer.ts` knows nothing about PDF's
object grammar, `object-parser.ts` knows nothing about xref tables,
`xref.ts` knows nothing about content streams. `content-stream.ts` reuses
the same `Lexer` as `object-parser.ts` — a content stream's operand
syntax (numbers, strings, names, arrays) is identical to an object's; only
the operators differ.

### What Stage 1 actually does

- Parses the classic (non-cross-reference-stream) PDF file structure:
  header, indirect objects, xref table + trailer, with `/Prev`-chain
  support for incrementally-updated files.
- Falls back to a full-file `<n> <g> obj` scan (real byte-search
  recovery, not a heuristic guess) when the xref table is missing,
  malformed, or points at garbage — the same class of recovery real-world
  PDF readers perform on damaged files.
- Decodes `FlateDecode`-compressed streams via `node:zlib`. Any other
  filter (`LZWDecode`, `ASCII85Decode`, `DCTDecode`, ...) raises
  `PDF_UNSUPPORTED_FEATURE` explicitly rather than silently producing
  wrong bytes.
- Walks the page tree (`/Root/Pages/Kids`) with correct attribute
  inheritance (`/Resources`, `/MediaBox`, `/Rotate`), in the PDF's own
  page order — deterministic, no traversal-order ambiguity.
- Recovers a stream's byte length by scanning for `endstream` when its
  declared `/Length` is wrong or an unresolvable indirect reference —
  real-world PDF writers occasionally get this wrong, and refusing to
  read the file over it would be a worse failure mode than recovering.
- Interprets content-stream text-showing operators (`Tj`, `TJ`, `'`,
  `"`, plus `Tf`/`Td`/`TD`/`Tm`/`T*`/`TL` for font/position tracking) into
  positioned `TextRun`s, then flattens those into a page's plain text.
- Extracts `/Info` dictionary metadata (Title, Author, Subject, Creator,
  Producer, CreationDate, ModDate), decoding PDF "text strings" per the
  spec's two-case rule (UTF-16BE with a BOM, or Latin-1/PDFDocEncoding
  otherwise).
- Flags a page `requiresOcr: true` when it has no extractable text at
  all, or a full-page image XObject with only trace amounts of text —
  this compiler frontend does not itself perform OCR; a page flagged this
  way is a signal for a future stage/tool to handle, not silently dropped.
- Fully deterministic: no wall-clock reads, no random ids; running the
  loader twice on identical bytes produces byte-for-byte identical output
  (see `pdf-loader.test.ts`'s determinism test).
- Every error path returns a `Result<LoadedPdfDocument, PdfError>` — a
  malformed or unsupported PDF is a `Result` error, never an uncaught
  throw, at this module's public boundary.

### Known limitations (real, not hidden)

- **No cross-reference *streams*** (PDF 1.5+'s alternative to the classic
  xref table, itself a compressed object stream). Most PDFs produced by
  common consumer tools (word processors, "Print to PDF") still use the
  classic table; PDFs from some newer/incremental-save-heavy toolchains
  may not parse until this is added.
- **No font encoding / `ToUnicode` CMap / CID font support.** Text bytes
  are decoded as raw Latin-1 (`text-runs-to-plain-text.ts`'s
  `decodeRunText`). This is correct for the common case (simple,
  non-embedded fonts with standard encodings) and **wrong** for PDFs
  using embedded CID-keyed fonts with custom byte-to-glyph mappings —
  those will decode to garbled text rather than throwing, which is the
  most important open correctness gap before this loader should be
  trusted on an arbitrary real-world legal PDF corpus.
- **No text-rendering-matrix composition.** `content-stream.ts` tracks
  the text line matrix's translation (`Td`/`TD`/`Tm`/`T*`) but not
  character/word spacing, horizontal scaling, or an enclosing `cm`'s
  effect on position. Reading order and line grouping are unaffected;
  sub-pixel-accurate glyph coordinates are not available.
- **No encrypted-PDF support.** An encrypted PDF (any `/Encrypt` entry in
  the trailer) is rejected with `PDF_ENCRYPTED` rather than attempting
  decryption.
- **No inter-run space inference.** Two separate `Tj`/`TJ` calls on the
  same line are concatenated with no inserted space unless the source
  PDF's own string content already contains one (see
  `text-runs-to-plain-text.ts`'s doc comment for why this is the more
  correct default, not just an easier one).

None of the above are silent — each surfaces either as a thrown/returned
`PdfError` (unsupported filter, cross-reference stream, encryption) or is
explicitly documented as a fidelity gap (encoding, positioning) rather
than asserted to be solved.

## Stage 2: Document Parser (`src/document/`)

Turns Stage 1's positioned `TextRun`s into a structural document tree —
headings, paragraphs, list items, and footnotes, nested into sections by
heading level — using only structural signals (font size relative to an
adaptively-computed body size, position on the page, a leading list
marker), never semantic understanding of the content.

```
line-grouper.ts       TextRun[] -> reading-order Line[] (grouped by y, sorted left-to-right)
font-stats.ts         adaptive body-font-size + heading-size-level detection
list-marker.ts        manual (non-regex) leading list-marker detection
block-classifier.ts   Line -> heading/paragraph/list_item/footnote, by structural signal
block-builder.ts      classified lines -> DocumentBlock[] (merges wrapped paragraph lines)
section-builder.ts    flat DocumentBlock[] -> nested DocumentSection tree, by heading level
document-parser.ts    public API: parseDocument(LoadedPdfDocument) -> ParsedDocument
```

**Known limitations:**
- **Table detection is conservative, single-line-cell only.** `block-
  builder.ts`'s `detectTableRowLines` (P0.9A area C) identifies genuine
  tables using repeated multi-column line alignment (`>=3` columns,
  `>=3` consecutive lines, matching x-positions) — validated against real
  fixtures with zero false positives on pure-prose documents and correct
  detection of `burglary-policy.pdf`'s Sum-Insured and premium-calculation
  tables. It deliberately does not attempt a table whose cells wrap across
  multiple physical lines (confirmed present in that same fixture's
  contact-details grid) — that case is left as ordinary paragraph text
  rather than guessed at, per this milestone's "quarantine over
  speculative interpretation" principle. Detected rows are represented as
  `TableRowBlock`s and quarantined from knowledge/capability extraction
  (`hybrid-extractor.ts` in both `knowledge/` and `capabilities/`) rather
  than being discarded — they remain part of `ExperienceDocument` for a
  future table-semantic adapter to process explicitly.
- **Paragraph-break detection is a font-size-relative heuristic**
  (`block-builder.ts`'s `PARAGRAPH_BREAK_GAP_MULTIPLIER`), not derived
  from the document's actual line-spacing statistics — works for typical
  single-spaced body text, may mis-merge or mis-split on unusual leading.
- **Footnote detection is purely positional** (bottom ~10% of the page,
  smaller-than-body font) — a small-font aside placed mid-page (a
  sidebar, a table caption) would not be distinguished from a footnote.
- **No roman-numeral list markers** ("i.", "iv)") — see `list-marker.ts`.

## Stage 3: Semantic Chunker (`src/semantic/`)

### Philosophy: boundary detection, not text splitting

Stage 3 does not cut a document into fixed-size windows. It walks Stage
2's structural tree and identifies where one coherent professional idea
ends and the next begins, using three kinds of real signal, in order of
priority: **structural certainty** (a list item or a footnote is always
its own idea — enumerated points and asides are never merged with
whatever precedes them), **section hierarchy** (a heading opens a new
idea; nesting depth is preserved), and **shallow rhetorical cues**
(`lexical-cues.ts`'s manual, non-regex word/phrase-boundary matching for
modal obligation language "shall"/"must", permission language "may", exception
markers "unless"/"notwithstanding", example markers "for example"/"such
as", and quoted-defined-term patterns "'X' means..."). A block is merged
into the current unit only when it's a plain paragraph *and* classifies to
the same semantic type as what's already accumulating — a type change
(e.g. an obligation followed by an exception) is treated as a topic
transition, closing the current unit and opening a new one.

These cues generalize past legal documents on purpose: modal/permission/
exception/example rhetoric and definition patterns ("X is/means/refers
to Y") appear across contracts, policies, technical specs, and runbooks
alike — nothing in `lexical-cues.ts` or `semantic-type-classifier.ts` is
legal-domain-specific.

### The ExperienceUnit model (`types.ts`)

A first-class, reusable compiler artifact — not an internal
implementation detail — representing one coherent idea:

| Field | Purpose |
|---|---|
| `id` | Deterministic content hash (`unit-id.ts`) — never random |
| `title` | Borrowed from the owning heading (a section's first unit) or synthesized from its own content |
| `semanticType` | `definition` \| `obligation` \| `right` \| `exception` \| `example` \| `explanatory_note` \| `clause` \| `general`, or `custom:<name>` |
| `content` | The unit's merged text |
| `provenance` | Document path, pages, section heading path, per-source-block page/y-range, and the block-index range within its section (the spec's "paragraph boundaries") |
| `hierarchy` | Depth, `parentUnitId`, and `siblingUnitIds` — see "Hierarchy," below |
| `confidence` | The classification confidence that produced `semanticType` |
| `relationships` | This unit's own outgoing relationships (a view onto the document-level relationship graph — see below) |
| `documentReferences` | Other sections' heading text this unit's content textually mentions |
| `metadata` | Open extension bag (empty by default in this stage) |

Every field here mirrors a design choice already made in `@xo/xoir`
(content-addressable ids, an open `custom:<name>` type union, explicit
confidence) — this stage's output is deliberately shaped like a
precursor to a XOIR node, since Stage 10 will eventually lower
`ExperienceUnit`s (enriched by Stage 4 onward) into exactly that.

### Hierarchy

Each section gets one **anchor unit** — its first unit, which borrows the
section's heading as its title (and, if the section has no body text of
its own, is synthesized from the heading alone, so a heading followed
immediately by subsections is still addressable — see
`unit-builder.ts`'s handling of heading-only sections). Every other unit
in that section points `hierarchy.parentUnitId` at the section's own
anchor; the anchor itself points at its *parent* section's anchor — so
anchors chain up the document's full heading hierarchy, while ordinary
units form a shallow star around their own section's anchor.
`siblingUnitIds` lists every other unit in the same section, in reading
order.

### Relationship graph (`relationship-builder.ts`)

Experience Units know how they relate before Stage 4 ever runs. Four
relationship kinds are computed deterministically, from real structural
or lexical signal:

| Type | Computed from | Confidence |
|---|---|---|
| `extends` | Every unit → its `hierarchy.parentUnitId` (always present when a parent exists) | 0.7 |
| `defines` | A `definition` unit's captured term → every other unit whose content contains that exact term | 0.8 |
| `supports` | An `example` unit → the nearest preceding non-example unit in the same section | 0.75 |
| `references` | Any unit whose content textually mentions another section's heading → that section's anchor unit | 0.6 |

`depends_on`, `contradicts`, `requires`, `implements`, and `explains` are
valid `RelationType`s this stage's model supports (matching the compiler
spec's example list) but does **not** itself populate — manufacturing
those from font size, position, and shallow lexical cues alone would be
overreach past what this stage can actually be confident about. They
remain available for Stage 4+ (once real semantic understanding exists,
via `@xo/ai-core`) or a future AI-assisted boundary resolver to populate.

### The hybrid strategy (`boundary-resolver.ts`)

Deterministic rule-based classification is the default whenever its own
confidence is at or above `AMBIGUITY_CONFIDENCE_THRESHOLD` (0.6). Only a
genuinely ambiguous block is ever offered to a `BoundaryAmbiguityResolver`
for a second opinion — the seam every future AI-assisted resolver plugs
into. This stage ships exactly one resolver, `RuleBasedOnlyResolver`,
which accepts the rule-based result as-is; `createDefaultBoundaryResolver`
already accepts a real `@xo/ai-core` `AiCapabilityLayer` instance (typed
against the actual export, not a stand-in), but doesn't yet have
anything productive to ask it to do — none of `@xo/ai-core`'s six
extraction capabilities is "resolve this boundary," and inventing one
here would mean doing Stage 4+'s semantic-judgment work inside Stage 3,
which this stage's instructions explicitly rule out. This is a real,
typed integration seam, not a placeholder — see `boundary-resolver.ts`'s
module doc comment for the full reasoning.

### Determinism guarantees

Given the same `ParsedDocument` and the same resolver (the shipped
default is itself fully deterministic), `chunkDocument` always produces
byte-for-byte identical output: identical unit ids (content hashes, never
random — `unit-id.ts`), identical content, identical relationships, in
identical order. Verified directly in `semantic-chunker.test.ts`'s
determinism test (deep-equal across two independent runs) and
transitively by every other stage's determinism guarantee underneath it
(Stage 1's PDF parsing, Stage 2's structural parsing).

### Output shape: NOT XOIR yet

```
ParsedDocument (Stage 2)
     |
     v
ExperienceDocument { units: ExperienceUnit[], relationshipGraph }   <- Stage 3, this stage
     |
     v
Stage 4+ (Knowledge Extractor, then capability/reasoning/decision/constraint)
     |
     v
XOIR Graph (Stage 10, not yet built)
```

An `ExperienceUnit` is exactly what Stage 4 (and every extractor after
it) builds a `CapabilityRequest` from: `unit.content` becomes
`CapabilityRequest.excerpt.text`, `unit.provenance` supplies
`excerpt.documentPath`/`page`/`section`, and `unit.id` is a natural
`CapabilityRequest.traceId` seed for correlating an AI extraction result
back to the unit it came from.

### Known limitations (real, not hidden)

- **Lexical cues are shallow keyword/phrase matches**, not true rhetorical
  understanding — a block using unusual phrasing for an obligation or
  exception (no "shall"/"unless"/equivalent) falls back to `clause` or
  `general` rather than being misclassified, but it also isn't
  recognized for what it structurally is.
- **`references`/`defines` matching is exact-substring**, not
  normalized — a defined term used with different capitalization,
  pluralization, or punctuation elsewhere in the document will not be
  linked. This is a deliberate precision-over-recall choice: a wrong edge
  is worse than a missed one for a graph every later stage will build on.
- **The AI-assisted boundary resolver is a typed seam, not yet a real
  implementation** — see "The hybrid strategy," above, for why building
  one now would overreach into Stage 4+'s territory.
- **`supports` only looks one unit back**, within the same section — a
  document with several consecutive examples illustrating the same
  clause links each to its *immediately preceding* non-example unit
  (which may itself be another example once the chain runs past the
  first), not all of them back to the original clause.

## Stage 4: Experience Knowledge Extractor (`src/knowledge/`)

### Why knowledge, not named entities

A traditional NER pass produces a flat list of strings tagged with a
type. That's not what this stage does. Every `KnowledgeNode` is a typed,
provenance-carrying, aliasable, mergeable graph citizen — connected to
other nodes by typed edges, ready to become the foundation every later
stage (and eventually a `@xo/xoir` graph) builds on. Entity/organization
detection is *part of* this stage (two node types among 23), not a
separate prior pass — see the "Pipeline note" in the Status table, above.

### The KnowledgeGraph model (`types.ts`)

```
KnowledgeGraph { nodes: readonly KnowledgeNode[], edges: readonly KnowledgeEdge[] }
```

Immutable (every field and array `readonly`), no builder/mutation API —
unlike `@xo/xoir`'s `XoirGraph` (a long-lived mutable container built
incrementally across many passes), a `KnowledgeGraph` is a one-shot final
artifact assembled once per document, so a plain frozen data structure
plus pure functions (`graph.ts`) is the right shape, not a class.

**`KnowledgeNode`**: `id` (deterministic — see "Deterministic ids and
merging," below), `semanticType` (23 known types from the compiler spec's
list — `concept`, `definition`, `entity`, `actor`, `organization`,
`product`, `technology`, `metric`, `risk`, `opportunity`, `constraint`,
`obligation`, `exception`, `jurisdiction`, `financial_instrument`,
`document`, `reference`, `time_period`, `event`, `process`, `action`,
`input`, `output` — plus `custom:<name>`, the same open-union pattern
`@xo/xoir` and Stage 3 use), `canonicalLabel`, `aliases`, `confidence`,
`provenance` (an array — see "Provenance," below), `metadata`.

**`KnowledgeEdge`**: `id`, `type` (21 known types from the spec's list —
`defines`, `references`, `depends_on`, `implements`, `requires`,
`supports`, `contradicts`, `belongs_to`, `part_of`, `causes`,
`mitigates`, `measures`, `governs`, `owned_by`, `uses`, `produces`,
`consumes`, `located_in`, `derived_from`, `version_of`, `supersedes` —
plus `custom:<name>`), `fromNodeId`, `toNodeId`, `confidence`,
`provenance`.

### Provenance

Every node and every edge carries `readonly KnowledgeProvenance[]` —
never a single entry, since a merged node (see below) accumulates one
provenance record per contributing candidate. Each record has the
Experience Unit id, document path, pages, section path, a character
offset range "where possible" (populated for rule-based entity detection,
which knows exact offsets; `undefined` for whole-unit-derived nodes
covering the entire unit, and for AI-extracted items, since
`@xo/ai-core`'s `extractKnowledge` capability doesn't report offsets),
and that specific contribution's own confidence.

### Deterministic ids and merging (`node-id.ts`, `merge.ts`)

A node's id is a content hash over its **match key** — semantic type
plus a normalized form of its label (lowercased, whitespace removed
entirely, a trailing corporate suffix like "Inc."/"LLC" stripped) —
never over which candidate happened to be seen first. This is what makes
"OpenAI", "Open AI", and "OpenAI Inc." converge on the same id
automatically: `merge.ts` groups every candidate (from every unit, from
every extractor that ran) by match key, then per group picks the most
frequent surface form as `canonicalLabel` (ties broken by first-seen,
stable), collects every other distinct surface form as `aliases`,
averages confidence, and concatenates provenance. Re-running the whole
stage on identical input reproduces byte-for-byte identical node ids,
labels, aliases, and provenance order — see
`knowledge-extractor.test.ts`'s determinism tests.

Matching is deliberately **type-scoped**: the same label under two
different semantic types never merges (a term defined as `definition`
and the same word appearing as a general `concept` stay two distinct
nodes) — see "Known limitations" for the precision/recall tradeoff this
implies in the other direction (whitespace-insensitive matching).

### Extraction: hybrid, never provider-specific (`rule-based-extractor.ts`, `ai-extractor.ts`, `hybrid-extractor.ts`)

- **`RuleBasedKnowledgeExtractor`** — always available, never fails,
  never calls a network. Per unit: one "unit primary" node mapping the
  unit's own Stage 3 `semanticType` onto a knowledge node type (a
  `definition` unit's node uses the actual defined term via Stage 3's
  `detectDefinedTerm`; `right` becomes `custom:right`, since the spec's
  node-type list has no direct counterpart), plus zero or more
  `entity`/`organization` candidates from `capitalized-run-detector.ts`
  (a manual, non-regex Title-Case-run scan — the same non-ML heuristic
  family as Stage 2/3's structural parsers).
- **`AiKnowledgeExtractor`** — calls `@xo/ai-core#extractKnowledge`
  **only** — never a provider SDK, never a raw HTTP call. Converts
  `@xo/ai-core`'s `fact`/`definition`/`rule`/`concept` items into
  knowledge nodes (`rule` → `constraint`) and its
  `depends_on`/`derived_from`/`contradicts`/`references` relationships
  into candidate edges (a direct, no-translation-needed type match).
- **`HybridKnowledgeExtractor`** — the default. Rule-based always runs
  first; an AI extractor, if configured, runs *in addition* and its
  candidates are unioned in. If the AI call fails for a unit (no
  eligible provider, rate-limited, every candidate provider down —
  anything `@xo/ai-core` reports as an `err` Result), that unit silently
  falls back to rule-based-only candidates rather than failing the whole
  extraction — the compiler spec's "if AI is unavailable, the rule-based
  extractor should still produce a correct graph with lower confidence,"
  verified directly in `hybrid-extractor.test.ts` and
  `knowledge-extractor.test.ts`'s "degrades gracefully" test.

### Relationships (`relationship-builder.ts`)

Built centrally, after merging, from three sources:

1. **Extractor-supplied edges** — resolved from an extractor's own
   unit-scoped `localId` references (e.g. `@xo/ai-core`'s
   `depends_on`/`derived_from`/`contradicts`/`references` relationships)
   to final merged node ids.
2. **Stage 3's relationship graph, projected** — `extends` → `part_of`
   (a subsection's idea is part of its parent's broader idea);
   `supports`, `defines`, `references` carry straight across (Stage 3
   already used the same names for the same concepts).
3. **Content-mention `references`** — a unit's primary node references
   any other node whose canonical label appears verbatim in that unit's
   content.

Every dangling reference (an endpoint that never resolved to a merged
node) is silently dropped rather than producing an edge to nowhere; a
self-loop is never produced.

### Hashing and serialization (`graph.ts`)

`hashKnowledgeGraph` is a Merkle root (via `@xo/crypto#buildMerkleRoot` —
the same primitive `@xo/xoir` builds its own graph hashing on) over every
node's and edge's own canonical hash, sorted first so it's
insertion-order-independent. `serializeKnowledgeGraph`/
`deserializeKnowledgeGraph` round-trip through a sorted-by-id canonical
JSON form.

### Determinism guarantees

Given the same `ExperienceDocument` and the same extractor configuration,
`extractKnowledgeGraph` produces a byte-for-byte identical `KnowledgeGraph`
— same node ids, labels, aliases, provenance order, edge ids, every time.
The one honestly-stated exception: if `options.aiCore` is wired to a real,
live provider, that provider's own sampling behavior is not itself
guaranteed deterministic across calls — this stage's determinism
guarantee covers its own logic (merging, id computation, relationship
building), not a live LLM's output. `@xo/ai-core`'s deterministic-replay
and scriptable-test providers are what make an end-to-end deterministic
test of the AI-assisted path possible at all — see
`ai-extractor.test.ts`/`hybrid-extractor.test.ts`/
`knowledge-extractor.test.ts`.

### Known limitations (real, not hidden)

- **Whitespace-insensitive label matching is aggressive.** Stripping all
  whitespace to unify "OpenAI"/"Open AI" also risks merging two
  genuinely different short labels that happen to collapse to the same
  string once spaces are removed. A real, precision-losing tradeoff,
  made deliberately (see `node-id.ts`'s doc comment) rather than left
  unstated.
- **Entity/organization detection is a capitalized-run heuristic**, not
  true NER — proper nouns that aren't Title-Case in the source (rare in
  formal documents, common in casual ones) aren't detected; a
  capitalized word at a sentence start that isn't actually a proper noun
  can produce a spurious low-confidence `entity` candidate (confidence
  0.5 for a single word is intentionally the lowest confidence this
  stage ever assigns, for exactly this reason).
- **`defines`/`references` content-mention matching is exact-substring**,
  same tradeoff as Stage 3's equivalent — a wrong edge is worse than a
  missed one for a graph every later stage builds on.
- **Not every one of the spec's 23 node types or 21 edge types is
  populated by the shipped extractors.** `RuleBasedKnowledgeExtractor`
  produces `concept`/`definition`/`obligation`/`exception`/`custom:right`/
  `reference`/`entity`/`organization`; `AiKnowledgeExtractor` adds
  `concept`/`definition`/`constraint` (from `fact`/`definition`/`rule`
  items). `part_of`/`supports`/`defines`/`references` are populated
  deterministically; `depends_on`/`derived_from`/`contradicts` only
  when an AI extractor is configured and reports them. Every other type
  in both lists is a valid, well-typed target for a future extractor —
  not a placeholder, just not yet produced.

## Stage 5: Capability Extractor (`src/capabilities/`)

### What a capability is here

A `Capability` is not a flat string tag — it's everything an XO can
*do*, described richly enough for a future runtime/execution layer to
act on: a deterministic id, canonical name, aliases, description,
category, confidence, provenance (Stage 4's own `KnowledgeProvenance`
model, reused verbatim — no parallel provenance shape), inputs, outputs,
dependencies, the knowledge nodes and concepts it relates to, required
permissions (empty until a permission model exists), invocation hints,
examples, a machine-readable `signature`, and open metadata. This stage
consumes Stage 3's `ExperienceDocument` *and* Stage 4's `KnowledgeGraph`
together — every capability is extracted from a unit with the whole
knowledge graph available for cross-referencing.

### The CapabilityGraph model (`types.ts`)

```
CapabilityGraph { capabilities: readonly Capability[], relationships: readonly CapabilityRelationship[] }
```

Immutable, one-shot (same reasoning as Stage 4's `KnowledgeGraph` — see
that section, above — applies here too: a plain frozen structure plus
pure functions, not a mutable builder class). 16 known categories
(`action`, `analysis`, `generation`, `transformation`, `retrieval`,
`communication`, `workflow`, `planning`, `reasoning`, `search`,
`classification`, `extraction`, `summarization`, `translation`,
`validation`, `execution` — plus `custom:<name>`) and 9 known
relationship types (`depends_on`, `invokes`, `produces`, `consumes`,
`extends`, `requires`, `enables`, `conflicts_with`, `complements` — plus
`custom:<name>`), the same open-union pattern every prior stage uses.

### The capability signature (`types.ts#CapabilitySignature`)

Per this stage's brief, every capability carries a machine-readable
signature — `inputs`/`outputs` (structured `{name, description}` pairs,
distinct from the capability's own simpler `inputs`/`outputs` string
lists), `sideEffects`, `requiredResources`, `determinism`
(`'deterministic' | 'non_deterministic' | 'unknown'`), `idempotent`
(`boolean | 'unknown'`), `executionMode` (`'sync' | 'async' |
'unknown'`), and `estimatedCost` (`'low' | 'medium' | 'high' |
'unknown'`) — added specifically so Stages 6-9 (Reasoning, Decision
Graph, Constraints, and eventually a runtime/execution layer) have this
shape available without the capability model needing to change again.
Both shipped extractors report `UNKNOWN_SIGNATURE` for every field
neither can honestly infer from text alone — `merge.ts#mergeSignatures`
prefers a known value over `'unknown'` when merging, so a future,
richer extractor's signal wins over a vaguer one rather than being
averaged away.

### Deterministic ids and merging (`capability-id.ts`, `merge.ts`)

Harder than Stage 4's entity matching, on purpose: this stage's own
worked example ("Send Email" / "Email Sending" / "Mail Sender" → one
capability) can't be solved by whitespace-insensitive matching alone —
none of the three share an exact word. `capability-id.ts` instead
reduces a name to a **word-set key**: stop words removed, a small fixed
synonym table applied ("mail" → "email"), each remaining word run
through a crude suffix-stripping stemmer ("sending"/"sender" → "send"),
then sorted and deduplicated. All three examples reduce to the same
stem set (`{email, send}`), and a capability's id is a content hash over
category + that word-set key — never over which surface form or
extractor produced it first. `merge.ts` groups every candidate by that
key (mirroring `../knowledge/merge.ts#mergeKnowledgeNodes` exactly in
approach) and unions `inputs`/`outputs`/`invocationHints`/`examples`/
`requiredKnowledgeNodeIds`/`relatedConcepts` across the merged group,
in addition to the name/alias/confidence/provenance merging Stage 4
already established.

### Extraction: hybrid, never provider-specific (`rule-based-extractor.ts`, `ai-extractor.ts`, `hybrid-extractor.ts`)

- **`RuleBasedCapabilityExtractor`** — always available, never fails,
  never calls a network. Three real detection techniques per unit:
  **verb-based** (`capability-lexicon.ts`'s verb table, checked against
  every sentence — true imperatives score higher confidence than a verb
  found after a modal word like "shall", which scores higher than a
  verb found elsewhere), **title-based** (a unit's title checked against
  a category-keyword table — "Risk Analysis" is itself evidence of an
  `analysis` capability), and **command-snippet-based**
  (`command-snippet-detector.ts`'s manual identifier-then-parens scan,
  with parenthesized arguments parsed into candidate `inputs`). Every
  candidate's `requiredKnowledgeNodeIds`/`relatedConcepts` come from
  cross-referencing matched text against the `KnowledgeGraph` Stage 4
  already built.
- **`AiCapabilityExtractor`** — calls `@xo/ai-core#extractCapabilities`
  **only**, never a provider directly. That capability's output has no
  category field of its own, so this extractor best-effort-guesses one
  by checking the AI's returned name/description against the same verb
  lexicon the rule-based extractor uses, falling back to the generic
  `action` category rather than inventing an unjustified `custom:` type.
- **`HybridCapabilityExtractor`** — the default, identical in structure
  to `../knowledge/hybrid-extractor.ts`'s `HybridKnowledgeExtractor`:
  rule-based always runs; an AI extractor, if configured, runs in
  addition; an AI failure for a unit falls back to rule-based-only
  candidates rather than failing the whole extraction — "never fail
  compilation," per this stage's brief.

### Relationships (`relationship-builder.ts`)

Built centrally, after merging, from four sources:

1. **Extractor-supplied edges** — the mechanism is real and tested, even
   though neither shipped extractor populates any today (`@xo/ai-core`'s
   `extractCapabilities` capability has no relationship field of its
   own, unlike `extractKnowledge`'s).
2. **`extends`** — a unit's verb- or snippet-derived capabilities extend
   that same unit's title-derived capability, when one exists (the
   specific elaborates the general).
3. **`complements`** — within a unit, each non-title capability
   complements the immediately preceding non-title capability found in
   the same unit (sequential co-occurrence, the same nearest-preceding
   pattern Stage 3's `supports` edges use).
4. **`depends_on`** — content-mention: a capability whose description
   textually mentions another capability's canonical name. Every
   `depends_on` edge is also mirrored onto the *from* capability's own
   `dependencies` field — a two-phase split (merge, then
   relationships-and-dependencies) matching Stage 3's
   `documentReferences` and Stage 4's edge-building precedent exactly.

Every dangling reference is dropped silently; a self-loop is never
produced.

### Hashing and serialization (`graph.ts`)

`hashCapabilityGraph` is a Merkle root over every capability's and
relationship's own canonical hash, sorted first — the identical strategy
`../knowledge/graph.ts#hashKnowledgeGraph` uses, per this stage's brief.
`serializeCapabilityGraph`/`deserializeCapabilityGraph` round-trip
through a sorted-by-id canonical JSON form.

### Determinism guarantees

Given the same `ExperienceDocument`, the same `KnowledgeGraph`, and the
same extractor configuration, `extractCapabilityGraph` produces a
byte-for-byte identical `CapabilityGraph` — same capability ids, names,
aliases, provenance order, relationship ids, dependencies, every time.
The same honestly-stated exception as Stage 4 applies: a live AI
provider's own sampling behavior is not this stage's to guarantee —
`@xo/ai-core`'s deterministic-replay and scriptable-test providers are
what make an end-to-end deterministic test of the AI-assisted path
possible at all.

### Known limitations (real, not hidden)

- **Word-set matching with a crude stemmer and a small fixed synonym
  table is a real but narrow technique**, not lemmatization or true NLP.
  It solves this stage's own worked example deliberately, and will merge
  some names that share word stems by coincidence rather than by true
  synonymy, and miss genuine synonyms not in `SYNONYMS`
  (`capability-id.ts`).
- **Verb-based detection only recognizes the lexicon's ~50 verbs.** A
  capability described with an unusual or domain-specific verb not in
  `capability-lexicon.ts`'s table produces no verb-based candidate (the
  title-based and command-snippet-based detectors are unaffected).
- **`inputs`/`outputs` are populated only for command-snippet-derived
  candidates.** Verb- and title-based candidates report empty
  `inputs`/`outputs` — inferring structured parameters from prose alone
  (versus a literal `fn(args)` snippet) isn't attempted, rather than
  guessed at unreliably.
- **`CapabilitySignature` is `UNKNOWN_SIGNATURE` for essentially every
  capability this version produces.** Neither extractor can honestly
  infer determinism/idempotency/execution-mode/cost from prose text
  alone; the field exists (and `merge.ts` already prefers a known value
  when one is available) specifically so a future, richer extractor can
  populate it without another model change.
- **`conflicts_with`, `enables`, `requires`, `produces`, `consumes` are
  valid relationship types this stage's model supports but does not
  itself populate deterministically** — same honesty pattern as every
  prior stage's under-populated type lists.

## XOIR Reconciliation and the XOIR-First Compilation Pipeline (`src/xoir/`, `src/pipeline/`)

Two pieces of cross-cutting architectural work sit here, orthogonal to the
per-extractor stage numbering above (Stage 6 in the *table* above means
"Reasoning Extractor," not what this section calls "Stage 6" — see the
note at the end of this section for why the two numbering tracks
diverged):

- **XOIR Reconciliation** made `@xo/xoir` the single canonical semantic
  representation every compiler stage's output converges into, and built
  the `KnowledgeGraph -> XOIR` / `CapabilityGraph -> XOIR` conversion
  boundary (`src/xoir/knowledge-to-xoir.ts`, `src/xoir/capability-to-xoir.ts`).
  See `packages/xoir/README.md` for the full canonical schema this
  established — that document is authoritative for XOIR itself; this
  section only covers how `@xo/compiler` uses it.
- **XOIR-First Compilation Pipeline Integration** (this section) made XOIR
  a real boundary *inside the compiler pipeline*, not merely a conversion
  utility a caller might or might not use. Before this, nothing forced a
  caller to route Stage 4/5 output through validation or normalization;
  after this, `compileXoir()` (`src/pipeline/compile.ts`) is the one
  documented way any current or future stage's output becomes a
  compiled artifact.

### Why XOIR, not `KnowledgeGraph`/`CapabilityGraph`, is the compiler's boundary

```
Before:  KnowledgeGraph ──→ compiler logic
         CapabilityGraph ─→ compiler logic

After:   KnowledgeGraph ──→ XOIR ──→ compiler logic
         CapabilityGraph ─→ XOIR ──→ compiler logic
```

Once a `KnowledgeGraph`/`CapabilityGraph` has been converted, no code
downstream of `compileXoir()` should depend on `KnowledgeGraph` semantic
types or `CapabilityGraph` relation types again — those are Stage 4/5's
own extraction-domain vocabulary, useful for *producing* evidence, not
for reasoning about compiled expertise generically. This is what lets a
future Stage 6 (Reasoning Extractor), Stage 7 (Decision Graph Generator),
Stage 8 (Constraint Extractor), or an entirely new source adapter (image,
video, web, DOCX, email, ...) plug into the same pipeline without this
package's pipeline code ever needing to change for them — they only need
to either produce a `KnowledgeGraph`/`CapabilityGraph`-shaped model with
its own conversion function, or emit XOIR directly (see
`PipelineInput`'s `'xoir'` variant below).

### Pipeline stages (`src/pipeline/`)

```
PipelineInput
  │  (KnowledgeGraph | CapabilityGraph | both | a pre-built XoirGraph)
  ▼
convertToXoir()            — src/pipeline/compile.ts
  │  knowledgeGraphToXoir() / capabilityGraphToXoir() / passthrough
  ▼
XOIR validation pass        — src/pipeline/validate-pass.ts
  │  wraps @xo/xoir#validateGraph; produces Diagnostic[]
  ▼
  invalid? ──yes──→ stop here; return { valid: false, diagnostics, ... }
  │no
  ▼
XOIR normalization pass     — src/pipeline/normalize-pass.ts
  │  deterministic ordering, canonical provenance ordering,
  │  safe exact-duplicate-edge collapsing
  ▼
CompiledXoirResult
  { graph, valid, validation, diagnostics, passRuns, stats }
```

Each stage is an explicit, named, independently-testable unit — no
implicit ordering, no hidden mutation of a graph a caller still holds a
reference to (every stage either returns the same graph reference
unchanged, per the validation pass's own contract, or an entirely new
graph, per normalization's). `compile.ts`'s `compileXoir()` is the only
place that sequences them.

**Entry points** (`src/pipeline/types.ts#PipelineInput`):

```ts
{ kind: 'knowledge', graph: KnowledgeGraph }
{ kind: 'capability', graph: CapabilityGraph }
{ kind: 'combined', knowledge: KnowledgeGraph, capability: CapabilityGraph }
{ kind: 'xoir', graph: XoirGraph }   // future adapters that already emit XOIR directly
```

A future source adapter's whole interface into this compiler is meant to
be exactly:

```ts
const domainGraph = await extract(source);       // Stage 4/5-style adapter
const result = await compileXoir({ kind: 'knowledge', graph: domainGraph });
```

without that adapter ever needing to construct a `PassManager`, call
`validateGraph`, or know normalization exists.

### Validation (`src/pipeline/validate-pass.ts`)

`createXoirValidationPass()` is a `@xo/xoir` `Pass` (registered with a
`PassManager`, same framework `@xo/xoir` already ships — see
`packages/xoir/README.md`'s "Visitor / Pass frameworks" section) that
runs `validateGraph` against the current graph and maps every
`ValidationIssue` onto a `Diagnostic`:

```ts
{ severity: 'error', code: 'xoir-validation/missing_required_property',
  passName: 'xoir-validation', message: '...', nodeId: XoirNodeId('...') }
```

No validation rule is duplicated here — every diagnostic is a direct
translation of a `ValidationIssue` `@xo/xoir` already computed; this pass
adds structure (a stable `code`, and looking up whether `subjectId` names
a node or an edge) on top, nothing more. `compileXoir()` — not this
pass — is what stops downstream compilation on failure: it inspects the
`ValidationReport` directly and simply never invokes the normalization
`PassManager` when `!validation.valid`, rather than relying on a
cancellation-token side channel between passes.

### Normalization (`src/pipeline/normalize-pass.ts`)

Normalization answers a different question than validation: not "is this
graph valid" but "is this valid graph in its canonical deterministic
form." `createXoirNormalizationPass()` does exactly three things,
deliberately conservative:

1. **Deterministic ordering** — rebuilds the graph with nodes and edges
   inserted in `id`-sorted order, so `allNodes()`/`allEdges()` iteration
   order is stable and independent of whatever order an adapter or merge
   produced them in.
2. **Canonical provenance ordering** — sorts each node/edge's
   `sourceRefs` into canonical (content-sorted) order and recomputes its
   hash to match. `sourceRefs` is a *set* of corroborating evidence, not
   a meaningful sequence (see `packages/xoir/README.md` §5), so two nodes
   backed by the same evidence in a different encounter order now hash
   identically. This is the one place normalization is allowed to change
   a node/edge's `hash` — the content is unchanged, only its ordering is
   canonicalized.
3. **Safe exact-duplicate-edge collapsing** — two edges asserting the
   identical relationship (`kind`, `fromId`, `toId`) under two *different*
   ids are collapsed into one, keeping the lexicographically-smallest id
   and unioning their `sourceRefs` (never dropping either side's
   evidence), with an `info`-severity diagnostic recording what was
   collapsed.

**What normalization deliberately does NOT do** (Stage 6's explicit
non-goals): it never infers that two differently-`id`'d *nodes* are "the
same" — that would be exactly the speculative semantic-equivalence
inference this stage is required to avoid; it never reorders
`properties` values (property array order is domain-meaningful, not an
evidence set); it never touches `tags`/`custom` beyond passing them
through; and it never runs at all if validation failed.

### Merge (`@xo/xoir`'s `provenance-merge.ts`)

The standard **combined path** (Stage 4 + Stage 5 together) does not need
a general merge: `capabilityGraphToXoir(cGraph, { into: knowledgeXoirGraph })`
(the `into` option `@xo/xoir` reconciliation already established) writes
Capability nodes/edges directly into the already-converted Knowledge
graph. Knowledge and Capability ids live in disjoint id spaces
(`computeKnowledgeNodeId` vs. `computeCapabilityId`), so there is no
genuine id conflict to resolve — `into` is composition, not merge, and
`compile.ts`'s `'combined'` input kind uses exactly this, per the
instruction to reuse Stage 5.5's `into` functionality rather than
duplicate its semantics.

A genuine **merge** — combining two or more *independently*-produced
`XoirGraph`s that may legitimately assert the same node/edge id (e.g. two
separate extraction runs over overlapping source material, or
incremental recompilation with new evidence) — is
`@xo/xoir#mergeGraphsPreservingProvenance` (`packages/xoir/src/provenance-merge.ts`,
added alongside this pipeline work since Stage 6 explicitly requires
provenance-additive merge semantics `@xo/xoir`'s original `mergeGraphs`
didn't provide — see that file's doc comment and
`packages/xoir/README.md`'s "Merge engine" section for the full
before/after). In short: two same-id candidates that agree on *core*
content (kind/subtype/properties/custom) are reconciled into one node
with **unioned, deduplicated** `sourceRefs`/`tags` and a `confidenceDetail`
reflecting the real, larger corroboration count — never a pick-one,
discard-the-rest resolution. Only candidates whose core content
*genuinely* differs are reported as a conflict and resolved via the same
`MergeStrategy` `mergeGraphs` already used (`prefer_first` /
`prefer_last` / `prefer_higher_confidence` / `error_on_conflict`).
`CompileXoirOptions.mergeStrategy` is reserved for a future caller that
needs to merge multiple independently-compiled `XoirGraph`s ahead of this
pipeline; the `'combined'` input kind itself never needs it.

### Diagnostics

`Diagnostic` (`@xo/xoir`'s `pass.ts`) gained four additive, optional
fields for Stage 6: `code`, `nodeId`, `edgeId`, `sourceRef`. Every
pre-Stage-6 diagnostic (just `severity`/`message`/`passName`) remains
valid — these fields are simply absent on it. A validation diagnostic
looks like:

```ts
{
  severity: 'error',
  code: 'xoir-validation/dangling_edge_reference',
  message: 'Edge "e1" references a node not present in the graph',
  passName: 'xoir-validation',
  edgeId: XoirEdgeId('e1'),
}
```

`CompiledXoirResult.diagnostics` aggregates every pass's diagnostics in
pass-execution order; `CompiledXoirResult.passRuns` carries the
`PassRunSummary[]` (`@xo/xoir`'s existing `pass.ts` type, unchanged) for
timing/cancellation introspection.

### Determinism

Given the same domain input (or the same pre-built `XoirGraph`) and the
same `now` override, `compileXoir()` produces an identical
`graph.contentHash()` on every run — proven directly in
`test/pipeline/compile.test.ts`'s determinism tests, including for the
combined Stage 4 + Stage 5 path. As established in the XOIR
reconciliation: `createdAt`/`updatedAt` node/edge timestamps and manifest
pass-history timestamps never enter any content hash; this pipeline adds
nothing that changes that. The one *new* thing that affects a node/edge's
hash post-conversion is normalization's canonical `sourceRefs` ordering
(§ above) — deliberately, so that two structurally-equivalent inputs
encountered in a different order still converge on one canonical hash,
which is a *stronger* determinism guarantee than existed before this
pipeline, not a weaker one.

### Why the numbering diverges from the Status table above

See "Roadmap numbering, resolved" in the Status table's notes, above.
Short version: the table's Stage 6/7/8/9 are the *original*
per-extractor plan; `Stage 5.5`/`Stage 6`/`Stage 7` (this document's
other numbering) are a separate, cross-cutting work track that
established the canonical semantic representation, the pipeline
boundary, and — as of Stage 7 — the reasoning/decision/constraint
extraction the original table's Stage 6-8 called for, built as one
XOIR-native module rather than three separate ones.

## Stage 7: Reasoning & Decision Extraction (`src/reasoning/`)

Extends the compiler from *what the source material knows*
(`KnowledgeGraph`) and *what it can do* (`CapabilityGraph`) to
*how it decides* — the explicit reasoning and decision-making structure
a source actually supports: rules, prerequisites, prohibitions, policies,
decisions, alternatives, justifications, exceptions, escalations, and
risk thresholds. Not a generic reasoning engine, and not permitted to
invent structure the source doesn't support — every extracted node
traces back to a specific, conservative pattern match or an AI capability
call, never a guess (see "Extraction strategy" below).

### The `ReasoningGraph` model (`types.ts`)

Same shape and purpose as Stage 4/5's own domain models
(`KnowledgeGraph`/`CapabilityGraph`): a minimal, internal,
deterministically-identified intermediate representation that converts
into canonical XOIR through an explicit boundary
(`src/xoir/reasoning-to-xoir.ts`) — **not** a competing canonical graph.
`ReasoningNode.nodeType` is Stage 7's own vocabulary (`rule`,
`prerequisite`, `prohibition`, `policy`, `decision`, `alternative`,
`justification`, `exception`, `escalation`, `risk_threshold`), mapped
onto XOIR's existing canonical kinds — see "XOIR mapping" below.
`ReasoningNode.provenance` reuses Stage 4/5's `KnowledgeProvenance` type
verbatim: no second provenance system.

### Extraction strategy: rule-based, AI-assisted, hybrid

Follows the identical architecture Stage 4/5 established
(`RuleBasedExtractor`/`AiExtractor`/`HybridExtractor`, `merge.ts`,
deterministic ids):

- **`rule-based-extractor.ts`** — always runs, never fails, never calls a
  network. `rule-pattern-parser.ts` does manual (no-regex, this package's
  established style — see `lexical-cues.ts`) sentence-pattern matching
  for a conservative, explicitly-scoped pattern set: `IF`/`WHEN ...
  THEN` (single- and multi-condition), `BEFORE A, B must be completed`
  (prerequisite), `CANNOT`/`MUST NOT`/`DO NOT` (prohibition), `ONLY ...
  MAY`/`MUST` (policy), `... is preferred when ...` (alternative),
  `BECAUSE E, D` / `D, because E` (justification), `UNLESS` (inline
  exception, folded into the rule it modifies), `... ELSE`/`OTHERWISE`
  (IF/THEN/ELSE alternative branching), and `X overrides Y` (standalone
  exception). Every pattern returns nothing rather than guessing when a
  sentence doesn't clearly match — Stage 7's explicit "false positives
  are worse than missing ambiguous reasoning."
- **`ai-extractor.ts`** — reuses `@xo/ai-core`'s **already-existing**
  `extractReasoning`, `extractDecisionGraph`, and `extractConstraints`
  capabilities (found during the required "read the repository first"
  step — these predate Stage 7 and needed zero changes to `@xo/ai-core`
  itself). Maps `ReasoningStep`s to `justification` nodes, `Exception`s
  to `exception` nodes, `AlternativePath`s to `alternative` nodes
  (linked to their steps via `SUPPORTS`), `DecisionNode`s/`DecisionBranch`es
  to `decision` nodes (linked via `DEPENDS_ON`/`condition_of`/`leads_to`),
  `EscalationPath`s to `escalation` nodes, `RiskThreshold`s to
  `risk_threshold` nodes, `Fallback`s to `rule` nodes, and
  `ExtractedConstraint`s to `policy` nodes. Deliberately **not** mapped
  (documented, not silently dropped): `tradeoffs`/`failureModes`
  (`extractReasoning`) and `confidenceBoundaries`
  (`extractConstraints`) — none has a clean 1:1 correspondence to a
  `ReasoningNodeType` without an awkward forced fit. Each of the three
  capabilities is called and handled independently — one failing doesn't
  block the other two's candidates.
- **`hybrid-extractor.ts`** — rule-based always; AI extraction
  additional and optional, with a rule-based-only fallback on failure —
  the same "AI is additive, never mandatory" posture as Stage 4/5, per
  Stage 7's explicit instruction.

### Merge and determinism (`merge.ts`, `node-id.ts`, `edge-builder.ts`)

A `ReasoningNode`'s id is a content hash over its node type + normalized
canonical label (`node-id.ts#computeReasoningNodeId`) — the same rule
stated by rule-based extraction *and* independently found by AI
extraction converges on one node with corroborated confidence, never a
duplicate (`merge.ts#mergeReasoningNodes`, mirroring
`../knowledge/merge.ts` exactly, plus unioning `exceptionConditions`
across the group). `edge-builder.ts` resolves every extractor-local edge
reference into a final `ReasoningEdge`, deduplicating and averaging
confidence for edges that collapse onto the same `(type, from, to)`
triple. Both are pure functions over already-extracted candidates —
running extraction on the same `ExperienceDocument` twice reproduces
identical node/edge ids, ordering, and provenance every time (see
`test/reasoning/reasoning-extractor.test.ts`'s determinism tests).

### XOIR mapping (`src/xoir/reasoning-node-kind-mapping.ts`, `reasoning-edge-mapping.ts`, `reasoning-to-xoir.ts`)

Per Stage 7's explicit instruction to reuse the existing taxonomy before
extending it, every `ReasoningNodeType` maps onto an *existing* canonical
XOIR kind — **zero new XOIR node kinds were needed**:

| Reasoning type | XOIR kind | Why |
|---|---|---|
| `rule`, `exception` | `heuristic` | `condition`/`action`/`exceptionConditions` is exactly `HeuristicNodeProps` |
| `prerequisite`, `prohibition`, `policy` | `constraint` | all three are hard limits; differ only in `subtype`/`severity` |
| `decision`, `alternative` | `decision_node` | an alternative is structurally another decision branch |
| `justification` | `reasoning_step` | `premise`/`conclusion` is exactly `rationale`/`outcome` |
| `escalation` | `escalation_rule` | `triggerCondition`/`escalationTarget` matches exactly — previously unused canonical kind |
| `risk_threshold` | `risk_policy` | `domain`/`toleranceLevel` matches `metric`/`thresholdDescription` — also previously unused |

Edges: 9 of the task's 10 suggested relationship names (`CONDITION_OF`,
`REQUIRES`, `CONSTRAINS`→`GOVERNS`, `EXCLUDES`→`CONTRADICTS`,
`OVERRIDES`→`SUPERSEDES`, `LEADS_TO`/`RESULTS_IN`→`TRIGGERED_BY`
*reversed*, `SUPPORTS`/`JUSTIFIES`→`SUPPORTS`, `DEPENDS_ON`) reuse an
existing XOIR edge kind — see `reasoning-edge-mapping.ts` for the exact
table and the reasoning behind each. **One genuine addition**:
`ALTERNATIVE_TO` (`@xo/xoir`'s `edge-kinds.ts`) — "Option A instead of
Option B" has no existing XOIR edge kind that means "mutually exclusive
choice" without a real semantic stretch (`COMPOSES_INTO`/`COMPLEMENTS`
mean "combines with," the opposite; `CONTRADICTS` is for two claims that
logically disagree, not two options a decision-maker is choosing
between). Purely additive to `@xo/xoir` — see that package's README
§19 and its own regression tests.

`reasoning-to-xoir.ts` also does one thing neither Stage 4 nor Stage 5's
adapter needs: best-effort **content-mention linking**
(`linkReferencedNodes`, default on) — for the "prerequisite → capability"
/ "rule → capability" relationship categories, it scans a
reasoning node's condition/action/outcome text for a substring match
against an already-composed Capability/Concept node's label in the
target graph, and adds a `REQUIRES` edge when found (same conservative
`MIN_REFERENCE_LABEL_LENGTH` gate `../knowledge/relationship-builder.ts`
uses). Never invents a link without a real textual match.

### Pipeline integration (`src/pipeline/`)

`PipelineInput`'s `'knowledge'`/`'capability'`/`'combined'` variants
gained an optional `reasoning?: ReasoningGraph` field. `compile.ts`'s
`convertToXoir` composes it in *last*, via the same `into` mechanism
Stage 6 established for Knowledge+Capability composition — Knowledge,
Capability, and Reasoning ids all live in disjoint id spaces, so there is
no genuine merge conflict, only composition, and converting reasoning
last is what lets `linkReferencedNodes` find real Capability/Concept
nodes already sitting in the target graph. No second `compileXoir`-like
entry point exists. Reasoning *extraction/composition* itself needed no
dedicated `Pass` — it happens at the conversion step, the same
architectural layer Stage 4/5's own adapters occupy, before any
`PassManager` Stage 6 built ever runs. Semantic *validation* of that
composed output, however, is a genuine pass — see the next section.

### Semantic reasoning validation (`src/pipeline/reasoning-validate-pass.ts`)

Structural validity and semantic validity are different questions.
`@xo/xoir#validateGraph` (reused via `validate-pass.ts`, Stage 6) answers
"are all nodes/edges valid XOIR objects" — required properties present,
confidence in range, no dangling edges. It is deliberately
domain-agnostic: it has no concept of what a "decision" or a "rule" *is*,
only that a `decision_node`/`heuristic` has the right property keys. That
leaves a real gap Stage 7 output can fall into without tripping it: an
explicitly **empty** `question`/`condition`/`rule` string passes
structural validation today (the key is present, its value just isn't
meaningful), and an `ALTERNATIVE_TO`/`SUPERSEDES` edge pointing at a node
with no rule/decision content to be an alternative to or override is
still a structurally well-formed edge.

`createReasoningValidationPass()` closes exactly that gap, conservatively:

- **What is validated.** Two kinds of check, both scoped to
  Stage-7-sourced content only (identified by `metadata.subtype` being
  one of Stage 7's own node types — see `reasoning/types.ts`):
  1. **Required-content checks** — a Stage-7-sourced node's
     semantically-required text fields (`condition`/`action` for a rule,
     `question`/`outcome` for a decision, `rule` for a
     prerequisite/prohibition/policy, `triggerCondition`/
     `escalationTarget` for an escalation, `domain`/`toleranceLevel` for
     a risk threshold, `premise`/`conclusion` for a justification) must
     be non-blank, not merely present.
  2. **Relationship-shape checks** — an `ALTERNATIVE_TO` edge must
     connect two `decision_node`s (an alternative can only be an
     alternative *to* another decision branch); a Stage-7-sourced
     `SUPERSEDES` (override) edge must target a node kind that actually
     has rule/decision/constraint content to override (`heuristic`,
     `decision_node`, `constraint`, `escalation_rule`, `risk_policy` —
     not a bare `concept`/`fact`); no Stage-7-relevant relationship edge
     may be a self-loop.
- **What is intentionally NOT validated.** Dangling edge endpoints
  (missing nodes) — that's `@xo/xoir#validateGraph`'s
  `dangling_edge_reference` check, reused, never duplicated here.
  Anything about a node/graph being *incomplete* — a unit that produced
  no structured reasoning at all contributes zero nodes, which is
  correct, not an error (Stage 7's explicit "false-positive validation
  errors are worse than allowing unsupported ambiguity to remain
  unstructured"). Linguistic ambiguity, ambiguous phrasing, or a
  plausible-but-unstructured sentence — none of that is this pass's
  concern; it only ever looks at content that already became a
  structured Stage 7 node/edge.
- **Conservative philosophy.** Every check answers "does this specific
  structured claim make sense," never "is this natural language good
  enough." `"Management generally prefers option A."` producing no
  structured decision is not flagged — nothing was claimed to be
  structured in the first place. Only a node/edge that XOIR *already
  claims* to be a rule/decision/override/alternative, but whose content
  contradicts what that claim requires, is an error.
- **Diagnostic codes** (four, matching the pattern's `code`
  taxonomy elsewhere in this pipeline): `DECISION_MISSING_REQUIRED_STRUCTURE`,
  `RULE_MISSING_REQUIRED_STRUCTURE`, `REASONING_INVALID_STRUCTURE`
  (prerequisite/prohibition/policy/escalation/risk_threshold/justification
  blank-content cases), `INVALID_REASONING_RELATIONSHIP`
  (`ALTERNATIVE_TO`/`SUPERSEDES`/self-loop shape violations). All
  `'error'`-severity, all attributed with `nodeId` or `edgeId`, reusing
  `@xo/xoir`'s `Diagnostic` type unchanged (`pass.ts`) — no second
  diagnostic model.
- **Pipeline placement.** `compile.ts` runs this pass in the *same*
  `PassManager` as generic structural validation, registered right after
  it: `xoir-validation` → `reasoning-validation` → (only if both produced
  zero error-severity diagnostics) `xoir-normalization`. An
  error from either validation stage stops downstream compilation
  identically — `CompiledXoirResult.valid` reflects both, and
  normalization simply never runs. The two passes are not linked by a
  hard `dependsOn` (this pass reads the raw graph directly, not the
  other pass's diagnostics, so a hard dependency would only make it
  unusable standalone); ordering is guaranteed by `compile.ts`'s
  explicit registration order, the same pattern `normalize-pass.ts`
  already established for the identical reason.
- **Determinism.** Nodes and edges are visited in `id`-sorted order (not
  graph-insertion order), so repeated runs on identical input produce
  byte-identical diagnostics in identical order — verified directly in
  `test/pipeline/reasoning-validate-pass.test.ts`.

### Known limitations

- **Rule-based extraction is intentionally narrow.** The pattern set
  above is exactly what Stage 7's required test categories call for —
  real source material with different phrasing (e.g. "X shall not occur
  when Y" instead of "cannot") will not match without AI assistance or a
  future pattern addition. This is a documented scope boundary, not a
  silent gap: `rule-pattern-parser.ts`'s module doc comment is explicit
  about "false negatives preferred over false positives."
  `escalation`/`risk_threshold` nodes are currently AI-only — no
  rule-based text pattern for them exists yet.
- **Cross-sentence exception resolution is not attempted.** "Exception E
  overrides rule R." (`parseStandaloneOverride`) extracts the exception
  node but does not resolve `R` to another sentence's rule node by text
  matching — only the *inline* `UNLESS` form (same sentence) produces a
  real `overrides`/`SUPERSEDES` edge. Resolving free-text cross-sentence
  references conservatively is future work.
- **Content-mention linking is textual, not semantic.** `Sign Contract`
  matches a capability named exactly `Sign Contract`; it will not match
  `Contract Signing` or a paraphrase. Same limitation Stage 4's
  `relationship-builder.ts` already has and documents.
- **AI-core's `tradeoffs`/`failureModes`/`confidenceBoundaries` are not
  mapped** — see "XOIR mapping" above.
- **Semantic validation checks shape, not truth.** A rule whose
  `condition`/`action` are both non-blank but nonsensical together (e.g.
  swapped, or internally contradictory) is not and cannot be caught here
  — that would require actual language understanding, which this
  conservative, structural pass deliberately does not attempt. It
  catches malformed *structure*, never linguistically-imperfect-but-
  well-formed content.




```ts
import { readFileSync } from 'node:fs';
import { NodePdfLoader, parseDocument, chunkDocument, extractKnowledgeGraph, hashKnowledgeGraph } from '@xo/compiler';

const loader = new NodePdfLoader();
const result = loader.load(readFileSync('contract-law.pdf'), 'contract-law.pdf');

if (result.ok) {
  console.log(`${result.value.pageCount} pages, title: ${result.value.metadata.title}`);

  const parsed = parseDocument(result.value);
  const experienceDoc = await chunkDocument(parsed, 'contract-law.pdf', result.value.metadata.title);

  for (const unit of experienceDoc.units) {
    console.log(`[${unit.semanticType}] ${unit.title} (confidence ${unit.confidence})`);
    console.log(`  section: ${unit.provenance.sectionPath.join(' > ')}`);
    for (const rel of unit.relationships) console.log(`  --${rel.type}--> ${rel.toUnitId}`);
  }

  // Stage 4 — rule-based only (no aiCore option) still produces a correct, lower-confidence graph.
  const knowledgeGraph = await extractKnowledgeGraph(experienceDoc);
  for (const node of knowledgeGraph.nodes) {
    console.log(`[${node.semanticType}] ${node.canonicalLabel}${node.aliases.length ? ` (aka ${node.aliases.join(', ')})` : ''} — confidence ${node.confidence}`);
  }
  for (const edge of knowledgeGraph.edges) {
    console.log(`  ${edge.fromNodeId} --${edge.type}--> ${edge.toNodeId}`);
  }
  console.log(`graph hash: ${hashKnowledgeGraph(knowledgeGraph)}`);
} else {
  console.error(result.error.code, result.error.message);
}
```

```ts
// Stage 4 with AI assistance — wire a real @xo/ai-core provider in, or fall back automatically if it's unavailable.
import { AiCapabilityLayer, AnthropicProvider } from '@xo/ai-core';

const aiCore = new AiCapabilityLayer({
  providers: [new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! })],
  policy: { rules: [{ capability: '*', providerOrder: ['anthropic'], modelByProvider: { anthropic: 'claude-sonnet-4-6' } }] },
});

const knowledgeGraph = await extractKnowledgeGraph(experienceDoc, { aiCore, domainHint: 'corporate contract law' });
```

```ts
// Stage 5 — capability extraction, rule-based only.
import { extractCapabilityGraph, hashCapabilityGraph } from '@xo/compiler';

const capabilityGraph = await extractCapabilityGraph(experienceDoc, knowledgeGraph);
for (const cap of capabilityGraph.capabilities) {
  console.log(`[${cap.category}] ${cap.canonicalName}${cap.aliases.length ? ` (aka ${cap.aliases.join(', ')})` : ''} — confidence ${cap.confidence}`);
  if (cap.dependencies.length > 0) console.log(`  depends on: ${cap.dependencies.join(', ')}`);
}
for (const rel of capabilityGraph.relationships) {
  console.log(`  ${rel.fromCapabilityId} --${rel.type}--> ${rel.toCapabilityId}`);
}
console.log(`capability graph hash: ${hashCapabilityGraph(capabilityGraph)}`);

// With AI assistance, same aiCore instance as Stage 4:
const aiAssistedCapabilityGraph = await extractCapabilityGraph(experienceDoc, knowledgeGraph, { aiCore, domainHint: 'corporate contract law' });
```

## Stage 8: Multi-Source Frontends & Source Normalization (`src/sources/`, `src/pipeline/compile-sources.ts`)

Everything above Stage 7 assumed one specific way in: a PDF, loaded by
`NodePdfLoader` and structurally parsed by `parseDocument`. Stage 8 keeps
that pipeline completely intact and puts a **source-frontend boundary**
in front of it, so a PDF, a plain-text/markdown document, an HTML page,
or a JSON/CSV record set can all be normalized into the same shape and
handed to the *exact same* Stage 3-7 pipeline — with zero branching on
source type anywhere in Stage 3 (`semantic/`), Stage 4 (`knowledge/`),
Stage 5 (`capabilities/`), or Stage 7 (`reasoning/`).

```text
PDF ─────────┐
Document ────┤
HTML ────────┼──►  SourceFrontend  ──►  CanonicalSource  ──►  (unchanged) chunkDocument
Structured ──┤        (src/sources/)      (ParsedDocument-      Stage 4/5/7 extraction
Image ───────┘                             shaped, or binary-    compileXoir
                                            only for images)
```

### Canonical source model (`src/sources/types.ts`)

A `CanonicalSource` is the one thing every frontend produces and the
only thing the rest of the compiler ever sees:

```ts
interface CanonicalSource {
  sourceId: string;              // deterministic content hash — never Date.now()/random
  sourceType: 'pdf' | 'document' | 'image' | 'html' | 'structured';
  sourcePath: string;             // human-facing label (filename, URL, caller-supplied)
  content: DocumentSourceContent | BinarySourceContent;
  metadata: Readonly<Record<string, string>>;
  semanticExtractionAvailable: boolean;
}
```

`content.kind === 'document'` carries a `ParsedDocument` — the exact same
type `parseDocument` (Stage 2) already produces for a PDF — plus a
best-effort `plainText` and `documentTitle`. `content.kind === 'binary'`
(currently: images only) carries just `mimeType`/`byteLength`/optional
`dimensions`; there is nothing for Stage 3+ to consume, and
`semanticExtractionAvailable` is `false` so that fact is explicit, not
implied.

### The `SourceFrontend` contract and registry (`frontend.ts`, `registry.ts`)

```ts
interface SourceFrontend<TInput = unknown> {
  readonly sourceType: SourceType;
  canHandle(input: unknown): input is TInput;
  ingest(input: TInput, context?: SourceIngestContext): Result<CanonicalSource, SourceError>;
}
```

`SourceFrontendRegistry` holds a set of these: `register`/`resolve` for
explicit lookup by declared type, `detect` for probing an untagged input
against every registered frontend's `canHandle` (in registration order),
and `ingest` as the one-call `detect` + `ingest` convenience that turns
"nothing matched" into a clear `SourceError`. `createDefaultRegistry()`
(`default-registry.ts`) returns a registry with every frontend below
already registered.

### Supported source types — fully supported vs. extensibility-only

| Type | Frontend | Status | Notes |
|---|---|---|---|
| `pdf` | `PdfSourceFrontend` | **Fully supported** | The existing `NodePdfLoader` + `parseDocument` (Stage 1-2), unmodified, wrapped behind the frontend boundary. Detects untagged `{ bytes, sourcePath }` via the `%PDF-` magic header, or accepts explicit `{ kind: 'pdf', ... }`. |
| `document` | `DocumentSourceFrontend` | **Fully supported** | Plain-text / lightly markdown-marked-up text (this repo had no separate DOCX/RTF ingestion to preserve — this is new capability, not a PDF refactor). Blank-line-separated paragraphs; `#`.."######" headings; `-`/`*`/`1.` list items. Builds a `ParsedDocument` directly via `buildSections` (the same section-nesting Stage 2 uses), rather than reimplementing Stage 2's PDF-specific line-grouping/font-stats machinery. |
| `html` | `HtmlSourceFrontend` | **Fully supported** | Deterministic, fixture-based `<h1-6>`/`<p>`/`<li>` extraction with entity decoding and inner-tag stripping. No network access, no crawler — a `url` field is accepted purely as a provenance label for HTML the caller already fetched. `<script>`/`<style>` contents are stripped before scanning so they can never be mistaken for page content. |
| `structured` | `StructuredSourceFrontend` | **Fully supported** | JSON (array-of-objects or a single object) and CSV (naive comma-split, no quoted-field support — a documented limitation, not a bug). Each record becomes one heading block ("Record N") plus one paragraph block per field, so field-level provenance survives (see below). |
| `image` | `ImageSourceFrontend` | **Extensibility-only** | Represents bytes, MIME type (sniffed from PNG/JPEG/GIF/WEBP magic headers, or caller-supplied), and pixel dimensions (only for PNG/GIF, where the header is trivial to read without a real decoder — never guessed for other formats). `semanticExtractionAvailable` is always `false`: there is no OCR/vision dependency in this repository to wire up, and Stage 8 deliberately does not add one. A future OCR/vision frontend can upgrade this without any change to `CanonicalSource`, the registry, or Stage 3+. |

None of the "fully supported" frontends duplicate Stage 4/5/7's
extraction logic — they only build a `ParsedDocument`, and everything
from `chunkDocument` onward runs completely unmodified.

### Synthetic provenance for non-PDF document content (`block-source-helpers.ts`)

`document/types.ts`'s `Provenance` (`{ page, yRange }`) is genuinely
PDF-shaped — real PDF user-space y-coordinates — and Stage 8 does not
redesign it. Non-PDF frontends reuse the type honestly rather than
claiming real coordinates they don't have:

- `document`/`html`: single logical page (`page: 1`), with `yRange` a
  strictly-descending counter over the block stream so ordering is still
  recoverable from provenance alone.
- `structured`: `page` is the 1-based **record index** — "record 42"
  reads the same way a PDF citation ("page 7") does — and `yRange`
  reflects the field's position within that record, so a specific field
  of a specific record remains individually attributable.

This is never presented as a real spatial coordinate; it is documented
as synthetic in both the code and here.

### Multi-source compilation (`src/pipeline/compile-sources.ts`)

```ts
import { compileSource, compileSources } from '@xo/compiler';

// One source:
const result = await compileSource({ kind: 'pdf', bytes, sourcePath: 'nda.pdf' });

// Several heterogeneous sources compiled together into one XOIR graph:
const merged = await compileSources([
  { kind: 'pdf', bytes: pdfBytes, sourcePath: 'nda.pdf' },
  { kind: 'html', html: faqHtml, sourcePath: 'faq.html', url: 'https://example.com/faq' },
  { kind: 'structured', format: 'json', text: partiesJson, sourcePath: 'parties.json' },
]);

if (merged.ok) {
  console.log(merged.value.stats, merged.value.sources); // per-source report: sourceId, sourceType, unitCount, semanticExtractionAvailable
}
```

`compileSources` does **not** run N independent compilers and merge
their outputs afterward. It normalizes every input to a
`CanonicalSource` first, chunks each document-shaped source with the
*unmodified* Stage 3 `chunkDocument` (each source's own `sourceId` as its
`documentPath`), merges the resulting `ExperienceDocument`s into one, and
then runs Stage 4 (`extractKnowledgeGraph`), Stage 5
(`extractCapabilityGraph`), and Stage 7 (`extractReasoningGraph`) **once**
over the merged document — the same shared extraction pipeline a
single-PDF compile already used, executed exactly once regardless of how
many sources went in.

This is collision-safe because every `ExperienceUnit.id`
(`semantic/unit-id.ts`) is a content hash that includes `documentPath`,
and every source is chunked under its own unique `sourceId` — two sources
with byte-identical text still produce disjoint unit ids, and units are
never accidentally merged across sources. Relationships are concatenated
as-is; Stage 8 never invents a relationship between units from two
different sources.

Non-textual sources (currently: `image`) are ingested, hashed, and
reported in the result's `sources` array with
`semanticExtractionAvailable: false` and `unitCount: 0` — never silently
dropped, and never faked into contributing content they can't support. A
batch made up **only** of non-textual sources fails explicitly (there is
nothing for Stage 4+ to run on) rather than returning a technically-valid
but practically-empty `XoirGraph`.

Ingestion is fail-fast: the first input that no frontend can handle, or
that its frontend rejects as malformed, aborts the whole batch with a
`SourceError` — a batch compile is one job, and a bad input partway
through it is a real error the caller should see immediately, not a
silently-incomplete result.

### Error handling

`SourceError` (`@xo/errors`) is the error type for every source-ingestion
failure. It deliberately **reuses this platform's existing generic
`ErrorCode` values** — `NOT_FOUND`, `ALREADY_EXISTS`, `INVALID_ARGUMENT`,
`PRECONDITION_FAILED`, `SERIALIZATION_PARSE_FAILED`,
`SERIALIZATION_SCHEMA_MISMATCH` — rather than minting new `SOURCE_*`
codes. The reason is a real cross-package constraint, not a style
preference: `apps/api`'s HTTP error-mapping layer enumerates every
`ErrorCode` value and has its own test asserting every one has an
explicit HTTP status mapping, and `apps/api` is out of scope for this
package's work. Reusing already-mapped codes means Stage 8 needs zero
changes anywhere outside `@xo/compiler` (and `@xo/errors`'s `SourceError`
class itself, which is additive). The specific failure reason is always
in the error's `message` and `context`, exactly like every other
generic-code error elsewhere in this platform.

### Determinism

Every frontend is deterministic: `sourceId` (`source-id.ts`) is a SHA-256
content hash over `(sourceType, sourcePath, content)`, never
`Date.now()`, `Math.random()`, or a random UUID. Re-ingesting identical
input always produces an identical `CanonicalSource`, and re-running
`compileSources` over an identical batch always produces an identical
`XoirGraph` (same node/edge counts, same source ids) — see
`test/sources/*.test.ts`'s determinism tests.

### What Stage 8 explicitly does not do

- No OCR, computer vision, video/audio understanding, web crawling,
  browser automation, or transcription — `image` is deliberately
  extensibility-only, and there is no `audio`/`video` frontend at all
  yet (adding one is a new frontend module, per the pattern above,
  with zero change to Stage 3-7).
- No network access from any frontend — `html`'s `url` field is a
  provenance label only.
- No redesign of `ParsedDocument`, `Provenance`, `ExperienceDocument`,
  `KnowledgeGraph`, `CapabilityGraph`, `ReasoningGraph`, or XOIR.
  Stage 1-7 are byte-for-byte unchanged by Stage 8.
- No second extraction pipeline: `document`/`html`/`structured` all
  terminate at `ParsedDocument` and flow through the same
  `chunkDocument` → Stage 4/5/7 path a PDF always did.

### Known limitations

- CSV parsing is naive (comma-split, no quoted-field/embedded-comma
  support).
- HTML extraction recognizes headings, paragraphs, and list items only
  — no tables, no CSS-based readability/boilerplate removal.
- Image dimension extraction only reads PNG/GIF headers; other formats
  are recognized by MIME type but report no dimensions rather than
  guessing.
- `compileSources` fails the whole batch on the first bad input rather
  than returning a partial result with per-source errors — a deliberate
  simplicity choice for this stage, not a technical ceiling.
