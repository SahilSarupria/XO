# Putting Studio and the API on a free hosting tier

Notes, not a tested recipe. Nothing here has been deployed from this repository to a free tier. The hosting choice is an owner item.

## What has to be true wherever it runs

1. **Studio is a static build** (`npm run build` in `apps/studio`, then serve `dist/`). Its addresses are paths (`/w/<workspace>/…`, `/join`), so the host must answer every unknown path with `index.html`. `deploy/serve.mjs` does this (checked: `/w/…/work/…`, `/w/…/activity/runs/…` and `/join` all return the page); `deploy/nginx.conf.example` does it with `try_files`. A static host needs the same "single-page app" rewrite.
2. **Studio and the API on one address.** The build calls `/api` on its own origin; the host forwards `/api/*` to the API with the `/api` prefix removed (see `deploy/nginx.conf.example`). Otherwise the API must allow the Studio's origin and the build must be told the API address (`window.__XO_CONFIG__.apiBaseUrl`).
3. **The API needs a disk that survives restarts.** Workspaces, audit logs, invitations, sessions and accounts are files under the data directory (`docs/CONFIGURATION.md`, Storage). A free tier whose disk is wiped on restart or sleep loses all of it. If the tier sleeps when idle, expect the first request after a pause to be slow; Studio shows its normal "could not reach XO" message until the API answers.
4. **TLS in front.** Terminate TLS at the host; set `XO_API_TRUSTED_PROXY_HOPS` to the number of proxies so rate limits see the real client.
5. **Upload size.** Match the proxy's body limit (50 MB in the example) to the API's.

## Sign-in on a hosted copy

- Access keys work anywhere and are meant for development and first trials.
- Google sign-in in the **browser** is not offered yet; it works in the desktop app. A hosted browser copy for real people therefore has only access keys handed out by an administrator until the owner decides on a browser sign-in. (The API has an optional password sign-in, `XO_API_PASSWORD_AUTH`, but Studio has no screen for it.)
- Invitations are links the inviter hands over; no email is sent (there is no sender yet).

## Before sharing the address with anyone

- Set a real access key policy (`XO_API_KEY_MAX_AGE_DAYS`) and keep the data directory backed up.
- Read `docs/SERVER_HARDENING.md`: it states what is not claimed about exposing the server to the public internet.
