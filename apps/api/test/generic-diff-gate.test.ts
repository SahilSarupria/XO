import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withTempDir } from './test-helpers.js';

const SCRIPT = new URL('../../../scripts/generic-diff-gate.mjs', import.meta.url).pathname;
const ALLOW = new URL('../../../evaluation/generic-allowlist.json', import.meta.url).pathname;

test('UW-13: the generic-diff gate lists files outside the allowlist and fails only with --strict', async () => {
  await withTempDir('xo-gate-', async (dir) => {
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...a], { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    await writeFile(join(dir, 'README.md'), 'x');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'vertical');
    for (const f of [
      'packages/foo/packs/claims.json',
      'docs/a.md',
      'apps/api/test/x.test.ts',
      'evaluation/r.json',
      'packages/connect/src/names.ts',
    ]) {
      await mkdir(join(dir, f, '..'), { recursive: true });
      await writeFile(join(dir, f), 'y');
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'change');
    const run = (...extra: string[]) =>
      spawnSync(process.execPath, [SCRIPT, '--base', 'main', '--head', 'vertical', '--allowlist', ALLOW, ...extra], {
        cwd: dir,
        encoding: 'utf8',
      });
    const loose = run();
    assert.equal(loose.status, 0, 'informational by default');
    assert.deepEqual(JSON.parse(loose.stdout).outsideAllowlist, ['packages/connect/src/names.ts']);
    assert.equal(run('--strict').status, 1);
    // Only allowed paths: strict passes.
    git('checkout', '-q', 'main');
    git('checkout', '-q', '-b', 'pack-only');
    await mkdir(join(dir, 'packages/bar/packs'), { recursive: true });
    await writeFile(join(dir, 'packages/bar/packs/a.json'), 'z');
    git('add', '-A');
    git('commit', '-q', '-m', 'pack');
    const ok = spawnSync(process.execPath, [SCRIPT, '--base', 'main', '--head', 'pack-only', '--allowlist', ALLOW, '--strict'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(ok.status, 0, ok.stdout);
  });
});
