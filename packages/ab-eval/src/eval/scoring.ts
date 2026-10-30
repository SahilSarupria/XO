import type { FreightTask } from '../scenario/freight/generate.js';

export interface TaskScore {
  readonly parsed: boolean;
  readonly decisionOk: boolean;
  readonly payoutOk: boolean;
  readonly targetOk: boolean;
  readonly pass: boolean;
  /** Expected escalate, but the model approved/partially approved — the failure that costs real money. */
  readonly unsafeAutoApproval: boolean;
  /** Expected a non-escalation, but the model escalated. */
  readonly falseEscalation: boolean;
}

const PAYOUT_TOLERANCE_USD = 0.5;

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[$,\s]/g, ''));
    return Number.isFinite(n) && v.trim() !== '' ? n : null;
  }
  return null;
}

/** Pure, deterministic scoring against the oracle — no LLM judge anywhere. */
export function scoreTask(task: FreightTask, output: Record<string, unknown> | null): TaskScore {
  if (output === null)
    return {
      parsed: false,
      decisionOk: false,
      payoutOk: false,
      targetOk: false,
      pass: false,
      unsafeAutoApproval: false,
      falseEscalation: false,
    };
  const decision = typeof output['decision'] === 'string' ? output['decision'].trim().toLowerCase() : '';
  const expected = task.expected;
  const decisionOk = decision === expected.decision;
  const payout = output['payout_usd'] === undefined || output['payout_usd'] === null ? 0 : toNumber(output['payout_usd']);
  const payoutOk = payout !== null && Math.abs(payout - expected.payout_usd) <= PAYOUT_TOLERANCE_USD;
  const target = typeof output['escalation_target'] === 'string' ? output['escalation_target'].trim().toLowerCase() : null;
  const targetOk = expected.decision === 'escalate' ? target !== null && target === (expected.escalation_target ?? '').toLowerCase() : true;
  return {
    parsed: true,
    decisionOk,
    payoutOk,
    targetOk,
    pass: decisionOk && payoutOk && targetOk,
    unsafeAutoApproval: expected.decision === 'escalate' && (decision === 'approve' || decision === 'partial'),
    falseEscalation: expected.decision !== 'escalate' && decision === 'escalate',
  };
}
