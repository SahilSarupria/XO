import { NotFoundError } from '@xo/errors';
import { actorFromPrincipal } from '@xo/audit';
import { RunStore, buildAuditBundle, verifyAuditBundle, type AuditBundle } from '@xo/workflow-runtime';
import { canonicalJson, type WorkflowComponent } from '@xo/workflow-ir';
import type { PermissionManager } from '@xo/permissions';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import { requireOwnedWorkspace, requirePermission, requirePrincipal, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceRecord, WorkspaceStore } from '../workspace/workspace.js';
import type { AuditService } from '../audit/audit-service.js';
import { newCorrelationId, safeId } from '../audit/audit-service.js';
import { approvalKeyring, currentPublicKeys } from '../pre-execution/approval-keys.js';
import { digestOfJson } from '../approvals/batch-approval.js';
import { readManifest, type StoredManifest } from '../runs/run-manifest.js';
import { runsDir } from './generated-run-routes.js';
import { workspaceDefinitionsStore, type WorkflowDefinitionRecord } from './pre-execution-routes.js';

/**
 * RX-1b (ADR 0048) — evidence of what a run did, over the API:
 *   - `GET …/runs/{runId}/manifest` (read role): what the run was bound to at admission, with its digest;
 *   - `GET …/runs/{runId}/audit-bundle` (audit role): the engine's signed audit bundle of the run and, for a batch, every item: each
 *     journal with its hash chain, a Merkle root over the heads, the component digest, the connector grants and the manifest, signed
 *     with the instance's approval key;
 *   - `POST /workspaces/{id}/audit-bundles/verify` (read role): checks a bundle against this instance's keyring: the signature, the
 *     Merkle root, every chain, and the manifest's digest. Anyone holding the public key can check the same offline.
 */

const RUN_ID = /^(run|fe)_[0-9a-f]{32,40}$/;

/** The run, and for a batch every item it fanned out, in id order. */
export async function runAndItems(store: RunStore, runId: string): Promise<string[]> {
  const ids = [runId];
  for (const id of await store.list().catch(() => [] as string[])) {
    if (!id.startsWith('fe_')) continue;
    const first = (await store.read(id).catch(() => []))[0];
    if ((first?.data as { parent?: unknown } | undefined)?.parent === runId) ids.push(id);
  }
  return ids;
}

export async function auditBundleOf(
  dataConfig: WorkspaceDataConfig,
  env: Readonly<Record<string, string | undefined>>,
  workspace: WorkspaceRecord,
  definition: WorkflowDefinitionRecord,
  runId: string,
): Promise<{ bundle: AuditBundle; runs: number }> {
  const dir = runsDir(dataConfig, workspace.workspaceId, definition.definitionId);
  const store = new RunStore(dir);
  if (!RUN_ID.test(runId) || (await store.read(runId).catch(() => [])).length === 0) throw new NotFoundError(`run "${runId}"`);
  const component = definition.lowered.component as WorkflowComponent | undefined;
  if (component === undefined) throw new NotFoundError(`a runnable definition for run "${runId}"`);
  const keys = await approvalKeyring(dataConfig.dataRootDir, env);
  const manifest = await readManifest(dir, runId);
  const runIds = await runAndItems(store, runId);
  const bundle = await buildAuditBundle({
    store,
    runIds,
    workflow: { id: component.workflows[0]!.id, version: definition.definitionId },
    componentBytes: Buffer.from(canonicalJson(component as never)),
    connectorGrants: Object.fromEntries(component.connectors.map((c) => [c.id, c.operations.map((o) => o.name)])),
    ...(manifest !== undefined ? { manifest } : {}),
    signer: keys.active.keyId,
    privateKeyPem: keys.active.privateKeyPem,
  });
  return { bundle, runs: runIds.length };
}

/** Verifies a bundle against this instance's keyring (every key that was ever active here). */
export async function verifyBundle(
  dataRootDir: string,
  bundle: unknown,
): Promise<{ ok: boolean; problems: string[]; signer?: string; signerKnown: boolean; runs: number; manifest?: Record<string, unknown> }> {
  const b = bundle as Partial<AuditBundle> | undefined;
  if (
    typeof b !== 'object' ||
    b === null ||
    b.formatVersion !== '1' ||
    typeof b.signer !== 'string' ||
    typeof b.signature !== 'string' ||
    !Array.isArray(b.runs)
  )
    return { ok: false, problems: ['this is not an XO audit bundle (format 1)'], signerKnown: false, runs: 0 };
  const pem = (await currentPublicKeys(dataRootDir)).get(b.signer);
  const problems: string[] = [];
  if (pem === undefined) problems.push(`the signer key ${b.signer} is not in this instance's keyring`);
  else problems.push(...verifyAuditBundle(b as AuditBundle, pem).problems);
  let manifest: Record<string, unknown> | undefined;
  const m = b.manifest as StoredManifest | undefined;
  if (m !== undefined) {
    const digestOk = typeof m === 'object' && m !== null && digestOfJson(m.manifest) === m.digest;
    if (!digestOk) problems.push('the run manifest does not match its digest');
    manifest = { runId: m?.manifest?.runId, digest: m?.digest, digestOk };
  }
  return {
    ok: problems.length === 0,
    problems,
    signer: b.signer,
    signerKnown: pem !== undefined,
    runs: b.runs.length,
    ...(manifest !== undefined ? { manifest } : {}),
  };
}

export function registerRunEvidenceRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  audit: AuditService,
  _permissionManager: PermissionManager,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const guarded =
    (h: (req: ApiRequest) => Promise<ApiResponse>) =>
    async (req: ApiRequest): Promise<ApiResponse> => {
      try {
        return await h(req);
      } catch (e) {
        return errorToResponse(e);
      }
    };
  const base = '/workspaces/:workspaceId/generated-workflows/:definitionId/runs/:runId';

  async function manifest(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'read', dataConfig, { action: 'read a run manifest' });
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    const runId = req.params['runId'] ?? '';
    const m = RUN_ID.test(runId)
      ? await readManifest(runsDir(dataConfig, workspace.workspaceId, definition.definitionId), runId)
      : undefined;
    if (m === undefined) throw new NotFoundError(`a manifest for run "${runId}" (runs admitted before RX-1b have none)`);
    return json(200, { ...m, digestOk: m.digest !== 'mismatch' });
  }

  async function bundle(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'audit', dataConfig, { action: 'export a run audit bundle' });
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    const runId = req.params['runId'] ?? '';
    const { bundle: b, runs } = await auditBundleOf(dataConfig, env, workspace, definition, runId);
    await audit.tryRecord({
      type: 'generated-workflow.audit-bundle.exported',
      action: 'generated-workflow.audit-bundle',
      actor: actorFromPrincipal(requirePrincipal(req)),
      correlationId: newCorrelationId(),
      outcome: 'completed',
      target: { kind: 'workflow', id: safeId(definition.candidateWorkflowId) ?? 'workflow', workspaceId: workspace.workspaceId },
      metadata: { runId: runId.startsWith('fe_') ? 'item' : runId, runs },
    });
    return json(200, b);
  }

  async function verify(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'read', dataConfig, { action: 'verify an audit bundle' });
    const body = await req.json<unknown>();
    if (!body.ok) throw body.error;
    return json(200, await verifyBundle(dataConfig.dataRootDir, body.value));
  }

  router.get(`${base}/manifest`, guarded(manifest));
  router.get(`${base}/audit-bundle`, guarded(bundle));
  router.post('/workspaces/:workspaceId/audit-bundles/verify', guarded(verify));
}
