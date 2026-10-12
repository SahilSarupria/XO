# Studio authentication — decision document

Status: **proposal, awaiting owner decision.** Nothing here is implemented in the API.

## Today

`apps/api` authenticates `Authorization: Bearer xoak_…` keys issued out-of-band by `apps/api/scripts/manage-keys.ts`. Studio asks the user to paste one. Studio keeps it in memory only (web) or, on a desktop shell that reports `persistentCredentials`, in the OS keychain. The API sends no CORS headers. This is a **development sign-in** and is labelled as such in the UI.

## Options

|                                 | A. Session cookie behind reverse proxy                                                | B. OIDC authorization-code + PKCE, both shells                                              | C. Per-user API tokens issued by the API                           |
| ------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Web token storage               | HttpOnly, Secure, SameSite=Lax cookie; JS never sees it                               | Access token in memory; refresh via HttpOnly cookie or rotating refresh token               | Token in memory (as today) or user re-pastes                       |
| Desktop storage                 | Poor fit: cookie jar in a webview is not the OS keychain and the proxy origin differs | Refresh token in OS keychain via native command; access token in memory                     | Token in OS keychain (works today's way)                           |
| Refresh                         | Server-side session sliding expiry                                                    | Standard refresh-token rotation                                                             | None unless added; long-lived by default                           |
| Revocation                      | Delete session server-side (immediate)                                                | IdP revokes refresh token; access token lives until expiry (keep short)                     | Delete token server-side (immediate)                               |
| CORS / CSRF                     | Same origin so no CORS; **needs CSRF defence** (SameSite + CSRF token on mutations)   | Bearer header, so no CSRF; desktop needs API CORS or the Tauri HTTP plugin                  | Same as today                                                      |
| Server-side authz/audit         | Session must resolve to the same principal the key resolves to today                  | Token `sub` mapped to the existing principal/identity; authz and audit unchanged downstream | Identical: token is just another credential for the same principal |
| New moving parts                | Session store, login UI, proxy coupling                                               | IdP (or embedded OIDC provider), callback handling, desktop loopback/deep-link redirect     | Token issuance/listing/revocation endpoints and UI                 |
| Fits "one frontend, two shells" | Web only                                                                              | **Yes, one flow for both**                                                                  | Yes, but it is still a pasted secret                               |

## Recommendation

**B. OIDC authorization-code with PKCE**, with the API accepting OIDC access tokens as a second credential type that resolves to the _same_ principal model the key resolves to today. Reasons: one flow serves both shells; the desktop can hold only a refresh token in the keychain; humans get real login (SSO, MFA, offboarding) without Studio inventing any auth; and server-side authorization and audit remain the single enforcement point because the API still resolves every request to a principal before the existing policy runs.

Keep option C's property for machine callers: service API keys remain valid and unchanged.

## API-side changes B would require (not implemented)

1. Verify bearer JWTs (issuer, audience, signature via JWKS with caching, `exp`/`nbf`, algorithm allow-list) alongside `xoak_` keys in the auth middleware.
2. A mapping from `(issuer, sub)` to an existing identity/principal, with an explicit provisioning path; unmapped subjects are rejected, never auto-created.
3. Audit records must carry the credential type and issuer in addition to the principal, without changing existing audit semantics for key callers.
4. Configuration for issuer, audience, JWKS URL and clock skew; fail closed when unset.
5. Revocation story: short access-token lifetime; optional introspection for high-risk routes.
6. Desktop only, if the Tauri HTTP plugin is not used: CORS for the desktop origin.
7. Tests: expired/forged/wrong-audience/wrong-issuer tokens, unmapped subject, key callers unaffected, authz and audit identical for both credential types.

## Owner decision needed

Choose A, B, C or another option; name the IdP (or whether the API should embed one). Until then, Studio keeps the labelled access-key sign-in and the storage rules above. No API change will be made without that approval.
