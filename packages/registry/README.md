# @xo/registry

Local-filesystem implementation of `@xo/registry-core`'s four frozen
interfaces — `PackageRepository`, `BenchmarkRepository`,
`LicenseRepository`, `Ledger` — plus a `RegistryClient` facade that ties
them together and is what the CLI's `registry` command group (`xo
publish`, `xo search`, `xo registry inspect`) actually depends on.

No network access, matching the same sandbox constraint
`@xo/package-sdk` and `@xo/ai-core` already document for themselves:
everything here runs against `@xo/storage`'s `LocalFsBlobStore`. The
registry's actual integrity guarantee — that a published package hasn't
been tampered with — comes from `@xo/crypto`'s content hashing, Merkle
roots, and signing, the same category of verification npm/apt/Sigstore
already rely on; the `Ledger` sits on top of that as a local,
tamper-evident audit trail, not as the source of the guarantee itself.
See "Known limitations" below for exactly what a local-only audit trail
trades away.

## Module map

| Module | Responsibility |
|---|---|
| `clock.ts` | `Clock`/`SystemClock` — the same local time-port pattern `@xo/package-sdk/src/install/clock.ts` uses, so `recordedAt`/`publishedAt` timestamps go through an injected port instead of a bare `new Date()`. |
| `ledger/hash-chained-ledger.ts` | `HashChainedLedger`: the `Ledger` implementation. Each entry's `entryHash` is derived from its `payloadHash`, `recordedAt`, and the *previous* entry's hash; `verify()` walks the chain back to genesis, so tampering with any earlier entry is caught, not just the one directly checked. |
| `package/fs-package-repository.ts` | `FsPackageRepository`: the `PackageRepository` implementation, content-addressed by `manifest.merkleRoot`. Also exposes `listAll()` (not part of the frozen interface — see "Design choices" below). |
| `benchmark/fs-benchmark-repository.ts` | `FsBenchmarkRepository`: the `BenchmarkRepository` implementation. Stores a `BenchmarkRun`'s inputs verbatim — never summarizes or discards them — per the "falsifiable trust" framing in `registry-core`'s own docstring. |
| `license/fs-license-repository.ts` | `FsLicenseRepository`: the `LicenseRepository` implementation, plus the standalone `validateRoyaltySplit` helper that enforces the "`royaltySplit` basis points sum to exactly 10000" invariant before any write. |
| `client/registry-client.ts` | `RegistryClient`: the facade — `publish`, `get`, `search`, `listByCreator`, `recordBenchmark`, `getBenchmark`, `listBenchmarksForPackage`, `createLicense`, `getLicense`, `verifyLedgerEntry`. This is where `@xo/package-sdk`'s `PackageValidator.validateAll()` actually runs before a package is ever published — see below. |

## Design choices worth knowing about

- **Verification happens in `RegistryClient.publish()`, not in
  `FsPackageRepository.publish()`.** `PackageRepository.publish(record:
  PackageRecord)` is a frozen interface, and `PackageRecord` is just `{
  id, manifest, publishedAt }` — no component bytes. That means the
  repository itself can never run `PackageValidator.validateAll()`,
  which needs a full `PackageBundle` (manifest *and* every component's
  actual data) to check content hashes and the Merkle root against real
  bytes, not just against what the manifest *claims* about itself. So
  the task's "never trust an unverified manifest" requirement is
  enforced one layer up: `RegistryClient.publish()` is the method that
  receives the full `PackageBundle`, runs `validateAll()`, and only
  constructs a `PackageRecord` — and calls
  `FsPackageRepository.publish()` with it — once verification passes.
  `FsPackageRepository.publish()` still does what it *can* check from a
  bare manifest as defense-in-depth (schema shape via `isXoManifest`,
  that `merkleRoot` is actually present, that the caller's `id` matches
  `manifest.merkleRoot`, duplicate-publish rejection) — but a caller who
  reaches for `FsPackageRepository` directly, bypassing `RegistryClient`,
  gets none of the hash/Merkle/signature guarantees. `RegistryClient` is
  the intended entry point for exactly this reason.
- **Content-addressed by `merkleRoot`, not a generated id.** Every
  `PackageRecord.id` *is* `manifest.merkleRoot` — publishing the same
  package content twice is a rejected duplicate
  (`REGISTRY_PACKAGE_ALREADY_PUBLISHED`), not a silent overwrite, and two
  packages can never collide on id unless their content is identical.
  `BenchmarkRun.id` and `LicenseRecord.id`, by contrast, aren't
  content-addressed — a package can legitimately have many benchmark runs
  and licenses with identical fields but distinct identities, so those
  get a fresh `randomUUID()` each (via `@xo/types`' `BenchmarkRunId`/
  `LicenseId` brand constructors) inside `RegistryClient`, not inside
  the repositories, which just persist whatever id they're handed.
- **`Ledger.append()` returns an `entryHash` distinct from the
  `payloadHash` it was given, and `verify()` takes the former, not the
  latter.** A caller who only knows a package's `id` (its `merkleRoot`)
  has no way to ask "was this verified?" without also knowing the
  ledger's own internal entry hash. Every mutating `RegistryClient`
  method (`publish`, `recordBenchmark`, `createLicense`) therefore
  returns its domain record *plus* `ledgerEntryHash` — the value
  `verifyLedgerEntry()` actually expects — rather than making a caller
  guess or re-derive it.
- **`search()` needs "every published package", which
  `PackageRepository` deliberately doesn't offer.** The frozen interface
  only has `listByCreator` — a genuinely per-creator API, not a
  full-catalog browse. `FsPackageRepository.listAll()` is an extra
  method on the *concrete* class (not smuggled into the interface) that
  `RegistryClient.search()` uses to do a simple case-insensitive
  substring match over name/creator/capability text. This is a linear
  scan over the whole catalog; it's fine for what this sandbox will ever
  hold, and `listAll()` is the seam a real implementation would replace
  with a query engine or search index.
- **Functional core, imperative shell**, matching `runtime`'s and
  `package-sdk`'s own convention: every domain record this package reads
  or writes (`PackageRecord`, `BenchmarkRun`, `LicenseRecord`,
  `LedgerEntry`) is a plain immutable value; only the repository/ledger
  classes themselves (holding a `BlobStore`) are stateful.
- **`Result<T, E>` everywhere**, never a thrown exception, for every
  method on every interface and on `RegistryClient` itself.

## Known limitations (stated honestly, not smoothed over)

- **`HashChainedLedger` is tamper-*evident*, not tamper-*resistant*.**
  Altering any entry (or the chain's order) changes every subsequent
  `entryHash`, and `verify()` walks the whole chain back to genesis to
  catch that — so tampering is always *detectable* after the fact. But
  this is a local log backed by a local `BlobStore`, with no protection
  against someone with direct write access to that backing storage. This
  is a deliberate scoping choice, not a stopgap: the registry's actual
  security requirement — verifying a package hasn't been tampered with —
  is fully met by `@xo/crypto`'s hashing, Merkle roots, and signing (see
  `RegistryClient.publish()`), the same category of guarantee
  npm/apt/Sigstore already provide without a distributed ledger. A local,
  tamper-evident audit log on top of that is a genuinely useful, low-cost
  thing to have; it isn't standing in for a consensus system this
  registry doesn't need.
- **No network access, so no real networked registry service.**
  Everything here is `LocalFsBlobStore`-backed. `publish`/`get`/`search`
  all operate against whatever `--registry <dir>` points at locally;
  there's no multi-party registry, no remote catalog, no federation.
- **Publish's primary write and its creator-index write aren't
  transactional.** `FsPackageRepository.publish()` does two `BlobStore`
  writes (the record itself, then a duplicate copy under a per-creator
  index key for `listByCreator`) with no multi-key transaction primitive
  underneath — `LocalFsBlobStore` doesn't offer one. A crash between the
  two writes could in principle leave a package readable via `get()` but
  missing from `listByCreator()`. Not observed in testing, since both
  writes happen synchronously back-to-back with no I/O in between, but
  worth stating rather than implying a stronger guarantee than what's
  actually there.
- **No benchmark re-run or challenge adjudication.** `BenchmarkRepository`
  stores a `BenchmarkRun`'s inputs verbatim so a claim *can* be re-run and
  challenged later — but actually re-running a benchmark or resolving a
  challenge against a disputed score is not something this package does;
  that's a consumer's job, sitting on top of `listForPackage`/`get`.
- **`search()` is a linear substring scan**, not a real search index —
  see "Design choices" above.
- **No signature-verification key distribution.** `RegistryClient`
  constructs its own `PackageValidator` with no `resolvePublicKey`
  option, matching `xo verify`'s own default: a signed manifest's
  signatures are reported as unverified (a warning) rather than failed,
  unless a caller supplies keys. `RegistryClient` doesn't currently
  expose a way to supply them — `RegistryClientOptions.validator` lets a
  caller construct and inject their own `PackageValidator` (with a
  resolver) if this matters to them, but there's no first-class flag or
  CLI option for it yet.

## Judgment calls the missing specs left to this package

`specs/SPECIFICATION.md` is empty in this repo snapshot, and
`XO_PROTOCOL.md`/`RUNTIME_ARCHITECTURE.md`/`EXPERIENCE_COMPILER.md`
aren't present at all. Everywhere this package had to make a call the
spec would otherwise have settled, it's called out above by name rather
than silently decided:

- The publish-time verification boundary (repository vs. facade).
- Package content-addressing by `merkleRoot` specifically, vs. some other
  scheme.
- The ledger's hash-chaining formula (`hash(previousEntryHash +
  payloadHash + recordedAt)`) and its tamper-detection walking the full
  chain rather than checking only the entry directly asked about.
- `search()`'s match fields (name, creator DID, capability id/name/
  description) and that it's a full-catalog scan.
- Returning `ledgerEntryHash` alongside every mutating `RegistryClient`
  call, since the `Ledger` interface alone gives no way for a caller to
  learn it otherwise.
