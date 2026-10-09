import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assessDocumentQuality } from '../../src/document/document-quality.js';
import { compileSources } from '../../src/pipeline/compile-sources.js';
import { createDefaultSourceFrontendRegistry } from '../../src/sources/default-registry.js';
import type { ParsedDocument, ParagraphBlock, DocumentSection } from '../../src/document/types.js';

/**
 * Phase 0 completion — permanent regression coverage against the real
 * policy fixture (`XO_Commercial_Property_Test_Policy_Compatible.pdf`).
 *
 * Every prior confirmation that this fixture compiles as `'trusted'`
 * with zero suspicious tokens (across M1.0–M1.3) was via ad-hoc manual
 * diagnostic scripts, never a committed test — so nothing would have
 * caught a future regression in `line-grouper.ts`/`text-legibility.ts`/
 * `document-quality.ts` silently reintroducing the exact class of defect
 * (`NameOpted`, the `and8827461093`-shaped digit/letter mash) this
 * pipeline was built to catch. This file closes that gap. It adds no
 * new detection logic — see the Phase 0 audit — only permanent proof
 * that the existing detection logic (a) currently passes on the real
 * fixture and (b) would actually notice if it stopped passing.
 */

const FIXTURE_PATH = fileURLToPath(new URL('../../../../examples/vertical-test/XO_Commercial_Property_Test_Policy_Compatible.pdf', import.meta.url));

async function loadRealFixtureBytes(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(FIXTURE_PATH));
}

function collectBlocks(section: DocumentSection, acc: ParagraphBlock[]): void {
  for (const block of section.blocks) if (block.kind === 'paragraph') acc.push(block);
  for (const subsection of section.subsections) collectBlocks(subsection, acc);
}

// ---------------------------------------------------------------------------
// 1. assessDocumentQuality directly against the real fixture
// ---------------------------------------------------------------------------

test('real policy fixture: assessDocumentQuality reports trusted with zero suspicious tokens', async () => {
  const registry = createDefaultSourceFrontendRegistry();
  const ingested = registry.ingest({ kind: 'pdf', bytes: await loadRealFixtureBytes(), sourcePath: 'XO_Commercial_Property_Test_Policy_Compatible.pdf' });
  assert.ok(ingested.ok, ingested.ok ? undefined : JSON.stringify(ingested.error));
  if (!ingested.ok) return;
  assert.equal(ingested.value.content.kind, 'document');
  if (ingested.value.content.kind !== 'document') return;

  const report = assessDocumentQuality(ingested.value.content.parsed, 'XO_Commercial_Property_Test_Policy_Compatible.pdf');
  assert.equal(report.state, 'trusted');
  assert.equal(report.suspiciousTokens, 0);
  assert.deepEqual(report.diagnostics, []);
  assert.ok(report.totalTokens > 0, 'sanity: the fixture actually produced extractable text');
});

// ---------------------------------------------------------------------------
// 2. Full compileSources end-to-end against the real fixture
// ---------------------------------------------------------------------------

test('real policy fixture: compileSources reports qualityState "trusted" and zero source-quality diagnostics', async () => {
  const result = await compileSources([{ kind: 'pdf', bytes: await loadRealFixtureBytes(), sourcePath: 'XO_Commercial_Property_Test_Policy_Compatible.pdf' }], {});
  assert.ok(result.ok, result.ok ? undefined : JSON.stringify(result.error));
  if (!result.ok) return;

  assert.equal(result.value.sources.length, 1);
  assert.equal(result.value.sources[0]!.qualityState, 'trusted');
  assert.ok(!result.value.diagnostics.some((d) => d.passName === 'source-quality'));
});

// ---------------------------------------------------------------------------
// 3. Synthetic corruption regression, grounded in the real fixture's own
//    text and the real, historically-observed defect shapes.
// ---------------------------------------------------------------------------

test('real-fixture regression proof: a single reintroduced known-defect token, injected into the real fixture\'s own real text, is individually detected even though the document as a whole (1300+ real tokens) correctly keeps its trust', async () => {
  const registry = createDefaultSourceFrontendRegistry();
  const ingested = registry.ingest({ kind: 'pdf', bytes: await loadRealFixtureBytes(), sourcePath: 'XO_Commercial_Property_Test_Policy_Compatible.pdf' });
  assert.ok(ingested.ok);
  if (!ingested.ok || ingested.value.content.kind !== 'document') return;
  const parsed = ingested.value.content.parsed;

  // The exact real historical defect shape this pipeline was built
  // against: a lowercase connector word glued directly onto a phone-
  // number-length digit run with no separating space — the shape
  // `line-grouper.ts`'s Stage-2 fix exists to prevent
  // (`sortedRuns.map(...).join('')`'s original concatenation defect).
  const REINTRODUCED_DEFECT = 'Contact and8827461093 AASTHA';

  const corrupted: ParsedDocument = {
    ...parsed,
    root: {
      ...parsed.root,
      subsections: [
        ...parsed.root.subsections,
        {
          heading: undefined,
          blocks: [{ kind: 'paragraph', text: REINTRODUCED_DEFECT, provenance: { page: 1, yRange: [0, 10] } }],
          subsections: [],
        },
      ],
    },
  };

  const report = assessDocumentQuality(corrupted, 'XO_Commercial_Property_Test_Policy_Compatible.pdf+reintroduced-defect');
  assert.ok(report.suspiciousTokens >= 1, 'the reintroduced defect token must be individually detected');
  assert.ok(report.diagnostics.some((d) => d.code === 'source-quality/digit_letter_mash'), 'the specific defect kind must be identified, not just a generic warning');
  // Proportionally small against the real fixture's ~1300 genuine
  // tokens — correctly does NOT tank the whole document's trust (see
  // `document-quality.ts`'s own DEGRADED_RATIO_THRESHOLD rationale: a
  // source should not lose full trust over one bounded artifact). The
  // point of this test is that the defect is never silently invisible,
  // not that one artifact should blocklist an otherwise-clean document.
  assert.equal(report.state, 'trusted');
});

test('real-fixture regression proof: the same reintroduced defect, concentrated in a small excerpt of the real fixture\'s own text, does flip the document-level state — proving detection scales from "one finding" to "untrustworthy document" as corruption density increases', async () => {
  const registry = createDefaultSourceFrontendRegistry();
  const ingested = registry.ingest({ kind: 'pdf', bytes: await loadRealFixtureBytes(), sourcePath: 'XO_Commercial_Property_Test_Policy_Compatible.pdf' });
  assert.ok(ingested.ok);
  if (!ingested.ok || ingested.value.content.kind !== 'document') return;

  const realParagraphs: ParagraphBlock[] = [];
  collectBlocks(ingested.value.content.parsed.root, realParagraphs);
  // A small, real excerpt (first few real paragraphs) — not the
  // document's full ~1300 tokens — so the same reintroduced defect
  // above is now a large-enough fraction of the total to matter.
  const excerpt = realParagraphs.slice(0, 1);
  assert.ok(excerpt.length > 0, 'sanity: the real fixture actually has extractable paragraphs to build the excerpt from');

  const REINTRODUCED_DEFECT = 'Contact and8827461093 AASTHA';
  const smallDoc: ParsedDocument = {
    bodyFontSizePt: ingested.value.content.parsed.bodyFontSizePt,
    root: { heading: undefined, blocks: [...excerpt, { kind: 'paragraph', text: REINTRODUCED_DEFECT, provenance: { page: 1, yRange: [0, 10] } }], subsections: [] },
  };

  const report = assessDocumentQuality(smallDoc, 'real-excerpt+reintroduced-defect');
  assert.notEqual(report.state, 'trusted');
  assert.ok(report.diagnostics.some((d) => d.code === 'source-quality/degraded' || d.code === 'source-quality/blocked'));
});
