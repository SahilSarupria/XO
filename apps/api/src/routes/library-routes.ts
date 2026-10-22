import { RegistryClient, FsPackageRepository } from '@xo/registry';
import { PackageInstaller, unpackArchive } from '@xo/package-sdk';
import type { PackageRecord } from '@xo/registry-core';
import { ErrorCode, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import {
  callerIdentityId,
  requireOwnedWorkspace,
  requirePermission,
  workspaceArchivesStore,
  workspacePackagesStore,
  workspaceRegistryStore,
  workspaceStateStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import type { WorkspaceRecord, WorkspaceStore } from '../workspace/workspace.js';
import { recordAudit } from '../audit/record.js';
import { FsSettingsStore } from '../settings/fs-settings-store.js';
import { loadArchive, readPublishers, summarizeBenchmarks, type BenchmarkSummary } from '../library/package-meta.js';

/**
 * The Library: what this workspace's registry holds, joined with what is installed and what benchmark runs exist.
 *
 * Scope, stated plainly: there is NO cross-workspace or public marketplace catalog behind this API. Every item is a
 * package that was published into THIS workspace's registry. A listing of other organizations' XOs, star ratings,
 * prices and "verified by independent runner" badges have no data source here and are therefore not in the response —
 * `trust` reports only what the records actually say (signed or not, benchmark runs recorded, and that the runner is
 * not recorded).
 */

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      return errorToResponse(cause);
    }
  };
}

type Scope = 'all' | 'installed' | 'mine';

interface LibraryItem {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly creatorDid: string;
  readonly publishedAt: string;
  readonly summary: string | null;
  readonly capabilities: readonly { readonly id: string; readonly name: string }[];
  readonly installed: boolean;
  readonly madeByMe: boolean;
  readonly trust: {
    readonly signed: boolean;
    readonly signerCount: number;
    readonly benchmarked: boolean;
    readonly overallScore: number | null;
    readonly independentlyVerified: false;
  };
}

function toItem(record: PackageRecord, installed: ReadonlySet<string>, publishers: Readonly<Record<string, string>>, me: { identityId: string; creatorDid?: string }, bench: BenchmarkSummary): LibraryItem {
  const m = record.manifest;
  const caps = m.capabilities ?? [];
  return {
    id: record.id,
    name: m.name,
    version: m.version,
    creatorDid: m.creatorDid,
    publishedAt: record.publishedAt,
    summary: caps[0]?.description ?? null,
    capabilities: caps.map((c) => ({ id: c.id, name: c.name })),
    installed: installed.has(`${m.name}@${m.version}`),
    madeByMe: publishers[record.id] === me.identityId || (me.creatorDid !== undefined && m.creatorDid === me.creatorDid),
    trust: {
      signed: (m.signatures ?? []).length > 0,
      signerCount: (m.signatures ?? []).length,
      benchmarked: bench.runs > 0,
      overallScore: bench.overall,
      independentlyVerified: false,
    },
  };
}

export function registerLibraryRoutes(router: Router, workspaceStore: WorkspaceStore, dataConfig: WorkspaceDataConfig): void {
  const ctx = (workspace: WorkspaceRecord) => ({
    registry: new RegistryClient(workspaceRegistryStore(workspace, dataConfig)),
    packages: new FsPackageRepository(workspaceRegistryStore(workspace, dataConfig)),
    installer: new PackageInstaller(workspacePackagesStore(workspace, dataConfig)),
    archives: workspaceArchivesStore(workspace, dataConfig),
    state: workspaceStateStore(workspace, dataConfig),
  });

  async function listLibrary(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const scope = (req.query.get('scope') ?? 'all') as Scope;
    if (scope !== 'all' && scope !== 'installed' && scope !== 'mine') throw new XoError(ErrorCode.INVALID_ARGUMENT, '"scope" must be "all", "installed" or "mine"');
    const q = req.query.get('q');
    const c = ctx(workspace);

    const records = q !== null && q.trim().length > 0 ? await c.registry.search(q) : await c.packages.listAll();
    const installedList = await c.installer.listInstalled();
    const installed = new Set(installedList.map((i) => `${i.name}@${i.version}`));
    const publishers = await readPublishers(c.state);
    const me = { identityId: callerIdentityId(req), ...(req.identity?.creatorDid !== undefined ? { creatorDid: req.identity.creatorDid } : {}) };

    const items: LibraryItem[] = [];
    for (const record of records) {
      const bench = summarizeBenchmarks(await c.registry.listBenchmarksForPackage(record.id));
      items.push(toItem(record, installed, publishers, me, bench));
    }
    const filtered = items.filter((i) => (scope === 'installed' ? i.installed : scope === 'mine' ? i.madeByMe : true));
    filtered.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0));
    return json(200, {
      items: filtered,
      counts: { all: items.length, installed: items.filter((i) => i.installed).length, mine: items.filter((i) => i.madeByMe).length },
      catalog: 'workspace',
    });
  }

  async function getPackage(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const id = req.params['packageId'];
    if (id === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing package id');
    const c = ctx(workspace);
    const found = await c.registry.get(id);
    if (!found.ok) throw found.error;
    const runs = await c.registry.listBenchmarksForPackage(id);
    const bench = summarizeBenchmarks(runs);
    const installed = new Set((await c.installer.listInstalled()).map((i) => `${i.name}@${i.version}`));
    const me = { identityId: callerIdentityId(req), ...(req.identity?.creatorDid !== undefined ? { creatorDid: req.identity.creatorDid } : {}) };
    const item = toItem(found.value, installed, await readPublishers(c.state), me, bench);
    const manifest = found.value.manifest;
    return json(200, {
      ...item,
      formatVersion: manifest.formatVersion,
      components: Object.entries(manifest.components).map(([kind, entry]) => ({ kind, path: entry.path, required: entry.required })),
      signatures: (manifest.signatures ?? []).map((sig) => ({ signerDid: sig.signerDid, role: sig.role })),
      benchmarks: bench,
      runs: runs.map((r) => ({ id: r.id, category: r.category, score: r.score, runAt: r.runAt, challengeable: r.challengeable })),
      installable: (await loadArchive(c.archives, id)) !== undefined,
    });
  }

  async function listInstalled(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const installed = await ctx(workspace).installer.listInstalled();
    return json(200, { installs: installed });
  }

  async function install(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'install package' });
    const bodyResult = await req.json<{ packageId?: unknown; force?: unknown }>();
    if (!bodyResult.ok) throw bodyResult.error;
    const { packageId, force } = bodyResult.value ?? {};
    if (typeof packageId !== 'string' || packageId.length === 0) throw new XoError(ErrorCode.INVALID_ARGUMENT, '"packageId" (string) is required');
    if (force !== undefined && typeof force !== 'boolean') throw new XoError(ErrorCode.INVALID_ARGUMENT, '"force", if present, must be a boolean');

    const c = ctx(workspace);
    const record = await c.registry.get(packageId);
    if (!record.ok) throw record.error;

    const settings = await new FsSettingsStore(workspaceStateStore(workspace, dataConfig), workspace.workspaceId).get();
    if (settings.trust.requireSignedPackages && (record.value.manifest.signatures ?? []).length === 0) {
      throw new XoError(ErrorCode.PRECONDITION_FAILED, 'this workspace requires signed packages (Settings → Trust and signing); this package carries no signatures');
    }
    const bytes = await loadArchive(c.archives, packageId);
    if (bytes === undefined) {
      throw new XoError(
        ErrorCode.PRECONDITION_FAILED,
        'the original package archive was not retained for this package (it was published before archives were kept); re-publish it to make it installable',
      );
    }
    const bundle = await unpackArchive(bytes);
    if (!bundle.ok) throw bundle.error;
    // Defense in depth: what we are about to install must be exactly what the registry vouches for.
    if (bundle.value.manifest.merkleRoot !== packageId) {
      throw new XoError(ErrorCode.CRYPTO_HASH_MISMATCH, 'the retained archive does not match the registry record for this package id');
    }
    const installed = await c.installer.install(bundle.value, force === true ? { force: true } : {});
    if (!installed.ok) throw installed.error;
    await recordAudit(req, workspace, dataConfig, {
      event: 'xo.installed',
      result: 'succeeded',
      target: { kind: 'xo', id: packageId, label: `${record.value.manifest.name}@${record.value.manifest.version}` },
    });
    return json(201, installed.value);
  }

  async function uninstall(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'uninstall package' });
    const name = req.params['name'];
    const version = req.params['version'];
    if (name === undefined || version === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing name/version');
    const result = await ctx(workspace).installer.uninstall(name, version);
    if (!result.ok) throw result.error;
    await recordAudit(req, workspace, dataConfig, { event: 'xo.uninstalled', result: 'succeeded', target: { kind: 'xo', id: `${name}@${version}`, label: `${name}@${version}` } });
    return json(200, { uninstalled: `${name}@${version}` });
  }

  router.get('/workspaces/:workspaceId/library', guarded(listLibrary));
  router.get('/workspaces/:workspaceId/library/packages/:packageId', guarded(getPackage));
  router.get('/workspaces/:workspaceId/library/installs', guarded(listInstalled));
  router.post('/workspaces/:workspaceId/library/installs', guarded(install));
  router.delete('/workspaces/:workspaceId/library/installs/:name/:version', guarded(uninstall));
}
