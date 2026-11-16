# 0023: Local first, cloud-ready with one command (D-N)

## Status

Accepted under owner delegation, 2026-11-13 (UW-0). Signed off 2026-11-13 by Claude under the owner's explicit delegation of sign-off authority (owner instruction of 2026-11-13); this is a delegated sign-off, not an independent review. Applies to all new code from UW-1 on; packaging is UW-17.

## Context

The owner wants development on localhost now and cloud deployment later without a rewrite (Revision 4, §0 and §7). Dockerfiles and a
compose file exist; there is no deployment, upgrade or restore guide (`docs/baseline/UW0_BASELINE.md` §7 row 39).

## Decision

One codebase, one container image, one configuration surface. Local and cloud differ only in configuration. Rules for every new line
of code:

1. All settings come from environment variables or a config file validated at start-up; no absolute paths, hostnames or ports in code.
2. All state lives in one instance data directory (SQLite, blobs, journal, ledger, token store, keys) behind storage interfaces.
3. Secrets come from a secret-provider interface: a local encrypted file now, a cloud secret manager later.
4. The OAuth callback and the public base URL are configuration.
5. Health, readiness and metrics endpoints; schema migrations at start-up; backup and restore commands; structured logs on stdout.
6. One runner process per instance; leases and locks sit behind interfaces so a distributed lease can be added later.

Deliverables (UW-17): `xo up`, one production image, a single-instance compose file, a provider-neutral deployment template, instance
lifecycle commands (create, back up, restore, upgrade with migration, delete with verified erasure) and a smoke test.

## Implementation (UW-17, wave W1)

How each rule is met (operations: `docs/INSTANCE.md`):

1. **Settings.** `packages/instance/src/settings.ts` is a registry of every setting the instance reads. A test fails if code reads an
   environment variable the registry does not list. Settings come from the environment, then `XO_CONFIG_FILE` or the data
   directory's `xo.env`, then the secrets file. Start-up checks all of them and lists every problem at once, including names that are
   not settings, with the closest real one. `docs/CONFIGURATION.md` is generated from the registry, and a test fails if the two
   differ.
2. **One data directory.** `XO_DATA_DIR` fills every storage setting with a folder inside it; a feature that is off stays off. The
   secrets key and the audit anchors are deliberately kept outside it, and start-up refuses either one if it points inside. Backups
   are kept outside too.
3. **Secrets.** `SecretProvider` is the interface. It has two implementations: the environment, and an AES-256-GCM file whose key is
   held elsewhere (`XO_SECRETS_KEY_FILE` or `XO_SECRETS_KEY`). `xo secrets set|list|remove` manages the file.
4. **Public address.** `XO_PUBLIC_BASE_URL` (https unless loopback) is configuration. Its `/auth/callback` is accepted, exactly, as a
   sign-in return address beside the desktop loopback one.
5. **Operations.**
   - `/health`.
   - `/readyz` (no credential, check names only) and `/ready` (authenticated, with reasons).
   - `/metrics` (Prometheus, `XO_METRICS_TOKEN`).
   - Migrations at start-up (`instance.json`, ordered and recorded; newer data is refused).
   - `xo instance backup|verify-backup|restore|upgrade|delete`. Delete produces a verified erasure receipt.
   - JSON logs on stdout.
6. **One runner.** `InstanceLock` (a file lock today) is held by whatever writes to the instance. Every way of starting it goes
   through `startInstance`: `xo up`, the API entrypoint, the container, `npm run dev`.

Deliverables: `xo up`; one production image (`Dockerfile`); a single-instance `compose.yaml`; `scripts/smoke-instance.mjs`; and the
CI job that builds the image and smoke-tests it. **Deferred to W5:** the provider-neutral deployment template that brings up a new
customer instance from a small config file.

## Reopen if

A cloud-only dependency is introduced.
