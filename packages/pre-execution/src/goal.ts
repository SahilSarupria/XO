/**
 * PX-6 — a typed goal and explainable scope selection (gap PX-G22).
 *
 * A `GoalSpecification` says what the workflow is for, in the person's words, plus optional capability needs and a
 * section hint. `selectWorkflowScope` ranks the composed candidate workflows against it and either selects one — with
 * the reasons — or, when two candidates fit about equally well, asks ONE clarification question instead of guessing.
 * Nothing here picks "the workflow with the most steps".
 */
import type { CandidateWorkflow } from '@xo/workflow-composer';
import { digestOf, type Digest } from './canonical.js';

export const GOAL_SCHEMA = 'xo.goal.v1';

export interface GoalSpecification {
  readonly schema: typeof GOAL_SCHEMA;
  /** What the workflow should achieve, in the person's words. */
  readonly text: string;
  /** Capabilities the goal needs, by name (each unmet one is a gap in the inventory). */
  readonly needs?: readonly string[];
  /** A section (heading) of the source the workflow should come from. */
  readonly section?: string;
  /** Who stated the goal (an actor id), when known. */
  readonly statedBy?: string;
}

export function goalSpecification(input: Omit<GoalSpecification, 'schema'>): GoalSpecification {
  const text = input.text.trim();
  if (text === '') throw new Error('a goal needs text: what should the workflow achieve?');
  return {
    schema: GOAL_SCHEMA,
    text,
    ...(input.needs !== undefined && input.needs.length > 0 ? { needs: input.needs.map((n) => n.trim()).filter((n) => n !== '') } : {}),
    ...(input.section !== undefined && input.section.trim() !== '' ? { section: input.section.trim() } : {}),
    ...(input.statedBy !== undefined ? { statedBy: input.statedBy } : {}),
  };
}

export function goalDigest(goal: GoalSpecification): Digest {
  return digestOf(goal, ['statedBy']);
}

export interface ScopeScore {
  readonly workflowId: string;
  readonly name: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

export type ScopeSelection =
  | { readonly status: 'selected'; readonly workflowId: string; readonly rationale: string; readonly ranking: readonly ScopeScore[] }
  | {
      readonly status: 'needs_clarification';
      readonly question: string;
      readonly options: readonly { readonly workflowId: string; readonly name: string }[];
      readonly ranking: readonly ScopeScore[];
    }
  | { readonly status: 'no_match'; readonly reason: string; readonly ranking: readonly ScopeScore[] };

/** Words that carry no meaning about scope. */
const STOP = new Set(
  'a an the of to for and or in on at by with from into is are be this that these those it its our we i you how what when do does should must can will workflow process run make'.split(
    ' ',
  ),
);
const words = (s: string): string[] =>
  s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w));
const norm = (s: string): string => words(s).join(' ');

/** Ambiguity margin: when the runner-up scores within this fraction of the best, the goal does not decide between them. */
export const SCOPE_AMBIGUITY_MARGIN = 0.15;

/**
 * Ranks `candidates` against `goal`:
 *   +3 per goal need that names a step of the workflow (exactly, after normalisation)
 *   +2 when the workflow's section matches the goal's section hint
 *   +1 per goal word found in the workflow's name, section or step names (each word once)
 * The best wins only when it clearly leads; otherwise one clarification question lists the tied candidates.
 */
export function selectWorkflowScope(candidates: readonly CandidateWorkflow[], goal: GoalSpecification): ScopeSelection {
  const goalWords = [...new Set(words(goal.text))];
  const ranking: ScopeScore[] = candidates
    .map((w) => {
      const section = (w.processGrouping?.sectionPath ?? []).join(' ');
      const stepNames = w.steps.map((s) => norm(s.capabilityName));
      const haystack = new Set(words(`${w.name} ${section} ${w.steps.map((s) => s.capabilityName).join(' ')}`));
      const reasons: string[] = [];
      let score = 0;
      for (const need of goal.needs ?? []) {
        if (stepNames.includes(norm(need))) {
          score += 3;
          reasons.push(`has the needed step "${need}"`);
        }
      }
      if (goal.section !== undefined && norm(section).includes(norm(goal.section)) && norm(goal.section) !== '') {
        score += 2;
        reasons.push(`comes from the section "${section}"`);
      }
      const hits = goalWords.filter((g) => haystack.has(g));
      if (hits.length > 0) {
        score += hits.length;
        reasons.push(`matches the goal's words ${hits.map((h) => `"${h}"`).join(', ')}`);
      }
      return { workflowId: w.id, name: w.name, score, reasons };
    })
    .sort((a, b) => b.score - a.score || a.workflowId.localeCompare(b.workflowId));

  const best = ranking[0];
  if (best === undefined || best.score === 0)
    return {
      status: 'no_match',
      reason: 'no candidate workflow matches the goal; restate it, name a needed step, or name the section',
      ranking,
    };
  const tied = ranking.filter((r) => r.score > 0 && best.score - r.score <= best.score * SCOPE_AMBIGUITY_MARGIN);
  if (tied.length > 1)
    return {
      status: 'needs_clarification',
      question: `The goal "${goal.text}" fits ${tied.length} workflows equally well. Which one do you mean: ${tied.map((t) => `"${t.name}"`).join(', ')}?`,
      options: tied.map((t) => ({ workflowId: t.workflowId, name: t.name })),
      ranking,
    };
  return {
    status: 'selected',
    workflowId: best.workflowId,
    rationale: `"${best.name}" ${best.reasons.join('; ')} (score ${best.score}; next ${ranking[1]?.score ?? 0})`,
    ranking,
  };
}
