import {
  PackageInstaller,
  PackageValidator,
  createLockfile,
  resolveDependencies,
  serializeLockfile,
  unpackArchive,
  type ManifestLookup,
} from '@xo/package-sdk';
import type { XoManifest } from '@xo/types';
import { ErrorCode, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import { requireOwnedWorkspace, workspacePackagesStore, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceStore } from '../workspace/workspace.js';
import { registerMovedStub } from './moved-stub.js';

/**
 * `build`/`pack` stay CLI-only per the brief ("more CLI-native") — they
 * take local source directories as input, which doesn't translate to an
 * HTTP request shape without inventing a file-upload protocol this repo
 * has no other use for. What's here: `validate` (an uploaded archive,
 * read-only, stateless — see below for why it is deliberately NOT
 * workspace-scoped), `resolve` (dry-run dependency resolution against a
 * workspace's installed packages, nothing written), and `lock` (the one
 * write — mirrors `xo lock` exactly, see `lock.ts`).
 *
 * P0.2: every handler that used to build its `PackageInstaller` from a
 * client-supplied `?store=` directory now resolves storage exclusively
 * through `requireOwnedWorkspace` + `workspacePackagesStore` — see
 * `workspace/workspace-context.ts`. `validate` never took a `?store=`
 * to begin with (it only ever unpacks/validates the archive bytes in
 * the request body — see the original `README`'s "Package validate"
 * note), so it is untouched, not moved under `/workspaces/:id/...`, and
 * has no legacy stub registered for it.
 */

function unwrapOrThrow<T>(result: { ok: true; value: T } | { ok: false; error: XoError }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/**
 * Adapts `PackageInstaller.listAllInstalledRecords()` +
 * `getManifest()` into a `ManifestLookup` — the same adapter
 * `apps/cli/src/commands/package/dependency-lookup.ts#buildLocalStoreLookup`
 * implements for the CLI. Not reusable from here directly (`apps/cli`
 * isn't set up as an importable library — see its `package.json`, which
 * only declares a `bin`, no `exports`), so this is a deliberate,
 * small duplication of that one function rather than a cross-app
 * dependency between `apps/api` and `apps/cli`.
 */
async function buildLocalStoreLookup(inst: PackageInstaller): Promise<ManifestLookup> {
  const records = await inst.listAllInstalledRecords();
  const versionsByName = new Map<string, string[]>();
  for (const record of records) {
    const versions = versionsByName.get(record.name);
    if (versions) versions.push(record.version);
    else versionsByName.set(record.name, [record.version]);
  }
  return async (name: string): Promise<readonly XoManifest[]> => {
    const versions = versionsByName.get(name) ?? [];
    const manifests: XoManifest[] = [];
    for (const version of versions) {
      const result = await inst.getManifest(name, version);
      if (result.ok) manifests.push(result.value);
    }
    return manifests;
  };
}

/** Same store layout convention `dependency-lookup.ts#lockfileKey` uses, mirrored here for the same reason as `buildLocalStoreLookup` above. */
function lockfileKey(name: string, version: string): string {
  return `${name}/${version}/xo.lock`;
}

interface ValidateBody {
  /** Base64-encoded `.xo` archive bytes. JSON, not a raw-bytes POST, so `publicKeys` can travel alongside it in one request — see the README's "Package validate" note on why this differs from the CLI's file-path-based `--pubkey`. */
  readonly archiveBase64?: unknown;
  /** `{ [creatorDid]: pemPublicKey }` — PEM text supplied directly, never a local file path, since a remote caller has no local filesystem for the server to read from on its behalf (unlike `xo verify --pubkey did=path`, which reads a path on the machine running the CLI itself). */
  readonly publicKeys?: unknown;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).every((v) => typeof v === 'string');
}

async function validate(req: ApiRequest): Promise<ApiResponse> {
  const body = unwrapOrThrow(await req.json<ValidateBody>());
  if (typeof body.archiveBase64 !== 'string' || body.archiveBase64.length === 0) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, '"archiveBase64" (base64-encoded .xo archive) is required');
  }
  if (body.publicKeys !== undefined && !isStringRecord(body.publicKeys)) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, '"publicKeys", if present, must be an object of { [did]: pemString }');
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(body.archiveBase64, 'base64'));
  } catch (cause) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, '"archiveBase64" is not valid base64', { cause });
  }

  const unpacked = unwrapOrThrow(await unpackArchive(bytes));

  const publicKeys = body.publicKeys as Record<string, string> | undefined;
  const validator = new PackageValidator(publicKeys !== undefined && Object.keys(publicKeys).length > 0 ? { resolvePublicKey: (did) => publicKeys[did] } : {});
  const report = validator.validateAll(unpacked);

  return json(report.valid ? 200 : 422, report);
}

interface ResolveBody {
  /** `"<name>@<version>"` of an already-installed package to resolve dependencies for. */
  readonly nameAtVersion?: unknown;
}

function splitNameAtVersion(nameAtVersion: string): { readonly name: string; readonly version: string } | undefined {
  const at = nameAtVersion.lastIndexOf('@');
  if (at <= 0) return undefined;
  return { name: nameAtVersion.slice(0, at), version: nameAtVersion.slice(at + 1) };
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

export function registerPackageRoutes(router: Router, workspaceStore: WorkspaceStore, dataConfig: WorkspaceDataConfig): void {
  // Not workspace-scoped — see the doc comment at the top of this file.
  router.post('/packages/validate', guarded(validate));

  /** Dry-run of what `lock` (below) would write — resolves and returns the result, writes nothing. */
  async function resolve(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const inst = new PackageInstaller(workspacePackagesStore(workspace, dataConfig));

    const body = unwrapOrThrow(await req.json<ResolveBody>());
    if (typeof body.nameAtVersion !== 'string') {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"nameAtVersion" (string, "<name>@<version>") is required');
    }
    const parsed = splitNameAtVersion(body.nameAtVersion);
    if (parsed === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, `expected "<name>@<version>", got "${body.nameAtVersion}"`);

    const manifest = unwrapOrThrow(await inst.getManifest(parsed.name, parsed.version));
    const lookup = await buildLocalStoreLookup(inst);
    const resolution = unwrapOrThrow(await resolveDependencies(manifest, lookup));
    return json(200, resolution);
  }

  async function lock(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const store = workspacePackagesStore(workspace, dataConfig);
    const inst = new PackageInstaller(store);

    const body = unwrapOrThrow(await req.json<ResolveBody>());
    if (typeof body.nameAtVersion !== 'string') {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"nameAtVersion" (string, "<name>@<version>") is required');
    }
    const parsed = splitNameAtVersion(body.nameAtVersion);
    if (parsed === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, `expected "<name>@<version>", got "${body.nameAtVersion}"`);

    const manifest = unwrapOrThrow(await inst.getManifest(parsed.name, parsed.version));
    const lookup = await buildLocalStoreLookup(inst);
    const resolution = unwrapOrThrow(await resolveDependencies(manifest, lookup));

    const lockfile = createLockfile(resolution);
    const putResult = await store.put(lockfileKey(parsed.name, parsed.version), serializeLockfile(lockfile), { contentType: 'application/json' });
    if (!putResult.ok) throw putResult.error;

    return json(200, lockfile);
  }

  async function getManifest(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const name = req.params['name'];
    const version = req.params['version'];
    if (name === undefined || version === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing name/version');
    const inst = new PackageInstaller(workspacePackagesStore(workspace, dataConfig));
    const manifest = unwrapOrThrow(await inst.getManifest(name, version));
    return json(200, manifest);
  }

  router.post('/workspaces/:workspaceId/packages/resolve', guarded(resolve));
  router.post('/workspaces/:workspaceId/packages/lock', guarded(lock));
  router.get('/workspaces/:workspaceId/packages/:name/:version/manifest', guarded(getManifest));

  // Legacy, pre-P0.2 paths: previously accepted an arbitrary client-
  // supplied `?store=` directory. Rather than silently ignoring that
  // query parameter now (which would look like it still works while
  // quietly resolving to nothing, or worse, to a shared default), these
  // return a clear, structured 400 pointing at the replacement route.
  registerMovedStub(router, 'post', '/packages/resolve', '/workspaces/:workspaceId/packages/resolve');
  registerMovedStub(router, 'post', '/packages/lock', '/workspaces/:workspaceId/packages/lock');
  registerMovedStub(router, 'get', '/packages/:name/:version/manifest', '/workspaces/:workspaceId/packages/:name/:version/manifest');
}
