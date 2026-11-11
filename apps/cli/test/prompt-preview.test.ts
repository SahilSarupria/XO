import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promptPreviewCommand } from '../src/commands/compiler/prompt.js';
import { withTempDir } from './helpers.js';

const TEXT = 'Build a request system that checks forms and emails the owner. If the widget count exceeds 5, approve the request.';

test('prompt-preview shows statements, intents and targeted questions without compiling anything', async () => {
  const r = await promptPreviewCommand({ text: TEXT });
  assert.equal(r.exitCode, 0);
  const out = r.lines.join('\n');
  assert.match(out, /needs_clarification/);
  assert.match(out, /approve the request/);
  assert.match(out, /missing-criterion/);
  assert.match(out, /missing-target/);
});

test('--json emits the full structured interpretation', async () => {
  const r = await promptPreviewCommand({ text: TEXT, json: true });
  const parsed = JSON.parse(r.lines.join('\n'));
  assert.equal(parsed.interpretation.statements.length, 1);
  assert.equal(parsed.interpretation.intents.length, 1);
  assert.equal(parsed.profile, null);
});

test('prompt text can come from a file', async () => {
  await withTempDir('xo-prompt-', async (dir) => {
    const file = join(dir, 'p.txt');
    await writeFile(file, 'If the widget count exceeds 5, approve the request.', 'utf8');
    const r = await promptPreviewCommand({ file });
    assert.equal(r.exitCode, 0);
    assert.match(r.lines.join('\n'), /ready/);
  });
});

test('a named domain profile is applied; an unknown profile is an error that lists the known ones', async () => {
  const text = 'If the shipment is flood, the request must be rejected.';
  const without = JSON.parse((await promptPreviewCommand({ text, json: true })).lines.join('\n'));
  assert.equal(without.interpretation.statements[0].structurable, true); // legacy core word
  const known = await promptPreviewCommand({ text, profile: 'insurance-claims', json: true });
  assert.equal(JSON.parse(known.lines.join('\n')).profile, 'insurance-claims');
  const bad = await promptPreviewCommand({ text, profile: 'nope' });
  assert.equal(bad.exitCode, 1);
  assert.match(bad.lines.join('\n'), /insurance-claims/);
});

test('missing or empty input fails clearly', async () => {
  assert.equal((await promptPreviewCommand({})).exitCode, 1);
  assert.equal((await promptPreviewCommand({ text: '   ' })).exitCode, 1);
  const missingFile = await promptPreviewCommand({ file: '/nonexistent/prompt.txt' });
  assert.equal(missingFile.exitCode, 1);
});
