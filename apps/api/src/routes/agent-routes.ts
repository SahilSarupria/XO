/**
 * UW-12a part 2 (ADR 0039) — the local agent's side of the instance: `/agent/v1/*` (protocol `xo.agent/1`, see
 * `@xo/connect` source-connections/agent.ts).
 *
 * These paths take no person's sign-in. Pairing takes a one-time pairing code; everything else takes an agent token, which opens
 * exactly one agent connection. A token that does not match, for a connection that is not an agent's, answers 401 with no detail;
 * a retired connection answers 410 so the agent stops.
 */
import {
  AGENT_PROTOCOL,
  AGENT_TOKEN,
  DEFAULT_FOLDER_LIMITS,
  PAIRING_CODE,
  type AgentManifest,
  type AgentSnapshot,
  type FolderItem,
  type FolderListing,
  type SourceConnection,
} from '@xo/connect';
import { validateKeyLexically } from '@xo/environment-intelligence';
import { ErrorCode, XoError } from '@xo/errors';
import type { AuditActor } from '../audit/audit-entry.js';
import { openWorkspaceAuditLog } from '../audit/workspace-audit-log.js';
import type { Router } from '../http/router.js';
import { json, type ApiRequest } from '../http/types.js';
import { SUPPORTED_EXTENSIONS } from '../sources/source.js';
import {
  agentSnapshotReader,
  claimPairing,
  clearStaging,
  newAgentToken,
  noteAgentSeen,
  revokePairings,
  stage,
  stagedBytes,
  stagingDir,
  tokenMatches,
} from '../source-connections/agent-pairing.js';
import { FsSourceConnectionStore } from '../source-connections/store.js';
import { syncConnection } from '../source-connections/sync.js';
import type { WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceRecord, WorkspaceStore } from '../workspace/workspace.js';

export const AGENT_PATHS = ['/agent/v1/pair', '/agent/v1/manifest', '/agent/v1/blob', '/agent/v1/snapshot'] as const;
export const AGENT_SYNC_MINUTES = 15;

const SKIP_REASONS = new Set([
  'unsupported_format',
  'hidden',
  'sensitive_name',
  'excluded_directory',
  'symlink_not_followed',
  'not_regular_file',
  'hard_linked_file',
  'too_large',
  'too_deep',
  'unreadable',
]);

const unauthorized = (): XoError => new XoError(ErrorCode.AUTH_TOKEN_INVALID, 'agent not recognised');
const label = (v: unknown, max: number): string =>
  typeof v === 'string'
    ? v
        .replace(/[\u0000-\u001f\u007f/\\]/g, ' ')
        .trim()
        .slice(0, max)
    : '';

export function registerAgentRoutes(router: Router, workspaceStore: WorkspaceStore, dataConfig: WorkspaceDataConfig): void {
  const actor = (c: SourceConnection): AuditActor => ({ identityId: `agent:${c.connectionId}`, kind: 'service' });
  const audit = async (
    w: WorkspaceRecord,
    c: SourceConnection,
    event: 'source_connection.agent_paired',
    detail: Record<string, unknown>,
  ) => {
    try {
      await openWorkspaceAuditLog(w, dataConfig).append({
        event,
        result: 'succeeded',
        actor: actor(c),
        target: { kind: 'source-connection', id: c.connectionId, label: c.displayName },
        detail,
      });
    } catch (cause) {
      process.stderr.write(`[xo-api] audit write failed (${event}): ${cause instanceof Error ? cause.message : String(cause)}\n`);
    }
  };

  /** The agent's workspace and connection, or 401. */
  const authenticate = async (req: ApiRequest): Promise<{ w: WorkspaceRecord; c: SourceConnection; store: FsSourceConnectionStore }> => {
    const h = req.headers['authorization'];
    const m = typeof h === 'string' ? /^Bearer (\S+)$/.exec(h) : null;
    const token = m?.[1];
    const parts = token !== undefined ? AGENT_TOKEN.exec(token) : null;
    if (token === undefined || parts === null) throw unauthorized();
    const ws = await workspaceStore.get(parts[1]!);
    if (!ws.ok) throw unauthorized();
    const store = new FsSourceConnectionStore(ws.value, dataConfig);
    const c = await store.get(parts[2]!);
    if (c === undefined || c.kind !== 'agent_folder' || !tokenMatches(token, c.agent?.tokenHash)) throw unauthorized();
    if (c.retiredAt !== undefined) throw new XoError(ErrorCode.SOURCE_CONNECTION_RETIRED, 'this connection was retired');
    return { w: ws.value, c, store };
  };

  router.post('/agent/v1/pair', async (req) => {
    const b = await req.json<Record<string, unknown>>();
    if (!b.ok) throw b.error;
    const o = typeof b.value === 'object' && b.value !== null ? b.value : {};
    const code = typeof o['code'] === 'string' ? o['code'].trim().toUpperCase() : '';
    if (!PAIRING_CODE.test(code)) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'that is not a pairing code');
    const now = new Date();
    const claimed = await claimPairing(dataConfig.dataRootDir, code, now);
    // Unknown, used and expired codes look the same.
    if (claimed === undefined)
      throw new XoError(ErrorCode.AUTH_TOKEN_INVALID, 'that pairing code is not valid (it may have been used or expired)');
    const ws = await workspaceStore.get(claimed.workspaceId);
    if (!ws.ok) throw unauthorized();
    const store = new FsSourceConnectionStore(ws.value, dataConfig);
    const c = await store.get(claimed.connectionId);
    if (c === undefined || c.kind !== 'agent_folder' || c.retiredAt !== undefined) throw unauthorized();
    const { token, hash } = newAgentToken(ws.value.workspaceId, c.connectionId);
    const folderName = label(o['folderName'], 120) || 'Folder';
    const next = await store.update(c.connectionId, undefined, now, (cur) => ({
      ...cur,
      displayName: folderName,
      agent: {
        tokenHash: hash,
        pairedAt: now.toISOString(),
        label: label(o['label'], 80) || 'a computer',
        platform: label(o['platform'], 40),
        agentVersion: label(o['agentVersion'], 40),
      },
    }));
    await revokePairings(dataConfig.dataRootDir, c.connectionId, now);
    await audit(ws.value, next, 'source_connection.agent_paired', { label: next.agent?.label, platform: next.agent?.platform });
    return json(200, { protocol: AGENT_PROTOCOL, connectionId: c.connectionId, token });
  });

  router.get('/agent/v1/manifest', async (req) => {
    const { w, c } = await authenticate(req);
    await noteAgentSeen(dataConfig.dataRootDir, w.workspaceId, c.connectionId, new Date().toISOString());
    const manifest: AgentManifest = {
      protocol: AGENT_PROTOCOL,
      connectionId: c.connectionId,
      state: c.paused ? 'paused' : 'active',
      syncEveryMinutes: c.sync.mode === 'interval' ? c.sync.everyMinutes : AGENT_SYNC_MINUTES,
      syncRequested: c.agent?.syncRequestedAt !== undefined,
      extensions: [...SUPPORTED_EXTENSIONS].sort(),
      limits: DEFAULT_FOLDER_LIMITS,
      have: c.items.map((i) => ({ key: i.key, sizeBytes: i.sizeBytes, modifiedAt: i.modifiedAt, digestSha256: i.digestSha256 })),
    };
    return json(200, manifest);
  });

  router.put('/agent/v1/blob', async (req) => {
    const { w, c } = await authenticate(req);
    if (c.paused) throw new XoError(ErrorCode.PRECONDITION_FAILED, 'this connection is paused');
    const digest = req.headers['x-xo-digest'];
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest))
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'x-xo-digest is the sha256 of the body');
    const bytes = await req.rawBody();
    if (bytes.length > DEFAULT_FOLDER_LIMITS.maxFileBytes)
      throw new XoError(ErrorCode.SOURCE_UPLOAD_TOO_LARGE, 'the file is over the size limit');
    const dir = stagingDir(dataConfig.dataRootDir, w.workspaceId, c.connectionId);
    if ((await stagedBytes(dir)) + bytes.length > DEFAULT_FOLDER_LIMITS.maxTotalBytes)
      throw new XoError(ErrorCode.SOURCE_UPLOAD_TOO_LARGE, 'too much is waiting to be synced; send the snapshot first');
    const r = await stage(dir, digest, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length));
    if (r === 'mismatch') throw new XoError(ErrorCode.INVALID_ARGUMENT, 'the body does not match x-xo-digest');
    return json(r === 'stored' ? 201 : 200, { digest, stored: r === 'stored' });
  });

  router.post('/agent/v1/snapshot', async (req) => {
    const { w, c, store } = await authenticate(req);
    if (c.paused) throw new XoError(ErrorCode.PRECONDITION_FAILED, 'this connection is paused');
    const b = await req.json<AgentSnapshot>();
    if (!b.ok) throw b.error;
    const listing = parseSnapshot(b.value);
    const dir = stagingDir(dataConfig.dataRootDir, w.workspaceId, c.connectionId);
    const now = new Date();
    try {
      const synced = await syncConnection(
        { workspace: w, dataConfig, actor: actor(c), readerFor: async () => agentSnapshotReader(dir, listing) },
        c.connectionId,
        now,
        agentSnapshotReader(dir, listing),
      );
      const done =
        synced.agent?.syncRequestedAt !== undefined
          ? await store.update(c.connectionId, undefined, now, (cur) => {
              const { syncRequestedAt: _done, ...agent } = cur.agent ?? {};
              return { ...cur, agent };
            })
          : synced;
      return json(200, { connectionId: c.connectionId, lastSync: done.lastSync });
    } finally {
      await clearStaging(dir);
    }
  });
}

/** The agent's listing, checked: paths inside the folder, formats the workspace reads, sizes and counts within the limits. */
function parseSnapshot(v: unknown): FolderListing {
  const bad = (m: string): never => {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `snapshot: ${m}`);
  };
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  if (o['protocol'] !== AGENT_PROTOCOL) bad(`protocol must be ${AGENT_PROTOCOL}`);
  const raw = o['items'];
  if (!Array.isArray(raw) || raw.length > DEFAULT_FOLDER_LIMITS.maxFiles)
    bad(`items is a list of at most ${DEFAULT_FOLDER_LIMITS.maxFiles}`);
  const seen = new Set<string>();
  let total = 0;
  const items: FolderItem[] = (raw as unknown[]).map((x, i) => {
    const it = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
    const key = it['key'];
    if (typeof key !== 'string' || key.length > 1024 || !validateKeyLexically(key).ok || key.split('/').some((s) => s.startsWith('.')))
      bad(`items[${i}].key is not a path inside the folder`);
    if (seen.has(key as string)) bad(`items[${i}].key is listed twice`);
    seen.add(key as string);
    const name = (key as string).split('/').at(-1)!;
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 ? name.slice(dot).toLowerCase() : '';
    if (!SUPPORTED_EXTENSIONS.has(extension)) bad(`items[${i}] is not a format the workspace reads`);
    const size = it['sizeBytes'];
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > DEFAULT_FOLDER_LIMITS.maxFileBytes)
      bad(`items[${i}].sizeBytes`);
    total += size as number;
    const digest = it['digestSha256'];
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) bad(`items[${i}].digestSha256`);
    const modifiedAt = it['modifiedAt'];
    if (typeof modifiedAt !== 'string' || Number.isNaN(Date.parse(modifiedAt))) bad(`items[${i}].modifiedAt`);
    return {
      key: key as string,
      name,
      extension,
      sizeBytes: size as number,
      modifiedAt: modifiedAt as string,
      digestSha256: digest as string,
    };
  });
  if (total > DEFAULT_FOLDER_LIMITS.maxTotalBytes) bad('more than the total size limit');
  const skipped: Record<string, number> = {};
  const rs = o['skipped'];
  if (typeof rs === 'object' && rs !== null)
    for (const [k, n] of Object.entries(rs))
      if (SKIP_REASONS.has(k) && typeof n === 'number' && Number.isInteger(n) && n >= 0) skipped[k] = Math.min(n, 1_000_000);
  const truncated = o['truncated'];
  return {
    items: items.sort((a, b) => a.key.localeCompare(b.key)),
    skipped,
    ...(truncated === 'max_files' || truncated === 'max_total_bytes' ? { truncated } : {}),
  };
}
