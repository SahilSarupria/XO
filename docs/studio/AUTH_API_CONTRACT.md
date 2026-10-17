# Studio ⇄ XO API authentication contract

Status: **Two sign-in paths, both implemented and tested only against local fake providers.** (1) Generic provider-JWT OIDC: the API verifies JWT access tokens from one configured issuer (`apps/api/test/oidc-*.test.ts`). (2) **Google sign-in → XO sessions** (this document's last major section): Google authenticates the user, the XO API verifies Google's ID token, and the API issues its own opaque session credentials; Google tokens are never used as API credentials. **Neither has been run against a real identity provider, Studio's desktop flow has not been run on a real desktop, and the Rust/Tauri code has never been compiled.** Until the API is configured, it is API-key-only and answers 401 to anything else exactly as before.

## Trust boundary

1. The XO API verifies the credential and **derives the principal itself**, from verified `(iss, sub)` mapped through a server-side binding record, exactly as it derives it from the key record today (`establishAuthenticatedPrincipal`). Headers, query, body, or token claims such as `email`, `org`, or `groups` never establish a principal or organization by themselves.
2. Authorization stays in `@xo/permissions`. A valid identity grants nothing by itself. The request carries `authentication: { credential: 'api-key' | 'oidc', issuer? }` as attribution context. **Gap:** this branch has no durable audit package (`@xo/audit` is on the integration line, not in this branch's ancestry), so credential type and issuer are not persisted in any audit record yet; only the principal snapshot on execution/workflow records is.
3. Studio is a public client. It holds no client secret, makes no identity decision, never sees the ID token, and never persists access tokens. (For Google, the code-for-token exchange happens on the API, which alone holds the OAuth client secret; see below.)

## What the API does (implemented)

Source: `apps/api/src/auth/oidc/`, `apps/api/src/http/auth.ts`. Library: [`jose`](https://github.com/panva/jose) (MIT, zero runtime dependencies, maintained; the only new dependency).

**Credential dispatch.** Two separate mechanisms, chosen by the credential's shape, never by anything the caller claims. A token starting `xoak_` is always an API key and is never given to the JWT verifier. A compact JWS (three base64url segments) goes to OIDC **only when OIDC is configured**. Anything else, including a JWT when OIDC is not configured, takes the unchanged API-key path and gets the unchanged `XO_AUTH_KEY_INVALID`.

**Verification** (`createOidcVerifier`):

- Algorithm allow-list `RS256`, `PS256`, `ES256`. `none`, every `HS*`, and anything else are refused before any network call.
- `iss` must equal the configured issuer exactly (string comparison, no normalisation). `aud` must contain the configured audience. `exp` and `sub` are required. `nbf` is enforced when present; `iat` more than the skew in the future is refused. Skew defaults to 30 s (`XO_API_OIDC_CLOCK_SKEW_SECONDS`, 0–120).
- Access tokens only, and the **token profile the API accepts is a JWT access token**: signed with an allowed algorithm, `iss` = the configured issuer, `aud` containing the API audience, `sub` present, `exp` present. Opaque (non-JWT) access tokens are not supported: they are refused as `XO_AUTH_KEY_INVALID` (they take the API-key path). Introspection (RFC 7662) is not implemented. Refused as ID-token indicators: a `nonce` claim, `token_use` other than `access`, and a header `typ` other than absent, `JWT` or `at+jwt` (RFC 9068). The audience check is the primary defence (an ID token's `aud` is the client id, not the API audience); these catch an ID token minted for the same audience.
  - **Provider compatibility is not established, because no provider is named or configured.** Known points to confirm per provider before go-live: (a) the provider must issue JWT access tokens carrying the API audience (some, e.g. AWS Cognito, put a `client_id` and no `aud` in access tokens, which this verifier refuses; Keycloak needs an audience mapper so `aud` contains the API audience); (b) the provider must not copy a request `nonce` into access tokens (Keycloak can). Studio therefore **does not send a `nonce`** (it never reads the ID token, so a nonce had no security value); (c) the header `typ` must be absent, `JWT` or `at+jwt`. If a provider's real access tokens are refused by (a)-(c), the verifier is the thing to adapt for that provider, with a test; do not remove the checks to make a login pass.
- Tokens over 8 KiB are refused. Only `(iss, sub)` leaves the verifier; no other claim is read anywhere in XO.
- Keys: the JWKS URL comes from `{issuer}/.well-known/openid-configuration` (the document's `issuer` must equal the configured issuer exactly; redirects are not followed; read is bounded to 64 KiB and aborted when exceeded) or from `XO_API_OIDC_JWKS_URI`. Both must be https (loopback http for a local issuer). Keys are cached (10 min), refetched on an unknown `kid` at most once per 30 s (so random `kid`s cannot amplify into JWKS traffic), with a 5 s timeout per request. The JWKS response itself has no size cap (the `jose` fetch reads it whole); the issuer is a trusted party, so this is documented rather than defended.

**Binding.** The verified `(iss, sub)` is looked up in the server-side binding store (`FsIdentityBindingStore`, `XO_API_OIDC_BINDINGS_DIR`). The principal (`kind`, stable `identityId`, optional `orgId` label) is minted by `establishAuthenticatedPrincipal` **from the binding record only**. No claim, header, query or body field is consulted. No binding, a revoked binding and a corrupt record all answer the same `XO_AUTH_IDENTITY_UNBOUND`. Records are written atomically (private temp file, fsync, rename, then fsync of the directory so an acknowledged revocation survives a crash where the filesystem supports it; mode 0600 in a 0700 directory), so a request never reads a half-written record. Reads refuse symlinks and non-regular files, bound the size, and require the record's stored pair and id to match its file name; anything else counts as no binding. The directory is operator-owned: whoever can write it can bind any identity. Nothing is auto-provisioned. `orgId` is a label the operator writes; it is not tenant membership, and no membership policy was invented.

Provisioning is an operator command, deliberately not an HTTP route (an endpoint that creates bindings would need its own authentication; an open one would let any provider user grant themselves access):

```
node --import tsx apps/api/scripts/manage-oidc-bindings.ts bind   --issuer <iss> --subject <sub> --identity <principalId> --kind <human|service> [--org <orgId>] [--dir <dir>]
node --import tsx apps/api/scripts/manage-oidc-bindings.ts revoke --issuer <iss> --subject <sub> [--dir <dir>]
node --import tsx apps/api/scripts/manage-oidc-bindings.ts list   [--dir <dir>]
```

Revocation marks the record and takes effect on the next request (existing access tokens stop working immediately, regardless of their remaining lifetime). A revoked pair can be bound again by a new explicit `bind`. `--issuer` must equal `XO_API_OIDC_ISSUER` exactly. Binding records hold the provider's subject identifier in plain text; treat the directory as access-controlled.

### Errors

All are 401 with the standard error envelope unless noted. Messages are fixed strings: they never echo the token, claims, issuer, or which check failed.

| Code                           | Status | Meaning                                                                                                                                                   |
| ------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `XO_AUTH_KEY_MISSING`          | 401    | No bearer credential (unchanged).                                                                                                                         |
| `XO_AUTH_KEY_INVALID`          | 401    | Not a recognised API key (unchanged). Also what a JWT gets when OIDC is off, and what a non-JWT-shaped bearer gets.                                       |
| `XO_AUTH_TOKEN_INVALID`        | 401    | Malformed, oversized, bad signature, disallowed algorithm, wrong issuer/audience, not yet valid, unknown `kid`, not an access token. One code on purpose. |
| `XO_AUTH_TOKEN_EXPIRED`        | 401    | Signature valid, `exp` passed. Studio should refresh and retry once.                                                                                      |
| `XO_AUTH_IDENTITY_UNBOUND`     | 401    | Token valid, but `(iss, sub)` has no active binding. Refreshing will not help; an operator must bind it.                                                  |
| `XO_AUTH_PROVIDER_UNAVAILABLE` | 503    | Signing keys could not be obtained (provider down, bad discovery, timeout), or the binding store failed. Fail closed; retry later.                        |

`XO_AUTH_KEY_MISSING` and `XO_AUTH_KEY_INVALID` already existed and are reused; the other four codes were added additively to `@xo/errors`.

### Key rotation and provider outage

Rotation: the provider publishes the new key and signs with it; the first token with the new `kid` triggers a refetch (subject to the 30 s cooldown) and is accepted if the key is present. Keys the provider stops publishing stop verifying once the cache (10 min) expires. Outage: a cached key set keeps verifying tokens signed by cached keys until it expires; a fetch failure for an unknown key or an expired cache answers 503 and **never** falls back to unverified acceptance. A malformed or structurally invalid JWKS, a non-200, a redirect and a timeout are all provider faults (503); a well-formed key set that simply lacks the token's `kid` is `XO_AUTH_TOKEN_INVALID`. Discovery (which only locates the key set) is repeated hourly and retried at most every 5 s after a failure; if re-discovery fails the previously validated key-set location keeps being used, and the key set itself still refetches on its own 10-minute policy and fails closed. With no previous location, discovery failure is a 503. Discovery and JWKS redirects are never followed.

### Configuration

| Variable                         | Required      | Meaning                                                                              |
| -------------------------------- | ------------- | ------------------------------------------------------------------------------------ |
| `XO_API_OIDC_ISSUER`             | with audience | Exact `iss` to trust. https (loopback http allowed); no credentials/query/fragment.  |
| `XO_API_OIDC_AUDIENCE`           | with issuer   | Value that must appear in `aud`. The API's own audience, **not** Studio's client id. |
| `XO_API_OIDC_JWKS_URI`           | no            | Explicit JWKS URL; skips discovery.                                                  |
| `XO_API_OIDC_CLOCK_SKEW_SECONDS` | no (30)       | 0–120.                                                                               |
| `XO_API_OIDC_BINDINGS_DIR`       | no            | Default `.xo-data/oidc-bindings`. Use a persistent volume.                           |

Neither variable has a default. Both unset: OIDC is off and the API is API-key-only. Exactly one set, or any invalid value: **the process refuses to start** with a message naming the variable (never its value). There is no client secret anywhere: Studio is a public client.

Studio's `XO_OIDC_AUDIENCE` (what it asks the provider for) must name the same audience the API is configured with in `XO_API_OIDC_AUDIENCE`. Configure them together.

### API-key sign-in vs OIDC

The development sign-in pastes an `xoak_` key; it is a development and machine-to-machine mechanism and is unchanged. OIDC is the human sign-in. They share only the resulting canonical principal shape. A person can have both only if an operator binds both to the same `identityId`.

## What Studio does (implemented, tested against a fake provider)

- Config: `{ issuer, clientId, scopes?, audience? }`; issuer must be https (loopback http for local IdPs), no credentials/query/fragment; any `*secret*` key is refused; unknown keys refused.
- Discovery: `{issuer}/.well-known/openid-configuration`; the document's `issuer` must equal the configured issuer **exactly**; authorization/token endpoints must be https; `S256` must be supported when advertised; redirects are not followed.
- Authorization request: `response_type=code`, PKCE `S256` (64 random bytes verifier), random `state` (no `nonce`: Studio never reads the ID token), loopback redirect `http://127.0.0.1:<random port>/callback` (RFC 8252), opened in the **system browser**.
- Callback: accepted only from the one-shot loopback listener, only for `GET /callback` with a matching `Host`; its `state` must match the attempt; any `access_token`/`id_token`/`token` in it is refused; provider free text is never echoed.
- Token exchange: no secret; the access token is held in memory; the **refresh token** alone is persisted, in the OS keychain, bound to `(issuer, clientId)` (a mismatch discards it unused).
- Refresh: ahead of expiry (60 s skew), single-flight, rotation persisted. Only `invalid_grant`/401 from the token endpoint ends the session and deletes the credential. Network errors, 5xx, 429 and malformed replies keep it.
- Expiry: Studio refreshes ahead of expiry. The refresh token is only ever sent to the provider's token endpoint, never to the XO API (the API accepts only the access token). Verified in code: during the **sign-in probe** a 401 aborts the sign-in ("XO did not accept this sign-in") and the freshly issued refresh token is revoked at the provider; any other failure there also aborts that sign-in attempt. In an **established session** Studio does not end the session on an API 401: it surfaces the per-action message, and only a permanent refresh rejection (`invalid_grant`) from the provider ends the session. A 503 (`XO_AUTH_PROVIDER_UNAVAILABLE`) is classified as a server problem and never signs an established session out. (An earlier version of this document said a 401 ends the session view; that was not accurate.)
- Logout: best-effort revocation at the provider, local credential cleared regardless.
- **Known limit:** the ID token is not validated by Studio (and no `nonce` is sent). This is safe only because Studio uses no identity claims. Do not add features that read ID-token claims in the client; if one is ever added it must send and verify a nonce, and the API's nonce rule must then be revisited for that provider.
- **Web shell:** a browser redirect flow is not implemented (needs a decision between in-memory tokens with a silent-refresh strategy and a same-origin backend-for-frontend session). The web app shows the labelled development sign-in only; if OIDC is configured and dev sign-in disabled it says OIDC is not yet available in the browser.

## Deployment configuration (no values invented)

| Setting              | Web (`window.__XO_CONFIG__`)   | Desktop (environment at launch)             |
| -------------------- | ------------------------------ | ------------------------------------------- |
| API address          | `apiBaseUrl`                   | `XO_API_URL` (https; loopback http for dev) |
| OIDC issuer / client | `oidc.issuer`, `oidc.clientId` | `XO_OIDC_ISSUER`, `XO_OIDC_CLIENT_ID`       |
| Audience (optional)  | `oidc.audience`                | `XO_OIDC_AUDIENCE`                          |
| Dev sign-in          | `devSignIn: false`             | `XO_DEV_SIGN_IN=0`                          |

The identity provider must register a **public** client with Authorization Code + PKCE, allow loopback redirect URIs `http://127.0.0.1:*/callback`, issue refresh tokens (`offline_access`), and expose a revocation endpoint (recommended).

## Google sign-in → XO sessions

Why a separate path: Google OAuth access tokens are opaque (`ya29.…`), not JWTs, so the access-token verifier above cannot and must not be pointed at them. Instead: **Google authenticates the user → the XO API verifies Google's ID token and establishes its own session → the XO API authorizes every request.** Source: `apps/api/src/auth/session/`, `apps/api/src/routes/auth-session-routes.ts`, `apps/studio/src/auth/xoSession.ts`.

### Flow

1. Studio `POST /auth/login-challenge` (unauthenticated) → `{ challengeId, nonce, expiresAt }`. The nonce is server-generated (256-bit CSPRNG), valid 5 minutes, single use.
2. Studio opens the **system browser** at Google's authorization endpoint: code flow, PKCE S256, random `state`, `nonce` = the challenge nonce, scope `openid` only, **no client secret, no `offline_access`, no audience**. The loopback listener receives the code (state checked, constant-time).
3. Studio does **not** contact Google's token endpoint. Google requires the OAuth client secret there (observed: a request without it is refused with `invalid_request: client_secret is missing.`), and a distributed app must not hold one. Studio therefore sends the **code and its PKCE verifier** to the API.
4. Studio `POST /auth/session` with `{ challengeId, code, codeVerifier, redirectUri }`. The API checks the shapes (`redirectUri` must be exactly `http://127.0.0.1:<port>/callback`, port 1024-65535; `codeVerifier` per RFC 7636) before consuming anything, consumes the challenge atomically, redeems the code at Google with `client_id` + `client_secret` + the verifier, takes **only the `id_token`** (Google's access token is discarded unread; a refresh token, if Google issues one, is revoked best-effort and never stored), then verifies the ID token independently against THIS attempt's nonce and resolves the verified `(issuer, sub)` through the operator-written binding (unbound → 401; nothing is provisioned from Google claims; email is never an identity key). The older body `{ challengeId, idToken }` is still accepted (exactly one of `idToken` or `code` per request); a `code` request on a server without the client secret is `501`.
5. The API returns `{ accessCredential (xoas_…, 15 min), refreshCredential (xoar_…), accessExpiresAt, refreshExpiresAt }`. Studio keeps the access credential in memory and the refresh credential in the OS keychain.
6. Every API call sends `Authorization: Bearer xoas_…`. The API re-derives the principal from the binding on every request and applies the existing ownership, permission, approval and idempotency rules.

### Endpoints (additive; present only when configured; no `/v1` prefix because no route in this API has one)

| Route                        | Auth                             | Purpose                                                        |
| ---------------------------- | -------------------------------- | -------------------------------------------------------------- |
| `POST /auth/login-challenge` | none, rate limited               | Issue a single-use challenge.                                  |
| `POST /auth/session`         | none, rate limited               | Verify the ID token for that challenge, mint a session.        |
| `POST /auth/refresh`         | none, rate limited               | Rotate the refresh credential.                                 |
| `POST /auth/logout`          | the session's `xoas_` credential | Revoke exactly that session. 400 for a non-session credential. |

Bodies are small JSON objects (each string field 1 to 8192 chars). Responses carry `Cache-Control: no-store`. No route lists, creates or edits bindings, and none exposes the unbound-login list.

### ID-token verification (`createIdTokenVerifier`: separate from the access-token verifier)

Header `alg` must be `RS256` and `typ` absent or `JWT`; the signature must verify against the configured issuer's keys (same discovery/JWKS machinery as above: issuer-exact discovery, no redirects, bounded reads, rate-limited refresh, fail closed with 503). `iss` must be in the accepted set; `aud` must contain the configured client id, and `azp` must equal it when present (and be present when there are several audiences); `exp`, `iat`, `sub` and `nonce` are required (30 s skew); `nonce` must equal the one issued for **this** challenge. Only `(canonical issuer, sub)` leaves the verifier. An ID token is used once and discarded, and is never accepted as an API credential (it fails at the dispatcher like any unrecognised bearer).

**Issuer canonicalization.** Google documents `iss` as `https://accounts.google.com` or `accounts.google.com`. When the configured issuer is exactly `https://accounts.google.com`, both spellings are accepted in a token and **both are bound and recorded as `https://accounts.google.com`**. Every other spelling (trailing slash, `http`, case change, look-alike hosts) is refused. With any other configured issuer only that exact string is accepted. Bind Google identities with `--issuer https://accounts.google.com`.

### Sessions (`FsSessionStore`)

- Opaque and server-side. Access and refresh credentials are `xoas_`/`xoar_` + 256 random bits (43 base64url characters). Only SHA-256 digests are stored, as file names; files are 0600 in 0700 directories; no credential, ID token or challenge id is stored in plaintext.
- Access: 15 minutes. Refresh: 30 days, single use, rotated on every refresh; the session family has an absolute 90-day cap.
- **Reuse detection:** presenting an already-used refresh credential revokes the whole family (every credential in it, at once). A client racing itself (two simultaneous refreshes with one credential) is indistinguishable from a replay and loses its session.
- **Logout:** `POST /auth/logout` revokes the calling session family only; other sessions of the same user are untouched. Studio clears its local credential regardless of whether the call reached XO.
- **Binding revocation:** every request re-reads the binding. A revoked or missing binding answers `XO_AUTH_IDENTITY_UNBOUND` immediately, permanently revokes that session family (re-binding later does not revive old sessions), and fails the next refresh the same way.
- After a rotation the previous access credential stays valid until its own expiry (at most 15 minutes) unless the family is revoked.
- A refresh credential is never accepted as an API bearer credential.

### Storage guarantees and the supported deployment boundary

Atomicity comes from write-to-temp + fsync + rename (atomic replacement) and from `rename` as the single-use primitive (of any number of concurrent callers, exactly one wins; used for challenges and refresh credentials). The directory entry is fsynced after writes where the filesystem supports it. A crash cannot leave a torn record or an accepted-but-unauthorised credential; a crash during a rotation can leave a session with no usable refresh credential (the client signs in again). Corrupt, truncated, oversize, symlinked or path-shaped records are refused as invalid sessions.

**Supported:** one host, a **local POSIX filesystem** (not NFS or another network filesystem), any number of API processes on that host sharing the directory. **Not supported and not protected against:** multiple hosts sharing or replicating the sessions directory. Rate limits are **per process**: N processes allow about N times the configured rate; behind a reverse proxy every client appears as the proxy's address (forwarding headers are not trusted), so the limits act as a shared cap there. This is not a distributed rate limit and must not be described as one.

### Abuse controls

Per client address and process, per minute: 20 challenge requests, 10 exchanges, 30 refreshes (then 429 `XO_AUTH_RATE_LIMITED`). At most 500 outstanding challenges (then 429). An exchange consumes its challenge whether or not it succeeds (a malformed request, rejected before an exchange is attempted, does not).

### Operator-only provisioning discovery

After an ID token has fully verified (signature, issuer, audience, expiry, nonce) but the identity has no active binding, `(canonical issuer, sub, time)` is recorded in `<sessions dir>/unbound-logins/`. Nothing else is stored: no email, token, code or client text. At most 100 entries (oldest evicted), 7-day retention, 0600 files. There is no API route for it. The operator reads it and binds explicitly:

```
node --import tsx apps/api/scripts/manage-oidc-bindings.ts unbound [--sessions-dir <dir>]
node --import tsx apps/api/scripts/manage-oidc-bindings.ts bind --issuer https://accounts.google.com --subject <sub> --identity <principalId> --kind human
```

Values are JSON-quoted when displayed. A successful `bind` removes that pair from the list. Because only verified identities are recorded, an unauthenticated caller cannot fill it with chosen values or use it to probe whether someone is bound (the response to an unbound sign-in reveals only the caller's own status).

### Configuration

| Variable                      | Meaning                                                                                                                                                                                                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `XO_API_GOOGLE_CLIENT_ID`     | Enables Google sign-in. The Google **Desktop app** OAuth client id (public, not a secret).                                                                                                                                                                                                      |
| `XO_API_GOOGLE_CLIENT_SECRET` | Optional; **enables the server-side code exchange the desktop flow needs.** The OAuth client's secret. Read from the process environment only (a secret manager in production); never logged, returned, written to disk, or sent to Studio. A single printable token of at most 256 characters. |
| `XO_API_GOOGLE_TOKEN_URI`     | Optional; default `https://oauth2.googleapis.com/token`. https (loopback http allowed). For tests and proxies.                                                                                                                                                                                  |
| `XO_API_GOOGLE_ISSUER`        | Optional; default `https://accounts.google.com`. Exists for tests and proxies; https (loopback http allowed), no credentials/query/fragment. Never taken from a token.                                                                                                                          |
| `XO_API_GOOGLE_JWKS_URI`      | Optional explicit key-set URL (skips discovery).                                                                                                                                                                                                                                                |
| `XO_API_SESSIONS_DIR`         | Session, challenge and unbound-login storage; default `.xo-data/sessions`. Local filesystem, one host.                                                                                                                                                                                          |
| `XO_API_OIDC_BINDINGS_DIR`    | The shared binding directory (same variable as the generic path).                                                                                                                                                                                                                               |

Any of the optional variables set without `XO_API_GOOGLE_CLIENT_ID`, or an invalid value, stops startup with a message naming the variable (never its value). The client secret, when set, is read only into the API's own config object and used only for the token request to `XO_API_GOOGLE_TOKEN_URI`.

Studio (desktop): `XO_OIDC_ISSUER=https://accounts.google.com`, `XO_OIDC_CLIENT_ID=<the Desktop client id>`, `XO_API_URL=<the API>`; no audience. Google's issuer selects the Google path by itself. The XO API's `XO_API_GOOGLE_CLIENT_ID` must be that same client id. The release capability file must list the XO API origin and Google's discovery origin (`https://accounts.google.com`); **not** `oauth2.googleapis.com`, which only the API calls. Real values only, set by the deployer. Studio never receives `XO_API_GOOGLE_CLIENT_SECRET`.

### Errors added

| Code                                              | Status | Meaning                                                                                                  |
| ------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| `XO_AUTH_CHALLENGE_INVALID`                       | 401    | The challenge is unknown, expired, malformed or already used. Start sign-in again.                       |
| `XO_AUTH_RATE_LIMITED`                            | 429    | Over a rate limit or the outstanding-challenge cap.                                                      |
| `XO_AUTH_TOKEN_INVALID` / `XO_AUTH_TOKEN_EXPIRED` | 401    | Also used for bad ID tokens and for invalid / expired session credentials (expired access: refresh it).  |
| `XO_AUTH_IDENTITY_UNBOUND`                        | 401    | Verified, but no active binding (sign-in, refresh, or an established session whose binding was revoked). |
| `XO_AUTH_PROVIDER_UNAVAILABLE`                    | 503    | Google's signing keys cannot be obtained, or a store failed. Fail closed.                                |

### Credential type and issuer on records

Execution and workflow-execution records now carry `authentication: { credential: 'api-key' | 'oidc' | 'session', issuer? }` next to `initiator`, derived only from what the server established while authenticating (validated again at write time; no token, subject, email or claim; absent on older records, never back-filled). This is Studio's own record metadata. It is a flat object so it can move verbatim into a future additive actor field in `@xo/audit`; nothing here imports or modifies the P1.0 audit implementation (a different branch base), and the authoritative `@xo/audit` actor model does not yet have such a field. That cross-branch step is deferred to the owner.

### What is NOT verified for Google

- ~~Whether Google's token endpoint accepts a Desktop-app client without a `client_secret`.~~ **Resolved by observation:** it does not (`400 invalid_request: client_secret is missing.`). The owner chose a server-side code exchange (option b): the API holds the secret, Studio holds none. This keeps the existing **Desktop** client (loopback redirect on any port) and uses its secret only on the server; a Web-type client would need a fixed registered redirect URI and is not required. The server-side exchange is tested against a fake Google that enforces the secret; **it has not yet been run against the real Google service end to end.**
- Whether Google accepts the server's token request exactly as built (`grant_type`, `code`, `redirect_uri`, `client_id`, `client_secret`, `code_verifier`) with the loopback redirect Studio used. Tested only against a fake.
- Whether Google accepts the revocation request for a returned refresh token. It is best effort and tested only against a fake.
- Whether the authorization request is accepted exactly as built (scope `openid`, a `nonce`, PKCE S256, loopback redirect). Tested only against a fake.
- Real signing-key rotation, real ID-token contents, real outage behaviour, and the real Tauri desktop flow.

See `GOOGLE_SIGNIN_RUNBOOK.md` for the manual validation steps.

## Remaining before this is production authentication

- Not run against a real identity provider; no live login has been verified. Provider-specific points to confirm: access tokens are JWTs signed with RS256/PS256/ES256, carry the API audience, have no `nonce`, and a `typ` of absent/`JWT`/`at+jwt` (see the token profile above).
- Web (browser) OIDC flow is still not implemented (see above).
- Studio does not retry once on `XO_AUTH_TOKEN_EXPIRED`, and an API 401 in an established session does not end it or trigger a refresh; it relies on proactive refresh (60 s ahead of expiry). A revoked binding therefore shows per-action errors until the user signs out. Deliberately not changed in this hardening pass (no defect in an enabled security path); a product decision.
- Lowercase `bearer` is refused (the scheme word is matched exactly, as for API keys always).
- Credential type/issuer are not persisted in audit records (no durable audit package on this branch).
- Binding administration (who may bind whom, tenant membership) is an operator CLI only.
- Native Tauri: `cargo check`/`cargo test`/`tauri dev`/`tauri build` have not been run in this work.

## How this is tested

- `apps/api/test/oidc-auth.test.ts`, `oidc-bindings.test.ts`, `oidc-idempotency.test.ts`, `session-auth.test.ts`, `session-records.test.ts`: in-process, with a local test issuer (`oidc-test-idp.ts`) and generated keys.
- `apps/api/test/oidc-integration.test.ts`, `session-integration.test.ts`: the **built** API (`dist/index.js`) as a child process behind the same local issuer, provisioned with the real CLIs, over real HTTP. It rebuilds the API first (`tsc -b`, a no-op when current) and needs no network or credentials. It runs as part of `npm test` in `apps/api`.
- Studio: `apps/studio/test/auth/googleSession.test.tsx` (with `test/fakeGoogle.ts`). None of this is a real identity provider. Native Tauri checks need a current Rust toolchain, which could not be installed in the build sandbox (see the runbook).
