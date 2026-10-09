/**
 * Only server-bind config and the server's own bookkeeping directories
 * live here (`PORT`/`HOST`, `apiKeysDir`, `workspacesDir`,
 * `workspaceDataDir`). Prior to P0.2, package/registry/runtime routes
 * took a per-request `?registry=`/`?store=` query parameter naming an
 * arbitrary filesystem path — that has been removed entirely (see
 * `routes/moved-stub.ts`): those routes now resolve storage exclusively
 * through a workspace record (`workspace/workspace-context.ts`), which
 * itself resolves to a subdirectory under `workspaceDataDir` below, never
 * anything the caller names directly.
 */
export interface ApiConfig {
  readonly port: number;
  readonly host: string;
  /**
   * Where issued API key records live (`@xo/storage`'s `LocalFsBlobStore`
   * root — see `auth/fs-api-key-store.ts`). The server's own identity/
   * credential infrastructure — who's allowed to talk to this process at
   * all — which is inherently one directory per running server, the same
   * category of setting as `PORT`/`HOST`. Defaults to a directory under
   * the process's cwd so a fresh checkout works without any env setup; a
   * real deployment should set `API_KEYS_DIR` to a persistent volume.
   */
  readonly apiKeysDir: string;
  /**
   * Where workspace *metadata* records live (`@xo/storage`'s
   * `LocalFsBlobStore` root — see `workspace/fs-workspace-store.ts`).
   * Same category of setting as `apiKeysDir` above and for the same
   * reason: this is the server's own ownership bookkeeping (which
   * identity owns which workspace), not per-request data the caller
   * legitimately chooses a path for. Defaults alongside `apiKeysDir`
   * under the process's cwd for a fresh checkout; a real deployment
   * should set `WORKSPACES_DIR` to a persistent volume.
   */
  readonly workspacesDir: string;
  /**
   * Where workspace-scoped package/registry *data* lives — the root a
   * given workspace's `<workspaceId>/packages` and `<workspaceId>/registry`
   * subdirectories are created under (see
   * `workspace/workspace-context.ts`). Deliberately a separate root from
   * `workspacesDir` above: that one holds a handful of small ownership
   * records, this one holds actual package/registry bytes — different
   * retention/size/access characteristics even though both are, today,
   * plain `LocalFsBlobStore` directories. Defaults alongside the other
   * two; a real deployment should set `WORKSPACE_DATA_DIR` to a
   * persistent volume, likely a different (larger) one than
   * `WORKSPACES_DIR`.
   */
  readonly workspaceDataDir: string;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): ApiConfig {
  const portRaw = env['PORT'];
  const port = portRaw !== undefined ? Number(portRaw) : 4000;
  return {
    port: Number.isFinite(port) && port > 0 ? port : 4000,
    host: env['HOST'] ?? '127.0.0.1',
    apiKeysDir: env['API_KEYS_DIR'] ?? '.xo-data/api-keys',
    workspacesDir: env['WORKSPACES_DIR'] ?? '.xo-data/workspaces',
    workspaceDataDir: env['WORKSPACE_DATA_DIR'] ?? '.xo-data/workspace-data',
  };
}
