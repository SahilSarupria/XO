# Studio ⇄ XO API authentication contract

Status: **Studio side implemented and tested; API side NOT implemented.** At commit time `apps/api` accepts only `Authorization: Bearer xoak_…` keys (`apps/api/src/http/auth.ts`). It has no JWT/JWKS verification, no OIDC library, and no token endpoints. Until the API work below exists, an OIDC sign-in completes at the identity provider but the API answers 401, and Studio reports that honestly ("XO did not accept this sign-in") instead of showing a signed-in state.

## Trust boundary

1. The XO API verifies the credential and **derives the principal itself**, from verified `(iss, sub)` mapped through a server-side binding record, exactly as it derives it from the key record today (`establishAuthenticatedPrincipal`). Headers, query, body, or token claims such as `email`, `org`, or `groups` never establish a principal or organization by themselves.
2. Authorization stays in `@xo/permissions`. Audit semantics are unchanged; records additionally carry credential type and issuer.
3. Studio is a public client. It holds no client secret, makes no identity decision, never uses the ID token (it is discarded), and never persists access tokens.

## What the API must do (not implemented)

1. Accept `Authorization: Bearer <access token>`. If the token is a JWT, verify: signature against the issuer's JWKS (cached, refetch on unknown `kid`, bounded), algorithm allow-list (no `none`, no HS* with a public key), `iss` equals configured issuer exactly, `aud` contains the configured API audience, `exp`/`nbf` with small bounded skew. `xoak_` keys continue to work unchanged.
2. Map `(iss, sub)` to an existing principal via a server-side binding (identity id, principal kind, org). **Unbound subjects are rejected (401), never auto-provisioned.**
3. Fail closed when issuer/audience/JWKS configuration is absent: OIDC acceptance is off.
4. Revocation: short access-token lifetime (recommended ≤ 15 min); revoking the refresh token at the provider ends access within that window; optional introspection for high-risk routes.
5. Public, unauthenticated discovery (proposed) `GET /auth/config` →
   ```json
   { "issuer": "https://…", "clientId": "…", "audience": "…", "scopes": ["openid", "offline_access"] }
   ```
   containing only public values. Studio currently takes the same values from deployment configuration (`window.__XO_CONFIG__.oidc` on web; `XO_OIDC_*` on desktop), so this endpoint is optional convenience.
6. Error contract: 401 `XO_AUTH_*` for missing/invalid/expired/unbound credentials (existing error mapping), with no token material in messages.
7. Tests required: wrong issuer, wrong audience, expired, not-yet-valid, forged signature, `alg:none`, unknown `kid`, unbound subject, key callers unaffected, authz and audit identical across credential types, client-supplied principal ignored.

## What Studio does (implemented, tested against a fake provider)

- Config: `{ issuer, clientId, scopes?, audience? }`; issuer must be https (loopback http for local IdPs), no credentials/query/fragment; any `*secret*` key is refused; unknown keys refused.
- Discovery: `{issuer}/.well-known/openid-configuration`; the document's `issuer` must equal the configured issuer **exactly**; authorization/token endpoints must be https; `S256` must be supported when advertised; redirects are not followed.
- Authorization request: `response_type=code`, PKCE `S256` (64 random bytes verifier), random `state` and `nonce`, loopback redirect `http://127.0.0.1:<random port>/callback` (RFC 8252), opened in the **system browser**.
- Callback: accepted only from the one-shot loopback listener, only for `GET /callback` with a matching `Host`; its `state` must match the attempt; any `access_token`/`id_token`/`token` in it is refused; provider free text is never echoed.
- Token exchange: no secret; the access token is held in memory; the **refresh token** alone is persisted, in the OS keychain, bound to `(issuer, clientId)` (a mismatch discards it unused).
- Refresh: ahead of expiry (60 s skew), single-flight, rotation persisted. Only `invalid_grant`/401 from the token endpoint ends the session and deletes the credential. Network errors, 5xx, 429 and malformed replies keep it.
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
