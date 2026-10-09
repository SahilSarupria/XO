# XO Platform

Reference implementation of the XO (Experience Object) platform described in
`SPECIFICATION.md`, `XO_PROTOCOL.md`, `EXPERIENCE_COMPILER.md`, and
`RUNTIME_ARCHITECTURE.md`. Those documents are the design source of truth —
this repo implements them; it does not redesign them. If implementation
reveals a flaw, it's documented (see `docs/adr/`), not silently "fixed" by
deviating.

## What it does

XO compiles source documents (currently PDFs and structured data) into
executable capability graphs, packages them as signed `.xo` archives, and
runs them through a permission-gated runtime:

```
source → compiler → XOIR graph → capability contracts → workflows
       → .xo package → registry → runtime execution
```

- **Compiler** — PDF → XOIR (the canonical, profession-agnostic typed
  property graph); discovers capabilities and relationships.
- **Capability contracts** — project discovered capabilities into portable
  `SemanticCapabilityContract`s and bind them to executable implementations
  (deterministic rule, human-in-the-loop, or hybrid).
- **Workflow composer** — deterministically proposes multi-step workflows
  from discovered capabilities; never invents capabilities.
- **Package SDK** — build, validate, sign, pack, install, and diff `.xo`
  packages.
- **Runtime** — mounts installed packages, enforces permissions, executes
  capabilities and workflows, records execution receipts.
- **Registry** — local-filesystem registry for packages, benchmarks,
  licenses, and a ledger.
- **Benchmark** — evaluates the real pipeline end to end with per-dimension
  metrics and regression comparison.

## Repository layout

```
apps/
  cli/                `xo` command-line tool
  api/                HTTP service (node:http) over registry, package-sdk,
                      runtime, and the compiler pipeline
packages/
  Foundation
    types/              Shared types: Result, branded IDs, manifest shapes
    errors/             Error hierarchy + stable error codes
    logger/             Structured logging
    config/             Env-based config with schema validation
    observability/      Tracer/Meter interfaces + console exporter
    di/                 Dependency-injection container
    serialization/      Versioned envelope + JSON codec framework
    testing/            Shared test doubles and fixtures
    crypto/             SHA-256, Merkle root, Ed25519 signing
    storage/            Blob store interface + local-filesystem impl
    graph-engine/       Knowledge-graph store + in-memory impl
  Compiler pipeline
    xoir/               XOIR — the intermediate representation
    compiler-core/      Compiler interfaces
    compiler/           PDF → XOIR compiler frontend
    capability-contract/ XOIR capability → contract → binding resolvers
    workflow-composer/  Capability → candidate workflow composition
    ai-core/            Provider-agnostic AI capability layer
  Packaging & runtime
    package-sdk/        Build/validate/sign/pack/install/diff `.xo` packages
    permissions/        Permission identity, policy, consent, grants, audit
    runtime-core/       Runtime interfaces
    runtime/            Package mounting, execution pipeline, workflows
    registry-core/      Registry interfaces
    registry/           Local-filesystem registry + client facade
  Evaluation
    benchmark/          Pipeline evaluation and regression comparison
  Visualization & interaction
    graph-ui/           Framework-agnostic graph visualization library
    atlas/              Interaction engine ("depth instead of navigation")
    marketplace-world/  Maps the XO ecosystem onto Atlas's spatial model
docs/                 Architecture, coding standards, tech stack, ADRs
examples/             Fixtures and end-to-end examples
scripts/              Repo tooling
```

## Quick start

Requires **Node.js ≥ 20.11** and **npm ≥ 10**.

```bash
git clone https://github.com/SahilSarupria/XO.git
cd XO
npm ci                  # resolves every workspace package
npm run build           # tsc -b across all workspaces

# Put `xo` on your PATH
cd apps/cli && npm link && cd ../..
chmod +x apps/cli/bin/xo.js     # if your shell reports "permission denied"

xo --help
xo doctor
xo demo commercial-property     # end-to-end golden path on a bundled fixture
```

Don't copy `node_modules/` or `dist/` between machines — workspace symlinks
break. Delete them and run `npm ci && npm run build` instead.

## The `xo` CLI

| Group     | Commands                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------- |
| system    | `config show`, `doctor`, `version`                                                                  |
| package   | `init`, `build`, `pack`, `inspect`, `verify`, `install`, `uninstall`, `lock`, `diff`, `fingerprint` |
| compiler  | `compile`, `capabilities`, `create`                                                                 |
| runtime   | `demo <aastha\|commercial-property>`, `workflow`, `run`                                             |
| registry  | `publish`, `search`, `registry inspect`                                                             |
| benchmark | `benchmark-run`, `benchmark-compare`                                                                |
| ai        | no commands yet                                                                                     |

Run `xo --help` for full flags. `xo demo` and `xo workflow` run the real
compile → compose → execute pipeline; there is no second, mock engine.

## The API

`apps/api` is an HTTP service built directly on `node:http` (no framework).
Every route except `/health` and `/openapi` requires
`Authorization: Bearer <key>`. Routes cover workspaces, source upload and
compilation, package review/approval, execution, and human-task resolution.
See [`apps/api/README.md`](apps/api/README.md) for the full route map and auth
scheme.

## Development

```bash
npm run typecheck    # tsc -b across the composite project
npm run lint         # eslint (max-warnings=0)
npm test             # every workspace's test script
npm run build        # emit dist/ per package
npm run format       # prettier
docker compose up    # local Postgres + Redis (Neo4j via --profile graph)
```

Generated `.xo` archives (`xo pack`, `xo build`, `xo create`) are build
outputs and are git-ignored. Fixture PDFs used by the demo and benchmarks live
in `examples/vertical-test/`.

## Further reading

- `docs/ARCHITECTURE.md` — how this maps to the design documents
- `docs/TECH_STACK.md` — why each technology was chosen
- `docs/CODING_STANDARDS.md` — conventions every package follows
- `docs/VERSIONING.md` — versioning policy
- `docs/adr/` — architecture decision records
- `CONTRIBUTING.md`

## License

Apache-2.0 — see `LICENSE`.
