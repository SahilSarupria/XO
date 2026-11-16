/**
 * PX-2 — source quality policy and digest-bound waivers (spec §4.3).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  assessSourceQuality,
  buildSourceSet,
  createSourceWaiver,
  sourceQualityOf,
  verifySourceWaiver,
  type CompilationArtifact,
} from '../src/index.js';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const ACTOR = { id: 'reviewer-1', kind: 'user' };
const NOW = '2026-11-15T10:00:00.000Z';

/** A minimal artifact view: the quality gate reads only the source set and the per-source reports. */
function artifactWith(
  sources: {
    name: string;
    content: string;
    qualityState?: string;
    pages?: { page: number; status: string; recoveredBy?: string; reason?: string }[];
  }[],
): CompilationArtifact {
  const sourceSet = buildSourceSet(
    sources.map((s) => ({
      sourceId: `src_${s.name}`,
      digestSha256: sha(s.content),
      name: s.name,
      byteSize: s.content.length,
      role: 'primary' as const,
    })),
  );
  return {
    sourceSet,
    sources: sources.map((s) => ({
      sourcePath: s.name,
      ...(s.qualityState !== undefined ? { qualityState: s.qualityState } : {}),
      ...(s.pages !== undefined ? { coverage: { entries: s.pages } } : {}),
    })),
  } as unknown as CompilationArtifact;
}

const PARTIAL = {
  name: 'policy.pdf',
  content: 'v1',
  qualityState: 'partial',
  pages: [
    { page: 1, status: 'extracted' },
    { page: 2, status: 'unaccounted', reason: 'no-text-layer' },
    { page: 3, status: 'unaccounted', reason: 'no-text-layer' },
  ],
};

test('findings: unread pages, model-only pages, degraded and blocked text each get a stable key', () => {
  const q = sourceQualityOf(
    artifactWith([
      PARTIAL,
      { name: 'scan.pdf', content: 's', qualityState: 'degraded', pages: [{ page: 1, status: 'ocr', recoveredBy: 'model' }] },
      { name: 'garbled.pdf', content: 'g', qualityState: 'blocked' },
      { name: 'notes.md', content: 'n', qualityState: 'trusted' },
    ]),
  );
  assert.deepEqual(
    q[0]!.findings.map((f) => f.key),
    ['page:2:unread', 'page:3:unread'],
  );
  assert.deepEqual(
    q[1]!.findings.map((f) => f.key),
    ['page:1:model-transcribed'],
  );
  assert.deepEqual(
    q[2]!.findings.map((f) => f.key),
    ['text:blocked'],
  );
  assert.deepEqual(q[3]!.findings, []);
});

test('a partial source blocks approval and readiness until a waiver covers every finding', () => {
  const artifact = artifactWith([PARTIAL]);
  const before = assessSourceQuality(artifact, [], 'approval');
  assert.equal(before.status, 'blocked');
  assert.match(before.blockers[0]!, /partial: 2 finding\(s\) without a waiver/);

  const entry = sourceQualityOf(artifact)[0]!;
  const onePage = createSourceWaiver({
    entry,
    reason: 'Page 2 is a blank separator sheet.',
    actor: ACTOR,
    createdAt: NOW,
    findings: ['page:2:unread'],
  });
  assert.equal(assessSourceQuality(artifact, [onePage], 'approval').status, 'blocked', 'a waiver covers only the findings it names');

  const all = createSourceWaiver({
    entry,
    reason: 'Pages 2-3 are the scanned signature pages; no rules there.',
    actor: ACTOR,
    createdAt: NOW,
  });
  const after = assessSourceQuality(artifact, [all], 'approval');
  assert.equal(after.status, 'pass-with-waivers');
  assert.deepEqual(
    after.appliedWaivers.map((w) => w.waiverId),
    [all.waiverId],
  );
  assert.equal(assessSourceQuality(artifact, [all], 'readiness').status, 'pass-with-waivers');
});

test('a waiver does not carry over to another version, another quality state, or a purpose outside its scope', () => {
  const v1 = artifactWith([PARTIAL]);
  const waiver = createSourceWaiver({
    entry: sourceQualityOf(v1)[0]!,
    reason: 'Signature pages carry no rules.',
    actor: ACTOR,
    createdAt: NOW,
    scope: ['approval'],
  });
  const v2 = artifactWith([{ ...PARTIAL, content: 'v2' }]);
  assert.equal(assessSourceQuality(v2, [waiver], 'approval').status, 'blocked', 'a new upload of changed bytes needs a new waiver');
  assert.equal(assessSourceQuality(v1, [waiver], 'readiness').status, 'blocked', 'an approval-only waiver does not make a workflow ready');
  const nowDegraded = artifactWith([{ ...PARTIAL, qualityState: 'degraded' }]);
  const r = assessSourceQuality(nowDegraded, [waiver], 'approval');
  assert.equal(r.status, 'blocked');
  assert.match(r.rejectedWaivers[0]!.reason, /recorded for a partial reading/);
});

test('blocked sources cannot be waived; trusted sources need nothing; tampered waivers are rejected', () => {
  const blocked = artifactWith([{ name: 'garbled.pdf', content: 'g', qualityState: 'blocked' }]);
  assert.throws(
    () => createSourceWaiver({ entry: sourceQualityOf(blocked)[0]!, reason: 'Accept it anyway please.', actor: ACTOR, createdAt: NOW }),
    /blocked: there is no reading to waive/,
  );
  assert.equal(assessSourceQuality(blocked, [], 'approval').status, 'blocked');
  assert.equal(assessSourceQuality(artifactWith([{ name: 'n.md', content: 'n', qualityState: 'trusted' }]), [], 'approval').status, 'pass');

  const artifact = artifactWith([PARTIAL]);
  const waiver = createSourceWaiver({
    entry: sourceQualityOf(artifact)[0]!,
    reason: 'Signature pages carry no rules.',
    actor: ACTOR,
    createdAt: NOW,
  });
  assert.equal(verifySourceWaiver(waiver), true);
  const widened = { ...waiver, findings: [...waiver.findings, 'page:9:unread'] };
  assert.equal(verifySourceWaiver(widened), false);
  const r = assessSourceQuality(artifact, [{ ...waiver, actor: { id: 'someone-else', kind: 'user' } }], 'approval');
  assert.equal(r.status, 'blocked');
  assert.match(r.rejectedWaivers[0]!.reason, /digest does not match/);
});

test('a waiver needs a reason, and can only name current findings', () => {
  const entry = sourceQualityOf(artifactWith([PARTIAL]))[0]!;
  assert.throws(() => createSourceWaiver({ entry, reason: 'ok', actor: ACTOR, createdAt: NOW }), /reason/);
  assert.throws(
    () => createSourceWaiver({ entry, reason: 'A long enough reason.', actor: ACTOR, createdAt: NOW, findings: ['page:7:unread'] }),
    /not a current finding/,
  );
});
