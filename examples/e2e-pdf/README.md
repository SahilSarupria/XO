# XO Platform — First Real PDF E2E Vertical Harness

A single, isolated, repeatable diagnostic script that pushes a real PDF as
far as the *current* XO Platform's real public APIs will actually take it,
and reports exactly where it stops. It is a measurement tool, not a demo:
it does not fabricate, mock, or hand-construct any stage to force a PASS.

## Purpose

Compiler Stages 1–7, the Package SDK, the Registry, and Runtime Stages
1–5 all exist and are independently tested. What was missing was one
harness that chains them together against a real document and tells you,
honestly, how far a PDF can currently travel end-to-end — and exactly
which integration boundary stops it. That's what this is.

## Fixture

`examples/vertical-test/burglary-policy.pdf` — the one PDF already
present in this repository. It is a blank insurer output-generation
template (5 pages, no filled-in customer/PAN/Aadhaar/KYC data), so it
satisfies the "non-sensitive blank policy/regulatory template" fixture
requirement without adding a new file to the repo.

## Command

From the repo root:

```
npm run e2e:pdf
```

or directly:

```
npx tsx examples/e2e-pdf/run.ts
```

Exit code is `0` for a normal diagnostic run (including one that reports
`BLOCKED`/`NOT_APPLICABLE` boundaries — those are honest measurements, not
failures) and non-zero only if a real, unexpected error occurred calling
an API that is supposed to exist and work (an `ERROR` boundary).

## What it exercises

```
PDF (burglary-policy.pdf)
  -> NodePdfLoader.load()                         [@xo/compiler]
  -> parseDocument()                               [@xo/compiler]
  -> chunkDocument()                                [@xo/compiler]
  -> extractKnowledgeGraph()                        [@xo/compiler]
  -> extractCapabilityGraph()                       [@xo/compiler]
  -> extractReasoningGraph()                        [@xo/compiler]
  -> compileXoir({ kind: 'combined', ... })         [@xo/compiler -> @xo/xoir]
  -> ManifestBuilder / Ed25519Signer / packBundle() [@xo/package-sdk]
  -> unpackArchive / PackageValidator / Verifier    [@xo/package-sdk]
  -> RegistryClient.publish/search/get()            [@xo/registry]
  -> PackageInstaller.install()                     [@xo/package-sdk]
  -> Runtime.mount() / PackageLoader                [@xo/runtime]
  -> CapabilityRegistry.all() (discovery)           [@xo/runtime]
  -> ExecutionEngine.execute()   (only if a real executable capability exists)
  -> FileRuntimeStore (sessions/receipts)            (only if execution completed)
```

Every function above is a real, currently-exported public API — nothing
in `run.ts` hand-constructs a `KnowledgeGraph`/`CapabilityGraph`/
`ReasoningGraph`/`XoirGraph`, hand-builds a `.xo` archive, or fabricates a
Runtime capability. `run.ts`'s own top-of-file comment documents exactly
which functions are called and why, stage by stage.

**No Stage 8 orchestrator was written or duplicated.** Stage 8 (still
in progress in another workstream) is expected to eventually wrap
"PDF -> XOIR" into one convenience function. Until it exists, this
harness — as an ordinary *caller* of the compiler package — chains the
existing Stage 1–7 public functions itself, exactly the way any other
current caller of `@xo/compiler` would have to.

## Output artifacts

Written to `examples/e2e-pdf/output/` (not `.gitignore`d, small,
JSON-only — no binaries):

| File | Contents |
|---|---|
| `e2e-report.json` | The full boundary-by-boundary report — the primary artifact |
| `source.json` | Loaded PDF summary (pages, metadata, per-page text stats) |
| `compiled-xoir.json` | The full canonical `XoirGraph` JSON (`@xo/xoir#toJson`) |
| `diagnostics.json` | XOIR pipeline validation/normalization diagnostics + pass runs |
| `package-inspect.json` | `inspectBundle()` output + validation report + signature check |
| `registry-result.json` | Publish/search/resolve results + the registry storage limitation |
| `execution-result.json` | The full `ExecutionResult`, or the reason execution was skipped |
| `receipt.json` | The `ExecutionReceipt`, only written if an execution actually completed |

Temporary package/registry/install/runtime-store state (the actual
`.xo` file, the local registry's blob store, the install directory, the
runtime store) lives in a fresh `mkdtemp()` directory per run and is
deleted at the end of the run — it is never written into the repo. Every
run uses fresh isolated state, so the harness is safely repeatable and
never corrupts a real local registry or install.

## Boundary statuses

Every boundary in `e2e-report.json.boundaries` is exactly one of:

- **`PASS`** — the real API was called and did what it's documented to do.
- **`BLOCKED`** — the real API was called, but the platform's current
  state (an architecture gap, a validation failure, a missing capability)
  stops the flow from continuing here.
- **`NOT_APPLICABLE`** — this stage doesn't apply given what happened
  upstream (e.g. "persistence" when no execution ever ran) — not faked
  just to produce a status.
- **`ERROR`** — a real, unexpected failure calling an API that's
  supposed to work. This is the only status that sets the harness's
  non-zero exit code.

## Known limitations (read this before trusting a PASS)

### 1. Registry artifact storage

`RegistryClient.publish()` verifies a full `PackageBundle`, but
`FsPackageRepository`/`PackageRepository` (`@xo/registry-core`) only
ever store and return a `PackageRecord` — `{ id, manifest, publishedAt }`.
There is no method anywhere in `packages/registry` or
`packages/registry-core` that accepts or returns component bytes. So
`RegistryClient.get()` genuinely resolves the manifest record (that part
works, and is reported `PASS`), but a package **cannot** be
reconstituted into an installable `.xo` bundle from the registry alone.
This harness does not pretend otherwise: `package_install_load` installs
from the local `.xo` archive path, not from anything read back through
the registry. A real registry service would need a component-blob
storage layer added to close this gap — out of scope for this harness.

### 2. Compiler `Capability` vs. Runtime `CapabilityDeclaration`

The compiler's `Capability` (`packages/compiler/src/capabilities/types.ts`
— category, signature, determinism, side effects, provenance) and the
manifest's `CapabilityDeclaration` (`packages/types/src/xo-capability.ts`
— id, name, description, `providerCompatibility: ModelFamily[]`,
`estimatedCost`, `estimatedLatencyMs`, `confidence`) are structurally
unrelated types. **No function anywhere in this repository converts one
into the other.** This harness never fabricates that conversion — a
generated package's `manifest.capabilities` only ever reflects
capabilities this harness can honestly attribute to real extraction
output, which for `burglary-policy.pdf` is zero (`extractCapabilityGraph()`
found no capability-shaped content in this document — see step 5 in the
report; not an error, an accurate result for this specific document).
Because of that, Runtime capability discovery legitimately finds nothing
to execute, and `runtime_execution`/`persistence`/`memory` are correctly
`NOT_APPLICABLE`, not forced passes or forced blocks.

The harness's execution/persistence code path itself is not
theoretical — it was verified against `packages/runtime/test/fixtures.ts`'s
`buildContractLawyerBundle()` (a package that *does* declare manifest
capabilities) during development of this harness, and completed/persisted
correctly. It's real, working code; it's simply not reached for this PDF.

### 3. XOIR has no manifest `ComponentKind`

`@xo/types`' `ComponentKind` union — `knowledge_graph`,
`long_term_memory_graph`, `decision_trees`, `reasoning_traces`,
`case_library`, `prompt_strategies`, `lora`, `finetune`, `safety_rules`,
`benchmark_suite` — has no `"xoir"` entry. This harness does not invent
one. The compiled XOIR's canonical serialization (`@xo/xoir#toJson`) is
embedded, unmodified, inside the existing `knowledge_graph` component
slot as the closest legitimate existing fit, **and** is separately
preserved in full as `output/compiled-xoir.json` so nothing is lost to
that choice of container. A future package-format revision adding a
first-class `xoir` component kind would let a package carry its compiled
XOIR natively instead.

## How to interpret a run

Read `output/e2e-report.json`:

- `overallResult`: `PASS` if every reached boundary was `PASS` or
  legitimately `NOT_APPLICABLE`; `BLOCKED` if any boundary was `BLOCKED`;
  `ERROR` if anything threw unexpectedly.
- `firstBlockingBoundary` / `firstHardError`: where to look first.
- `boundaries.<key>`: full status + human-readable reason + detail for
  every stage in the pipeline above.
- `knownArchitecturalBoundaries`: the three limitations above, in
  machine-readable form.

For `burglary-policy.pdf` today: every stage through `package_install_load`
and `runtime_capability_discovery` is `PASS`; `runtime_execution`,
`persistence`, and `memory` are `NOT_APPLICABLE` because this specific
document doesn't contain capability-shaped content for the current
rule-based extractor to find. That is the real, current measurement —
not a partial failure, and not something this harness works around.
