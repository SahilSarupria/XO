import { validateProcedure, procedureHash, type ProcedureDefinition } from '@xo/procedure';
import { parsePrincipal, type Principal } from '@xo/permissions';

/** P1.1 M2 — persisted procedure records. Every record is re-verified on read (fail closed: a malformed record is never trusted). */
export const PROCEDURE_RECORD_SCHEMA = 1 as const;
export const PROCEDURE_APPROVAL_SCHEMA = 1 as const;

/** Path-parameter shapes only (never used as a length bound on documents): same identifier grammar as the M1 validator. */
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
export function isValidProcedureId(value: string | undefined): value is string {
  return value !== undefined && ID.test(value) && !RESERVED.has(value);
}
export function parseVersionParam(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

export interface StoredPrincipal {
  readonly kind: 'human' | 'service';
  readonly id: string;
  readonly orgId?: string;
}

export interface ProcedureVersionRecord {
  readonly schemaVersion: typeof PROCEDURE_RECORD_SCHEMA;
  readonly workspaceId: string;
  readonly procedureId: string;
  readonly version: number;
  /** `sha256:` of the canonical JSON of `definition` (M1 `procedureHash`). */
  readonly procedureHash: string;
  readonly createdAt: string;
  readonly author: StoredPrincipal;
  readonly definition: ProcedureDefinition;
}

export interface ProcedureApprovalStep {
  readonly stepId: string;
  readonly contractHash: string;
  readonly permissionFingerprint: string;
  readonly bindingId: string;
}

/** Plan D.3: { procedureId, version, procedureHash, validationReportHash, steps[], approverPrincipalId } plus the registry evidence it was derived from. */
export interface ProcedureApprovalBinding {
  readonly procedureId: string;
  readonly version: number;
  readonly procedureHash: string;
  readonly validationReportHash: string;
  readonly registryStateDigest: string;
  readonly compilationId: string;
  readonly graphHash: string;
  readonly steps: readonly ProcedureApprovalStep[];
  readonly approverPrincipalId: string;
}

export interface ProcedureApprovalRecord {
  readonly schemaVersion: typeof PROCEDURE_APPROVAL_SCHEMA;
  readonly workspaceId: string;
  readonly procedureId: string;
  readonly version: number;
  readonly status: 'approved';
  readonly approvedAt: string;
  readonly approver: StoredPrincipal;
  /** Free text the approver supplied to acknowledge author-asserted steps / unknowns (required when either exists). */
  readonly acknowledgment?: string;
  readonly binding: ProcedureApprovalBinding;
}

export type StoredLookup<T> = { readonly kind: 'none' } | { readonly kind: 'malformed' } | { readonly kind: 'ok'; readonly record: T };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));

function parseStoredPrincipal(raw: unknown): StoredPrincipal | undefined {
  const p = parsePrincipal(raw);
  if (!p.ok) return undefined;
  const v: Principal = p.value;
  return { kind: v.kind, id: v.id, ...(v.orgId !== undefined ? { orgId: v.orgId } : {}) };
}

/**
 * Parses and RE-VERIFIES a stored version: shape, identity against the key it was read from, the definition against the full
 * M1 validator (including the approved N-10 limits), and `procedureHash` recomputed from the definition. Any mismatch is `malformed`.
 */
export function parseVersionRecord(
  raw: unknown,
  expect: { workspaceId: string; procedureId: string; version: number },
): StoredLookup<ProcedureVersionRecord> {
  if (!isObj(raw)) return { kind: 'malformed' };
  if (!onlyKeys(raw, ['schemaVersion', 'workspaceId', 'procedureId', 'version', 'procedureHash', 'createdAt', 'author', 'definition']))
    return { kind: 'malformed' };
  if (raw['schemaVersion'] !== PROCEDURE_RECORD_SCHEMA) return { kind: 'malformed' };
  if (raw['workspaceId'] !== expect.workspaceId || raw['procedureId'] !== expect.procedureId || raw['version'] !== expect.version)
    return { kind: 'malformed' };
  if (!nonEmpty(raw['procedureHash']) || !nonEmpty(raw['createdAt'])) return { kind: 'malformed' };
  const author = parseStoredPrincipal(raw['author']);
  if (author === undefined) return { kind: 'malformed' };
  const verified = validateProcedure(JSON.stringify(raw['definition']));
  if (!verified.ok) return { kind: 'malformed' };
  if (verified.definition.procedureId !== expect.procedureId || verified.definition.version !== expect.version)
    return { kind: 'malformed' };
  if (verified.procedureHash !== raw['procedureHash'] || procedureHash(verified.definition) !== raw['procedureHash'])
    return { kind: 'malformed' };
  return {
    kind: 'ok',
    record: {
      schemaVersion: PROCEDURE_RECORD_SCHEMA,
      workspaceId: expect.workspaceId,
      procedureId: expect.procedureId,
      version: expect.version,
      procedureHash: raw['procedureHash'],
      createdAt: raw['createdAt'],
      author,
      definition: verified.definition,
    },
  };
}

export function parseApprovalRecord(
  raw: unknown,
  expect: { workspaceId: string; procedureId: string; version: number },
): StoredLookup<ProcedureApprovalRecord> {
  if (!isObj(raw)) return { kind: 'malformed' };
  if (
    !onlyKeys(raw, [
      'schemaVersion',
      'workspaceId',
      'procedureId',
      'version',
      'status',
      'approvedAt',
      'approver',
      'acknowledgment',
      'binding',
    ])
  )
    return { kind: 'malformed' };
  if (raw['schemaVersion'] !== PROCEDURE_APPROVAL_SCHEMA || raw['status'] !== 'approved') return { kind: 'malformed' };
  if (raw['workspaceId'] !== expect.workspaceId || raw['procedureId'] !== expect.procedureId || raw['version'] !== expect.version)
    return { kind: 'malformed' };
  if (!nonEmpty(raw['approvedAt'])) return { kind: 'malformed' };
  if (raw['acknowledgment'] !== undefined && !nonEmpty(raw['acknowledgment'])) return { kind: 'malformed' };
  const approver = parseStoredPrincipal(raw['approver']);
  if (approver === undefined) return { kind: 'malformed' };
  const b = raw['binding'];
  if (!isObj(b)) return { kind: 'malformed' };
  if (
    !onlyKeys(b, [
      'procedureId',
      'version',
      'procedureHash',
      'validationReportHash',
      'registryStateDigest',
      'compilationId',
      'graphHash',
      'steps',
      'approverPrincipalId',
    ])
  )
    return { kind: 'malformed' };
  for (const f of [
    'procedureId',
    'procedureHash',
    'validationReportHash',
    'registryStateDigest',
    'compilationId',
    'graphHash',
    'approverPrincipalId',
  ] as const) {
    if (!nonEmpty(b[f])) return { kind: 'malformed' };
  }
  if (b['procedureId'] !== expect.procedureId || b['version'] !== expect.version) return { kind: 'malformed' };
  if (b['approverPrincipalId'] !== approver.id) return { kind: 'malformed' };
  const steps = b['steps'];
  if (!Array.isArray(steps)) return { kind: 'malformed' };
  const parsedSteps: ProcedureApprovalStep[] = [];
  for (const s of steps) {
    if (!isObj(s) || !onlyKeys(s, ['stepId', 'contractHash', 'permissionFingerprint', 'bindingId'])) return { kind: 'malformed' };
    if (!nonEmpty(s['stepId']) || !nonEmpty(s['contractHash']) || !nonEmpty(s['permissionFingerprint']) || !nonEmpty(s['bindingId']))
      return { kind: 'malformed' };
    parsedSteps.push({
      stepId: s['stepId'],
      contractHash: s['contractHash'],
      permissionFingerprint: s['permissionFingerprint'],
      bindingId: s['bindingId'],
    });
  }
  return {
    kind: 'ok',
    record: {
      schemaVersion: PROCEDURE_APPROVAL_SCHEMA,
      workspaceId: expect.workspaceId,
      procedureId: expect.procedureId,
      version: expect.version,
      status: 'approved',
      approvedAt: raw['approvedAt'] as string,
      approver,
      ...(raw['acknowledgment'] !== undefined ? { acknowledgment: raw['acknowledgment'] as string } : {}),
      binding: {
        procedureId: b['procedureId'] as string,
        version: expect.version,
        procedureHash: b['procedureHash'] as string,
        validationReportHash: b['validationReportHash'] as string,
        registryStateDigest: b['registryStateDigest'] as string,
        compilationId: b['compilationId'] as string,
        graphHash: b['graphHash'] as string,
        steps: parsedSteps,
        approverPrincipalId: b['approverPrincipalId'] as string,
      },
    },
  };
}
