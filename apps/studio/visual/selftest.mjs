#!/usr/bin/env node
// Proves the visual-regression MACHINERY works, without Studio or the API: a real Chromium captures a tiny local page,
// and the suite must (1) pass when nothing changed, (2) fail with an inspectable diff when something did, (3) flag a
// missing reference and a size change, and (4) call a dead page an infrastructure failure, not a regression.
// This tests the checker, not Studio. It is not coverage of any Studio screen.
//
//   node apps/studio/visual/selftest.mjs [--out <dir>]
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { InfraError, loadPlaywright, newContext, shoot } from './lib/browser.mjs';
import { classify } from './lib/classify.mjs';
import { decodePng } from './lib/png.mjs';
import { Recorder } from './lib/recorder.mjs';
import { writeReport } from './lib/report.mjs';
import { screen } from './screens.mjs';
import { EXIT, VIEWPORTS } from './visual.config.mjs';
import { readFileSync } from 'node:fs';

const outArg = process.argv.indexOf('--out');
const out = resolve(outArg > 0 ? process.argv[outArg + 1] : mkdtempSync(join(tmpdir(), 'xo-visual-selftest-out-')));
const work = mkdtempSync(join(tmpdir(), 'xo-visual-selftest-'));

let variant = 'base';
const page = () => {
  const heading = variant === 'changed' ? 'Waiting for approval' : 'Waiting for you';
  const extra = variant === 'taller' ? '<div style="height:1600px;background:#eef"></div>' : '';
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><body style="margin:0;font:16px sans-serif">
  <nav style="background:#123;color:#fff;padding:12px">Home · Work · Tasks</nav>
  <main style="padding:24px"><h1>Commercial property claims</h1><h2>${heading}</h2>
  <p>Check the claim against the policy limits.</p>
  <button style="background:${variant === 'changed' ? '#b00' : '#06c'};color:#fff;border:0;padding:10px 18px">Continue in Tasks</button>${extra}</main>`;
};
const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(page());
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const { chromium } = loadPlaywright();
const browser = await chromium.launch();

async function capture(recorder) {
  for (const viewport of Object.keys(VIEWPORTS)) {
    const context = await newContext(browser, viewport);
    const p = await context.newPage();
    await p.goto(url);
    recorder.submit(viewport, 'home', await shoot(p, { fullPage: variant === 'taller' }));
    await context.close();
  }
}

const checks = [];
const expect = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
};
const nonEmptyPng = (rel) => {
  const f = join(out, rel);
  return existsSync(f) && statSync(f).size > 0 && decodePng(readFileSync(f)).width > 0;
};

try {
  // 0. Propose references (never touches the repo), then "approve" them by copying into a temp baselines folder.
  const baselines = join(work, 'baselines');
  variant = 'base';
  const candidates = new Recorder({ outDir: join(out, '0-candidates'), baselinesDir: baselines, mode: 'update-candidates' });
  await capture(candidates);
  for (const r of candidates.results) {
    mkdirSync(join(baselines, r.id, '..'), { recursive: true });
    copyFileSync(join(out, '0-candidates', r.candidate), join(baselines, `${r.id}.png`));
  }
  expect(
    'candidates are written for both viewports and are valid PNGs',
    candidates.results.length === 2 && candidates.results.every((r) => r.status === 'candidate'),
  );

  // 1. Nothing changed -> pass.
  const same = new Recorder({ outDir: join(out, '1-unchanged'), baselinesDir: baselines, mode: 'compare' });
  await capture(same);
  const v1 = classify({ results: same.results });
  expect(
    'unchanged UI passes with exit code 0',
    v1.kind === 'pass' && v1.exitCode === EXIT.pass && same.results.every((r) => r.diffPixels === 0),
    JSON.stringify(same.results),
  );

  // 2. A visible change -> regression with an inspectable diff.
  variant = 'changed';
  const changed = new Recorder({ outDir: join(out, '2-changed'), baselinesDir: baselines, mode: 'compare' });
  await capture(changed);
  const v2 = classify({ results: changed.results });
  expect(
    'a visual change is a REGRESSION with exit code 10',
    v2.kind === 'regression' && v2.exitCode === EXIT.regression,
    JSON.stringify(v2),
  );
  expect(
    'the changed screens are named',
    changed.results.every((r) => r.status === 'diff' && r.diffPixels > 50),
    JSON.stringify(changed.results),
  );
  const sample = changed.results[0];
  const dir2 = (rel) => join('2-changed', rel);
  expect(
    'a diff image and a side-by-side image were written and are valid PNGs',
    nonEmptyPng(dir2(sample.diff)) && nonEmptyPng(dir2(sample.sideBySide)),
    JSON.stringify(sample),
  );
  const side = decodePng(readFileSync(join(out, dir2(sample.sideBySide))));
  expect(
    'the side-by-side image is three panels wide',
    side.width === VIEWPORTS.desktop.width * 3 + 16 || side.width === VIEWPORTS.mobile.width * 3 + 16,
    String(side.width),
  );
  writeReport(join(out, '2-changed'), {
    verdict: v2,
    results: changed.results,
    orphans: [],
    info: { Note: 'self-test, not Studio' },
    mode: 'compare',
  });
  expect('the report was written', existsSync(join(out, '2-changed', 'report.md')) && existsSync(join(out, '2-changed', 'result.json')));

  // 3. Size change.
  variant = 'taller';
  const taller = new Recorder({ outDir: join(out, '3-size'), baselinesDir: baselines, mode: 'compare' });
  await capture(taller);
  expect(
    'a change in page size is a regression',
    classify({ results: taller.results }).kind === 'regression' && taller.results.some((r) => r.status === 'size-mismatch'),
    JSON.stringify(taller.results),
  );

  // 4. Missing reference.
  variant = 'base';
  rmSync(join(baselines, 'mobile', 'home.png'));
  const missing = new Recorder({ outDir: join(out, '4-missing'), baselinesDir: baselines, mode: 'compare' });
  await capture(missing);
  expect(
    'a screen with no approved reference is a regression, not a silent pass',
    missing.results.find((r) => r.id === 'mobile/home')?.status === 'missing-baseline' &&
      classify({ results: missing.results }).kind === 'regression',
  );

  // 5. Orphans are reported but do not fail.
  copyFileSync(join(baselines, 'desktop', 'home.png'), join(baselines, 'desktop', 'retired.png'));
  const orphan = new Recorder({ outDir: join(out, '5-orphan'), baselinesDir: baselines, mode: 'compare' });
  await capture(orphan);
  expect('a retired screen is listed as an orphaned reference', orphan.orphanedBaselines().includes('desktop/retired.png'));

  // 6. A dead page is infrastructure, never "a visual regression".
  let infra;
  try {
    const context = await newContext(browser, 'desktop');
    const p = await context.newPage();
    await p.goto('http://127.0.0.1:1/', { timeout: 5000 });
  } catch (e) {
    infra = String(e.message).split('\n')[0];
  }
  const v6 = classify({ infraError: infra, results: [] });
  expect(
    'an unreachable page is an INFRASTRUCTURE failure with exit code 20',
    infra !== undefined && v6.kind === 'infra' && v6.exitCode === EXIT.infra,
    JSON.stringify(v6),
  );
  expect(
    'an infrastructure error outranks screens that did compare',
    classify({ infraError: 'x', results: same.results }).kind === 'infra',
  );
  expect('a run that captured nothing is infrastructure, not a pass', classify({ results: [] }).kind === 'infra');

  // 7. The bug the first CI run hit: Studio's Rules tab carries a count badge, so its accessible name is "Rules7 ready for
  //    review" (no space), and a word boundary after "Rules" cannot match it.
  const tab = (count) =>
    `<div class="app"><button type="button">Documents</button><button type="button">Rules${
      count > 0 ? `<span aria-label="${count} ready for review">${count}</span>` : ''
    }</button></div>`;
  const ctx7 = await newContext(browser, 'desktop');
  const p7 = await ctx7.newPage();
  p7.setDefaultTimeout(1000);
  const found = async (count, re) => {
    await p7.setContent(tab(count));
    return p7.getByRole('button', { name: re }).count();
  };
  expect('the old selector /^Rules\\b/ really cannot see a Rules tab that has a count badge', (await found(7, /^Rules\b/)) === 0);
  expect(
    'the fixed selector finds the Rules tab with and without a count badge',
    (await found(7, /^Rules(?![A-Za-z])/)) === 1 && (await found(0, /^Rules(?![A-Za-z])/)) === 1,
  );

  // 8. A control missing from a live page fails THAT screen (with a screenshot) and the run carries on.
  await p7.setContent(tab(0));
  const rec8 = new Recorder({ outDir: join(out, '8-missing-control'), baselinesDir: baselines, mode: 'compare' });
  await screen(rec8, 'desktop', 'setup-rules', p7, async () => {
    await p7.getByRole('button', { name: /^Nope(?![A-Za-z])/ }).click();
  });
  await screen(rec8, 'desktop', 'next-screen', p7, async () => rec8.submit('desktop', 'next-screen', await shoot(p7)));
  const failure = rec8.results.find((r) => r.id === 'desktop/setup-rules');
  expect(
    'a missing control is recorded as a failure of that screen, naming what was awaited, with a screenshot',
    failure?.status === 'functional' &&
      /waiting for getByRole/.test(failure.detail) &&
      failure.failureShot !== undefined &&
      nonEmptyPng(join('8-missing-control', failure.failureShot)),
    JSON.stringify(failure),
  );
  expect(
    'the run carried on to the next screen',
    rec8.results.some((r) => r.id === 'desktop/next-screen'),
  );
  expect('that is a regression, not an infrastructure failure', classify({ results: rec8.results }).kind === 'regression');

  // 9. If the page itself is gone, the same timeout is an infrastructure failure.
  await p7.setContent('<p>a blank page: no app, no sign-in</p>');
  let thrown;
  try {
    await screen(rec8, 'desktop', 'after-crash', p7, async () => {
      await p7.getByRole('button', { name: 'Anything' }).click();
    });
  } catch (e) {
    thrown = e;
  }
  expect('a timeout on a page with no app is an INFRASTRUCTURE failure', thrown instanceof InfraError, String(thrown));
  await ctx7.close();
} finally {
  await browser.close();
  server.close();
  rmSync(work, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c).length;
console.log(`\n${checks.length - failed}/${checks.length} machinery checks passed. Artifacts for inspection: ${out}`);
console.log(`(files: ${readdirSync(out).join(', ')})`);
process.exit(failed === 0 ? 0 : 1);
