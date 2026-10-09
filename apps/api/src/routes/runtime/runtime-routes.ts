import type { HostCapability, ModelFamily } from '@xo/types';
import { PackageInstaller } from '@xo/package-sdk';
import type { BlobStore } from '@xo/storage';
import { EnvironmentId, ExecutionEngine, RequestId, Runtime } from '@xo/runtime';
import type { ExecutionRequest } from '@xo/runtime';
import { ErrorCode, XoError } from '@xo/errors';
import type { Router } from '../../http/router.js';
import type { ApiRequest, ApiResponse } from '../../http/types.js';
import { json } from '../../http/types.js';
import { errorToResponse, knownStatusCodes } from '../../http/error-mapping.js';
import { resolveProvider } from './provider-factory.js';
import { requireOwnedWorkspace, workspacePackagesStore, type WorkspaceDataConfig } from '../../workspace/workspace-context.js';
import type { WorkspaceStore } from '../../workspace/workspace.js';
import { registerMovedStub } from '../moved-stub.js';

/**
 * Built directly from `apps/cli/src/commands/runtime/run.ts` — same
 * bootstrap-then-execute shape, same division of labor (this file only
 * constructs the runtime/engine and shapes the request/response; all
 * planning/execution logic is `@xo/runtime`'s). Per the brief: no
 * persistence-aware endpoints (checkpoint/resume) yet — that's Stage
 * 4's territory, landing underneath this same `Runtime` facade, so
 * nothing here should need to change shape when it lands.
 *
 * P0.2: `?store=<dir>` (a client-supplied filesystem path) is gone.
 * Both routes below are now registered under
 * `/workspaces/:workspaceId/runtime/...` and bootstrap against exactly
 * the same `PackageInstaller`/`BlobStore` a workspace's
 * `/workspaces/:workspaceId/packages/...` routes install into (see
 * `workspace/workspace-context.ts#workspacePackagesStore`'s doc
 * comment for why these two route files deliberately share one
 * function) — never a directory the caller names.
 *
 * Out of scope for this milestone (flagged in the P0 audit, not fixed
 * here): `execute` still constructs `ExecutionEngine` with no
 * `permissionGate`, so it still executes fail-open with respect to
 * capability-level authorization. P0.2 only removes the
 * client-controlled-storage-path risk; it does not change
 * `ExecutionEngine`'s own authorization posture, which is a separate,
 * already-documented risk for a future slice.
 */

async function bootstrapRuntime(store: BlobStore): Promise<{ readonly runtime: Runtime; readonly installer: PackageInstaller; readonly bootstrapWarnings: readonly string[] }> {
  const installer = new PackageInstaller(store);
  const runtime = new Runtime(installer);
  const bootstrap = await runtime.bootstrap();
  const bootstrapWarnings = bootstrap.failures.map((f) => `"${f.name}@${f.version}" failed to mount: [${f.error.code}] ${f.error.message}`);
  return { runtime, installer, bootstrapWarnings };
}

interface ExecuteBody {
  readonly capabilityId?: unknown;
  readonly query?: unknown;
  readonly input?: unknown;
  readonly model?: unknown;
  readonly hostFamily?: unknown;
  readonly hostCapabilities?: unknown;
  readonly tokenBudget?: unknown;
  readonly maxTokens?: unknown;
}

function parseExecuteBody(body: ExecuteBody): {
  readonly capabilityId?: string;
  readonly query?: string;
  readonly input: string;
  readonly model?: string;
  readonly hostFamily?: ModelFamily;
  readonly hostCapabilities?: readonly HostCapability[];
  readonly tokenBudget?: number;
  readonly maxTokens?: number;
} {
  if (typeof body.input !== 'string' || body.input.length === 0) {
    throw new XoError(ErrorCode.RUNTIME_INVALID_REQUEST, '"input" (non-empty string) is required');
  }
  if (body.capabilityId !== undefined && typeof body.capabilityId !== 'string') {
    throw new XoError(ErrorCode.RUNTIME_INVALID_REQUEST, '"capabilityId", if present, must be a string');
  }
  if (body.query !== undefined && typeof body.query !== 'string') {
    throw new XoError(ErrorCode.RUNTIME_INVALID_REQUEST, '"query", if present, must be a string');
  }
  if (body.capabilityId === undefined && body.query === undefined) {
    throw new XoError(ErrorCode.RUNTIME_INVALID_REQUEST, 'at least one of "capabilityId" or "query" is required');
  }
  if (body.model !== undefined && typeof body.model !== 'string') {
    throw new XoError(ErrorCode.RUNTIME_INVALID_REQUEST, '"model", if present, must be a string');
  }
  if (body.hostFamily !== undefined && typeof body.hostFamily !== 'string') {
    throw new XoError(ErrorCode.RUNTIME_INVALID_REQUEST, '"hostFamily", if present, must be a string');
  }
  if (body.hostCapabilities !== undefined && (!Array.isArray(body.hostCapabilities) || !body.hostCapabilities.every((c) => typeof c === 'string'))) {
    throw new XoError(ErrorCode.RUNTIME_INVALID_REQUEST, '"hostCapabilities", if present, must be an array of strings');
  }
  if (body.tokenBudget !== undefined && typeof body.tokenBudget !== 'number') {
    throw new XoError(ErrorCode.RUNTIME_INVALID_REQUEST, '"tokenBudget", if present, must be a number');
  }
  if (body.maxTokens !== undefined && typeof body.maxTokens !== 'number') {
    throw new XoError(ErrorCode.RUNTIME_INVALID_REQUEST, '"maxTokens", if present, must be a number');
  }

  return {
    ...(body.capabilityId !== undefined ? { capabilityId: body.capabilityId as string } : {}),
    ...(body.query !== undefined ? { query: body.query as string } : {}),
    input: body.input,
    ...(body.model !== undefined ? { model: body.model as string } : {}),
    ...(body.hostFamily !== undefined ? { hostFamily: body.hostFamily as ModelFamily } : {}),
    ...(body.hostCapabilities !== undefined ? { hostCapabilities: body.hostCapabilities as readonly HostCapability[] } : {}),
    ...(body.tokenBudget !== undefined ? { tokenBudget: body.tokenBudget as number } : {}),
    ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens as number } : {}),
  };
}

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      return errorToResponse(cause);
    }
  };
}

export function registerRuntimeRoutes(router: Router, workspaceStore: WorkspaceStore, dataConfig: WorkspaceDataConfig): void {
  /** Mounts everything installed in this workspace and returns the resulting state — mounted packages, derived capability index, any per-package mount failures — without executing anything. */
  async function getContext(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const { runtime, bootstrapWarnings } = await bootstrapRuntime(workspacePackagesStore(workspace, dataConfig));
    const context = runtime.context();
    return json(200, {
      builtAt: context.builtAt,
      mountedPackages: context.registry.all(),
      capabilities: context.capabilities.all(),
      bootstrapWarnings,
    });
  }

  async function execute(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);

    const providerResult = resolveProvider(req);
    if (!providerResult.ok) {
      throw new XoError(ErrorCode.RUNTIME_INVALID_REQUEST, providerResult.error);
    }
    const provider = providerResult.value;

    const bodyResult = await req.json<ExecuteBody>();
    if (!bodyResult.ok) throw bodyResult.error;
    const parsed = parseExecuteBody(bodyResult.value);

    const models = provider.describeCapabilities().models;
    if (parsed.model === undefined && models.length === 0) {
      throw new XoError(ErrorCode.RUNTIME_INVALID_REQUEST, `provider "${provider.id}" advertises no models of its own — pass "model" in the request body`);
    }

    const { runtime, installer, bootstrapWarnings } = await bootstrapRuntime(workspacePackagesStore(workspace, dataConfig));

    let engine: ExecutionEngine;
    try {
      engine = new ExecutionEngine(() => runtime.context(), installer, provider, parsed.model !== undefined ? { model: parsed.model } : {});
    } catch (cause) {
      throw new XoError(ErrorCode.RUNTIME_INVALID_REQUEST, `could not construct the execution engine: ${(cause as Error).message}`, { cause });
    }

    const now = new Date();
    const request: ExecutionRequest = {
      requestId: RequestId(`req_${now.getTime()}`),
      ...(parsed.capabilityId !== undefined ? { capabilityId: parsed.capabilityId } : {}),
      ...(parsed.query !== undefined ? { query: parsed.query } : {}),
      environment: {
        environmentId: EnvironmentId(`env_${now.getTime()}`),
        hostProfile: { family: parsed.hostFamily ?? 'claude', capabilities: parsed.hostCapabilities ?? ['chat', 'tool_use'] },
        provider: provider.id,
        ...(parsed.tokenBudget !== undefined ? { tokenBudget: parsed.tokenBudget } : {}),
        createdAt: now.toISOString(),
      },
      requestedAt: now.toISOString(),
      input: parsed.input,
      ...(parsed.maxTokens !== undefined ? { maxTokens: parsed.maxTokens } : {}),
    };

    const result = await engine.execute(request);

    // `result.error` is a domain-modeled outcome (safety block, budget
    // exceeded, provider failure, ...), not a malformed request — the
    // request itself was valid and fully processed. So this still uses
    // `knownStatusCodes()` to pick a status matching what happened
    // (403/429/502/504/...), rather than either hardcoding 200 for every
    // outcome or dropping to the generic `errorToResponse()` envelope,
    // which would lose `receipt`/`bootstrapWarnings` a caller still wants
    // even on a failed execution.
    const status = result.error ? (knownStatusCodes()[result.error.code] ?? 500) : 200;

    return json(status, {
      status: result.session.status,
      executionId: result.executionId,
      response: result.response ?? null,
      receipt: result.receipt ?? null,
      error: result.error ? { code: result.error.code, message: result.error.message } : null,
      bootstrapWarnings,
    });
  }

  router.get('/workspaces/:workspaceId/runtime/context', guarded(getContext));
  router.post('/workspaces/:workspaceId/runtime/execute', guarded(execute));

  // Legacy, pre-P0.2 paths — see moved-stub.ts's doc comment.
  registerMovedStub(router, 'get', '/runtime/context', '/workspaces/:workspaceId/runtime/context');
  registerMovedStub(router, 'post', '/runtime/execute', '/workspaces/:workspaceId/runtime/execute');
}
