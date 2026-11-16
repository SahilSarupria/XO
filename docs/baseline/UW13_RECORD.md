# UW-13 test record (evaluation harness skeleton, wave W1)

Branch `uw-13/evaluation-harness`, stacked on `uw-14/residency-egress`. Compared by name against `docs/baseline/tests-26f0052.tsv`.

## Behaviour changes callers can see

- **`npm run eval`** runs the evaluation harness (`packages/evaluation`). `npm run eval -- --write` updates `evaluation/REPORT.md`.
- **`npm run typecheck`** also typechecks the harness suites (`packages/evaluation/tsconfig.suites.json`). The suites are run with
  tsx and read the compiler's labelled table corpus from its test folder.
- **Owner-controlled data lives in `evaluation/`:** thresholds (all proposed) and the R1 to R18 register.

## Same name, body changed

- `every environment variable the instance code reads is in the registry` (`packages/instance/test/settings.test.ts`, added in UW-17).
  Its source scan now skips `packages/evaluation/suites`, which is development tooling rather than instance code.

No baseline test was renamed or removed.

## Result

7,481 pass, 4 skip and 1 fail across all workspaces. The failure was that scan, fixed above; `@xo/instance` passes 19/19 on re-run. By
name against the UW-0 baseline, nothing regresses beyond UW-1's documented benchmark rename.

## Added

`packages/evaluation/test/harness.test.ts` covers:

- thresholds as proposals until ratified, with only ratified ones passing or failing;
- the register rules, including accepted items, closed items and pilot blockers;
- the committed register: R1 to R18, the ten pilot-blocking items, and every cited file existing;
- the committed thresholds: valid, all proposed, and each produced by its suite;
- byte-identical reports across runs, with every suite stating its limits;
- a ratified failure shown in the verdict;
- `evaluation/REPORT.md` matching a fresh run of every suite.
