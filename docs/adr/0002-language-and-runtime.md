# ADR 0002: TypeScript on Node.js as the primary implementation language

## Status
Accepted

## Context
The XO format is JSON-shaped throughout (manifest, metadata, knowledge
graph, decision trees, reasoning traces). The platform's five deployables
share a large surface of types and interfaces. The team building this
(today: one AI engineer + reviewer) needs to move fast without
re-deriving the same domain types in multiple languages.

## Decision
TypeScript on Node.js ≥20, for every package in this repo.

## Alternatives considered
- **Go for the runtime**: better memory/concurrency characteristics for a
  process holding many mounted packages in memory simultaneously.
  Rejected *for now*: would require either duplicating
  `runtime-core`'s interfaces in a second language or generating one from
  the other (extra tooling with no implementation yet to validate it
  against). Revisit once `runtime-core` has a real implementation and
  profiling shows Node is the bottleneck — nothing in `packages/types` or
  `runtime-core`'s interfaces is Node-specific, so a Go runtime consuming
  the same manifest/IR JSON shapes remains possible later.
- **Python**: strong fit for the eventual synthetic-data / expert-review
  pipeline described in `PACKAGE_README.md` §3 (scaling reasoning traces
  to 300+), weaker fit for a typed, multi-package foundation layer.
  Revisit specifically for that pipeline as its own service, not as a
  replacement for this repo's language.

## Consequences
- `packages/*`'s shared `Result`/branded-ID/error conventions are
  TypeScript-idiomatic; a future non-TS service must translate at its
  boundary (e.g. treat a `ContentHash` as a validated string, re-deriving
  the `sha256:<hex>` regex check).
- Testing standardizes on `node:test` (see ADR 0005) rather than a
  cross-language test strategy.
