/**
 * PX-3 — validity is not completeness; open work closes only by a recorded, version-bound human ruling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  assessCompleteness,
  compileSourceSet,
  confirmedRulesFrom,
  createHumanRuling,
  defaultCompileConfiguration,
  verifyHumanRuling,
  type CompilationArtifact,
  type SourceSetMember,
} from '../src/index.js';

const ACTOR = { id: 'reviewer-1', kind: 'user' };
const NOW = '2026-11-15T10:00:00.000Z';
const m = (name: string, text: string): SourceSetMember => ({
  entry: { sourceId: name, digestSha256: createHash('sha256').update(text).digest('hex'), name, byteSize: text.length, role: 'primary' },
  input: { kind: 'document', text, sourcePath: name },
});
const A = '# Refunds\n\nIf the refund amount exceeds 500, the refund must be denied.\n\nStaff should keep receipts where practical.\n';
const B = (limit = 500) => `# Refunds update\n\nIf the refund amount exceeds ${limit}, the refund must be approved.\n`;

async function compile(b = B()): Promise<CompilationArtifact> {
  const r = await compileSourceSet([m('a.md', A), m('b.md', b)], defaultCompileConfiguration(), { now: () => NOW });
  assert.ok(r.ok, r.ok ? '' : r.error.message);
  return r.value.artifact;
}

const items = (a: CompilationArtifact) => (a.reviewQueue as { items: { id: string; kind: string; priority: number }[] }).items;

test('a valid graph can be incomplete: an unresolved conflict and a decision-needing item keep it open; informational items do not', async () => {
  const artifact = await compile();
  const c = assessCompleteness(artifact);
  assert.equal(c.valid, true);
  assert.equal(c.complete, false);
  assert.equal(c.dimensions.find((d) => d.id === 'conflicts')!.status, 'incomplete');
  assert.equal(c.dimensions.find((d) => d.id === 'structure')!.status, 'complete');
  assert.equal(c.dimensions.find((d) => d.id === 'source-coverage')!.status, 'complete');
  const open = c.dimensions.flatMap((d) => d.open.map((o) => o.detail));
  assert.ok(!open.some((d) => /Not a mandatory rule/.test(d)), 'priority-3 items never block');
  const ids = items(artifact).map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'each review item appears once');
});

test('rulings close items: resolve-conflict for the conflict, acknowledge for a human-required item; the result is complete', async () => {
  const artifact = await compile();
  const conflict = items(artifact).find((i) => i.kind === 'conflict')!;
  const human = items(artifact).find((i) => i.kind === 'human-required')!;
  assert.throws(
    () =>
      createHumanRuling({
        artifact,
        reviewItemId: conflict.id,
        decision: { kind: 'acknowledge', note: 'fine' },
        actor: ACTOR,
        createdAt: NOW,
      }),
    /needs a resolve-conflict ruling/,
  );
  const r1 = createHumanRuling({
    artifact,
    reviewItemId: conflict.id,
    decision: { kind: 'resolve-conflict', prevails: 'b', rationale: 'b.md is the newer refund policy and supersedes a.md.' },
    actor: ACTOR,
    createdAt: NOW,
  });
  const r2 = createHumanRuling({
    artifact,
    reviewItemId: human.id,
    decision: { kind: 'acknowledge', note: 'A refunds officer approves these by hand.' },
    actor: ACTOR,
    createdAt: NOW,
  });
  assert.ok(verifyHumanRuling(r1) && verifyHumanRuling(r2));
  assert.equal(r1.evidence.length > 0, true, 'the ruling keeps the text it was made on');
  const c = assessCompleteness(artifact, [r1, r2]);
  assert.equal(c.complete, true, JSON.stringify(c.dimensions.filter((d) => d.status === 'incomplete')));
  assert.deepEqual([...c.appliedRulings].sort(), [r1.rulingId, r2.rulingId].sort());
});

test('a ruling is bound to its source set and its text: a changed sentence makes it stale; another set ignores it', async () => {
  const artifact = await compile();
  const conflict = items(artifact).find((i) => i.kind === 'conflict')!;
  const ruling = createHumanRuling({
    artifact,
    reviewItemId: conflict.id,
    decision: { kind: 'resolve-conflict', prevails: 'a', rationale: 'a.md is the board-approved policy.' },
    actor: ACTOR,
    createdAt: NOW,
  });
  const changed = await compile(B(600));
  assert.notEqual(changed.sourceSet.sourceSetId, artifact.sourceSet.sourceSetId);
  const c = assessCompleteness(changed, [ruling]);
  assert.deepEqual(c.appliedRulings, [], 'a ruling on another source set does not apply');
  // Same set id but the item text changed: simulate by asking a fresh compilation of the same set with an edited artifact.
  const sameSetDifferentItems = { ...artifact, reviewQueue: { items: [] } } as CompilationArtifact;
  assert.deepEqual(
    assessCompleteness(sameSetDifferentItems, [ruling]).staleRulings.map((s) => s.reason),
    ['the item it ruled on is no longer in this compilation (its text changed)'],
  );
  const tampered = {
    ...ruling,
    decision: {
      kind: 'resolve-conflict' as const,
      prevails: 'b' as const,
      rationale: ruling.decision.kind === 'resolve-conflict' ? ruling.decision.rationale : '',
    },
  };
  assert.equal(assessCompleteness(artifact, [tampered]).staleRulings[0]!.reason, 'its digest does not match its content');
});

test('a confirm-rule ruling becomes a confirmed rule for the next compilation of the same set', async () => {
  const artifact = await compile();
  const human = items(artifact).find((i) => i.kind === 'human-required')!;
  const ruling = createHumanRuling({
    artifact,
    reviewItemId: human.id,
    decision: { kind: 'confirm-rule', condition: 'refund amount exceeds 500', outcome: 'requires_approval' },
    actor: ACTOR,
    createdAt: NOW,
  });
  const rules = confirmedRulesFrom([ruling], artifact.sourceSet.sourceSetId);
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.confirmedBy, 'reviewer-1');
  assert.deepEqual(confirmedRulesFrom([ruling], 'ss_other'), []);
  const next = await compileSourceSet([m('a.md', A), m('b.md', B())], defaultCompileConfiguration({ confirmedRules: rules }), {
    now: () => NOW,
  });
  assert.ok(next.ok);
  assert.notEqual(next.value.artifact.configurationDigest, artifact.configurationDigest, 'the ruling is part of the configuration');
});
