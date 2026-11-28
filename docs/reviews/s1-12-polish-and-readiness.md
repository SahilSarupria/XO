# S1-12 review: polish and readiness

Status: needs owner review.

## What changed for a customer

- On a workflow's own page, the Ask box names that workflow and questions are about it (before, it named nothing there).
- The older "certificate" wording in the pre-start check and the draft panel is gone ("Check before starting").
- Settings no longer says "capabilities".

## What was added to the repository

- `test/ui/copy.test.tsx`: reads every place and every Settings section in User mode for technical and industry words.
- `test/contract/client-vs-openapi.test.ts`: every route the client calls is in the API's OpenAPI document with that method. It found that `/connect/...` is served but not documented; the test names that as a known gap and fails when it is fixed.
- J8-03 is a real journey. J3 stays recorded as not done (needs a mail server that drops a connection).
- `docs/studio/USABILITY_SCRIPT.md`, `docs/studio/STUDIO_READINESS_REPORT.md`, `docs/studio/FREE_TIER_DEPLOY.md`.

## Decided conservatively

The old candidate list and its side panel on Work are kept. Named workflows are created from a goal, so hiding the list would leave documents with candidates and no named workflow unable to start. The owner decides how a candidate becomes a workflow; then the list can go.

## Five states, glossary, axe, keyboard

No new screens beyond the Ask box's placeholder; axe finds nothing new and `a11y-known.json` is empty.

## Hand checks not done

Screen reader, 200% zoom, reduced motion. The Tauri desktop build was not built or run.
