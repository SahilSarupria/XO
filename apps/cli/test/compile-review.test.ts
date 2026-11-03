import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConsoleLogger } from '@xo/logger';
import { run } from '../src/index.js';
import { withTempDir } from './helpers.js';

async function capture(fn: () => Promise<number>): Promise<{ code: number; text: string }> {
  const original = process.stdout.write;
  let text = '';
  process.stdout.write = ((c: string | Uint8Array) => ((text += String(c)), true)) as typeof process.stdout.write;
  try {
    return { code: await fn(), text };
  } finally {
    process.stdout.write = original;
  }
}

test('compile-review lists what the compiler could not work out as questions and exits 2 while any need an answer', async () => {
  await withTempDir('xo-review-', async (dir) => {
    const file = join(dir, 'manual.md');
    await writeFile(
      file,
      '# Desk\n\n## Rules\n\n**R1.** If the policy had lapsed, the claim is denied.\n\n**R2.** Payments above $15,000 need Senior Adjuster approval.\n',
    );
    const r = await capture(() => run(['compile-review', file, '--json'], new ConsoleLogger({ level: 'fatal' })));
    assert.equal(r.code, 2);
    const parsed = JSON.parse(r.text) as {
      report: { quality: { blockingQuestions: number } };
      questions: { kind: string; prompt: string }[];
    };
    assert.ok(parsed.report.quality.blockingQuestions >= 1);
    assert.ok(parsed.questions.some((q) => q.kind === 'resolve_sentence' && /lapsed/.test(q.prompt)));
  });
});

test('compile-review refuses a missing file with a clear message', async () => {
  const r = await capture(() => run(['compile-review', '/no/such/manual.md'], new ConsoleLogger({ level: 'fatal' })));
  assert.notEqual(r.code, 0);
});
