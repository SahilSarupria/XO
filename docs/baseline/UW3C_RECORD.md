# UW-3c record: reading documents XO was not written against

Branch `uw-3c/real-document-hardening`, stacked on `uw-3b/pdf-layout-procedural`. Decision record: `docs/adr/0028-spec-compliant-readers-and-one-block-model.md`.

## Why

After UW-3b, "any source ingests correctly" could not be claimed: no document XO had not been written against had been measured. UW-3c adds real documents in Word, HTML, PDF and scanned-PDF forms, fixes right-aligned tables and per-glyph bullets, and measures failure modes on those documents.

## The set

`packages/evaluation/sets/real-documents.json`: fourteen public-domain / CC0 documents by 18F, CISA and USDS (sources and commits in `examples/real-corpus/SOURCES.md`), each in the formats it travels in. Variants are derived by `examples/real-corpus/build.sh` (pandoc, LibreOffice, rasterise-and-degrade scans). Every sentence or list item is labelled with its expected reading: step, criterion, rule, action, none, or optional.

Labels were committed (e0943d6) before any compiler change. Three splits:

- **dev**: used to find and fix failures;
- **held-out**: labelled before XO ran on it; its failures were seen once, at the baseline;
- **blind**: labelled before any fix.

## Results (final scorer, both compilers)

| Split    | Items read right: UW-3b → UW-3c | Outputs right     | Lost without report |
| -------- | ------------------------------- | ----------------- | ------------------- |
| dev      | 65/161 → 159/161                | 65/138 → 159/163  | 50 → 2              |
| held-out | 114/223 → 183/223               | 114/222 → 187/230 | 61 → 32             |
| blind    | 51/143 → 114/143                | 52/118 → 114/168  | 61 → 7              |

The blind split was measured twice, never to choose a change: 110/143 after the dev tuning, and 114/143 after generic fixes made for failures found elsewhere (a benchmark regression on Aastha.pdf's per-glyph bullets, and one held-out item lost silently). Both runs are in `docs/baseline/uw3c/`.

Blind split, per format: Markdown 18/21, Word 29/34, scanned PDF 16/21, web page 20/27, PDF 22/29, Word HTML export 9/11.

Blind failure modes after: missed-silently 7, missed-reported 22, spurious-from-non-content 9, unmatched-output 42. Before, they were 61, 28, 8 and 53, plus wrong-kind 3.

## What does not meet the bar

The proposed thresholds (`evaluation/thresholds.json`) are 90% items read right, 90% output precision and zero silent losses on the blind split. None is met. Output precision is the weakest: XO still emits readings nobody labelled (42 on the blind split), mostly capabilities from descriptive sentences and fragments of code or links.

## Benchmark

`vertical-fixtures` was refreshed `f63630f39404` → `ec91b4bb3171` (`packages/benchmark/baselines/refresh/uw-3c.refresh.json`, CHANGELOG). Capability recall and precision are unchanged. Two conservative regressions on Aastha are acknowledged:

- the receipts workflow is ordered by tie-break, because its source uses unordered bullets;
- two capabilities read from descriptive sentences are not executable (they were human-in-the-loop).

The insurance fixtures (commercial property, TaskTest, multidoc) are otherwise unchanged. Burglary's Important Notice block is now four list items.

## Verification

Commands run at the PR head: `npm run build`, `npm test` (all workspaces), Studio Vitest, `npm run lint`, `npx prettier --check .`, `npm run typecheck`, `npm run eval -- --check`. Results are in the PR description.
