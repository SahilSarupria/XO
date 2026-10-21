import { describe, expect, it } from 'vitest';
import { barPercent, categoryLabel, knowledgeGraph, latestByCategory, shortDid } from '../../src/domain/xo';
import { parseRegistryInspect, parseRegistrySearch, WireParseError } from '../../src/platform/wire';

const run = (id: string, category: string, score: number, runAt: string) => ({ id, packageId: 'p', category, score, runAt, challengeable: false });

describe('benchmark helpers', () => {
  it('keeps the latest run per category and never averages', () => {
    const r = latestByCategory([run('1', 'reasoning_quality', 0.5, '2026-01-01'), run('2', 'reasoning_quality', 0.9, '2026-02-01'), run('3', 'safety', 0.7, '2026-01-05')]);
    expect(r).toEqual([
      { category: 'reasoning_quality', score: 0.9, runAt: '2026-02-01', runs: 2 },
      { category: 'safety', score: 0.7, runAt: '2026-01-05', runs: 1 },
    ]);
    expect(latestByCategory([])).toEqual([]);
  });
  it('draws a bar only when the score can be read as a fraction or a percentage', () => {
    expect(barPercent(0.5)).toBe(50);
    expect(barPercent(80)).toBe(80);
    expect(barPercent(250)).toBeUndefined();
    expect(barPercent(-1)).toBeUndefined();
    expect(barPercent(Number.NaN)).toBeUndefined();
  });
  it('words a category and shortens a DID', () => {
    expect(categoryLabel('reasoning_quality')).toBe('Reasoning quality');
    expect(shortDid('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK')).toMatch(/…/);
    expect(shortDid('did:x')).toBe('did:x');
  });
});

describe('knowledge graph', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, name: `Rule ${i}`, state: 'approved' as const }));
  it('places at most max rules around the XO and reports how many were left out', () => {
    const g = knowledgeGraph('X', items, 10);
    expect(g.nodes).toHaveLength(10);
    expect(g.hidden).toBe(2);
    expect(knowledgeGraph('X', [], 10).nodes).toEqual([]);
  });
});

describe('registry wire parsers', () => {
  const rec = { id: 'p1', publishedAt: '2026-01-01T00:00:00Z', manifest: { name: 'burglary', version: '1.0.0', creatorDid: 'did:key:abc', capabilities: [{ id: 'c', name: 'Check', description: 'd' }], signatures: [{}], components: { rules: { path: 'rules.json' } } } };
  it('reads a record and counts signatures without judging them', () => {
    const [p] = parseRegistrySearch({ records: [rec] });
    expect(p).toMatchObject({ id: 'p1', name: 'burglary', version: '1.0.0', signatureCount: 1 });
    expect(p!.capabilities).toHaveLength(1);
  });
  it('reads an inspect response and rejects malformed bodies', () => {
    const r = parseRegistryInspect({ record: rec, benchmarkRuns: [{ id: 'b', packageId: 'p1', category: 'safety', score: 0.5, runAt: 'x', challengeable: true }] });
    expect(r.runs[0]!.challengeable).toBe(true);
    expect(() => parseRegistrySearch({ records: [{ id: 1 }] })).toThrow(WireParseError);
    expect(() => parseRegistryInspect({ record: rec })).toThrow(WireParseError);
  });
});
