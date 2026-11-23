import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll } from 'vitest';
import { cleanup } from '@testing-library/react';
import { initTheme } from '../src/ui/theme';
import { preloadScreens } from '../src/ui/lazyScreen';
import '../src/ui/screens';

afterEach(() => {
  // Contract tests run in a plain Node environment (no DOM) against the real API; there is nothing to reset there.
  if (typeof window === 'undefined') return;
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  // The theme starts at its default (dark, D-18) for the next test.
  initTheme();
  // Each test starts at the root: Studio's addresses are paths (S1-3), so a path left by one test must not choose the next test's screen.
  window.history.replaceState(null, '', '/');
});

if (typeof window !== 'undefined') initTheme();

// S1-3: screens are lazy chunks in the app; tests load them all first, so a screen renders as soon as it is chosen.
beforeAll(async () => {
  if (typeof window !== 'undefined') await preloadScreens();
});
