import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compileCommand } from '../src/commands/compiler/compile.js';
import { withTempDir } from './helpers.js';

const RULE = 'If the widget count exceeds 5, approve the request.';

test('compile with an unconfirmed --prompt alongside a document: warns that it contributed nothing', async () => {
  await withTempDir('xo-cp-', async (dir) => {
    const doc = join(dir, 'notes.md');
    await writeFile(doc, '# Notes\nThe study enrolled 240 participants.\n', 'utf8');
    const r = await compileCommand({ sources: [doc], prompts: [RULE] });
    assert.equal(r.exitCode, 0);
    assert.match(r.lines.join('\n'), /awaiting confirmation/);
  });
});

test('compile with a confirmed --prompt compiles its rules and does not warn', async () => {
  const r = await compileCommand({ sources: [], prompts: [RULE], confirmedBy: 'owner@example.test' });
  assert.equal(r.exitCode, 0);
  const out = r.lines.join('\n');
  assert.doesNotMatch(out, /awaiting confirmation/);
  assert.match(out, /\(prompt\)/);
  assert.match(out, /decision_node|heuristic/);
});

test('a prompt-only compile that is unconfirmed fails and shows the interpretation and its questions', async () => {
  const r = await compileCommand({ sources: [], prompts: ['Build a system that emails the owner and applies size limits.'] });
  assert.equal(r.exitCode, 1);
  const out = r.lines.join('\n');
  assert.match(out, /confirm/i);
  assert.match(out, /missing-target/);
  assert.match(out, /missing-threshold/);
});

test('--json includes the prompt interpretations', async () => {
  const r = await compileCommand({ sources: [], prompts: [RULE], confirmedBy: 'owner@example.test', json: true });
  const parsed = JSON.parse(r.lines.join('\n'));
  assert.equal(parsed.promptInterpretations.length, 1);
  assert.equal(parsed.promptInterpretations[0].confirmed, true);
  assert.equal(parsed.promptInterpretations[0].confirmedBy, 'owner@example.test');
});

test('a profile id is validated; an unknown one fails listing the known ids', async () => {
  const bad = await compileCommand({ sources: [], prompts: [RULE], confirmedBy: 'x', profile: 'nope' });
  assert.equal(bad.exitCode, 1);
  assert.match(bad.lines.join('\n'), /insurance-claims/);
  const good = await compileCommand({ sources: [], prompts: [RULE], confirmedBy: 'x', profile: 'insurance-claims' });
  assert.equal(good.exitCode, 0);
});

test('no sources and no prompt is still an error', async () => {
  const r = await compileCommand({ sources: [] });
  assert.equal(r.exitCode, 1);
});

test('compile accepts a real .docx file end to end and extracts its rules', async () => {
  const { fileURLToPath } = await import('node:url');
  const docx = fileURLToPath(new URL('../../../packages/compiler/test/fixtures/loan-python-docx.docx', import.meta.url));
  const r = await compileCommand({ sources: [docx] });
  assert.equal(r.exitCode, 0, r.lines.join('\n'));
  assert.match(r.lines.join('\n'), /\(docx\)/);
  assert.match(r.lines.join('\n'), /decision_node|heuristic/);
});

test('a corrupt .docx fails with a specific error instead of ingesting garbage', async () => {
  await withTempDir('xo-baddocx-', async (dir) => {
    const bad = join(dir, 'bad.docx');
    await writeFile(bad, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0]));
    const r = await compileCommand({ sources: [bad] });
    assert.equal(r.exitCode, 1);
    assert.match(r.lines.join('\n'), /could not read DOCX|not a ZIP|not a Word/i);
  });
});

test('compile accepts a real .xlsx workbook end to end and extracts its rules from the rows', async () => {
  const { fileURLToPath } = await import('node:url');
  const xlsx = fileURLToPath(new URL('../../../packages/compiler/test/fixtures/rules-openpyxl.xlsx', import.meta.url));
  const r = await compileCommand({ sources: [xlsx] });
  assert.equal(r.exitCode, 0, r.lines.join('\n'));
  assert.match(r.lines.join('\n'), /\(xlsx\)/);
});
