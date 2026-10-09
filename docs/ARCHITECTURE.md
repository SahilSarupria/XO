# Architecture

This document maps the repo's structure to the frozen design docs. It does
not restate their content — read `SPECIFICATION.md`, `XO_PROTOCOL.md`,
`EXPERIENCE_COMPILER.md`, and `RUNTIME_ARCHITECTURE.md` for the actual
design.

## The intended end-to-end flow

```
Professional Knowledge
     |
     v
Experience Compiler   <-- packages/compiler-core (interfaces only)
     |
     v
Experience IR
     |
     v
XO Package            <-- packages/types (XoManifest/XoMetadata shapes),
     |                     packages/crypto (hashing/signing), packages/storage
     v
Registry               <-- packages/registry-core (interfaces only)
     |
     v
Runtime                <-- packages/runtime-core (interfaces only)
     |
     v
LLM
     |
     v
Capability Execution
     |
     v
Benchmark               <-- packages/registry-core's BenchmarkRepository (interface only)
     |
     v
Results
```

Module 1 builds every box's *foundation* — the types, errors, and
infrastructure primitives every future box will need — without
implementing any box's business logic.

## Package dependency graph

```
types  <-- errors  <-- {logger, config, serialization, di, crypto, storage, graph-engine}
                                  ^
                       logger <-- observability
                                  ^
                       logger <-- testing

compiler-core  --> types
runtime-core   --> types
registry-core  --> types, errors

apps/cli --> types, errors, logger, config
```

Nothing in `packages/*` depends on `apps/cli`; `apps/cli` is the only thing
allowed to depend on everything. `compiler-core`, `runtime-core`, and
`registry-core` depend only on `types` (+ `errors` where needed) — they
export interfaces, never implementations, so no other package can
accidentally start depending on business logic that doesn't exist yet.

## Where each frozen doc's concepts live today

- **SPECIFICATION.md §1 (package layout, manifest/metadata)** →
  `packages/types/src/xo-manifest.ts`, `xo-metadata.ts`.
- **SPECIFICATION.md §2.2 (compatibility levels)** →
  `packages/types/src/compatibility.ts`.
- **SPECIFICATION.md §4 (royalty splits)** →
  `packages/registry-core/src/license-repository.interface.ts`'s
  `RoyaltySplit` (interface only — no settlement logic).
- **SPECIFICATION.md §0/§3 (falsifiable, challengeable benchmark trust)** →
  `packages/registry-core/src/benchmark-repository.interface.ts`,
  `ledger.interface.ts` (interfaces only).
- **PACKAGE_README.md §4 (`xo pack`, Merkle root, signing)** →
  `packages/crypto/src/sha256-hasher.ts` (`buildMerkleRoot`),
  `ed25519-signer.ts`. The actual `xo pack` CLI command is not built in
  this module.
- **RUNTIME_ARCHITECTURE.md's mount/retrieve/merge/budget/safety/assemble
  pipeline** → `packages/runtime-core/src/runtime.interface.ts` (interfaces
  only).
- **EXPERIENCE_COMPILER.md's staged IR pipeline** →
  `packages/compiler-core/src/ir.types.ts`, `compiler.interface.ts`
  (interfaces only).

## What is explicitly NOT here

- Any implementation of `Compiler`, `Runtime`, or the registry
  repositories — these are the next modules.
- A production KMS/HSM-backed signer — `Ed25519Signer` is real,
  working cryptography suitable for local dev/CI, not key custody.
- A real object-storage or graph-database backend — `LocalFsBlobStore`
  and `InMemoryGraphStore` are the reference implementations; swapping
  backends means writing a new class behind the same interface, not
  changing call sites.
