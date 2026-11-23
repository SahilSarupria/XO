import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withTempDir } from './test-helpers.js';

const SCRIPT = new URL('../../../scripts/test-names.mjs', import.meta.url).pathname;
const BASE = ['@xo/api\tpass\told composed start', '@xo/api\tpass\tkept test', '@xo/api\tpass\tnew start', ''].join('\n');

async function compare(current: string[], retired: string[] | undefined) {
  return withTempDir('xo-names-', async (dir) => {
    await writeFile(join(dir, 'base.tsv'), BASE);
    await writeFile(join(dir, 'cur.tsv'), current.join('\n') + '\n');
    const args = [SCRIPT, 'compare', join(dir, 'base.tsv'), join(dir, 'cur.tsv')];
    if (retired !== undefined) {
      await writeFile(join(dir, 'retired.tsv'), retired.join('\n') + '\n');
      args.push('--retired', join(dir, 'retired.tsv'));
    }
    const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
    return { code: r.status, out: r.stdout };
  });
}
const row = '@xo/api\told composed start\tADR 0052: composed start removed\t@xo/api :: new start';

test('ADR 0052: retired names are not regressions, are listed, and must be absent', async () => {
  const gone = await compare(['@xo/api\tpass\tkept test', '@xo/api\tpass\tnew start'], undefined);
  assert.equal(gone.code, 1, 'without a retired list the missing test is a regression');
  assert.match(gone.out, /MISSING-OR-NOT-PASSING/);
  const ok = await compare(['@xo/api\tpass\tkept test', '@xo/api\tpass\tnew start'], [row]);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /RETIRED\t@xo\/api\told composed start\tADR 0052/);
  const present = await compare(['@xo/api\tpass\tkept test', '@xo/api\tpass\tnew start', '@xo/api\tpass\told composed start'], [row]);
  assert.equal(present.code, 1);
  assert.match(present.out, /RETIRED-BUT-PRESENT/);
});

test('ADR 0052: a retired name whose replacement is missing fails, and a row without an ADR 0052 reason is refused', async () => {
  const missing = await compare(['@xo/api\tpass\tkept test'], [row]);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /REPLACEMENT-MISSING/);
  const none = await compare(
    ['@xo/api\tpass\tkept test', '@xo/api\tpass\tnew start'],
    ['@xo/api\told composed start\tADR 0052: removed\tnone: the subject is gone'],
  );
  assert.equal(none.code, 0, none.out);
  const bad = await compare(['@xo/api\tpass\tkept test', '@xo/api\tpass\tnew start'], ['@xo/api\told composed start\tbecause\tnone: x']);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /BAD-RETIRED-ROW/);
});
