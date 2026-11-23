# 0054: A cloud deployment template, still one instance (UW-17)

## Status

Accepted under the owner's delegation, 2026-11-23. Delivers the provider-neutral template ADR 0023 deferred to W5. Keeps ADR 0045
decision 1.

## Context

`xo up`, one image and a single-instance compose file exist. There was no way to bring up a customer instance on a server with TLS
from a small config file. The hosting provider is not chosen.

## Decision

1. **One instance, no queue.** The template deploys what `xo up` runs, on one machine or one pod, with its data on one volume. Several
   replicas or a managed queue would break the single-writer data directory; they need their own ADR.
2. **One config file, two targets.** `xo deploy render` produces either a cloud-init bundle for a virtual machine (XO behind Caddy,
   which obtains and renews TLS certificates automatically; Docker from the distribution's archive; a daily backup) or Kubernetes
   manifests (one replica, volumes only one pod may mount, probes, non-root).
3. **No secret in any rendered file.** Keys are generated inside the instance on first boot and never leave it; provider secrets are
   set after boot or referenced by name.
4. **The same validation as start-up**, with every problem listed at once, and the image pinned by digest.
5. **Backups stay on the machine** until the operator copies them; the README says how.

## Consequences

- A customer instance comes up with one command plus a domain, DNS and the OAuth redirect addresses, which remain the owner's.
- No high availability. Recovery is restore from backup (runbooks).

## Reopen if

- A customer needs high availability or several replicas (a distributed lease and shared storage first).
- A provider is chosen and a provider-specific target (for example Terraform/OpenTofu) is wanted.
