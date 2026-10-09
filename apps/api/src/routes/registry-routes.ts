import { RegistryClient, type CreateLicenseInput, type RecordBenchmarkInput } from '@xo/registry';
import { unpackArchive } from '@xo/package-sdk';
import { ErrorCode, XoError } from '@xo/errors';
import type { RoyaltySplit } from '@xo/registry-core';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import { requireOwnedWorkspace, workspaceRegistryStore, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceStore } from '../workspace/workspace.js';
import { registerMovedStub } from './moved-stub.js';

/**
 * Every route below is a direct translation of one `RegistryClient`
 * method — no business logic of its own, the same "handler calls the
 * library, done" shape `apps/cli/src/commands/registry/*.ts` uses (see
 * `publish.ts`/`search.ts`/`inspect.ts`, which these routes were built
 * from almost line for line). `RegistryClient` itself decides
 * everything about what's valid; a route's only job is HTTP
 * request/response shape.
 *
 * P0.2: `?registry=<dir>` (a client-supplied filesystem path) is gone.
 * Every route below is now registered under
 * `/workspaces/:workspaceId/registry/...` and resolves its
 * `RegistryClient`'s storage exclusively through
 * `requireOwnedWorkspace` + `workspaceRegistryStore` (see
 * `workspace/workspace-context.ts`) — the workspace's *own* registry
 * subdirectory, never anything the caller names directly.
 */

function unwrapOrThrow<T>(result: { ok: true; value: T } | { ok: false; error: XoError }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

async function client(req: ApiRequest, workspaceStore: WorkspaceStore, dataConfig: WorkspaceDataConfig): Promise<RegistryClient> {
  const workspace = await requireOwnedWorkspace(req, workspaceStore);
  return new RegistryClient(workspaceRegistryStore(workspace, dataConfig));
}

interface RecordBenchmarkBody {
  readonly category?: unknown;
  readonly score?: unknown;
  readonly challengeable?: unknown;
}

function parseRecordBenchmarkBody(id: string, body: RecordBenchmarkBody): RecordBenchmarkInput {
  if (typeof body.category !== 'string' || body.category.length === 0) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, '"category" (string) is required');
  }
  if (typeof body.score !== 'number' || !Number.isFinite(body.score)) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, '"score" (number) is required');
  }
  if (body.challengeable !== undefined && typeof body.challengeable !== 'boolean') {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, '"challengeable", if present, must be a boolean');
  }
  return {
    packageId: id,
    category: body.category,
    score: body.score,
    ...(body.challengeable !== undefined ? { challengeable: body.challengeable } : {}),
  };
}

interface CreateLicenseBody {
  readonly packageId?: unknown;
  readonly tier?: unknown;
  readonly royaltySplit?: unknown;
}

function isRoyaltySplit(value: unknown): value is RoyaltySplit {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<RoyaltySplit>;
  return typeof v.role === 'string' && typeof v.basisPoints === 'number';
}

function parseCreateLicenseBody(body: CreateLicenseBody): CreateLicenseInput {
  if (typeof body.packageId !== 'string' || body.packageId.length === 0) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, '"packageId" (string) is required');
  }
  if (typeof body.tier !== 'string' || body.tier.length === 0) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, '"tier" (string) is required');
  }
  if (!Array.isArray(body.royaltySplit) || !body.royaltySplit.every(isRoyaltySplit)) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, '"royaltySplit" must be an array of { role, basisPoints }');
  }
  return { packageId: body.packageId, tier: body.tier, royaltySplit: body.royaltySplit };
}

/** Wraps every handler above so a thrown `XoError`/`Error` becomes the right `ApiResponse` right at the registration boundary, rather than every handler needing its own try/catch — `server.ts`'s `runHandler` does the same thing again as a last-resort net, but doing it here too keeps each route's own tests able to call the handler directly and get a clean `ApiResponse` back instead of a thrown error. */
function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      return errorToResponse(cause);
    }
  };
}

export function registerRegistryRoutes(router: Router, workspaceStore: WorkspaceStore, dataConfig: WorkspaceDataConfig): void {
  async function publish(req: ApiRequest): Promise<ApiResponse> {
    // Resolve the workspace (and therefore validate ownership) before
    // doing any work on the body — otherwise a request for an unowned/
    // unknown workspace *and* carrying a malformed body reports the
    // wrong problem (a 422 from unpackArchive failing on garbage bytes,
    // masking the 404 an unauthorized caller most needs to see).
    const c = await client(req, workspaceStore, dataConfig);
    const bytes = await req.rawBody();
    if (bytes.length === 0) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'request body must be the raw bytes of a .xo archive');
    }
    const unpacked = unwrapOrThrow(await unpackArchive(new Uint8Array(bytes)));
    const published = unwrapOrThrow(await c.publish(unpacked));
    return json(201, published);
  }

  async function getPackage(req: ApiRequest): Promise<ApiResponse> {
    const id = req.params['id'];
    if (id === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing package id');
    const c = await client(req, workspaceStore, dataConfig);
    const record = unwrapOrThrow(await c.get(id));
    return json(200, record);
  }

  async function listByCreator(req: ApiRequest): Promise<ApiResponse> {
    const creatorDid = req.query.get('creator');
    if (creatorDid === null || creatorDid.trim().length === 0) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'query parameter "creator" is required');
    }
    const c = await client(req, workspaceStore, dataConfig);
    const records = await c.listByCreator(creatorDid);
    return json(200, { records });
  }

  async function search(req: ApiRequest): Promise<ApiResponse> {
    const query = req.query.get('q');
    if (query === null || query.trim().length === 0) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'query parameter "q" is required');
    }
    const c = await client(req, workspaceStore, dataConfig);
    const records = await c.search(query);
    return json(200, { records });
  }

  /** Mirrors `xo registry inspect <id>` — package record plus its recorded benchmark runs, nothing this route computes itself. */
  async function inspect(req: ApiRequest): Promise<ApiResponse> {
    const id = req.params['id'];
    if (id === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing package id');
    const c = await client(req, workspaceStore, dataConfig);
    const record = unwrapOrThrow(await c.get(id));
    const benchmarkRuns = await c.listBenchmarksForPackage(id);
    return json(200, { record, benchmarkRuns });
  }

  async function recordBenchmark(req: ApiRequest): Promise<ApiResponse> {
    const id = req.params['id'];
    if (id === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing package id');
    const body = unwrapOrThrow(await req.json<RecordBenchmarkBody>());
    const input = parseRecordBenchmarkBody(id, body);
    const c = await client(req, workspaceStore, dataConfig);
    const run = unwrapOrThrow(await c.recordBenchmark(input));
    return json(201, run);
  }

  async function getBenchmark(req: ApiRequest): Promise<ApiResponse> {
    const benchmarkId = req.params['benchmarkId'];
    if (benchmarkId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing benchmark id');
    const c = await client(req, workspaceStore, dataConfig);
    const run = unwrapOrThrow(await c.getBenchmark(benchmarkId));
    return json(200, run);
  }

  async function listBenchmarksForPackage(req: ApiRequest): Promise<ApiResponse> {
    const id = req.params['id'];
    if (id === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing package id');
    const c = await client(req, workspaceStore, dataConfig);
    const runs = await c.listBenchmarksForPackage(id);
    return json(200, { runs });
  }

  async function createLicense(req: ApiRequest): Promise<ApiResponse> {
    const body = unwrapOrThrow(await req.json<CreateLicenseBody>());
    const input = parseCreateLicenseBody(body);
    const c = await client(req, workspaceStore, dataConfig);
    const license = unwrapOrThrow(await c.createLicense(input));
    return json(201, license);
  }

  async function getLicense(req: ApiRequest): Promise<ApiResponse> {
    const id = req.params['id'];
    if (id === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing license id');
    const c = await client(req, workspaceStore, dataConfig);
    const license = unwrapOrThrow(await c.getLicense(id));
    return json(200, license);
  }

  async function verifyLedgerEntry(req: ApiRequest): Promise<ApiResponse> {
    const entryHash = req.params['entryHash'];
    if (entryHash === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing ledger entry hash');
    const c = await client(req, workspaceStore, dataConfig);
    const verified = await c.verifyLedgerEntry(entryHash);
    return json(200, { entryHash, verified });
  }

  router.post('/workspaces/:workspaceId/registry/packages', guarded(publish));
  router.get('/workspaces/:workspaceId/registry/packages', guarded(listByCreator));
  router.get('/workspaces/:workspaceId/registry/packages/:id', guarded(getPackage));
  router.get('/workspaces/:workspaceId/registry/packages/:id/inspect', guarded(inspect));
  router.get('/workspaces/:workspaceId/registry/search', guarded(search));

  router.post('/workspaces/:workspaceId/registry/packages/:id/benchmarks', guarded(recordBenchmark));
  router.get('/workspaces/:workspaceId/registry/packages/:id/benchmarks', guarded(listBenchmarksForPackage));
  router.get('/workspaces/:workspaceId/registry/benchmarks/:benchmarkId', guarded(getBenchmark));

  router.post('/workspaces/:workspaceId/registry/licenses', guarded(createLicense));
  router.get('/workspaces/:workspaceId/registry/licenses/:id', guarded(getLicense));

  router.get('/workspaces/:workspaceId/registry/ledger/:entryHash/verify', guarded(verifyLedgerEntry));

  // Legacy, pre-P0.2 paths — see moved-stub.ts's doc comment.
  registerMovedStub(router, 'post', '/registry/packages', '/workspaces/:workspaceId/registry/packages');
  registerMovedStub(router, 'get', '/registry/packages', '/workspaces/:workspaceId/registry/packages');
  registerMovedStub(router, 'get', '/registry/packages/:id', '/workspaces/:workspaceId/registry/packages/:id');
  registerMovedStub(router, 'get', '/registry/packages/:id/inspect', '/workspaces/:workspaceId/registry/packages/:id/inspect');
  registerMovedStub(router, 'get', '/registry/search', '/workspaces/:workspaceId/registry/search');
  registerMovedStub(router, 'post', '/registry/packages/:id/benchmarks', '/workspaces/:workspaceId/registry/packages/:id/benchmarks');
  registerMovedStub(router, 'get', '/registry/packages/:id/benchmarks', '/workspaces/:workspaceId/registry/packages/:id/benchmarks');
  registerMovedStub(router, 'get', '/registry/benchmarks/:benchmarkId', '/workspaces/:workspaceId/registry/benchmarks/:benchmarkId');
  registerMovedStub(router, 'post', '/registry/licenses', '/workspaces/:workspaceId/registry/licenses');
  registerMovedStub(router, 'get', '/registry/licenses/:id', '/workspaces/:workspaceId/registry/licenses/:id');
  registerMovedStub(router, 'get', '/registry/ledger/:entryHash/verify', '/workspaces/:workspaceId/registry/ledger/:entryHash/verify');
}
