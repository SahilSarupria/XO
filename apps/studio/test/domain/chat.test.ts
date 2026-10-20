import { describe, expect, it } from 'vitest';
import { chatReply, matchXos, mentionQuery, threadTitle } from '../../src/domain/chat';
import { documentLabel, xoItems } from '../../src/domain/xo';
import type { Compilation, Source } from '../../src/platform/wire';

const none = { documents: undefined, analyses: undefined, processes: undefined, runs: undefined };

describe('chatReply', () => {
  it('states only counts that loaded, and says nothing is known while loading', () => {
    expect(chatReply('give me a summary', none).text).toMatch(/not finished loading/i);
    const r = chatReply('what do i have', { documents: 1, analyses: 2, processes: undefined, runs: 0 });
    expect(r.text).toBe('This workspace holds 1 document, 2 analyses, 0 recorded runs.');
  });

  it('points at real screens and never claims to have done anything', () => {
    expect(chatReply('show me the graph', none).action?.target).toBe('graph');
    expect(chatReply('build an xo', none).action?.target).toBe('create');
    expect(chatReply('what is waiting for me', none).action?.target).toBe('tasks');
    for (const q of ['hello', 'compile this', 'run it', 'approve everything']) {
      expect(chatReply(q, none).text).not.toMatch(/\b(i (have )?(compiled|ran|approved|added|started|created))\b/i);
    }
  });

  it('says plainly that attachments are not read', () => {
    expect(chatReply('hello', none, ['burglary-policy']).text).toMatch(/does not read them/i);
  });
});

describe('thread titles and mentions', () => {
  it('shortens long first messages and collapses whitespace', () => {
    expect(threadTitle('  Compile   this  ')).toBe('Compile this');
    expect(threadTitle('x'.repeat(60))).toHaveLength(36);
  });
  it('finds an @-word at the end of the text only', () => {
    expect(mentionQuery('hello @bur')).toBe('bur');
    expect(mentionQuery('@')).toBe('');
    expect(mentionQuery('mail me@x.com now')).toBeUndefined();
    expect(matchXos([{ label: 'Burglary-policy' }, { label: 'tax' }], 'burg')).toHaveLength(1);
  });
});

describe('xoItems', () => {
  const src = (id: string, name: string): Source => ({ sourceId: id, originalFilename: name, mediaType: 'application/pdf', byteSize: 1, digestSha256: 'x', createdAt: '2026-10-01T00:00:00Z' });
  const comp = (id: string, sourceId: string, status: Compilation['status'], at: string): Compilation => ({ compilationId: id, sourceId, sourceDigestSha256: 'x', status, createdAt: at });
  it('names each XO after its document, newest first, succeeded analyses only', () => {
    const items = xoItems(
      [comp('c1', 's1', 'succeeded', '2026-10-01T00:00:00Z'), comp('c2', 's2', 'failed', '2026-10-02T00:00:00Z'), comp('c3', 's2', 'succeeded', '2026-10-03T00:00:00Z')],
      [src('s1', 'burglary-policy.pdf'), src('s2', 'claims-sop.docx')],
    );
    expect(items.map((i) => i.label)).toEqual(['claims-sop', 'burglary-policy']);
    expect(documentLabel('noext')).toBe('noext');
  });
});
