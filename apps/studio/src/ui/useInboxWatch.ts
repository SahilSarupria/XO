import { useEffect, useRef } from 'react';
import { useQueryCache, wsKey } from '../platform/query';
import { useSession } from './session';

/**
 * S1-3: the one long request that keeps a workspace's inbox live (it replaces one loop per screen). It waits on the platform
 * until the inbox differs from `etag` (the tag of what is shown), then refreshes the inbox key for every screen showing it.
 * It sleeps while the tab is hidden, backs off for 5 s after a failure, and stops when the workspace closes (a late answer is
 * ignored). A server that answers at once is asked at most every 2 s. With no tag (an older platform, or nothing loaded yet) it
 * does nothing.
 */
export function useInboxWatch(ws: string, etag: string | undefined): void {
  const { client } = useSession();
  const cache = useQueryCache();
  const tagRef = useRef(etag);
  tagRef.current = etag;
  const live = etag !== undefined;
  useEffect(() => {
    if (!live) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      });
    void (async () => {
      while (!stopped) {
        const tag = tagRef.current;
        if (tag === undefined || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) {
          await sleep(tag === undefined ? 200 : 1000);
          continue;
        }
        const asked = Date.now();
        const r = await client.inboxChanges(ws, tag, 25);
        if (stopped) return;
        // A server that answers at once instead of waiting is not asked again sooner than every 2 s.
        const quick = Date.now() - asked < 2000;
        if (!r.ok) {
          await sleep(5000);
          continue;
        }
        if (r.value.changed && r.value.etag !== tagRef.current) {
          tagRef.current = r.value.etag;
          cache?.invalidate(wsKey(ws, 'control-inbox'));
        } else if (quick) await sleep(2000);
      }
    })();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, cache, ws, live]);
}
