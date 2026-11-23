# Review: UW-17 cloud deployment template (branch `uw-17/cloud-template`)

For the Opus review of ADR 0054: secrets handling and internet exposure. Code: `packages/instance/src/deploy/*`,
`apps/cli/src/commands/deploy/index.ts`, `xo instance init-keys` in `apps/cli/src/commands/instance/index.ts`, `deploy/cloud/*`, CI job `deploy-template`.

## What to check first

1. **No secret value in any rendered file.** The config has no field that takes one: `settings` refuses any secret setting, `secrets` is names
   only (extra keys refused), and `XO_APPROVAL_SIGNING_KEY` and `XO_SECRETS_KEY` may not be listed. The render never reads the environment.
   Test `no secret value appears in any rendered file` renders with secrets in the environment and scans every output; files are `0600`.
2. **Keys are generated where they live.** `xo instance init-keys` creates the secrets key (`XO_SECRETS_KEY_FILE`, owner-only, `wx`) and the
   approval signing key (stored encrypted by `xo secrets set`'s store), is idempotent, and prints neither. vm: `ExecStartPre` of `xo.service`;
   Kubernetes: an init container with the same volumes. Test `init-keys creates missing keys once and never prints them`.
3. **Exposure.** vm: the XO container publishes no port; Caddy publishes 80/443 and reaches XO by name; `ufw` allows 22, 80 and 443 only.
   Caution: Docker publishes ports around `ufw` by design, which is why XO publishes none. SSH on 22 is open to everyone; restrict it at the
   cloud firewall. Kubernetes: a ClusterIP Service; an Ingress only when asked.
4. **Same validation as start-up.** `parseDeployConfig` runs `resolveSettings` in production with the template's fixed values and a placeholder
   for the generated signing key, so a missing trust policy or audit retention is refused with every other problem at once.
5. **Image pinned by digest** (`@sha256:` plus 64 hex) is required; Caddy is `caddy:2-alpine` (not pinned by digest; see below).

## Things I would look at critically

- Caddy's image is a floating tag (`caddy:2-alpine`). The XO image is digest-pinned; Caddy should be too once the provider and registry are chosen.
- `cloud-init.yaml` embeds the compose file, Caddyfile and units. User data is visible through many clouds' metadata services; it holds the ACME
  contact address, the domain and the image reference, nothing secret. The ACME email is the owner's choice and is written only to the Caddyfile.
- The backup unit runs `docker compose exec` as root on the host, and writes backups as uid 10001 into `/srv/xo/backups` on the same disk as the data.
  A backup on the data disk does not survive losing the disk; copying it off is the operator's job (documented).
- Kubernetes: the trust policy is a ConfigMap named `<name>-trust` that must exist; the pod will not start without it. Secrets are `optional: true`
  references, so a missing Secret does not stop the pod, it leaves the setting unset (the instance's own validation then reports it).
- `xo deploy render` refuses a non-empty output directory unless `--force`; it does not check the file system the output is on.

## Not covered by tests

- The rendered stack is not started anywhere: CI renders both targets and validates the compose file (`docker compose config -q`) only. No cluster, no
  cloud-init run, no real certificate issuance.
- `docker-compose-v2` and `docker.io` are assumed to be in Ubuntu 24.04 `universe`/`main` as the plan states; not verified here.
- No change to the instance's runtime behaviour other than the new `init-keys` command.
