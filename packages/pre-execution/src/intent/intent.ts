import type { XoirGraph } from '@xo/xoir';
import type { CandidateWorkflow } from '@xo/workflow-composer';
import { digestOf, type Digest } from '../canonical.js';
import type { CapabilityInventory } from '../capability-inventory.js';
import { goalSpecification, selectWorkflowScope, type GoalSpecification, type ScopeSelection } from '../goal.js';
import { lowerCandidateWorkflow, type LowerOptions, type LoweredWorkflow } from '../lower-workflow.js';

/**
 * UW-6 (ADR 0043) — from a stated outcome to a validated, typed workflow definition, with missing capabilities and missing
 * information handled explicitly. No free-form planner: an intent is a small STRUCTURED proposal (the goal, the steps it needs by
 * name, how the work repeats, how cases arrive); composition is the existing selection and the one lowering function, followed by the
 * validator. A proposal from a model is the same structure, parsed and checked exactly like a person's, and carries no authority:
 * it can only name things the compiled catalogue already has, and what it says is never read as an instruction (selection scores
 * words; nothing interprets text).
 */
export const INTENT_PROPOSAL_SCHEMA = 'xo.intent.proposal.v1';
export const INTENT_TRACE_SCHEMA = 'xo.intent.trace.v1';

export type ProposalOrigin = 'structured' | 'model';

export interface IntentProposal {
  readonly schema: typeof INTENT_PROPOSAL_SCHEMA;
  readonly text: string;
  readonly needs?: readonly string[];
  readonly section?: string;
  readonly forEach?: string;
  readonly intake?: 'structured' | 'text';
}

export interface IntentFinding {
  readonly severity: 'error' | 'warning';
  readonly code: 'not_an_object' | 'unknown_field' | 'bad_value';
  readonly field?: string;
  readonly message: string;
}

const KNOWN = ['schema', 'text', 'needs', 'section', 'forEach', 'intake', 'statedBy'] as const;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
export const MAX_INTENT_TEXT = 2000;
export const MAX_INTENT_NEEDS = 20;

const clean = (s: string): string => s.replace(CONTROL, ' ').normalize('NFKC').trim();

/** Strict parse: only the known fields survive, bounded; anything else is dropped and reported. The origin changes nothing about what is accepted. */
export function parseIntentProposal(raw: unknown): { readonly proposal?: IntentProposal; readonly findings: readonly IntentFinding[] } {
  const findings: IntentFinding[] = [];
  const bad = (field: string, message: string): void => void findings.push({ severity: 'error', code: 'bad_value', field, message });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { findings: [{ severity: 'error', code: 'not_an_object', message: 'a proposal must be an object' }] };
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!(KNOWN as readonly string[]).includes(k))
      findings.push({
        severity: 'warning',
        code: 'unknown_field',
        field: k,
        message: `field "${k.slice(0, 40)}" is not part of a proposal and was ignored`,
      });
  const text = typeof o['text'] === 'string' ? clean(o['text']) : '';
  if (text === '' || text.length > MAX_INTENT_TEXT) bad('text', `text must be 1 to ${MAX_INTENT_TEXT} characters`);
  let needs: string[] | undefined;
  if (o['needs'] !== undefined) {
    if (
      !Array.isArray(o['needs']) ||
      o['needs'].length > MAX_INTENT_NEEDS ||
      !o['needs'].every((n) => typeof n === 'string' && clean(n) !== '' && n.length <= 200)
    )
      bad('needs', `needs must be at most ${MAX_INTENT_NEEDS} names of 1 to 200 characters`);
    else needs = [...new Set((o['needs'] as string[]).map(clean))];
  }
  const optional = (field: 'section' | 'forEach', max: number, pattern?: RegExp): string | undefined => {
    const v = o[field];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || clean(v).length > max || (pattern !== undefined && !pattern.test(clean(v))))
      return void bad(field, `${field} is not valid`);
    return clean(v) === '' ? undefined : clean(v);
  };
  const section = optional('section', 200);
  const forEach = optional('forEach', 40, /^[\p{L}][\p{L}\p{N} _-]*$/u);
  if (o['intake'] !== undefined && o['intake'] !== 'structured' && o['intake'] !== 'text')
    bad('intake', 'intake must be structured or text');
  if (findings.some((f) => f.severity === 'error')) return { findings };
  const proposal: IntentProposal = {
    schema: INTENT_PROPOSAL_SCHEMA,
    text,
    ...(needs !== undefined && needs.length > 0 ? { needs } : {}),
    ...(section !== undefined ? { section } : {}),
    ...(forEach !== undefined ? { forEach } : {}),
    ...(o['intake'] === 'text' ? { intake: 'text' as const } : {}),
  };
  return { proposal, findings };
}

export const intentToGoal = (p: IntentProposal, statedBy?: string): GoalSpecification =>
  goalSpecification({
    text: p.text,
    ...(p.needs !== undefined ? { needs: p.needs } : {}),
    ...(p.section !== undefined ? { section: p.section } : {}),
    ...(p.forEach !== undefined ? { forEach: p.forEach } : {}),
    ...(p.intake !== undefined ? { intake: p.intake } : {}),
    ...(statedBy !== undefined ? { statedBy } : {}),
  });

/** What the catalogue is, as a version: the same capabilities and contracts give the same version. */
export function catalogueVersion(inventory: CapabilityInventory): Digest {
  return digestOf(inventory.capabilities.map((c) => [c.capabilityId, c.contractHash, c.status]).sort());
}

export type IntentGapKind = 'missing_capability' | 'unbound_capability';
export interface IntentGap {
  readonly kind: IntentGapKind;
  readonly need: string;
  readonly reason: string;
}

/** The proposal-to-validation record stored with the workflow version. Counts, names the person gave, ids and digests; no source content. */
export interface IntentTrace {
  readonly schema: typeof INTENT_TRACE_SCHEMA;
  readonly origin: ProposalOrigin;
  readonly proposalDigest: Digest;
  readonly findings: readonly IntentFinding[];
  readonly catalogueVersion: Digest;
  readonly selection: {
    readonly status: ScopeSelection['status'] | 'explicit';
    readonly workflowId?: string;
    readonly ranking: readonly { workflowId: string; score: number }[];
  };
  readonly outcome: 'composed' | 'needs_clarification' | 'gap' | 'invalid';
  readonly gaps: readonly IntentGap[];
  readonly lowering?: {
    readonly version: string;
    readonly definitionDigest: Digest;
    readonly steps: number;
    readonly valid: boolean;
    readonly blocking: number;
  };
}

export type IntentResult =
  | {
      readonly status: 'composed';
      readonly goal: GoalSpecification;
      readonly candidate: CandidateWorkflow;
      readonly selection: ScopeSelection | { readonly status: 'explicit'; readonly workflowId: string };
      readonly lowered: LoweredWorkflow;
      readonly trace: IntentTrace;
      readonly traceDigest: Digest;
    }
  | {
      readonly status: 'needs_clarification';
      readonly question: string;
      readonly options: readonly { workflowId: string; name: string }[];
      readonly trace: IntentTrace;
      readonly traceDigest: Digest;
    }
  | { readonly status: 'gap'; readonly gaps: readonly IntentGap[]; readonly trace: IntentTrace; readonly traceDigest: Digest }
  | { readonly status: 'invalid'; readonly findings: readonly IntentFinding[]; readonly trace: IntentTrace; readonly traceDigest: Digest };

export interface IntentContext {
  readonly graph: XoirGraph;
  readonly workflows: readonly CandidateWorkflow[];
  /** Built with the proposal's needs, so `gaps` says which needs nothing usable provides (see `buildCapabilityInventory`). */
  readonly inventory: CapabilityInventory;
}

/**
 * Composes a proposal into the canonical workflow definition, or says exactly why it cannot:
 *  - a need nothing usable provides, or a chosen step with no connector bound, is a GAP (never guessed around);
 *  - two workflows that fit equally, or none that fits, is ONE clarification question;
 *  - a definition the validator rejects is `invalid`.
 */
export function composeIntent(
  context: IntentContext,
  rawProposal: unknown,
  origin: ProposalOrigin,
  options: LowerOptions & {
    readonly statedBy?: string;
    readonly workflowId?: string;
    readonly priorFindings?: readonly IntentFinding[];
  } = {},
): IntentResult {
  const version = catalogueVersion(context.inventory);
  const finish = (
    partial: Omit<IntentTrace, 'schema' | 'origin' | 'proposalDigest' | 'catalogueVersion'>,
    proposalDigest: Digest,
  ): { trace: IntentTrace; traceDigest: Digest } => {
    const trace: IntentTrace = { schema: INTENT_TRACE_SCHEMA, origin, proposalDigest, catalogueVersion: version, ...partial };
    return { trace, traceDigest: digestOf(trace) };
  };
  const own = parseIntentProposal(rawProposal);
  // Findings from an earlier parse of the same answer (the route that read a model's text) belong in the trace too.
  const parsed = { ...own, findings: [...(options.priorFindings ?? []), ...own.findings] };
  if (parsed.proposal === undefined) {
    const t = finish(
      { findings: parsed.findings, selection: { status: 'no_match', ranking: [] }, outcome: 'invalid', gaps: [] },
      digestOf(null),
    );
    return { status: 'invalid', findings: parsed.findings, ...t };
  }
  const proposal = parsed.proposal;
  const proposalDigest = digestOf(proposal);
  const goal = intentToGoal(proposal, options.statedBy);
  const gaps: IntentGap[] = context.inventory.gaps.map((g) => ({ kind: 'missing_capability' as const, need: g.need, reason: g.reason }));
  if (gaps.length > 0) {
    const t = finish({ findings: parsed.findings, selection: { status: 'no_match', ranking: [] }, outcome: 'gap', gaps }, proposalDigest);
    return { status: 'gap', gaps, ...t };
  }
  let selection: ScopeSelection | { readonly status: 'explicit'; readonly workflowId: string };
  if (options.workflowId !== undefined) selection = { status: 'explicit', workflowId: options.workflowId };
  else {
    const scope = selectWorkflowScope(context.workflows, goal);
    const ranking = scope.ranking.slice(0, 5).map((r) => ({ workflowId: r.workflowId, score: r.score }));
    if (scope.status === 'needs_clarification') {
      const t = finish(
        { findings: parsed.findings, selection: { status: scope.status, ranking }, outcome: 'needs_clarification', gaps: [] },
        proposalDigest,
      );
      return { status: 'needs_clarification', question: scope.question, options: scope.options, ...t };
    }
    if (scope.status === 'no_match') {
      const t = finish(
        { findings: parsed.findings, selection: { status: scope.status, ranking }, outcome: 'needs_clarification', gaps: [] },
        proposalDigest,
      );
      return {
        status: 'needs_clarification',
        question: 'Which part of the compiled sources is this about? Name a section, or the steps it needs.',
        options: [],
        ...t,
      };
    }
    selection = scope;
  }
  const chosen =
    selection.status === 'explicit' ? selection.workflowId : (selection as Extract<ScopeSelection, { status: 'selected' }>).workflowId;
  const candidate = context.workflows.find((w) => w.id === chosen);
  const ranking =
    selection.status === 'explicit'
      ? []
      : (selection as Extract<ScopeSelection, { status: 'selected' }>).ranking
          .slice(0, 5)
          .map((r) => ({ workflowId: r.workflowId, score: r.score }));
  if (candidate === undefined) {
    const t = finish(
      {
        findings: [
          ...parsed.findings,
          { severity: 'error', code: 'bad_value', field: 'workflowId', message: 'no such workflow in the compiled sources' },
        ],
        selection: { status: selection.status, workflowId: chosen, ranking },
        outcome: 'invalid',
        gaps: [],
      },
      proposalDigest,
    );
    return { status: 'invalid', findings: t.trace.findings, ...t };
  }
  const lowered = lowerCandidateWorkflow(context.graph, candidate, context.inventory, options);
  const blocking = lowered.issues.filter((i) => i.severity === 'blocking');
  const traceLowering = {
    version: lowered.schema,
    definitionDigest: lowered.definitionDigest,
    steps: lowered.component?.workflows[0]?.steps.length ?? 0,
    valid: lowered.validation.valid,
    blocking: blocking.length,
  };
  const unbound = blocking.filter((i) => i.code === 'unbound');
  if (unbound.length > 0) {
    const g = unbound.map((i): IntentGap => ({
      kind: 'unbound_capability',
      need: i.capabilityId ?? i.stepId ?? 'a step',
      reason: i.message,
    }));
    const t = finish(
      {
        findings: parsed.findings,
        selection: { status: selection.status, workflowId: chosen, ranking },
        outcome: 'gap',
        gaps: g,
        lowering: traceLowering,
      },
      proposalDigest,
    );
    return { status: 'gap', gaps: g, ...t };
  }
  if (!lowered.complete) {
    const findings: IntentFinding[] = [
      ...parsed.findings,
      ...blocking.map((i): IntentFinding => ({ severity: 'error', code: 'bad_value', message: i.message })),
    ];
    const t = finish(
      {
        findings,
        selection: { status: selection.status, workflowId: chosen, ranking },
        outcome: 'invalid',
        gaps: [],
        lowering: traceLowering,
      },
      proposalDigest,
    );
    return { status: 'invalid', findings, ...t };
  }
  const t = finish(
    {
      findings: parsed.findings,
      selection: { status: selection.status, workflowId: chosen, ranking },
      outcome: 'composed',
      gaps: [],
      lowering: traceLowering,
    },
    proposalDigest,
  );
  return { status: 'composed', goal, candidate, selection, lowered, ...t };
}

/**
 * A model's answer as a proposal: the answer is untrusted text. It is parsed as JSON (a fenced block is tolerated) and goes through
 * `parseIntentProposal` and `composeIntent` like anything else. Nothing else in the answer is used.
 */
export function proposalFromModelAnswer(answer: string): unknown {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(answer);
  try {
    return JSON.parse((m?.[1] ?? answer).trim());
  } catch {
    return undefined;
  }
}

/**
 * UW-15 (ADR 0044) — the key under which a compiled definition is reused: the same goal over the same schema with the same catalogue
 * gives the same key. Stricter than goal + schema + catalogue, because a definition also depends on what it was lowered against:
 * the compilation, the connector bindings and an explicit workflow choice are part of the key, so a change to any of them composes afresh.
 */
export function reuseKey(parts: {
  readonly goalDigest: Digest;
  /** Digest of the compiled tables' schema (headers, types, value shapes), or null when the compilation has none. */
  readonly schemaDigest: Digest | null;
  readonly catalogueVersion: Digest;
  readonly compilationId: string;
  readonly bindingsDigest: Digest;
  readonly workflowId?: string;
}): Digest {
  return digestOf({ v: 1, ...parts, workflowId: parts.workflowId ?? null });
}
