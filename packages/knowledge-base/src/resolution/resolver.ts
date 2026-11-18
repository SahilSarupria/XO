import { NAME_MATCH_TIERS, matchesTier, personName, type NameMatchKind } from './names.js';
import { normaliseIdentifier, type IdentifierRule } from './normalise.js';

/**
 * UW-5 (ADR 0040) — deterministic entity resolution across sources (a recipient row ↔ a document, an invoice ↔ a ledger line).
 * No model. Result per subject: `resolved | ambiguous | unmatched`, each with the evidence behind it. Similarity never confirms.
 *
 * `resolved` needs a distinguishing identifier match (declared strong scheme) OR a unique full-name match of at least
 * `minNameWords` words with no other candidate (and no other subject) at the same tier. Everything weaker is at most `ambiguous`.
 */
export type Cardinality = 'one_to_one' | 'one_to_many' | 'many_to_one';

export interface ResolutionSchema {
  readonly relationship: string;
  /** one_to_many: one subject may own many candidates; many_to_one: many subjects may share one candidate. */
  readonly cardinality: Cardinality;
  /** Strong identifier schemes and how each is normalised. Only these can confirm by identifier. */
  readonly strongSchemes: Readonly<Record<string, IdentifierRule>>;
  /** A name alone confirms only with at least this many words (default 2: a one-word name is never confirmed by name). */
  readonly minNameWords?: number;
}

export interface ResolutionItem {
  /** Opaque reference (row id, file id): what results and audit use instead of the name. */
  readonly ref: string;
  /** A person or thing name, or the file name / path text it appears in. */
  readonly name?: string;
  readonly identifiers?: readonly { readonly scheme: string; readonly value: string }[];
}

export type EvidenceBasis = 'identifier' | NameMatchKind;

export interface CandidateEvidence {
  readonly candidate: string;
  readonly basis: EvidenceBasis;
  /** For an identifier basis: which scheme (never the value). */
  readonly scheme?: string;
  /** Whether this evidence alone could confirm the match. */
  readonly confirming: boolean;
}

export type AmbiguityReason = 'several_candidates' | 'several_subjects' | 'similarity_only' | 'weak_name' | 'both';

export type SubjectResolution =
  | { readonly outcome: 'resolved'; readonly subject: string; readonly candidates: readonly CandidateEvidence[] }
  | { readonly outcome: 'ambiguous'; readonly subject: string; readonly reason: AmbiguityReason; readonly candidates: readonly CandidateEvidence[] }
  | { readonly outcome: 'unmatched'; readonly subject: string };

export interface CardinalityViolation {
  readonly relationship: string;
  readonly kind: 'subject_has_many' | 'candidate_has_many';
  /** The item with too many links, and the items on the other side. */
  readonly item: string;
  readonly linkedTo: readonly string[];
}

export interface ResolutionReport {
  readonly schema: { readonly relationship: string; readonly cardinality: Cardinality };
  readonly results: readonly SubjectResolution[];
  readonly unmatchedSubjects: readonly string[];
  /** Candidates no subject resolved to. */
  readonly unmatchedCandidates: readonly string[];
  readonly violations: readonly CardinalityViolation[];
  /** True when nothing is ambiguous, no cardinality violation, and nothing unmatched: safe to present for confirmation. */
  readonly clean: boolean;
}

const LEVELS: readonly EvidenceBasis[] = ['identifier', ...NAME_MATCH_TIERS];
const rank = (b: EvidenceBasis): number => LEVELS.indexOf(b);

interface Edge {
  readonly subject: string;
  readonly candidate: string;
  readonly basis: EvidenceBasis;
  readonly scheme?: string;
  readonly confirming: boolean;
}

function normalisedIds(schema: ResolutionSchema, item: ResolutionItem): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const id of item.identifiers ?? []) {
    const rule = schema.strongSchemes[id.scheme];
    if (rule === undefined) continue;
    const v = normaliseIdentifier(rule, id.value);
    if (v === '') continue;
    (out.get(id.scheme) ?? out.set(id.scheme, new Set()).get(id.scheme)!).add(v);
  }
  return out;
}

/** The best evidence between one subject and one candidate, or undefined (also when strong identifiers CONFLICT). */
function pairEvidence(schema: ResolutionSchema, minWords: number, s: ResolutionItem, c: ResolutionItem): Edge | undefined {
  const sIds = normalisedIds(schema, s);
  const cIds = normalisedIds(schema, c);
  let matchedScheme: string | undefined;
  for (const [scheme, sv] of sIds) {
    const cv = cIds.get(scheme);
    if (cv === undefined) continue;
    const common = [...sv].some((v) => cv.has(v));
    // Same scheme, different values: positive evidence these are different things. Excluded even if the names match.
    if (!common) return undefined;
    matchedScheme ??= scheme;
  }
  if (matchedScheme !== undefined)
    return { subject: s.ref, candidate: c.ref, basis: 'identifier', scheme: matchedScheme, confirming: true };
  const person = s.name === undefined ? undefined : personName(0, s.name);
  if (person === undefined || c.name === undefined) return undefined;
  for (const kind of NAME_MATCH_TIERS) {
    if (matchesTier(kind, person, c.name)) {
      return { subject: s.ref, candidate: c.ref, basis: kind, confirming: kind === 'full' && person.words.length >= minWords };
    }
  }
  return undefined;
}

export function resolveEntities(
  schema: ResolutionSchema,
  subjects: readonly ResolutionItem[],
  candidates: readonly ResolutionItem[],
): ResolutionReport {
  const minWords = schema.minNameWords ?? 2;
  const edges: Edge[] = [];
  for (const s of subjects) for (const c of candidates) {
    const e = pairEvidence(schema, minWords, s, c);
    if (e !== undefined) edges.push(e);
  }
  const bestOf = (es: readonly Edge[]): number => Math.min(...es.map((e) => rank(e.basis)));
  const bySubject = new Map<string, Edge[]>();
  const byCandidate = new Map<string, Edge[]>();
  for (const e of edges) {
    (bySubject.get(e.subject) ?? bySubject.set(e.subject, []).get(e.subject)!).push(e);
    (byCandidate.get(e.candidate) ?? byCandidate.set(e.candidate, []).get(e.candidate)!).push(e);
  }
  const manyCandidates = schema.cardinality === 'one_to_many';
  const manySubjects = schema.cardinality === 'many_to_one';

  const results: SubjectResolution[] = subjects.map((s): SubjectResolution => {
    const all = bySubject.get(s.ref) ?? [];
    if (all.length === 0) return { outcome: 'unmatched', subject: s.ref };
    const best = bestOf(all);
    const hits = all.filter((e) => rank(e.basis) === best);
    const evidence: CandidateEvidence[] = hits.map((e) => ({
      candidate: e.candidate,
      basis: e.basis,
      ...(e.scheme === undefined ? {} : { scheme: e.scheme }),
      confirming: e.confirming,
    }));
    if (!hits.every((e) => e.confirming)) {
      const weakName = hits.some((e) => e.basis === 'full');
      return { outcome: 'ambiguous', subject: s.ref, reason: weakName ? 'weak_name' : 'similarity_only', candidates: evidence };
    }
    const severalCandidates = !manyCandidates && hits.length > 1;
    // Candidate side: another subject with evidence as strong as this one for the same candidate makes it ambiguous.
    const severalSubjects =
      !manySubjects &&
      hits.some((e) => {
        const others = (byCandidate.get(e.candidate) ?? []).filter((o) => o.subject !== s.ref && rank(o.basis) <= rank(e.basis));
        return others.length > 0;
      });
    if (severalCandidates || severalSubjects) {
      const reason: AmbiguityReason = severalCandidates && severalSubjects ? 'both' : severalCandidates ? 'several_candidates' : 'several_subjects';
      return { outcome: 'ambiguous', subject: s.ref, reason, candidates: evidence };
    }
    return { outcome: 'resolved', subject: s.ref, candidates: evidence };
  });

  const resolvedLinks = results.flatMap((r) => (r.outcome === 'resolved' ? r.candidates.map((c) => ({ subject: r.subject, candidate: c.candidate })) : []));
  const violations = validateCardinality(schema, resolvedLinks);
  const linkedCandidates = new Set(resolvedLinks.map((l) => l.candidate));
  const unmatchedSubjects = results.filter((r) => r.outcome === 'unmatched').map((r) => r.subject);
  const unmatchedCandidates = candidates.filter((c) => !linkedCandidates.has(c.ref)).map((c) => c.ref);
  const clean =
    results.every((r) => r.outcome === 'resolved') && violations.length === 0 && unmatchedCandidates.length === 0;
  return {
    schema: { relationship: schema.relationship, cardinality: schema.cardinality },
    results,
    unmatchedSubjects,
    unmatchedCandidates,
    violations,
    clean,
  };
}

/**
 * The declared cardinality over a set of links (resolved, or confirmed by a person): a violation blocks and names the items.
 * Run again after human confirmation, since a person can confirm two links the resolver would have held apart.
 */
export function validateCardinality(
  schema: Pick<ResolutionSchema, 'relationship' | 'cardinality'>,
  links: readonly { readonly subject: string; readonly candidate: string }[],
): readonly CardinalityViolation[] {
  const out: CardinalityViolation[] = [];
  const group = (key: 'subject' | 'candidate'): Map<string, Set<string>> => {
    const m = new Map<string, Set<string>>();
    for (const l of links) {
      const k = l[key];
      const other = key === 'subject' ? l.candidate : l.subject;
      (m.get(k) ?? m.set(k, new Set()).get(k)!).add(other);
    }
    return m;
  };
  if (schema.cardinality !== 'one_to_many')
    for (const [item, to] of group('subject')) if (to.size > 1) out.push({ relationship: schema.relationship, kind: 'subject_has_many', item, linkedTo: [...to].sort() });
  if (schema.cardinality !== 'many_to_one')
    for (const [item, to] of group('candidate')) if (to.size > 1) out.push({ relationship: schema.relationship, kind: 'candidate_has_many', item, linkedTo: [...to].sort() });
  return out.sort((a, b) => (a.kind + a.item).localeCompare(b.kind + b.item));
}
