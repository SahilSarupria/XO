/**
 * UW-12a part 2 (ADR 0039) — pairing the local agent, its token, and the bytes it uploads.
 *
 *   pairing code   16 characters (80 bits) without look-alikes, shown once to the person who makes the connection, valid for
 *                  15 minutes and for ONE use. Kept as a hash in `<data>/agent-pairings/`, which maps it to its workspace and
 *                  connection; claiming it renames the entry first, so two agents racing for one code cannot both win.
 *   agent token    `xoa.<workspace>.<connection>.<43 base64url>`: opens that one connection and nothing else. The instance keeps
 *                  its sha256 on the connection and compares in constant time. Pairing again or retiring revokes it.
 *   staging        `<data>/<ws>/source-connections/<scn>/staging/<sha256>`: uploaded bytes, checked against their digest on the way
 *                  in and again when read, and removed after each snapshot's sync.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FolderError, type FolderItem, type FolderListing, type SourceReader } from '@xo/connect';

export const PAIRING_TTL_MS = 15 * 60_000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DIGEST = /^[0-9a-f]{64}$/;

const sha256 = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');
const pairingsDir = (dataRootDir: string): string => join(dataRootDir, 'agent-pairings');

export function newPairingCode(): string {
  const chars = Array.from({ length: 16 }, () => ALPHABET[randomInt(ALPHABET.length)]!);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

export async function savePairing(
  dataRootDir: string,
  code: string,
  entry: { workspaceId: string; connectionId: string; expiresAt: string },
): Promise<void> {
  await mkdir(pairingsDir(dataRootDir), { recursive: true, mode: 0o700 });
  await writeFile(join(pairingsDir(dataRootDir), `${sha256(code)}.json`), JSON.stringify(entry), { flag: 'wx', mode: 0o600 });
}

/** Single use: the entry is renamed away before it is read, so only one claim can succeed. Expired codes are refused. */
export async function claimPairing(
  dataRootDir: string,
  code: string,
  now: Date,
): Promise<{ workspaceId: string; connectionId: string } | undefined> {
  const from = join(pairingsDir(dataRootDir), `${sha256(code)}.json`);
  const to = `${from}.claimed-${randomBytes(6).toString('hex')}`;
  try {
    await rename(from, to);
  } catch {
    return undefined;
  }
  try {
    const e = JSON.parse(await readFile(to, 'utf8')) as { workspaceId: string; connectionId: string; expiresAt: string };
    if (!(Date.parse(e.expiresAt) > now.getTime())) return undefined;
    return { workspaceId: e.workspaceId, connectionId: e.connectionId };
  } finally {
    await rm(to, { force: true });
  }
}

/** Removes every unclaimed pairing code of a connection (pairing again, retiring), and any expired code. */
export async function revokePairings(dataRootDir: string, connectionId: string, now = new Date()): Promise<void> {
  let names: string[];
  try {
    names = await readdir(pairingsDir(dataRootDir));
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(pairingsDir(dataRootDir), n);
    try {
      const e = JSON.parse(await readFile(p, 'utf8')) as { connectionId?: string; expiresAt?: string };
      if (e.connectionId === connectionId || !(Date.parse(e.expiresAt ?? '') > now.getTime())) await rm(p, { force: true });
    } catch {
      /* claimed meanwhile */
    }
  }
}

export function newAgentToken(workspaceId: string, connectionId: string): { token: string; hash: string } {
  const token = `xoa.${workspaceId}.${connectionId}.${randomBytes(32).toString('base64url')}`;
  return { token, hash: sha256(token) };
}

export function tokenMatches(token: string, hash: string | undefined): boolean {
  if (hash === undefined || !DIGEST.test(hash)) return false;
  return timingSafeEqual(Buffer.from(sha256(token), 'hex'), Buffer.from(hash, 'hex'));
}

// ------------------------------------------------------------------------------------------------ staging and the agent's reader

export const stagingDir = (dataRootDir: string, workspaceId: string, connectionId: string): string =>
  join(dataRootDir, workspaceId, 'source-connections', connectionId, 'staging');

export async function stagedBytes(dir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const n of names) total += (await stat(join(dir, n)).catch(() => ({ size: 0 }))).size;
  return total;
}

/** Stores uploaded bytes under their digest, after checking them against it. */
export async function stage(dir: string, digest: string, bytes: Uint8Array): Promise<'stored' | 'already' | 'mismatch'> {
  if (!DIGEST.test(digest) || sha256(bytes) !== digest) return 'mismatch';
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(join(dir, digest), bytes, { flag: 'wx', mode: 0o600 });
    return 'stored';
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'already';
    throw e;
  }
}

export const clearStaging = (dir: string): Promise<void> => rm(dir, { recursive: true, force: true });

/** The agent's listing as a reader: bytes come from staging and must still match the digest the agent listed. */
export function agentSnapshotReader(dir: string, listing: FolderListing): SourceReader {
  return {
    list: async () => listing,
    async read(item: FolderItem) {
      const d = item.digestSha256;
      if (d === undefined || !DIGEST.test(d)) throw new FolderError('not_staged', `${item.name} was listed without a digest`);
      let bytes: Buffer;
      try {
        bytes = await readFile(join(dir, d));
      } catch {
        throw new FolderError('not_staged', `${item.name} was listed but its bytes were not uploaded`);
      }
      if (sha256(bytes) !== d) throw new FolderError('not_staged', `${item.name}: the uploaded bytes do not match their digest`);
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
    },
  };
}

/** When the agent last checked in, kept beside the connection (not on it, so polling does not churn its revisions). */
export async function noteAgentSeen(dataRootDir: string, workspaceId: string, connectionId: string, at: string): Promise<void> {
  const dir = join(dataRootDir, workspaceId, 'source-connections', connectionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'agent-seen.json'), JSON.stringify({ at }), { mode: 0o600 });
}

export async function agentLastSeen(dataRootDir: string, workspaceId: string, connectionId: string): Promise<string | undefined> {
  try {
    return (
      JSON.parse(await readFile(join(dataRootDir, workspaceId, 'source-connections', connectionId, 'agent-seen.json'), 'utf8')) as {
        at?: string;
      }
    ).at;
  } catch {
    return undefined;
  }
}
