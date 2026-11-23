import type { EvidenceStep, RunEvidence } from '../platform/wire-control';

/**
 * UW-12b (ADR 0052): the evidence for one result in plain words. The platform sends facts and codes; these are the words a person
 * reads. An unknown code is shown as it came, never hidden. Nothing here reads a recipient, a cell value or a document's contents.
 */

/** How a document was matched to the person it is for. 'exact' is the only match XO treats as certain. */
export function matchWords(match: string): string {
  if (match === 'exact') return 'matched exactly';
  if (match === 'loose') return 'matched loosely, so a person should check it';
  return `matched by another rule (${match})`;
}

export function decidedByWords(s: EvidenceStep): string {
  switch (s.decidedBy) {
    case 'person':
      return s.by !== undefined ? `decided by ${s.by}` : 'decided by a person';
    case 'batch_approval':
      return 'covered by the batch approval';
    case 'standing_approval':
      return 'covered by a standing approval';
  }
}

export function approvalWords(e: RunEvidence): string | undefined {
  const a = e.approval;
  if (a === undefined) return undefined;
  if (a.kind === 'standing') return `Went ahead under a standing approval, approved by ${a.reviewerId}.`;
  return `Approved in a batch by ${a.reviewerId}${a.selfApproved ? ' (who also prepared it)' : ''}.`;
}

export function effectStateWords(state: string): string {
  switch (state) {
    case 'confirmed':
      return 'done';
    case 'outcome_unknown':
      return 'outcome unknown, needs a check';
    case 'intended':
      return 'about to happen';
    case 'not_sent':
      return 'not sent';
    default:
      return state;
  }
}

export const manifestWords = (e: RunEvidence): string =>
  e.manifest.digestOk
    ? 'This run used exactly the workflow that was certified.'
    : 'The workflow this run used does not match its certificate. Do not rely on it.';

/** What a retained output is, for the outputs panel: who can open it and how long it is kept. */
export const keptWords = (kept: string): string => (kept === '' ? 'No retention is recorded' : `Kept ${kept}`);
