import { createRequire } from 'node:module';
import { EXPECTED_PLAYWRIGHT_VERSION, VIEWPORTS } from '../visual.config.mjs';

/**
 * Loads the pinned Playwright library (CommonJS resolution, so a global or local install both work) and refuses to run
 * against any other version: baselines are only comparable when the browser build is the one they were made with.
 */
export function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const { chromium } = require('playwright');
  const { version } = require('playwright/package.json');
  if (version !== EXPECTED_PLAYWRIGHT_VERSION) {
    throw new InfraError(`Playwright ${version} is installed but ${EXPECTED_PLAYWRIGHT_VERSION} is required (see visual.config.mjs).`);
  }
  return { chromium, version };
}

/** A problem with the environment or services, never with the UI under test. */
export class InfraError extends Error {}

/** A page that loaded but did not behave as expected (a heading is missing, Escape did not close the menu, ...). */
export class FunctionalFailure extends Error {}

// Dates come from the server's real clock, so they differ on every run. Studio formats them with
// Date#toLocaleString({ dateStyle, timeStyle }); this test-side shim pins that one call to a fixed string so layouts stay
// identical without masking regions. It changes nothing in the product and nothing else on the page.
const DATE_SHIM = () => {
  const original = Date.prototype.toLocaleString;
  Date.prototype.toLocaleString = function (locales, options) {
    if (options && options.dateStyle) return 'Jan 1, 2000, 12:00 PM';
    return original.call(this, locales, options);
  };
};

export async function newContext(browser, viewportName) {
  const viewport = VIEWPORTS[viewportName];
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    isMobile: viewportName === 'mobile',
    hasTouch: viewportName === 'mobile',
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  await context.addInitScript(DATE_SHIM);
  return context;
}

/** One screenshot, with everything that can wobble switched off. Returns PNG bytes. */
export async function shoot(page, { fullPage = false } = {}) {
  await page.evaluate(() => document.fonts.ready);
  return page.screenshot({ type: 'png', fullPage, animations: 'disabled', caret: 'hide', scale: 'css' });
}
