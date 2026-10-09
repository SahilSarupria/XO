# 0007: Capabilities are a first-class, declared part of the package format

## Status

Accepted

## Context

Runtime Stage 1 needs to expose what a mounted package can *do* —
`contract_analysis`, `fraud_detection`, `radiology`, and so on — as
structured data a `CapabilityRegistry` can index and a
`CapabilityNegotiator` can rank. The obvious shortcut was to derive this
from `metadata.json`'s existing free-text `domain` and `scope` fields,
which every package already carries.

That shortcut was rejected before any runtime code was written. A
package's `metadata.json` is descriptive prose aimed at a human or a
marketplace listing — `domain: "legal"`, `scope: ["contract_review"]` —
not a contract a negotiator can safely rank, filter, or route on. Two
packages with identical `scope` entries could mean genuinely different
things by them; a `CapabilityNegotiator` slugifying `scope` strings into
capability ids would be inferring structure that was never actually
declared, and would have no principled way to attach the
cost/latency/confidence figures a negotiator needs to rank candidates.

## Decision

`manifest.capabilities?: readonly CapabilityDeclaration[]` is now a
first-class, optional field on `XoManifest` (`@xo/types`). Each
`CapabilityDeclaration` carries `id`, `name`, `description`,
`providerCompatibility`, `requiredComponents`, `estimatedCost`,
`estimatedLatencyMs`, and `confidence` — set explicitly by a package
creator via `@xo/package-sdk`'s `ManifestBuilder.setCapabilities(...)`,
never inferred from `metadata.json` by any part of this codebase.
`PackageValidator.validateCapabilities` checks internal consistency (no
duplicate ids within a manifest, every `requiredComponents` entry
actually declared in `manifest.components`, confidence in `[0, 1]`,
non-negative cost/latency).

The field is **optional**, not a `formatVersion` bump. A manifest that
never calls `setCapabilities` declares zero capabilities — a structurally
valid, meaningful state (the package simply exposes nothing to
`@xo/runtime`'s negotiator) — rather than a validation failure. This was
chosen over making the field required (which would have meant bumping
`formatVersion` to `"1.1"` and writing a migration, per
`manifest-migration.ts`'s existing registry) because every already-built
package (the demo package, every package-sdk fixture, the flagship
`xo-corporate-contract-lawyer` reference package in `../PACKAGE_README.md`)
predates this field, and none of Runtime Stage 1's actual requirements —
discover, verify, mount, expose declared capabilities, plan
deterministically — need capabilities to be mandatory to work correctly.
Making it required is a reasonable future change; it wasn't the minimal
one this stage needed.

## Consequences

- `@xo/runtime`'s `PackageLoader` reads `manifest.capabilities` directly
  when building a `MountedPackage`'s `CapabilityDescriptor[]`. There is no
  code path anywhere that derives a capability from `metadata.json`.
- A capability id is only unique *within* the manifest that declares it,
  not globally — `@xo/runtime`'s `CapabilityDescriptor` pairs a
  `CapabilityDeclaration` with the package name/version that offers it
  specifically so two different packages can legitimately declare the
  same capability id (e.g. two competing `contract_analysis` packages)
  without collision.
- A package built before this ADR (no `capabilities` field) mounts and
  verifies exactly as before; it simply contributes nothing to
  `CapabilityRegistry`. No existing fixture, test, or the demo package
  needed to change to remain valid.
- If capabilities are later made mandatory, that's a `formatVersion`
  bump with a registered `manifest-migration.ts` entry filling
  `capabilities: []` for every pre-existing `"1.0"` manifest — the
  registry this repo already has for exactly that kind of change.
