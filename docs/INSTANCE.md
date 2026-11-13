# Running an XO instance (UW-17)

One XO instance is one process: the API, the schedule triggers and Studio, on one port, with all of its state in one data directory.
The same image and the same settings run on a laptop and in the cloud; only the values differ ([ADR 0023](adr/0023-local-first-cloud-ready.md)).

## Start one on this machine

```bash
npm ci && npm run build      # once (builds Studio too)
xo up                        # or: node apps/cli/bin/xo.js up
```

`xo up` creates the instance on first run and prints where to open it and the access key to sign in with:

```
  XO is running (new instance): xoi_…
  Open    http://127.0.0.1:4000
  Sign in with the access key (Development sign-in):
         xoak_…
  Data    ~/.xo/instances/default
```

| Flag                                  | Default                                       | Meaning                        |
| ------------------------------------- | --------------------------------------------- | ------------------------------ |
| `--data <dir>`                        | `XO_DATA_DIR`, else `~/.xo/instances/default` | The instance data directory.   |
| `--port`, `--host`                    | `4000`, `127.0.0.1`                           | Where to listen.               |
| `--studio-dir <dir>` \| `--no-studio` | the repository's `apps/studio/dist`           | Serve Studio, or only the API. |

On this machine, and only when nothing says otherwise, `xo up` adds these local defaults:

- **Package trust in development mode.** Unsigned packages compiled here can run. This never applies in production, and never when
  `XO_PACKAGE_TRUST_POLICY` is set.
- **Secrets key and audit anchors under `~/.xo`, filed by instance id.** They are kept out of the data directory on purpose (see the
  layout below).
- **An owner access key**, valid for 90 days. It is shown once and saved owner-only at `~/.xo/keys/<id>.owner-key`.

`npm run dev` is still the way to work on Studio itself (hot reload); it now starts the API through the same start-up as `xo up`.

## Settings

Every setting is listed in [CONFIGURATION.md](CONFIGURATION.md), which is generated from the registry the instance validates against,
so the two cannot drift apart.

**Where settings come from.** Each value is taken from the first of these that sets it:

1. environment variables;
2. the config file: `XO_CONFIG_FILE`, or else `xo.env` in the data directory, in `KEY=VALUE` lines;
3. the encrypted secrets file, for secret settings only.

An empty value means unset.

**Problems stop start-up.** The instance stops with every problem listed at once, before it writes anything. Problems include:

- a value of the wrong shape;
- a value a feature would quietly read as "off" (`XO_API_SELF_SIGNUP=yes`);
- a half-configured feature;
- production without durable audit or a package-trust decision;
- an anchor or key folder inside the data directory.

A name that looks like an XO setting but is not one (`XO_OCR_WORKER`) is reported with the closest real one.

**Check without starting.**

```bash
xo config check [--data <dir>] [--json]
```

This runs the same check and prints every resolved setting with where it came from. Secrets are shown as `(set, hidden)`.

### Secrets

```bash
xo secrets set ANTHROPIC_API_KEY < key.txt   # read from standard input, never from the command line
xo secrets list                              # names only
xo secrets remove ANTHROPIC_API_KEY
```

**How they are stored.** Secrets go into `secrets.enc` in the data directory, encrypted with AES-256-GCM. Only settings the registry
marks as secret can be stored, and a value with a stray newline is refused.

**The key is kept elsewhere.** The key lives outside the data directory, at `XO_SECRETS_KEY_FILE` (owner-only, `0600`; anything
group- or world-readable is refused). Alternatively, it can be given as `XO_SECRETS_KEY` (base64) where the host injects secrets as
environment variables. This means a copy of the data, such as a backup or a volume snapshot, is not a copy of the secrets.

**Changes apply on restart.** A secret takes effect the next time the instance starts.

**Precedence.** Environment variables still win over secrets. A secret left in plain text in the config file is flagged.

A cloud secret manager can replace the file without touching callers: it implements the same `SecretProvider` interface
(`packages/instance/src/secrets.ts`).

### Public address and sign-in

`XO_PUBLIC_BASE_URL` is the address people use. It must be https, except on loopback. `xo up` prints it, and
`<XO_PUBLIC_BASE_URL>/auth/callback` becomes the one extra sign-in return address the API accepts, alongside the desktop app's
loopback one. The match is exact, never a prefix.

## The data directory

```
<data>/
  instance.json      instance id, schema version, migration history
  instance.lock      held while the instance (or a backup, restore, erasure) uses it
  xo.env             optional settings file
  secrets.enc        encrypted secrets (key kept elsewhere)
  api-keys/  workspaces/  workspace-data/  oidc-bindings/  external-effects/  inference-cache/
  sessions/  accounts/  audit/    (only when Google sign-in, password sign-in or durable platform audit is on)
```

**One instance per data directory.** The lock is held by the running process. A second `xo up`, a backup, a restore or a delete
against a running instance is refused, and the message says who holds the lock. A lock left behind by a process that is no longer
running on the same host is taken over. On another host it is never taken over: remove it by hand once you are sure.

**Kept outside on purpose.**

- The secrets key.
- The audit anchors (`XO_AUDIT_ANCHOR_DIR`). An anchor next to the log it attests proves nothing.
- Backups.

**Pointing it at the wrong folder.** XO only adopts a folder that is empty or holds what XO itself puts there. A folder with anything
else in it is refused.

Without `XO_DATA_DIR`, the older layout of separate folders still works. It has no lock, metadata, migrations or backups, and start-up
warns about it.

## Health, readiness, metrics, logs

| Endpoint       | Credential                  | Answers                                                                                                                 |
| -------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /health`  | none                        | The process is up.                                                                                                      |
| `GET /readyz`  | none                        | 200 or 503 with check names only: `storage`, `schema`, `instance-lock`, `scheduler`.                                    |
| `GET /ready`   | an access key               | The same checks with their reasons, plus inference configuration.                                                       |
| `GET /metrics` | `Bearer <XO_METRICS_TOKEN>` | Prometheus text: requests by method, route template and status class; durations; build and memory. Off without a token. |

**Metric labels never carry data.** A label is never an id, a path or user content: routes appear as templates
(`/workspaces/:workspaceId/sources`).

**Logs.** Each log line is one JSON object on standard output. `XO_LOG_LEVEL` sets the level. Each request is logged with its method,
route template, status and duration; probes are counted in metrics but not logged.

## Back up, restore, upgrade, delete

```bash
xo instance backup  [--data <dir>] [--out file.tar.gz] [--live]
xo instance verify-backup file.tar.gz
xo instance restore file.tar.gz [--data <dir>] [--force]
xo instance upgrade [--data <dir>] [--backup-dir <dir>]
xo instance delete  --data <dir> --confirm <instance-id> [--receipt receipt.json]
xo instance status  [--data <dir>] [--json]
xo instance access-key [--data <dir>] [--identity owner] [--days 90]
```

### Backup

**What it contains.** A backup is a standard `.tar.gz`, which `tar -tzf` can list. The whole data directory is under `data/`, a
header comes first and a manifest last. The manifest gives every file with its size and SHA-256. Neither the lock nor the secrets key
is included.

**Consistency.** By default a backup needs the instance stopped, so the copy is consistent. `--live` takes one while the instance runs
and records that it did. A file whose size changes during the copy fails the backup instead of being silently cut off.

### Restore

**Verified before anything is written.** The whole archive is checked against its manifest first. An archive is refused, and nothing
is written, if it has:

- a path that could escape the target folder;
- a link;
- a file that does not match its recorded hash;
- a truncated end;
- a schema newer than this XO understands.

**Where it writes.** Files are written to a staging folder, checked again, then moved into place. A non-empty target is refused
unless `--force` is given, which moves the old folder aside rather than deleting it.

**After restoring.** Pending migrations run. To read the secrets file, put its key back at `XO_SECRETS_KEY_FILE`.

### Upgrade

**Migrations.** On start-up, the instance brings its data up to the newest schema it knows, one recorded step at a time.

**Upgrade with a backup first.** `xo instance upgrade` takes a backup, then migrates, and prints how to undo it.

**Downgrades are refused.** Data written by a newer XO is refused rather than read by code that does not understand it.

### Delete

**What it removes.**

- The data directory: workspaces, sources, runs, audit, access keys, sessions, connector tokens and encrypted secrets.
- The secrets key.
- The owner access key.
- The audit anchors.

**Safeguards.** It needs the instance id as confirmation, and it refuses while the instance runs.

**Proof.** It checks that every path is gone and writes a receipt saying what was there and that it no longer is.

**Limits.** Removing files does not erase bytes the storage medium may keep, nor copies in backups and snapshots. Where that matters,
keep the data on an encrypted volume and destroy the volume or its key too.

## The container

[`Dockerfile`](../Dockerfile) builds the one production image. It contains the API, the CLI and the built Studio, runs as a non-root
user, keeps data in `/data`, and is health-checked on `/readyz`. [`compose.yaml`](../compose.yaml) runs one instance on
`127.0.0.1:4000`, with its data, anchors and keys on three separate volumes:

```bash
docker compose up -d
docker compose exec xo xo instance access-key --data /data           # sign-in key, shown once
docker compose exec -T xo xo secrets set ANTHROPIC_API_KEY < key.txt  # then: docker compose restart xo
docker compose exec xo xo instance backup --data /data --live --out /tmp/xo.tar.gz && docker compose cp xo:/tmp/xo.tar.gz ./
```

**Production settings.** The image sets `NODE_ENV=production`. With it, start-up refuses to run without:

- durable audit retention (`XO_AUDIT_RETENTION_DAYS`, `XO_AUDIT_MIN_RETENTION_DAYS`);
- a package trust policy (`XO_PACKAGE_TRUST_POLICY`).

**Local defaults.** `compose.yaml` supplies development defaults for running on your own machine.

**Moving to production.** Copy [`deploy/instance.env.example`](../deploy/instance.env.example) to `.env` beside `compose.yaml`. Set
your domain, the trust policy, sign-in and secrets.

**Tested in CI.** The `image` CI job:

1. builds the image;
2. checks that production defaults refuse to start;
3. starts it with compose;
4. runs the smoke test against it;
5. takes and verifies a live backup.

## Smoke test

```bash
node scripts/smoke-instance.mjs --url http://127.0.0.1:4000 --key xoak_… [--metrics-token …]
```

**What it runs.** It works against any instance (local, container or cloud) and walks the certificate path as far as XO goes today:

1. the instance is alive and ready;
2. an email with a certificate attached is uploaded;
3. the attachment is opened as its own source;
4. compiling it proposes "certificate";
5. the audit trail shows the attachment was opened.

Matching the certificate to a customer and sending it are added as UW-5 and UW-8 land.

**What it leaves behind.** It leaves one `smoke-<time>` workspace, because workspaces cannot be deleted through the API yet.

## Not yet

These are recorded in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

- **The provider-neutral deployment template is scheduled for W5.** This is the infrastructure as code that brings up a customer
  instance from a small config file with one command.
- **Storage is local only.** Postgres and object-storage adapters can be added behind the storage interfaces when a deployment needs
  them.
- **Leases are single-host.** The lock is a file on one host; a distributed lease sits behind the same `InstanceLock` interface.
