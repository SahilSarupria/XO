import { describe, expect, it } from 'vitest';
import {
  buildTree,
  effectsSentence,
  readSummary,
  removalSentences,
  selectionSummary,
  stateView,
  toggleNode,
  triState,
  visibleActions,
} from '../../src/domain/connect';
import type { FolderEntry, ReadReport } from '../../src/platform/wire-connect';

const f = (key: string, acquirable = true, size = 10): FolderEntry => ({
  key,
  name: key.split('/').pop() as string,
  extension: '.txt',
  sizeBytes: size,
  modifiedAt: '2026-11-01T00:00:00.000Z',
  depth: key.split('/').length - 1,
  contentAcquirable: acquirable,
});
const report = (over: Partial<ReadReport> = {}): ReadReport => ({
  requested: 3,
  read: 3,
  unreadable: 0,
  skipped: { notIncluded: 0, notAcquirable: 0, vanished: 0 },
  status: 'complete',
  errorCodes: [],
  evidence: 'retained',
  retired: 0,
  ...over,
});

describe('connect wording is true', () => {
  it('never says XO learned something from a read; says whether it was kept and how much was understood', () => {
    const s = readSummary(report({ notUnderstood: 3, assertionsAdded: 0 }));
    expect(s).toMatch(/XO kept what it read/);
    expect(s).toMatch(/3 items kept but not understood yet: only structured organizational records become knowledge today/);
    expect(s).not.toMatch(/learned/i);
    expect(readSummary(report({ evidence: 'not_retained' }))).toMatch(/did not keep/);
    expect(readSummary(report({ status: 'failed' }))).toMatch(/Nothing new was kept/);
    expect(readSummary(report({ retired: 1 }))).toMatch(/1 item was deleted or changed and retired\./);
    expect(readSummary(report({ retired: 2 }))).toMatch(/2 items were deleted or changed and retired\./);
  });

  it('disconnect and narrowing say what is kept; nothing claims removal', () => {
    for (const futureReads of ['stopped', 'narrowed'] as const)
      expect(effectsSentence({ futureReads, existingKnowledge: 'kept', platformAuthorization: 'unchanged' })).toMatch(
        /already learned is kept|already learned is kept/,
      );
    expect(effectsSentence({ futureReads: 'stopped', existingKnowledge: 'kept', platformAuthorization: 'unchanged' })).toMatch(
      /nothing in your folder was changed/,
    );
  });

  it('removal makes no claim about facts other sources may support', () => {
    const text = removalSentences({ evidenceItems: 4, factDependencies: 'not_available' }).join(' ');
    expect(text).toMatch(/4 pieces of evidence/);
    expect(text).toMatch(/Your files are not touched/);
    expect(text).toMatch(/makes no claim about facts that other sources may also support/);
    expect(text).not.toMatch(/disappear|immediately|right away/i);
  });

  it('expired and ended access never claim a cause or a removal; both keep earlier knowledge', () => {
    for (const state of ['access_expired', 'access_ended'] as const) {
      const v = stateView({ state });
      expect(v.summary).toMatch(/Earlier knowledge is kept and may be out of date/);
      expect(v.summary).not.toMatch(/removed|deleted/i);
      expect(v.actions).not.toContain('read');
    }
  });
});

describe('actions follow capabilities', () => {
  const caps = (manageSources: boolean) => ({ viewSources: true, manageSources, readKnowledge: true, reviewKnowledge: false });
  it('offers nothing that changes anything without manage capability, or when capabilities are unknown', () => {
    const v = stateView({ state: 'read_complete' });
    expect(visibleActions(v, caps(false))).toEqual([]);
    expect(visibleActions(v, undefined)).toEqual([]);
    expect(visibleActions(v, caps(true))).toContain('remove');
  });
  it('a disconnected source can only be reconnected or removed', () => {
    expect(stateView({ state: 'disconnected' }).actions).toEqual(['reconnect', 'remove']);
  });
});

describe('selection tree', () => {
  const entries = [f('a.txt'), f('docs/b.txt'), f('docs/c.txt'), f('docs/img.png', false), f('docs/deep/d.txt')];
  const tree = buildTree(entries);
  it('groups by folder and is sorted deterministically', () => {
    expect(tree.files.map((x) => x.key)).toEqual(['a.txt']);
    expect(tree.folders.map((x) => x.path)).toEqual(['docs']);
    expect(tree.folders[0]?.folders.map((x) => x.path)).toEqual(['docs/deep']);
  });
  it('tri-state counts only readable files; toggling a folder selects and clears all of them', () => {
    const docs = tree.folders[0]!;
    expect(triState(docs, new Set())).toBe('none');
    const some = new Set(['docs/b.txt']);
    expect(triState(docs, some)).toBe('some');
    const all = toggleNode(docs, some);
    expect([...all].sort()).toEqual(['docs/b.txt', 'docs/c.txt', 'docs/deep/d.txt']);
    expect(all.has('docs/img.png')).toBe(false);
    expect(triState(docs, all)).toBe('all');
    expect(toggleNode(docs, all).size).toBe(0);
  });
  it('summarises the chosen set', () => {
    expect(selectionSummary(entries, new Set(['a.txt', 'docs/b.txt']))).toEqual({ files: 2, bytes: 20 });
  });
});
