import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import {
  callerIdentityId,
  requireOwnedWorkspace,
  requirePermission,
  workspaceAuditStore,
  workspacePackagesStore,
  workspaceStateStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import type { WorkspaceRecord, WorkspaceStore } from '../workspace/workspace.js';
import { regionLabel } from '../workspace/regions.js';
import { recordAudit } from '../audit/record.js';
import { FsAuditLog } from '../audit/fs-audit-log.js';
import { FsSettingsStore } from '../settings/fs-settings-store.js';
import {
  applySettingsPatch,
  LOCAL_PROVIDER_IDS,
  parseSettingsPatch,
  RUNTIME_LOCATIONS,
  type RuntimeLocation,
  type WorkspaceSettings,
} from '../settings/workspace-settings.js';
import { SUPPORTED_PROVIDER_IDS } from './runtime/provider-factory.js';
import { bootstrapRuntime } from './runtime/runtime-routes.js';

const STARTED_AT = new Date();

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      return errorToResponse(cause);
    }
  };
}

/** Which model providers this server has credentials for. Names only — a key is never returned, logged or echoed. */
export function configuredProviders(
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly { readonly id: string; readonly configured: boolean; readonly local: boolean }[] {
  const has = (...names: string[]) => names.every((n) => (env[n] ?? '').length > 0);
  const configured: Record<string, boolean> = {
    anthropic: has('ANTHROPIC_API_KEY'),
    openai: has('OPENAI_API_KEY'),
    'azure-openai': has('AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT'),
    gemini: has('GEMINI_API_KEY'),
    // Ollama needs no credential; "configured" means the operator pointed the server at one.
    ollama: has('OLLAMA_BASE_URL') || has('XO_API_OLLAMA_ENABLED'),
  };
  return SUPPORTED_PROVIDER_IDS.map((id) => ({ id, configured: configured[id] === true, local: LOCAL_PROVIDER_IDS.has(id) }));
}

/** Runtime locations this deployment can honor. Default: only the machine the server runs on. */
export function availableRuntimeLocations(env: Readonly<Record<string, string | undefined>> = process.env): readonly RuntimeLocation[] {
  const raw = env['XO_API_RUNTIME_LOCATIONS'];
  if (raw === undefined || raw.trim().length === 0) return ['this_computer'];
  const wanted = raw.split(',').map((s) => s.trim());
  const valid = RUNTIME_LOCATIONS.filter((l) => wanted.includes(l));
  return valid.length > 0 ? valid : ['this_computer'];
}

/** Says, per setting, whether the server enforces it or merely records it. Nothing here is aspirational. */
function describeEffect(workspace: WorkspaceRecord, settings: WorkspaceSettings) {
  return {
    runtime: {
      enforced: false,
      note: 'Records where the operator runs this workspace. The server runs on the machine it is deployed on; choosing a location it does not offer is refused.',
      availableLocations: availableRuntimeLocations(),
    },
    model: {
      enforced: true,
      note: 'Used by chat. A provider with no server-side credential is reported unconfigured and chat refuses until it is set up.',
      providers: configuredProviders(),
    },
    airGapped: {
      enforced: true,
      note: 'Blocks URL import and chat calls to off-box model providers for this workspace.',
      blocks: ['source.import_url', 'chat.off_box_provider'],
    },
    residency: {
      enforced: false,
      declared: workspace.region ?? null,
      label: workspace.region !== undefined ? (regionLabel(workspace.region) ?? null) : null,
      note: 'Declarative. It is recorded on the workspace and in audit exports; the server does not prove or control where bytes are physically stored.',
    },
    trust: {
      requireSignedPackages: {
        enforced: true,
        note: 'Registry publish and XO install refuse a package whose manifest carries NO signature entries. This is a presence check only: this server has no signer-key resolution or trust anchors, so it does not verify that any signature is valid or who made it. Do not treat it as proof of authenticity.',
      },
      requireCompilerAttestation: {
        enforced: false,
        available: false,
        note: 'This server has no compiler-attestation facility; the option is not offered.',
      },
    },
    notifications: {
      enforced: true,
      delivery: 'in_app',
      note: 'Preferences filter GET /notifications. There is no email, push or webhook delivery.',
    },
    settingsRevision: settings.revision,
  };
}

export function registerSettingsRoutes(router: Router, workspaceStore: WorkspaceStore, dataConfig: WorkspaceDataConfig): void {
  const settingsStoreFor = (workspace: WorkspaceRecord) =>
    new FsSettingsStore(workspaceStateStore(workspace, dataConfig), workspace.workspaceId);

  async function getSettings(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const settings = await settingsStoreFor(workspace).get();
    return json(200, {
      settings: { ...settings, residency: { region: workspace.region ?? null } },
      effect: describeEffect(workspace, settings),
    });
  }

  async function putSettings(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'manage', dataConfig, { action: 'update settings' });
    const bodyResult = await req.json();
    if (!bodyResult.ok) throw bodyResult.error;
    const patch = parseSettingsPatch(bodyResult.value, availableRuntimeLocations());
    const actor = callerIdentityId(req);

    const before = await settingsStoreFor(workspace).get();
    const next = await settingsStoreFor(workspace).update(patch.expectedRevision, (current) =>
      applySettingsPatch(current, patch, actor, new Date()),
    );

    let updatedWorkspace = workspace;
    if (patch.region !== undefined && patch.region !== workspace.region) {
      const updated = await workspaceStore.update(workspace.workspaceId, { region: patch.region });
      if (!updated.ok) throw updated.error;
      updatedWorkspace = updated.value;
    }
    const changed: string[] = [];
    if (patch.runtime !== undefined && patch.runtime.location !== before.runtime.location) changed.push('runtime.location');
    if (patch.model !== undefined) changed.push('model');
    if (patch.airGapped !== undefined && patch.airGapped !== before.airGapped) changed.push('airGapped');
    if (patch.region !== undefined && patch.region !== workspace.region) changed.push('region');
    if (patch.trust !== undefined) changed.push('trust');
    if (patch.notifications !== undefined) changed.push('notifications');
    await recordAudit(req, updatedWorkspace, dataConfig, {
      event: 'settings.updated',
      result: 'succeeded',
      target: { kind: 'workspace', id: workspace.workspaceId },
      detail: { changed, revision: next.revision, ...(patch.airGapped !== undefined ? { airGapped: next.airGapped } : {}) },
    });
    return json(200, {
      settings: { ...next, residency: { region: updatedWorkspace.region ?? null } },
      effect: describeEffect(updatedWorkspace, next),
    });
  }

  /**
   * Whether the runtime that executes this workspace's capabilities is usable, from what the server can actually
   * observe: it re-bootstraps the workspace's package runtime (the same call `/runtime/context` makes) and reports
   * the outcome. "online" means "this process answered and the workspace runtime bootstrapped", nothing more.
   */
  async function runtimeStatus(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const settings = await settingsStoreFor(workspace).get();
    const started = Date.now();
    let bootstrapOk = true;
    let mountedPackages = 0;
    let capabilityCount = 0;
    let warnings: readonly string[] = [];
    try {
      const { runtime, bootstrapWarnings } = await bootstrapRuntime(workspacePackagesStore(workspace, dataConfig));
      const context = runtime.context();
      mountedPackages = context.registry.all().length;
      capabilityCount = context.capabilities.all().length;
      warnings = bootstrapWarnings;
    } catch (cause) {
      bootstrapOk = false;
      warnings = [cause instanceof Error ? cause.message : String(cause)];
    }
    const providers = configuredProviders();
    const audit = new FsAuditLog(workspaceAuditStore(workspace, dataConfig), workspace.workspaceId);
    const head = await audit.head().catch(() => undefined);
    return json(200, {
      status: bootstrapOk ? (warnings.length > 0 ? 'degraded' : 'online') : 'offline',
      location: settings.runtime.location,
      checkedAt: new Date().toISOString(),
      bootstrapMs: Date.now() - started,
      server: { startedAt: STARTED_AT.toISOString(), uptimeSeconds: Math.round(process.uptime()), node: process.version },
      runtime: { mountedPackages, capabilityCount, warnings },
      model: {
        primary: settings.model.primary,
        fallback: settings.model.fallback,
        providers,
        usable: settings.model.primary !== null && providers.some((p) => p.id === settings.model.primary?.provider && p.configured),
      },
      airGapped: settings.airGapped,
      auditHead: head !== undefined ? { seq: head.seq, hash: head.hash } : null,
    });
  }

  router.get('/workspaces/:workspaceId/settings', guarded(getSettings));
  router.put('/workspaces/:workspaceId/settings', guarded(putSettings));
  router.get('/workspaces/:workspaceId/runtime/status', guarded(runtimeStatus));
}
