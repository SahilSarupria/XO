# ADR 0001: Monorepo with npm workspaces + TypeScript project references

## Status
Accepted

## Context
The platform has at least five distinct deployables (compiler, runtime,
registry, SDK, CLI) that share types and infrastructure primitives
(`packages/*-core` and below). They need to evolve together without
version-skew pain during early development, but eventually ship/version
independently.

## Decision
One monorepo (`packages/*`, `apps/*`), npm workspaces for dependency
linking, TypeScript composite projects (`references` + `tsc -b`) for
incremental, dependency-ordered builds.

## Alternatives considered
- **Polyrepo per package**: rejected for now — at this stage every
  `*-core` interface change would require coordinated PRs across repos,
  with no compiler/runtime/registry implementation yet to justify that
  overhead.
- **pnpm workspaces**: stricter `node_modules`, faster installs, widely
  used for monorepos this size. Deferred, not rejected — see
  `docs/TECH_STACK.md`'s "recommended upgrade path". Not adopted now
  because npm workspaces required zero additional tooling to verify this
  module in a network-restricted environment.
- **Turborepo / Nx**: build caching and task orchestration on top of the
  workspace tool. Deferred until CI build time or cache-hit-rate actually
  becomes a problem — premature at 15 packages.

## Consequences
- `tsconfig.json`'s `references` array must be kept in sync by hand when
  a package is added (see `CONTRIBUTING.md`). Not yet automated.
- Every package versions independently via Changesets (ADR-adjacent, see
  `docs/VERSIONING.md`), which npm workspaces support natively.
