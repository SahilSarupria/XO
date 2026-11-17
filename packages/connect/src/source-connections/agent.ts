/**
 * UW-12a part 2 — the local agent: a folder on a person's own computer, connected to an XO instance that runs somewhere else.
 *
 * The agent runs on that computer (`xo agent`). It only ever calls OUT to the instance, so nothing has to reach into the person's
 * network, and it only ever READS the folder. The protocol (`xo.agent/1`, all under `/agent/v1/`):
 *
 *   POST /agent/v1/pair       a one-time pairing code (shown once, when the connection is made) → an agent token for that one
 *                             connection
 *   GET  /agent/v1/manifest   what the instance already holds (path, size, time, digest), what it reads, how often to sync
 *   PUT  /agent/v1/blob       the bytes of one new or changed file (`x-xo-digest`: its sha256; the instance checks it)
 *   POST /agent/v1/snapshot   the folder's listing as it is now; the instance then syncs exactly as for any other connection
 *
 * The agent applies the same listing rules as the instance (no links, nothing hidden or credential-looking, bounded). The token
 * opens one connection and nothing else; retiring the connection or pairing again revokes it.
 */
import { createHash } from 'node:crypto';
import {
  DEFAULT_FOLDER_LIMITS,
  listFolder,
  readFolderItem,
  type FolderItem,
  type FolderLimits,
  type FolderListing,
} from './folder-reader.js';

export const AGENT_PROTOCOL = 'xo.agent/1' as const;
export const AGENT_TOKEN = /^xoa\.(ws_[0-9a-f]{32})\.(scn_[0-9a-f]{24})\.([A-Za-z0-9_-]{43})$/;
/** XXXX-XXXX-XXXX-XXXX in an alphabet without look-alikes (0/O, 1/I/L). */
export const PAIRING_CODE = /^[A-HJ-KM-NP-Z2-9]{4}(?:-[A-HJ-KM-NP-Z2-9]{4}){3}$/;

export interface AgentPairRequest {
  readonly code: string;
  /** The folder's last segment, as the person will see it. */
  readonly folderName: string;
  /** A label for the computer (its host name, or what the person typed). */
  readonly label: string;
  readonly platform: string;
  readonly agentVersion: string;
}

export interface AgentPairResponse {
  readonly protocol: typeof AGENT_PROTOCOL;
  readonly connectionId: string;
  /** Shown once. The agent keeps it (owner-only file); the instance keeps only its hash. */
  readonly token: string;
}

export interface AgentManifest {
  readonly protocol: typeof AGENT_PROTOCOL;
  readonly connectionId: string;
  readonly state: 'active' | 'paused' | 'retired';
  readonly syncEveryMinutes: number;
  /** A person asked for a sync now. */
  readonly syncRequested: boolean;
  readonly extensions: readonly string[];
  readonly limits: FolderLimits;
  readonly have: readonly {
    readonly key: string;
    readonly sizeBytes: number;
    readonly modifiedAt: string;
    readonly digestSha256: string;
  }[];
}

export interface AgentSnapshot {
  readonly protocol: typeof AGENT_PROTOCOL;
  readonly folderName: string;
  readonly items: readonly (Omit<FolderItem, 'ref' | 'digestSha256'> & { readonly digestSha256: string })[];
  readonly skipped: FolderListing['skipped'];
  readonly truncated?: FolderListing['truncated'];
}

export interface AgentHttp {
  /** `fetch`-compatible. */
  (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string | Uint8Array },
  ): Promise<{
    status: number;
    text(): Promise<string>;
  }>;
}

export class AgentError extends Error {
  constructor(
    readonly code: 'unreachable' | 'refused' | 'unpaired' | 'retired' | 'insecure_server' | 'bad_folder',
    message: string,
  ) {
    super(message);
  }
}

/** https only, except to this computer itself (development). */
export function serverBase(server: string): string {
  let u: URL;
  try {
    u = new URL(server);
  } catch {
    throw new AgentError('insecure_server', 'the server address is not a URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback))
    throw new AgentError('insecure_server', 'the server must be https (plain http only to this computer)');
  if (u.username !== '' || u.password !== '') throw new AgentError('insecure_server', 'the server address must not contain credentials');
  return u.origin;
}

async function call<T>(
  http: AgentHttp,
  base: string,
  path: string,
  init: { method: string; headers: Record<string, string>; body?: string | Uint8Array },
  unauthorised = 'the instance does not accept this agent any more; pair it again',
): Promise<T> {
  let res;
  try {
    res = await http(`${base}${path}`, init);
  } catch (e) {
    throw new AgentError('unreachable', `cannot reach ${base}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  if (res.status === 401) throw new AgentError('unpaired', unauthorised);
  if (res.status === 410) throw new AgentError('retired', 'this connection was retired on the instance');
  if (res.status < 200 || res.status >= 300) {
    let message = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { message?: unknown; error?: { message?: unknown } };
      message = String(j.error?.message ?? j.message ?? message);
    } catch {
      /* keep the text */
    }
    throw new AgentError('refused', `the instance refused ${path} (${res.status}): ${message}`);
  }
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

export function pairAgent(http: AgentHttp, server: string, req: AgentPairRequest): Promise<AgentPairResponse> {
  if (!PAIRING_CODE.test(req.code.trim().toUpperCase()))
    throw new AgentError('refused', 'that is not a pairing code (XXXX-XXXX-XXXX-XXXX)');
  return call<AgentPairResponse>(
    http,
    serverBase(server),
    '/agent/v1/pair',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...req, code: req.code.trim().toUpperCase() }),
    },
    'the pairing code is not valid: it was already used, has expired, or was replaced; make a new one on the instance',
  );
}

/** What the instance wants now (also how the agent says it is alive). 401 → unpaired, 410 → retired, as AgentError. */
export function agentManifest(http: AgentHttp, server: string, token: string): Promise<AgentManifest> {
  if (!AGENT_TOKEN.test(token)) throw new AgentError('unpaired', 'the saved agent token is not valid; pair again');
  return call<AgentManifest>(http, serverBase(server), '/agent/v1/manifest', {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
}

/** Digests the agent already computed, so an unchanged file is not read again: key → size, time, digest. */
export type DigestCache = Record<string, { readonly sizeBytes: number; readonly modifiedAt: string; readonly digestSha256: string }>;

export interface AgentRunResult {
  readonly uploaded: number;
  readonly listed: number;
  readonly report: unknown;
  readonly cache: DigestCache;
}

/** One sync: compare, upload what the instance lacks, send the listing. `folder` is the real path the person chose. */
export async function runAgentOnce(
  http: AgentHttp,
  server: string,
  token: string,
  folder: string,
  folderName: string,
  cache: DigestCache = {},
): Promise<AgentRunResult & { readonly manifest: AgentManifest }> {
  if (!AGENT_TOKEN.test(token)) throw new AgentError('unpaired', 'the saved agent token is not valid; pair again');
  const base = serverBase(server);
  const auth = { authorization: `Bearer ${token}` };
  const manifest = await call<AgentManifest>(http, base, '/agent/v1/manifest', { method: 'GET', headers: auth });
  if (manifest.state === 'retired') throw new AgentError('retired', 'this connection was retired on the instance');
  if (manifest.state === 'paused') return { uploaded: 0, listed: 0, report: { paused: true }, cache, manifest };
  const limits = { ...DEFAULT_FOLDER_LIMITS, ...manifest.limits };
  let listing: FolderListing;
  try {
    listing = await listFolder(folder, new Set(manifest.extensions), limits);
  } catch (e) {
    throw new AgentError('bad_folder', `cannot read the folder: ${e instanceof Error ? e.message : String(e)}`);
  }
  const have = new Set(manifest.have.map((h) => h.digestSha256));
  const next: DigestCache = {};
  const items: AgentSnapshot['items'][number][] = [];
  let uploaded = 0;
  for (const f of listing.items) {
    const known = cache[f.key];
    let digest: string;
    let bytes: Uint8Array | undefined;
    if (known !== undefined && known.sizeBytes === f.sizeBytes && known.modifiedAt === f.modifiedAt) digest = known.digestSha256;
    else {
      try {
        bytes = await readFolderItem(folder, f, limits);
      } catch {
        continue; // gone or swapped since the listing: the next run sees it
      }
      digest = createHash('sha256').update(bytes).digest('hex');
    }
    if (!have.has(digest)) {
      if (bytes === undefined) {
        try {
          bytes = await readFolderItem(folder, f, limits);
        } catch {
          continue;
        }
        const now = createHash('sha256').update(bytes).digest('hex');
        if (now !== digest) digest = now;
      }
      await call(http, base, '/agent/v1/blob', {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/octet-stream', 'x-xo-digest': digest },
        body: bytes,
      });
      have.add(digest);
      uploaded++;
    }
    next[f.key] = { sizeBytes: f.sizeBytes, modifiedAt: f.modifiedAt, digestSha256: digest };
    items.push({
      key: f.key,
      name: f.name,
      extension: f.extension,
      sizeBytes: f.sizeBytes,
      modifiedAt: f.modifiedAt,
      digestSha256: digest,
    });
  }
  const snapshot: AgentSnapshot = {
    protocol: AGENT_PROTOCOL,
    folderName,
    items,
    skipped: listing.skipped,
    ...(listing.truncated !== undefined ? { truncated: listing.truncated } : {}),
  };
  const report = await call<unknown>(http, base, '/agent/v1/snapshot', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(snapshot),
  });
  return { uploaded, listed: items.length, report, cache: next, manifest };
}
