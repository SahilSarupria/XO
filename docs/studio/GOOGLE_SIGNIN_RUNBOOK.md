# Google sign-in: manual validation runbook

Everything automated so far ran against **local fakes** (a fake Google and a fake issuer). Nothing in this runbook has been executed. It is the smallest set of steps that turns "tested against fakes" into "validated against Google on a real desktop". Record the result of every step; at the first unexpected result, stop and keep the exact message.

Requires: a Google account that can create an OAuth client in a Google Cloud project, a **second Google account to use as the test user**, a machine with a display, a current Rust toolchain and the Tauri v2 platform prerequisites (<https://v2.tauri.app/start/prerequisites/>), and Node 22. The build sandbox this work was done in could not reach `accounts.google.com`, could not install Rust (`static.rust-lang.org` unreachable; the distribution's `rustc` 1.75 is older than Tauri 2 requires), and has no display.

## 1. Create the Google OAuth client

1. Google Cloud Console → pick or create a project → **APIs & Services → OAuth consent screen**. Configure it; while testing, leave publishing status as **Testing** and add the second account under **Test users**. Scopes: only the defaults for sign-in (`openid`); XO asks for nothing else.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
3. Application type: **Desktop app**. Name it (for example `XO Studio (test)`). Create.
4. Copy the **Client ID** (`<digits>-<random>.apps.googleusercontent.com`). It is public. Google also shows a **client secret** for this type. Studio never holds it; you will put it **only** in the API's configuration in step 2 (`XO_API_GOOGLE_CLIENT_SECRET`, or `.env` for local development). Never paste it into chat, a ticket, Studio's settings or git.
5. There is no redirect-URI list to fill in for a Desktop client: Google accepts the loopback address (`http://127.0.0.1:<random port>`) that Studio opens. If Google later rejects the redirect, record the exact `redirect_uri_mismatch` text.

## 2. Configure the XO API

On the host that runs the API (one host, a local filesystem):

```
XO_API_GOOGLE_CLIENT_ID=<the Client ID from step 1>
XO_API_GOOGLE_CLIENT_SECRET=<that client's secret; API process only>
XO_API_SESSIONS_DIR=/var/lib/xo/sessions        # local disk, 0700, owned by the API user
XO_API_OIDC_BINDINGS_DIR=/var/lib/xo/bindings   # the operator-managed binding list
```

Leave `XO_API_GOOGLE_ISSUER` and `XO_API_GOOGLE_JWKS_URI` **unset** (the defaults are Google's). Start the API. It must start without an error; `XO_API_GOOGLE_CLIENT_ID` must be exactly the client id Studio is configured with. Check: `POST /auth/login-challenge` returns 201 with a `challengeId` and `nonce`. Without `XO_API_GOOGLE_CLIENT_SECRET` the desktop sign-in is refused with "not set up for desktop Google sign-in" (501).

## 3. Build and start Studio

1. `cd apps/studio`. Run the native checks: `cargo check` and `cargo test` in `src-tauri`, then `npm run check:tauri`. Record the real output.
2. Release configuration: copy `src-tauri/deploy/http-deploy.capability.example.json` to `src-tauri/capabilities/http-deploy.json` and set your **real** origins: the XO API and Google's discovery origin (`https://accounts.google.com`; the token endpoint is called by the API, not Studio). No wildcards. Then `npm run check:tauri:release` must pass. Do not weaken the check to make it pass.
3. Launch with:
   ```
   XO_API_URL=<your API origin>
   XO_OIDC_ISSUER=https://accounts.google.com
   XO_OIDC_CLIENT_ID=<the Client ID>
   XO_DEV_SIGN_IN=0
   ```
   (`tauri dev` for a first look; `tauri build` and the packaged app for the real check.)

## 4. First sign-in: the unbound path

1. Click the sign-in button. The system browser opens Google. Sign in as the **test user**. Check the address bar URL while it is open: it contains `scope=openid`, `code_challenge_method=S256`, `state`, `nonce`; it contains **no** `client_secret`, no `offline_access`.
2. Studio returns to a message that XO did not accept the sign-in / the account is not enabled. That is correct: nothing is bound yet.
3. **If instead Studio reports `XO could not complete the Google sign-in: … refused the sign-in (invalid_client)`:** the API's client id or secret does not match the Google client Studio signed in with. Re-copy both from the same Desktop client. `redirect_uri_mismatch` or any other code: record the exact text and stop.
4. On the API host: `node --import tsx apps/api/scripts/manage-oidc-bindings.ts unbound --sessions-dir /var/lib/xo/sessions`. You should see exactly one line: `issuer="https://accounts.google.com"` and the test user's `subject` (a long number), with a time. Nothing else (no email).

## 5. Bind and sign in

1. Bind exactly what step 4 showed:
   ```
   node --import tsx apps/api/scripts/manage-oidc-bindings.ts bind \
     --issuer https://accounts.google.com --subject <subject from step 4> \
     --identity <an XO principal id> --kind human
   ```
   `unbound` now lists nothing.
2. Sign in again in Studio. It should complete and show the workspace list for that principal.
3. Create a workspace in Studio. Confirm in the API data that it is owned by the bound principal id, not by anything Google supplied.
4. Check the execution records after running anything: `authentication` is `{ "credential": "session", "issuer": "https://accounts.google.com" }`.

## 6. Session lifecycle

1. **Persistence:** quit Studio and start it again. It should return to signed-in without opening the browser (the keychain holds one entry, `dev.xo.studio`; it contains an `xoar_…` credential, never a Google token and never an `xoas_…` access credential).
2. **Refresh:** keep Studio open for more than 15 minutes (or move the API host clock forward) and use the app. It should keep working; the keychain entry's credential changes after the refresh (rotation).
3. **Reuse detection:** copy the keychain credential, let Studio refresh once, then `curl -X POST <api>/auth/refresh -H 'content-type: application/json' -d '{"refreshCredential":"<the OLD credential>"}'`: expect 401, and then Studio's own next request must fail and Studio must return to sign-in (the whole session was revoked).
4. **Binding revocation:** sign in again, then `manage-oidc-bindings.ts revoke --issuer https://accounts.google.com --subject <subject>`. The very next action in Studio must be refused (`XO_AUTH_IDENTITY_UNBOUND`). Re-bind and confirm that the **old** session does not come back and a fresh sign-in works.
5. **Sign-out:** click Sign out. The keychain entry is removed and the API refuses the old access credential. Repeat with the API stopped: Studio must still clear its local credential.
6. **Provider outage:** block `accounts.google.com` and `www.googleapis.com` from the API host (firewall). New sign-ins fail with a 503-style "temporarily unavailable" message; existing sessions keep working (they do not depend on Google); nothing authenticates that should not.
7. **Cancel and failure:** start a sign-in and close the browser tab: Studio shows "not completed" after the 5-minute bound and stays signed out. Try the callback URL by hand with a wrong `state`: Studio refuses it.

## 7. Clean up and leak check

1. Revoke the test binding, delete the test user's sessions (`rm -r <sessions dir>/sessions`), remove the keychain entry, and delete (or restrict to test users) the OAuth client in Google Cloud.
2. Check the API log, Studio's log and the browser history for the strings `xoas_`, `xoar_`, the `id_token` value, `ya29.`, `1//` (Google refresh tokens) and the nonce: none should appear. Only the authorization-code redirect (`code=…&state=…`) may appear in browser history (it is single-use and already spent).
3. List the sessions directory: all files `0600`, directories `0700`, and `grep -r xoas_ <dir>` finds nothing.

## What a pass means

All of section 4 to 7 behaving as written means: real Google sign-in works end to end with the server-side code exchange (or you have the exact failure), the desktop flow works on the platform you tested, and the XO session lifecycle behaves as documented. It does **not** cover other operating systems, a multi-host deployment (unsupported), or production hardening beyond this document.
