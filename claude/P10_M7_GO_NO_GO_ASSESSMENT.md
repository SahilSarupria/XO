# P1.0 M7 conditional go/no-go — assessment (2026-10-15)

Baseline: feat/p10-m5-package-trust @ 8a85c85; ancestry a8b4b60 (M4) → e04407b (M3) → eab65b9 (M6) → 5e8a241 (M5) → 8a85c85 verified linear. Working tree: only apps/cli/bin/xo.js mode change (100644→100755). Nothing pushed by this assessment; no PR/merge/audit.

## Decision: NO-GO (defer M7 hardening to P1.5)

No concrete, unresolved, in-scope gap was demonstrated. No M7 implementation commit was created.

## Evidence
1. AI execution not exposed. API `POST /workspaces/:id/runtime/execute` and CLI `runCommand` AI branch are guarded by `AI_EXECUTION_ENABLED = false` (code constants in apps/api/src/routes/runtime/runtime-routes.ts and apps/cli/src/commands/runtime/run.ts). Refusal (501 / failWith) happens before provider resolution or any x-xo-* header read. API `resolveProvider` has a single caller (that route). API deterministic paths (executions, workflows, human tasks) never construct a ModelProvider/ExecutionEngine.
2. Endpoint authentication. Live probe over all 62 registered routes: every route except /health and /openapi.json returned 401 for missing, malformed, unknown and wrong-scheme credentials; no credential echo. Exempt list is an exact-match allowlist.
3. Authorization boundaries. Workspace routes derive ownership from the server-side key record (requireOwnedWorkspace; foreign = uniform 404). Audit routes use AuditAccessController. /compiler/compile and /packages/validate are authenticated, workspace-independent pure computation.
4. Secret leakage. Probe: provider key/base-url/endpoint headers on the disabled route are not echoed in body or headers; unexpected non-XoError errors return a generic body; startup logs carry no key material; key store persists hashes only; manage-keys prints a raw key once at issue; CLI history redacts `--api-key`.
5. Focused existing tests: apps/api 82/82 (auth, principal, runtime-routes, provider-factory, error-mapping, router, workspace-bound-storage, authorization); apps/cli 46/46 (run, provider-factory, authorization).

## Observations (not demonstrated vulnerabilities; not fixed)
- Latent: API provider-factory accepts caller-supplied x-xo-api-key / x-xo-base-url / x-xo-endpoint (SSRF/credential-forwarding shape). Unreachable while the constant is false. Must be redesigned (operator-configured providers, endpoint allowlist) BEFORE AI execution is re-enabled; this is the gating item for D3.
- Malformed percent-encoding in a path param (e.g. `/workspaces/%E0%A4%A`) returns an unauthenticated generic 500 because route resolution (decodeURIComponent) runs before the auth middleware. No data disclosed; robustness defect only.
- Not assessed (out of scope / deferred audit): TLS, rate limiting/brute-force throttling, key expiry/rotation, request-size limits beyond the 64 MB body cap, CLI `--api-key` visible in process args (AI path disabled), CLI TUI `!` shell passthrough (local operator).

## Reason for deferral
D3 keeps AI execution disabled until effective authorization; the provider-header design only matters when that changes. Re-enabling is a P1.5-or-later code change that must carry its own hardening. Not a production-readiness claim.
