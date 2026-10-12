# XO Studio — web and desktop shells

One React frontend (`apps/studio/src`), two shells. Business state is on the server; shells hold none.

## Layout

- `src/` shared UI. Talks to native features only through `ShellServices` (`src/shell/services.tsx`). No Tauri imports.
- `desktop/`, `vite.desktop.config.ts`: desktop entry and build. **Unverified.**
- `src-tauri/`: Tauri v2 shell. **Unverified, never compiled.**
- `deploy/`: same-origin hosting for the web build (`serve.mjs` exercised; `nginx.conf.example` not).

## API address

Order: `window.__XO_CONFIG__.apiBaseUrl` > `VITE_XO_API_URL` > `/api`. Relative path or http(s) only; an invalid value stops startup with a message (it never falls through to another address).

## Web hosting

`npm run build`, then serve `dist/` and route `/api/*` to the API with the prefix stripped (same origin, no CORS): `XO_API_URL=http://127.0.0.1:4000 npm run serve:prod`, or adapt `deploy/nginx.conf.example`.

## Desktop network path (decision)

The API sends no CORS headers, and the webview CSP stays strict. Desktop API calls therefore go through `tauri-plugin-http` (native side), restricted by the `http:default` allow-list in `src-tauri/capabilities/default.json`. **Edit that list to your real API origin before packaging.** The API address is supplied at launch via `XO_API_URL` (validated natively and in the UI) and must be absolute.

## Owner: verify locally (none of this was run)

Prerequisites: Rust toolchain and platform webview libraries (Linux: webkit2gtk-4.1 etc.; Windows: WebView2; macOS: Xcode CLT).

```
cd apps/studio
npm i -D @tauri-apps/cli@^2
npm i @tauri-apps/api@^2 @tauri-apps/plugin-http@^2
cd src-tauri && cargo check && cargo test
cd .. && XO_API_URL=http://127.0.0.1:4000 npx tauri dev
npx tauri build            # installer for the host OS; add icons first (bundle.icon is empty)
```

Check: window opens; sign-in works; credential survives restart and is gone after Sign out; a revoked key is rejected with the sign-in form; stopping the API shows "cannot reach XO" without discarding the credential; keyboard focus order and visible focus; a decision made here shows in the web app.

## Known gaps

No icons; no code signing/notarization; no auto-update; keychain behaviour per OS untested; if Linux lacks a Secret Service, credential calls fail and the user falls back to manual sign-in each launch. Real sign-in awaits `AUTH_DECISION.md`.
