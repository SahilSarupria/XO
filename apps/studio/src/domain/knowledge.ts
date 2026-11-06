/**
 * Knowledge: presentation logic as pure functions. Claims here are limited to what C6 reports: status, origin, independent-source counts
 * and evidence references. Confidence is never shown as a probability, and nothing says a statement "disappears" when a source goes: it
 * stops being shown only if every source behind it is removed.
 */
import type { EvidenceReference, ReviewItem, Statement } from '../platform/wire-knowledge';
import type { OutcomeTone } from './review';
import { plural } from './connect';

export interface StatusView {
  readonly label: string;
  readonly tone: OutcomeTone;
  readonly explanation: string;
}

export function statusView(s: Pick<Statement, 'status' | 'origin' | 'kind' | 'reviewRequired'>): StatusView {
  if (s.kind === 'conflict' || s.status === 'conflicted')
    return { label: 'Conflict', tone: 'danger', explanation: 'Sources disagree. XO has not chosen; a reviewer needs to decide.' };
  if (s.status === 'hypothesis' || s.reviewRequired)
    return {
      label: 'Unverified guess',
      tone: 'warning',
      explanation: 'Inferred from what was read. Not confirmed by an independent source.',
    };
  if (s.status === 'unknown') return { label: 'Unknown', tone: 'neutral', explanation: 'XO does not know this.' };
  if (s.origin === 'observed') return { label: 'Observed', tone: 'success', explanation: 'Directly recorded by the source.' };
  if (s.origin === 'stated')
    return { label: 'Stated', tone: 'success', explanation: 'Stated by the source (for example in a policy or message).' };
  return { label: 'Inferred, corroborated', tone: 'neutral', explanation: 'Inferred, and supported by more than one independent source.' };
}

export const independentSources = (evidence: readonly EvidenceReference[]): number => new Set(evidence.map((e) => e.sourceId)).size;

export const sourcesLine = (s: Pick<Statement, 'evidence'>): string => plural(independentSources(s.evidence), 'source');

export const shortHash = (h: string): string => (h.length <= 18 ? h : `${h.slice(0, 14)}…${h.slice(-4)}`);

export interface EvidencePanel {
  readonly backing: string;
  readonly items: readonly { readonly key: string; readonly source: string; readonly observed: string; readonly hash: string }[];
  readonly howSure: string;
  readonly ifRemoved: string;
  readonly visibility: string;
}

export function evidencePanel(s: Statement): EvidencePanel {
  const n = independentSources(s.evidence);
  return {
    backing: n === 0 ? 'No evidence is attached to this statement.' : `Backed by ${plural(n, 'independent source')}.`,
    items: s.evidence.map((e) => ({
      key: e.evidenceId,
      source: `Source ${e.sourceId.slice(0, 12)}`,
      observed: e.observedAt,
      hash: shortHash(e.contentHash),
    })),
    howSure: 'This describes the evidence, not a probability, and it never lets XO act on its own.',
    ifRemoved: `This stops being shown only if every source behind it is removed. Right now it rests on ${plural(n, 'source')}.`,
    visibility: 'Results show only what you may see. Something missing here is not proof nothing is known.',
  };
}

export const KNOWLEDGE_TABS = [
  { id: 'search', label: 'Search' },
  { id: 'entities', label: 'People and things' },
  { id: 'claims', label: 'Facts' },
  { id: 'conflicts', label: 'Conflicts' },
  { id: 'review', label: 'Needs review' },
] as const;
export type KnowledgeTab = (typeof KNOWLEDGE_TABS)[number]['id'];

export const reviewKindLabel = (k: ReviewItem['kind']): string =>
  k === 'conflict' ? 'Conflict' : k === 'unverified_inference' ? 'Unverified guess' : 'Possible match';

export function uncertaintyLine(u: { conflicted: number; hypotheses: number; reviewRequired: number; singleSource: number }): string {
  const parts: string[] = [];
  if (u.conflicted > 0) parts.push(plural(u.conflicted, 'conflict'));
  if (u.hypotheses > 0) parts.push(`${plural(u.hypotheses, 'unverified guess', 'unverified guesses')}`);
  if (u.reviewRequired > 0) parts.push(`${u.reviewRequired} need review`);
  if (u.singleSource > 0) parts.push(`${u.singleSource} rest on a single source`);
  return parts.length === 0 ? 'Nothing here is flagged.' : parts.join(' · ');
}
