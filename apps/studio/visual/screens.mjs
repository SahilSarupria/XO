// The established Studio screens, captured against a REAL running Studio and API. Selectors come from the product's own
// roles and labels (headings, the "Menu" button, the nav buttons), never from CSS classes, so a restyle does not break them.
//
// Two kinds of failure are kept apart on purpose:
//   InfraError         the page never loaded / sign-in failed: the suite could not do its job
//   FunctionalFailure  the app loaded but a screen did not appear or a control did not work: a regression
import { FunctionalFailure, InfraError, newContext, shoot } from './lib/browser.mjs';
import { SYNTHETIC, TIMEOUTS, VIEWPORTS } from './visual.config.mjs';

const wait = { timeout: TIMEOUTS.uiMs };

const heading = (page, name, level = 2) => page.getByRole('heading', { level, name, exact: true });

async function settle(page) {
  const idle = () => page.waitForFunction(() => document.querySelector('.spinner') === null, undefined, wait);
  await idle();
  await page.waitForLoadState('networkidle', wait);
  await idle();
}

/** Waits for a piece of UI. If it is missing but the app shell is up, that is a regression; if the app never loaded, infra. */
async function expectVisible(page, locator, what) {
  try {
    await locator.waitFor({ state: 'visible', ...wait });
  } catch {
    const shellUp = (await page.locator('.app').count()) > 0;
    throw shellUp ? new FunctionalFailure(`${what} did not appear.`) : new InfraError(`Studio did not load (${what} was never shown).`);
  }
}

async function signIn(page, baseUrl, key) {
  await page.goto(`${baseUrl}/#/home`, { waitUntil: 'load', timeout: TIMEOUTS.uiMs });
  const field = page.locator('#api-key');
  try {
    await field.waitFor({ state: 'visible', ...wait });
  } catch {
    throw new InfraError('Studio did not show its sign-in screen.');
  }
  await field.fill(key); // tracing is never enabled, so this value is not recorded anywhere
  await page.getByRole('button', { name: 'Connect' }).click();
  try {
    await page.locator('.app').waitFor({ state: 'visible', ...wait });
  } catch {
    throw new InfraError('Sign-in with the synthetic access key was not accepted.');
  }
}

async function openDrawer(page) {
  // Idempotent: if an earlier screen failed with the drawer open, clicking Menu again would close it.
  if ((await page.locator('#sidebar[data-open="true"]').count()) === 0) await page.getByRole('button', { name: 'Menu' }).click();
  await expectVisible(page, page.locator('#sidebar[data-open="true"]'), 'The navigation drawer');
}

async function closeDrawerWithEscape(page) {
  await page.keyboard.press('Escape');
  try {
    await page.locator('#sidebar[data-open="false"]').waitFor({ state: 'attached', ...wait });
  } catch {
    throw new FunctionalFailure('Escape did not close the navigation drawer.');
  }
}

async function goTo(page, viewport, label, pageHeading) {
  if (viewport === 'mobile') await openDrawer(page);
  await page.getByRole('button', { name: new RegExp(`^${label}(?![A-Za-z])`) }).click();
  await expectVisible(page, pageHeading, `The ${label} screen`);
  await settle(page);
}

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

async function firstRun(browser, baseUrl, keys, rec) {
  const context = await newContext(browser, 'desktop');
  const page = await context.newPage();
  try {
    await signIn(page, baseUrl, keys.empty);
    await screen(rec, 'desktop', 'first-run', page, async () => {
      await expectVisible(page, heading(page, 'Start with a workspace', 3), 'The first-run workspace prompt');
      await settle(page);
      rec.submit('desktop', 'first-run', await shoot(page));
    });
    await screen(rec, 'desktop', 'home-empty', page, async () => {
      await page.locator('#ws-name').fill(SYNTHETIC.emptyWorkspaceName);
      await page.getByRole('button', { name: 'Create workspace' }).click();
      await expectVisible(page, heading(page, 'Home'), 'The Home screen of a new workspace');
      await expectVisible(page, heading(page, 'Get started in four steps', 3), 'The getting-started panel');
      await settle(page);
      rec.submit('desktop', 'home-empty', await shoot(page));
    });
  } finally {
    await context.close();
  }
}

async function populated(browser, baseUrl, keys, viewport, rec) {
  const mobile = viewport === 'mobile';
  const context = await newContext(browser, viewport);
  const page = await context.newPage();
  try {
    await signIn(page, baseUrl, keys.demo);
    await expectVisible(page, heading(page, SYNTHETIC.workspaceName, 1), 'The seeded workspace');
    await expectVisible(page, heading(page, 'Home'), 'The Home screen');
    await settle(page);

    await screen(rec, viewport, 'home', page, async () => rec.submit(viewport, 'home', await shoot(page)));

    if (mobile) {
      await screen(rec, viewport, 'drawer-open', page, async () => {
        await openDrawer(page);
        rec.submit(viewport, 'drawer-open', await shoot(page));
        await closeDrawerWithEscape(page);
      });
    }

    await screen(rec, viewport, 'work', page, async () => {
      await goTo(page, viewport, 'Work', heading(page, 'Work'));
      rec.submit(viewport, 'work', await shoot(page));
    });
    await screen(rec, viewport, 'work-detail', page, async () => {
      await page.getByText('What each step is based on').first().click();
      await settle(page);
      rec.submit(viewport, 'work-detail', await shoot(page, { fullPage: true }));
    });

    await screen(rec, viewport, 'tasks', page, async () => {
      await goTo(page, viewport, 'Tasks', heading(page, 'Tasks'));
      rec.submit(viewport, 'tasks', await shoot(page));
    });

    // Browser history keeps the person's place (the section lives in the URL fragment).
    await screen(rec, viewport, 'history', page, async () => {
      await page.goBack();
      await expectVisible(page, heading(page, 'Work'), 'Back to Work');
      await page.goForward();
      await expectVisible(page, heading(page, 'Tasks'), 'Forward to Tasks');
    });

    if (!mobile) {
      await screen(rec, viewport, 'activity', page, async () => {
        await goTo(page, viewport, 'Activity', heading(page, 'Activity'));
        rec.submit(viewport, 'activity', await shoot(page));
      });
      await screen(rec, viewport, 'setup-documents', page, async () => {
        await goTo(page, viewport, 'Setup', heading(page, 'Context'));
        rec.submit(viewport, 'setup-documents', await shoot(page));
      });
      await screen(rec, viewport, 'setup-rules', page, async () => {
        await page.getByRole('button', { name: /^Rules(?![A-Za-z])/ }).click();
        await expectVisible(page, heading(page, 'Review'), 'The Review screen');
        await settle(page);
        rec.submit(viewport, 'setup-rules', await shoot(page));
      });
    }
  } finally {
    await context.close();
  }
}

/** Captures every established screen. `keys` = { demo, empty } synthetic access keys; they are only ever typed into the page. */
export async function captureAll({ chromium, baseUrl, keys, recorder }) {
  const browser = await chromium.launch();
  try {
    await firstRun(browser, baseUrl, keys, recorder);
    for (const viewport of Object.keys(VIEWPORTS)) await populated(browser, baseUrl, keys, viewport, recorder);
    return { chromiumVersion: browser.version() };
  } finally {
    await browser.close();
  }
}
