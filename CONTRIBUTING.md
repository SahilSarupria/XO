# Contributing

## Before you open a PR

1. `npm run typecheck && npm run lint && npm test` all pass locally.
2. If you changed a published package's public API (its `src/index.ts`
   exports), run `npm run changeset` and describe the change.
3. If your change touches something governed by one of the frozen design
   docs (`SPECIFICATION.md`, `XO_PROTOCOL.md`, `EXPERIENCE_COMPILER.md`,
   `RUNTIME_ARCHITECTURE.md`), link the relevant section in the PR — don't
   silently reinterpret it.

## Adding a new package

1. Copy the shape of an existing small package (`packages/di` is a good
   template — one concern, one interface file, one implementation file).
2. Register it in the root `tsconfig.json`'s `references` array.
3. Add it to any `apps/cli/tsconfig.json`-style consumer's references if
   something needs to import it.
4. Give it a real `test/` directory — every package other than pure
   type-only ones should have at least one runnable test.

## Coding standards

See `docs/CODING_STANDARDS.md`. The short version: `Result` for expected
failures, `throw` only for programmer errors and unrecoverable startup
failures, dependency-inject collaborators (`Logger`, `Clock`, `Container`)
rather than reaching for globals, and no package outside `*-core` may
contain business logic yet — those are interfaces on purpose.

## Commit / branch conventions

- Branch names: `<type>/<short-description>`, e.g. `feat/blob-store-s3-backend`.
- Conventional Commits style messages (`feat:`, `fix:`, `docs:`, `chore:`) —
  the changelog is generated from these via Changesets.
