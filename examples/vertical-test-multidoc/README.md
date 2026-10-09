# Golden multi-document fixture

Three synthetic, non-sensitive documents demonstrating a real organization's
"document set" — a burglary/theft insurance policy split across a summary of
cover, a claims procedure, and supporting rules/definitions — compiled by
`xo create ./examples/vertical-test-multidoc` (or the equivalent
`collectSources`/`compileSources` call) into **one** merged XO, per this
task's "golden vertical requirement."

## Why `.txt`, not `.pdf`

The brief's example names these as `.pdf` files. They're plain text here
instead, deliberately:

- `@xo/compiler`'s Stage 8 architecture normalizes every textual source
  (`pdf`, `document`, `html`, `structured`) to the exact same
  `ParsedDocument` shape before extraction ever runs (see
  `packages/compiler/src/sources/types.ts`'s `DocumentSourceContent` doc
  comment) — so a `.txt` file and a text-equivalent `.pdf` exercise
  identical downstream compiler behavior. The only thing `.pdf` would add
  here is PDF *parsing*, which is already covered by
  `packages/compiler`'s own PDF frontend tests and by
  `examples/e2e-pdf/run.ts` against a real PDF.
- A real, valid, multi-page `.pdf` isn't something to hand-author byte by
  byte, and copying the same real PDF fixture (`examples/vertical-test/
  burglary-policy.pdf`, ~360KB) three times under different names would
  triple that binary's footprint in the repository for a fixture whose
  actual job is exercising *directory/ZIP collection and multi-source
  merge*, not PDF parsing.
- The task brief explicitly allows this: "The fixture can be
  synthetic/non-sensitive."

`apps/cli/test/source-collection.test.ts` additionally covers a real `.pdf`
file inside a directory, using `examples/vertical-test/burglary-policy.pdf`
itself, so real-PDF-in-a-directory is still exercised — just not tripled
into this fixture.

## What this fixture is for

`apps/cli/test/create.test.ts`'s multi-document golden-vertical test points
`xo create` directly at this directory and asserts:

- all three files are discovered (`collectSources`), sorted deterministically
- they compile into one `XoirGraph` (`compileSources`'s merge, not three
  independent graphs stitched together)
- every semantic node's provenance still traces back to the specific file
  (`claims-procedure.txt` vs. `policy.txt` vs. `supporting-rules.txt`) it
  came from — the merge never collapses multi-source provenance into the
  directory path itself
- the result packages into one signed, valid `.xo`
