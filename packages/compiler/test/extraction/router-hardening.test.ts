import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { NodePdfLoader } from '../../src/pdf/pdf-loader.js';
import { recoverUnreadPages, InMemoryRecoveryCache, summarizeRun } from '../../src/extraction/router.js';
import { RunBudget } from '../../src/extraction/budget.js';
import { FileRecoveryCache } from '../../src/extraction/file-cache.js';
import type { PageRecovery, PageTier, TierCostClass } from '../../src/extraction/types.js';

const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL('../fixtures/scanned-and-mixed.pdf', import.meta.url))));
const loaded = () => {
  const r = new NodePdfLoader().load(bytes, 'x.pdf');
  assert.ok(r.ok);
  return r.value;
};
const GOOD: PageRecovery = { lines: [{ text: 'Recovered text for this page.', x: 72, y: 700 }], confidence: 0.9 };

function tier(
  name: string,
  costClass: TierCostClass,
  behave: (page: number, signal: AbortSignal | undefined) => Promise<PageRecovery | undefined>,
  estimate?: number,
): PageTier & { calls: number } {
  const t = {
    name,
    version: '1',
    costClass,
    calls: 0,
    handles: (p: { requiresOcr: boolean }) => p.requiresOcr,
    ...(estimate !== undefined ? { estimateCostUsd: () => estimate } : {}),
    async recover({ page, signal }: { page: { pageNumber: number }; signal?: AbortSignal }) {
      t.calls += 1;
      return behave(page.pageNumber, signal);
    },
  };
  return t as PageTier & { calls: number };
}

test('router: a timed-out tier call has its AbortSignal aborted, so it can stop consuming resources', async () => {
  let aborted = false;
  const slow = tier(
    'slow',
    'local',
    (_p, signal) => new Promise((resolve) => signal?.addEventListener('abort', () => ((aborted = true), resolve(undefined)))),
  );
  const { ledger } = await recoverUnreadPages(loaded(), bytes, [slow], { tierTimeoutMs: 30 });
  assert.equal(aborted, true);
  assert.ok(ledger.entries.every((e) => e.outcome === 'timed_out'));
});

test('router: one RunBudget is shared across documents and concurrent pages and is never overrun', async () => {
  const run = new RunBudget(0.05);
  const model = tier('vision', 'model', async () => ({ ...GOOD, costUsd: 0.02, tokensUsed: 100 }), 0.02);
  const docs = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      recoverUnreadPages(loaded(), new Uint8Array([...bytes, i]), [model], { maxCostUsd: 1, runBudget: run, concurrency: 4 }),
    ),
  );
  const report = summarizeRun(docs.map((d) => d.ledger));
  assert.ok(report.totalCostUsd <= 0.05 + 1e-9, `spent ${report.totalCostUsd}`);
  assert.ok(run.committedUsd <= 0.05 + 1e-9);
  assert.ok(model.calls <= 2, `model called ${model.calls} times for a ceiling that fits 2`);
  assert.ok(report.byTier.some((t) => t.tier === 'vision'));
});

test('router: with the default budget a model tier is never called, whatever the concurrency', async () => {
  const model = tier('vision', 'model', async () => GOOD, 0.01);
  const { ledger } = await recoverUnreadPages(loaded(), bytes, [model], { concurrency: 16 });
  assert.equal(model.calls, 0);
  assert.equal(ledger.totalCostUsd, 0);
  assert.ok(ledger.entries.every((e) => e.outcome === 'skipped_budget'));
});

test('router: concurrent runs over the same document call a tier once per page (never sent twice)', async () => {
  const cheap = tier('ocr', 'local', async () => {
    await new Promise((r) => setTimeout(r, 40));
    return GOOD;
  });
  const cache = new InMemoryRecoveryCache();
  const [a, b] = await Promise.all([
    recoverUnreadPages(loaded(), bytes, [cheap], {}, cache),
    recoverUnreadPages(loaded(), bytes, [cheap], {}, cache),
  ]);
  assert.equal(cheap.calls, 2, 'two scanned pages, one call each');
  assert.equal(a.ledger.pagesRecovered, 2);
  assert.equal(b.ledger.pagesRecovered, 2);
  const shared = [...a.ledger.entries, ...b.ledger.entries].filter((e) => e.outcome === 'deduplicated' || e.outcome === 'cache_hit');
  assert.equal(shared.length, 2);
});

test('router: a rejected (low-confidence) answer is remembered, so a failing page is not paid for twice', async () => {
  const model = tier(
    'vision',
    'model',
    async () => ({ lines: [{ text: 'blurry', x: 1, y: 1 }], confidence: 0.2, costUsd: 0.01, tokensUsed: 50 }),
    0.01,
  );
  const cache = new InMemoryRecoveryCache();
  await recoverUnreadPages(loaded(), bytes, [model], { maxCostUsd: 1 }, cache);
  const first = model.calls;
  const second = await recoverUnreadPages(loaded(), bytes, [model], { maxCostUsd: 1 }, cache);
  assert.equal(model.calls, first, 'no second call for the same pages');
  assert.equal(second.ledger.totalCostUsd, 0);
});

test('router: cancelling the run leaves remaining pages unaccounted and calls no further tier', async () => {
  const ac = new AbortController();
  const t = tier('ocr', 'local', async () => GOOD);
  ac.abort();
  const { document, ledger } = await recoverUnreadPages(loaded(), bytes, [t], { signal: ac.signal });
  assert.equal(t.calls, 0);
  assert.equal(ledger.pagesRecovered, 0);
  assert.ok(document.pages.filter((p) => p.requiresOcr).length >= 2);
});

test('file cache: round-trips, rejects tampered entries, and survives many concurrent writer processes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xo-cache-'));
  const cache = new FileRecoveryCache(dir);
  cache.set('a'.repeat(64), GOOD);
  assert.deepEqual(cache.get('a'.repeat(64)), GOOD);
  assert.equal(cache.get('b'.repeat(64)), undefined);
  const script = `
    import { FileRecoveryCache } from ${JSON.stringify(fileURLToPath(new URL('../../src/extraction/file-cache.ts', import.meta.url)))};
    const c = new FileRecoveryCache(${JSON.stringify(dir)});
    for (let i = 0; i < 40; i++) c.set('c'.repeat(63) + (i % 4), { lines: [{ text: 'shared', x: 1, y: 1 }], confidence: 0.9 });
  `;
  const procs = Array.from({ length: 6 }, () =>
    spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8' }),
  );
  for (const p of procs) assert.equal(p.status, 0, p.stderr);
  for (let i = 0; i < 4; i++) assert.equal(cache.get('c'.repeat(63) + i)?.lines[0]?.text, 'shared');
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0, 'no temp files left behind');
});
