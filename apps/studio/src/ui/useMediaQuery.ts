import { useSyncExternalStore } from 'react';

/** A phone, as the design defines it (handoff 3.5): narrower than 600 px. */
export const PHONE_QUERY = '(max-width: 599px)';

/** Whether a media query matches now, following changes. False where matchMedia is unavailable (tests, old browsers). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window.matchMedia !== 'function') return () => {};
      const m = window.matchMedia(query);
      m.addEventListener?.('change', cb);
      return () => m.removeEventListener?.('change', cb);
    },
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  );
}
