# Cloud deployment template (UW-17, ADR 0054)

One XO instance, from one config file, behind TLS, on one virtual machine or one Kubernetes pod. Still one instance and no external
queue: the data directory has a single writer, so there is no high availability. Recovery is a restore from backup (`docs/runbooks/`).

1. Copy `instance.example.yaml`, fill it in (domain, ACME email, the image digest, settings). `xo deploy check --config instance.yaml`
   validates it with the same rules the instance applies at start-up and lists what you must still provide.
2. `xo deploy render --config instance.yaml --target vm --out ./bundle` (or `--target kubernetes`). The bundle's `README.md` has the steps.
3. No rendered file holds a secret. The approval signing key and the secrets key are generated on the instance on first boot
   (`xo instance init-keys`) and never leave it. Provider secrets are set after boot with `xo secrets set <NAME>` (vm), or come from
   Kubernetes Secrets you create by name.

The vm target is written for Ubuntu 24.04 LTS images on clouds that run cloud-init. Kubernetes needs 1.29 or later and a CSI storage class
(volumes use `ReadWriteOncePod`). Backups stay on the machine until you copy them elsewhere.
