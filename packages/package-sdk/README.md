# @xo/package-sdk

The canonical infrastructure for building, validating, signing, packing,
installing, and diffing `.xo` packages, per `SPECIFICATION.md` §1. This is
the library every other tool — CLI, Studio, Registry, Marketplace, CI/CD,
enterprise servers — is meant to depend on for anything touching the
package format, the same way npm's package builder, OCI image tooling, or
Cargo's package infrastructure sit underneath their respective CLIs.

It is **not** a CLI, **not** the compiler, **not** the runtime, and **not**
the registry. It has no `bin` entry and makes no network calls.

## Why one package instead of five

The task brief that kicked this off sketched five candidate packages
(`package-sdk`, `-builder`, `-validator`, `-installer`, `-verifier`,
`-signer`). They're implemented here as one package with clearly separated
internal modules instead, because every one of those responsibilities
shares the same core types (`XoManifest`, `PackageBundle`) and the same
foundation dependencies (`@xo/crypto`, `@xo/types`, `@xo/errors`), and in
practice nothing in this repo ever wants "the validator" without also
wanting "the builder" nearby (you validate the thing you just built, or
the thing you're about to install). Splitting them would have meant five
`package.json`s with near-identical dependency lists and constant
cross-package version bumps for no isolation benefit — this repo's own
`xoir` package makes the same call (graph + diff + hashing + validation +
versioning, one package). If a real reason to split emerges later (e.g. an
installer that needs to run in an environment where pulling in the
archive/tar-stream dependency is unwanted), `src/install/` is already an
isolated module with a narrow import surface, so extracting it is a
mechanical move, not a redesign.

## Module map

| Module | Responsibility |
|---|---|
| `manifest/manifest-builder.ts` | Immutable builder: `setIdentity`, `setCompatibility`, `setCapabilities`, `setMetadata`, `addComponent`, `addSignature`, `build()`. Computes every component hash and the manifest's Merkle root itself — a caller can never hand it a mismatched hash. |
| `manifest/semver.ts` | Semver parse/compare/bump-classification (hand-rolled; see "Known limitations"). |
| `manifest/compatibility.ts` | Host-capability intersection against `manifest.compatibility` (§2.1 steps 3-5, §2.2 levels). |
| `manifest/manifest-migration.ts` | A real migration-chain registry; currently zero registered steps because the frozen `XoManifest` type only has one `formatVersion` today. |
| `hashing/component-hasher.ts`, `hashing/fingerprint.ts` | Component hashing and a manifest "fingerprint" (content hash of everything except signatures — used to recognize identical package content independent of who's signed it). |
| `signing/package-signer.ts` | `PackageSigner` / `PackageVerifier`, thin wrappers over `@xo/crypto`'s `Ed25519Signer`. |
| `archive/` | `tar-codec.ts` (dependency-free ustar reader/writer — see "Known limitations"), `zstd-codec.ts` (native `node:zlib` zstd), `package-writer.ts` / `package-reader.ts` (buffer *and* streaming variants). |
| `validation/` | `schema.ts` (structural `XoManifest`/`XoMetadata`/`CapabilityDeclaration` guards) and `package-validator.ts` (hash, Merkle, required-component, duplicate-path, version, signature, and capability-consistency checks — `validateAll` never short-circuits). |
| `install/package-installer.ts` | `install` / `uninstall` / `upgrade` / `rollback` / `listInstalled` / `listAllInstalledRecords` / `getManifest` / `verifyInstallation` / `repairInstallation` over an injected `@xo/storage` `BlobStore`. No registry fetch — see below. |
| `diff/package-differ.ts` | `compareManifests`, `compareComponents`, `comparePackages`, `generateUpgradePlan`. |
| `inspect/package-inspector.ts` | Read-only summary (`inspectBundle`) and per-host compatibility matrix (`inspectCompatibilityMatrix`) for tools that need to *show* a package. |

## Design choices worth knowing about

- **Everything immutable.** `ManifestBuilder` methods each return a new
  builder; `build()` returns a `Object.freeze`d `PackageBundle`. Nothing
  downstream can mutate a manifest after it's been hashed/validated
  against.
- **`Result`, not exceptions, for expected failures.** Corrupt archives,
  hash mismatches, invalid signatures, and version conflicts are `Result`
  returns (`@xo/types`), per `docs/CODING_STANDARDS.md` — they're expected
  outcomes a caller must branch on, not programmer errors.
- **zstd via `node:zlib`, no external native dependency.** Node has shipped
  built-in zstd support in `node:zlib` since 22.15 (verified present on
  this repo's Node 22.22 runtime); using it means the archive layer has no
  native-binding dependency (`@mongodb-js/zstd` and similar need
  per-platform prebuilt binaries this SDK can't guarantee for every
  consumer). `src/archive/node-zlib-zstd.d.ts` is a small ambient-type
  augmentation because the pinned `@types/node` (`^20.14.0`) predates
  these APIs in its type definitions, even though they're real at runtime.
- **Stream error propagation is handled explicitly.** `.pipe()` does not
  forward source-stream errors to its destination in Node — both
  `zstd-codec.ts` and `tar-codec.ts` attach explicit `'error'` listeners
  so a corrupt or non-zstd archive surfaces as a `Result`, never an
  unhandled exception that crashes the host process.
- **Capabilities are first-class, never inferred.** `manifest.capabilities`
  (`CapabilityDeclaration[]`, in `@xo/types`) is what `@xo/runtime`'s
  capability registry and negotiator read — a package's `id`, `name`,
  `description`, `providerCompatibility`, `requiredComponents`,
  `estimatedCost`, `estimatedLatencyMs`, and `confidence` per capability,
  set via `ManifestBuilder.setCapabilities(...)` and checked for internal
  consistency by `PackageValidator.validateCapabilities` (duplicate ids,
  a `requiredComponents` entry the package doesn't actually declare,
  out-of-range confidence, negative cost/latency). Optional and additive
  — a manifest that never calls `setCapabilities` declares zero
  capabilities, not "capabilities inferred from `metadata.json`'s
  `domain`/`scope`", which this format deliberately never does.
- **New error codes, appended, not invented ad hoc.** `PACKAGE_*` and a
  handful of installer codes were added to `packages/errors/src/error-codes.ts`
  following its own documented append-only rule, plus `PackageError` /
  `InstallError` domain classes in `domain-errors.ts` — reusing the
  existing `XoError` machinery rather than building a parallel one.
- **`Clock` is a local port, not `@xo/testing`'s `SystemClock`.**
  `@xo/testing` is a test-doubles package everywhere else in this repo (no
  other package takes it as a runtime dependency); the installer needed a
  real, injectable clock, so `src/install/clock.ts` defines its own
  minimal `Clock`/`SystemClock` rather than reaching into a test package
  from production code.

## Known limitations (stated honestly, not smoothed over)

- **`tar-codec.ts` is a hand-rolled ustar codec, not the `tar-stream`
  package.** This SDK was originally written against `tar-stream`, but
  the sandbox this was integrated in has no network access to install
  it. The four functions `package-writer.ts`/`package-reader.ts` actually
  call (`tarEntriesToStream`, `tarEntriesToBuffer`, `tarStreamToEntries`,
  `tarBufferToEntries`) kept their exact signatures, so this is invisible
  to every caller; internally it's a minimal POSIX ustar reader/writer
  (regular files only, ustar's ~255-byte name+prefix path limit — both
  comfortably sufficient for `.xo` archives per SPECIFICATION.md §1.1).
  If a real `tar-stream` install ever becomes available, swapping the
  internals back is a self-contained change to this one file.

- **No registry integration.** The installer's job is local install-state
  management against a `BlobStore` a caller already has a `PackageBundle`
  for. Fetching a package *from* a marketplace is explicitly out of scope
  per the brief this package was built against ("Support future registry
  integration but DO NOT implement the registry") — `PackageInstaller`'s
  constructor takes only a `BlobStore`, which is the seam a future
  registry client would sit behind.
- **Key custody is entirely the caller's problem.** `PackageSigner` accepts
  raw PEM key material and signs with it; it does nothing about where that
  key comes from. This matches how `PACKAGE_README.md` (the flagship
  Corporate Contract Lawyer XO) describes the real production signing
  step: "this is a real operational step involving real key material,
  which doesn't exist in a demo context." A KMS/HSM-backed `Signer`
  implementation is a drop-in for `@xo/crypto`'s `Signer` interface, not a
  change this package needs to make.
- **`semver` is hand-rolled**, not the `node-semver` package. The parse /
  compare / classify-bump surface this SDK actually exercises is small and
  stable against semver.org's grammar; pulling in a dependency for it
  seemed like more surface area than value. It does not implement semver
  *ranges* (`^1.2.3`, `~1.2.3`) — nothing in this SDK currently needs them
  (compatibility resolution is by declared capability, not version range).
  If a future consumer needs range matching, that's an argument for adding
  it here rather than reaching for `node-semver` piecemeal.
- **Manifest migration has zero registered migrations.** Not a stub — the
  `ManifestMigrationRegistry` class is fully implemented and tested with
  synthetic version chains — but there is genuinely only one
  `formatVersion` in the frozen `XoManifest` type as of this writing, so
  there is nothing real to migrate *from* yet.
- **`Zstd`'s type augmentation should be deleted once `@types/node` catches
  up.** It's a small, contained shim (`src/archive/node-zlib-zstd.d.ts`),
  not a permanent fixture.

## Package lifecycle (typical flow)

```
ManifestBuilder.create()
  .setIdentity(...).setCompatibility(...).setMetadata(...)
  .addComponent(...).addComponent(...)
  .build()                                  // -> Result<PackageBundle>
    -> new PackageValidator().validateAll() // -> ValidationReport
    -> new PackageSigner().sign(...)        // -> SignatureEntry, then .addSignature(...).build() again
    -> packBundle(bundle)                   // -> Uint8Array (.xo archive bytes)

unpackArchive(bytes)                        // -> Result<PackageBundle>
  -> new PackageValidator().validateAll()   // re-validate an untrusted archive before trusting it
  -> new PackageInstaller(blobStore).install(bundle)
```

## Extension points

- **Registry client**: implement fetch-then-`unpackArchive` against
  whatever the real marketplace transport turns out to be; feed the
  resulting `PackageBundle` into `PackageInstaller`.
- **Trust authorities**: `PackageVerifier.verifyAll` already takes a
  `resolvePublicKey(signerDid) => string | undefined` callback instead of
  a single fixed key — a future trust-authority lookup (DID resolution,
  a co-signer allowlist) is a different implementation of that same
  callback, not a change to the verifier.
- **Manifest migrations**: register `ManifestMigration` steps on a shared
  `ManifestMigrationRegistry` instance as `formatVersion` bumps happen.
- **Alternative `BlobStore` backends**: `PackageInstaller` only depends on
  the `@xo/storage` `BlobStore` interface (already swappable to S3/GCS/R2
  per that package's own docs) — nothing here is filesystem-specific.

## Testing

```
npm test              # node --test, 80 tests
npm run test:coverage # line/branch/function coverage report
```

Tests cover, among other things: corrupted archives (bad zstd, bad tar,
missing `manifest.json`), invalid signatures, hash and Merkle-root
mismatches, duplicate component paths, version conflicts (downgrades,
same-version "upgrades"), install/uninstall/upgrade/rollback/repair
scenarios against a real `LocalFsBlobStore`, streaming vs. buffer archive
round-trips, capability declaration/validation (duplicate ids, undeclared
required components, out-of-range confidence), and multi-version
discovery (`listAllInstalledRecords`, `getManifest`) for `@xo/runtime`'s
benefit.
