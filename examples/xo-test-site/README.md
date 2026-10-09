# XO Platform — Test Website

A temporary, standalone test harness that lets someone exercise the real
`apps/api` (workspaces → sources → compile → capabilities → approve →
execute, human-in-the-loop, workflows, the runtime, and the registry) from
a browser, without writing a single line of code.

**Nothing here touches the XO Platform repo.** This is three small files
(`server.mjs`, `public/index.html`, `public/app.js`, `public/styles.css`)
that live completely outside it and only talk to it over plain HTTP.

```
xo-test-site/
├── server.mjs        # tiny static file + reverse-proxy server (no deps)
├── public/
│   ├── index.html    # the console UI (tabs)
│   ├── app.js         # all the fetch() calls into apps/api
│   └── styles.css
└── README.md          # this file
```

## Why a proxy server at all?

`apps/api` is deliberately built on plain `node:http` with no CORS
headers (see its own README). Rather than add CORS handling to the real
service, `server.mjs` serves this UI and forwards `/api/*` to the real API
on the same origin — the browser never makes a cross-origin request, and
`apps/api`'s source is untouched.

## 1. Start the real `apps/api`

From your existing checkout of the XO Platform (this is exactly your
normal dev workflow — nothing new):

```bash
cd apps/api
pnpm install        # if you haven't already
pnpm build           # or: tsc -b tsconfig.json — only if dist/ isn't already built
node dist/index.js
```

By default it listens on `http://127.0.0.1:4000`. Override with `PORT`,
`HOST`, `API_KEYS_DIR`, `WORKSPACES_DIR`, `WORKSPACE_DATA_DIR` env vars if
you want (see `apps/api/src/config.ts`).

### Issue yourself an API key

Every route except `/health` and `/openapi.json` requires
`Authorization: Bearer <key>`. Keys are minted with the API's own script
(never over HTTP — see the script's own comment for why):

```bash
cd apps/api
node --import tsx scripts/manage-keys.ts issue my-demo-user
```

This prints a key exactly once, like:

```
xoak_B4_8P3wp4MgPYjGZnoILK9UQoqpoHlrRa2w72ZnI_ww
```

Copy it — you'll paste it into the test website's **Connect** tab.

If your sandbox has no `node_modules` wired up for the workspace packages
(the same offline-symlink situation your own notes describe), the same
fix applies here as everywhere else in the monorepo: symlink each built
`packages/*` into the consuming package's `node_modules/@xo/*`, and once
into `packages/node_modules/@xo/*` so cross-package `import`s inside
`packages/*/dist` resolve too. This test site doesn't change any of that.

## 2. Start the test website

In a second terminal, from this folder:

```bash
node server.mjs
```

```
XO Platform test website:  http://localhost:5173
Proxying /api/*  ->  http://127.0.0.1:4000
```

Open **http://localhost:5173** in a browser.

If your API isn't on `127.0.0.1:4000`, point the proxy at it instead:

```bash
XO_API_URL=http://127.0.0.1:4000 SITE_PORT=5173 node server.mjs
```

## 3. Use it

The tabs mirror the API's own route groups, in the order you'd naturally
walk through them:

1. **Connect** — paste your API key, run a health check.
2. **Workspaces** — create one, or select an existing one. Every other
   tab is scoped to whichever workspace is selected (shown top-right).
3. **Sources & Compile** — upload a document (pdf/html/json/csv/txt/md/
   image), compile it, then pull up the capabilities the compiler found.
4. **Capabilities & Executions** — a capability must be **approved**
   before it can run (the button's right there in the capabilities list
   on the previous tab); then execute it and watch the result, including
   an honest `waiting_for_human` outcome if the capability escalates.
5. **Human Tasks** — every execution that ever became
   `waiting_for_human`, with an approve/reject resolve action.
6. **Workflows** — discovers multi-step workflows composed automatically
   from a succeeded compilation, starts one, and can resume a workflow
   sitting at a human-in-the-loop step.
7. **Runtime Console** — raw `runtime/context` and ad-hoc
   `runtime/execute`, including the `x-xo-provider` / `x-xo-api-key`
   headers if you want to point it at a real model provider.
8. **Registry & Packages** — publish/search/inspect `.xo` packages,
   record and read benchmarks, licenses, ledger verification, dependency
   resolve/lock, and standalone archive validation.
9. **Compiler Playground** — raw `POST /compiler/compile` against a
   hand-written XOIR graph (only `kind: "xoir"` is supported over HTTP
   today, per the API itself).

Every action shows the raw JSON response in the panel underneath it, so
nothing is hidden — if you want to see exactly what the API returned,
it's right there.

## Notes

- API key and selected workspace are kept in the browser's
  `localStorage`, scoped to this page only.
- This was built and smoke-tested end-to-end against a locally running
  `apps/api` (workspace → upload → compile → capabilities → approve →
  execute → workflow start), so the request/response shapes match the
  API as it actually behaves, not just its OpenAPI doc.
- This is a throwaway test harness, not a product surface — there's no
  build step, no framework, and it's meant to be deleted once you're done
  poking at the API.
