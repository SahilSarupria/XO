/**
 * Domain identification: which known domain (if any) does this text read like — and how do we know?
 *
 * Deterministic and evidence-first: a pack scores by the DISTINCT concepts it recognises (weighted by specificity, so generic
 * words like "policy" or "interest" cannot identify a domain on their own), plus a small log bonus for repeated mentions.
 * Below a minimum score the answer is `unknown`; two comparably strong packs give `mixed`. It never forces text into the
 * nearest pack: knowing that it does not recognise a domain is the safe, useful answer.
 *
 * The result is ADVISORY. It reports and suggests; it does not alter extraction or apply vocabulary.
 */
import { phraseRegex } from './retrieval.js';
import type { DomainKnowledgePack } from './types.js';

export interface MatchedConcept {
  readonly conceptId: string;
  readonly label: string;
  readonly count: number;
  /** The surface form that matched when it was a synonym rather than the label. */
  readonly viaSynonym?: string;
}

export interface DomainCandidate {
  readonly packId: string;
  readonly score: number;
  readonly matchedConcepts: readonly MatchedConcept[];
}

export interface DomainIdentification {
  /** A pack id, `mixed` (two comparably strong domains), or `unknown` (nothing recognised well enough). */
  readonly domain: string;
  /** 0..1, how decisively the top candidate beat the rest; 0 for `unknown`. */
  readonly confidence: number;
  readonly candidates: readonly DomainCandidate[];
}

export const MIN_DOMAIN_SCORE = 2.5;
const MIXED_RATIO = 0.7;

function scorePack(text: string, pack: DomainKnowledgePack): DomainCandidate {
  const matched: MatchedConcept[] = [];
  let score = 0;
  let mentions = 0;
  for (const concept of pack.concepts) {
    let count = (text.match(phraseRegex(concept.label)) ?? []).length;
    let viaSynonym: string | undefined;
    if (count === 0) {
      for (const synonym of concept.synonyms) {
        const n = (text.match(phraseRegex(synonym)) ?? []).length;
        if (n > 0) {
          count = n;
          viaSynonym = synonym;
          break;
        }
      }
    }
    if (count === 0) continue;
    matched.push({ conceptId: concept.id, label: concept.label, count, ...(viaSynonym !== undefined ? { viaSynonym } : {}) });
    score += concept.weight;
    mentions += count;
  }
  if (mentions > 0) score += 0.1 * Math.log(mentions);
  return { packId: pack.id, score, matchedConcepts: matched };
}

export function identifyDomain(text: string, packs: readonly DomainKnowledgePack[]): DomainIdentification {
  const candidates = packs
    .map((pack) => scorePack(text, pack))
    .filter((c) => c.matchedConcepts.length > 0)
    .sort((a, b) => b.score - a.score || a.packId.localeCompare(b.packId));
  const best = candidates[0];
  if (best === undefined || best.score < MIN_DOMAIN_SCORE) return { domain: 'unknown', confidence: 0, candidates };
  const second = candidates[1];
  if (second !== undefined && second.score >= MIN_DOMAIN_SCORE && second.score >= MIXED_RATIO * best.score) {
    return { domain: 'mixed', confidence: best.score / (best.score + second.score), candidates };
  }
  return { domain: best.packId, confidence: best.score / (best.score + (second?.score ?? 0) + 1), candidates };
}
