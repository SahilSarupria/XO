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

## Reopen if

A cloud-only dependency is introduced.
