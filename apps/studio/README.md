# @xo/studio

Customer-facing XO Studio. Business-first (Standard mode), with Builder mode as a deeper layer of the same product.
Talks to `@xo/api` over HTTP only. Architecture, capability map and platform gaps: [`docs/STUDIO_ARCHITECTURE.md`](docs/STUDIO_ARCHITECTURE.md).

## Run locally

From the repo root:

```sh
npm ci
npm run typecheck                      # existing platform build (unchanged)

# 1. an API key for yourself (prints the key once)
cd apps/api
npm run keys -- issue me --kind human --dir /tmp/xo-dev/keys

# 2. start the API (needs a built apps/api/dist: `npm run build` at the root)
API_KEYS_DIR=/tmp/xo-dev/keys WORKSPACES_DIR=/tmp/xo-dev/ws WORKSPACE_DATA_DIR=/tmp/xo-dev/wsd PORT=4000 node run-api.mjs

# 3. start Studio (proxies /api -> http://127.0.0.1:4000; override with XO_API_URL)
cd ../studio
npm run dev                            # http://localhost:5173 — paste the key to connect
```

## Checks

```sh
cd apps/studio
npm run typecheck     # strict tsc
npm test              # vitest: client, domain, and journey tests (fake API, tests only)
npm run build         # tsc + vite build
npx eslint apps/studio --max-warnings=0   # from the repo root; covers .ts only

# Live contract check against a REAL running API (creates a throwaway workspace; dev API only)
XO_API_URL=http://127.0.0.1:4000 XO_API_KEY=xoak_... node --import tsx scripts/live-smoke.mjs
```
