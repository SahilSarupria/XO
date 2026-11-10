import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rename, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalCorruptError, RunStore } from '../src/index.js';

const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), 'xo-seg-'));

test('segments: the journal seals at the size limit, and read verifies the chain across every segment', async () => {
  const dir = await tmp();
  const s = new RunStore(dir, undefined, { segmentBytes: 400 });
  await s.create('r');
  for (let i = 0; i < 30; i++) await s.append('r', 't', { i, pad: 'x'.repeat(20) });
  const files = (await readdir(join(dir, 'r'))).sort();
  assert.ok(files.filter((f) => /^journal\.\d{6}\.jsonl$/.test(f)).length >= 3, files.join());
  const all = await new RunStore(dir).read('r'); // a fresh store, default options: segments are a property of the files
  assert.deepEqual(
    all.map((e) => e.seq),
    Array.from({ length: 30 }, (_, i) => i + 1),
  );
  // a fresh store appends onto the right tail (cold start reads only the newest entry)
  const fresh = new RunStore(dir, undefined, { segmentBytes: 400 });
  const e = await fresh.append('r', 't', {});
  assert.equal(e.seq, 31);
  assert.equal((await fresh.read('r')).length, 31);
  await rm(dir, { recursive: true });
});

test('segments: window returns only the newest entries; a corrupt entry inside it is refused', async () => {
  const dir = await tmp();
  const s = new RunStore(dir, undefined, { segmentBytes: 300 });
  await s.create('r');
  for (let i = 0; i < 20; i++) await s.append('r', 't', { i });
  const w = await s.window('r', 3);
  assert.deepEqual(
    w.map((e) => e.seq),
    [18, 19, 20],
  );
  assert.deepEqual(
    (await s.window('r', 500)).map((e) => e.seq),
    (await s.read('r')).map((e) => e.seq),
  );
  await assert.rejects(s.window('r', 0), /positive integer/);
  assert.deepEqual(await s.window('absent', 3), []);
  await rm(dir, { recursive: true });
});

test('segments (adversarial): a removed, reordered, edited or truncated sealed segment is a hard error, never a shorter valid history', async () => {
  const mk = async (): Promise<{ dir: string; seg: (n: number) => string }> => {
    const dir = await tmp();
    const s = new RunStore(dir, undefined, { segmentBytes: 300 });
    await s.create('r');
    for (let i = 0; i < 20; i++) await s.append('r', 't', { i });
    return { dir, seg: (n) => join(dir, 'r', `journal.${String(n).padStart(6, '0')}.jsonl`) };
  };
  let m = await mk();
  await rm(m.seg(2));
  await assert.rejects(new RunStore(m.dir).read('r'), JournalCorruptError); // gap in numbering
  m = await mk();
  await rename(m.seg(1), m.seg(1) + '.x');
  await rename(m.seg(2), m.seg(1));
  await rename(m.seg(1) + '.x', m.seg(2));
  await assert.rejects(new RunStore(m.dir).read('r'), JournalCorruptError); // swapped
  m = await mk();
  const t = await readFile(m.seg(1), 'utf8');
  await writeFile(m.seg(1), t.replace('"i":0', '"i":9'));
  await assert.rejects(new RunStore(m.dir).read('r'), JournalCorruptError); // edited
  m = await mk();
  await writeFile(m.seg(1), (await readFile(m.seg(1), 'utf8')).slice(0, -5));
  await assert.rejects(new RunStore(m.dir).read('r'), /torn|chain|not JSON/); // sealed segment cut short is not a "torn tail"
  m = await mk();
  const last = (await readdir(join(m.dir, 'r'))).filter((f) => /^journal\.\d{6}/.test(f)).length;
  await rm(m.seg(last)); // dropping the newest sealed segment leaves a chain that breaks at the active file
  await assert.rejects(new RunStore(m.dir).read('r'), JournalCorruptError);
});

test('store memory is bounded: tail cache is LRU-capped and idle queues are released; evicted runs still append correctly', async () => {
  const dir = await tmp();
  const s = new RunStore(dir, undefined, { maxTrackedRuns: 2 });
  for (const id of ['a', 'b', 'c']) {
    await s.create(id);
    await s.append(id, 't', {});
  }
  const internals = s as unknown as { tails: Map<string, unknown>; queues: Map<string, unknown> };
  assert.equal(internals.tails.size, 2);
  assert.equal(internals.tails.has('a'), false);
  await new Promise((r) => setImmediate(r));
  assert.equal(internals.queues.size, 0);
  assert.equal((await s.append('a', 't', {})).seq, 2); // evicted tail is recovered from disk
  assert.throws(() => new RunStore(dir, undefined, { segmentBytes: -1 }), /non-negative/);
  await rm(dir, { recursive: true });
});
