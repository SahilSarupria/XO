import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  // Contract tests run in a plain Node environment (no DOM) against the real API; there is nothing to reset there.
  if (typeof window === 'undefined') return;
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  // Each test starts at the root: Studio's addresses are paths (S1-3), so a path left by one test must not choose the next test's screen.
  window.history.replaceState(null, '', '/');
});
