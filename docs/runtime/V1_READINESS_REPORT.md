# V1 readiness report (one page)

The certificate-distribution vertical (V1) as of wave W5. This page links the evidence; it does not repeat it.

## Verdict

**Engineering is complete for V1; the exit waits on owner items.** The flow runs end to end through the API with production approval rules
against a local fake of Gmail. Nothing in this repository can close the items below.

## Where the evidence is

- Acceptance check, criterion by criterion: [`V1_ACCEPTANCE.md`](V1_ACCEPTANCE.md).
- Mandatory scenarios and their tests: [`MANDATORY_SCENARIOS.md`](MANDATORY_SCENARIOS.md).
- Measured accuracy and the readiness register: [`evaluation/REPORT.md`](../../evaluation/REPORT.md). The `v1-vertical` suite measures reading the
  list, pairing, wrong pairings and left-out rows on a seeded synthetic set (ADR 0053).
- Limits stated plainly: [`KNOWN_LIMITATIONS.md`](../KNOWN_LIMITATIONS.md).
- Domain isolation (G-3): `apps/api/test/domain-isolation.test.ts`. Generic-code-diff gate (G-1): `scripts/generic-diff-gate.mjs`, informational.

## What the owner's sample will measure

Give a labelled sample in the `xo-v1-set/1` format ([`EVALUATION.md`](../EVALUATION.md), "Labelled V1 sets") and run
`npm run eval -- --suite v1-vertical --set v1-vertical=/path/to/sample`. The result is a second row, `v1-vertical-external`, with the set's
hash and counts and the seven measures. **Ratify the thresholds first**, at least `wrong-pairings` at most zero.

## Open owner items

1. A labelled V1 sample, and ratified thresholds before it is measured (UAC-19).
2. One run against a sandbox mailbox for Gmail and Microsoft (V1-G5).
3. One green CI run on the merge (V1-G6).
4. Choose a hosting provider and domain (UW-17).

## What the synthetic numbers do not show

The synthetic set's labels were written with the name matcher's tiers in view. They show the matcher does what it was designed to do. They
do not show accuracy on a customer's files, which is what UAC-19 asks for.
