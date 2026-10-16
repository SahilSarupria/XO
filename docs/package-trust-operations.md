# Package trust — operator guide (P1.0 M5)

This guide covers how XO decides whether a package may be **installed, published, verified, mounted or run**, how to configure
that, and how to migrate from unsigned local packages. It is the operator-facing companion to the decision record
(`P10_ENTERPRISE_TRUST_DECISIONS.md` §G) and the implementation report (`P10_M5_PACKAGE_TRUST_IMPLEMENTATION_REPORT.md`).

> Passing tests is not a production-readiness claim. See [Limitations](#limitations).

## The one rule

**Trust is fail-closed.** Every entry point resolves its trust configuration through one function
(`loadOperatorTrustPolicy` in `@xo/package-sdk`), so the CLI, the API, registry publish, install and runtime mounting cannot
disagree about the effective mode or policy. With nothing configured, they all refuse.

A missing policy is **never** interpreted as "development mode". Development mode exists only when you ask for it by name.

## Configuration

Two environment variables, read by the CLI (per command) and the API (once, at startup):

| Variable                  | Values                            | Meaning                                                                                                                      |
| ------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `XO_PACKAGE_TRUST_POLICY` | path to a policy JSON file        | The operator trust anchor. Selects **enforce** mode.                                                                         |
| `XO_TRUST_MODE`           | unset / `enforce` / `development` | Unset means `enforce`. `development` explicitly disables verification (see below). Any other value is an error, not a guess. |

Resolution table (any combination not listed is an error):

| `XO_TRUST_MODE`   | `XO_PACKAGE_TRUST_POLICY` | `NODE_ENV`     | Result                                                      |
| ----------------- | ------------------------- | -------------- | ----------------------------------------------------------- |
| unset / `enforce` | readable, valid file      | any            | **enforce**, policy from the file                           |
| unset / `enforce` | unset or blank            | any            | **error** `XO_PACKAGE_TRUST_NOT_CONFIGURED`                 |
| unset / `enforce` | unreadable / invalid      | any            | **error** (never a downgrade)                               |
| `development`     | unset or blank            | not production | **development** (nothing verified, nothing trusted)         |
| `development`     | set                       | any            | **error** — ambiguous; a configured policy is never ignored |
| `development`     | any                       | `production`   | **error** — development mode is forbidden in production     |
| anything else     | any                       | any            | **error** — unknown mode                                    |

"Error" means: the CLI command exits 1 with `error: [XO_PACKAGE_TRUST_NOT_CONFIGURED] …` and writes nothing; the API refuses to
start. `XO_PACKAGE_TRUST_NOT_CONFIGURED` maps to HTTP 500 where it can surface on a request path, because it is an operator
fault, not the caller's.

The production guard applies to **every** policy source, including a policy injected in code by an embedder or test harness
(`assertTrustPolicyAllowedHere`). No entry point is the permissive one.

### Secure defaults

- No configuration ⇒ refuse. There is no implicit development mode and no "unenforced" mode any more.
- A policy **file cannot** select development mode or disable verification: `mode` in the file may only be `"enforce"` (or
  omitted). A file saying `"mode": "development"` is rejected.
- `NODE_ENV=production` + development mode ⇒ refuse, from the environment or when injected.
- Development mode + a policy file ⇒ refuse.
- A policy file that is missing, a directory, empty, not JSON, the wrong version, has unknown fields, non-Ed25519 keys, private
  key material, duplicate keys, or a key both active and revoked ⇒ refuse.

## Enforce mode

Write a policy file and point `XO_PACKAGE_TRUST_POLICY` at it:

```json
{
  "version": 1,
  "mode": "enforce",
  "requireSignature": true,
  "requiredRoles": ["creator"],
  "bindPublisher": true,
  "keys": [
    {
      "signerDid": "did:xo:acme-publisher",
      "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n",
      "algorithm": "ed25519",
      "status": "active",
      "notBefore": "2026-01-01T00:00:00Z",
      "notAfter": "2027-01-01T00:00:00Z"
    }
  ]
}
```

Every field except `version` and `keys` is optional; the defaults are the strict ones shown above.

Under an enforcing policy a package is admitted only if: it carries a signature (when `requireSignature`), **every** signature
entry verifies against a key in the policy for that signer DID (malformed, unknown-signer, revoked, out-of-window and
non-verifying entries each fail the whole package), every `requiredRoles` role has a verified signature, and — with
`bindPublisher` — the creator signature comes from `manifest.creatorDid`. Anything the package itself carries (an embedded
`publicKeyPem`, a key in the manifest, API `publicKeys`) is never consulted.

A valid signature proves possession of a trusted key over the manifest, which commits to the component hashes. It does not prove
the package is benign or authorised — M2 (authorization) and M3 (approval) remain authoritative for that.

**Revoking or rotating:** set the key's `status` to `"revoked"` with `revokedAt`, add the replacement key, re-sign. Revocation is
conservative: a signature by a now-revoked key is rejected regardless of when it was made (the package format carries no
trustworthy signing time). The CLI re-reads the policy on every command; the **API reads it once at startup, so restart it**.

## Development mode

`XO_TRUST_MODE=development` is a local-development compatibility mode for **locally compiled, unsigned packages**.

- Signatures are **not verified** and **no package is ever reported trusted**. A package admitted this way has status
  `unverified` and mode `development` — a distinct state from `unsigned` (permitted by an enforcing policy that does not require
  signatures) and from `trusted`.
- It cannot be enabled when `NODE_ENV=production`, cannot be combined with a policy file, and cannot be selected by a policy file.
- It is surfaced everywhere, not just once:
  - **API:** a startup warning (`PACKAGE TRUST IS DISABLED …`), `bootstrapWarnings` on every runtime response, a `trust`
    object (`mode`, `status`) on `/packages/validate` and registry publish responses, and a `TRUST_DEVELOPMENT_MODE` warning
    in validation reports.
  - **CLI:** a `warning:` line on `install`, `verify`, `publish` and `run` (and in the `--json` `warnings` array of `run`);
    `trust: unverified [mode=development]` on install/publish; `TRUST: unverified [mode=development]` on `verify`;
    `xo doctor` shows `package_trust … mode=development — …`.
  - **Install records:** `trust: { status: "unverified", mode: "development", … }`.
- `xo verify --pubkey` (operator-supplied key files) works **only** in development mode. Under an enforcing policy it is refused,
  so it cannot produce a "VALID" the policy would reject.

Do not use development mode in production or for enterprise tenants. The guard above enforces the production half of that; the
enterprise half is a deployment practice you must hold (see Limitations).

## Diagnostics

`xo doctor` reports `package_trust` through the same resolver install/verify/publish/run use, so it can never say "ok" about a
configuration those commands would refuse:

```
FAIL  package_trust  [XO_PACKAGE_TRUST_NOT_CONFIGURED] no package trust policy is configured: set XO_PACKAGE_TRUST_POLICY …
ok    package_trust  mode=enforce, 3 trusted key(s), policy sha256:…
ok    package_trust  mode=development — PACKAGE TRUST IS DISABLED (XO_TRUST_MODE=development): …
```

Note this means a fresh checkout's `xo doctor` fails until a trust configuration is chosen. That is intentional.

## Entry points covered

| Entry point                                                      | Behaviour                                                                                                                  |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `xo install`                                                     | Resolves trust first; refuses with nothing written if not configured; admits per mode; records the verdict.                |
| `xo verify`                                                      | Same resolver; prints `TRUST: <status> [mode=<mode>]`.                                                                     |
| `xo publish` / `POST …/registry/packages`                        | Registry client is built with the effective validator; refuses unconfigured/untrusted; response carries the verdict.       |
| `xo run` / API runtime bootstrap / mount                         | Installer is built with the effective validator; mount re-evaluates trust under the **current** policy from a single read. |
| `POST /packages/validate`                                        | Effective policy only; request-supplied `publicKeys` is rejected (400).                                                    |
| API startup                                                      | Aborts without a valid configuration; logs development mode loudly.                                                        |
| `PackageInstaller` / `RegistryClient` / `PackageValidator` (SDK) | Built with no policy they are **unconfigured** and fail closed. `skipValidation` never bypasses the trust check.           |
| `xo create` / `xo build` / `xo pack` (authoring)                 | Validate structure before writing a file; they admit, publish, mount and run nothing, so no policy applies (see below).    |

**Authoring commands.** `create`, `build` and `pack` check a package's structure (schema, hashes, Merkle root) before writing it.
They use an explicit development-mode validator (`authoringValidator()`), never evaluate signatures against a policy, and never
claim trust. The packages they sign use a throw-away development key that no enforcing policy trusts.

## Migrating from unsigned local packages

Before M5 the default was "verify nothing", and `xo create --sign` / `xo build --sign` produce packages signed by a **freshly
generated throw-away key**. After this change, with no configuration every command refuses.

**Local development (keep working as before):**

```sh
export XO_TRUST_MODE=development      # explicit; never inferred
xo create policy.pdf --name my_pkg    # unsigned or dev-signed local package
xo install my_pkg-1.0.0.xo --store ./store
xo doctor                             # shows mode=development
```

Packages installed this way are recorded `unverified`/`development`. They are **not** trusted.

**Moving to enforce mode** (staging, enterprise, production):

1. Decide the publisher identity (`creatorDid`) and generate a long-lived Ed25519 keypair under your own key-management process.
2. Create a policy file listing the public key for that DID (see above) and set `XO_PACKAGE_TRUST_POLICY`; unset `XO_TRUST_MODE`.
3. Re-sign each package with that key, with `signerDid` equal to the manifest's `creatorDid` (publisher binding).
4. Reinstall with `xo install … --force`. **Packages previously installed in development mode are refused at mount under an
   enforcing policy** (`PACKAGE_UNSIGNED`/signature errors in the mount failure) until reinstalled — the migration is never silent.
5. Check `xo doctor` and `xo verify <pkg>.xo` (`TRUST: trusted [mode=enforce]`).

**Pre-M5 install records** have no `trust` field and no `manifestDigest`; they stay readable, the manifest-digest check is
skipped for them, and trust is still re-evaluated at mount under the current policy.

**Practical gap — signing with a persistent key.** The CLI can only sign with a _freshly generated_ key (`--sign`, optionally
`--key-out <prefix>` to save it); there is no command that signs with an existing key. A persistent publisher key therefore has to
be applied through the SDK (`PackageSigner.sign(manifest, did, 'creator', privateKeyPem, publicKeyPem)`). Adding each generated
key to the policy per build works but does not scale. A signing command is outside M5; see Limitations.

## Limitations

- Trust anchors are a **file on the host**. Whoever can write that file (or set the two environment variables) controls trust.
  Protect it, keep it off package-writable paths, and treat `XO_TRUST_MODE` as sensitive.
- `NODE_ENV=production` is the only environmental signal the production guard can see. A deployment that is production in every
  respect but does not set `NODE_ENV=production` **can** run development mode if someone sets `XO_TRUST_MODE=development`.
  Enterprise/production deployments must set `NODE_ENV=production` and must not set `XO_TRUST_MODE`. The code cannot know the
  deployment's intent beyond that.
- Policy changes reach the API only on restart. There is no revocation distribution, no revocation-time semantics (revoked ⇒
  always rejected), and no signing-time proofs.
- No certificate chains, no threshold/multi-signature beyond "required roles", no KMS/HSM or key-custody tooling, no CLI command to
  sign with an existing key.
- `metadata.json` and `CHANGELOG.md` are not covered by hashes or signatures (not used for execution). Archive entries not
  declared in the manifest are ignored, not rejected.
- Development-mode packages already on disk are not removed or flagged retroactively; they are refused only when something later
  evaluates them under an enforcing policy.
- Single process; concurrent writers to one store are not coordinated. TOCTOU after mount is mitigated by per-read hashing, not
  eliminated. Windows behaviour is lexically covered only.
