// S1-2: the live journeys (plan section 4), run against a REAL Studio and API seeded by seed.mjs. Each journey is a list of
// steps a person takes; a step either runs (and, at a checkpoint, is screenshotted and checked with axe) or is recorded as
// `todo` with the PR that will make it possible, so the report always shows how much of each journey Studio can do today.
// Selectors come from roles and labels, never CSS classes, so a restyle does not break them.
//
// Failures are kept apart (lib/classify.mjs): the app never loading is infrastructure; a step that does not work in a Studio
// that is up is a regression of that step, with a screenshot of the page at that moment, and the journey carries on.
import { readFileSync } from 'node:fs';
import { FunctionalFailure, InfraError, newContext, shoot } from './lib/browser.mjs';
import { SYNTHETIC, TIMEOUTS } from './visual.config.mjs';

const wait = { timeout: TIMEOUTS.uiMs };
const KNOWN_A11Y = JSON.parse(readFileSync(new URL('./a11y-known.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------------------------------------------------------- helpers

const quietInbox = new WeakSet();

async function settle(page) {
  const idle = () =>
    page.waitForFunction(() => document.querySelector('.spinner, .skeleton, .k-skeleton, [aria-busy="true"]') === null, undefined, wait);
  await idle();
  await page.waitForLoadState('networkidle', wait);
  await idle();
}

async function expectVisible(page, locator, what) {
  try {
    await locator.first().waitFor({ state: 'visible', ...wait });
  } catch {
    const up =
      (await page
        .locator('#root > *')
        .count()
        .catch(() => 0)) > 0;
    throw up ? new FunctionalFailure(`${what} did not appear.`) : new InfraError(`Studio did not load (${what} was never shown).`);
  }
}

/** Signs in with an access key and opens the named workspace (or stays on the first-workspace screen when there is none). */
async function signIn(page, baseUrl, key, workspaceName) {
  // S1-3: Studio keeps one long request open per workspace to keep the Inbox live (it waits up to 25 s for a change). The
  // network never goes idle while it waits, so here it is refused; Studio then backs off for 5 s, which lets each screen settle.
  if (!quietInbox.has(page)) {
    quietInbox.add(page);
    await page.route('**/api/workspaces/*/control/inbox/changes*', (route) => route.abort('failed'));
  }
  await page.goto(`${baseUrl}/`, { waitUntil: 'load', timeout: TIMEOUTS.uiMs });
  const field = page.locator('#api-key');
  try {
    await field.waitFor({ state: 'visible', ...wait });
  } catch {
    throw new InfraError('Studio did not show its sign-in screen.');
  }
  await field.fill(key); // tracing is never enabled, so this value is not recorded anywhere
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  if (workspaceName === undefined) return;
  const chooser = page.getByRole('button', { name: 'Open workspace' });
  // S1-3: a page's h1 is its place ("Home"); the workspace's name is on the sidebar card (in the drawer on a phone).
  const heading = page.getByRole('heading', { level: 1, name: 'Home' });
  await Promise.race([chooser.waitFor({ state: 'visible', ...wait }), heading.waitFor({ state: 'visible', ...wait })]).catch(() => {
    throw new InfraError(`Sign-in did not lead to the workspace "${workspaceName}".`);
  });
  if (await chooser.isVisible()) {
    await page.getByText(workspaceName, { exact: true }).first().click();
    await chooser.click();
  }
  await expectVisible(page, heading, `The workspace "${workspaceName}"`);
  if ((await page.locator('.ws-name', { hasText: workspaceName }).count()) === 0)
    throw new FunctionalFailure(`The open workspace is not "${workspaceName}".`);
  await settle(page);
}

/** S1-3: the old screen names the journeys use, as a place and, when it is not the place's first view, a tab. */
const PLACE = {
  Home: ['Home'],
  Inbox: ['Inbox'],
  Workflows: ['Work'],
  Work: ['Work'],
  Library: ['Work', 'Library'],
  Sources: ['Sources'],
  Documents: ['Sources', 'Documents and rules'],
  Connect: ['Sources', 'Connections'],
  Knowledge: ['Knowledge'],
  Activity: ['Activity'],
  'Audit log': ['Activity', 'Audit log'],
  Settings: ['Settings'],
};
const BOTTOM = new Set(['Home', 'Inbox', 'Work', 'Activity']);

/** The sidebar on a desktop; on a phone the bottom bar, or More (the drawer) for the other places. Then the tab, if any. */
async function nav(page, viewport, label) {
  const [place, tab] = PLACE[label] ?? [label];
  const name = new RegExp(`^${place}(?![A-Za-z])`);
  if (viewport === 'mobile' && BOTTOM.has(place)) {
    await page.getByRole('navigation', { name: 'Main places' }).getByRole('button', { name }).click();
  } else {
    if (viewport === 'mobile' && (await page.locator('#sidebar[data-open="true"]').count()) === 0)
      await page.getByRole('navigation', { name: 'Main places' }).getByRole('button', { name: 'More' }).click();
    await page.getByRole('navigation', { name: 'Workspace sections' }).getByRole('button', { name }).first().click();
  }
  await settle(page);
  if (tab !== undefined) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await settle(page);
  }
}

async function settings(page, viewport, tab) {
  await nav(page, viewport, 'Settings');
  if (tab !== undefined) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await settle(page);
  }
}

/** axe on the page as it is: serious and critical WCAG 2.2 AA findings. Known ones (a11y-known.json) are reported, not failed. */
async function a11y(page, axeSource, id) {
  // Evaluated, not added as a script tag: Studio's Content Security Policy refuses inline scripts, as it should.
  if ((await page.evaluate(() => typeof window.axe)) === 'undefined') await page.evaluate(axeSource);
  const result = await page.evaluate(async () => {
    const r = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      resultTypes: ['violations'],
    });
    return r.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
  });
  const known = new Set(KNOWN_A11Y[id.replace(/^(desktop|mobile)\//, '')] ?? []);
  return { fresh: result.filter((v) => !known.has(v.id)), known: result.filter((v) => known.has(v.id)) };
}

// Playwright wraps parts of its error text in ANSI colour codes; they must not reach reports.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const firstLine = (text) => String(text).replace(ANSI, '').split('\n')[0];

/**
 * One journey, at one viewport. `step` runs a step and, when `shot` is set, takes the checkpoint screenshot and runs axe on it;
 * `todo` records a step Studio cannot do yet, naming the PR that enables it.
 */
function journey(rec, viewport, page, axeSource) {
  return {
    async step(name, fn, { shot = true, fullPage = false } = {}) {
      const id = `${viewport}/${name}`;
      try {
        await fn();
        if (!shot) {
          rec.passed(viewport, name);
          return true;
        }
        await settle(page);
        const { fresh, known } = await a11y(page, axeSource, id);
        rec.accessibility(
          id,
          known.map((v) => v.id),
        );
        if (fresh.length > 0)
          throw new FunctionalFailure(
            `Accessibility: ${fresh.map((v) => `${v.id} (${v.nodes.join(', ')})`).join('; ')}. Fix it, or, for a screen not yet rebuilt, list the rule in visual/a11y-known.json with the PR that fixes it.`,
          );
        rec.submit(viewport, name, await shoot(page, { fullPage }));
        return true;
      } catch (e) {
        const expected = e instanceof FunctionalFailure || e?.name === 'TimeoutError';
        if (!expected) throw e;
        const alive =
          (await page
            .locator('#root > *')
            .count()
            .catch(() => 0)) > 0;
        if (!alive) throw new InfraError(`Studio stopped responding during "${id}": ${firstLine(e.message)}`);
        rec.functionalFailure(
          viewport,
          name,
          e instanceof FunctionalFailure ? e.message : firstLine(e.message),
          await shoot(page).catch(() => undefined),
        );
        return false;
      }
    },
    todo(name, enabledBy, what) {
      rec.todo(viewport, name, enabledBy, what);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------- journeys

/** J1. First day: from nothing to a first approved batch (operator, then reviewer). */
async function j1(browser, ctx, viewport, rec) {
  // Steps 1–4 on a new account with no workspace; steps 5–12 in the seeded workspace.
  {
    const context = await newContext(browser, viewport);
    const page = await context.newPage();
    const j = journey(rec, viewport, page, ctx.axeSource);
    try {
      await j.step('j1-01-sign-in', async () => {
        await page.goto(`${ctx.baseUrl}/`, { waitUntil: 'load' });
        await expectVisible(page, page.locator('#api-key'), 'The sign-in form');
        await expectVisible(page, page.getByText('Development sign-in', { exact: false }), 'The development sign-in label');
      });
      await j.step('j1-02-first-workspace', async () => {
        await page.locator('#api-key').fill(ctx.keys.newcomer[viewport]);
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await expectVisible(page, page.getByLabel('Workspace name'), 'The first-workspace form');
      });
      await j.step('j1-03-home-next-step', async () => {
        await page.getByLabel('Workspace name').fill(SYNTHETIC.emptyWorkspaceName);
        await page.getByRole('button', { name: 'Create workspace' }).click();
        await expectVisible(page, page.getByRole('heading', { level: 1, name: 'Home' }), 'The new workspace');
        await expectVisible(page, page.getByRole('region', { name: 'Start work' }), 'The one next step on Home');
      });
      // Connect a folder in the screen and say whether XO has it right (the seeded workspace has this done already).
      await j.step('j1-04-sources-findings', async () => {
        await nav(page, viewport, 'Connect');
        await page.getByRole('button', { name: 'Connect a server folder' }).click();
        await page.getByLabel('Folder path on the XO server').fill(ctx.folderPath);
        await page.getByRole('button', { name: 'Connect folder', exact: true }).click();
        const found = page.getByRole('region', { name: 'What XO found' });
        await expectVisible(page, found, 'What XO found in the folder');
        for (let i = 0; i < 6; i += 1) {
          const yes = found.getByRole('button', { name: 'Yes, that is right' }).first();
          if ((await yes.count()) === 0) break;
          await yes.click();
          await page.waitForTimeout(300);
        }
        await expectVisible(page, found.getByText('You have answered everything XO found here.'), 'Every finding answered');
      });
      // The other half of Sources: documents. A new workspace has none yet, and says what to do.
      await j.step('j1-04a-documents-empty', async () => {
        await nav(page, viewport, 'Documents');
        await expectVisible(page, page.getByRole('heading', { name: 'Documents' }), 'The Documents screen');
        await expectVisible(page, page.getByText('Drop documents here'), 'The drop zone');
        await expectVisible(page, page.getByText('No documents yet'), 'The empty state');
      });
    } finally {
      await context.close();
    }
  }
  const context = await newContext(browser, viewport);
  const page = await context.newPage();
  const j = journey(rec, viewport, page, ctx.axeSource);
  try {
    await signIn(page, ctx.baseUrl, ctx.keys.operator, SYNTHETIC.workspaceName);
    await j.step('j1-05-workflow-proposed', async () => {
      await nav(page, viewport, 'Workflows');
      const list = page.getByRole('list', { name: 'Your workflows' });
      await expectVisible(page, list, 'The list of workflows');
      await expectVisible(page, list.getByRole('link', { name: SYNTHETIC.sendWorkflowName }), 'The proposed workflow, named from its goal');
    });
    await j.step('j1-06-send-setup', async () => {
      await page.getByRole('list', { name: 'Your workflows' }).getByRole('link', { name: SYNTHETIC.sendWorkflowName }).click();
      await expectVisible(page, page.getByRole('heading', { level: 1, name: SYNTHETIC.sendWorkflowName }), 'The workflow page');
      await page.getByRole('tab', { name: 'Setup' }).click();
      await expectVisible(page, page.getByRole('heading', { name: 'Sending email' }), 'The send set-up');
      await expectVisible(page, page.getByLabel('Who it goes to'), 'Where the address comes from');
    });
    await j.step(
      'j1-07-check-before-starting',
      async () => {
        await page.getByRole('tab', { name: 'Schedule and approvals' }).click();
        await page.getByRole('button', { name: /check before starting|check again/i }).click();
        await expectVisible(page, page.getByRole('list', { name: 'What was checked' }), 'The result of the check');
      },
      { fullPage: false },
    );
    await j.step('j1-08-preview', async () => {
      await nav(page, viewport, 'Workflows');
      await page.getByRole('list', { name: 'Your workflows' }).getByRole('link', { name: SYNTHETIC.sendWorkflowName }).click();
      await page.getByRole('button', { name: 'Start this workflow' }).click();
      // The workflow sends, so it prepares a preview for a person; if XO has more than one list it asks which first.
      const pick = page.getByRole('button', { name: /^Use .* in /i }).first();
      await pick.waitFor({ timeout: 20000 }).catch(() => undefined);
      if (await pick.isVisible()) await pick.click();
      await expectVisible(page, page.getByText(/nothing was sent/i).first(), 'The preview was prepared and nothing was sent');
    });
    await j.step('j1-09-ask-for-approval', async () => {
      await nav(page, viewport, 'Inbox');
      // On a phone the Inbox opens on its list; open the batch to read it.
      if (viewport === 'mobile')
        await page
          .getByRole('list', { name: 'Waiting for a person' })
          .getByText(/items$/)
          .first()
          .click();
      await expectVisible(
        page,
        page.getByRole('group', { name: 'Batch to approve' }).or(page.locator('[aria-label="Batch to approve"]')).first(),
        'The batch waiting for a reviewer',
      );
      await expectVisible(
        page,
        page.getByText(/need(s)? a look before you approve|Nothing needs a look/).first(),
        'What needs a look, first',
      );
    });
    await j.step('j1-10-reviewer-approves', async () => {
      await nav(page, viewport, 'Inbox');
      // On a phone this may already be open from the step before; click it only where it is on screen.
      const row = page.getByRole('list', { name: 'Waiting for a person' }).getByText('Email the client their document: 3 items').first();
      if (await row.isVisible()) await row.click();
      await expectVisible(page, page.getByText(/would send/).first(), 'The summary comes first');
      await page.getByRole('button', { name: 'Approve this batch' }).click();
      await page.getByRole('button', { name: /^Yes, approve 3 items$/ }).click();
      await expectVisible(page, page.getByText(/Approved\. It is recorded as your signed decision/).first(), 'The approval is recorded');
    });
    await j.step('j1-11-run-shows-at-once', async () => {
      // The seed started this workflow; its page says so at once.
      await nav(page, viewport, 'Workflows');
      await page.getByRole('list', { name: 'Your workflows' }).getByRole('link', { name: SYNTHETIC.checkWorkflowName }).click();
      await expectVisible(page, page.getByText('One decision waits for a person in the Inbox.'), 'The run waiting for a person');
    });
    await j.step('j1-12-evidence', async () => {
      await page.keyboard.press('Escape');
      await nav(page, viewport, 'Activity');
      const runs = page.getByRole('list', { name: 'Runs' });
      await expectVisible(page, runs, 'The list of runs');
      await runs.getByRole('button', { name: 'Show results' }).first().click();
      await expectVisible(page, page.getByRole('region', { name: 'Why XO did this' }), 'The evidence for the run');
    });
    await j.step('j1-13-run-page', async () => {
      // A run opens on its own page, with its results already shown, and a way back.
      await page.getByRole('list', { name: 'Runs' }).locator('h3 button').first().click();
      await expectVisible(page, page.getByRole('button', { name: 'Back to Activity' }), 'The run page');
      await expectVisible(page, page.getByRole('region', { name: 'Why XO did this' }), 'The results on the run page');
      await page.getByRole('button', { name: 'Back to Activity' }).click();
      await expectVisible(page, page.getByRole('list', { name: 'Runs' }), 'Back on the list of runs');
    });
    await j.step('j1-14-knowledge', async () => {
      // What XO knows and the records are one place with two tabs.
      await nav(page, viewport, 'Knowledge');
      await expectVisible(page, page.getByRole('tab', { name: 'What XO knows' }), 'The first tab');
      await expectVisible(page, page.getByRole('tab', { name: 'Records' }), 'The second tab');
    });
  } finally {
    await context.close();
  }
}

/** J2. A normal day (reviewer on a phone): open the Inbox, decide a step. */
async function j2(browser, ctx, viewport, rec) {
  const context = await newContext(browser, viewport);
  const page = await context.newPage();
  const j = journey(rec, viewport, page, ctx.axeSource);
  try {
    await signIn(page, ctx.baseUrl, ctx.keys.reviewer, SYNTHETIC.workspaceName);
    await j.step('j2-01-inbox', async () => {
      await nav(page, viewport, 'Inbox');
      await expectVisible(page, page.getByRole('region', { name: 'Inbox', exact: true }), 'The Inbox');
      await expectVisible(page, page.getByText(/Check the overnight messages/).first(), 'The step waiting for a person');
    });
    await j.step('j2-02-approve-batch', async () => {
      // The reviewer's whole job took the summary, one tap and one confirmation; what is left is starting what was approved.
      await nav(page, viewport, 'Inbox');
      await expectVisible(page, page.getByText(/ready to start/).first(), 'The approved batch, ready to start');
    });
    // The two sizes share one workspace, so the one decision is made at phone size (the last run) and desktop leaves it waiting.
    if (viewport === 'mobile') {
      await j.step('j2-03-mark-done', async () => {
        await nav(page, viewport, 'Inbox');
        // On a phone the list comes first; opening an item shows its detail with a way back.
        await page
          .getByRole('list', { name: 'Waiting for a person' })
          .getByText(/Check the overnight messages/)
          .first()
          .click();
        await expectVisible(page, page.getByRole('button', { name: 'Back to the Inbox' }), 'The way back to the list');
        await page.getByLabel('A note (optional)').fill('Looked at them all');
        await page.getByRole('button', { name: 'Mark done' }).click();
        await expectVisible(page, page.getByText(/Marked done\./), 'The recorded outcome');
      });
    }
  } finally {
    await context.close();
  }
}

/** J4. Recurring work: choose how often a workflow starts, then switch it off again so the other journeys stay as they are. */
async function j4(browser, ctx, viewport, rec) {
  const context = await newContext(browser, viewport);
  const page = await context.newPage();
  const j = journey(rec, viewport, page, ctx.axeSource);
  try {
    await signIn(page, ctx.baseUrl, ctx.keys.operator, SYNTHETIC.workspaceName);
    await j.step('j4-01-schedule', async () => {
      await nav(page, viewport, 'Workflows');
      await page.getByRole('list', { name: 'Your workflows' }).getByRole('link', { name: SYNTHETIC.sendWorkflowName }).click();
      await page.getByRole('tab', { name: 'Schedule and approvals' }).click();
      await page.getByRole('radio', { name: 'Every week' }).check();
      await page.getByRole('button', { name: 'Save' }).click();
      await expectVisible(page, page.getByText(/^Done\. Every 7 days/), 'The schedule is saved');
    });
    await j.step('j4-02-off-again', async () => {
      await page.getByRole('radio', { name: 'Only when someone starts it' }).check();
      await page.getByRole('button', { name: 'Save' }).click();
      await expectVisible(page, page.getByText('Done. It will only start when someone starts it.'), 'The schedule is off');
    });
  } finally {
    await context.close();
  }
}

/** J6. Invite a colleague: the operator makes a link for the reviewer role; the colleague signs in, opens it and joins; the link shows as used. */
async function j6(browser, ctx, viewport, rec) {
  const context = await newContext(browser, viewport);
  const page = await context.newPage();
  const j = journey(rec, viewport, page, ctx.axeSource);
  let link;
  try {
    await signIn(page, ctx.baseUrl, ctx.keys.operator, SYNTHETIC.workspaceName);
    await j.step('j6-01-make-link', async () => {
      await settings(page, viewport, 'Members');
      await page.getByLabel('What they can do').selectOption('reviewer');
      await page.getByRole('button', { name: 'Make an invitation link' }).click();
      const shown = page.getByTestId('invite-link');
      await expectVisible(page, shown, 'The link is shown once');
      link = (await shown.textContent()) ?? '';
    });
    const guest = await newContext(browser, viewport);
    const gp = await guest.newPage();
    const gj = journey(rec, viewport, gp, ctx.axeSource);
    try {
      await gj.step('j6-02-join', async () => {
        const url = new URL(link.trim());
        await gp.route('**/api/workspaces/*/control/inbox/changes*', (route) => route.abort('failed'));
        await gp.goto(`${ctx.baseUrl}${url.pathname}${url.hash}`, { waitUntil: 'load', timeout: TIMEOUTS.uiMs });
        await gp.locator('#api-key').fill(ctx.keys.joiner[viewport]);
        await gp.getByRole('button', { name: 'Continue', exact: true }).click();
        await gp.getByRole('button', { name: 'Join this workspace' }).click();
        await expectVisible(gp, gp.getByText(/You have joined\./), 'The colleague joined');
        await gp.getByRole('button', { name: 'Open the workspace' }).click();
        await expectVisible(gp, gp.getByRole('heading', { level: 1, name: 'Home' }), 'They land in the workspace');
      });
    } finally {
      await guest.close();
    }
    await j.step('j6-03-link-used', async () => {
      await nav(page, viewport, 'Home');
      await settings(page, viewport, 'Members');
      await expectVisible(
        page,
        page
          .getByRole('list', { name: 'Invitations' })
          .getByText(/Reviewer: Used/)
          .first(),
        'The link shows as used',
      );
    });
  } finally {
    await context.close();
  }
}

/** J5. Stop everything (administrator): stop, see it, release. */
async function j5(browser, ctx, viewport, rec) {
  const context = await newContext(browser, viewport);
  const page = await context.newPage();
  const j = journey(rec, viewport, page, ctx.axeSource);
  try {
    await signIn(page, ctx.baseUrl, ctx.keys.operator, SYNTHETIC.workspaceName);
    await j.step('j5-01-operations', async () => {
      await settings(page, viewport, 'Operations');
      await expectVisible(page, page.getByRole('group', { name: 'Stop something' }), 'The emergency stop form');
    });
    await j.step('j5-02-stop', async () => {
      const group = page.getByRole('group', { name: 'Stop something' });
      await group.getByLabel('What to stop').selectOption('connector');
      // Picked from what is set up, never typed.
      await group.getByLabel('Which connection').selectOption('mail');
      await group.getByLabel('Why (optional)').fill('Checking the stop');
      await group.getByRole('button', { name: 'Stop it' }).click();
      await page.getByRole('group', { name: 'Confirm' }).getByRole('button', { name: 'Yes, stop it' }).click();
      await expectVisible(page, page.getByText('Stopped: mail.').first(), 'The stop is recorded');
    });
    await j.step('j5-03-banner-everywhere', async () => {
      await nav(page, viewport, 'Home');
      await expectVisible(page, page.getByText('Some work is stopped'), 'The banner on Home');
      await nav(page, viewport, 'Inbox');
      await expectVisible(page, page.getByText('Some work is stopped'), 'The banner on the Inbox');
    });
    await j.step('j5-04-release', async () => {
      await settings(page, viewport, 'Operations');
      await page.getByRole('button', { name: 'Release' }).first().click();
      await page.getByRole('group', { name: 'Confirm' }).getByRole('button', { name: 'Yes, release it' }).click();
      await expectVisible(page, page.getByText('Nothing is stopped.'), 'The list is empty again');
      await nav(page, viewport, 'Home');
      await page.getByText('Some work is stopped').waitFor({ state: 'detached', timeout: 15000 });
    });
  } finally {
    await context.close();
  }
}

/** J7. Something went wrong: the API cannot be reached; the API is a version this Studio does not support. The rest arrives with S1-11. */
async function j7(browser, ctx, viewport, rec) {
  const context = await newContext(browser, viewport);
  const page = await context.newPage();
  const j = journey(rec, viewport, page, ctx.axeSource);
  try {
    await signIn(page, ctx.baseUrl, ctx.keys.operator, SYNTHETIC.workspaceName);
    await j.step('j7-01-unreachable', async () => {
      await page.route('**/api/**', (route) => route.abort('connectionrefused'));
      await nav(page, viewport, 'Activity');
      await expectVisible(page, page.getByText(/could not|cannot reach|could not be loaded/i), 'A message that XO cannot be reached');
      if ((await page.getByText('Nothing has been run yet').count()) > 0)
        throw new FunctionalFailure('Activity claimed nothing has been run while XO could not be reached.');
      await page.unroute('**/api/**');
    });
    await j.step('j7-02-version', async () => {
      await page.unroute('**/api/**');
      // An API this Studio does not support: a calm full-screen message instead of screens failing oddly (S1-3).
      await page.route('**/api/version', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ version: '9.0.0', features: { connect: true, googleSignIn: false, oidc: false, passwordSignIn: false } }),
        }),
      );
      await signIn(page, ctx.baseUrl, ctx.keys.operator);
      await expectVisible(page, page.getByRole('heading', { level: 1, name: 'XO is being updated' }), 'The version message');
      await expectVisible(page, page.getByText(/needs XO 0\.1, and the service reports 9\.0\.0/), 'What the administrator needs to know');
      await page.unroute('**/api/version');
    });
    j.todo('j7-03-session-expired', 'S1-11', 'A silent refresh, or "Sign in again" with the screen kept.');
    j.todo('j7-04-denied', 'S1-11', 'A refused action says who can do it.');
  } finally {
    await context.close();
  }
}

/**
 * J8. Ask XO from anywhere: the box works on Home, in Work and in Activity, understands "open …" without a model, and says
 * plainly when there is nothing to show. (From a workflow's own page arrives with S1-5.)
 */
async function askBox(page, text) {
  const box = page.getByRole('textbox', { name: 'Ask XO' }).first();
  await box.fill(text);
  await box.press('Enter');
  const panel = page.getByRole('dialog', { name: 'Ask XO conversation' });
  await panel.waitFor();
  return panel;
}

async function j8(browser, ctx, viewport, rec) {
  const context = await newContext(browser, viewport);
  const page = await context.newPage();
  const j = journey(rec, viewport, page, ctx.axeSource);
  try {
    await signIn(page, ctx.baseUrl, ctx.keys.operator, SYNTHETIC.workspaceName);
    await j.step('j8-01-ask-from-home', async () => {
      const panel = await askBox(page, 'Open the Inbox');
      await expectVisible(page, panel.getByRole('button', { name: 'Open Inbox' }), 'The "Open Inbox" card');
    });
    await page.getByRole('dialog', { name: 'Ask XO conversation' }).getByRole('button', { name: 'Open Inbox' }).click();
    await settle(page);
    await j.step('j8-02-ask-from-activity', async () => {
      await nav(page, viewport, 'Activity');
      const panel = await askBox(page, 'Show the run that failed');
      await expectVisible(page, panel.getByText('No run has failed.'), 'The plain answer that no run has failed');
    });
    j.todo(
      'j8-03-ask-from-workflow-page',
      'S1-5',
      'Ask about this workflow from its own page: the box names the workflow and the answer is about it.',
    );
  } finally {
    await context.close();
  }
}

/** Journeys with no step Studio can do yet: recorded so the report shows the whole plan. */
function notYet(rec, viewport) {
  rec.todo(
    viewport,
    'j3-unknown-outcome',
    'S1-7',
    'An unknown send outcome: what XO checked, and "It was sent / It was not sent / Cannot tell" with a reason.',
  );
}

/**
 * Runs every journey at both sizes. `keys` = { operator, reviewer, newcomer } synthetic access keys; they are only typed into
 * the page. `axeSource` is the axe-core script injected for the accessibility checks.
 */
export async function runJourneys({ chromium, baseUrl, keys, recorder, axeSource, folderPath }) {
  // XO_VISUAL_CHROMIUM: a local Chrome for trying the journeys outside the pinned container. Screenshots taken with it are not
  // comparable with the approved references (fonts and rendering differ); CI never sets it.
  const browser = await chromium.launch(process.env.XO_VISUAL_CHROMIUM ? { executablePath: process.env.XO_VISUAL_CHROMIUM } : {});
  const ctx = { baseUrl, keys, axeSource, folderPath };
  try {
    for (const viewport of ['desktop', 'mobile']) {
      await j1(browser, ctx, viewport, recorder);
      await j2(browser, ctx, viewport, recorder);
      notYet(recorder, viewport);
      await j4(browser, ctx, viewport, recorder);
      await j5(browser, ctx, viewport, recorder);
      await j6(browser, ctx, viewport, recorder);
      await j7(browser, ctx, viewport, recorder);
      await j8(browser, ctx, viewport, recorder);
    }
    return { chromiumVersion: browser.version() };
  } finally {
    await browser.close();
  }
}
