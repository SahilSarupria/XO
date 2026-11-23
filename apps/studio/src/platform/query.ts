import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import type { Result } from './client';
import type { LoadState } from '../ui/primitives';

const loadedValue = <T>(s: LoadState<T>): T | undefined => (s.phase === 'ready' ? s.value : s.phase === 'error' ? s.stale : undefined);

/**
 * S1-3 (plan 6.5): one cache of platform reads per signed-in session, with no dependency.
 *
 * - **Keyed reads.** A read is named by a key (`ws/<id>/runs`). Every screen that asks for the same key shares one entry, so
 *   Home, Activity and a workflow's panel show the same runs and update together.
 * - **Stale while revalidate.** A screen that opens shows what is already known for its key at once and asks again in the
 *   background; a failed refresh keeps the last good value as `stale` (never "empty"). A different key never borrows another
 *   key's value (a value loaded for another analysis must not stand in for this one).
 * - **One request in flight per key.** Asking again while a request is out waits for that request.
 * - **Invalidation by prefix.** After a change (a start, a decision), `invalidate('ws/<id>/')` asks again for every key of the
 *   workspace that a screen is showing; keys no screen shows are dropped, so they are read fresh when next shown.
 * - **Shared pollers.** However many screens poll a key, one timer runs, at the shortest interval asked for, and it pauses
 *   while the tab is hidden (and catches up when it is shown again).
 * - **Cancellation.** A screen that closes stops listening; an answer that arrives later still fills the cache but is shown to
 *   no one. (The client has no abort; the request itself is not cut off.)
 * Reads only: nothing here sends a change, and the platform still decides everything.
 */
const LOADING: LoadState<never> = { phase: 'loading' };

interface Entry {
  state: LoadState<unknown>;
  fetcher?: () => Promise<Result<unknown>>;
  inflight?: Promise<void>;
  readonly listeners: Set<() => void>;
  readonly polls: Map<number, number>; // interval -> how many screens ask for it
  timer?: ReturnType<typeof setInterval>;
  timerMs?: number;
}

export class QueryCache {
  private readonly entries = new Map<string, Entry>();
  private hidden = false;
  private readonly onVisibility = () => {
    const was = this.hidden;
    this.hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    for (const [key, e] of this.entries) {
      this.schedule(key, e);
      if (was && !this.hidden && e.polls.size > 0) void this.revalidate(key);
    }
  };
  constructor() {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
  }

  private entry(key: string): Entry {
    let e = this.entries.get(key);
    if (e === undefined) {
      e = { state: LOADING, listeners: new Set(), polls: new Map() };
      this.entries.set(key, e);
    }
    return e;
  }

  state<T>(key: string): LoadState<T> {
    return (this.entries.get(key)?.state ?? LOADING) as LoadState<T>;
  }

  subscribe(key: string, listener: () => void): () => void {
    const e = this.entry(key);
    e.listeners.add(listener);
    return () => {
      e.listeners.delete(listener);
    };
  }

  setFetcher<T>(key: string, fetcher: () => Promise<Result<T>>): void {
    this.entry(key).fetcher = fetcher as () => Promise<Result<unknown>>;
  }

  /** Asks the platform again for `key` (one request at a time); resolves when the answer is in the cache. */
  revalidate(key: string): Promise<void> {
    const e = this.entry(key);
    if (e.inflight !== undefined) return e.inflight;
    const fetcher = e.fetcher;
    if (fetcher === undefined) return Promise.resolve();
    const p = fetcher()
      .then(
        (r) => {
          const stale = loadedValue(e.state);
          e.state = r.ok
            ? { phase: 'ready', value: r.value }
            : { phase: 'error', problem: r.problem, ...(stale !== undefined ? { stale } : {}) };
        },
        () => {
          /* the client returns failures as values; a thrown error leaves the entry as it was */
        },
      )
      .finally(() => {
        e.inflight = undefined;
        e.listeners.forEach((l) => l());
      });
    e.inflight = p;
    return p;
  }

  /** Asks again for every shown key that starts with `prefix`; forgets the ones no screen shows. */
  invalidate(prefix: string): void {
    for (const [key, e] of [...this.entries]) {
      if (!key.startsWith(prefix)) continue;
      if (e.listeners.size > 0) void this.revalidate(key);
      else if (e.inflight === undefined && e.polls.size === 0) this.entries.delete(key);
    }
  }

  /** A screen asks for `key` to be read every `ms`; returns the function that withdraws the request. */
  poll(key: string, ms: number): () => void {
    const e = this.entry(key);
    e.polls.set(ms, (e.polls.get(ms) ?? 0) + 1);
    this.schedule(key, e);
    return () => {
      const n = (e.polls.get(ms) ?? 1) - 1;
      if (n <= 0) e.polls.delete(ms);
      else e.polls.set(ms, n);
      this.schedule(key, e);
    };
  }

  private schedule(key: string, e: Entry): void {
    const want = this.hidden || e.polls.size === 0 ? undefined : Math.min(...e.polls.keys());
    if (want === e.timerMs) return;
    if (e.timer !== undefined) clearInterval(e.timer);
    e.timer = undefined;
    e.timerMs = want;
    if (want !== undefined) e.timer = setInterval(() => void this.revalidate(key), want);
  }

  /** Stops every timer (sign-out). */
  dispose(): void {
    for (const e of this.entries.values()) if (e.timer !== undefined) clearInterval(e.timer);
    this.entries.clear();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
  }
}

export const QueryContext = createContext<QueryCache | undefined>(undefined);

/**
 * Reads `key` through the session's cache: the same `{ state, reload }` as `useLoad`. `key` names the inputs, so two screens
 * with the same key must ask the same question. Outside a session (a screen rendered alone) a private cache is used.
 */
export function useQuery<T>(
  key: string,
  fn: () => Promise<Result<T>>,
  opts: { pollMs?: number } = {},
): { state: LoadState<T>; reload: () => void } {
  const shared = useContext(QueryContext);
  const own = useRef<QueryCache | undefined>(undefined);
  if (shared === undefined && own.current === undefined) own.current = new QueryCache();
  const cache = shared ?? own.current!;
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const state = useSyncExternalStore(
    (cb) => cache.subscribe(key, cb),
    () => cache.state<T>(key),
  );
  useEffect(() => {
    cache.setFetcher(key, () => fnRef.current());
    void cache.revalidate(key);
  }, [cache, key]);
  const pollMs = opts.pollMs;
  useEffect(() => (pollMs !== undefined && pollMs > 0 ? cache.poll(key, pollMs) : undefined), [cache, key, pollMs]);
  return { state, reload: () => void cache.revalidate(key) };
}

export const useQueryCache = (): QueryCache | undefined => useContext(QueryContext);

/** The cache key of one workspace's read: `ws/<id>/<what>`. `wsKey(ws, '')` is the prefix of all of them. */
export const wsKey = (ws: string, what: string): string => `ws/${encodeURIComponent(ws)}/${what}`;
