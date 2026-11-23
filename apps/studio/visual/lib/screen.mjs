// One screen of the self-test (selftest.mjs): a missing control in a page that is up is a failure of that screen, with a
// screenshot; a page that is gone is an infrastructure failure. The journeys use the same rule (journeys.mjs, step()).
import { FunctionalFailure, InfraError, shoot } from './browser.mjs';

/**
 * Runs one screen. A control or screen that is missing in a Studio that is up is recorded as a failure of THAT screen (with a
 * screenshot of what was on the page) and the run carries on, so one broken screen cannot hide the others. If the page itself
 * is gone, nothing after it can be trusted, so that stays an infrastructure failure.
 */
export async function screen(rec, viewport, name, page, fn) {
  try {
    await fn();
  } catch (e) {
    const missing = e instanceof FunctionalFailure || e?.name === 'TimeoutError';
    if (!missing) throw e;
    const alive =
      (await page
        .locator('.app, #api-key')
        .count()
        .catch(() => 0)) > 0;
    if (!alive) throw new InfraError(`Studio stopped responding during "${viewport}/${name}": ${firstLine(e.message)}`);
    const shot = await shoot(page).catch(() => undefined);
    const detail = e instanceof FunctionalFailure ? e.message : `A control or screen was not found in time. ${describeTimeout(e.message)}`;
    rec.functionalFailure(viewport, name, detail, shot);
  }
}

// Playwright wraps parts of its error text in ANSI colour codes (ESC [ ... m); they must not reach reports or be parsed around.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (text) => String(text).replace(ANSI, '');

const firstLine = (text) => plain(text).split('\n')[0];

/** "locator.click: Timeout 20000ms exceeded." plus what it was waiting for, without the rest of Playwright's call log. */
function describeTimeout(message) {
  const lines = plain(message)
    .split('\n')
    .map((l) => l.trim());
  const waiting = lines.find((l) => l.startsWith('- waiting for'));
  return [lines[0], waiting === undefined ? undefined : waiting.replace(/^- /, '')].filter(Boolean).join(' ');
}
