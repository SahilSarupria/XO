# XO — Package Installation Path Traversal: Security Report

**Scope:** `@xo/package-sdk` package installation path confinement (P1.0 parallel security task).
**Status:** Fix implemented, tested and committed locally. **Not pushed.** Awaiting review.
**Commit hash:** this report is part of the commit it describes, so the hash cannot be embedded in the committed copy. It is stated in the delivery summary and by `git log -1` on `main`. The copy of this report shipped in the ZIP appends a "Commit confirmation" section with the hash.

## 1. What was inspected

| Item | Value |
|---|---|
| Branch | `main` |
| Original base inspected | `86334307216eac9ccf08d601194eed12b95d2fa7` (clean tree) |
| Current base | `81f2bce` `feat(security): establish authenticated principal foundation` |
| Working directory | A fresh `git clone` at `/home/claude/XO`, isolated from any other session's working tree |

Before committing I ran `git fetch` and found `origin/main` one commit ahead: `81f2bce`, the other session's P1.0 M1 work (29 files in `apps/api`, `apps/cli`, `packages/permissions`, plus its own report). **No file overlaps** with this fix, and upstream did not touch `package-sdk` or `storage`. I fast-forwarded my own clone (`git merge --ff-only`, no merge commit); staged changes were unaffected. Nothing in the other session's files was modified, and everything below was re-verified on `81f2bce` + this fix.

Housekeeping: `npm install` flipped the mode of `apps/cli/bin/xo.js` (reverted, `core.fileMode false`); `apps/api` tests create an untracked `apps/api/.xo-data/` (deleted each time). Neither is in the commit.

## 2. Vulnerability

**Confirmed by tests** (disposable `mkdtemp` sandboxes with a throwaway pre-installed "victim" package, driving the real `PackageInstaller` + `LocalFsBlobStore`; every one of these is a failing test on the original code):

1. **Cross-package overwrite via component path.** `../../victim/1.0.0/safety/rules.json` stays inside the store root, so the store's check passes. `install()` returned `ok` and the victim's `safety/rules.json` became attacker bytes.
2. **Cross-package overwrite via package `name`** (`x/../victim`): same result.
3. **Cross-package overwrite via `version`** when `skipValidation` is used (`../victim/1.0.0` stays in the store root; the version check lives only in the validator that `skipValidation` bypasses).
4. **Self-corruption.** A component path of `manifest.json` replaced the package's own installed manifest, with install reporting success.
5. **Partial installs.** Traversal paths that escape the store root were refused by the store, but `install()` writes everything with `Promise.all` and no rollback, so `manifest.json`, `metadata.json`, `safety/rules.json`, etc. were already on disk when the install returned an error. A file-vs-directory component collision (`weights/lora/` + `weights/lora/adapter.bin`) failed the same way and left five files behind.
6. **Alias reads/deletes.** `getManifest`, `getComponent`, `verifyInstallation`, `rollback` and `uninstall` took `name`/`version` straight into store keys, so `x/../victim` aliased the victim's directory. `name`/`version` reach these methods from HTTP request parameters in `apps/api`.
7. **Legacy poisoned records.** A package installed *before* this fix could store traversal paths in its install record, and `uninstall()` deleted every recorded path without checking it, so uninstalling that package would delete another package's files.

**Demonstrated but not reachable from package content alone:** `LocalFsBlobStore` follows a *pre-planted* symlink out of the store root (a write landed outside). A package cannot create symlinks (archive extraction is in-memory, the installer only calls `writeFile`). See §10.

**Not demonstrated as escapes (not claimed as such):** absolute paths, backslash paths and drive prefixes landed as odd filenames *inside* the package directory on Linux. Windows was not tested. They are rejected regardless.

**Impact bounded by tenancy:** in `apps/api` each workspace has its own `LocalFsBlobStore` rooted at `<dataRoot>/<workspaceId>/packages`, so these defects are confined to one workspace's store and cannot cross workspaces. I found no write outside the store root.

**Severity (my assessment):** High for integrity within an install store: silent replacement of another installed package's files, including its safety rules, by installing one crafted package. No confidentiality impact found.

## 3. Root cause

1. `isComponentEntry` only checked `typeof path === 'string'`; nothing validated path content, name or version.
2. `install()` built keys `` `${name}/${version}/${c.path}` `` from unvalidated strings.
3. `LocalFsBlobStore` confines to the **store root**, not the **package directory**.
4. Validation looked at `manifest.components[].path`, the installer wrote `bundle.components[].path`, and `hashComponent` hashes bytes only, so paths were independent of hashes.
5. `skipValidation` bypassed all of it.
6. No pre-flight, so writes began before every key was known safe.
7. `uninstall()` and the read methods trusted `name`/`version` and stored records.

## 4. Package-format compatibility decision

### 4.1 Is `weights/lora/` valid?

**Resolved from evidence, not guessed.** It is a valid component path under the existing format and implementation.

- `SPECIFICATION.md` §1.1 draws `weights/lora/` and `weights/finetune/` as directories, **and** §1.2's example manifest declares them as component entries with directory-style paths: `"lora": {"path": "weights/lora/", ...}`, `"finetune": {"path": "weights/finetune/", ...}`. So it is both layout illustration and a real manifest path shape.
- The implementation models a component as exactly one path ↔ one byte blob (`ComponentEntry {path, hash, required}`, `ComponentInput.data: Uint8Array`, `hashComponent` hashes bytes, tar entries are regular files). There is no representation of a multi-file directory component.
- **Experiment on the original code** (pack → unpack → install → `getComponent`): `weights/lora/`, `weights/lora`, `weights/lora/adapter.bin` and `weights/finetune/` all work, stored as a single blob (the store drops the trailing slash). So the trailing-slash form is *supported by the existing implementation*.
- Nothing in the repo produces `lora`/`finetune` components (compiler packager: "no fine-tuning/weights pipeline exists") and no pre-existing test uses such a path.

**My first draft rejected trailing slashes. That was a compatibility regression**, found by running the experiment above (the same experiment run first via dynamic `import()` was invalid because it loaded stale tracked `.js` files; I discarded it and redid it with static imports, which load the `.ts` sources). **Fix:** a single trailing `/` is accepted as a directory-style entry meaning the same file as the path without it (`componentPathKey`). That normalized key is what the reserved-name and collision checks compare, which also closed a bypass in my own draft (`manifest.json/` would have escaped the raw-string reserved check). Doubled slashes (`knowledge//`), `../`, `./`, and a bare `/` are still rejected.

Path confinement is not weakened: traversal, absolute, Windows-style, `:`, control-character and reserved-name rules are unchanged and apply to the normalized path.

New rule worth knowing: two components may not address the same file or nest file-under-directory (`weights/lora/` + `weights/lora/adapter.bin`, or `weights/lora` + `weights/lora/`; case-insensitive). On the original code these combinations **never worked** (write error + partial install, §2.5), so no legitimate structure is lost.

**Not resolved, and not resolvable from the existing implementation:** whether a `lora`/`finetune` directory component is meant to hold *multiple files* under one hash. The spec does not define directory hashing and the format has no multi-file representation. That is a separate format decision, outside this fix.

### 4.2 Do the package-name restrictions reject legitimate names?

**No legitimate name or namespace is rejected, as far as the existing format and code show.**

- Every package name in code, tests and examples is an identifier (`xo_demo_contract_clause_lookup`, `xo_e2e_burglary_policy`, `x`, `preview`, …); the only slashed name anywhere was the malicious one in my own tests.
- The spec's display-style name (`Corporate Contract & Commercial Lawyer`) and `xo_id`-style names pass; there is a test for these plus dotted, hyphenated and non-ASCII names.
- `namespace` and `publisher` are *not* manifest fields or part of the install path: the protocol's `xo:<namespace>/<publisher>/<name>@<version>` identifier keeps them separate from `name`, and the implementation addresses installs as `<name>/<version>`. The CLI addresses packages as `<name>@<version>` (splitting on the last `@`).
- Rule: `name` and `version` must each be exactly one safe path segment (no `/`, `\`, `:`, `.`/`..`, empty, or control characters). A scoped name such as `scope/pkg` would now be rejected; no such name is supported by anything in the repo, and allowing `/` would let a package place itself inside another package's directory.

## 5. Fix design

New `packages/package-sdk/src/validation/safe-path.ts` (pure, lexical, platform-independent): `packageSegmentProblem`, `componentPathProblem`, `componentPathKey`, `componentCollisionProblem`, `confinementProblem` (defense-in-depth re-normalization of the final key).

- **Installer, the security boundary:** `findUnsafeInstallLocation` runs at the top of `install()`, before any store access and regardless of `skipValidation`. It checks name, version, both manifest-declared and bundle-carried component paths, final keys and collisions. `upgrade()` and `repairInstallation()` go through `install()`. A rejected package performs zero writes. Error: existing `XO_PACKAGE_VALIDATION_FAILED`, message `Refusing to install package: unsafe install location — <reason>` (the reason never echoes control characters).
- **Other entry points:** `uninstall`, `rollback`, `getManifest`, `getComponent` (via `getManifest`) and `verifyInstallation` answer `XO_PACKAGE_NOT_INSTALLED` for an unsafe name/version, exactly as for any package that is not installed (it can never have been installed). `uninstall()` additionally fails closed (`XO_PACKAGE_VALIDATION_FAILED`, "Nothing was deleted.") if its install record lists any path outside `<name>/<version>/`.
- **Validator:** `validatePathSafety` in `validateAll`, with `PACKAGE_IDENTITY_UNSAFE`, `COMPONENT_PATH_UNSAFE`, `COMPONENT_PATH_COLLISION`.
- **Schema:** `isXoManifest` rejects unsafe component paths and names, so `unpackArchive` and `getManifest` refuse such manifests early.

No new error codes. Nothing outside `package-sdk` changed.

## 6. Files changed

| File | Change |
|---|---|
| `packages/package-sdk/src/validation/safe-path.ts` | **new**: path-safety rules |
| `packages/package-sdk/src/install/package-installer.ts` | install gate; identity guard on 5 methods; fail-closed `uninstall` |
| `packages/package-sdk/src/validation/package-validator.ts` | `validatePathSafety`, wired into `validateAll` |
| `packages/package-sdk/src/validation/schema.ts` | `isXoManifest` rejects unsafe name / component paths |
| `packages/package-sdk/test/package-path-confinement.test.ts` | **new**: 50 regression tests |
| `XO_PACKAGE_PATH_TRAVERSAL_SECURITY_REPORT.md` | **new**: this report |

The diff against `HEAD` was reviewed in full: additions only, plus one replaced line in `schema.ts`; no generated files, secrets or unrelated formatting.

## 7. Regression tests (50, `node:test`, existing conventions)

Legitimate install; existing path shapes (including `weights/lora/`, `knowledge/`); spec-style `weights/lora/` and `weights/finetune/` pack/unpack/install/`getComponent`/`verifyInstallation` round trip; directory-style blob stays inside `<name>/<version>/`; 24 unsafe component paths (`../`, nested, cross-package, absolute, backslash, mixed, drive prefix, UNC, ADS, `.`, `//`, `knowledge//`, `../`, `./`, `/`, NUL, control char, empty, reserved `manifest.json`/`metadata.json` including `manifest.json/` and `Metadata.JSON`); 7 unsafe names; legitimate-name acceptance; cross-package overwrite via path, name and version (victim bytes asserted unchanged); `skipValidation` and bundle-vs-manifest path differences; `force`/`upgrade`/`repairInstallation`; collisions; validator and schema rejections; unsafe-identity aliasing on the five methods; fail-closed `uninstall` on a legacy record; normal `uninstall` unaffected. Every rejection test snapshots the entire sandbox before/after and asserts byte-for-byte equality (zero writes).

## 8. Commands and actual results

Final run on `81f2bce` + this fix, from `/home/claude/XO` (`dist/` is gitignored, so `npx tsc -b <workspace>/tsconfig.json` is needed first).

| Command | Result |
|---|---|
| `npx tsc -b` on `package-sdk`, `permissions`, `compiler`, `registry`, `runtime`, `apps/api`, `apps/cli` (real exit codes) | all `exit=0`, no output |
| `node --import tsx --test test/package-path-confinement.test.ts` vs **original** code | 50 tests: **10 pass, 40 fail** (28 parameterized path/name rejections + 12 named tests incl. the legacy-record and alias tests) |
| same, with the fix | **50 pass / 0 fail** |
| `npm test` in `packages/package-sdk` | **196 pass / 0 fail** (146 original + 50 new) |
| `npm test` in `packages/storage` | 6 pass / 0 fail |
| `npm test` in `packages/permissions` | 116 pass / 0 fail (includes the other session's M1 tests) |
| `npm test` in `packages/registry` | 40 pass / 0 fail |
| `npm test` in `packages/runtime` | 433 pass / 0 fail |
| `npm test` in `apps/api` | 199 pass / 0 fail |
| `npm test` in `packages/compiler` | 894 pass / **1 fail** (#114 "M1.1 shape 6…") |
| `npm test` in `apps/cli` | 260 pass / **2 fail** (#8, #49 "vertical-test benchmark fixture") |

**Pre-existing failures, not regressions:** compiler #114 and cli #8/#49 fail identically on a pristine `git clone` of `81f2bce` **with no fix** (894/895 and 260/262, same test names). They are count mismatches in compiler capability discovery (e.g. expected 23, got 33), unrelated to installation. I did not investigate or fix them. **Zero regressions.**

**Lint/format:** `eslint --max-warnings=0` is clean on `safe-path.ts`, `schema.ts`, `package-validator.ts` and the new test. `package-installer.ts` has exactly the same 3 pre-existing eslint errors as `HEAD` (`StorageError`/`Clock` type-only imports, unused `_removed` in `uninstall`, untouched by this change). Prettier already fails at `HEAD` on `schema.ts`, `package-validator.ts` and `package-installer.ts`; I did not reformat them. I measured that **none of my added lines** is objectionable to prettier (0 in each file), and the two new files are prettier-clean.

## 9. Commit and pre-commit hook

Message: `fix(package-sdk): prevent package component path traversal`. Staged by explicit file name (never `git add -A`): exactly the six files in §6.

1. **Normal commit attempted first.** The husky hook (`npx lint-staged`: `eslint --fix` then `prettier --write` on staged files) failed. Its only reported error was `package-installer.ts: '_removed' is assigned a value but never used`: pre-existing at `HEAD` (line 123 there), in code this change does not touch. lint-staged reverted cleanly; nothing was lost. I reproduced the hook's output by running its command directly beforehand.
2. **Why the hook was bypassed:** passing it would have required reformatting about 180 changed lines (49 + 106 + 28, measured) of pre-existing code in three files (prettier `--write` is part of the hook), burying a security fix in unrelated churn. Per your authorization, after the manual checks above (eslint, prettier on my lines, all builds, the security tests, package-sdk and all dependent suites) all passed and no new lint failure existed, the commit used `git commit --no-verify` **once**.
3. **Checks run manually instead:** §8 in full.

## 10. Remaining limitations

- **Symlinks (demonstrated, out of reach for package content).** `LocalFsBlobStore.resolveKey` is lexical and does not `realpath`; anyone able to plant a symlink inside the store can redirect writes outside it. Fixing it means changing the shared `@xo/storage`, which I judged outside this narrow fix. Recommended follow-up.
- **Partial writes on I/O failure.** Rejection by path checks now causes zero writes (including collisions), but a disk error midway through `install()`'s parallel writes can still leave a partial install; there is no rollback.
- **Windows not tested.** Windows-style paths are rejected lexically on every platform.
- **`ManifestBuilder` still accepts unsafe paths when building**; they are rejected at validate/install/read. Hand-crafted packages bypass the builder anyway.
- **Reserved store-level names:** a package named `_records` or `_index.json` can collide with the installer's own bookkeeping keys. Not changed (risk of rejecting legitimate names); needs a decision.
- **Packages installed before this fix remain on disk as they were.** `uninstall()` now refuses to act on a poisoned record, which leaves such a package un-uninstallable until an operator removes it manually. Already-overwritten victim files are not repaired.
- **Multi-file `lora`/`finetune` directory components** are not representable in the current format (§4.1).
- **Error messages** for collisions and reserved names echo the offending path; paths containing control characters are rejected before they can be echoed by the installer, but the validator's collision message runs on raw paths.
- **Tracked build artifacts:** the repo tracks ~571 compiled `.js`/`.d.ts` files beside sources (stale; `schema.js` lacks `human_in_the_loop`). Tests load the `.ts` (confirmed by fail-then-pass runs). A dynamic `import()` by absolute path loaded the stale `.js` during my compatibility experiment. Worth a cleanup decision.
