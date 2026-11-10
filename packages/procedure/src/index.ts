import { parseStrictJson } from './parse.js';
import { validateStructure } from './validate.js';
import { procedureHash } from './canonical.js';
import type { ProcedureFinding } from './codes.js';
import type { ProcedureDefinition } from './definition.js';

export * from './codes.js';
export * from './definition.js';
export { parseStrictJson, utf8ByteLengthExceeds, type ParseResult } from './parse.js';
export { canonicalJson, procedureHash } from './canonical.js';
export { lowerToWorkflowGraph, lowerCondition } from './lower.js';

export type ProcedureValidation =
  | { readonly ok: true; readonly definition: ProcedureDefinition; readonly procedureHash: string }
  | { readonly ok: false; readonly findings: readonly ProcedureFinding[] };

/**
 * Raw text/bytes -> strict parse -> local static validation -> canonical hash.
 * Enforces the owner-approved limits (bytes/depth/steps) before validation or lowering.
 * Never throws. Findings are code + JSON pointer only (no submitted values).
 * Registry-dependent checks (contract-hash drift, capability/binding resolution) are NOT performed (M2).
 */
export function validateProcedure(input: string | Uint8Array): ProcedureValidation {
  const parsed = parseStrictJson(input);
  if (!parsed.ok) return { ok: false, findings: parsed.findings };
  const r = validateStructure(parsed.value);
  if (!r.definition) return { ok: false, findings: r.findings };
  return { ok: true, definition: r.definition, procedureHash: procedureHash(r.definition) };
}
