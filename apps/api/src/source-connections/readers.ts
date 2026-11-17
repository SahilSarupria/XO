/**
 * UW-12a part 2 (ADR 0039) — the reader for each kind of source connection, and the authorised HTTP cloud drives read through.
 *
 *   local_folder      the folder on this machine, re-approved against XO_SOURCE_FOLDER_ROOTS at every listing
 *   microsoft_drive   OneDrive / SharePoint through Microsoft Graph, with the workspace credential named on the connection
 *   google_drive      Google Drive, likewise
 *   agent_folder      no reader here: the agent on the person's computer sends the listing and bytes (routes/agent-routes.ts)
 *
 * Every drive request goes through the UW-9 broker (`use`, never `get`: the token is revealed only into the request's header) and
 * the pinned egress transport, to the provider's own hosts only. Microsoft's pre-authenticated download addresses are fetched
 * WITHOUT the token, and only on Microsoft storage hosts.
 */
import {
  DRIVE_API_HOSTS,
  FolderError,
  MICROSOFT_DOWNLOAD_HOSTS,
  googleDriveReader,
  localFolderReader,
  microsoftDriveReader,
  type CloudDriveProvider,
  type DriveHttp,
  type SourceConnection,
  type SourceReader,
} from '@xo/connect';
import { CredentialError, OAUTH_PROVIDERS, egress, revealSecret, type EgressPolicy } from '@xo/connectors';
import { ErrorCode, XoError } from '@xo/errors';
import type { AuditService } from '../audit/audit-service.js';
import { workspaceBroker, type CredentialsConfig } from '../credentials/credentials.js';
import { SUPPORTED_EXTENSIONS } from '../sources/source.js';
import type { WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceRecord } from '../workspace/workspace.js';
import { sourceFolderRoots } from './sync.js';

const JSON_MAX = 8 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

export interface ReaderContext {
  readonly workspace: WorkspaceRecord;
  readonly dataConfig: WorkspaceDataConfig;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly audit?: AuditService;
}

const fail = (status: number, what: string): FolderError =>
  status === 401 || status === 403
    ? new FolderError('credential_unusable', `${what}: the provider refused the connection's credential (${status}); reconnect it`)
    : status === 404
      ? new FolderError('item_missing', `${what}: not found (it was moved, deleted, or is no longer shared)`)
      : new FolderError('remote_unavailable', `${what}: the provider answered ${status}`);

/** Authorised drive HTTP for one credential: every call is a broker `use` that needs the read scope. */
export async function driveHttp(ctx: ReaderContext, credentialId: string, provider: CloudDriveProvider): Promise<DriveHttp> {
  const cfg: CredentialsConfig | undefined = await ctx.dataConfig.credentials?.();
  if (cfg === undefined)
    throw new FolderError('credential_unusable', 'connections are not configured on this instance (XO_CREDENTIALS_KEY)');
  const broker = workspaceBroker(ctx.workspace, ctx.dataConfig.dataRootDir, cfg, ctx.audit);
  const need = { scopes: OAUTH_PROVIDERS[provider].capabilityScopes['files.read'], purpose: 'source-connection:read' };
  const policy = (hosts: readonly string[], max: number): EgressPolicy => ({
    allowedHosts: hosts,
    maxRequestBytes: 0,
    maxResponseBytes: max,
  });
  const deps = cfg.oauth ?? {};
  const authorised = async (url: string, max: number, bytes: boolean) => {
    try {
      return await broker.use(credentialId, need, async (h) => {
        if (h.accessToken === undefined) throw new FolderError('credential_unusable', 'the credential has no access token');
        return egress(
          {
            url,
            method: 'GET',
            headers: { authorization: `Bearer ${revealSecret(h.accessToken)}`, accept: bytes ? '*/*' : 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
            ...(bytes ? { responseType: 'bytes' as const } : {}),
          },
          policy(DRIVE_API_HOSTS[provider], max),
          deps,
        );
      });
    } catch (e) {
      if (e instanceof CredentialError)
        throw new FolderError('credential_unusable', `the connection's credential cannot be used: ${e.message}`);
      if (e instanceof FolderError) throw e;
      throw new FolderError('remote_unavailable', `the drive could not be reached: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return {
    async getJson(url) {
      const r = await authorised(url, JSON_MAX, false);
      if (r.status !== 200) throw fail(r.status, 'the drive listing');
      try {
        return JSON.parse(r.body) as unknown;
      } catch {
        throw new FolderError('remote_unavailable', 'the drive answered something that is not JSON');
      }
    },
    async getBytes(url, max) {
      const r = await authorised(url, max, true);
      if (r.status !== 200) throw fail(r.status, 'a file download');
      return r.bytes ?? new Uint8Array();
    },
    async getPublicBytes(url, max) {
      let r;
      try {
        // No Authorization header: the address carries its own short-lived authorisation.
        r = await egress(
          { url, method: 'GET', headers: { accept: '*/*' }, signal: AbortSignal.timeout(TIMEOUT_MS), responseType: 'bytes' },
          policy(MICROSOFT_DOWNLOAD_HOSTS, max),
          deps,
        );
      } catch (e) {
        throw new FolderError('remote_unavailable', `a file download failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (r.status !== 200) throw fail(r.status, 'a file download');
      return r.bytes ?? new Uint8Array();
    },
  };
}

export async function readerFor(ctx: ReaderContext, c: SourceConnection): Promise<SourceReader> {
  switch (c.kind) {
    case 'local_folder':
      if (c.root === undefined) throw new XoError(ErrorCode.UNKNOWN, 'a local folder connection without a folder');
      return localFolderReader(c.root, sourceFolderRoots(ctx.env), SUPPORTED_EXTENSIONS);
    case 'microsoft_drive':
    case 'google_drive': {
      const r = c.remote;
      if (r === undefined) throw new XoError(ErrorCode.UNKNOWN, 'a drive connection without a drive');
      const http = await driveHttp(ctx, r.credentialId, r.provider);
      if (r.provider === 'microsoft') {
        const [driveId, folderId] = r.folder.split(':');
        return microsoftDriveReader({ driveId: driveId ?? '', folderId: folderId ?? '' }, http, SUPPORTED_EXTENSIONS);
      }
      return googleDriveReader({ folderId: r.folder }, http, SUPPORTED_EXTENSIONS);
    }
    case 'agent_folder':
      throw new FolderError('not_staged', 'the agent on the computer syncs this connection');
  }
}
