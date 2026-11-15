import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { knowledgeCommand, type KnowledgeOptions } from '../src/commands/knowledge/knowledge.js';

test('xo knowledge: propose → approve → search → verify; recompiling proposes nothing; refusals are clean', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-cli-kb-'));
  const src = join(dir, 'refunds.md');
  await writeFile(src, '# Refunds\n\nAcme Corp handles refunds.\n\nIf the refund amount exceeds 500, the refund must be denied.\n');
  const base = { kbDir: join(dir, 'kb'), tenant: 'local', json: true, args: [] } satisfies Omit<KnowledgeOptions, 'action'>;
  const run = async (o: Partial<KnowledgeOptions> & { action: string }): Promise<{ exitCode: number; value: unknown }> => {
    const r = await knowledgeCommand({ ...base, ...o });
    return { exitCode: r.exitCode, value: r.exitCode === 0 && o.json !== false ? JSON.parse(r.lines.join('\n')) : r.lines };
  };
  const p = (await run({ action: 'propose', args: [src] })).value as { changeSet: { changeSetId: string }; report: { accepted: string[] } };
  assert.ok(p.report.accepted.length > 0);
  const refused = await run({ action: 'approve', args: [p.changeSet.changeSetId] });
  assert.equal(refused.exitCode, 1, 'a reason is required');
  const state = (await run({ action: 'approve', args: [p.changeSet.changeSetId], reason: 'matches policy' })).value as { stateId: string };
  const hits = (await run({ action: 'search', args: ['refund'] })).value as { stateId: string; hits: unknown[] };
  assert.equal(hits.stateId, state.stateId);
  assert.ok(hits.hits.length > 0);
  assert.equal(((await run({ action: 'verify' })).value as { verified: boolean }).verified, true);
  const again = (await run({ action: 'propose', args: [src] })).value as { changeSet: null };
  assert.equal(again.changeSet, null);
  const twice = await run({ action: 'approve', args: [p.changeSet.changeSetId], reason: 'again' });
  assert.equal(twice.exitCode, 1);
  assert.match(String((twice.value as string[])[0]), /already_decided/);
});
