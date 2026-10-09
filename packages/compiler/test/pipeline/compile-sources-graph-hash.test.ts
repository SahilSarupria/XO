import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSources } from '../../src/pipeline/compile-sources.js';

/**
 * P0.9B Step 1 — graph identity. `compileSources` always finalizes the
 * compiled graph's manifest with `graphHash` set to `XoirGraph.contentHash()`
 * (`@xo/xoir`'s own, pre-existing, authoritative graph identity — see
 * `graph.ts#contentHash`). No second graph-hashing scheme is introduced:
 * this suite only proves the existing identity is now consistently
 * *captured* on the manifest, and that capture never silently invents or
 * duplicates the identity itself.
 */

const CLEAN_TEXT_A = `# Clean Section
Contact the claims department within 30 days of any loss event.
Send a confirmation notice to the policyholder upon issuance of this policy.`;

const CLEAN_TEXT_B = `# A Different Clean Section
The reviewer must escalate any claim exceeding $10,000 to a senior adjuster.
All escalations are logged with a timestamped case reference.`;

test('graphHash: compiling the same source twice (no source-quality findings) produces the same manifest.graphHash both times', async () => {
  // `@xo/xoir`'s node hashing deliberately includes `createdAt` as
  // provenance (see `create.ts`'s own recompile-determinism check for
  // the same convention), so a genuine determinism comparison pins the
  // clock across both compiles — this is not something P0.9B's graphHash
  // propagation changes or needs to work around.
  const now = () => '2026-01-01T00:00:00.000Z';
  const first = await compileSources([{ kind: 'document', text: CLEAN_TEXT_A, sourcePath: 'clean.txt' }], { now });
  const second = await compileSources([{ kind: 'document', text: CLEAN_TEXT_A, sourcePath: 'clean.txt' }], { now });
  assert.ok(first.ok, first.ok ? undefined : JSON.stringify(first.error));
  assert.ok(second.ok, second.ok ? undefined : JSON.stringify(second.error));
  if (!first.ok || !second.ok) return;

  assert.ok(first.value.graph.manifest?.graphHash, 'manifest.graphHash must be set');
  assert.equal(first.value.graph.manifest?.graphHash, second.value.graph.manifest?.graphHash);
});

test('graphHash: manifest.graphHash always equals graph.contentHash() at the moment compileSources returns', async () => {
  const result = await compileSources([{ kind: 'document', text: CLEAN_TEXT_A, sourcePath: 'clean.txt' }], {});
  assert.ok(result.ok, result.ok ? undefined : JSON.stringify(result.error));
  if (!result.ok) return;

  assert.equal(result.value.graph.manifest?.graphHash, result.value.graph.contentHash());
});

test('graphHash: a semantically different compiled source produces a different graphHash', async () => {
  const a = await compileSources([{ kind: 'document', text: CLEAN_TEXT_A, sourcePath: 'clean-a.txt' }], {});
  const b = await compileSources([{ kind: 'document', text: CLEAN_TEXT_B, sourcePath: 'clean-b.txt' }], {});
  assert.ok(a.ok, a.ok ? undefined : JSON.stringify(a.error));
  assert.ok(b.ok, b.ok ? undefined : JSON.stringify(b.error));
  if (!a.ok || !b.ok) return;

  assert.notEqual(a.value.graph.manifest?.graphHash, b.value.graph.manifest?.graphHash);
});

test('graphHash: manifest.graphHash is set for a fully trusted source with no quality diagnostics (graph identity is unconditional, not gated on any quality finding existing)', async () => {
  const result = await compileSources([{ kind: 'document', text: CLEAN_TEXT_A, sourcePath: 'clean.txt' }], {});
  assert.ok(result.ok, result.ok ? undefined : JSON.stringify(result.error));
  if (!result.ok) return;

  // No quality *diagnostics* for a fully trusted source (existing
  // behavior, unchanged — see compile-sources-quality.test.ts): this is
  // deliberately not the same thing as "no sourceQuality entry at all"
  // (every document source gets one, per-document, regardless of
  // state) — the point of this test is only that graphHash's presence
  // never depends on whichever branch sourceQuality happened to take.
  assert.ok(!result.value.diagnostics.some((d) => d.passName === 'source-quality'));
  assert.ok(result.value.graph.manifest !== undefined);
  assert.ok(result.value.graph.manifest?.graphHash !== undefined);
});

test('graphHash: source-quality findings (when present) are unaffected by, and coexist with, graphHash on the same manifest', async () => {
  const CORRUPTED_TEXT = `and8827461093 PlanOpted NameOpted xyz9999999 abc8888888 ContactNoEmail defGGGG1111 hij2222222word`;
  const result = await compileSources(
    [
      { kind: 'document', text: CORRUPTED_TEXT, sourcePath: 'corrupted.txt' },
      { kind: 'document', text: CLEAN_TEXT_A, sourcePath: 'clean.txt' },
    ],
    {},
  );
  assert.ok(result.ok, result.ok ? undefined : JSON.stringify(result.error));
  if (!result.ok) return;

  assert.ok(result.value.graph.manifest?.sourceQuality !== undefined, 'sourceQuality must still be attached, unchanged');
  assert.ok(result.value.graph.manifest?.graphHash !== undefined, 'graphHash must also be attached, additively');
  assert.equal(result.value.graph.manifest?.graphHash, result.value.graph.contentHash());
});
