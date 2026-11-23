import { useSyncExternalStore } from 'react';

/**
 * The person's theme choice. "system" (the default) follows the device's light or dark setting and changes with it; the other
 * two fix it. The choice is a convenience kept in local storage, which may be unavailable; the applied theme is always
 * `light` or `dark` on <html data-theme>.
 */
export type Theme = 'system' | 'light' | 'dark';
export type AppliedTheme = 'light' | 'dark';
const KEY = 'xo.studio.theme';
const listeners = new Set<() => void>();

function stored(): Theme {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}
let current: Theme = 'system';
let query: MediaQueryList | undefined;

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function appliedTheme(t: Theme = current): AppliedTheme {
  return t === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : t;
}

function apply(): void {
  const t = appliedTheme();
  document.documentElement.dataset['theme'] = t;
  document.documentElement.style.colorScheme = t;
}

/** Called once at start-up: reads the saved choice, applies it, and follows the device while the choice is "system". */
export function initTheme(): void {
  current = stored();
  apply();
  if (query === undefined && typeof window.matchMedia === 'function') {
    query = window.matchMedia('(prefers-color-scheme: dark)');
    query.addEventListener?.('change', () => {
      if (current !== 'system') return;
      apply();
      listeners.forEach((l) => l());
    });
  }
}

export function setTheme(t: Theme): void {
  current = t;
  apply();
  try {
    if (t === 'system') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, t);
  } catch {
    /* the choice then lasts for this session only */
  }
  listeners.forEach((l) => l());
}

/** The choice and a setter; `appliedTheme()` says which one is showing. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const t = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
  return [t, setTheme];
}
