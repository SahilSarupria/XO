import type { ApiProblem } from '../platform/client';
import type { Capability, Execution } from '../platform/wire';

/**
 * The review state shown to a person. It is DERIVED, never stored or invented, from
 * exactly two real platform facts per capability: its binding `status` and its
 * `approved` flag.
 *
 *  needs_attention   status is unresolved / ambiguous / denied. XO found the rule but
 *                    cannot carry it out yet. It cannot be approved from Studio.
 *  ready_for_review  status is resolved and no approval record exists.
 *  approved          an approval record exists AND the capability is resolved.
 *
 * What this deliberately does NOT claim:
 *  - There is no "authorized" state. Authorization beyond the approval record is not
 *    enforced on API execution paths yet (P1.0 M2 is not merged), so Studio shows
 *    approval as exactly what it is: a recorded approval.
 *  - There is no "validated" state. The API exposes no validation result per capability;
 *    `confidence` is XO's own estimate and is labelled as such.
 *  - An approval record on an unresolved capability can exist server-side (the approve
 *    route only checks membership). That is surfaced as needs_attention, not approved.
 */
export type ReviewState = 'needs_attention' | 'ready_for_review' | 'approved';

export function reviewStateOf(c: Capability): ReviewState {
  if (c.status !== 'resolved') return 'needs_attention';
  return c.approved ? 'approved' : 'ready_for_review';
}

/** Studio only offers Approve where it is meaningful; the server enforces its own rules regardless. */
export function canApprove(c: Capability): boolean {
  return reviewStateOf(c) === 'ready_for_review';
}

export function canRun(c: Capability): boolean {
  return reviewStateOf(c) === 'approved';
}

export const REVIEW_STATE_LABEL: Record<ReviewState, string> = {
  needs_attention: 'Needs more information',
  ready_for_review: 'Ready for your review',
  approved: 'Approval recorded',
};

export const REVIEW_STATE_EXPLANATION: Record<ReviewState, string> = {
  needs_attention: 'XO found this rule in your document, but does not yet have enough detail to carry it out on its own.',
  ready_for_review: 'XO can carry this out. Check that it matches what your document says, then approve it.',
  approved:
    'An approval is recorded for this rule. It is not a guarantee that a run will succeed: XO still checks the details you provide when you run it.',
};

export function executionClassLabel(executionClass: string | undefined): string | undefined {
  if (executionClass === undefined) return undefined;
  if (executionClass === 'deterministic_rule') return 'Runs automatically';
  if (executionClass === 'human_in_the_loop') return 'Needs a person to decide';
  return executionClass;
}

export interface ReviewSummary {
  readonly total: number;
  readonly needsAttention: number;
  readonly readyForReview: number;
  readonly approved: number;
}

export function summarize(caps: readonly Capability[]): ReviewSummary {
  let needsAttention = 0;
  let readyForReview = 0;
  let approved = 0;
  for (const c of caps) {
    const s = reviewStateOf(c);
    if (s === 'needs_attention') needsAttention++;
    else if (s === 'ready_for_review') readyForReview++;
    else approved++;
  }
  return { total: caps.length, needsAttention, readyForReview, approved };
}

/** Most recent execution per capability within one compilation. */
export function latestExecutionByCapability(executions: readonly Execution[], compilationId: string): ReadonlyMap<string, Execution> {
  const map = new Map<string, Execution>();
  for (const e of executions) {
    if (e.compilationId !== compilationId) continue;
    const prev = map.get(e.capabilityId);
    if (prev === undefined || e.requestedAt > prev.requestedAt) map.set(e.capabilityId, e);
  }
  return map;
}

export type OutcomeTone = 'success' | 'warning' | 'danger' | 'neutral';
export interface OutcomeView {
  readonly label: string;
  readonly tone: OutcomeTone;
  readonly detail?: string;
  /** What the person can do about it. Present for failures the platform describes with a known code. */
  readonly hint?: string;
}

/** Platform error codes Studio gives specific wording to. Anything else falls back to the platform's own message. */
export const PLATFORM_CODE = {
  BINDING_UNRESOLVED: 'XO_BINDING_UNRESOLVED',
  BINDING_AMBIGUOUS: 'XO_BINDING_AMBIGUOUS',
  BINDING_DENIED: 'XO_BINDING_DENIED',
  INPUT_INVALID: 'XO_RUNTIME_CAPABILITY_INPUT_INVALID',
} as const;

function isBindingCode(code: string | undefined): boolean {
  return code === PLATFORM_CODE.BINDING_UNRESOLVED || code === PLATFORM_CODE.BINDING_AMBIGUOUS || code === PLATFORM_CODE.BINDING_DENIED;
}

const BINDING_HINT = 'XO found this rule but cannot carry it out yet, so nothing ran. It needs a clearer or more complete source document.';
const INPUT_HINT = 'Nothing ran. Check the details you entered against the message above and try again.';

/** How an execution is described to a person. A failed run is never shown as a success. */
export function describeExecution(e: Execution): OutcomeView {
  switch (e.status) {
    case 'succeeded':
      return { label: 'Completed', tone: 'success' };
    case 'waiting_for_human':
      return e.humanTask?.status === 'resolved'
        ? { label: 'Decision recorded', tone: 'neutral' }
        : {
            label: 'Waiting for a person to decide',
            tone: 'warning',
            detail: 'XO paused here on purpose. A person needs to approve or reject.',
          };
    case 'rejected':
      return { label: 'Rejected by a person', tone: 'neutral' };
    case 'running':
      return { label: 'Running', tone: 'neutral' };
    case 'failed':
      return {
        label: 'Did not complete',
        tone: 'danger',
        ...(e.errorMessage !== undefined ? { detail: e.errorMessage } : {}),
        ...(isBindingCode(e.errorCode) ? { hint: BINDING_HINT } : e.errorCode === PLATFORM_CODE.INPUT_INVALID ? { hint: INPUT_HINT } : {}),
      };
  }
}

/**
 * The input contract of a capability is not exposed by the API (see STUDIO_ARCHITECTURE.md,
 * platform gap G1). The only place the platform names required fields is the validation
 * failure message of a run attempt. This extracts names from messages shaped like
 * "input validation failed: claim: missing required property; x: missing required property".
 * It is a convenience that degrades to "no suggestions" — never a source of truth.
 */
export function suggestedFieldsFromFailure(e: Execution): string[] {
  if (e.errorCode !== 'XO_RUNTIME_CAPABILITY_INPUT_INVALID' || e.errorMessage === undefined) return [];
  const body = e.errorMessage.replace(/^input validation failed:\s*/, '');
  const names: string[] = [];
  for (const part of body.split(';')) {
    const m = /^\s*([A-Za-z0-9_.\-]+):\s*missing required property\s*$/.exec(part);
    if (m?.[1] !== undefined && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/** Entered text becomes JSON when it parses as JSON, otherwise it is sent as a plain string. */
export function coerceFieldValue(raw: string): unknown {
  const t = raw.trim();
  if (t.length === 0) return '';
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return raw;
  }
}

export interface ProblemView {
  readonly title: string;
  readonly body: string;
  /** What the person can do next. Always present: a dead end is a bug. */
  readonly next: string;
}

/**
 * User-appropriate wording per problem kind. Wording avoids leaking internals; the raw
 * platform code/message remains available to Builder Mode via `problem` itself.
 */
export function describeProblem(p: ApiProblem): ProblemView {
  // A platform code that says exactly why is more useful than the generic wording for its HTTP class.
  if (isBindingCode(p.code)) {
    return {
      title: 'XO cannot carry this rule out yet',
      body: 'The rule was found in your document, but XO does not have enough detail to act on it, so nothing was recorded or run.',
      next: 'Add a clearer or more complete document and analyse it again.',
    };
  }
  switch (p.kind) {
    case 'unauthenticated':
      return {
        title: 'Your access key was not accepted',
        body: 'XO could not confirm who you are, so nothing was done.',
        next: 'Check the key and try again, or ask your administrator for a new one.',
      };
    case 'forbidden':
      // 403 covers more than one cause (e.g. the rule is not approved, or the account is not allowed). Studio does not guess which.
      return {
        title: 'XO refused this action',
        body: 'XO understood the request but did not allow it. Either the rule is not approved or your account is not permitted to do this. Nothing was run.',
        next: 'Refresh and check the rule shows an approval; otherwise ask an administrator for access.',
      };
    case 'not_found':
      // The platform answers 404 for things you cannot access as well as things that do not exist, on purpose. Studio does not say which.
      return {
        title: 'XO could not find that for you',
        body: 'It does not exist, or you do not have access to it. XO does not say which.',
        next: 'Go back and choose something from your workspace.',
      };
    case 'rejected':
      return { title: 'XO did not accept this request', body: p.message, next: 'Adjust what you sent and try again.' };
    case 'unavailable':
      return {
        title: 'This is not available yet',
        body: 'XO deliberately does not offer this action right now. Nothing was attempted.',
        next: 'This will appear once the platform supports it.',
      };
    case 'server':
      return {
        title: 'XO ran into a problem',
        body: 'The service failed while handling your request. Your data was not changed unless shown otherwise.',
        next: 'Try again in a moment. If it keeps happening, contact your administrator.',
      };
    case 'network':
      return {
        title: 'Cannot reach XO',
        body: 'Studio could not connect to the XO service.',
        next: 'Check that the service is running and your connection is working.',
      };
    case 'malformed':
      return {
        title: 'XO sent something Studio could not trust',
        body: 'The response did not match what Studio expects, so it was not shown.',
        next: 'Try again. If it keeps happening, the service and Studio may be out of step — contact your administrator.',
      };
  }
}

export interface Progress {
  readonly step: 'context' | 'analyze' | 'review' | 'run' | 'done';
  readonly headline: string;
  readonly hint: string;
}

/** The single most useful next step, derived from real workspace facts. */
export function nextStep(args: {
  sources: number;
  succeededCompilations: number;
  summary: ReviewSummary | undefined;
  executions: number;
}): Progress {
  if (args.sources === 0)
    return {
      step: 'context',
      headline: 'Add your first document',
      hint: 'Upload a policy, procedure or rulebook. XO reads it and finds the rules inside.',
    };
  if (args.succeededCompilations === 0)
    return {
      step: 'analyze',
      headline: 'Analyse your document',
      hint: 'XO will read it and list the rules it finds, with the evidence for each.',
    };
  const s = args.summary;
  if (s !== undefined && s.approved === 0)
    return {
      step: 'review',
      headline: 'Review what XO found',
      hint: 'Approve the rules that match your document. Nothing runs without your approval.',
    };
  if (args.executions === 0)
    return { step: 'run', headline: 'Try an approved rule', hint: 'Run one approved rule to see exactly what XO does with it.' };
  return { step: 'done', headline: 'Keep going', hint: 'Review more rules, add more documents, or check your run history.' };
}
