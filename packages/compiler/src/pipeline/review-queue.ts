/**
 * Review queue: ONE structured list of everything in a compilation that still needs a person.
 *
 * The compiler already reports these facts in several places (readiness blockers, coverage diagnostics, prompt questions,
 * OCR gaps, unknown domain). A reviewer should not have to assemble them. Each item has a stable id, a priority
 * (1 = blocks trust, 2 = needs a decision, 3 = informational) and a plain-language summary. Pure and deterministic; it
 * derives from compiler outputs and adds no new claims.
 */
import { createHash } from 'node:crypto';
import type { Diagnostic } from '@xo/xoir';
import type { ExecutionReadiness } from './execution-readiness.js';
import type { CandidateRunResult } from '../ai-assist/candidates.js';
import type { CrossDocumentAnalysis } from './cross-document.js';
import type { KnowledgeRetriever } from '../knowledge-layer/retrieval.js';

export type ReviewQueueKind =
  | 'ocr-required'
  | 'uncovered-sentence'
  | 'unresolved-condition'
  | 'preserved-exception'
  | 'non-mandatory-rule'
  | 'human-required'
  | 'clarification-question'
  | 'unformalized-intent'
  | 'unknown-domain'
  | 'domain-clarification'
  | 'conflict'
  | 'amendment'
  | 'ai-candidate';

/** Reference knowledge retrieved for an item. Advisory: it says what a term means in a domain, never that the document contains a rule. */
export interface DomainHint {
  readonly packId: string;
  readonly conceptId: string;
  readonly label: string;
  readonly definition: string;
  readonly engines: readonly string[];
}

export interface ReviewQueueOptions {
  /** Retriever over the domain packs; absent when domain knowledge is disabled. */
  readonly retriever?: KnowledgeRetriever;
  /** True when domain identification found no known domain; unstructured rules then raise a clarification request. */
  readonly domainUnknown?: boolean;
  readonly crossDocument?: CrossDocumentAnalysis;
  readonly aiCandidates?: readonly CandidateRunResult[];
}

export interface ReviewQueueItem {
  readonly id: string;
  readonly kind: ReviewQueueKind;
  /** 1 = blocks trust in the result, 2 = needs a decision, 3 = informational. */
  readonly priority: 1 | 2 | 3;
  readonly summary: string;
  readonly detail: string;
  readonly hints?: readonly DomainHint[];
}

export interface ReviewQueue {
  readonly items: readonly ReviewQueueItem[];
  readonly summary: { readonly byKind: Readonly<Record<string, number>>; readonly byPriority: Readonly<Record<1 | 2 | 3, number>> };
}

const idOf = (kind: string, text: string): string => `rq_${createHash('sha256').update(`${kind}\u0000${text}`).digest('hex').slice(0, 12)}`;

export function buildReviewQueue(readiness: ExecutionReadiness, diagnostics: readonly Diagnostic[], options: ReviewQueueOptions = {}): ReviewQueue {
  const items: ReviewQueueItem[] = [];
  const add = (kind: ReviewQueueKind, priority: 1 | 2 | 3, summary: string, detail: string, hints?: readonly DomainHint[]): void =>
    void items.push({ id: idOf(kind, summary), kind, priority, summary, detail, ...(hints !== undefined && hints.length > 0 ? { hints } : {}) });
  const hintsFor = (text: string): DomainHint[] | undefined =>
    options.retriever?.retrieve(text, 3).map((h) => ({ packId: h.packId, conceptId: h.conceptId, label: h.label, definition: h.definition, engines: [...new Set(h.provenance.map((p) => p.engine))] }));

  for (const d of diagnostics) {
    if (d.code === 'source-quality/ocr-required') add('ocr-required', 1, 'Pages without a text layer were not compiled', d.message);
    else if (d.code === 'coverage/normative-sentence-not-extracted') add('uncovered-sentence', 1, d.message.replace(/^An? \w+ sentence produced no extracted rule or constraint and may have been lost: /, ''), d.message);
    else if (d.code === 'prompt/clarification-needed') add('clarification-question', 2, d.message, d.message);
    else if (d.code === 'prompt/unformalized-intent') add('unformalized-intent', 2, d.message, d.message);
    else if (d.code === 'domain/unknown') add('unknown-domain', 3, 'No known domain vocabulary recognised', d.message);
  }
  for (const e of readiness.entries) {
    const label = e.label.length > 120 ? `${e.label.slice(0, 117)}...` : e.label;
    if (e.compilerState === 'unresolved' && e.blockers.some((b) => /condition could not be structured/.test(b))) {
      const query = e.condition ?? e.label;
      add('unresolved-condition', 2, `Condition not structured: ${label}`, e.blockers.join('; '), hintsFor(query));
      if (options.domainUnknown === true) {
        const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 3))].slice(0, 6);
        add(
          'domain-clarification',
          2,
          `Unfamiliar vocabulary in: ${e.condition ?? label}`,
          `No known domain recognises the terms (${terms.join(', ')}). Which domain does this belong to, or what do these terms mean? You can define them or supply a domain profile.`,
        );
      }
    }
    if (e.blockers.some((b) => /exception condition/.test(b))) add('preserved-exception', 2, `Exception kept as text: ${label}`, e.blockers.join('; '));
    if (e.blockers.some((b) => /non-mandatory|permission modality|advisory modality/.test(b))) add('non-mandatory-rule', 3, `Not a mandatory rule: ${label}`, e.blockers.join('; '));
    if (e.executionState === 'human_required') add('human-required', 2, `Needs a person's decision: ${label}`, `Outcome type: ${e.outcomeType ?? 'unknown'}`);
  }
  for (const c of options.crossDocument?.conflicts ?? []) {
    const resolved = c.resolution.status === 'resolved-by-precedence';
    add('conflict', resolved ? 3 : 1, `${resolved ? 'Resolved conflict' : 'Unresolved conflict'}: "${c.a.label}" vs "${c.b.label}"`, `${c.kind}, ${c.scope}; ${c.a.sourcePath} [${c.a.outcomeType}] vs ${c.b.sourcePath} [${c.b.outcomeType}]${resolved && c.resolution.status === 'resolved-by-precedence' ? `; winner ${c.resolution.winner}` : ''}`);
  }
  for (const a of options.crossDocument?.amendments ?? []) add('amendment', 2, `Amendment wording in ${a.sourcePath}: ${a.cue}`, `${a.sentence}${a.effectiveDate !== undefined ? ` (effective ${a.effectiveDate})` : ''}`);
  for (const run of options.aiCandidates ?? []) {
    for (const r of run.results) {
      if (r.validation.status === 'validated') add('ai-candidate', 2, `Model-proposed reading awaiting confirmation: ${run.sentence}`, `Passed deterministic validation${r.validation.flags.length > 0 ? ` (flags: ${r.validation.flags.join(', ')})` : ''}. Not merged; confirm it to compile it as a user instruction.`);
    }
  }
  items.sort((a, b) => a.priority - b.priority || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const byKind: Record<string, number> = {};
  const byPriority: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };
  for (const i of items) {
    byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
    byPriority[i.priority] += 1;
  }
  return { items, summary: { byKind, byPriority } };
}
