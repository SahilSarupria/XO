# P1.0 M5 — Package Trust: Implementation Report

**Status:** implemented and committed locally on `feat/p10-m5-package-trust`; **not pushed**. The default-policy decision (D4, 2026-10-13) is implemented in a follow-up commit — see §8, which **supersedes** every statement below that describes an "unenforced" default. Evidence below; this is not a production-readiness claim.

## 1. Baseline

- Clone of `github.com/SahilSarupria/XO`, `main` at `857c6cb`. Branch created from `origin/feat/p10-m6-idempotency` = `eab65b9`.
- Verified ancestry: `eab65b9` (M6) → `e04407b` (M3) → `a8b4b60` (M4) → `857c6cb` (M2 merge). Linear.
- Tree was clean except the known mode-only change to `apps/cli/bin/xo.js` (left untouched, not committed; `core.fileMode=false` set locally in this clone only).
- No authoritative M5 specification exists in the repo (`P10_ENTERPRISE_TRUST_DECISIONS.md` §C lists package trust as "not decided"). Choices are recorded as proposals in §G of that file.
- Baseline (before edits): typecheck clean; package-sdk 196, runtime 473, registry 40, api 301, cli 275, compiler 896 — all pass.

## 2. Vulnerabilities found

| #   | Finding                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | Signature verification was optional: unsigned packages and `signatures: []` validated; signed packages with no resolver passed with only a _warning_. The default `PackageInstaller`/`RegistryClient`/runtime validator had no resolver, so signatures were never checked on install, publish or mount. |
| V2  | `POST /packages/validate` accepted caller-supplied `publicKeys` and returned 200 "valid" — the caller (package author) could vouch for the package. `SignatureEntry.publicKeyPem` was likewise self-asserted.                                                                                           |
| V3  | No publisher binding: nothing tied the signer to `manifest.creatorDid`.                                                                                                                                                                                                                                 |
| V4  | No revocation, key validity, algorithm or key-format validation; malformed key PEM made `verifyOne` throw. Signature encodings were not checked.                                                                                                                                                        |
| V5  | `manifestHash` excludes signatures, so signatures could be stripped/swapped on an installed manifest unnoticed; mount did `verifyInstallation` then re-read the manifest (check-then-reread); `getComponent` returned bytes without re-hashing.                                                         |
| V6  | Tar reader was lenient: duplicate entries (last wins), non-regular entries silently skipped, no header-checksum check, bad/oversized sizes and truncation tolerated (`subarray` clamps), no end marker, trailing data, no size/entry caps; entry names were not path-checked on read.                   |
| V7  | Install wrote in parallel with no rollback (failed write left a loadable partial package; forced reinstall could destroy a valid install) and the verified bundle's buffers were the live caller buffers. `skipValidation` would have bypassed any trust check.                                         |

## 3. What changed

| File                                                                                                    | Purpose                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package-sdk/src/trust/trust-policy.ts`                                                                 | Strict operator policy parsing, key normalisation/keyId (SHA-256 of SPKI), `loadOperatorTrustPolicy` (env `XO_PACKAGE_TRUST_POLICY`, fail-closed when set-but-broken).                                                                                                                     |
| `package-sdk/src/trust/verify-trust.ts`                                                                 | `evaluatePackageTrust` → verdict (`trusted`/`untrusted`/`unsigned`/`unenforced`), strict signature decoding, revocation, validity windows, role requirements, publisher binding.                                                                                                           |
| `package-sdk/src/validation/package-validator.ts`                                                       | `trustPolicy` option, `evaluateTrust`; enforce mode turns failures into errors. Legacy `resolvePublicKey` kept (code-supplied) and mutually exclusive with `trustPolicy`.                                                                                                                  |
| `package-sdk/src/install/package-installer.ts`                                                          | Pins bundle bytes; trust + confinement checked even with `skipValidation`; backup/rollback; read-back verification before the record exists; record `manifestDigest`/`trust`; `loadVerified` (single read); per-read hash check in `getComponent`; identity/digest checks on verification. |
| `package-sdk/src/archive/{tar-codec,zstd-codec,package-reader}.ts`                                      | Strict tar parsing, entry-name safety + collision checks, 512 MiB decompression cap (configurable on `unpackArchive`), 4096-entry cap.                                                                                                                                                     |
| `package-sdk/src/signing/package-signer.ts`                                                             | `verifyOne`/`verifyAll` no longer throw on malformed keys; docs state the embedded key is self-asserted.                                                                                                                                                                                   |
| `runtime/src/loader/package-loader.ts`                                                                  | Mount uses `loadVerified` (verified manifest is the mounted manifest).                                                                                                                                                                                                                     |
| `api/src/{server,workspace/workspace-context,routes/*}.ts`, `openapi.ts`, `error-mapping.ts`            | Operator policy resolved once at startup; used by validate, registry publish and runtime bootstrap; `publicKeys` in request bodies is rejected (400); validate returns a `trust` verdict.                                                                                                  |
| `cli/src/package-trust.ts`, `commands/{package/install,package/verify,registry/publish,runtime/run}.ts` | Same policy for install/verify/publish/run; `verify` prints `TRUST:`; `--pubkey` remains as the legacy operator-supplied-file mode.                                                                                                                                                        |
| `errors/*`                                                                                              | New `PACKAGE_UNTRUSTED` code.                                                                                                                                                                                                                                                              |

## 4. Semantics (operator documentation)

- **Configure:** set `XO_PACKAGE_TRUST_POLICY=/path/policy.json`. Document: `{ "version": 1, "mode": "enforce", "requireSignature": true, "requiredRoles": ["creator"], "bindPublisher": true, "keys": [ { "signerDid", "publicKeyPem", "algorithm": "ed25519", "status": "active"|"revoked", "revokedAt"?, "notBefore"?, "notAfter"? } ] }`. Unknown fields, non-Ed25519 keys, private keys, duplicate keys are rejected.
- **Operator responsibilities:** protect the policy file (it _is_ the trust anchor); keep it off package-writable paths; revoke keys by editing it and restarting the API (policy is read once at startup; the CLI reads it per command).
- **Trust boundary:** a valid signature proves possession of a trusted signing key over the manifest (which commits to component hashes via the Merkle root). It does not prove the package is benign, correct, or authorised — M2/M3 remain authoritative for access/approval.
- **Failure behaviour:** untrusted/unsigned/tampered → install refused (`XO_PACKAGE_UNTRUSTED` or `XO_PACKAGE_VALIDATION_FAILED`), nothing left on disk; mount refused; publish refused; validate returns 422.
- **Compatibility/migration:** package format and signed bytes unchanged. ~~Unenforced default keeps existing flows working.~~ **Superseded by D4 (§8): there is no unenforced default; with no configuration every protected operation refuses, and local flows need an explicit `XO_TRUST_MODE=development`.** API `publicKeys` is a deliberate breaking change. Pre-M5 install records lack `manifestDigest`, so that check is skipped for them (trust is still re-verified at mount under the current policy).

## 5. Tests (all real verification code; no trust mocks)

Added: `package-sdk/test/package-trust.test.ts` (26), `package-sdk/test/archive-hardening.test.ts` (7), `runtime/test/package-trust-mount.test.ts` (5), `api/test/package-trust.test.ts` (3), `cli/test/package-trust.test.ts` (4). Mutation checks: removing `pinBundle` and reverting the tar reader each make the corresponding new tests fail.

## 6. Remaining limitations / not claimed

- ~~**Default is unenforced.**~~ **Resolved by D4 (§8):** the default is now fail-closed. The remaining limitations of the trust mechanism are in §8.5.
- No certificate chains, no threshold/multi-signature beyond "required roles", no automated rotation/revocation distribution (policy edit + restart), no revocation-time semantics (revoked = reject always), no signing-time/timestamp proofs.
- `metadata.json` and `CHANGELOG.md` are not covered by hashes or signatures (not used for execution; capabilities come from the signed manifest). Archive entries not declared in the manifest are ignored, not rejected.
- Local-filesystem confinement beyond lexical checks is unchanged: `LocalFsBlobStore` does not `realpath` (a pre-planted symlink in the store is out of reach of package content; tar symlinks are now rejected). Windows behaviour is lexically covered only; not tested on Windows.
- Stale files from a prior version at the same path are not removed on forced reinstall.
- TOCTOU between mount and later component reads is mitigated by per-read hashing, not eliminated; the manifest is not re-verified on each read. Concurrent writers to the same store are not coordinated.
- Single-process, key custody (KMS/HSM) out of scope. `xo build --sign` still generates throw-away development keys.
- Not performed: M7, system-wide P1.0 audit, push/PR.

## 7. Open decision for the owner — RESOLVED

~~Whether `unenforced` should remain the default.~~ **Decided 2026-10-13 (D4):** an explicit development compatibility mode is approved; production and enterprise package operations require a configured trust policy. Implemented as described in §8.

## 8. Default-policy resolution (D4) — fail-closed trust mode

Follow-up commit on `feat/p10-m5-package-trust`, on top of `5e8a241`. No history rewritten; M3 → M6 → M5 ancestry preserved. M7 and the system-wide audit were not started.

### 8.1 Final policy semantics

Two modes, selected only by the environment (`loadOperatorTrustPolicy`, the single resolver used by every entry point):

| `XO_TRUST_MODE`   | `XO_PACKAGE_TRUST_POLICY` | `NODE_ENV`     | Result                                              |
| ----------------- | ------------------------- | -------------- | --------------------------------------------------- |
| unset / `enforce` | readable, valid file      | any            | **enforce**                                         |
| unset / `enforce` | unset / blank             | any            | **error** `XO_PACKAGE_TRUST_NOT_CONFIGURED`         |
| unset / `enforce` | unreadable / invalid      | any            | **error** (never a downgrade)                       |
| `development`     | unset / blank             | not production | **development** (nothing verified; never "trusted") |
| `development`     | set                       | any            | **error** (ambiguous)                               |
| `development`     | any                       | `production`   | **error**                                           |
| anything else     | any                       | any            | **error** (unknown mode; no permissive spelling)    |

- A missing policy is never inferred to be development mode. A policy file cannot select or disable anything: its `mode` may only be `enforce`.
- `unenforced` no longer exists (policy constructor, verdict status, install-record status). Development mode yields verdict status `unverified`, mode `development`, which is distinct from `unsigned` and `trusted`.
- The production guard (`assertTrustPolicyAllowedHere`) applies to every source of a policy — environment **and injected** — in the API (`buildRouter`) and CLI (`resolveTrustValidator`).
- `PackageValidator`, `PackageInstaller` and `RegistryClient` built with no policy are _unconfigured_ and fail closed (`TRUST_NOT_CONFIGURED` / `XO_PACKAGE_TRUST_NOT_CONFIGURED`); `skipValidation` does not bypass it.
- `resolvePublicKey` and `xo verify --pubkey` work only under an explicit development policy; refused under enforce (previously they could stand beside or in place of a policy).
- Authoring commands (`create`, `build`, `pack`) validate structure with an explicit development-mode validator (`authoringValidator()`); they admit/publish/mount/run nothing and claim no trust.

### 8.2 Entry points inspected

Changed to the shared resolver / fail-closed behaviour: `xo install`, `xo verify`, `xo publish`, `xo run`, `xo doctor` (new `package_trust` check); API startup (`buildRouter`), `POST /packages/validate`, `POST …/registry/packages`, runtime bootstrap/mount (`bootstrapRuntime`, `PackageLoader.mount` via `PackageInstaller.loadVerified`); SDK `PackageInstaller`, `PackageValidator`, `evaluatePackageTrust`; `RegistryClient.publish`.

Inspected and **intentionally unchanged** (they read manifests, write a lockfile or delete files; none validates, installs, publishes, mounts or executes a package): `xo search`, `xo registry inspect`, `xo inspect` (store), `xo uninstall`, `xo lock`, `xo diff`, `xo fingerprint`, `xo pack/inspect` archive reads, API `packages/resolve|lock|…/manifest`, `PackageInstaller.getManifest/getComponent` (components are re-hashed on every read; trust is not re-evaluated per read — see §8.5).

### 8.3 Diagnostics

Development mode is surfaced at API startup (warning), in `bootstrapWarnings` on every runtime response, in the `trust` object on `/packages/validate` and registry-publish responses, as a `TRUST_DEVELOPMENT_MODE` warning in validation reports, as a `warning:` line (and `--json` `warnings` entry for `run`) plus `trust: unverified [mode=development]` on CLI install/verify/publish/run, in `xo doctor`, and in the install record (`trust.mode`).

### 8.4 Tests proving fail-closed behaviour

New/changed trust tests (all use real verification code, no trust mocks):

- `package-sdk/test/trust-mode.test.ts` (19): no policy ⇒ error in every NODE_ENV; missing/unreadable/malformed/invalid/empty/wrong-version policy ⇒ error across NODE_ENV values; valid policy ⇒ enforce; explicit development; development refused in production (case/whitespace variants); development + policy file refused; unknown/near-miss modes refused; a policy file cannot select development; development verdict `unverified`, never trusted (unsigned and signed); `undefined` policy never acceptable; enforce refuses unsigned and untrusted-key signatures; `PackageValidator`/`PackageInstaller` with no policy refuse (also with `skipValidation`, nothing written); `resolvePublicKey` only under development; development-admitted package refused at mount under enforce and under no policy.
- `package-sdk/test/package-trust.test.ts` (updated): development verdict, loader semantics, development warnings.
- `runtime/test/package-trust-mount.test.ts` (+3): mount with no policy fails closed; development mount is `unverified`; one store, three policies agree.
- `registry/test/registry-client.test.ts` (+2): publish with no policy fails closed and writes no record; enforce refuses unsigned, development publishes.
- `api/test/package-trust.test.ts`: startup fails closed with no configuration in every NODE_ENV; development logs the warning, refused in production / with a policy file / when injected in production; enforcing policy starts; validate + registry publish + runtime apply the same enforcing policy to the same package; development surfaced as `unverified`; unconfigured workspace config fails closed.
- `cli/test/package-trust.test.ts`: no configuration ⇒ install, verify, publish, run and doctor all fail identically with nothing written; invalid/unreadable/malformed policy ⇒ all four refuse identically; development mode output on every surface; refused in production (environment and injected); refused with a policy file; enforce refuses an unsigned local package and `--pubkey` cannot bypass it; environment policy honoured exactly like an injected one.

Non-trust tests across package-sdk, runtime, registry, api, cli and compiler now declare explicit development mode in one visible place each (a helper, or the call), because trust is no longer implicit.

### 8.5 Remaining limitations (not claimed)

- Trust anchors are a file on the host; whoever can write it, or set `XO_TRUST_MODE`/`XO_PACKAGE_TRUST_POLICY`, controls trust.
- The production guard keys on `NODE_ENV=production` only. A production-in-practice deployment that does not set it can run development mode if `XO_TRUST_MODE=development` is set. Enterprise deployments must set `NODE_ENV=production` and never set `XO_TRUST_MODE`; code cannot enforce intent beyond that signal.
- The CLI cannot sign with an existing key (`--sign` generates a throw-away key); persistent-key signing needs the SDK. No key-custody tooling (out of scope).
- Policy changes reach the API only on restart; no revocation distribution, revocation-time semantics or signing-time proofs; no certificate chains or multi-signature approval (out of scope).
- Packages already installed in development mode are not flagged retroactively; they are refused only when evaluated under an enforcing policy (mount, verify).
- Trust is evaluated at install and mount, not on every component read (reads re-hash against the manifest only).
- `metadata.json`/`CHANGELOG.md` are not signed; undeclared archive entries are ignored; single-process; not tested on Windows. `xo doctor` now fails on a fresh checkout until a trust mode is chosen (intentional).
- Test results here are not evidence of production readiness: no deployment, key-management, or operational testing was performed.
