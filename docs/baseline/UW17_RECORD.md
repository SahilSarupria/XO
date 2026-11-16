# UW-17 test record (local-first, cloud-ready packaging, wave W1)

Branch `uw-17/local-first-packaging`, stacked on `uw-3/generic-ingestion`. Compared by name against `docs/baseline/tests-26f0052.tsv`.

## Behaviour changes callers can see

- **The API entrypoint now goes through `startInstance`.** This covers `node apps/api/dist/index.js`, `npm start` and
  `run-api.mjs`, which is what `npm run dev` runs. Start-up now does three things it did not:
  - it validates every setting first and lists all problems at once;
  - it locks, creates and migrates the instance when `XO_DATA_DIR` is set;
  - it logs `listening on <url>` as before, with the public URL and the Studio and scheduler state as fields.
- **`npm run dev` now starts the scheduler and resolves audit and trust like production.** `run-api.mjs` used to skip these. The dev
  launcher passes `XO_TRUST_MODE=development` explicitly, unless `.env` sets a trust mode.
- **Unknown or ill-formed settings stop start-up.** This covers ill-formed values, such as `XO_API_SELF_SIGNUP=yes`, which used to be
  read silently as off. An empty value is still "unset".
- **`XO_API_OLLAMA_ENABLED` is now a flag.** `1` or `true` means on; `0` used to turn Ollama on, like any non-empty value.
- **`/ready` reports instance checks.** It answers 503 when one fails. Two new routes:
  - `/readyz` (no credential, check names only);
  - `/metrics` (scrape token; absent without one).
- **`docker-compose.yml` is now `compose.yaml`.** It runs the instance. Postgres and Redis start only with `--profile backing`.
- **The root `Dockerfile` is now the production instance image.** It was a build/test image; nothing in CI or the docs used its
  `test` stage.

## Same name, body changed

- `AutomationEngine > retries transient failures with backoff, then dead-letters; permanent errors skip retries`
  (`packages/automation/test/engine.test.ts`). This fixes a flake that predates UW-17. The test took the first two recorded delays as
  one item's, but two items retry concurrently. It now checks all four delays in any order.

The start-up tests from the baseline (`audit-startup`, `oidc-integration`) pass unchanged against the new start-up path.

No baseline test was renamed or removed.

## Added

- `packages/instance/test/settings.test.ts` covers:
  - every problem at once;
  - unknown names with the closest real one;
  - the data-directory layout and the features that stay off;
  - cross-setting rules, including production audit and trust;
  - precedence of environment, config file and secrets;
  - no echo of URL, string or secret values;
  - empty values meaning unset;
  - the registry covering every variable the code reads;
  - the generated configuration reference.
- `packages/instance/test/lifecycle.test.ts` covers:
  - creation, refusal of foreign folders, migrations, and refusal of downgrades;
  - the one-runner lock and stale-lock takeover;
  - encrypted secrets, including wrong keys, tampering and permissions;
  - the start-up sequence;
  - a backup/verify/restore round trip with long paths, readable by GNU tar;
  - live backups and refused backups;
  - crafted archives: escaping paths, links, altered files, truncation;
  - verified erasure.
- `apps/api/test/instance.test.ts` covers:
  - one port for Studio and the API, the content-security policy, caching, path traversal and writes refused;
  - `/readyz`, `/ready` and `/metrics`;
  - the lock and reopening;
  - invalid settings writing nothing;
  - a missing Studio build;
  - the public callback matching exactly;
  - the metrics format and token.
- `apps/cli/test/instance.test.ts` runs the built CLI as a child process: `xo instance` create, status, secrets, config check,
  backup, verify, restore, access-key and delete (with its receipt); `xo up` end to end (locked while running, live backup, Ctrl+C);
  and the instance smoke test against a running `xo up`.
- The CI `image` job: builds the image; checks that production defaults refuse to start; runs compose; runs the smoke test; takes and
  verifies a live backup.

## Result

7,455 pass, 4 skip, 0 fail across all workspaces, after the two fixes above were re-run in full (`@xo/automation` 31/31, `@xo/cli`
367/367). By name against the UW-0 baseline, nothing regresses beyond UW-1's documented benchmark rename.
