# ADR 0005: Node's built-in test runner, contract tests for interface-only packages

## Status
Accepted

## Context
Every package needs tests. The ecosystem default for a TypeScript
monorepo is Vitest or Jest — richer matchers, watch mode, snapshot
testing. Three packages (`compiler-core`, `runtime-core`,
`registry-core`) intentionally contain interfaces with no implementation,
per the instruction this module was built from ("no compiler
implementation... no runtime implementation... no registry
implementation").

## Decision
- Use `node:test` + `node:assert/strict` for every package. No test
  framework dependency.
- For the three interface-only packages, write **contract tests**: a
  small fake implementation, local to the test file, that satisfies the
  interface and is exercised through it. This proves the interface is
  actually implementable and ergonomic to call, without adding real
  business logic to the package under test.

## Alternatives considered
- **Vitest**: nicer DX (watch mode, in-source snapshots), but is a
  dependency this module could not install in the sandbox it was
  built/verified in (see `docs/TECH_STACK.md`'s sandbox note), and
  `node:test` is stable and sufficient for this repo's current test
  style (plain assertions, no snapshots). Revisit if a package's tests
  need something `node:test` doesn't offer (e.g. component/DOM testing,
  which doesn't apply to this backend-only repo today).
- **No tests for interface-only packages**: rejected — an interface that
  has never been implemented against anything is unverified; a contract
  test is cheap and catches, e.g., a method signature that's awkward to
  actually satisfy (wrong variance, a required field with no sensible
  default).

## Consequences
- Every package's `test` script is `node --import tsx --test
  test/**/*.test.ts` — `tsx` is the one test-only dependency, used to run
  `.ts` test files directly. In the sandbox this module was built in
  (no registry access), tests were instead run via a globally-installed
  `tsx` (`scripts/sandbox-verify-tests.sh`); a normal `npm install`
  resolves each package's own `tsx` devDependency and `npm test` (the
  real script) is the actual entry point.
- Contract tests in `compiler-core`/`runtime-core`/`registry-core` must
  not accrete real business logic over time — if a "fake" implementation
  starts looking like it should just be the real one, that's a signal to
  start the next module, not to keep growing the fake.
