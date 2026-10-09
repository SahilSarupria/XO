# XO Platform

Reference implementation of the XO (Experience Object) platform described in
`SPECIFICATION.md`, `XO_PROTOCOL.md`, `EXPERIENCE_COMPILER.md`, and
`RUNTIME_ARCHITECTURE.md`. Those four documents are **frozen** — this repo
implements them; it does not redesign them. If implementation reveals a
flaw, it's documented (see `docs/adr/`), not silently "fixed" by deviating.

## What's in this module (Module 1)

This is the engineering foundation only: repo structure, shared types,
errors, logging, config, observability, DI, serialization, testing
utilities, crypto primitives, storage, and a graph engine — plus
interface-only packages for the three big subsystems (`compiler-core`,
`runtime-core`, `registry-core`) and a minimal CLI.

**No compiler, runtime, or registry business logic is implemented here.**
That's intentional — see the root prompt this module was built from.

## Repository layout

```
packages/
  types/            Shared types: Result, branded IDs, XO manifest/metadata shapes
  errors/           Error hierarchy + stable error codes
  logger/           Structured logging (console + no-op implementations)
  config/           Env-based config loading with schema validation
  observability/    Tracer/Meter interfaces + console exporter
  di/               Minimal dependency-injection container
  serialization/    Versioned envelope + JSON codec framework
  testing/          Shared test doubles (mock logger, mock clock, fixtures)
  crypto/           Hashing (SHA-256, Merkle root) + signing (Ed25519)
  storage/          Blob store interface + local-filesystem implementation
  graph-engine/     Knowledge-graph store interface + in-memory implementation
  compiler-core/    Experience Compiler interfaces — no implementation
  runtime-core/     XO Runtime interfaces — no implementation
  registry-core/    Registry repository interfaces — no implementation
apps/
  cli/              `xo` CLI: version / doctor / config show only
docs/               Architecture, coding standards, tech stack rationale, ADRs
```

## Working in this repo

```bash
npm install          # resolves every workspace package
npm run typecheck    # tsc -b across the whole composite project
npm run lint         # eslint
npm test             # every package's own test script
npm run build        # tsc -b, emitting dist/ per package
docker compose up    # local Postgres + Redis (Neo4j via --profile graph)
```

> **Sandbox note:** if you're reading this inside an environment without
> registry (npm) access, `npm install` won't have anything to fetch from.
> `scripts/sandbox-verify-tests.sh` is a workaround used only to
> self-verify this repo in that situation — it is not part of the real
> developer workflow and should not be used outside of it.

See `docs/ARCHITECTURE.md` for how this maps to the frozen design docs,
`docs/TECH_STACK.md` for why each technology was chosen, and
`docs/CODING_STANDARDS.md` for conventions every package follows.
