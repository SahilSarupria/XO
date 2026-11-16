# UW-3 test record (generic ingestion)

Branch `uw-3/generic-ingestion`, stacked on `uw-1/integrity-identity-authorization`. Compared by name against
`docs/baseline/tests-26f0052.tsv`.

## Same name, body changed

| Test                                                                                  | Change                                                                                                                                             |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSV field-block tests in `packages/compiler/test/sources/structured-frontend.test.ts` | Each `structuredField` now also names its cell (`cellRef: 'A2'`); the exact-shape assertions include it.                                           |
| `the default registry has every built-in frontend registered` (`registry.test.ts`)    | The email frontend (`eml`) is registered by default.                                                                                               |
| `payload e2e: the step PAUSES ...` (`apps/api/test/payload-approval-m4.test.ts`)      | Fixed a pre-existing flake: "no input value in audit" matched `4242` inside random UUIDs (about 1 run in 20); it now matches the value as a token. |

No baseline test was renamed or removed.

## Added

- `packages/compiler/test/tabular/` — CSV (`csv.test.ts`), XLSX cells and hostile workbooks (`xlsx.test.ts`), record sets (`records.test.ts`),
  and the measured accuracy on the labelled corpus (`accuracy.test.ts`, `labelled-corpus.ts`).
- `packages/compiler/test/sources/` — `tabular-sources.test.ts`, `eml-frontend.test.ts`, `kind-proposals.test.ts`.
- A recovered-text provenance test in `packages/compiler/test/extraction/router.test.ts`.
- `apps/api/test/resumable-upload.test.ts`, and workbook, email, refusal and source-report tests in `apps/api/test/source-ingest.test.ts`.
- `apps/studio/test/platform/resumable-upload.test.ts`.
- Photos and scans (UW-3f): `packages/compiler/test/extraction/image-recovery.test.ts` (an image-capable tier reads a photo; other
  tiers are never offered one; JPEG frame-header dimensions; real tesseract end to end, skipped where the engine is missing), two
  photo tests in `vision-tier.test.ts`, and `apps/api/test/photo-ocr.test.ts` (an uploaded photo is read and reported; OCR
  configuration).
- Email attachments (UW-3f): `apps/api/test/email-attachments.test.ts` (opened, refused and decorative attachments; forwarded emails
  and the nesting limit; the 20-attachment limit; untrusted names) and a `withContent`/inline test in `eml-frontend.test.ts`.
