import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'xo.studio.theme';
const listeners = new Set<() => void>();

function stored(): Theme {
  try {
    return window.localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}
let current: Theme = 'dark';

function apply(t: Theme): void {
  document.documentElement.dataset['theme'] = t;
  document.documentElement.style.colorScheme = t;
}

/** Called once at start-up: reads the saved choice (a convenience; storage may be unavailable) and applies it. */
export function initTheme(): void {
  current = stored();
  apply(current);
}

export function setTheme(t: Theme): void {
  current = t;
  apply(t);
  try {
    window.localStorage.setItem(KEY, t);
  } catch {
    /* the choice then lasts for this session only */
  }
  listeners.forEach((l) => l());
}

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
