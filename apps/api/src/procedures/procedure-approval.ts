import { Sha256Hasher } from '@xo/crypto';
import { canonicalStringify } from '@xo/xoir';
import type { ProcedureApprovalBinding, ProcedureApprovalRecord, ProcedureVersionRecord, StoredLookup } from './procedure.js';
import type { RegistryResult, RegistrySnapshot } from './registry-validation.js';

/**
 * P1.1 M2 — approval binding for procedures (extends the capability approval-binding model; per-step state comes from the
 * unchanged `deriveCapabilityApprovalState`, via `validateAgainstRegistry`). Lifecycle is COMPUTED from persisted facts and the
 * current registry state; there is no stored "validated"/"approved"/"executable" boolean to flip.
 */

export type ProcedureLifecycle = 'draft' | 'approved' | 'approval_stale' | 'approval_invalid' | 'approval_unverifiable';

const hash = (value: Parameters<typeof canonicalStringify>[0]): string => String(new Sha256Hasher().hash(canonicalStringify(value)));

/** The ValidationReport the approval is bound to: only reachable with ZERO blocking findings (a snapshot exists only when there are none). */
export function validationReportHash(procedureHash: string, snapshot: RegistrySnapshot): string {
  return hash({
    schema: 'xo.procedure-validation-report.v1',
    procedureHash,
    registryStateDigest: snapshot.digest,
    blockingFindings: 0,
  });
}

export function deriveProcedureApprovalBinding(
  record: ProcedureVersionRecord,
  snapshot: RegistrySnapshot,
  approverPrincipalId: string,
): ProcedureApprovalBinding {
  return {
    procedureId: record.procedureId,
    version: record.version,
    procedureHash: record.procedureHash,
    validationReportHash: validationReportHash(record.procedureHash, snapshot),
    registryStateDigest: snapshot.digest,
    compilationId: snapshot.compilationId,
    graphHash: snapshot.graphHash,
    steps: snapshot.steps.map((s) => ({
      stepId: s.stepId,
      contractHash: s.contractContentHash,
      permissionFingerprint: s.declarationFingerprint,
      bindingId: s.bindingId,
    })),
    approverPrincipalId,
  };
}

function bindingMatches(approved: ProcedureApprovalBinding, current: ProcedureApprovalBinding): boolean {
  if (approved.procedureHash !== current.procedureHash) return false;
  if (approved.validationReportHash !== current.validationReportHash) return false;
  if (approved.registryStateDigest !== current.registryStateDigest) return false;
  if (approved.compilationId !== current.compilationId || approved.graphHash !== current.graphHash) return false;
  if (approved.steps.length !== current.steps.length) return false;
  return approved.steps.every((s, i) => {
    const c = current.steps[i];
    return (
      c !== undefined &&
      c.stepId === s.stepId &&
      c.contractHash === s.contractHash &&
      c.permissionFingerprint === s.permissionFingerprint &&
      c.bindingId === s.bindingId
    );
  });
}

/**
 * Lifecycle of one stored version. `approved` requires: a well-formed approval record, bound to THIS procedureHash, and every
 * recorded registry fact (graph hash, per-step contract hash / permission fingerprint / binding id) equal to what the registry
 * says NOW. Any drift is `approval_stale`; evidence that cannot be established is never `approved`.
 */
export function computeLifecycle(
  record: ProcedureVersionRecord,
  approval: StoredLookup<ProcedureApprovalRecord>,
  current: RegistryResult | undefined,
): ProcedureLifecycle {
  if (approval.kind === 'none') return 'draft';
  if (approval.kind === 'malformed') return 'approval_invalid';
  if (current === undefined) return 'approval_unverifiable';
  if (!current.ok) {
    // The registry says the procedure no longer validates: definite drift, or the evidence is simply unavailable.
    return current.findings.some((f) => f.code === 'PROC_COMPILATION_UNAVAILABLE') ? 'approval_unverifiable' : 'approval_stale';
  }
  const expected = deriveProcedureApprovalBinding(record, current.snapshot, approval.record.binding.approverPrincipalId);
  return bindingMatches(approval.record.binding, expected) ? 'approved' : 'approval_stale';
}

/** Lifecycle gate used by start paths (N-13). M2 contains no execution; M3 adds start-time recomputation on top of this gate. */
export function lifecycleStartGate(lifecycle: ProcedureLifecycle): { readonly allowed: boolean; readonly reason: string } {
  return lifecycle === 'approved'
    ? { allowed: true, reason: 'approved' }
    : { allowed: false, reason: lifecycle === 'draft' ? 'not_approved' : lifecycle };
}
