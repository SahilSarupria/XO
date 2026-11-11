import type { AdapterInvokeRequest, AdapterInvokeResult, ExternalToolAdapter } from '@xo/adapters';

/**
 * Local, deterministic reference "external system" for M4 tests and demos.
 *
 * It is in-process: no sockets, no clock, no randomness, no credentials, no real side effects.
 * Its only "effect" is appending to an in-memory list, which tests can inspect to prove
 * whether an effect really happened — independent of what the adapter was able to report.
 *
 * Behaviour is chosen by the request's `scenario` field:
 *   - 'accept'  : applies the effect, replies success.
 *   - 'reject'  : refuses BEFORE applying anything, replies a clean rejection (no effect).
 *   - 'drop'    : applies the effect, then the "connection drops" before any reply — the
 *                 adapter cannot know what happened. This is the ambiguity M4 must never
 *                 report as success.
 *   - 'garbled' : applies the effect, replies with a malformed reply.
 */
export type ReferenceScenario = 'accept' | 'reject' | 'drop' | 'garbled';

export interface ReferenceEffect {
  readonly dispatchKey: string;
  readonly amount: number;
}

export class ReferenceService {
  readonly effects: ReferenceEffect[] = [];
  readonly requests: AdapterInvokeRequest[] = [];

  /** Wire-level behaviour. Throws to model a dropped connection. */
  handle(request: AdapterInvokeRequest): unknown {
    this.requests.push(request);
    const scenario = request.input['scenario'];
    const amount = request.input['amount'];
    if (scenario === 'reject' || typeof amount !== 'number') {
      return { status: 'rejected', reason: 'amount rejected by the reference service' };
    }
    this.effects.push({ dispatchKey: request.dispatchKey, amount });
    if (scenario === 'drop') throw new Error('connection reset before reply');
    if (scenario === 'garbled') return 'ok??';
    return { status: 'applied', receipt: `rcpt-${this.effects.length}` };
  }
}

/** Adapter over the reference service. Reports `confirmed_failure_no_effect` ONLY for the service's explicit rejection. */
export function createReferenceAdapter(
  service: ReferenceService,
  id = 'reference-service',
  approvalMode: 'definition' | 'payload' = 'definition',
): ExternalToolAdapter {
  return {
    id,
    approvalMode,
    async invoke(request: AdapterInvokeRequest): Promise<AdapterInvokeResult> {
      let reply: unknown;
      try {
        reply = service.handle(request);
      } catch (cause) {
        return {
          kind: 'outcome_unknown',
          reason: `no reply from the reference service (${cause instanceof Error ? cause.message : String(cause)})`,
        };
      }
      if (typeof reply === 'object' && reply !== null) {
        const r = reply as Record<string, unknown>;
        if (r['status'] === 'applied') return { kind: 'confirmed_success', output: { receipt: r['receipt'] } };
        if (r['status'] === 'rejected') {
          return { kind: 'confirmed_failure_no_effect', code: 'REFERENCE_REJECTED', message: String(r['reason']) };
        }
      }
      return { kind: 'outcome_unknown', reason: 'unrecognised reply from the reference service' };
    },
  };
}
