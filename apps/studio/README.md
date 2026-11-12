# @xo/studio

Customer-facing XO Studio. Business-first (Standard mode), with Builder mode as a deeper layer of the same product.
Talks to `@xo/api` over HTTP only. Architecture, capability map and platform gaps: [`docs/STUDIO_ARCHITECTURE.md`](docs/STUDIO_ARCHITECTURE.md).

## Run locally

From the repo root (full guide: [`docs/DEVELOPING.md`](../../docs/DEVELOPING.md)):

```sh
npm run setup   # once: installs, creates .env, builds the API, creates a dev access key
npm run dev     # API + Studio together; prints the URL and the key to paste
npm run doctor  # if anything is wrong
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
