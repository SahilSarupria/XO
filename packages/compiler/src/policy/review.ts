import type { Extraction, UnrecognizedClause } from './extract.js';
import { addProposal, type ClauseProposal, type ReviewItem } from './model-extract.js';

/**
 * Human review loop. A reviewer sees each `ReviewItem` and accepts, edits or rejects it. Decisions are stored in a
 * `ReviewLedger` (plain JSON, keyed by the source sentence) so they survive recompilation: the next compile replays
 * accepted/edited rules as operator-origin steps and never asks again about rejected sentences.
 * An operator's proposal passes the SAME deterministic checks as a model's — a human edit cannot smuggle in a number
 * that is not in the quoted text.
 */

export type ReviewDecision =
  | { readonly sentence: string; readonly action: 'accept' }
  | { readonly sentence: string; readonly action: 'edit'; readonly proposal: ClauseProposal }
  | { readonly sentence: string; readonly action: 'reject'; readonly note?: string };

export interface ReviewLedger {
  readonly accepted: readonly { readonly sentence: string; readonly proposal: ClauseProposal }[];
  readonly rejected: readonly { readonly sentence: string; readonly note?: string }[];
}
export const EMPTY_LEDGER: ReviewLedger = { accepted: [], rejected: [] };

export interface ReviewOutcome {
  readonly extraction: Extraction;
  readonly ledger: ReviewLedger;
  /** decisions that could not be applied (unknown sentence, or the proposal failed the checks), with reasons */
  readonly refused: readonly { readonly sentence: string; readonly reasons: readonly string[] }[];
  readonly review: readonly ReviewItem[];
}

export function applyReviewDecisions(
  extraction: Extraction,
  review: readonly ReviewItem[],
  decisions: readonly ReviewDecision[],
  ledger: ReviewLedger = EMPTY_LEDGER,
): ReviewOutcome {
  let program = extraction.program;
  const accepted = [...ledger.accepted];
  const rejected = [...ledger.rejected];
  const refused: { sentence: string; reasons: string[] }[] = [];
  const closed = new Set<string>();
  let n = accepted.length;
  // Decisions may depend on one another (one rule's expression reads a quantity another defines), so apply them in
  // passes until no further decision can be applied; whatever is still refused then is reported with its reasons.
  let pending: ReviewDecision[] = [...decisions];
  let lastReasons = new Map<string, string[]>();
  for (let pass = 0; pass < 8 && pending.length > 0; pass++) {
    const next: ReviewDecision[] = [];
    lastReasons = new Map();
    for (const d of pending) {
      const item = review.find((r) => r.sentence === d.sentence);
      const clause: UnrecognizedClause | undefined = extraction.unrecognized.find((u) => u.sentence === d.sentence);
      if (item === undefined || clause === undefined) {
        lastReasons.set(d.sentence, ['no such item awaiting review']);
        continue;
      }
      if (d.action === 'reject') {
        rejected.push({ sentence: d.sentence, ...(d.note ? { note: d.note } : {}) });
        closed.add(d.sentence);
        continue;
      }
      const proposal = d.action === 'edit' ? d.proposal : item.proposal;
      if (proposal === undefined) {
        lastReasons.set(d.sentence, ['nothing to accept: provide an edited proposal']);
        continue;
      }
      n += 1;
      const res = addProposal(program, proposal, clause, 'operator', n);
      if ('reasons' in res) {
        lastReasons.set(d.sentence, res.reasons);
        next.push(d);
        continue;
      }
      program = res.program;
      accepted.push({ sentence: d.sentence, proposal });
      closed.add(d.sentence);
    }
    if (next.length === pending.filter((d) => d.action !== 'reject').length && next.length === pending.length) {
      pending = next;
      break;
    }
    pending = next;
  }
  for (const d of pending) refused.push({ sentence: d.sentence, reasons: lastReasons.get(d.sentence) ?? ['could not be applied'] });
  return {
    extraction: { ...extraction, program, unrecognized: extraction.unrecognized.filter((u) => !closed.has(u.sentence)) },
    ledger: { accepted, rejected },
    refused,
    review: review.filter((r) => !closed.has(r.sentence)),
  };
}

/** Replays a stored ledger on a fresh extraction (before any model call). Rejected sentences stay out of the review list. */
export function applyLedger(extraction: Extraction, ledger: ReviewLedger): Extraction {
  let program = extraction.program;
  const closed = new Set(ledger.rejected.map((r) => r.sentence));
  let n = 0;
  for (const a of ledger.accepted) {
    const clause = extraction.unrecognized.find((u) => u.sentence === a.sentence);
    if (clause === undefined) continue; // the document changed; the ruling no longer applies
    n += 1;
    const res = addProposal(program, a.proposal, clause, 'operator', n);
    if ('program' in res) {
      program = res.program;
      closed.add(a.sentence);
    }
  }
  return { ...extraction, program, unrecognized: extraction.unrecognized.filter((u) => !closed.has(u.sentence)) };
}
