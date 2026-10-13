# P1.0 M5 — Package Trust: Implementation Report

**Status:** implemented and committed locally on `feat/p10-m5-package-trust`; **not pushed**. Evidence below; this is not a production-readiness claim.

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
- **Compatibility/migration:** package format and signed bytes unchanged. Unenforced default keeps existing flows working. API `publicKeys` is a deliberate breaking change. Pre-M5 install records lack `manifestDigest`, so that check is skipped for them (trust is still re-verified at mount under an enforcing policy).

## 5. Tests (all real verification code; no trust mocks)

Added: `package-sdk/test/package-trust.test.ts` (26), `package-sdk/test/archive-hardening.test.ts` (7), `runtime/test/package-trust-mount.test.ts` (5), `api/test/package-trust.test.ts` (3), `cli/test/package-trust.test.ts` (4). Mutation checks: removing `pinBundle` and reverting the tar reader each make the corresponding new tests fail.

## 6. Remaining limitations / not claimed

- **Default is unenforced** (see Open decision). Without a policy file nothing is trusted _or_ verified.
- No certificate chains, no threshold/multi-signature beyond "required roles", no automated rotation/revocation distribution (policy edit + restart), no revocation-time semantics (revoked = reject always), no signing-time/timestamp proofs.
- `metadata.json` and `CHANGELOG.md` are not covered by hashes or signatures (not used for execution; capabilities come from the signed manifest). Archive entries not declared in the manifest are ignored, not rejected.
- Local-filesystem confinement beyond lexical checks is unchanged: `LocalFsBlobStore` does not `realpath` (a pre-planted symlink in the store is out of reach of package content; tar symlinks are now rejected). Windows behaviour is lexically covered only; not tested on Windows.
- Stale files from a prior version at the same path are not removed on forced reinstall.
- TOCTOU between mount and later component reads is mitigated by per-read hashing, not eliminated; the manifest is not re-verified on each read. Concurrent writers to the same store are not coordinated.
- Single-process, key custody (KMS/HSM) out of scope. `xo build --sign` still generates throw-away development keys.
- Not performed: M7, system-wide P1.0 audit, push/PR.

## 7. Open decision for the owner

Whether `unenforced` should remain the default. Switching to default-deny means changing `loadOperatorTrustPolicy`'s unset case and giving test harnesses/dev flows an explicit policy; it would break unsigned local compile→run flows until keys are provisioned.
