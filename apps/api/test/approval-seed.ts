import { join } from 'node:path';
import { LocalFsBlobStore } from '@xo/storage';
import { FsCompilationStore } from '../src/compilations/fs-compilation-store.js';
import { FsApprovalStore } from '../src/approvals/fs-approval-store.js';
import { deriveCapabilityApprovalStateFromJson } from '../src/approvals/approval-binding.js';

/**
 * Writes an approval record straight to the store, bound to the capability's CURRENT material state (P1.0 M3) — what the approve
 * route would have stored. Used where a test needs an approval the route would refuse to create (e.g. a record written before the
 * route enforced eligibility), to prove the EXECUTION boundary refuses independently.
 */
export async function seedBoundApproval(args: {
  readonly dataDir: string;
  readonly workspaceId: string;
  readonly compilationId: string;
  readonly capabilityId: string;
  readonly approverId: string;
}) {
  const { dataDir, workspaceId, compilationId, capabilityId, approverId } = args;
  const compilations = new FsCompilationStore(new LocalFsBlobStore(join(dataDir, workspaceId, 'compilations')));
  const compilation = await compilations.get(compilationId);
  if (!compilation.ok) throw compilation.error;
  const graph = await compilations.getCompiledGraph(compilationId);
  if (!graph.ok) throw graph.error;
  const state = deriveCapabilityApprovalStateFromJson(graph.value, capabilityId, compilation.value.sourceDigestSha256);
  if (!state.ok) throw state.error;
  return new FsApprovalStore(new LocalFsBlobStore(join(dataDir, workspaceId, 'approvals'))).approve({
    compilationId,
    capabilityId,
    workspaceId,
    approver: { kind: 'human', id: approverId },
    binding: {
      stateDigest: state.value.stateDigest,
      contractId: state.value.contractId,
      contractContentHash: state.value.contractContentHash,
      declarationFingerprint: state.value.declarationFingerprint,
      implementationClass: state.value.implementationClass,
      bindingId: state.value.bindingId,
      sourceDigestSha256: state.value.sourceDigestSha256,
    },
  });
}
