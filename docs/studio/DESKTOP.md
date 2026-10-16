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

## Desktop network path

The API sends no CORS headers and the CSP stays strict, so all API **and identity-provider** calls go through `tauri-plugin-http`, limited by a capability allow-list. The committed default grants no origins.

| Mode        | Command                                                  | Capabilities enabled                                    |
| ----------- | -------------------------------------------------------- | ------------------------------------------------------- |
| Development | `tauri dev --config src-tauri/tauri.dev.conf.json`       | `default` + `http-dev` (loopback `127.0.0.1:4000` only) |
| Release     | `tauri build --config src-tauri/tauri.release.conf.json` | `default` + `http-deploy` (**you create it**)           |

To build a release: copy `src-tauri/deploy/http-deploy.capability.example.json` to `src-tauri/capabilities/http-deploy.json` and replace both origins (your XO API and your OIDC provider; no wildcards). Check with `npm run check:tauri:release`.

Launch configuration (environment): `XO_API_URL`, `XO_OIDC_ISSUER`, `XO_OIDC_CLIENT_ID`, optional `XO_OIDC_AUDIENCE`, `XO_DEV_SIGN_IN=0` to hide the development sign-in. Invalid values stop startup with a message.

**Google:** set `XO_OIDC_ISSUER=https://accounts.google.com` and `XO_OIDC_CLIENT_ID` to your Google _Desktop app_ client id (no audience, no secret). That issuer selects the Google path automatically; Studio then signs in at Google, hands Google's ID token to the XO API once, and holds only XO session credentials (access in memory, rotating refresh credential in the keychain). See `AUTH_API_CONTRACT.md` and `GOOGLE_SIGNIN_RUNBOOK.md`. Your release capability file needs the Google origins as well as the XO API origin.

## Owner: verify locally (none of the native code was compiled or run)

Prerequisites: Rust stable, platform webview libraries (Linux: webkit2gtk-4.1, libsoup3, a Secret Service such as gnome-keyring; Windows: WebView2; macOS: Xcode CLT), Node 20+.

```
cd apps/studio
npm i -D @tauri-apps/cli@^2
npm i @tauri-apps/api@^2 @tauri-apps/plugin-http@^2
npm run check:tauri                       # static boundary check (also runs in this repo's tests)
cd src-tauri && cargo check && cargo test # includes URL/credential/callback validation tests
cd .. && XO_API_URL=http://127.0.0.1:4000 npx tauri dev --config src-tauri/tauri.dev.conf.json
# release:
cp src-tauri/deploy/http-deploy.capability.example.json src-tauri/capabilities/http-deploy.json   # edit origins
npm run check:tauri:release && npx tauri build --config src-tauri/tauri.release.conf.json
```

Manual checklist:

1. **System-browser login**: button opens the default browser (not a webview); consent completes; the loopback page says you can close it; Studio becomes signed in.
2. **Callback handling**: while waiting, `curl "http://127.0.0.1:<port>/callback?code=x&state=y"` is rejected and the wait continues; a request with a wrong `Host` is rejected; closing the browser tab leaves Studio on a clear "not completed" message after the 5-minute bound.
3. **Secure storage**: after login, the OS keychain holds one entry (`dev.xo.studio`); it contains a refresh token, never an access token; restart restores the session; Sign out removes the entry and revokes at the provider. With the keychain locked/unavailable the app says so and still allows sign-in.
4. **API-origin restriction**: with `http-deploy` listing only your API and IdP, a request to any other origin from the webview console fails; the CSP blocks direct `fetch` to the API.
5. **Revocation**: revoke the refresh token at the provider; within the access-token lifetime Studio returns to sign-in with a message. Block the network instead: Studio shows "cannot reach" and the keychain entry is kept.
6. **API unavailable**: stop the API; the app shows a connection message, not a blank or success screen.
7. **Packaged startup**: install the built package on a clean user account; it starts with only the launch environment above; invalid `XO_API_URL` shows the configuration error.
8. **Expected**: with the API configured for the generic provider or for Google sign-in, login completes; with the API unconfigured, it ends with "XO did not accept this sign-in" and the development sign-in still works.

## Known gaps

No icons, signing/notarization, or auto-update. Web OIDC redirect flow not implemented. The API-side verification and the Google session flow are implemented and tested only against local fakes. Native code uncompiled and the desktop Google flow never run. Keychain behaviour per OS untested.
