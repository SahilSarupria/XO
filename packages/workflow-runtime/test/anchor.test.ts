import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AnchoredRunStore, RunStore, verifyRunAnchors, type RunAnchor, type RunAnchorSink } from '../src/index.js';

const mem = (): { sink: RunAnchorSink; got: RunAnchor[] } => {
  const got: RunAnchor[] = [];
  return { got, sink: { id: 'mem', publish: async (a) => void got.push(a) } };
};
const setup = async (every = 3) => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-anc-'));
  const { sink, got } = mem();
  const inner = new RunStore(dir);
  const store = new AnchoredRunStore(inner, [sink], { every });
  return { dir, inner, store, got };
};

describe('run journal anchoring', () => {
  it('anchors every N entries, at the end of a run, on escalations and outcomes and on an ambiguous effect; a clean journal verifies', async () => {
    const { store, got, inner } = await setup(3);
    await store.create('r');
    for (let i = 0; i < 7; i++) await store.append('r', 't', { i });
    await store.append('r', 'effect_ambiguous', {});
    await store.append('r', 'run_finished', { state: 'completed' });
    assert.deepEqual(
      got.map((a) => a.seq),
      [3, 6, 8, 9],
    );
    const v = await verifyRunAnchors(inner, got);
    assert.deepEqual([v.ok, v.anchors, v.runs, v.problems], [true, 4, 1, []]);
  });
  it('adversarial: a truncated journal, a rebuilt-from-scratch journal and a deleted run are all caught even though each chain is self-consistent', async () => {
    const { dir, store, got, inner } = await setup(2);
    for (const id of ['cut', 'rebuilt', 'gone']) {
      await store.create(id);
      for (let i = 0; i < 6; i++) await store.append(id, 't', { i });
    }
    // truncate: drop the last 3 lines (chain still valid, just shorter than the anchors at 4 and 6)
    const f = join(dir, 'cut', 'journal.jsonl');
    const lines = (await readFile(f, 'utf8')).trimEnd().split('\n');
    await writeFile(f, `${lines.slice(0, 3).join('\n')}\n`);
    // rebuild: a different but internally valid history of the same length
    await rm(join(dir, 'rebuilt'), { recursive: true });
    const other = new RunStore(dir);
    await other.create('rebuilt');
    for (let i = 0; i < 6; i++) await other.append('rebuilt', 't', { i: i + 100 });
    await rm(join(dir, 'gone'), { recursive: true });
    const v = await verifyRunAnchors(inner, got);
    assert.equal(v.ok, false);
    const text = v.problems.join('\n');
    assert.match(text, /run cut: anchor at seq 4 is beyond the journal's end \(3\) — journal truncated/);
    assert.match(text, /run rebuilt: anchor at seq \d does not match — history was rewritten/);
    assert.match(text, /run gone: journal is missing or empty/);
  });
  it('adversarial: edited entries are corrupt; forged or malformed anchor records are reported, never skipped', async () => {
    const { dir, store, got, inner } = await setup(2);
    await store.create('e');
    for (let i = 0; i < 4; i++) await store.append('e', 't', { i });
    const f = join(dir, 'e', 'journal.jsonl');
    await writeFile(f, (await readFile(f, 'utf8')).replace('"i":1', '"i":9'));
    assert.match((await verifyRunAnchors(inner, got)).problems.join(), /corrupt/);
    const bad = await verifyRunAnchors(inner, [{ runId: 'e', seq: 0, hash: 'x', at: '' }, { seq: 1 } as never]);
    assert.equal(bad.problems.filter((p) => /malformed/.test(p)).length, 2);
  });
  it('a failing or hanging sink never stops the run; it is counted and reported', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xo-anc-'));
    const failures: string[] = [];
    const store = new AnchoredRunStore(
      new RunStore(dir),
      [
        { id: 'down', publish: async () => Promise.reject(new Error('503')) },
        { id: 'hung', publish: () => new Promise(() => undefined) },
        mem().sink,
      ],
      { every: 1, timeoutMs: 20, onFailure: (s, _a, e) => failures.push(`${s}:${e.message}`) },
    );
    await store.create('r');
    await store.append('r', 't', {});
    assert.equal(store.failures, 2);
    assert.equal(store.published, 1);
    assert.deepEqual(failures.sort(), ['down:503', 'hung:anchor sink did not answer within 20 ms']);
    assert.equal((await store.read('r')).length, 1);
  });
  it('refuses nonsense configuration', async () => {
    const s = new RunStore(await mkdtemp(join(tmpdir(), 'xo-anc-')));
    assert.throws(() => new AnchoredRunStore(s, []), /at least one sink/);
    assert.throws(() => new AnchoredRunStore(s, [mem().sink], { every: 0 }), /positive integer/);
  });
});
