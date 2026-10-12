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

## Not implemented or not verified

- Everything under `src-tauri/` and `desktop/`: **uncompiled, unrun.**
- Keychain behaviour per OS (Windows Credential Manager, macOS Keychain, Linux Secret Service availability).
- Real sign-in: pending the owner's decision in `AUTH_DECISION.md`.
- A browser-driven run of the built web bundle (the live smoke exercises Studio's client and parsers from Node, not the bundle in a browser).
