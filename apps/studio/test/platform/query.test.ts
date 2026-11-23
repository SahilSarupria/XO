/** S1-3 — the session's read cache: one request in flight per key, stale while revalidate, prefix invalidation, shared pollers. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryCache, wsKey } from '../../src/platform/query';
import type { Result } from '../../src/platform/client';

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const bad = (): Result<never> => ({ ok: false, problem: { kind: 'network', message: 'down' } });

describe('QueryCache', () => {
  let cache: QueryCache;
  beforeEach(() => {
    cache = new QueryCache();
  });
  afterEach(() => {
    cache.dispose();
    vi.useRealTimers();
  });

  it('asks once while a request is in flight, however many screens ask', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    cache.setFetcher('k', async () => {
      calls += 1;
      await gate;
      return ok(1);
    });
    const a = cache.revalidate('k');
    const b = cache.revalidate('k');
    release();
    await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(cache.state('k')).toEqual({ phase: 'ready', value: 1 });
  });

  it('keeps the last good value as stale when a refresh fails, and never borrows another key', async () => {
    let n = 0;
    cache.setFetcher('a', async () => (++n === 1 ? ok('first') : bad()));
    await cache.revalidate('a');
    await cache.revalidate('a');
    expect(cache.state('a')).toMatchObject({ phase: 'error', stale: 'first' });
    expect(cache.state('b')).toEqual({ phase: 'loading' });
  });

  it('invalidating a prefix asks again for shown keys only, and forgets the rest', async () => {
    const asked: string[] = [];
    for (const k of [wsKey('w1', 'runs'), wsKey('w1', 'sources'), wsKey('w2', 'runs')])
      cache.setFetcher(k, async () => {
        asked.push(k);
        return ok(k);
      });
    const stop = cache.subscribe(wsKey('w1', 'runs'), () => {});
    await Promise.all([
      cache.revalidate(wsKey('w1', 'runs')),
      cache.revalidate(wsKey('w1', 'sources')),
      cache.revalidate(wsKey('w2', 'runs')),
    ]);
    asked.length = 0;
    cache.invalidate(wsKey('w1', ''));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual([wsKey('w1', 'runs')]);
    expect(cache.state(wsKey('w1', 'sources'))).toEqual({ phase: 'loading' }); // forgotten: read fresh when next shown
    expect(cache.state(wsKey('w2', 'runs'))).toMatchObject({ phase: 'ready' }); // another workspace is untouched
    stop();
  });

  it('runs one timer per key at the shortest interval asked for, pauses while the tab is hidden, and stops when withdrawn', async () => {
    vi.useFakeTimers();
    let calls = 0;
    cache.setFetcher('p', async () => {
      calls += 1;
      return ok(calls);
    });
    const a = cache.poll('p', 1000);
    const b = cache.poll('p', 500);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2); // every 500 ms, not both intervals
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(2);
    hidden.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(3); // catches up when shown again
    b();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(4);
    a();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(4);
  });
});
