/**
 * M4 adapter contract.
 *
 * EFFECT STATES. The owner-approved effect model (O-3) names six states:
 * intent_recorded, dispatch_attempted, confirmed_success,
 * confirmed_failure_no_effect, outcome_unknown, reconciliation_required.
 * Their exact definitions (Review §5.3) are NOT available in this repository,
 * so this package does not define transitions between them and implements no
 * recovery. It only uses the state NAMES a single dispatch can honestly end in:
 *   - `dispatch_attempted`  — written to the ledger BEFORE the adapter is called;
 *   - `confirmed_success`, `confirmed_failure_no_effect`, `outcome_unknown` —
 *     the adapter's reported terminal result.
 * Anything not positively reported as confirmed is `outcome_unknown`.
 */

/** Terminal states a dispatch can produce (names from the approved O-3 model). */
export type ExternalEffectState = 'confirmed_success' | 'confirmed_failure_no_effect' | 'outcome_unknown';

/** Every state this package writes to the evidence ledger. */
export type LedgerEffectState = 'dispatch_attempted' | ExternalEffectState;

export interface AdapterInvokeRequest {
  readonly capabilityId: string;
  /** Server-derived identity of THIS dispatch (never client-supplied). One dispatch per key, ever. */
  readonly dispatchKey: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export type AdapterInvokeResult =
  | { readonly kind: 'confirmed_success'; readonly output: unknown }
  | { readonly kind: 'confirmed_failure_no_effect'; readonly code: string; readonly message: string }
  | { readonly kind: 'outcome_unknown'; readonly reason: string };

/**
 * An external system adapter. It MUST report `confirmed_failure_no_effect` only
 * when it positively knows the external system made no change; every other
 * failure or ambiguity (timeouts, dropped connections, malformed replies) is
 * `outcome_unknown`, or a throw/rejection, which the dispatcher maps to it.
 */
export interface ExternalToolAdapter {
  readonly id: string;
  invoke(request: AdapterInvokeRequest): Promise<AdapterInvokeResult>;
}

export interface DispatchEvidence {
  readonly seq: number;
  readonly dispatchKey: string;
  readonly capabilityId: string;
  readonly adapterId: string;
  readonly state: LedgerEffectState;
  readonly detail?: string;
}

/** Retained evidence of dispatch attempts. Appending may fail; a failed append means NO dispatch. */
export interface DispatchLedger {
  read(dispatchKey: string): readonly DispatchEvidence[];
  append(entry: Omit<DispatchEvidence, 'seq'>): void;
}

export class InMemoryDispatchLedger implements DispatchLedger {
  private readonly entries: DispatchEvidence[] = [];
  read(dispatchKey: string): readonly DispatchEvidence[] {
    return this.entries.filter((e) => e.dispatchKey === dispatchKey);
  }
  append(entry: Omit<DispatchEvidence, 'seq'>): void {
    this.entries.push(Object.freeze({ ...entry, seq: this.entries.length + 1 }));
  }
  all(): readonly DispatchEvidence[] {
    return [...this.entries];
  }
}
