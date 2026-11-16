# Evaluation harness (UW-13, wave W1 skeleton)

One harness measures what XO claims, on labelled sets whose provenance and content hash are part of every result. Thresholds are the
owner's, and the commercial readiness register says what still blocks a first pilot.

```bash
npm run eval                    # every suite; prints the report
npm run eval -- --fast          # skip slow suites
npm run eval -- --suite tabular-reading,document-kinds
npm run eval -- --write         # also update evaluation/REPORT.md and evaluation/report.json
npm run eval -- --check         # exit 1 if a ratified threshold fails, or the thresholds or register are invalid
```

The current report is [evaluation/REPORT.md](../evaluation/REPORT.md). A test fails when it is stale, so the committed numbers are
always the numbers the code produces.

## Suites

| Suite                 | Measures                                                                                                               | Evidence for   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------- |
| `tabular-reading`     | Header, column-type and record-count accuracy on UW-3's 170-table labelled corpus.                                     | UAC-19         |
| `document-kinds`      | Right document kind proposed first, abstention, certificate precision and recall.                                      | UAC-19         |
| `egress-boundary`     | Real values reaching a typed request over 200 random tables, and hosted calls passing `strict_local` (both must be 0). | UAC-24, UAC-25 |
| `intelligence-oracle` | Customer intelligence per category, with a deterministic stand-in model; restricted-content leaks.                     | UAC-17, UAC-19 |
| `injection-corpus`    | The UW-1 injection corpus's structural checks in the compiler, intelligence layer and workflow runtime (slow).         | UAC-17         |

Each suite does three things in every result:

- names its labelled sets with version, provenance (`synthetic` or `real`) and a SHA-256 of their content;
- says which acceptance criteria it is evidence for;
- states its limits.

Notes never contain customer content.

**Adding a suite.**

1. Write a `Suite` in `packages/evaluation/suites/` and add it to `suites/index.ts`.
2. Give each measure a proposed threshold in `evaluation/thresholds.json`.
3. Run `npm run eval -- --write`.

## Labelled sets

A labelled set records how its labels were made: by whom, and with what in view. A set written with the code in view shows that a
mechanism works, not how well it works on real documents. UAC-19 needs real sets: real customer workbooks and certificates for the
first vertical, labelled by someone who has not seen the code's output. Those come with the pilot (R12, R13).

Real customer documents never go into the repository. When real sets arrive, the harness will read them from a path given at run
time, and only their hash, size and measures will enter the report.

## Thresholds (UAC-19)

`evaluation/thresholds.json` holds one bound per measure, with its rationale.

- **Proposals do not gate.** Every threshold starts as `proposed`. A proposal is shown beside its measure and never gates anything.
- **The owner ratifies.** A threshold becomes `ratified` when the owner sets `status`, `ratifiedBy` and `ratifiedAt`. Ratify before
  looking at new numbers, not after.
- **Failures surface.** A ratified threshold that fails appears in the verdict, and `--check` exits 1.

**Where the proposals come from.**

- Most are engineering proposals made from the current measurements.
- The intelligence ones are carried over from `packages/intelligence-eval`.
- The egress ones restate ADR 0019 and 0020, and tests that fail the build enforce them anyway.

## Commercial readiness register (UAC-20)

`evaluation/register.json` lists R1 to R18. Each item has a title, an owner, a status (`open`, `in_progress`, `closed`, `accepted`),
evidence and the next step. Ten items block a first pilot with real customer data: R1, R2, R3, R4, R6, R10, R11, R12, R13 and R17.
The pilot gate stays **blocked** until each of them is closed, or explicitly accepted by the owner (`acceptedBy`, `acceptedAt`).

A test checks four things:

- every item is present;
- every item has an owner;
- an accepted item records who accepted it;
- every cited file exists.

R8, R9, R15 and R16 are not titled in the plan text this was built from; they are marked `titleUnconfirmed` until they are
confirmed from the A1 audit.

## Not yet

- **Live-model evaluation (Q1).** It exists for customer intelligence (`npm run eval -w @xo/intelligence-eval -- --mode live`) but is
  not part of the harness report. A live run is not reproducible and costs money, so it will be a separate, stamped report.
- **Real labelled sets** for the certificate vertical (R12, R13).
- **Wave W5.** The vertical runs (V0, V2, V3) under the generic-code-diff gate (UAC-18) and the head-to-head against an agent
  baseline.
- **The benchmark package's cross-domain corpus** (`packages/benchmark`) is not yet a suite here.
