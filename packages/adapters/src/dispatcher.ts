import type { AdapterInvokeResult, DispatchLedger, ExternalEffectState, ExternalToolAdapter } from './contract.js';

/**
 * What a dispatch call can end in. The first four never reached the adapter
 * (`dispatched: false`): nothing external happened.
 */
export type DispatchOutcome =
  | { readonly kind: 'not_configured'; readonly dispatched: false; readonly reason: string }
  | { readonly kind: 'invalid_request'; readonly dispatched: false; readonly reason: string }
  | { readonly kind: 'ledger_unavailable'; readonly dispatched: false; readonly reason: string }
  | {
      /** A prior attempt exists for this key; re-dispatch is refused. `requiresReconciliation` is true unless that attempt confirmed success or confirmed no-effect. */
      readonly kind: 'blocked_prior_dispatch';
      readonly dispatched: false;
      readonly priorState: string;
      readonly requiresReconciliation: boolean;
      readonly reason: string;
    }
  | { readonly kind: 'confirmed_success'; readonly dispatched: true; readonly adapterId: string; readonly output: unknown }
  | {
      readonly kind: 'confirmed_failure_no_effect';
      readonly dispatched: true;
      readonly adapterId: string;
      readonly code: string;
      readonly message: string;
    }
  | { readonly kind: 'outcome_unknown'; readonly dispatched: true; readonly adapterId: string; readonly reason: string };

export interface ExternalToolDispatcherOptions {
  /** Explicit configuration: capability (contract) id -> adapter. Nothing else can ever be dispatched. */
  readonly adapters: ReadonlyMap<string, ExternalToolAdapter>;
  readonly ledger: DispatchLedger;
}

const isPlainObject = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Fail-closed, single-shot dispatcher.
 *  - no configured adapter  => nothing is called;
 *  - one dispatch per `dispatchKey`, ever: there is NO retry here, and a second call with the same key is refused;
 *  - `dispatch_attempted` evidence is written BEFORE the adapter is invoked (if that write fails, the adapter is not called);
 *  - a throw, a rejection, or any result that is not exactly one of the three declared shapes is `outcome_unknown`.
 * It never classifies an effect on its own authority and never resolves or clears an unknown outcome.
 */
export class ExternalToolDispatcher {
  private readonly adapters: ReadonlyMap<string, ExternalToolAdapter>;
  private readonly ledger: DispatchLedger;

  constructor(options: ExternalToolDispatcherOptions) {
    this.adapters = new Map(options.adapters);
    this.ledger = options.ledger;
  }

  /** True only for an explicitly configured capability id. */
  isConfigured(capabilityId: string): boolean {
    return this.adapters.has(capabilityId);
  }

  adapterIdFor(capabilityId: string): string | undefined {
    return this.adapters.get(capabilityId)?.id;
  }

  async dispatch(capabilityId: string, dispatchKey: string, input: unknown): Promise<DispatchOutcome> {
    const adapter = this.adapters.get(capabilityId);
    if (adapter === undefined) {
      return { kind: 'not_configured', dispatched: false, reason: `no adapter is configured for capability "${capabilityId}"` };
    }
    if (typeof dispatchKey !== 'string' || dispatchKey.length === 0) {
      return { kind: 'invalid_request', dispatched: false, reason: 'a server-derived dispatchKey is required' };
    }
    if (!isPlainObject(input)) {
      return { kind: 'invalid_request', dispatched: false, reason: 'external_tool input must be a plain object' };
    }

    let prior: ReturnType<DispatchLedger['read']>;
    try {
      prior = this.ledger.read(dispatchKey);
    } catch (cause) {
      return { kind: 'ledger_unavailable', dispatched: false, reason: `evidence ledger unreadable: ${describe(cause)}` };
    }
    if (prior.length > 0) {
      const last = prior[prior.length - 1]!;
      const settled = last.state === 'confirmed_success' || last.state === 'confirmed_failure_no_effect';
      return {
        kind: 'blocked_prior_dispatch',
        dispatched: false,
        priorState: last.state,
        requiresReconciliation: !settled,
        reason: settled
          ? `dispatch "${dispatchKey}" already ran (${last.state}); a second dispatch under the same key is refused`
          : `dispatch "${dispatchKey}" has a prior attempt in state ${last.state}; reconciliation is required before any further dispatch`,
      };
    }

    try {
      this.ledger.append({ dispatchKey, capabilityId, adapterId: adapter.id, state: 'dispatch_attempted' });
    } catch (cause) {
      return {
        kind: 'ledger_unavailable',
        dispatched: false,
        reason: `evidence could not be recorded, so nothing was dispatched: ${describe(cause)}`,
      };
    }

    let raw: unknown;
    try {
      raw = await adapter.invoke({ capabilityId, dispatchKey, input: Object.freeze({ ...input }) });
    } catch (cause) {
      return this.settle(capabilityId, dispatchKey, adapter, {
        kind: 'outcome_unknown',
        reason: `adapter threw after dispatch: ${describe(cause)}`,
      });
    }
    return this.settle(capabilityId, dispatchKey, adapter, normalize(raw));
  }

  private settle(capabilityId: string, dispatchKey: string, adapter: ExternalToolAdapter, result: AdapterInvokeResult): DispatchOutcome {
    const detail =
      result.kind === 'outcome_unknown'
        ? result.reason
        : result.kind === 'confirmed_failure_no_effect'
          ? `${result.code}: ${result.message}`
          : undefined;
    try {
      this.ledger.append({
        dispatchKey,
        capabilityId,
        adapterId: adapter.id,
        state: result.kind satisfies ExternalEffectState,
        ...(detail !== undefined ? { detail } : {}),
      });
    } catch (cause) {
      // The adapter already ran. If the terminal evidence cannot be recorded the result cannot be trusted to be reconstructable: report unknown.
      return {
        kind: 'outcome_unknown',
        dispatched: true,
        adapterId: adapter.id,
        reason: `adapter reported ${result.kind} but the terminal evidence could not be recorded: ${describe(cause)}`,
      };
    }
    switch (result.kind) {
      case 'confirmed_success':
        return { kind: 'confirmed_success', dispatched: true, adapterId: adapter.id, output: result.output };
      case 'confirmed_failure_no_effect':
        return { kind: 'confirmed_failure_no_effect', dispatched: true, adapterId: adapter.id, code: result.code, message: result.message };
      case 'outcome_unknown':
        return { kind: 'outcome_unknown', dispatched: true, adapterId: adapter.id, reason: result.reason };
    }
  }
}

function normalize(raw: unknown): AdapterInvokeResult {
  if (isPlainObject(raw)) {
    if (raw['kind'] === 'confirmed_success' && 'output' in raw) return { kind: 'confirmed_success', output: raw['output'] };
    if (raw['kind'] === 'confirmed_failure_no_effect' && typeof raw['code'] === 'string' && typeof raw['message'] === 'string') {
      return { kind: 'confirmed_failure_no_effect', code: raw['code'], message: raw['message'] };
    }
    if (raw['kind'] === 'outcome_unknown' && typeof raw['reason'] === 'string') return { kind: 'outcome_unknown', reason: raw['reason'] };
  }
  return { kind: 'outcome_unknown', reason: 'adapter returned a result that is not one of the declared outcome shapes' };
}

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
