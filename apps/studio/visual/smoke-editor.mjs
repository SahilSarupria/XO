#!/usr/bin/env node
// Real-browser smoke for the workflow editor, against a REAL API and the production Studio build on throw-away data:
//   edit a step -> add a step -> platform validates -> save -> Run draft -> test case (add, run, platform verdict).
// It asserts only what the platform answers; nothing is mocked. It never modifies the repository.
//
//   node apps/studio/visual/smoke-editor.mjs [--skip-build] [--out <dir>]
// Browser: Playwright's Chromium by default. Set XO_SMOKE_CHROMIUM=<path> (and optionally XO_SMOKE_CHROMIUM_ARGS='["--no-sandbox"]')
// to use another Chromium build when Playwright's download is not reachable.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './lib/browser.mjs';
import { SYNTHETIC, TIMEOUTS } from './visual.config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const out = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : mkdtempSync(join(tmpdir(), 'xo-smoke-out-')));
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'xo-smoke-'));
const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? work, LANG: 'C.UTF-8', TZ: 'UTC', TMPDIR: work };
const children = [];
const steps = [];
let pending; // detail for the step currently running
const log = (s) => console.log(s);

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
const sh = (label, cmd, a, opts = {}) => {
  log(`> ${label}`);
  const r = spawnSync(cmd, a, { cwd: root, env, encoding: 'utf8', timeout: 600_000, ...opts });
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status})\n${(r.stdout ?? '') + (r.stderr ?? '')}`.slice(-1500));
  return r.stdout ?? '';
};
const start = (cmd, a, opts) => {
  const c = spawn(cmd, a, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  c.stdout.resume();
  c.stderr.resume();
  children.push(c);
  return c;
};
const up = async (url) => {
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} did not come up`);
};

let browser;
let page;
try {
  const { chromium } = loadPlaywright();
  if (!skipBuild) {
    sh('build-api', 'npx', ['tsc', '-b', 'apps/api/tsconfig.json']);
    sh('build-studio', 'npx', ['vite', 'build', '--outDir', join(work, 'studio-dist'), '--emptyOutDir'], {
      cwd: join(root, 'apps/studio'),
    });
  }
  const [apiPort, studioPort] = [await freePort(), await freePort()];
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const studioUrl = `http://127.0.0.1:${studioPort}`;
  const dataEnv = {
    API_KEYS_DIR: join(work, 'keys'),
    WORKSPACES_DIR: join(work, 'workspaces'),
    WORKSPACE_DATA_DIR: join(work, 'workspace-data'),
  };
  const keyText = sh('issue-key', 'npm', [
    'run',
    '--silent',
    'keys',
    '-w',
    '@xo/api',
    '--',
    'issue',
    SYNTHETIC.demoIdentity,
    '--kind',
    'human',
    '--dir',
    dataEnv.API_KEYS_DIR,
  ]);
  const key = /xoak_[A-Za-z0-9_-]+/.exec(keyText)?.[0];
  if (key === undefined) throw new Error('no key issued');
  start(process.execPath, ['run-api.mjs'], {
    cwd: join(root, 'apps/api'),
    env: { ...env, ...dataEnv, PORT: String(apiPort), HOST: '127.0.0.1' },
  });
  await up(`${apiUrl}/health`);
  sh('seed', process.execPath, ['--import', 'tsx', 'visual/seed.mjs'], {
    cwd: join(root, 'apps/studio'),
    env: { ...env, XO_API_URL: apiUrl, XO_API_KEY: key, XO_FIXTURE_PDF: join(root, SYNTHETIC.fixturePdf) },
  });
  start(
    'npx',
    ['vite', 'preview', '--outDir', join(work, 'studio-dist'), '--host', '127.0.0.1', '--port', String(studioPort), '--strictPort'],
    {
      cwd: join(root, 'apps/studio'),
      env: { ...env, XO_API_URL: apiUrl },
    },
  );
  await up(`${studioUrl}/api/health`);

  const exe = process.env.XO_SMOKE_CHROMIUM;
  browser = await chromium.launch({
    ...(exe ? { executablePath: exe } : {}),
    args: process.env.XO_SMOKE_CHROMIUM_ARGS ? JSON.parse(process.env.XO_SMOKE_CHROMIUM_ARGS) : [],
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'en-US', serviceWorkers: 'block' });
  context.setDefaultTimeout(TIMEOUTS.uiMs);
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const step = async (name, fn) => {
    try {
      pending = undefined;
      await fn();
      steps.push({ name, ok: true, ...(pending !== undefined ? { detail: pending } : {}) });
      log(`  ok   ${name}`);
    } catch (e) {
      steps.push({ name, ok: false, error: String(e.message ?? e).split('\n')[0] });
      log(`  FAIL ${name}: ${String(e.message ?? e).split('\n')[0]}`);
      await page.screenshot({ path: join(out, `fail-${steps.length}.png`), fullPage: true }).catch(() => undefined);
      throw e;
    }
  };
  const shot = (n) => page.screenshot({ path: join(out, `${n}.png`), fullPage: true });
  const graph = () => page.getByRole('region', { name: 'Workflow graph' });
  const inspector = () => page.getByRole('complementary', { name: 'Inspector' });
  const palette = () => page.getByRole('complementary', { name: 'Node palette' });
  const draft = () => page.getByRole('region', { name: 'Draft' });

  await step('sign in and open the workflow graph', async () => {
    await page.goto(`${studioUrl}/#/home`, { waitUntil: 'load' });
    await page.locator('#api-key').fill(key);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.locator('.app').waitFor();
    await page.getByRole('button', { name: 'Workflows', exact: true }).click();
    // Open the first process that is not waiting on approvals (the seed approved its rules; others may not be).
    const count = await page.getByRole('button', { name: /view graph of/i }).count();
    let opened = false;
    for (let i = 0; i < count && !opened; i++) {
      await page
        .getByRole('button', { name: /view graph of/i })
        .nth(i)
        .click();
      await graph().waitFor();
      opened = (await page.getByText('Needs approval', { exact: true }).count()) === 0;
      if (!opened)
        await page
          .getByRole('link', { name: 'Workflows' })
          .or(page.getByRole('button', { name: /^Workflows$/ }))
          .first()
          .click();
    }
    if (!opened) throw new Error('every process still needs approval');
    await palette().getByRole('button', { name: 'Branch on confidence' }).waitFor(); // the platform has said what it can run
    await shot('1-editor');
  });

  await step('the palette offers only what the platform reports, and says why for the rest', async () => {
    const text = await palette().innerText();
    for (const needle of ['There is no scheduler', 'no folder or drop watcher', 'no webhook or email delivery'])
      if (!text.includes(needle)) throw new Error(`palette lacks "${needle}"`);
    if ((await palette().getByRole('button', { name: 'Schedule' }).getAttribute('aria-disabled')) !== 'true')
      throw new Error('Schedule should be disabled');
  });

  await step('edit: relabel a step; the platform keeps validating', async () => {
    const first = graph().getByRole('list', { name: 'Steps in the draft' }).getByRole('button').nth(1);
    await first.click();
    await inspector().getByLabel('Label').fill('Smoke-checked step');
    await graph()
      .getByRole('button', { name: /^Smoke-checked step/ })
      .waitFor();
    await draft().getByText('The platform found no structural problems.').waitFor();
  });

  await step(
    'edit: an invalid addition is refused by the platform with its reason, on the node it names; removing it clears the problem',
    async () => {
      await palette().getByRole('button', { name: 'Person reviews' }).click(); // added after the selected step; a review may not follow a review
      const reasons = draft().getByRole('list', { name: 'Reasons this draft cannot run' });
      await reasons.waitFor();
      pending = (await reasons.innerText()).replace(/\s+/g, ' ');
      if (!(await draft().getByRole('button', { name: 'Run draft' }).isDisabled()))
        throw new Error('Run draft must be disabled while the platform says it cannot run');
      await shot('2a-refused');
      await inspector().getByRole('button', { name: 'Remove step' }).click();
      await draft()
        .getByText(/the platform says this draft can run/i)
        .waitFor();
      await shot('2b-fixed');
    },
  );

  await step('save the draft', async () => {
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText(/Saved as revision 1/).waitFor();
    await graph().getByText('Saved', { exact: true }).waitFor();
  });

  await step('the platform says the saved draft can run', async () => {
    await draft()
      .getByText(/the platform says this draft can run/i)
      .waitFor();
    if (!(await draft().getByRole('button', { name: 'Run draft' }).isEnabled()))
      throw new Error('Run draft should be enabled when saved and runnable');
  });

  await step('Run draft: the platform runs it (or refuses in its own words)', async () => {
    const json = draft().getByLabel('Input (JSON object)');
    if (await json.count()) await json.fill('{}');
    // Fill any generated contract fields with plausible values; the platform checks them either way.
    for (const f of await draft().locator('input[id^="wf-run-"]').all()) {
      const label = (
        await draft()
          .locator(`label[for="${await f.getAttribute('id')}"]`)
          .innerText()
      ).toLowerCase();
      await f.fill(label.includes('number') ? '1200' : 'smoke value');
    }
    await draft().getByRole('button', { name: 'Run draft' }).click();
    const started = draft().getByText(/^Run started:/);
    const refused = draft().getByLabel('What the platform said');
    await Promise.race([started.waitFor(), refused.waitFor()]);
    const refusal = (await refused.count()) ? await refused.innerText() : undefined;
    pending = refusal ?? (await started.innerText());
    await shot('3-run-draft');
    if (refusal !== undefined) throw new Error(`the platform refused: ${refusal}`);
  });

  await step('the run is listed in the existing Executions tab', async () => {
    await page
      .getByRole('button', { name: /^Executions$/ })
      .or(page.getByRole('tab', { name: /^Executions$/ }))
      .first()
      .click();
    await page.getByText('Runs', { exact: true }).waitFor();
    // The seeded process already has a run; the draft run we just started makes it at least two.
    const runs = page.getByRole('button', { name: /^Run [0-9a-f]{6}/ });
    await runs.nth(1).waitFor();
    pending = `${await runs.count()} runs listed, newest: ${(await runs.first().innerText()).replace(/\s+/g, ' ')}`;
    await shot('4-executions');
  });

  await step('test case: add, run, show the platform verdict', async () => {
    // The workflow screen is full-width; leave it through the breadcrumb to get the sidebar back.
    await page
      .getByRole('link', { name: 'Workflows' })
      .or(page.getByRole('button', { name: /^Workflows$/ }))
      .first()
      .click();
    await page.getByRole('button', { name: 'Workspace menu' }).click();
    await page.getByRole('menuitemradio', { name: 'Builder mode' }).click();
    await page.getByRole('button', { name: /^My XOs/ }).click();
    await page.getByRole('button', { name: /^contracts/i }).click();
    const list = page.getByRole('list', { name: 'Capability contracts' });
    await list.waitFor();
    const cards = list.getByRole('listitem');
    const unapproved = cards.filter({ has: page.getByText('not approved', { exact: true }) }).first();
    const approved = cards.filter({ has: page.getByText('approved', { exact: true }) }).first();
    const exercise = async (card, caseName) => {
      await card.getByText('Test cases', { exact: true }).click();
      const panel = card.getByRole('region', { name: /^Test cases for/ });
      await panel.getByRole('button', { name: 'Add a test case' }).click();
      const form = panel.getByRole('group', { name: 'New test case' });
      await form.getByLabel('Name').fill(caseName);
      const json = form.getByLabel('Input (JSON object)');
      if (await json.count()) await json.fill('{}');
      else for (const f of await form.locator('input[id^="tc-new-"]').all()) await f.fill('1');
      await form.getByLabel('Expected result').selectOption('succeeded');
      await form.getByRole('button', { name: 'Save test case' }).click();
      await panel.getByText(caseName, { exact: true }).waitFor();
      await panel.getByRole('button', { name: `Run ${caseName}` }).click();
      return { panel, row: panel.getByText(caseName, { exact: true }).locator('xpath=ancestor::li[1]') };
    };
    // 1) A rule that is not approved: the platform's gate refuses the run, and no result is recorded.
    const refused = await exercise(unapproved, 'Smoke refusal');
    const said = refused.panel.getByLabel('What the platform said');
    await said.waitFor();
    const refusal = await said.innerText();
    if (!/not approved for execution/.test(refusal)) throw new Error(`unexpected refusal: ${refusal}`);
    await refused.row.getByText('Not run', { exact: true }).waitFor();
    // 2) An approved rule: a real execution, and the verdict is the platform's.
    const ran = await exercise(approved, 'Smoke verdict');
    await ran.row.getByText(/^(Passed|Failed)$/).waitFor();
    const verdict = await ran.row.getByText(/^(Passed|Failed)$/).innerText();
    const why = verdict === 'Failed' ? await ran.row.getByRole('list', { name: /^Why/ }).innerText() : '';
    pending = `unapproved rule -> ${refusal.replace(/\s+/g, ' ')} | approved rule -> platform verdict: ${verdict}${why ? ` (${why.replace(/\s+/g, ' ')})` : ''}`;
    await shot('5-test-case');
  });

  if (errors.length > 0) throw new Error(`page errors: ${errors.join(' | ')}`);
  log(`\nSMOKE PASSED (${steps.length} steps). Screenshots: ${out}`);
} catch (e) {
  log(`\nSMOKE FAILED: ${String(e.message ?? e).split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  writeFileSync(join(out, 'steps.json'), JSON.stringify(steps, null, 2));
  for (const s of steps) if (s.detail) log(`  note ${s.name}: ${s.detail}`);
  await browser?.close().catch(() => undefined);
  for (const c of children) c.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1000));
  for (const c of children) c.kill('SIGKILL');
  rmSync(work, { recursive: true, force: true });
}
