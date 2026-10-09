# ADR 0003: Hand-rolled DI container instead of a decorator/reflection-based one

## Status
Accepted

## Context
Every package needs a consistent way to wire injectable collaborators
(`Logger`, `Clock`, `BlobStore`, etc.) without hard-coding a concrete
implementation inside business logic. The Node/TypeScript ecosystem's
common answer is a decorator + `reflect-metadata` container (tsyringe,
InversifyJS), which infers constructor dependencies from parameter types
at runtime.

## Decision
`packages/di`'s `Container` is a small, explicit `token -> factory`
registry with singleton/transient scopes and cycle detection — no
decorators, no `reflect-metadata`, no implicit constructor-parameter
inference.

## Alternatives considered
- **tsyringe**: requires `experimentalDecorators` +
  `emitDecoratorMetadata` compiler flags repo-wide, and a runtime
  dependency (`reflect-metadata`) that must be imported exactly once,
  globally, before any decorated class is loaded — a footgun for a
  multi-package repo where import order across `packages/*` isn't fully
  controlled by any one package. Also: this module was built/verified
  without npm registry access, and a hand-rolled container needed zero
  dependencies to compile and test in that environment. Not the deciding
  factor by itself, but it meant "hand-roll it" had no downside in this
  module's actual build.
- **InversifyJS**: similar reflection-based tradeoffs, heavier API
  surface than this repo's current wiring needs.
- **No DI container at all (manual wiring everywhere)**: viable at
  today's scale but doesn't give a shared `createChild()` scoping
  primitive, which the (future) runtime will want per-request/per-mount
  scopes for.

## Consequences
- Registrations are explicit and greppable
  (`container.register(loggerToken, () => new ConsoleLogger())`), at the
  cost of writing that line by hand instead of an `@injectable()`
  decorator inferring it.
- If constructor lists grow long enough that manual factories become
  painful, revisit — that pain is the actual signal to adopt a
  reflection-based container, not a guess made up front.
