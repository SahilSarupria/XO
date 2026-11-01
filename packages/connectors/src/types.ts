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

export interface ConnectorOperation {
  readonly sideEffect: SideEffect;
  readonly execute: (args: Readonly<Record<string, Json>>, ctx: OperationContext) => Promise<Json>;
}

export interface Connector {
  readonly kind: ConnectorKind;
  readonly operations: Readonly<Record<string, ConnectorOperation>>;
}

/** The host operator's local policy: which declared connectors/operations are granted and how they bind to this machine. */
export interface ConnectorPolicy {
  readonly connectors: Readonly<Record<string, { readonly grant: readonly string[]; readonly config?: Readonly<Record<string, Json>> }>>;
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
