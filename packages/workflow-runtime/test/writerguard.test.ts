import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { WriterLockedError, acquireWriterLock } from '../src/index.js';

const dir = (): Promise<string> => mkdtemp(join(tmpdir(), 'xo-wg-'));

describe('single-writer guard', () => {
  it('a second live writer on the same host is refused, naming the holder; release lets the next in', async () => {
    const d = await dir();
    const a = await acquireWriterLock(d, { pid: 111, host: 'h', isAlive: () => true });
    await assert.rejects(
      acquireWriterLock(d, { pid: 222, host: 'h', isAlive: () => true }),
      (e: Error) => e instanceof WriterLockedError && /pid 111 on this host/.test(e.message),
    );
    await a.release();
    const b = await acquireWriterLock(d, { pid: 222, host: 'h', isAlive: () => true });
    await b.release();
  });
  it('the same process asking again is the same writer; its extra release does not drop the first hold', async () => {
    const d = await dir();
    const a = await acquireWriterLock(d, { pid: 5, host: 'h', isAlive: () => true });
    const again = await acquireWriterLock(d, { pid: 5, host: 'h', isAlive: () => true });
    await again.release();
    await assert.rejects(acquireWriterLock(d, { pid: 6, host: 'h', isAlive: () => true }), WriterLockedError);
    await a.release();
  });
  it('a lock whose holder is gone is taken over; one held by another host never is; garbage is refused, not overwritten', async () => {
    const d = await dir();
    await acquireWriterLock(d, { pid: 111, host: 'h', isAlive: () => true }); // never released: the holder "crashed"
    const taken = await acquireWriterLock(d, { pid: 222, host: 'h', isAlive: (p) => p !== 111 });
    assert.equal(JSON.parse(await readFile(join(d, '.xo-writer.lock'), 'utf8')).pid, 222);
    await taken.release();
    const other = await dir();
    await acquireWriterLock(other, { pid: 1, host: 'elsewhere' });
    await assert.rejects(acquireWriterLock(other, { pid: 2, host: 'h', isAlive: () => false }), /another host|host "elsewhere"/);
    const bad = await dir();
    await writeFile(join(bad, '.xo-writer.lock'), 'not json');
    await assert.rejects(acquireWriterLock(bad, { pid: 2, host: 'h' }), /unreadable writer lock/);
    await writeFile(join(bad, '.xo-writer.lock'), '{"pid":"x"}');
    await assert.rejects(acquireWriterLock(bad, { pid: 2, host: 'h' }), /malformed/);
  });
  it('release never removes a lock that is not ours, and racing acquirers admit exactly one', async () => {
    const d = await dir();
    const a = await acquireWriterLock(d, { pid: 1, host: 'h', isAlive: () => true });
    await writeFile(join(d, '.xo-writer.lock'), JSON.stringify({ pid: 9, host: 'h', startedAt: 'x' }));
    await a.release();
    assert.equal(JSON.parse(await readFile(join(d, '.xo-writer.lock'), 'utf8')).pid, 9);
    const r = await dir();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => acquireWriterLock(r, { pid: 100 + i, host: 'h', isAlive: () => true })),
    );
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  });
});
