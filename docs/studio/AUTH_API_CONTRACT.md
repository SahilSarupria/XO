# Studio ⇄ XO API authentication contract

Status: **Studio side implemented and tested against a fake provider. API side implemented and tested against a local test issuer (`apps/api/test/oidc-auth.test.ts`, plus a run against the built API process).** It has **not** been run against a real identity provider, and no production OIDC login has been verified end to end. Until a deployment configures the API (below), the API stays API-key-only and answers 401 to a JWT exactly as before; Studio then reports "XO did not accept this sign-in".

## Trust boundary

1. The XO API verifies the credential and **derives the principal itself**, from verified `(iss, sub)` mapped through a server-side binding record, exactly as it derives it from the key record today (`establishAuthenticatedPrincipal`). Headers, query, body, or token claims such as `email`, `org`, or `groups` never establish a principal or organization by themselves.
2. Authorization stays in `@xo/permissions`. A valid identity grants nothing by itself. The request carries `authentication: { credential: 'api-key' | 'oidc', issuer? }` as attribution context. **Gap:** this branch has no durable audit package (`@xo/audit` is on the integration line, not in this branch's ancestry), so credential type and issuer are not persisted in any audit record yet; only the principal snapshot on execution/workflow records is.
3. Studio is a public client. It holds no client secret, makes no identity decision, never uses the ID token (it is discarded), and never persists access tokens.

## What the API does (implemented)

Source: `apps/api/src/auth/oidc/`, `apps/api/src/http/auth.ts`. Library: [`jose`](https://github.com/panva/jose) (MIT, zero runtime dependencies, maintained; the only new dependency).

**Credential dispatch.** Two separate mechanisms, chosen by the credential's shape, never by anything the caller claims. A token starting `xoak_` is always an API key and is never given to the JWT verifier. A compact JWS (three base64url segments) goes to OIDC **only when OIDC is configured**. Anything else, including a JWT when OIDC is not configured, takes the unchanged API-key path and gets the unchanged `XO_AUTH_KEY_INVALID`.

**Verification** (`createOidcVerifier`):

- Algorithm allow-list `RS256`, `PS256`, `ES256`. `none`, every `HS*`, and anything else are refused before any network call.
- `iss` must equal the configured issuer exactly (string comparison, no normalisation). `aud` must contain the configured audience. `exp` and `sub` are required. `nbf` is enforced when present; `iat` more than the skew in the future is refused. Skew defaults to 30 s (`XO_API_OIDC_CLOCK_SKEW_SECONDS`, 0–120).
- Access tokens only. Refused: a `nonce` claim, `token_use` other than `access`, and a header `typ` other than absent, `JWT` or `at+jwt` (RFC 9068). The audience check is the primary defence; these catch an ID token minted for the same audience. If your provider's access tokens legitimately carry a `nonce`, this will refuse them: report it rather than loosening the check.
- Tokens over 8 KiB are refused. Only `(iss, sub)` leaves the verifier; no other claim is read anywhere in XO.
- Keys: the JWKS URL comes from `{issuer}/.well-known/openid-configuration` (the document's `issuer` must equal the configured issuer exactly; redirects are not followed; 64 KiB cap) or from `XO_API_OIDC_JWKS_URI`. Both must be https (loopback http for a local issuer). Keys are cached (10 min), refetched on an unknown `kid` at most once per 30 s (so random `kid`s cannot amplify into JWKS traffic), with a 5 s timeout per request.

**Binding.** The verified `(iss, sub)` is looked up in the server-side binding store (`FsIdentityBindingStore`, `XO_API_OIDC_BINDINGS_DIR`). The principal (`kind`, stable `identityId`, optional `orgId` label) is minted by `establishAuthenticatedPrincipal` **from the binding record only**. No claim, header, query or body field is consulted. No binding, a revoked binding and a corrupt record all answer the same `XO_AUTH_IDENTITY_UNBOUND`. Nothing is auto-provisioned. `orgId` is a label the operator writes; it is not tenant membership, and no membership policy was invented.

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

Rotation: the provider publishes the new key and signs with it; the first token with the new `kid` triggers a refetch (subject to the 30 s cooldown) and is accepted if the key is present. Keys the provider stops publishing stop verifying once the cache (10 min) expires. Outage: a cached key set keeps verifying tokens signed by cached keys until it expires; a fetch failure for an unknown key or an expired cache answers 503 and **never** falls back to unverified acceptance. Discovery failure is retried at most every 5 s.

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
- Authorization request: `response_type=code`, PKCE `S256` (64 random bytes verifier), random `state` and `nonce`, loopback redirect `http://127.0.0.1:<random port>/callback` (RFC 8252), opened in the **system browser**.
- Callback: accepted only from the one-shot loopback listener, only for `GET /callback` with a matching `Host`; its `state` must match the attempt; any `access_token`/`id_token`/`token` in it is refused; provider free text is never echoed.
- Token exchange: no secret; the access token is held in memory; the **refresh token** alone is persisted, in the OS keychain, bound to `(issuer, clientId)` (a mismatch discards it unused).
- Refresh: ahead of expiry (60 s skew), single-flight, rotation persisted. Only `invalid_grant`/401 from the token endpoint ends the session and deletes the credential. Network errors, 5xx, 429 and malformed replies keep it.
- Expiry: Studio refreshes ahead of expiry. The refresh token is only ever sent to the provider's token endpoint, never to the XO API (the API accepts only the access token). A 401 ends the session view; a 503 (`XO_AUTH_PROVIDER_UNAVAILABLE`) is classified as a server problem and does not sign the user out.
- Logout: best-effort revocation at the provider, local credential cleared regardless.
- **Known limit:** the ID token is not validated by Studio, so `nonce` is sent but not checked. This is safe only because Studio uses no identity claims. Do not add features that read ID-token claims in the client.
- **Web shell:** a browser redirect flow is not implemented (needs a decision between in-memory tokens with a silent-refresh strategy and a same-origin backend-for-frontend session). The web app shows the labelled development sign-in only; if OIDC is configured and dev sign-in disabled it says OIDC is not yet available in the browser.

## Deployment configuration (no values invented)

| Setting              | Web (`window.__XO_CONFIG__`)   | Desktop (environment at launch)             |
| -------------------- | ------------------------------ | ------------------------------------------- |
| API address          | `apiBaseUrl`                   | `XO_API_URL` (https; loopback http for dev) |
| OIDC issuer / client | `oidc.issuer`, `oidc.clientId` | `XO_OIDC_ISSUER`, `XO_OIDC_CLIENT_ID`       |
| Audience (optional)  | `oidc.audience`                | `XO_OIDC_AUDIENCE`                          |
| Dev sign-in          | `devSignIn: false`             | `XO_DEV_SIGN_IN=0`                          |

The identity provider must register a **public** client with Authorization Code + PKCE, allow loopback redirect URIs `http://127.0.0.1:*/callback`, issue refresh tokens (`offline_access`), and expose a revocation endpoint (recommended).

## Remaining before this is production authentication

- Not run against a real identity provider; no live login has been verified. Provider-specific points to confirm: access tokens are JWTs signed with RS256/PS256/ES256, carry the API audience, and have no `nonce`.
- Web (browser) OIDC flow is still not implemented (see above).
- Studio does not yet retry once on `XO_AUTH_TOKEN_EXPIRED`; it relies on proactive refresh.
- Credential type/issuer are not persisted in audit records (no durable audit package on this branch).
- Binding administration (who may bind whom, tenant membership) is an operator CLI only.
- Native Tauri: `cargo check`/`cargo test`/`tauri dev`/`tauri build` have not been run in this work.
