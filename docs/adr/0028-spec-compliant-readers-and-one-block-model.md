# 0028: Spec-compliant readers for Markdown, HTML and Word, one block model, and reading documents XO was not written against

## Status

Accepted under owner delegation, 2026-11-15 (UW-3c). Signed off by Claude under the owner's explicit delegation of decision authority; this is a delegated sign-off, not an independent review.

## Context

UW-3b made the compiler read a document's structure before reading it as policy, measured on documents written for that work. The owner asked whether any source would ingest correctly. It could not be claimed: no document XO had not been written against had been measured, Markdown and HTML were read by hand-written regular expressions, the API flattened Word to plain text before the compiler saw it, and right-aligned tables and per-glyph bullets were known gaps (KNOWN_LIMITATIONS, UW-3b).

A labelled set of fourteen public-domain documents by US federal teams (18F, CISA, USDS), each in the formats it travels in, was committed before any compiler change (`packages/evaluation/sets/real-documents.json`, three splits: dev, held-out, blind). On the UW-3b compiler it measured 65/161 (dev), 114/223 (held-out) and 51/143 (blind) items read right, with 50, 61 and 61 items lost without any report.

## Decision

1. **Spec-compliant parsers.** `@xo/compiler` depends on `parse5` (WHATWG HTML) and `markdown-it` (CommonMark with GitHub tables and task lists; indented code blocks are disabled, because plain-text documents indent paragraphs). Word is read by a linear XML tokenizer over `document.xml`, `numbering.xml`, `styles.xml`, footnotes and endnotes. No regular expression parses a markup language.
2. **One block model.** All three readers write through one `BlockSink` (`sources/structured-blocks/block-sink.ts`): headings; paragraphs (with a `preformatted` flag for code); list items with kind, ordinal by position, marker as written, nesting depth and check-box state; table rows with the first row flagged; footnotes. A bold run-in title is kept as `**lead** body` markup, the form the policy reader already titles passages by. Bold that runs on into the sentence (`**Never** share ...`) is emphasis, not a title.
3. **The API reads Word with the compiler's reader.** Uploads are still held to the API's ZIP limits; compiling a `.docx` passes the file itself (`{kind: 'docx'}`), as the CLI already did.
4. **PDF and OCR layout.** Wrapped list items, nesting by marker position (also across a page break when markers sit where they did), per-glyph markers rejoined to their text, numbered sentences that are not headings, bold labels between items, right-aligned and centred table columns (by estimated glyph widths), and on recovered (OCR) pages: body-size normalisation, misread bullet glyphs, headings from blank space, and bare-number repair.
5. **Reading what the text says.** Instructions behind lead clauses, phrases, fillers, adverbs, soft leads ("Try to ...", "Take a few minutes to ...") and bold labels; verbs only in verb positions; questions never as rules or actions; obligations stated about a subject ("Each team member is responsible for ...") as policies; hedged predictions ("will probably take") not as rules; title-case labels not as instructions; names that close the brackets and quotes they open; a blank line ends a sentence.
6. **Tasks in guideline sections are actions.** A plain instruction under a label item ("Reconciliation Tasks:" → "Match CRM records vs. insurer statements") or after a colon label of its own is marked a task: the action extractors read it, and the guideline constraint is kept only when no action is found in it. A rule stated as a sentence title, "Always ...", modals and prohibitions stay rules.
7. **No silent loss of instructions.** Coverage now also reports an imperative sentence that neither a rule nor a capability accounts for.

## Consequences

- Final measurement (`docs/baseline/uw3c/`): dev 159/161, held-out 183/223, blind 114/143 items read right; silent losses 2, 32 and 7. The blind split was measured twice (110/143 after dev tuning; 114/143 after generic fixes found on the benchmark and one held-out regression), never to choose a change.
- `vertical-fixtures` was refreshed (`packages/benchmark/baselines/refresh/uw-3c.refresh.json`). Two conservative regressions are recorded: Aastha's receipts workflow is ordered by tie-break because its source uses unordered bullets, and two capabilities read from descriptive sentences lose their human-in-the-loop binding.
- Three new runtime dependencies in `@xo/compiler`: `parse5`, `markdown-it`, and `@types/markdown-it` (dev).
- The escalation evaluation gold re-keys four Aastha units the reader now cuts at item boundaries; the held-out gold total moves 33 → 27 and results before UW-3c are not comparable on that split.

## Not decided here

- A calibrated quality threshold for any of the real-documents measures. The thresholds in `evaluation/thresholds.json` are proposals; the blind split does not meet them.
- The generic manual/HITL policy for steps with no declared operation (pre-execution program, W4).
