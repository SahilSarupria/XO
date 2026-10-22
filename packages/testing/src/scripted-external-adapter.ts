import type { AdapterInvokeRequest, AdapterInvokeResult, ExternalToolAdapter } from '@xo/adapters';

/** One scripted reaction: a declared result, a throw, a rejection after a tick, or an arbitrary (malformed) value. */
export type ScriptedAdapterStep =
  { readonly returns: AdapterInvokeResult } | { readonly throws: string } | { readonly rejects: string } | { readonly returnsRaw: unknown };

/**
 * Deterministic test double for `ExternalToolAdapter`. It performs NO I/O and has no clock.
 * It records every call, so tests can assert "zero adapter calls" on every denial path
 * and "exactly one call" on every dispatch (no automatic retries).
 * With no script left it answers `outcome_unknown` (never success).
 */
export class ScriptedExternalAdapter implements ExternalToolAdapter {
  readonly calls: AdapterInvokeRequest[] = [];
  private readonly script: ScriptedAdapterStep[];

  constructor(
    readonly id: string,
    script: readonly ScriptedAdapterStep[] = [],
  ) {
    this.script = [...script];
  }

  async invoke(request: AdapterInvokeRequest): Promise<AdapterInvokeResult> {
    this.calls.push(request);
    const step = this.script.shift();
    if (step === undefined) return { kind: 'outcome_unknown', reason: 'scripted adapter has no further scripted response' };
    if ('throws' in step) throw new Error(step.throws);
    if ('rejects' in step) return Promise.reject(new Error(step.rejects));
    if ('returnsRaw' in step) return step.returnsRaw as AdapterInvokeResult;
    return step.returns;
  }
}
