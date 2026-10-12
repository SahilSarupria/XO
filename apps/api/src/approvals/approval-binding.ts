import { ErrorCode, XoError } from '@xo/errors';
import { err, ok, type Result } from '@xo/types';
import { Sha256Hasher } from '@xo/crypto';
import { canonicalStringify, fromJson, XoirNodeId, type XoirGraph, type XoirGraphJson } from '@xo/xoir';
import { buildSemanticCapabilityContract, computeContractContentHash } from '@xo/capability-contract';
import { resolveContractBinding } from '@xo/runtime';
import { declaredPermissionsForNode } from '../executions/authorization.js';
import { declarationFingerprint } from '../executions/execute-capability.js';
import type { CurrentApprovalState } from './approval.js';

/**
 * P1.0 M3 — what "the material state of a capability" means for approval purposes.
 *
 * An approval authorizes a capability as it WILL EXECUTE, so the digest is derived from exactly the three things execution is
 * decided by, each through the SAME function the execution boundary uses (never a second derivation):
 *
 *  1. the contract's semantic content — `computeContractContentHash(contract)`: name, description, inputs, outputs, determinism,
 *     required permissions, the rules (conditions, outcomes, exceptions) and action refs. Recomputed from the graph, so it does
 *     not trust a stored `contentHash`. This is what makes "approving one rule must not authorize a changed rule" true.
 *  2. the authoritative permission declaration — `declarationFingerprint(declaredPermissionsForNode(...))`, the same value M2's
 *     TOCTOU tie uses. A loosened or tightened declaration is a material change.
 *  3. the resolved binding — implementation class, resolver and binding id, so a capability that now resolves to a different
 *     implementation (e.g. deterministic rule -> human-in-the-loop) is a different thing.
 *
 * Deliberately NOT part of it: confidence scores and provenance pointers (the contract hash already excludes them: re-scoring is
 * not a change of what the capability does), timestamps, and unrelated parts of the graph (editing some other capability must not
 * invalidate this one's approval). The source digest of the compilation is bound separately (`binding.sourceDigestSha256`).
 *
 * A capability whose contract cannot be built at all has no state: `err`, never a default digest, so it can be neither approved nor
 * verified. An unresolved binding/declaration still has a (bound) state — see the comment in the function body.
 */
export function deriveCapabilityApprovalState(
  graph: XoirGraph,
  capabilityId: string,
  sourceDigestSha256: string,
): Result<CurrentApprovalState, XoError> {
  const unavailable = (why: string): Result<never, XoError> =>
    err(new XoError(ErrorCode.INVALID_ARGUMENT, `capability "${capabilityId}" has no approvable state: ${why}`));
  try {
    const contractResult = buildSemanticCapabilityContract(graph, XoirNodeId(capabilityId));
    if (!contractResult.ok) return unavailable(contractResult.error.message);
    const contract = contractResult.value;

    // An unresolved / ambiguous / denied binding or an unresolved declaration is NOT refused here: execution refuses it downstream
    // (M2 / binding resolution), exactly as before. It is BOUND instead — the state records that it was unresolved — so if it
    // later becomes resolvable, that is a material change and the old approval is stale rather than silently inherited.
    const bindingOutcome = resolveContractBinding(contract);
    const binding =
      bindingOutcome.status === 'resolved'
        ? {
            implementationClass: String(bindingOutcome.binding.implementationClass),
            resolverName: bindingOutcome.binding.resolverName,
            id: bindingOutcome.binding.id,
          }
        : { implementationClass: `unresolved:${bindingOutcome.status}`, resolverName: 'none', id: 'none' };

    const declaration = declaredPermissionsForNode(graph, contract.id);

    const contractContentHash = String(computeContractContentHash(contract));
    const fingerprint = declarationFingerprint(contract.id, declaration);
    const stateDigest = new Sha256Hasher().hash(
      canonicalStringify({
        schema: 'xo.approval-state.v1',
        capabilityId,
        contractId: contract.id,
        contractContentHash,
        declarationFingerprint: fingerprint,
        implementationClass: binding.implementationClass,
        resolverName: binding.resolverName,
        bindingId: binding.id,
      }),
    );
    return ok({
      stateDigest: String(stateDigest),
      contractId: contract.id,
      contractContentHash,
      declarationFingerprint: fingerprint,
      implementationClass: binding.implementationClass,
      bindingId: binding.id,
      sourceDigestSha256,
    });
  } catch (cause) {
    return unavailable(cause instanceof Error ? cause.message : String(cause));
  }
}

/** Same derivation from a persisted graph JSON (the form the execution and approval routes hold). */
export function deriveCapabilityApprovalStateFromJson(
  compiledGraphJson: unknown,
  capabilityId: string,
  sourceDigestSha256: string,
): Result<CurrentApprovalState, XoError> {
  const graph = fromJson(compiledGraphJson as XoirGraphJson);
  if (!graph.ok) return err(graph.error);
  return deriveCapabilityApprovalState(graph.value, capabilityId, sourceDigestSha256);
}
