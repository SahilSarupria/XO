import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { apiClosure, expectedPaths, readWorkflowPaths, triggersRun, WORKFLOW_FILE, workflowSafetyProblems } from '../lib/paths.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const patterns = expectedPaths(root);
const runs = (...files) => triggersRun(files, patterns);

test('Studio changes that can alter rendering start the workflow', () => {
  assert.ok(runs('apps/studio/src/ui/WorkSection.tsx'));
  assert.ok(runs('apps/studio/src/styles/tokens.css'));
  assert.ok(runs('apps/studio/package.json'));
  assert.ok(runs('apps/studio/vite.config.ts'));
  assert.ok(runs('apps/studio/index.html'));
});

test('the suite, its reference images and its own tests start the workflow', () => {
  assert.ok(runs(WORKFLOW_FILE));
  assert.ok(runs('apps/studio/visual/screens.mjs'));
  assert.ok(runs('apps/studio/visual/baselines/desktop/home.png'));
  assert.ok(runs('apps/studio/visual/test/compare.test.mjs'));
});

test('dependency and tool-version changes start the workflow', () => {
  assert.ok(runs('package-lock.json'));
  assert.ok(runs('package.json'));
  assert.ok(runs('.nvmrc'));
  assert.ok(runs('tsconfig.base.json'));
  assert.ok(runs('examples/vertical-test/Aastha.pdf'));
});

test('workspace packages the API is built from start the workflow', () => {
  for (const dir of apiClosure(root)) assert.ok(runs(`${dir}/src/index.ts`), dir);
  assert.ok(apiClosure(root).includes('packages/compiler'));
  assert.ok(apiClosure(root).includes('packages/runtime'));
});

test('unrelated changes stay quiet', () => {
  assert.ok(!runs('docs/DEVELOPING.md'));
  assert.ok(!runs('README.md'));
  assert.ok(!runs('apps/cli/src/index.ts'));
  assert.ok(!runs('.github/workflows/ci.yml'));
  assert.ok(!runs('.github/workflows/release.yml'));
  assert.ok(!runs('.changeset/some-note.md'));
  assert.ok(!runs('packages/atlas/src/index.ts'), 'a package the API does not use');
});

test('documentation, tests and desktop-only code inside relevant folders stay quiet', () => {
  assert.ok(!runs('apps/studio/docs/STUDIO_ARCHITECTURE.md'));
  assert.ok(!runs('apps/studio/README.md'));
  assert.ok(!runs('apps/studio/test/ui/App.test.tsx'));
  assert.ok(!runs('apps/studio/src-tauri/src/main.rs'));
  assert.ok(!runs('apps/studio/desktop/main.tsx'));
  assert.ok(!runs('apps/studio/scripts/live-smoke.mjs'));
  assert.ok(!runs('apps/api/README.md'));
  assert.ok(!runs('apps/api/test/server.test.ts'));
  assert.ok(!runs('packages/compiler/README.md'));
  assert.ok(!runs('packages/compiler/test/compile.test.ts'));
  assert.ok(!runs('packages/compiler/src/pipeline/compile.test.ts'));
});

test('a change set triggers if ANY file in it qualifies', () => {
  assert.ok(runs('docs/DEVELOPING.md', 'apps/studio/src/ui/App.tsx'));
  assert.ok(!runs('docs/DEVELOPING.md', 'apps/cli/src/index.ts'));
});

test('the workflow file declares exactly the filters the repository implies (push and pull_request)', () => {
  const actual = readWorkflowPaths(readFileSync(join(root, WORKFLOW_FILE), 'utf8'));
  assert.deepEqual(actual.push, patterns, 'push paths drifted; run: node apps/studio/visual/check-trigger-paths.mjs --print');
  assert.deepEqual(actual.pull_request, patterns, 'pull_request paths drifted');
});

test('the workflow satisfies the static safety rules', () => {
  assert.deepEqual(workflowSafetyProblems(readFileSync(join(root, WORKFLOW_FILE), 'utf8')), []);
});

test('the safety checker actually catches unsafe workflows', () => {
  const bad = `name: x\non:\n  pull_request_target:\npermissions:\n  contents: write\njobs:\n  a:\n    steps:\n      - run: git push\n      - run: echo \${{ secrets.TOKEN }}\n`;
  const found = workflowSafetyProblems(bad).join(' | ');
  for (const needle of ['pull_request_target', 'secrets', 'permissions must be exactly', 'git commit/push', 'persist-credentials']) {
    assert.ok(found.includes(needle), `expected a problem mentioning "${needle}" in: ${found}`);
  }
  assert.ok(workflowSafetyProblems('name: x\n').some((p) => p.includes('no top-level permissions')));
});
