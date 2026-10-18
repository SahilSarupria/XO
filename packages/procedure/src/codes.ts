/**
 * Stable, local error codes (P1.1 M1; local union confirmed by the owner 2026-10-18).
 * Deliberately NOT added to the shared `@xo/errors` enum (that would touch an existing
 * package). A finding carries only a code and a JSON-pointer path (limit findings use a
 * constant path) — never a submitted value.
 */
/**
 * Owner-approved resource limits (P1.1 O-2 / N-10, decision of 2026-10-18).
 * Library-owned constants: NOT caller-configurable, and `limits` in a document stays a
 * rejected authority field. A route-level body cap is a separate M2 concern.
 */
export const MAX_PROCEDURE_BYTES = 262_144; // UTF-8 bytes of the raw input (256 KiB)
export const MAX_PROCEDURE_DEPTH = 16; // nested containers, root container = depth 1
export const MAX_PROCEDURE_STEPS = 25; // entries in the top-level `steps` array

export type ProcedureErrorCode =
  | 'PROC_BODY_TOO_LARGE'
  | 'PROC_TOO_DEEP'
  | 'PROC_TOO_MANY_STEPS'
  | 'PROC_INVALID_ENCODING'
  | 'PROC_INVALID_JSON'
  | 'PROC_DUPLICATE_KEY'
  | 'PROC_FORBIDDEN_KEY'
  | 'PROC_NOT_AN_OBJECT'
  | 'PROC_UNKNOWN_FIELD'
  | 'PROC_AUTHORITY_FIELD'
  | 'PROC_MISSING_FIELD'
  | 'PROC_INVALID_FIELD'
  | 'PROC_UNSUPPORTED_SCHEMA'
  | 'PROC_UNSUPPORTED_NODE'
  | 'PROC_AI_STEP_DISABLED'
  | 'PROC_DUPLICATE_ID'
  | 'PROC_INVALID_PATH'
  | 'PROC_INVALID_CONDITION'
  | 'PROC_DANGLING_EDGE'
  | 'PROC_DANGLING_REFERENCE'
  | 'PROC_BINDING_NOT_UPSTREAM'
  | 'PROC_GRAPH_CYCLE'
  | 'PROC_UNREACHABLE'
  | 'PROC_AMBIGUOUS_ORDER'
  | 'PROC_EMPTY'
  // P1.1 M2 — produced only by registry-dependent validation (apps/api), never by the pure M1 validator.
  | 'PROC_PATH_MISMATCH'
  | 'PROC_COMPILATION_REF_REQUIRED'
  | 'PROC_COMPILATION_UNAVAILABLE'
  | 'PROC_COMPILATION_DRIFT'
  | 'PROC_UNRESOLVED_CAPABILITY'
  | 'PROC_CONTRACT_MISMATCH'
  | 'PROC_UNSUPPORTED_CAPABILITY_CLASS'
  | 'PROC_PERMISSION_DECLARATION_UNRESOLVED'
  | 'PROC_UNKNOWN_INPUT_PARAM'
  | 'PROC_BINDING_OUTPUT_UNDECLARED'
  | 'PROC_BINDING_TYPE_MISMATCH'
  | 'PROC_UNBOUND_REQUIRED_INPUT';

export interface ProcedureFinding {
  readonly code: ProcedureErrorCode;
  /** RFC 6901 JSON pointer into the submitted document. Never contains values. */
  readonly path: string;
}

/** Keys that are never accepted anywhere in a document (prototype-pollution vectors). */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Authority-bearing field names. Client input may never define permission,
 * identity, approval, effect classification, binding, capability definitions,
 * limits, human-gate status, or executable/validated status (owner O-2).
 * Matched on exact name, or on prefix for `approval*`, `binding*`, `trust*`.
 */
export const AUTHORITY_FIELDS: ReadonlySet<string> = new Set([
  'permissions',
  'requiredPermissions',
  'grants',
  'principal',
  'identity',
  'approvedBy',
  'effectClass',
  'effect',
  'effectKey',
  'implementationClass',
  'runtimeDeclaration',
  'inputSchema',
  'outputSchema',
  'capabilities',
  'confidence',
  'executable',
  'validated',
  'humanGate',
  'responsibility',
  'limits',
]);
const AUTHORITY_PREFIXES = ['approval', 'binding', 'trust'] as const;

export function isAuthorityField(name: string): boolean {
  return AUTHORITY_FIELDS.has(name) || AUTHORITY_PREFIXES.some((p) => name.startsWith(p));
}
