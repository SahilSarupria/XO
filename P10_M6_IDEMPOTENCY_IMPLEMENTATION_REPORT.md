# P1.0 M6 — Idempotency: Implementation Report

**Status: implementation complete, NOT accepted.** Built on the re-created M3 commit (`e04407b`, on `feat/p10-m3-approval-integrity`) over M4 (`a8b4b60`), per M1 → M2 → M4 → M3 → M6. M5 and conditional M7 are not implemented. No system-wide audit was performed.

## Behaviour
See `apps/api/README.md` "Idempotency (P1.0 M6)" for the contract. Summary: optional `Idempotency-Key` on capability execution start and workflow start; scope = operation + workspace + principal + key; request fingerprint decides same-vs-different; replay returns the original with `Idempotent-Replayed: true`; conflict 422; in-flight 409 (+`Retry-After`); interrupted-unprovable 409 `OUTCOME_UNKNOWN`; corrupt/foreign record 500 fail-closed. M1/M2/M3 re-run on every request; M4 audits original/replayed/recovered/conflict/in_progress/indeterminate with a `keyRef` digest only.

## Validation (this session)
- Focused: `apps/api/test/idempotency.test.ts` 30/30.
- Regression: `apps/api` 301/301 (271 prior + 30 new; includes execution, workflow, permissions, approval, audit-sink and error-mapping suites).
- Packages: storage 9/9 (+3 new atomic-store tests), audit 30/30, errors 6/6, permissions 146/146, runtime 473/473.
- `tsc -b tsconfig.json`: exit 0 (global TypeScript 6.0.3, not the pinned 5.9.3).
- **Not run:** ESLint and Prettier (not installable; `registry.npmjs.org` denied by sandbox egress). `apps/cli` and other packages' suites were not re-run in this session; CLI has 9 pre-existing environmental failures (`adm-zip` missing) unrelated to M6.

## Limitations (for the later audit)
1. In-process coordination only: concurrent processes on one data dir can race on takeover of a stranded key.
2. No TTL/cleanup of key records; no cancellation of in-flight work whose client left.
3. Records are plain files: a filesystem-level attacker can forge them (signing is M5 territory).
4. Not exactly-once. Interrupted-after-start work is surfaced as unknown, never retried automatically.
5. Resume/approval endpoints are not keyed. The CLI is unchanged.
6. M3/M4 known limitations were intentionally not touched.
