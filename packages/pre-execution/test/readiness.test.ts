/**
 * PX-7 — the Workflow Readiness Certificate: the false-ready corpus (every way a workflow must NOT be called ready),
 * conditions, staleness, tampering. (ADR 0029 decisions 14-15; gaps PX-G24, PX-G25.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { composeWorkflows, type CandidateWorkflow } from '@xo/workflow-composer';
import {
  assessCompleteness,
  assessReadiness,
  assessSourceQuality,
  buildCapabilityInventory,
  compileSourceSet,
  defaultCompileConfiguration,
  goalSpecification,
  lowerCandidateWorkflow,
  readinessBindings,
  selectWorkflowScope,
  verifyReadinessCertificate,
  type ReadinessInput,
} from '../src/index.js';

const PROCEDURE =
  '# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code from the main branch. | The working copy matches main. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n';
const CONFLICT = `${PROCEDURE}\n# Refunds\n\nIf the refund amount exceeds 500, the refund must be denied.\n\nIf the refund amount exceeds 500, the refund must be approved.\n`;

async function setup(
  text: string,
  opts: { approved?: boolean; needs?: string[]; dropFromInventory?: string } = {},
): Promise<ReadinessInput> {
  const bytes = new TextEncoder().encode(text);
  const entry = {
    sourceId: 'src_1',
    digestSha256: createHash('sha256').update(bytes).digest('hex'),
    name: 'ops.md',
    byteSize: bytes.length,
    role: 'primary' as const,
  };
  const compiled = await compileSourceSet(
    [{ entry, input: { kind: 'document', text, sourcePath: 'ops.md' } }],
    defaultCompileConfiguration({}),
  );
  assert.ok(compiled.ok);
  if (!compiled.ok) throw new Error();
  const { artifact, result } = compiled.value;
  const workflows = composeWorkflows(result.graph, { now: () => '1970-01-01T00:00:00.000Z' });
  assert.ok(workflows.ok);
  if (!workflows.ok) throw new Error();
  const goal = goalSpecification({ text: 'Ship a release', needs: opts.needs ?? ['Run the full test suite'] });
  const yes = { value: 'yes' as const, reason: 'approved' };
  const no = { value: 'no' as const, reason: 'not approved for its current contract' };
  let inventory = buildCapabilityInventory(result.graph, {
    artifactDigest: artifact.digest,
    authorize: () => (opts.approved === false ? no : yes),
    needs: goal.needs ?? [],
  });
  if (opts.dropFromInventory !== undefined)
    inventory = { ...inventory, capabilities: inventory.capabilities.filter((c) => c.name !== opts.dropFromInventory) };
  const scope = selectWorkflowScope(workflows.value, goal);
  const candidate: CandidateWorkflow =
    workflows.value.find((w) => scope.status === 'selected' && w.id === scope.workflowId) ?? workflows.value[0]!;
  return {
    artifact,
    sourceQuality: assessSourceQuality(artifact, [], 'readiness'),
    completeness: assessCompleteness(artifact, []),
    inventory,
    candidate,
    lowered: lowerCandidateWorkflow(result.graph, candidate, inventory),
    goal,
    scope,
    issuedBy: { id: 'u1', kind: 'human' },
    issuedAt: '2026-11-16T00:00:00.000Z',
  };
}

test('READY: everything bound, approved, complete; the certificate verifies against its own bindings', async () => {
  const input = await setup(PROCEDURE);
  const cert = assessReadiness(input);
  assert.equal(cert.status, 'READY', JSON.stringify(cert.gates.filter((g) => g.outcome !== 'pass')));
  assert.match(cert.certificateId, /^wrc_[0-9a-f]{24}$/);
  assert.deepEqual(verifyReadinessCertificate(cert, readinessBindings(input)), { ok: true });
  assert.deepEqual(
    cert.gates.map((g) => g.id),
    ['source-quality', 'completeness', 'knowledge', 'goal', 'capabilities', 'authorization', 'workflow-definition'],
  );
});

test('false-ready corpus: each of these is never READY', async () => {
  // not approved
  const unapproved = assessReadiness(await setup(PROCEDURE, { approved: false }));
  assert.equal(unapproved.status, 'NEEDS_REVIEW');
  assert.equal(unapproved.gates.find((g) => g.id === 'authorization')!.outcome, 'review');
  // an open conflict in the sources
  const conflicted = assessReadiness(await setup(CONFLICT));
  assert.notEqual(conflicted.status, 'READY');
  assert.equal(conflicted.gates.find((g) => g.id === 'completeness')!.outcome, 'review');
  // the goal needs a step nobody provides
  const gap = assessReadiness(await setup(PROCEDURE, { needs: ['Run the full test suite', 'Deploy to production'] }));
  assert.equal(gap.status, 'BLOCKED');
  assert.ok(gap.blockers.some((b) => b.includes('Deploy to production')));
  // a step that is not bound
  const unbound = assessReadiness(await setup(PROCEDURE, { dropFromInventory: 'Run the full test suite' }));
  assert.equal(unbound.status, 'BLOCKED');
  // a blocked source
  const base = await setup(PROCEDURE);
  const blockedSource = assessReadiness({
    ...base,
    sourceQuality: { ...base.sourceQuality, status: 'blocked', blockers: ['"ops.md" is blocked'] },
  });
  assert.equal(blockedSource.status, 'BLOCKED');
  // an unresolved knowledge conflict
  const knowledge = assessReadiness({ ...base, knowledge: { stateId: 'ks_1', digest: 'sha256:x', unresolvedConflicts: ['cfl_1'] } });
  assert.equal(knowledge.status, 'NEEDS_REVIEW');
  // the goal asks a question instead of selecting
  const asked = assessReadiness({ ...base, scope: { status: 'needs_clarification', question: 'Which one?', options: [], ranking: [] } });
  assert.equal(asked.status, 'NEEDS_REVIEW');
  // a circular step order
  const circular = assessReadiness({
    ...base,
    candidate: { ...base.candidate, gaps: [{ kind: 'circular_dependency', description: 'a needs b needs a', involvedCapabilityIds: [] }] },
  });
  assert.equal(circular.status, 'BLOCKED');
});

test('READY_WITH_CONDITIONS only for a declared, accepted condition; not accepted it needs review', async () => {
  const base = await setup(PROCEDURE);
  const tied = {
    ...base.candidate,
    gaps: [{ kind: 'ambiguous_precedence' as const, description: 'two steps have no stated order', involvedCapabilityIds: [] }],
  };
  assert.equal(assessReadiness({ ...base, candidate: tied }).status, 'NEEDS_REVIEW');
  const accepted = assessReadiness({ ...base, candidate: tied, accepted: { ambiguousStepOrder: true } });
  assert.equal(accepted.status, 'READY_WITH_CONDITIONS');
  assert.equal(accepted.conditions.length, 1);
  assert.deepEqual(verifyReadinessCertificate(accepted, readinessBindings({ ...base, candidate: tied })), { ok: true });
});

test('stale, tampered and not-ready certificates are refused at verification', async () => {
  const input = await setup(PROCEDURE);
  const cert = assessReadiness(input);
  const now = readinessBindings(input);
  const stale = (patch: Partial<typeof now>): readonly string[] => {
    const v = verifyReadinessCertificate(cert, { ...now, ...patch });
    return v.ok ? [] : v.reasons;
  };
  assert.match(stale({ inventoryDigest: 'sha256:other' }).join(), /capability inventory changed/);
  assert.match(stale({ workflowDefinitionDigest: 'sha256:other' }).join(), /workflow definition changed/);
  assert.match(stale({ knowledgeState: { stateId: 'ks_2', digest: 'sha256:y' } }).join(), /knowledge state changed/);
  assert.match(stale({ goalDigest: 'sha256:other' }).join(), /goal changed/);
  assert.match(stale({ decisions: ['sha256:new-waiver'] }).join(), /waivers and rulings changed/);
  const firstStep = Object.keys(now.contractHashes)[0]!;
  assert.match(stale({ contractHashes: { ...now.contractHashes, [firstStep]: 'sha256:changed' } }).join(), /contract of/);
  const tampered = verifyReadinessCertificate({ ...cert, status: 'READY', blockers: [], gates: [] }, now);
  assert.equal(tampered.ok, false);
  const notReady = assessReadiness(await setup(PROCEDURE, { approved: false }));
  const v = verifyReadinessCertificate(notReady, readinessBindings(await setup(PROCEDURE, { approved: false })));
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.reasons.join(), /NEEDS_REVIEW, which does not allow a start/);
});

test('the certificate is deterministic for the same inputs', async () => {
  const a = assessReadiness(await setup(PROCEDURE));
  const b = assessReadiness(await setup(PROCEDURE));
  assert.equal(a.digest, b.digest);
});
