# P0.9C Step 1 — delivery manifest

Apply by copying `files/` over the repo root (complete replacement files). `p09c-step1.diff` is the full diff against the uploaded snapshot (`diff -ruN`).

## Added (2)
- packages/benchmark/src/attribution.ts
- packages/benchmark/test/attribution.test.ts

## Modified (9)
- packages/benchmark/src/{observation,observe,evaluation-types,evaluate,report,compare,format,index}.ts
- packages/benchmark/baselines/runtime-mechanics.report.json  (regenerated; +45 lines, 0 removed: evaluationVersion + attribution only)

## Deliberately NOT modified
vertical-fixtures baseline (stale, classified B), both suite files, fixtures, P0.9A/P0.9B code, Area E, compile-pdf-to-package.ts, all pre-existing tests.

## Test counts (sandbox)
Step 0 baseline: 2885 tests, 13 failing. Now: 2903 tests, 2887 pass, 13 failing (identical set: 3 pre-existing, 9 adm-zip sandbox, 1 stale phase2 .js load).
benchmark 61 -> 79 (+18). cli benchmark test 6/6.
Build: tsc -b clean for api, cli, benchmark, compiler, capability-contract, runtime (root tsc -b not runnable: apps/atlas-playground absent).
