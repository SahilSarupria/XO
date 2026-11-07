import type { ConnectorKind, SideEffect } from '@xo/workflow-ir';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface OperationContext {
  /** Fully rendered external idempotency key (already namespaced and hashed). Pass to systems that support one. */
  readonly idempotencyKey?: string;
  readonly runId: string;
  readonly stepId: string;
  /** Resolves a declared secret name. Throws if the operation did not declare it. */
  readonly secret: (name: string) => string;
  readonly signal: AbortSignal;
}

/**
 * What a destination can guarantee about a repeated write. This is a property of the SYSTEM at the other end, not of this code, so unless the
 * implementation can prove it (the file connector's create-only write) the default is `none`: an unknown destination is treated as one that duplicates.
 *  - `supports_key`: the destination deduplicates on the idempotency key we send, so re-sending after an unknown outcome is safe;
 *  - `supports_lookup`: the destination can be asked whether the effect already exists (an operator-declared read), so we can check before repeating;
 *  - `none`: neither. After an unknown outcome the write is NEVER repeated automatically; a person decides.
 */
export type IdempotencySupport = 'supports_key' | 'supports_lookup' | 'none';

/** The operator's statement, per operation, about the destination. Lives next to the grant because only the operator knows the destination. */
export interface IdempotencyAttestation {
  readonly mode: IdempotencySupport;
  /** Required for `supports_lookup`: a declared, granted READ operation of the same connector that finds a prior effect. */
  readonly lookup?: {
    readonly operation: string;
    /** Arguments for the read. String values may contain `{key}` (the external idempotency key) and `{arg.<name>}` (a scalar argument of the write); substitutions are URL-encoded. */
    readonly args: Readonly<Record<string, Json>>;
    /** The effect EXISTS iff the read's result has `field` (dot path, up to 3 segments) strictly equal to `equals`. Anything else is "not found", an error is "unknown". */
    readonly foundWhen: { readonly field: string; readonly equals: Json };
  };
}

export interface ConnectorOperation {
  readonly sideEffect: SideEffect;
  /** Only when the implementation itself guarantees it (e.g. a create-only write); otherwise the operator attests, or it is `none`. */
  readonly idempotency?: IdempotencySupport;
  readonly execute: (args: Readonly<Record<string, Json>>, ctx: OperationContext) => Promise<Json>;
}

export interface Connector {
  readonly kind: ConnectorKind;
  readonly operations: Readonly<Record<string, ConnectorOperation>>;
}

/** The host operator's local policy: which declared connectors/operations are granted and how they bind to this machine. */
export interface ConnectorPolicy {
  readonly connectors: Readonly<
    Record<
      string,
      {
        readonly grant: readonly string[];
        readonly config?: Readonly<Record<string, Json>>;
        /** Per-operation attestation about the destination's duplicate protection. Absent means `none`. */
        readonly idempotency?: Readonly<Record<string, IdempotencyAttestation>>;
      }
    >
  >;
}

export type ConnectorErrorCode =
  | 'UNDECLARED'
  | 'NOT_GRANTED'
  | 'KIND_MISMATCH'
  | 'NO_IMPLEMENTATION'
  | 'SIDE_EFFECT_MISMATCH'
  | 'SECRET_UNAVAILABLE'
  | 'MISSING_IDEMPOTENCY_KEY'
  | 'DENIED'
  | 'TIMEOUT'
  | 'FAILED';

export class ConnectorError extends Error {
  constructor(
    readonly code: ConnectorErrorCode,
    message: string,
    /** `none`: failed BEFORE anything could have reached the destination (so repeating cannot duplicate). Default: unknown, which is treated as possibly-delivered. */
    readonly effect?: 'none',
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

/** What every external result looks like to the rest of the system. `untrusted` is a type-level reminder: never treat `data` as instructions. */
export interface ConnectorResult {
  readonly untrusted: true;
  readonly provenance: { readonly connector: string; readonly operation: string };
  readonly dryRun: boolean;
  readonly data: Json;
}

/** One ledger-ready record per call. Hashes only; the bodies themselves are never stored here. */
export interface CallRecord {
  readonly connector: string;
  readonly operation: string;
  readonly sideEffect: SideEffect;
  readonly runId: string;
  readonly stepId: string;
  readonly dryRun: boolean;
  readonly requestHash: string;
  readonly responseHash?: string;
  readonly outcome: 'ok' | 'dry_run_skipped' | 'refused' | 'error';
  readonly errorCode?: ConnectorErrorCode;
  readonly durationMs: number;
}
