# Studio shells — security boundary

- **The desktop shell is untrusted by the server.** It is a client like the browser: it authenticates with a credential and the API authorizes every request.
- **Approvals and authorization are enforced server-side.** Studio never decides that something is allowed; it shows what the API recorded or refused.
- **Nothing in a shell is a secret.** The bundle, the injected `window.__XO_CONFIG__`, and the installer contain no keys. Only the _user's_ credential is secret, held in memory (web) or the OS keychain (desktop).
- **Local operations are separate from server-authorized XO operations.** The only native commands are credential load/save/clear and reading shell config. Local files are not an XO workspace. XO workspaces stay server-side. The future durable-workspace work (P1.1-D) has no code here, only this boundary.
- **The webview policy is not loosened.** CSP is `default-src 'self'`; API traffic goes through the Tauri HTTP plugin restricted to an allow-listed origin rather than widening `connect-src` or adding CORS.

## Boundaries implemented and verified

- API base-URL validation and precedence (unit tested).
- No Tauri import in shared UI (`src/`); desktop code lives in `desktop/` and `src-tauri/`.
- Web credential store is memory-only (tested: nothing in localStorage, sessionStorage or cookies).
- Production build reached the real API through a same-origin `/api` proxy (24/24 live contract checks).

- API-side OIDC: algorithm allow-list, issuer/audience/time checks, bounded JWKS handling, server-side `(iss, sub)` binding, fail-closed configuration, no token or claim in responses or logs (`apps/api/test/oidc-auth.test.ts`, 18 tests; plus a run against the built API process).

## Not implemented or not verified

- Everything under `src-tauri/` and `desktop/`: **uncompiled, unrun.**
- Keychain behaviour per OS (Windows Credential Manager, macOS Keychain, Linux Secret Service availability).
- Real sign-in against a real provider: the API verifies OIDC access tokens (`AUTH_API_CONTRACT.md`) and is tested against a local test issuer only. No production login has been run.
- A browser-driven run of the built web bundle (the live smoke exercises Studio's client and parsers from Node, not the bundle in a browser).

## Hardening added with the auth foundation

- **Native surface** (all unverified Rust, validated by a static checker): credential load/save/clear, `shell_config`, `login_begin`/`login_await` (one-shot loopback listener, strict method/path/Host match, 5 min bound), `open_system_browser` (https or loopback http only). No fs/shell/process/opener/dialog permissions. `node scripts/check-tauri-config.mjs` enforces this and is covered by tests that try to add each forbidden grant.
- **Network egress**: the webview CSP has no remote `connect-src`. API and identity-provider calls go through the native HTTP plugin and its capability allow-list. The committed default grants none; `http-dev` (loopback only) is enabled only by `tauri.dev.conf.json`; a release must enable `http-deploy`, which the owner creates with real origins, so a release cannot be built without an explicit allow-list (`npm run check:tauri:release` fails until then).
- **No loosened CSP for dev**: `tauri dev` serves the built bundle under the release CSP (no HMR) rather than adding `unsafe-inline`.
- **Credential lifecycle**: a stored credential is deleted only on permanent rejection (server 401 for a dev key, `invalid_grant` for a refresh token), never on network failure, and a credential for a different issuer/client is discarded unused. If the keychain is unavailable the user is told and signs in each launch.
- **Principal**: never taken from the client. See `AUTH_API_CONTRACT.md`.
