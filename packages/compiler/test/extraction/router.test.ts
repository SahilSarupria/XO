import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NodePdfLoader } from '../../src/pdf/pdf-loader.js';
import { recoverUnreadPages, InMemoryRecoveryCache } from '../../src/extraction/router.js';
import type { PageTier, PageRecovery, TierCostClass } from '../../src/extraction/types.js';
import { compileSources } from '../../src/pipeline/compile-sources.js';

const PDF = fileURLToPath(new URL('../fixtures/scanned-and-mixed.pdf', import.meta.url));
const bytes = new Uint8Array(readFileSync(PDF));
const load = () => {
  const r = new NodePdfLoader().load(bytes, 'scanned-and-mixed.pdf');
  assert.ok(r.ok);
  return r.value;
};

const TEXT_BY_PAGE: Record<number, string[]> = {
  2: ['Claim Assessment', 'If the claim assessment amount exceeds 10000, then deny the claim.'],
  3: ['Notification', 'The Insured must notify the Insurer within 7 days of becoming aware of the loss.'],
};

function tier(
  name: string,
  costClass: TierCostClass,
  opts: { confidence?: number; throws?: boolean; hang?: boolean; cost?: number; estimate?: number } = {},
): PageTier & { calls: number[] } {
  const calls: number[] = [];
  return {
    name,
    version: '1',
    costClass,
    calls,
    handles: (p) => p.requiresOcr,
    ...(opts.estimate !== undefined ? { estimateCostUsd: () => opts.estimate! } : {}),
    async recover({ page }): Promise<PageRecovery | undefined> {
      calls.push(page.pageNumber);
      if (opts.throws) throw new Error('engine crashed');
      if (opts.hang) return new Promise(() => undefined);
      const lines = (TEXT_BY_PAGE[page.pageNumber] ?? []).map((text, i) => ({
        text,
        x: 72,
        y: 760 - i * 30,
        fontSizePt: i === 0 ? 14 : 11,
      }));
      return {
        lines,
        confidence: opts.confidence ?? 0.9,
        tokensUsed: costClass === 'model' ? 400 : 0,
        ...(opts.cost !== undefined ? { costUsd: opts.cost } : {}),
      };
    },
  };
}

test('extraction: with no tier a scanned page stays unaccounted, exactly as before', async () => {
  const r = await compileSources([{ kind: 'pdf', bytes, sourcePath: 'scanned-and-mixed.pdf' }]);
  assert.ok(r.ok);
  const src = r.value.sources[0]!;
  assert.equal(src.qualityState, 'partial');
  assert.equal(src.coverage?.unaccountedPages, 2);
  assert.equal(src.recovery, undefined);
});

test('extraction: a free/local tier recovers scanned pages, coverage becomes complete, and the recovered text is compiled into rules', async () => {
  const ocr = tier('stub-ocr', 'local');
  const r = await compileSources([{ kind: 'pdf', bytes, sourcePath: 'scanned-and-mixed.pdf' }], { pageTiers: [ocr] });
  assert.ok(r.ok);
  const src = r.value.sources[0]!;
  assert.equal(src.coverage?.unaccountedPages, 0);
  assert.equal(src.coverage?.ocrPages, 2);
  assert.equal(src.qualityState, 'trusted');
  assert.equal(src.recovery?.pagesRecovered, 2);
  assert.equal(src.recovery?.totalCostUsd, 0);
  assert.ok(
    r.value.graph.allNodes().some((n) => JSON.stringify(n.properties).includes('exceeds 10000')),
    'the rule on the scanned page was extracted',
  );
  assert.ok(
    r.value.graph.allNodes().some((n) => JSON.stringify(n.properties).includes('days since becoming aware')),
    'the deadline on the scanned page was extracted',
  );
});

test('extraction: tiers run in cost order and a cheaper success means the dearer tier is never called', async () => {
  const model = tier('vision', 'model', { estimate: 0.05, cost: 0.04 });
  const local = tier('ocr', 'local');
  const { ledger } = await recoverUnreadPages(load(), bytes, [model, local], { maxCostUsd: 1 });
  assert.deepEqual(model.calls, []);
  assert.equal(local.calls.length, 2);
  assert.equal(ledger.totalCostUsd, 0);
});

test('extraction: with the default budget a model tier is never called; an explicit ceiling is never overrun even in parallel', async () => {
  const none = tier('vision', 'model', { estimate: 0.05, cost: 0.05 });
  const a = await recoverUnreadPages(load(), bytes, [none], {});
  assert.deepEqual(none.calls, []);
  assert.equal(a.ledger.pagesRecovered, 0);
  assert.ok(a.ledger.entries.every((e) => e.outcome === 'skipped_budget'));

  const one = tier('vision', 'model', { estimate: 0.05, cost: 0.05 });
  const b = await recoverUnreadPages(load(), bytes, [one], { maxCostUsd: 0.07, concurrency: 4 });
  assert.equal(one.calls.length, 1, 'only one 0.05 call fits under 0.07');
  assert.ok(b.ledger.totalCostUsd <= 0.07);
  assert.equal(b.ledger.pagesRecovered, 1);
});

test('extraction: a crashing, low-confidence or hanging tier falls through to the next tier', async () => {
  const crash = tier('crash', 'free', { throws: true });
  const weak = tier('weak', 'local', { confidence: 0.3 });
  const hang = tier('hang', 'local', { hang: true });
  const good = tier('good', 'local', { confidence: 0.95 });
  const { document, ledger } = await recoverUnreadPages(load(), bytes, [crash, weak, hang, good], { tierTimeoutMs: 50 });
  assert.equal(ledger.pagesRecovered, 2);
  assert.ok(document.pages.filter((p) => p.recovery?.tier === 'good').length === 2);
  const outcomes = new Set(ledger.entries.map((e) => e.outcome));
  for (const o of ['tier_failed', 'low_confidence', 'timed_out', 'recovered']) assert.ok(outcomes.has(o as never), `missing outcome ${o}`);
});

test('extraction: nothing readable by any tier leaves the page unaccounted, never guessed', async () => {
  const weak = tier('weak', 'local', { confidence: 0.2 });
  const { document } = await recoverUnreadPages(load(), bytes, [weak]);
  assert.ok(document.pages[1]!.requiresOcr);
  assert.equal(document.pages[1]!.recovery, undefined);
});

test('extraction: a recovered page is cached, so a second run never calls the tier', async () => {
  const cache = new InMemoryRecoveryCache();
  const first = tier('ocr', 'local');
  await recoverUnreadPages(load(), bytes, [first], {}, cache);
  assert.equal(first.calls.length, 2);
  const second = tier('ocr', 'local');
  const { ledger } = await recoverUnreadPages(load(), bytes, [second], {}, cache);
  assert.equal(second.calls.length, 0);
  assert.ok(ledger.entries.every((e) => e.outcome === 'cache_hit'));
  const bumped = { ...tier('ocr', 'local'), version: '2' } as PageTier;
  const { ledger: l3 } = await recoverUnreadPages(load(), bytes, [bumped], {}, cache);
  assert.ok(
    l3.entries.every((e) => e.outcome === 'recovered'),
    'a new tier version does not reuse old results',
  );
});
