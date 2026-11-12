import { describe, expect, it } from 'vitest';
import { chatHint, groupByDay, matchXos, mentionQuery } from '../../src/domain/chat';
import { documentLabel, xoItems } from '../../src/domain/xo';
import type { Compilation, Source } from '../../src/platform/wire';

describe('thread grouping and mentions', () => {
  const t = (id: string, updatedAt: string) => ({ threadId: id, title: id, updatedAt, messageCount: 0 });
  it('groups threads by local day, newest first: Today, Yesterday, then the date', () => {
    const now = new Date(2026, 9, 28, 12, 0, 0);
    const g = groupByDay(
      [
        t('old', new Date(2026, 9, 1, 9).toISOString()),
        t('y', new Date(2026, 9, 27, 9).toISOString()),
        t('a', new Date(2026, 9, 28, 8).toISOString()),
        t('b', new Date(2026, 9, 28, 11).toISOString()),
      ],
      now,
    );
    expect(g.map((x) => x.label).slice(0, 2)).toEqual(['Today', 'Yesterday']);
    expect(g[0]!.threads.map((x) => x.threadId)).toEqual(['b', 'a']);
    expect(g).toHaveLength(3);
  });
  it('maps the chat refusals that have a next step', () => {
    expect(chatHint({ status: 412 })).toBe('settings');
    expect(chatHint({ status: 502 })).toBe('nothing_saved');
    expect(chatHint({ status: 404 })).toBe('gone');
    expect(chatHint({ status: 500 })).toBeUndefined();
  });
  it('finds an @-word at the end of the text only', () => {
    expect(mentionQuery('hello @bur')).toBe('bur');
    expect(mentionQuery('@')).toBe('');
    expect(mentionQuery('mail me@x.com now')).toBeUndefined();
    expect(matchXos([{ label: 'Burglary-policy' }, { label: 'tax' }], 'burg')).toHaveLength(1);
  });
});

describe('xoItems', () => {
  const src = (id: string, name: string): Source => ({
    sourceId: id,
    originalFilename: name,
    mediaType: 'application/pdf',
    byteSize: 1,
    digestSha256: 'x',
    createdAt: '2026-10-01T00:00:00Z',
  });
  const comp = (id: string, sourceId: string, status: Compilation['status'], at: string): Compilation => ({
    compilationId: id,
    sourceId,
    sourceDigestSha256: 'x',
    status,
    createdAt: at,
  });
  it('names each XO after its document, newest first, succeeded analyses only', () => {
    const items = xoItems(
      [
        comp('c1', 's1', 'succeeded', '2026-10-01T00:00:00Z'),
        comp('c2', 's2', 'failed', '2026-10-02T00:00:00Z'),
        comp('c3', 's2', 'succeeded', '2026-10-03T00:00:00Z'),
      ],
      [src('s1', 'burglary-policy.pdf'), src('s2', 'claims-sop.docx')],
    );
    expect(items.map((i) => i.label)).toEqual(['claims-sop', 'burglary-policy']);
    expect(documentLabel('noext')).toBe('noext');
  });
});
