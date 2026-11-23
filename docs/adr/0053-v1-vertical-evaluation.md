# 0053: Measured evaluation of the V1 vertical (UW-13)

## Status

Accepted under the owner's delegation, 2026-11-23. Implements the UW-13 vertical runs for V1 and two of Revision 4's generality
criteria (G-1, G-3). Thresholds remain proposals until the owner ratifies them (UAC-19).

## Context

V1 exits on owner items alone; one of them is accuracy on a labelled V1 sample (UAC-19). The harness had no suite for the V1 path and
no way to read a labelled set kept outside the repository. Revision 4 also asks for V2 and V3 runs and a head-to-head with an agent
baseline.

## Decision

1. **A `v1-vertical` suite** measures what V1 runs: reading the client list, building one item per row, pairing each row with its
   document by name, and leaving out rows and documents with the right reason. Seven measures, including the count of wrong pairings.
2. **Labelled sets have a format and are read where they lie.** `xo-v1-set/1`: a list, a folder of documents and a labels file that
   states the true person for every document and the true reason for every exclusion. Only the set's hash, sizes and the measures enter
   the report. A real set inside the repository, or a set with symbolic links, is refused.
3. **A seeded synthetic set** stands in until the owner's sample arrives. Its labels come from construction, with the matcher in view,
   and the report says so.
4. **Thresholds are proposals.** Wrong pairings at most zero restates the vertical's rule that one wrong pairing is a failure; the
   owner should ratify it before any real measurement.
5. **Generality now:** a generic-code-diff gate lists every change outside pack content, sets, tests, fixtures and docs (informational
   until a vertical run makes it strict), and a test shows the V1 flow's safety behaviour does not depend on which Domain Knowledge
   Pack is installed.
6. **Deferred to the generality wave, with reasons:** V2 (invoice reconciliation) and V3 (delivery risk) need labelled data written by
   someone other than the engineer and a read-only database connector; the agent-baseline comparison needs a live model, which
   `strict_local` refuses by default.
7. A one-page V1 readiness report links the acceptance check, the evaluation report, the scenario index and the limits.

## Consequences

- UAC-19 can be measured the day the owner provides a sample, with one command.
- The generality exit (Revision 4 B.14.2) is partly instrumented; its runs remain.

## Reopen if

- The owner's sample needs a format this one cannot express (for example several documents per person by design).
