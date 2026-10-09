# apps/cli — compiler subsystem work (this session)

## What's in this package

The full `apps/cli` package (`@xo/cli`), merged from the standalone CLI
archive into `monorepo/apps/cli`, plus three new commands wired into the
previously-empty `commands/compiler` subsystem.

Drop this directly into `monorepo/apps/cli` (it replaces that directory
wholesale — it *is* that directory, source-only, with `dist/`,
`tsconfig.tsbuildinfo`, and `node_modules/` stripped).

## What changed vs. the original standalone CLI archive

1. **New files** (all under `src/commands/compiler/`):
   - `compile.ts` — `xo compile <source>...`, wraps `@xo/compiler`'s `compileSources`.
   - `capabilities.ts` — `xo capabilities <source-or-.xo>`, shows DISCOVERED (XOIR `capability` nodes) vs. RESOLVED (`manifest.capabilities`) as separate, never-conflated concepts.
   - `create.ts` — `xo create <source>...`, orchestrates `compileSources` → `packageXoirGraph` → optional sign → `PackageValidator` → `packBundle` → `.xo` on disk. Includes a real determinism check (pinned-clock recompile + graph content-hash comparison).
   - `source-input.ts` — the one piece of CLI-side adaptation: turns a file path into the tagged `SourceInput` shape `@xo/compiler`'s frontends expect, by extension (`.pdf`/`.html`/`.json`/`.csv`/fallback `document`).
   - `index.ts` (rewritten) — registers the three commands above; previously declared zero commands.

2. **Modified**: `src/commands/package/pack.ts` — its "raw document not supported" error message pre-dated `compileSources`/`packageXoirGraph` existing and was stale; updated to point at `xo create` instead of describing a gap that's now partially closed. No behavior change — `pack` still only accepts project directories.

3. **package.json / tsconfig.json**: added `@xo/compiler` and `@xo/xoir` as dependencies / project references.

4. **New tests**: `test/compile.test.ts`, `test/capabilities.test.ts`, `test/create.test.ts` (15 tests total). `test/pack.test.ts` had one assertion updated to match the corrected error text.

## Verification performed (this session)

- `apps/cli` builds clean via `tsc -b`.
- Full monorepo builds clean (`npm run build --workspaces`).
- Full monorepo test suite: **1479/1479 passing, 0 failures**, across all 24 workspaces (`@xo/cli` 75/75, `@xo/compiler` 438/438, `@xo/runtime` 327/327, `@xo/package-sdk` 131/131, `@xo/registry` 40/40, `@xo/xoir` 119/119, etc.) — no regressions anywhere.
- `examples/e2e-pdf`'s existing harness (`npm run e2e:pdf`) still passes, unchanged.
- Manually ran the real `xo` binary end-to-end against the real `examples/vertical-test/burglary-policy.pdf` fixture: `compile` → `capabilities` → `create --sign` → `verify` (PASS) → `capabilities` on the built archive → `install` → `run` (fails correctly and honestly, first on missing args, then on missing provider credentials — never fabricates or crashes).

## Explicitly NOT done here — left for platform-side work

- **`xo receipt <id>`**: no standalone receipt-lookup API exists in `@xo/runtime` beyond what `run` already prints inline from a single execution. Needs a platform-side API (e.g. a receipt store/index queryable by id) before a CLI command can wrap it — building UI around a nonexistent lookup would mean faking data.
- **`xo bind`**: depends on the same missing seam `capabilities.ts`/`create.ts` document extensively — there is no lowering from a compiler-discovered XOIR `capability` node to a manifest-level `CapabilityDeclaration`. `ManifestBuilder.setCapabilities()` exists and works fine; nothing in `@xo/compiler`'s Packager calls it from XOIR output. This is a deliberate design decision to be made in `@xo/compiler`, not something to improvise in the CLI.

Both are confirmed as being picked up in another session — nothing here assumes or half-implements either.

## Update: multi-document source collection (directory / .zip)

Added on top of the previous compiler-subsystem work in this file, per a
follow-up task ("Multi-Document Source Collection Support"):

`xo compile` / `xo create` / `xo capabilities` now accept, per positional
argument: a single file (unchanged, exact prior behavior/tests preserved),
a directory (recursively walked), or a `.zip` archive (extracted to a temp
dir, then walked the same way). All three route through the same
`compileSources` call — no second compilation pipeline.

### New files

- `src/commands/compiler/source-collection.ts` — `resolveSourceArg` (one
  arg → file/directory/zip classification + discovery) and
  `collectSources` (multi-arg orchestration: concatenate, dedupe by
  realpath, tag via `loadSourceInput`, fail clearly on zero sources,
  `finally`-safe cleanup of any temp ZIP extraction dir). Lives in
  `apps/cli`, not `@xo/compiler` — the compiler's source frontends are
  deliberately fs-free (they take bytes/text, never a path to read), so
  directory/ZIP walking is CLI-layer plumbing, same category as the
  existing `source-input.ts`.

### Changed files

- `source-input.ts` — `loadSourceInput` now takes `(readPath, declaredPath
  = readPath)` instead of just `(sourcePath)`, so a collection can read
  bytes from a temp-extracted absolute path while declaring a clean,
  collection-relative `sourcePath` (this is what keeps provenance and
  `computeSourceId` hashes free of temp-directory names — see the file's
  doc comment). Also added `.png/.jpg/.jpeg/.gif/.webp` → `image` tagging
  (previously missing) and exported `KNOWN_EXTENSIONS`, the single
  extension→frontend mapping both single-file and collection code paths
  now share.
- `compile.ts` / `capabilities.ts` / `create.ts` — source resolution now
  goes through `collectSources` instead of mapping `loadSourceInput`
  directly over `options.sources`. Each command's text/JSON output gained
  a `discoveredSources` / `unsupportedFiles` field. `create.ts`'s
  determinism check (pinned-clock double-compile, see the file's own doc
  comment) transparently covers directory/ZIP inputs too, since
  `collectSources` only extracts a ZIP once and both compile calls read
  the same already-tagged inputs.
- `package.json` / project deps — added `adm-zip` (+ `@types/adm-zip`) as
  a new CLI-only dependency for ZIP extraction. Zip-slip protection
  (path-traversal / absolute-path entry rejection) is hand-rolled in
  `source-collection.ts`, not delegated to the library.

### New fixture

- `examples/vertical-test-multidoc/` (repo root, alongside
  `examples/vertical-test/`) — the "golden vertical" 3-document fixture
  the follow-up task asked for: `policy.txt`, `claims-procedure.txt`,
  `supporting-rules.txt`, synthetic burglary/theft insurance content. Its
  own `README.md` explains why `.txt` rather than `.pdf` (avoids tripling
  a 360KB binary fixture purely to exercise collection mechanics; real
  PDF-in-a-directory is covered separately in
  `test/source-collection.test.ts` using the existing
  `examples/vertical-test/burglary-policy.pdf`).

### New/extended tests (not run in this session — see below)

- `test/source-collection.test.ts` (new) — 23 tests: directory walking
  (single/multiple/nested/mixed-types/unsupported/dotfile-skip/empty/
  deterministic-ordering/real-PDF/symlink-dedup), ZIP handling (same
  matrix + empty archive + **zip-slip rejection using a hand-rolled raw
  ZIP writer**, since `adm-zip`'s own `addFile()` sanitizes traversal
  paths at write time and would otherwise make the malicious-path test
  pass for the wrong reason + original-archive-untouched + temp-dir
  cleanup), and `collectSources` multi-arg combination.
- `test/compile.test.ts` — 5 new tests (directory, unsupported-file
  reporting, empty-directory failure, `.zip`, file+directory combined).
- `test/capabilities.test.ts` — 2 new tests (directory, `.zip`).
- `test/create.test.ts` — 4 new tests, including the golden-vertical
  integration test against `examples/vertical-test-multidoc/`, asserting
  one merged, valid `.xo` and that all three original files remain
  individually visible in the compiled `sources[]` report (provenance is
  not collapsed into the directory argument).

**I have not run any of these tests or rebuilt in this final packaging
pass** (per instruction — testing is being done on the receiving end).
The one thing I did verify before packaging: `tsc -b apps/cli/tsconfig.json`
compiles clean with zero errors. Test correctness (especially the
hand-rolled raw-ZIP-writer bytes in `source-collection.test.ts`, and the
exact `discoveredSources`/`unsupportedFiles` JSON field names each command
emits) has not been execution-verified in this pass.
