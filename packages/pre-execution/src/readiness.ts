/**
 * PX-7 — the Workflow Readiness Certificate (gaps PX-G24, PX-G25; ADR 0029 decisions 14 and 15).
 *
 * `assessReadiness` takes everything the pre-execution pipeline produced for ONE workflow — the compilation artifact,
 * source quality, completeness, the knowledge state, the capability inventory, the goal and its scope selection, and the
 * lowered Workflow IR — and issues a certificate:
 *
 *   status    READY | READY_WITH_CONDITIONS | NEEDS_REVIEW | BLOCKED
 *   gates     one per concern, each pass / condition / review / block with the findings that decided it
 *   bindings  the digest of every input the status depends on (decision 15)
 *   digest    SHA-256 of the certificate's canonical JSON without `digest`
 *
 * The rules (decision 14): any block → BLOCKED; else any review → NEEDS_REVIEW; else any condition →
 * READY_WITH_CONDITIONS; else READY. A condition is allowed only for the declared, bounded cases — an ambiguous step
 * order the owner accepted, or a coverage gap with a recorded waiver. Mandatory gates (source quality, binding, runtime
 * support, the workflow definition, approval) never degrade to conditions.
 *
 * `verifyReadinessCertificate` re-checks a certificate against freshly computed bindings: a certificate whose own digest
 * fails, whose status does not allow a start, or any of whose bindings differs from the current one is refused as stale.
 */
import type { CandidateWorkflow } from '@xo/workflow-composer';
import { digestOf, type Digest } from './canonical.js';
import type { CapabilityInventory } from './capability-inventory.js';
import type { CompilationArtifact } from './compilation-artifact.js';
import type { CompletenessAssessment } from './completeness.js';
import { goalDigest, type GoalSpecification, type ScopeSelection } from './goal.js';
import type { ConnectorBinding, LoweredWorkflow } from './lower-workflow.js';
import type { SourceQualityAssessment } from './source-quality.js';

export const READINESS_CERTIFICATE_SCHEMA = 'xo.workflow-readiness-certificate.v1';
/**
 * v2 (ADR 0030): the two declared, bounded conditions of ADR 0029 decision 14 — an unstated step order the owner accepted,
 * and a source-quality finding covered by a recorded waiver — and the workspace's connector bindings are bound.
 */
export const READINESS_POLICY_VERSION = 'xo.readiness-policy.v2';

export type ReadinessStatus = 'READY' | 'READY_WITH_CONDITIONS' | 'NEEDS_REVIEW' | 'BLOCKED';
export type GateOutcome = 'pass' | 'condition' | 'review' | 'block';
export type ReadinessGateId =
  'source-quality' | 'completeness' | 'knowledge' | 'goal' | 'capabilities' | 'authorization' | 'workflow-definition';

export interface ReadinessGate {
  readonly id: ReadinessGateId;
  readonly outcome: GateOutcome;
  /** What decided the outcome, one finding per line; for a pass, what was checked. */
  readonly findings: readonly string[];
}

/** Every input the status depends on, by digest (decision 15). Any of them changing makes the certificate stale. */
export interface CertificateBindings {
  readonly sourceSetId: string;
  readonly sourceSetDigest: string;
  readonly artifactDigest: string;
  readonly xoirGraphHash: string;
  /** The pinned knowledge state, or null when the workspace pins none. */
  readonly knowledgeState: { readonly stateId: string; readonly digest: string } | null;
  readonly inventoryDigest: string;
  /** Content hash of the contract of each workflow step, by capability id. */
  readonly contractHashes: Readonly<Record<string, string>>;
  readonly workflowDefinitionDigest: string;
  readonly goalDigest: string;
  /** Digest of the connector bindings the workflow's act steps use (empty list when none). */
  readonly connectorBindingsDigest: string;
  /** Digests of the waivers and rulings the assessment applied (sorted). */
  readonly decisions: readonly string[];
  readonly policyVersion: typeof READINESS_POLICY_VERSION;
}

export interface WorkflowReadinessCertificate {
  readonly schema: typeof READINESS_CERTIFICATE_SCHEMA;
  /** `wrc_` + the first 24 hex characters of the digest. */
  readonly certificateId: string;
  readonly status: ReadinessStatus;
  readonly scope: {
    readonly compilationId?: string;
    /** The generated workflow (`gwf_…`) the certificate is for, when issued through the API. */
    readonly definitionId?: string;
    readonly candidateWorkflowId: string;
    readonly workflowName: string;
  };
  readonly goal: GoalSpecification;
  readonly gates: readonly ReadinessGate[];
  /** Blocking findings across gates; empty unless BLOCKED. */
  readonly blockers: readonly string[];
  /** Review findings; a person must act on each before start. */
  readonly reviewItems: readonly string[];
  /** Declared, bounded conditions the start proceeds under. */
  readonly conditions: readonly string[];
  readonly bindings: CertificateBindings;
  readonly issuedAt: string;
  readonly issuedBy: { readonly id: string; readonly kind: string };
  readonly digest: Digest;
}

export interface ReadinessInput {
  readonly artifact: CompilationArtifact;
  readonly sourceQuality: SourceQualityAssessment;
  readonly completeness: CompletenessAssessment;
  readonly inventory: CapabilityInventory;
  readonly candidate: CandidateWorkflow;
  readonly lowered: LoweredWorkflow;
  readonly goal: GoalSpecification;
  /** The scope selection that chose `candidate`, when the goal chose it (absent: the workflow was named explicitly). */
  readonly scope?: ScopeSelection;
  readonly knowledge?: { readonly stateId: string; readonly digest: string; readonly unresolvedConflicts: readonly string[] };
  /** Owner-accepted bounded conditions (decision 14). */
  readonly accepted?: { readonly ambiguousStepOrder?: boolean };
  /** Digests of the waivers and rulings applied in the assessments (bound so a revoked decision makes the certificate stale). */
  readonly decisionDigests?: readonly string[];
  /** The connector bindings the lowering used (bound so a changed binding makes the certificate stale). */
  readonly connectorBindings?: readonly ConnectorBinding[];
  readonly compilationId?: string;
  readonly definitionId?: string;
  readonly issuedBy: { readonly id: string; readonly kind: string };
  readonly issuedAt: string;
}

/** The bindings of the inputs as they are now (used both to issue and to verify). */
export function readinessBindings(
  input: Omit<
    ReadinessInput,
    'sourceQuality' | 'completeness' | 'scope' | 'accepted' | 'issuedBy' | 'issuedAt' | 'compilationId' | 'definitionId'
  >,
): CertificateBindings {
  const stepIds = new Set(input.candidate.steps.map((s) => s.capabilityId));
  const contractHashes: Record<string, string> = {};
  for (const c of input.inventory.capabilities) if (stepIds.has(c.capabilityId)) contractHashes[c.capabilityId] = c.contractHash;
  return {
    sourceSetId: input.artifact.sourceSet.sourceSetId,
    sourceSetDigest: input.artifact.sourceSet.digest,
    artifactDigest: input.artifact.digest,
    xoirGraphHash: input.artifact.graph.contentHash,
    knowledgeState: input.knowledge !== undefined ? { stateId: input.knowledge.stateId, digest: input.knowledge.digest } : null,
    inventoryDigest: input.inventory.digest,
    contractHashes,
    workflowDefinitionDigest: input.lowered.definitionDigest,
    goalDigest: goalDigest(input.goal),
    connectorBindingsDigest: digestOf(
      [...(input.connectorBindings ?? [])]
        .filter((b) => input.candidate.steps.some((st) => st.capabilityName === b.capability))
        .sort((a, b) => a.capability.localeCompare(b.capability)),
    ),
    decisions: [...(input.decisionDigests ?? [])].sort(),
    policyVersion: READINESS_POLICY_VERSION,
  };
}

function gate(id: ReadinessGateId, findings: { outcome: GateOutcome; text: string }[], passNote: string): ReadinessGate {
  const order: GateOutcome[] = ['block', 'review', 'condition', 'pass'];
  const worst = order.find((o) => findings.some((f) => f.outcome === o)) ?? 'pass';
  const relevant = findings.filter((f) => f.outcome !== 'pass').map((f) => f.text);
  return { id, outcome: worst, findings: worst === 'pass' ? [passNote, ...findings.map((f) => f.text)] : relevant };
}

export function assessReadiness(input: ReadinessInput): WorkflowReadinessCertificate {
  const gates: ReadinessGate[] = [];

  // Source quality: mandatory. A blocked source blocks; a waived one passes (the waiver is bound in `decisions`).
  gates.push(
    gate(
      'source-quality',
      input.sourceQuality.status === 'blocked'
        ? input.sourceQuality.blockers.map((b) => ({ outcome: 'block' as const, text: b }))
        : input.sourceQuality.status === 'pass-with-waivers'
          ? input.sourceQuality.appliedWaivers.map((w) => ({
              outcome: 'condition' as const,
              text: `"${w.sourceName}" is relied on under waiver ${w.waiverId} (${w.findings.length} finding(s) accepted by ${w.actor.id}: ${w.reason})`,
            }))
          : [],
      'every source was read and can be relied on',
    ),
  );

  // Completeness: an invalid graph blocks; anything open needs a person (rulings close items).
  const completeness: { outcome: GateOutcome; text: string }[] = [];
  if (!input.completeness.valid) completeness.push({ outcome: 'block', text: 'the compiled graph is structurally invalid' });
  for (const d of input.completeness.dimensions)
    if (d.status === 'incomplete' && d.id !== 'structure')
      completeness.push({
        outcome: 'review',
        text: `${d.id}: ${d.open.length} open item(s) — ${d.open
          .slice(0, 3)
          .map((o) => o.detail)
          .join('; ')}`,
      });
  for (const s of input.completeness.staleRulings)
    completeness.push({ outcome: 'review', text: `stale ruling ${s.rulingId}: ${s.reason}` });
  gates.push(gate('completeness', completeness, 'nothing is open: every review item, conflict and unread page is closed'));

  // Knowledge: unresolved conflicts in the pinned state need a ruling.
  gates.push(
    gate(
      'knowledge',
      (input.knowledge?.unresolvedConflicts ?? []).map((c) => ({ outcome: 'review' as const, text: `unresolved knowledge conflict ${c}` })),
      input.knowledge !== undefined
        ? `knowledge state ${input.knowledge.stateId} has no unresolved conflict`
        : 'no knowledge state is pinned for this workspace',
    ),
  );

  // Goal: the goal must select this workflow (or the workflow was named explicitly).
  const goalFindings: { outcome: GateOutcome; text: string }[] = [];
  if (input.scope !== undefined) {
    if (input.scope.status === 'no_match') goalFindings.push({ outcome: 'block', text: input.scope.reason });
    else if (input.scope.status === 'needs_clarification') goalFindings.push({ outcome: 'review', text: input.scope.question });
    else if (input.scope.workflowId !== input.candidate.id)
      goalFindings.push({
        outcome: 'block',
        text: `the goal selects ${input.scope.workflowId}, not this workflow (${input.candidate.id})`,
      });
    else goalFindings.push({ outcome: 'pass', text: input.scope.rationale });
  } else goalFindings.push({ outcome: 'pass', text: 'the workflow was named explicitly' });
  for (const gap of input.inventory.gaps) goalFindings.push({ outcome: 'block', text: `the goal needs "${gap.need}": ${gap.reason}` });
  gates.push(gate('goal', goalFindings, `goal: "${input.goal.text}"`));

  // Capabilities and authorization, for the workflow's own steps.
  const reports = new Map(input.inventory.capabilities.map((c) => [c.capabilityId, c] as const));
  const capFindings: { outcome: GateOutcome; text: string }[] = [];
  const authFindings: { outcome: GateOutcome; text: string }[] = [];
  for (const step of input.candidate.steps) {
    const r = reports.get(step.capabilityId);
    if (r === undefined) {
      capFindings.push({ outcome: 'block', text: `"${step.capabilityName}" is not in the capability inventory` });
      continue;
    }
    const a = r.readiness;
    if (r.status === 'rejected' || r.status === 'duplicate')
      capFindings.push({ outcome: 'block', text: `"${r.name}" is ${r.status}: ${r.statusReason}` });
    for (const k of ['eligible', 'bound', 'runtimeSupported'] as const)
      if (a[k].value !== 'yes') capFindings.push({ outcome: 'block', text: `"${r.name}" ${k}: ${a[k].reason}` });
    for (const c of a.conditions) capFindings.push({ outcome: 'review', text: `"${r.name}": ${c}` });
    if (a.authorized.value !== 'yes') authFindings.push({ outcome: 'review', text: `"${r.name}": ${a.authorized.reason}` });
  }
  gates.push(
    gate('capabilities', capFindings, `${input.candidate.steps.length} step(s), each eligible, bound and supported by the runtime`),
  );
  gates.push(gate('authorization', authFindings, 'every step is approved for its current contract (permission is rechecked at start)'));

  // Workflow definition: mandatory; plus the composer's own gaps.
  const wf: { outcome: GateOutcome; text: string }[] = input.lowered.issues.map((i) => ({
    outcome: i.severity === 'blocking' ? ('block' as const) : ('review' as const),
    text: i.message,
  }));
  for (const g of input.candidate.gaps) {
    switch (g.kind) {
      case 'circular_dependency':
      case 'conflicting_capabilities':
        wf.push({ outcome: 'block', text: `${g.kind}: ${g.description}` });
        break;
      case 'source_derived_ordering':
        // The source states the order (a numbered procedure): that order is the author's, not a guess.
        wf.push({ outcome: 'pass', text: `the step order is the source's own numbered sequence` });
        break;
      case 'ambiguous_precedence':
      case 'source_order_only': {
        const ok = input.accepted?.ambiguousStepOrder === true;
        wf.push({
          outcome: ok ? 'condition' : 'review',
          text: ok
            ? `step order not stated by the source, accepted by the owner: ${g.description}`
            : `step order not stated by the source: ${g.description}`,
        });
        break;
      }
      default:
        wf.push({ outcome: 'review', text: `${g.kind}: ${g.description}` });
    }
  }
  gates.push(gate('workflow-definition', wf, `Workflow IR valid (${input.lowered.definitionDigest.slice(0, 19)}…)`));

  const pick = (o: GateOutcome): string[] => gates.flatMap((g) => (g.outcome === o ? g.findings : []));
  const blockers = pick('block');
  const reviewItems = gates.flatMap((g) => (g.outcome === 'review' ? g.findings : []));
  const conditions = pick('condition');
  const status: ReadinessStatus =
    blockers.length > 0 ? 'BLOCKED' : reviewItems.length > 0 ? 'NEEDS_REVIEW' : conditions.length > 0 ? 'READY_WITH_CONDITIONS' : 'READY';

  const body = {
    schema: READINESS_CERTIFICATE_SCHEMA as typeof READINESS_CERTIFICATE_SCHEMA,
    status,
    scope: {
      ...(input.compilationId !== undefined ? { compilationId: input.compilationId } : {}),
      ...(input.definitionId !== undefined ? { definitionId: input.definitionId } : {}),
      candidateWorkflowId: input.candidate.id,
      workflowName: input.candidate.name,
    },
    goal: input.goal,
    gates,
    blockers,
    reviewItems,
    conditions,
    bindings: readinessBindings(input),
    issuedAt: input.issuedAt,
    issuedBy: input.issuedBy,
  };
  const digest = digestOf(body);
  return { ...body, certificateId: `wrc_${digest.slice(7, 31)}`, digest };
}

export type CertificateVerification = { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

/** A certificate allows a start only when it is intact, its status allows a start, and every binding is still current. */
export function verifyReadinessCertificate(cert: WorkflowReadinessCertificate, current: CertificateBindings): CertificateVerification {
  const reasons: string[] = [];
  const { digest, certificateId, ...body } = cert;
  if (digestOf(body) !== digest || `wrc_${digest.slice(7, 31)}` !== certificateId)
    reasons.push('the certificate does not match its digest');
  if (cert.status !== 'READY' && cert.status !== 'READY_WITH_CONDITIONS')
    reasons.push(`the certificate status is ${cert.status}, which does not allow a start`);
  if (cert.bindings.policyVersion !== READINESS_POLICY_VERSION)
    reasons.push(`the certificate was issued under ${cert.bindings.policyVersion}, not ${READINESS_POLICY_VERSION}`);
  const b = cert.bindings;
  const diff = (label: string, then: unknown, now: unknown): void => {
    if (digestOf(then) !== digestOf(now)) reasons.push(`stale: ${label} changed since the certificate was issued`);
  };
  diff('the source set', [b.sourceSetId, b.sourceSetDigest], [current.sourceSetId, current.sourceSetDigest]);
  diff('the compilation artifact', b.artifactDigest, current.artifactDigest);
  diff('the compiled graph', b.xoirGraphHash, current.xoirGraphHash);
  diff('the knowledge state', b.knowledgeState, current.knowledgeState);
  diff('the capability inventory', b.inventoryDigest, current.inventoryDigest);
  for (const id of new Set([...Object.keys(b.contractHashes), ...Object.keys(current.contractHashes)]))
    diff(`the contract of ${id}`, b.contractHashes[id] ?? null, current.contractHashes[id] ?? null);
  diff('the workflow definition', b.workflowDefinitionDigest, current.workflowDefinitionDigest);
  diff('the goal', b.goalDigest, current.goalDigest);
  diff('the connector bindings', b.connectorBindingsDigest, current.connectorBindingsDigest);
  diff('the applied waivers and rulings', b.decisions, current.decisions);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
