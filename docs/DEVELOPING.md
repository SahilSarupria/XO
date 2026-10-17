# Developing XO locally

Requires Node 22.15+ (check with `node -v`). Everything below works on macOS, Linux and Windows.

## First time

```sh
npm run setup
```

It checks your tools, installs packages if needed, creates `.env` from `.env.example`, builds the API, and creates a
development access key saved in `.xo-dev/dev-key.txt`. It is safe to run again.

## Every day

```sh
npm run dev       # API + Studio together. Prints the URL and your access key.
```

Open the printed address, choose **Development sign-in**, and paste the access key. `Ctrl+C` stops both.
If one of the two stops, the launcher stops the other and says why.

| Command                     | What it does                                                              |
| --------------------------- | ------------------------------------------------------------------------- |
| `npm run doctor`            | Checks Node, packages, `.env`, build, key and ports, and says what to fix |
| `npm run test:studio`       | Studio tests once (fake API, no server needed)                            |
| `npm run test:studio:watch` | Studio tests re-run as you edit                                           |
| `npm run check:studio`      | Studio typecheck + tests (the quick pre-commit check)                     |
| `npm run smoke`             | Studio's live contract check against the **running** dev API (24 checks)  |
| `npm run test:api`          | API tests                                                                 |
| `npm run build` / `lint`    | Whole-repo build / lint (the full release checks still apply)             |

## Settings (`.env`)

All optional. See `.env.example` for the list. The ones you are most likely to change:

- `PORT` (API, default 4000) and `STUDIO_PORT` (Studio, default 5173) if a port is taken.
- `API_KEYS_DIR`, `WORKSPACES_DIR`, `WORKSPACE_DATA_DIR` to move data off `./.xo-dev`.
- Variables already set in your shell win over `.env`.

## Starting over

Delete the `.xo-dev` folder and run `npm run setup` again. This removes all local workspaces and the dev key.

## Common problems

- **"Port 4000 is in use"** — another API is running, or set `PORT` in `.env`.
- **Studio says "Cannot reach XO"** — the API is not running; use `npm run dev` (not `vite` alone).
- **"access key was not accepted"** — the key came from a different `API_KEYS_DIR`. Copy it from `.xo-dev/dev-key.txt`.
- **Anything else** — run `npm run doctor`.

The dev access key is for local use only. Never reuse it, and never commit `.env` or `.xo-dev`.
