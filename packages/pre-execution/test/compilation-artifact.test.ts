/**
 * PX-1 — the complete compilation artifact: every part of the compiler's result is kept, bound to the source set and the
 * configuration, and content-addressed (the same set and configuration give the same digest; any change gives another).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  artifactOpenWork,
  compileSourceSet,
  defaultCompileConfiguration,
  toCompileSourcesOptions,
  verifyCompilationArtifact,
  type SourceSetMember,
} from '../src/index.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const NOW = () => '2026-01-01T00:00:00.000Z';

function member(name: string, bytes: Uint8Array, input: unknown): SourceSetMember {
  const digest = createHash('sha256').update(bytes).digest('hex');
  return { entry: { sourceId: `src_${digest.slice(0, 32)}`, digestSha256: digest, name, byteSize: bytes.length, role: 'primary' }, input };
}

const MD = [
  '# Leave policy',
  '',
  '## Steps',
  '',
  '1. Submit the leave request to your manager.',
  '2. Record the approved leave in the HR system.',
  '',
  'Employees must give 10 days notice for planned leave.',
  'A request over 15 days requires approval by the director.',
  'Purchases are reviewed quarterly by the finance team in line with procurement rules.',
].join('\n');

async function compileMd(text = MD, configuration = defaultCompileConfiguration()) {
  const bytes = new TextEncoder().encode(text);
  const r = await compileSourceSet([member('leave.md', bytes, { kind: 'document', text, sourcePath: 'leave.md' })], configuration, {
    now: NOW,
  });
  assert.ok(r.ok, r.ok ? '' : r.error.message);
  return r.value;
}

test('the artifact keeps every part of the result, and verifies', async () => {
  const { artifact, result } = await compileMd();
  for (const key of [
    'validation',
    'diagnostics',
    'passRuns',
    'stats',
    'sources',
    'unclassified',
    'executionReadiness',
    'reviewQueue',
    'crossDocument',
  ])
    assert.ok(key in artifact, `artifact.${key}`);
  assert.equal(artifact.graph.contentHash, result.graph.contentHash());
  assert.equal(artifact.valid, result.valid);
  assert.match(artifact.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(verifyCompilationArtifact(artifact), { ok: true });
  const sources = artifact.sources as { parserVersion?: string }[];
  assert.equal(sources[0]!.parserVersion, 'document@uw-3c.1', 'each source names the reader version');
  const work = artifactOpenWork(artifact);
  assert.equal(typeof work.reviewItems, 'number');
});

test('reproducible: the same sources and configuration give the same digest; timings do not count', async () => {
  const a = await compileMd();
  const b = await compileMd();
  assert.equal(a.artifact.digest, b.artifact.digest);
  assert.equal(a.sourceSet.sourceSetId, b.sourceSet.sourceSetId);
});

test('a changed byte, or a changed configuration, gives a different artifact', async () => {
  const a = await compileMd();
  const changed = await compileMd(MD.replace('10 days', '12 days'));
  assert.notEqual(changed.sourceSet.sourceSetId, a.sourceSet.sourceSetId);
  assert.notEqual(changed.artifact.digest, a.artifact.digest);
  const otherConfig = await compileMd(MD, defaultCompileConfiguration({ policy: 'off' }));
  assert.notEqual(otherConfig.artifact.configurationDigest, a.artifact.configurationDigest);
  assert.notEqual(otherConfig.artifact.digest, a.artifact.digest);
});

test('tampering with a stored artifact is detected', async () => {
  const { artifact } = await compileMd();
  const forged = { ...artifact, unclassified: [...(artifact.unclassified as unknown[]), { sentence: 'injected' }] };
  assert.equal(verifyCompilationArtifact(forged).ok, false);
  const reconfigured = { ...artifact, configuration: { ...artifact.configuration, domainHint: 'x' } };
  assert.equal(verifyCompilationArtifact(reconfigured).ok, false);
});

test('a configuration asking for OCR with no engine supplied is compiled, and the run says so', async () => {
  const { artifact } = await compileMd(MD, defaultCompileConfiguration({ ocr: { mode: 'local' } }));
  assert.equal(artifact.runNotes.length, 1);
  assert.match(artifact.runNotes[0]!, /no recovery tier was supplied/);
});

test('one options builder: precedence, connectors, confirmed rules and policy all reach the compiler', () => {
  const options = toCompileSourcesOptions(
    defaultCompileConfiguration({
      precedence: ['a.pdf', 'b.pdf'],
      connectors: [{ id: 'crm', operations: ['create_record'] }],
      policy: 'off',
      domainHint: 'insurance',
    }),
  );
  assert.deepEqual(options.precedence, { order: ['a.pdf', 'b.pdf'] });
  assert.deepEqual(options.connectors, [{ id: 'crm', operations: ['create_record'] }]);
  assert.equal(options.policy, false);
  assert.equal(options.domainHint, 'insurance');
  assert.equal(options.pageTiers, undefined, 'no OCR tiers unless the configuration asks and the runtime supplies them');
});

test('a real PDF: the artifact carries per-page coverage and the quality state', async () => {
  const bytes = new Uint8Array(await readFile(`${ROOT}examples/vertical-test/burglary-policy.pdf`));
  const r = await compileSourceSet(
    [member('burglary-policy.pdf', bytes, { kind: 'pdf', bytes, sourcePath: 'burglary-policy.pdf' })],
    defaultCompileConfiguration(),
    {
      now: NOW,
    },
  );
  assert.ok(r.ok);
  const source = (r.value.artifact.sources as { qualityState?: string; coverage?: { entries?: unknown[] } }[])[0]!;
  assert.ok(['trusted', 'degraded', 'partial'].includes(source.qualityState!));
  assert.ok(Array.isArray(source.coverage?.entries) && source.coverage.entries.length > 0, 'per-page coverage is kept');
});
