# Password sign-in — design (milestone proposal, not implemented)

Status: **DESIGN FOR REVIEW. No code for this exists on any branch.** Password login is approved as an _additional_ authentication method next to Google sign-in. It is a dedicated security workstream: it ships on its own branch, with its own review, and must not change the behaviour of Google sign-in, OIDC or API keys. This document is written against `AUTH_API_CONTRACT.md` as it stands and reuses its primitives instead of inventing parallel ones.

## 1. Goals and non-goals

**Goals**

- A person can sign in to Studio with a login name and a password, and receives the same kind of XO session (`xoas_` / `xoar_`) that Google sign-in issues, resolving to the same principal model.
- Passwords are stored only as salted, memory-hard hashes. A password never appears in plaintext in storage, logs, audit events, responses, errors or client-side storage.
- Sign-in is hard to enumerate and slow to brute-force or credential-stuff.
- Changing a password ends other sessions. A disabled account or a revoked binding ends all sessions immediately.
- Google sign-in, OIDC and API keys behave byte-for-byte as before, including when this feature is off (the default).

**Non-goals (explicitly out of this milestone)**

- Self-service "forgot password" by email (§9). Blocked until email delivery and token handling are designed and verified.
- Self-registration. See §3: it contradicts an existing rule.
- Passkeys / WebAuthn, TOTP or any second factor (§12, listed as a residual risk).
- Federating password accounts across hosts. The supported boundary stays what `AUTH_API_CONTRACT.md` states: one host, a local POSIX filesystem.

## 2. What already exists and must be reused

| Existing primitive                                                                                                                                                  | Source                                 | How this design uses it                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Principal derived only from a server-side **binding** `(issuer, sub) → identity`; nothing auto-provisioned; no HTTP route creates bindings                          | `AUTH_API_CONTRACT.md` "Binding"       | Password accounts are bound exactly this way, with a reserved issuer (§3).                                  |
| Opaque server-side sessions: 15-minute access, 30-day single-use rotating refresh, 90-day family cap, **reuse detection revokes the family**, logout revokes family | `auth/session/session-store.ts`        | Password sign-in mints a session family through the same service (§6).                                      |
| Single-use via atomic `rename`; 0600 files in 0700 directories; digests only, no plaintext credentials on disk                                                      | `auth/session/fs-util.ts`              | Same storage discipline for accounts, attempt counters and setup/reset tokens.                              |
| Per-process, per-address rate limiter → 429 `XO_AUTH_RATE_LIMITED`                                                                                                  | `auth/session/rate-limiter.ts`         | Kept as the outer layer; **not sufficient alone** (it is per process, and forwarding headers are untrusted) |
| Fixed-string errors that never say which check failed                                                                                                               | error table in the contract            | New generic code for password failures (§5).                                                                |
| `authentication: { credential, issuer? }` recorded on executions                                                                                                    | `auth/recorded-authentication.ts`      | Additive `method` field (§6).                                                                               |
| Hash-chained audit log                                                                                                                                              | `apps/api/src/audit/` (Studio backend) | A separate, account-level instance records auth events (§8).                                                |
| Feature configured by environment, **startup refuses invalid or partial configuration**                                                                             | `auth/session/config.ts`               | Same pattern for the password feature flag (§10).                                                           |

## 3. Account model — and why there is no "Create account"

The project's rule is that identities are **operator-bound and never auto-provisioned**, because an open endpoint that mints access would let anyone grant themselves access. Open self-registration breaks that rule, so **this milestone does not include it**, and the Studio sign-in screen's "Create account" link must not ship. (If you want self-registration later, it is a separate decision about tenancy and approval, not an authentication detail.)

Instead, a password account is a credential attached to an identity an operator has already decided exists:

```
PasswordAccount (one file per account, 0600)
  accountId        random 128-bit id, immutable. This is the OIDC-style "subject".
  loginName        normalized (NFKC, trimmed, lower-cased) and unique. May look like an email; it is a label, not a verified address.
  hash             PHC-format string (algorithm + parameters + salt + digest)
  passwordVersion  integer, bumped by every password change or reset (§7)
  state            active | disabled
  createdAt, passwordChangedAt
  failure counters live in a separate store (§4), never on this record
```

The account is linked to a principal through the **existing binding store**, under a reserved issuer string `xo:password` with `sub = accountId`:

```
node --import tsx apps/api/scripts/manage-password-accounts.ts create --login <name> --identity <principalId> --kind human
  -> creates the account (no password yet), binds (xo:password, accountId) -> principalId,
     prints a single-use setup code (§9) — never a password
```

Consequences worth stating plainly:

- The principal is still minted **from the binding record only**. Nothing in the login request, the account record or any claim can name a principal or organization.
- A binding revoked by the operator immediately ends password sessions, exactly as for Google (§6).
- A person who has both a Google binding and a password binding to the **same `identityId`** is one principal reached two ways. That is intended and is the operator's choice.
- The operator, not the user, decides who may have a password. Operator-created accounts can be audited (§8).

## 4. Hashing, password policy and abuse controls

### 4.1 Hashing (decision needed, §13-1)

- **Recommended: Argon2id** (OWASP's first choice), from a maintained library, e.g. `@node-rs/argon2` or `argon2`. Starting parameters per current OWASP guidance (memory 19 MiB or more, 2 iterations, 1 lane — or 46 MiB / 1 iteration); the **deployed values are chosen by measuring the target host** so one verification costs on the order of 100-250 ms, and are stored inside each PHC string.
- **Fallback if a new native dependency is unacceptable:** Node's built-in `crypto.scrypt` with `N = 2^17, r = 8, p = 1`. Also OWASP-acceptable, no new dependency, slightly weaker against GPU attackers than Argon2id.
- Never SHA-\*, bcrypt-with-low-cost, or a home-made construction. No "peppered" fast hash.
- **Rehash on login** when the stored parameters are weaker than current policy.
- **Optional pepper:** an HMAC of the (normalized) password under a server secret from the environment, applied before hashing, with a key id stored in the PHC string to allow rotation. Pros: a stolen account directory alone is not crackable. Cons: key management and rotation complexity, and the secret becomes a deployment requirement. Default off; decision in §13-2.
- Verification runs under a **concurrency cap** with a bounded queue. Memory-hard hashing is itself a denial-of-service vector; when the queue is full the API answers 503, not a slow hang.

### 4.2 Password policy (NIST SP 800-63B)

- Minimum **12** characters, maximum **128** characters and 1024 UTF-8 bytes, checked **before** any hashing so oversized input cannot be used to burn CPU.
- Any printable Unicode, including spaces. **NFKC-normalized** before hashing so the same visible password is always the same bytes.
- **No composition rules** and **no periodic expiry** (both are counterproductive per NIST). Reject: passwords on a bundled common-password blocklist, ones equal to or containing the login name, and ones that are all one repeated character or a trivial sequence.
- Online breach-database checks are **off by default** (they need outbound network, which is incompatible with air-gapped mode). If enabled later they must use k-anonymity and fail open with a logged warning, never block sign-in.

### 4.3 Throttling and credential-stuffing resistance

Four layers, because the existing limiter is per process and per address only:

1. **Outer limiter** (existing): per client address and process, `POST /auth/password/login` capped (proposed 10/min). Unchanged mechanism.
2. **Per-account, per-source counter**, persisted on disk (atomic rename, shared by all processes on the host): consecutive failures for the pair (normalized login name, source address) back off exponentially (1 s, 2 s, 4 s … capped at 15 minutes). Applies identically whether or not the account exists, so throttling reveals nothing (§5).
3. **Per-account soft ceiling:** more than a threshold of failures across all sources inside a window (proposed 20 / 15 min) adds a delay for _every_ source until the window clears. This is a deliberate trade-off: it lets an attacker slow a victim's sign-in (a temporary denial of service) in exchange for stopping a distributed guesser. There is **no permanent lockout**, because permanent lockout is a trivial denial-of-service against any known login name.
4. **Global circuit breaker:** if password failures across **distinct** accounts exceed a threshold in a short window (the signature of credential stuffing), new password attempts get a short uniform delay and an `auth.password.stuffing_suspected` event is written. This protects the host; it is not a substitute for a WAF or a distributed limiter.

Limits stated plainly: counters are per host. Behind a reverse proxy every client shares the proxy's address (forwarding headers are not trusted), so layers 1-2 act as shared caps there. This is **not** a distributed rate limit and must not be described as one.

Counters for unknown login names are keyed by a **keyed hash** of the name (not the name), bounded in number with oldest-first eviction, so an attacker cannot fill the disk or learn names from it.

## 5. Login endpoint and error behaviour

```
POST /auth/password/login      { loginName, password }       (unauthenticated, rate limited)
  -> 201 { accessCredential, refreshCredential, accessExpiresAt, refreshExpiresAt }
  -> 401 XO_AUTH_CREDENTIALS_INVALID    one fixed message for ALL of:
        unknown account · wrong password · disabled account · no active binding · account with no password yet
  -> 429 XO_AUTH_RATE_LIMITED           uniform, same for existing and non-existing names
  -> 503 XO_AUTH_PROVIDER_UNAVAILABLE   store failure or hash queue full (fail closed)
```

Anti-enumeration rules, each with a test (§11):

- **One error for every failure** — same status, same body, same headers.
- **Equal work:** an unknown login name still verifies the supplied password against a fixed dummy hash with the same parameters, so response time does not separate "no such account" from "wrong password".
- An account with a valid password but **no active binding** also gets the generic error. (Google deliberately distinguishes `XO_AUTH_IDENTITY_UNBOUND` because Google has already proven who the person is; a password endpoint must not become an oracle for which login names exist.)
- Error text is a fixed string. It never echoes the login name, never says which check failed, never reveals a throttle's remaining time beyond a uniform `Retry-After`.
- `Cache-Control: no-store` on every response.

Other routes reused unchanged: `POST /auth/refresh` and `POST /auth/logout` operate on the session family regardless of how it was created.

## 6. Session integration

Reuse `SessionService`'s family minting; do not build a second session system.

- Add an additive `method: 'google' | 'password'` to the session family record and to the recorded authentication (`credential: 'session', method`). Records without it are read as before; nothing is back-filled.
- A password session family also stores `accountId` and the account's `passwordVersion` at creation.
- **Every request** on a password session re-checks, in addition to the existing binding re-read: account is `active`, and the family's `passwordVersion` equals the account's current one. A mismatch **permanently revokes that family** (same behaviour the contract describes for revoked bindings: re-enabling later does not revive old sessions).
- An index `by-account/<accountId>/<familyId>` lets a password change or disable revoke every family for the account without scanning all sessions.
- `refresh` re-runs the same checks, so a stolen refresh credential stops working the moment the password changes.
- **Studio** keeps the access credential in memory and the refresh credential in the OS keychain exactly as for Google. **It never stores the password, in memory beyond the submit, keychain, `localStorage`, `sessionStorage`, logs, or crash reports.** The field uses `type="password"`, correct `autocomplete` attributes, and is cleared after submit.
- Passwords travel only over TLS. The API refuses password routes over plain HTTP except to loopback for development.

## 7. Password change and session invalidation

```
POST /auth/password/change     (authenticated by an xoas_ session)   { currentPassword, newPassword }
  -> 200  new passwordVersion; every OTHER session family of the account is revoked; the calling session continues
  -> 401  XO_AUTH_CREDENTIALS_INVALID   (current password wrong; counted by the same throttle as login)
  -> 400  policy violation (message names the rule, never the password)
```

- Requires re-entering the current password even with a valid session (a stolen access credential must not be enough to take over the account).
- New password must differ from the current one.
- A reset or an operator-forced reset (§9) revokes **all** families including any the caller holds.
- Disabling an account (operator CLI) revokes all families immediately and makes the next request on any of them fail.

## 8. Audit and logging

There is no account-level audit today: workspace audit logs belong to a workspace and authentication happens before one is chosen. This milestone adds a separate **auth event log** reusing the hash-chained implementation with its own store and a reserved scope id.

Events (all carry time, `accountId` where one exists, a source-address _hash_ rather than the address, and the result): `auth.account.created`, `auth.password.setup_completed`, `auth.password.login_succeeded`, `auth.password.login_failed`, `auth.password.throttled`, `auth.password.changed`, `auth.password.reset_issued` / `reset_completed`, `auth.sessions.revoked` (with reason: password_change, disabled, binding_revoked, reuse_detected), `auth.account.disabled`, `auth.password.stuffing_suspected`.

Hard rules:

- **No password, hash, salt, pepper, token, code, session credential or digest is ever written** to an audit event, a log line, a response or an error message.
- Failed attempts for unknown names record only a keyed hash of the name.
- The HTTP layer must **not log request bodies** for `/auth/*`. A test asserts it (§11).
- The audit chain limits that apply to the workspace log apply here: it makes partial edits detectable; it does not stop someone with write access to the directory from rewriting the whole chain unless the head hash is anchored somewhere outside it.

## 9. Setup tokens, recovery, and what is deferred

The initial password and any recovery need the **same primitive**: a short-lived, single-use token that lets a person set a password without the operator ever learning it. Designing it once, used in two stages:

```
Token (one file, filename = SHA-256 digest of the token; the token itself is never stored)
  accountId, purpose (setup | reset), passwordVersion at issue, expiresAt, issuedBy
  256 random bits, base64url
  setup: valid 24 h        reset: valid 30 min
  at most ONE outstanding token per account — issuing another supersedes (deletes) the previous
  redeemed by atomic rename: of any number of concurrent attempts exactly one wins
  bound to passwordVersion: ANY password change invalidates every outstanding token
  one error for unknown / expired / used / superseded / wrong-account (no hint which)
  redemption attempts are throttled like logins (§4.3)
```

**Stage A (this milestone) — operator-assisted, no email infrastructure needed**

- `manage-password-accounts.ts create` prints a setup token; the operator hands it to the person out of band. `POST /auth/password/setup { token, newPassword }` sets the first password.
- `manage-password-accounts.ts reset --login <name>` issues a reset token the same way (admin-assisted recovery) and revokes nothing until the token is redeemed.
- **Explicit limitation, to be shown to anyone enabling this for real users:** _a person who forgets their password cannot recover their account by themselves; an operator must issue a reset token. An operator who can issue tokens can take over any password account — every issuance is audited (§8), and this trust is inherent in admin-assisted recovery._

**Stage B (blocked until designed) — self-service forgot-password by email**

Needs, before any code: a verified outbound mail mechanism with its own failure and bounce handling, a decision on whether `loginName` is a verified address, uniform responses so "forgot password" never reveals whether an account exists, per-account and per-address request throttling, and token delivery that never lands in logs. **Do not implement or enable forgot-password until those are designed.** The Studio "Forgot password?" link stays hidden or reads "Contact your workspace admin" until then.

## 10. Configuration and rollout

- **Off by default.** Enabled only by `XO_API_PASSWORD_AUTH=1`. With it unset, the `/auth/password/*` routes are not registered (404), no account store is touched, and the process behaves identically to today. A test asserts the registered route set and responses are unchanged when off.
- When on, required: `XO_API_ACCOUNTS_DIR` (default `.xo-data/accounts`, local filesystem, one host), hashing parameters (defaults from measurement), optional `XO_API_PASSWORD_PEPPER`. Any invalid or partial value stops startup naming the variable, never its value — same rule as `auth/session/config.ts`.
- Requires the session service (`XO_API_GOOGLE_CLIENT_ID` is not required; the session store is). If sessions are not configured, password auth refuses to start.
- Roll-out order: (1) land the code dark, (2) enable for operators in a non-production environment, (3) security review sign-off, (4) enable for named users with the §9 limitation acknowledged in writing.

## 11. Test plan (all additive; none may modify an existing test)

**Authentication failures and enumeration** — wrong password, unknown name, disabled account, unbound account, account without a password: identical status, body and headers. A spy on the hasher proves an unknown name still performs a verification. Throttled responses are identical for existing and non-existing names.

**Throttling** — per-pair exponential backoff; soft ceiling delays other sources; no permanent lockout; global breaker trips on many distinct accounts failing; counters shared across two server processes on one directory; counter store is bounded and keyed by hash.

**Hash and policy** — PHC output, per-account salt, parameters upgraded on login, minimum and maximum lengths enforced before hashing, Unicode normalization equivalence, blocklist and login-name-in-password rejection, oversized body refused cheaply, hash queue full → 503.

**Tokens (setup and reset)** — replay of a used token fails; expired token fails; superseded token fails; token for another account fails; concurrent redemption: exactly one wins; any password change invalidates outstanding tokens; digest-only storage verified by scanning the directory for the token; one error for every failure.

**Sessions** — password change revokes other families and keeps the caller; reset and disable revoke all; a stolen refresh credential fails after a change; revoked binding ends password sessions and re-binding does not revive them; refresh re-checks account state and `passwordVersion`.

**Secrets never leak** — run the whole flow with a unique canary password and assert it appears nowhere in: any stored file, the audit log, server log output, any response body or header, any error message. Same for tokens and setup codes. Assert `/auth/*` request bodies are never logged.

**Regression for everything else** — the existing `session-auth`, `session-records`, `session-integration`, `oidc-*` suites pass **unmodified**; with the flag off the route table and the `/auth/*` responses are byte-identical; Google sign-in, refresh and logout are re-run with password auth enabled to prove no interaction; a Google session and a password session for the same identity coexist and revoke independently.

**Operator CLI** — create/disable/reset commands, token printed once and never stored, refuses to run with a password on the command line (interactive no-echo only if ever added).

## 12. Threats and residual risks (to be reviewed, not assumed solved)

| Threat                                         | Mitigation in this design                                         | Residual risk                                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Offline cracking of a stolen account directory | Argon2id/scrypt, per-account salt, optional pepper                | A weak chosen password is still weak; pepper adds key management                                                           |
| Online guessing / credential stuffing          | Four throttling layers, no confirmation oracle                    | Counters are per host; a distributed attack behind a shared proxy address is only capped, not blocked — needs a WAF or IdP |
| Account enumeration                            | One error, equal work, uniform throttling, no unbound distinction | Timing is statistical; a determined attacker with many samples may still learn something — measured, not guaranteed        |
| Phishing / password reuse                      | None beyond policy                                                | **Passwords are phishable and reusable. No second factor exists.** Recommend admins keep Google sign-in as the primary     |
| Session theft after password change            | passwordVersion binding; families revoked                         | Access credentials already issued live up to 15 minutes unless the family is revoked (as today)                            |
| Operator abuse                                 | All issuance and resets audited                                   | An operator can take over a password account by design; audit is tamper-evident, not tamper-proof                          |
| Denial of service by locking a known login     | Soft ceiling, no permanent lockout                                | A victim can be slowed for the window                                                                                      |
| Denial of service by hashing cost              | Length caps before hashing, concurrency cap, bounded queue, 503   | A large botnet can still saturate the host                                                                                 |
| Secrets in logs/telemetry                      | No body logging on `/auth/*`, canary tests, fixed error strings   | A future logging change could regress — the canary test is the guard                                                       |
| Single-host storage                            | Same documented boundary as sessions                              | No multi-host support                                                                                                      |

## 13. Decisions needed from the owner before implementation

1. **Hashing library:** accept one new maintained dependency for **Argon2id** (recommended), or stay dependency-free with **scrypt**?
2. **Pepper:** adopt the optional server-side pepper, or leave it out for the first release?
3. **Login name:** free-form handle chosen by the operator (proposed), or must it be an email address? (Verification of the address belongs to stage B either way.)
4. **Who may issue setup/reset tokens in stage A:** operator CLI only (proposed, no new HTTP authorization surface), or also a Studio admin action over HTTP (needs its own authorization and review)?
5. **On password change:** keep the calling session and revoke the rest (proposed), or revoke everything and force a fresh login?
6. **MFA:** is a second factor (TOTP) a precondition for enabling passwords for admin-role members, or an accepted residual risk with Google sign-in recommended for admins?
7. **Stage B:** is there a planned email service? Until there is, the §9 limitation stands and must be disclosed to users.

## 14. Out of scope here, tracked elsewhere

Passkeys (separate milestone), self-registration, SSO changes, workspace-level role changes (those live in the Studio backend branch), the Studio screens for sign-in/change password (built after the API is reviewed, against the contract this design produces).
