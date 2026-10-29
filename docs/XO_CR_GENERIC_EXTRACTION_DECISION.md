# XO CR — Generic extraction architecture: decision record

Status: DECIDED 2026-10-30 (CEO / lead engineer). Slice 1 implemented on `cr/ws1-dev-corpus`; later slices below.

## Goal
Extraction that works on any PDF, as fast as possible and with the fewest model tokens, with a hybrid (model-assisted) path
available later without redesign. "Any PDF" must be a measured claim, not a slogan.

## Ground truth today (verified in the code)
- Own dependency-free PDF reader + deterministic layout/table/rule stack. Fast, auditable, zero tokens.
- **No OCR engine exists.** A scanned page is only flagged `requires_ocr_unavailable`. So "any PDF" currently means
  "any PDF with a text layer".
- `packages/ai-core` already has cache, cost, router and model selection, but the main extraction path never calls a model.

## Decision
A **tiered, per-page recovery router**. Every page is read by the free deterministic reader first. Only a page it cannot
read is offered, one page at a time, to recovery tiers in cost order, stopping at the first trustworthy result:

1. `free`  — a second reader of the same file (decision: **pdfium via WASM**; permissive licence; also rasterises pages for tiers 2–3).
2. `local` — OCR on this machine (decision: **Tesseract** first; swap only if the benchmark shows it is the bottleneck).
3. `model` — a hosted vision model on that single page image. Last, budget-guarded, never auto-promoted (CRD-04).

Cost controls that are part of the design, not afterthoughts:
- A model tier's worst-case cost is **reserved before the call**; the default budget is **zero model spend**; the
  per-document ceiling can never be overrun, including with pages recovered in parallel.
- Results cached by (document hash, page, tier, tier version): re-runs and retries cost nothing.
- Confidence gate per tier; a failing, hanging, empty or low-confidence tier falls through; a page nobody can read stays
  **unaccounted and reported**, never guessed.
- Pages are independent and run in a bounded worker pool: wall-clock time is the slowest page, not the sum.
- Every run produces a **ledger** (tier, outcome, ms, tokens, USD per page) so cost is a number.

Model use outside page recovery stays sentence-level: one validated, human-confirmed proposal per review-list sentence
(WS1-09). No whole-document model reads, ever.

## Rejected
- LLM reads whole documents: highest cost, lowest checkability.
- mupdf: AGPL, unsuitable for a commercial product.
- Layout ML models now: dependency and model files for a problem the benchmark has not shown yet. Revisit if table
  recall on real documents is the limiting failure.
- Replacing the own reader: it is the fast, free path for the common case; the second reader is a fallback, not a replacement.

## Slices
1. DONE: tier interface, router, budget/reservation, cache, ledger, coverage status `ocr`, `compileSources` options
   (`pageTiers`, `extractionBudget`, `recoveryCache`), tests with stub tiers on a generated scanned/mixed fixture.
   The real engines are NOT in yet.
2. Failure-taxonomy benchmark: synthetic cases (scanned, rotated, two-column, encrypted, form-heavy, table-only, non-English,
   corrupted) measuring per tier: pages recovered, ms, tokens.
3. Adapters: pdfium WASM (second reader + rasteriser), Tesseract OCR. Needs package installs, which the build sandbox
   blocks; done where `npm ci` works (CI / dev machine).
4. Vision-model tier behind the budget guard, calibrated against the benchmark; encrypted PDFs; rotated pages.
5. Real documents (see `examples/real-documents`): measure and tune the thresholds (confidence gate, timeouts, routing).

## Open risks
- All thresholds (min confidence 0.6, timeout 60 s) are unvalidated defaults until slice 2/5 provide data.
- Tesseract quality on insurance tables is unknown; the vision tier may be needed more often than hoped. The ledger will say.
- Hosted-model use sends page images off-machine: needs a customer data-handling decision before the pilot.
