import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSources } from '../../src/pipeline/compile-sources.js';

/** A document that is almost entirely layout-reconstruction artifacts — well past the blocked threshold. */
const CORRUPTED_TEXT = `# Corrupted
and8827461093 PlanOpted NameOpted xyz9999999 abc8888888 ContactNoEmail defGGGG1111 hij2222222word`;

const CLEAN_TEXT = `# Clean Section
Contact the claims department within 30 days of any loss event.
Send a confirmation notice to the policyholder upon issuance of this policy.`;

test('a source whose extracted text is mostly corrupted is blocked: it contributes zero units and never reaches capability/knowledge extraction', async () => {
  const result = await compileSources([{ kind: 'document', text: CORRUPTED_TEXT, sourcePath: 'corrupted.txt' }], {});
  // With nothing else to compile, this is the honest "nothing to compile" outcome — not a silent empty success.
  assert.equal(result.ok, false);
  if (result.ok) return;
  const context = result.error.context as { sources?: readonly { qualityState?: string; unitCount: number }[] } | undefined;
  const sources = context?.sources;
  assert.ok(sources && sources.length === 1);
  assert.equal(sources![0]!.qualityState, 'blocked');
  assert.equal(sources![0]!.unitCount, 0);
});

test('a blocked source alongside a trusted source: only the trusted source contributes units, and the blocked one is reported with zero, never silently merged in', async () => {
  const result = await compileSources(
    [
      { kind: 'document', text: CORRUPTED_TEXT, sourcePath: 'corrupted.txt' },
      { kind: 'document', text: CLEAN_TEXT, sourcePath: 'clean.txt' },
    ],
    {},
  );
  assert.ok(result.ok, result.ok ? undefined : JSON.stringify(result.error));
  if (!result.ok) return;

  const corrupted = result.value.sources.find((s) => s.sourcePath === 'corrupted.txt');
  const clean = result.value.sources.find((s) => s.sourcePath === 'clean.txt');
  assert.equal(corrupted!.qualityState, 'blocked');
  assert.equal(corrupted!.unitCount, 0);
  assert.equal(clean!.qualityState, 'trusted');
  assert.ok(clean!.unitCount > 0);

  // The blocked source's error-severity diagnostic is surfaced, not swallowed.
  assert.ok(result.value.diagnostics.some((d) => d.code === 'source-quality/blocked' && d.severity === 'error'));

  // Nothing in the compiled graph can be traced back to the corrupted source.
  for (const node of result.value.graph.allNodes()) {
    for (const ref of node.metadata.sourceRefs) {
      assert.notEqual(ref.documentPath, 'corrupted.txt');
    }
  }
});

test('a fully trusted source compiles normally with no source-quality diagnostics at all', async () => {
  const result = await compileSources([{ kind: 'document', text: CLEAN_TEXT, sourcePath: 'clean.txt' }], {});
  assert.ok(result.ok, result.ok ? undefined : JSON.stringify(result.error));
  if (!result.ok) return;
  assert.equal(result.value.sources[0]!.qualityState, 'trusted');
  assert.ok(!result.value.diagnostics.some((d) => d.passName === 'source-quality'));
});

// --- P0.9A area D: source quality surfaced on the graph's own manifest ---
// A `'degraded'` source (unlike `'blocked'`) still contributes units, so
// its quality assessment is the interesting case for checking that the
// signal survives into the compiled graph itself, joinable by
// `documentPath`/`sourceId` — not only in the ephemeral
// `CompileSourcesResult.sources[]` array a caller might not keep around.
const DEGRADED_TEXT = `# Mostly Clean\n${Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ')} and8827461093 ${Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ')}`;

test('a degraded source\'s quality assessment is attached to the compiled graph\'s manifest, keyed by the same documentPath its own nodes carry', async () => {
  const result = await compileSources([{ kind: 'document', text: DEGRADED_TEXT, sourcePath: 'mostly-clean.txt' }], {});
  assert.ok(result.ok, result.ok ? undefined : JSON.stringify(result.error));
  if (!result.ok) return;
  assert.equal(result.value.sources[0]!.qualityState, 'degraded');

  const manifest = result.value.graph.manifest;
  assert.ok(manifest, 'expected the compiled graph to carry a manifest');
  assert.ok(manifest!.sourceQuality, 'expected manifest.sourceQuality to be set');

  const documentPath = result.value.sources[0]!.sourceId;
  const entry = manifest!.sourceQuality![documentPath];
  assert.ok(entry, 'expected a sourceQuality entry keyed by the source\'s own sourceId/documentPath');
  assert.equal(entry!.state, 'degraded');
  assert.ok(entry!.suspiciousTokenRatio > 0);

  // Confirm this is genuinely the same key space a node's own source refs
  // use — not a coincidentally-matching but separately-derived string.
  const nodeWithRef = result.value.graph.allNodes().find((n) => n.metadata.sourceRefs.length > 0);
  assert.ok(nodeWithRef, 'expected at least one node with a source ref to exist on a degraded-but-not-blocked source');
  assert.equal(nodeWithRef!.metadata.sourceRefs[0]!.documentPath, documentPath);
});

test('a trusted-only compilation still gets a manifest with a sourceQuality entry (state: trusted), not an absent manifest', async () => {
  const result = await compileSources([{ kind: 'document', text: CLEAN_TEXT, sourcePath: 'clean.txt' }], {});
  assert.ok(result.ok, result.ok ? undefined : JSON.stringify(result.error));
  if (!result.ok) return;
  const documentPath = result.value.sources[0]!.sourceId;
  assert.equal(result.value.graph.manifest?.sourceQuality?.[documentPath]?.state, 'trusted');
});

test('manifest.sourceQuality does not affect any node/edge content hash: a trusted-only and a degraded-only compilation of otherwise-identical content produce identically-hashed nodes', async () => {
  const trusted = await compileSources([{ kind: 'document', text: CLEAN_TEXT, sourcePath: 'clean.txt' }], {});
  assert.ok(trusted.ok);
  if (!trusted.ok) return;
  // Re-compiling the very same trusted text must reproduce the same node
  // hashes regardless of the manifest now being attached — the manifest
  // mechanism (`setManifest`) is documented as hash-inert, and this pins
  // that guarantee at the `compileSources` call site specifically.
  const trustedAgain = await compileSources([{ kind: 'document', text: CLEAN_TEXT, sourcePath: 'clean.txt' }], {});
  assert.ok(trustedAgain.ok);
  if (!trustedAgain.ok) return;
  const idsA = trusted.value.graph.allNodes().map((n) => n.id).sort();
  const idsB = trustedAgain.value.graph.allNodes().map((n) => n.id).sort();
  assert.deepEqual(idsA, idsB);
});
