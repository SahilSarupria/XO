import { createHash, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';
import { canonicalJson, sha256Hex } from '@xo/workflow-ir';
import { RUN_ID, type JournalEntry, type RunStoreLike } from './journal.js';

/** Binary Merkle root over hex leaf hashes (odd node is promoted by hashing with itself). Empty input gives the hash of the empty string. */
export function merkleRoot(leaves: readonly string[]): string {
  if (leaves.length === 0) return sha256Hex('');
  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256Hex(`${level[i]}${level[i + 1] ?? level[i]}`));
    level = next;
  }
  return level[0] as string;
}

export interface AuditRun {
  readonly runId: string;
  readonly entries: readonly JournalEntry[];
  readonly headHash: string;
}

export interface AuditBundle {
  readonly formatVersion: '1';
  readonly createdAt: string;
  readonly workflow: { readonly id: string; readonly version: string; readonly componentSha256: string };
  /** Connector operations the operator had granted (effective grants), for the exporting host. */
  readonly connectorGrants: Readonly<Record<string, readonly string[]>>;
  /** Optional passthrough of the package manifest and load receipt (the caller supplies them; they are covered by the signature). */
  readonly manifest?: unknown;
  readonly loadReceipt?: unknown;
  readonly runs: readonly AuditRun[];
  /** Merkle root over the run head hashes (sorted by run id). */
  readonly merkleRoot: string;
  readonly signer: string;
  /** base64 Ed25519 signature over canonicalJson of everything above. */
  readonly signature: string;
}

export interface BuildAuditOptions {
  readonly store: RunStoreLike;
  readonly runIds: readonly string[];
  readonly workflow: { readonly id: string; readonly version: string };
  readonly componentBytes: Uint8Array;
  readonly connectorGrants: Readonly<Record<string, readonly string[]>>;
  readonly manifest?: unknown;
  readonly loadReceipt?: unknown;
  readonly signer: string;
  readonly privateKeyPem: string;
  readonly now?: () => Date;
}

type Unsigned = Omit<AuditBundle, 'signature'>;
const signingBytes = (b: Unsigned): Buffer => Buffer.from(canonicalJson(b));

export async function buildAuditBundle(o: BuildAuditOptions): Promise<AuditBundle> {
  const runs: AuditRun[] = [];
  for (const id of [...o.runIds].sort()) {
    if (!RUN_ID.test(id)) throw new Error(`invalid run id ${id}`);
    const entries = await o.store.read(id); // read() verifies the hash chain; a corrupt journal throws here
    if (entries.length === 0) throw new Error(`run ${id} has no journal`);
    runs.push({ runId: id, entries, headHash: (entries.at(-1) as JournalEntry).hash });
  }
  const unsigned: Unsigned = {
    formatVersion: '1',
    createdAt: (o.now?.() ?? new Date()).toISOString(),
    workflow: { ...o.workflow, componentSha256: createHash('sha256').update(o.componentBytes).digest('hex') },
    connectorGrants: o.connectorGrants,
    ...(o.manifest !== undefined ? { manifest: o.manifest } : {}),
    ...(o.loadReceipt !== undefined ? { loadReceipt: o.loadReceipt } : {}),
    runs,
    merkleRoot: merkleRoot(runs.map((r) => r.headHash)),
    signer: o.signer,
  };
  return { ...unsigned, signature: edSign(null, signingBytes(unsigned), o.privateKeyPem).toString('base64') };
}

export interface AuditVerification {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/** Independent verification: signature, Merkle root, and every run's hash chain. Needs only the bundle and the signer's public key. */
export function verifyAuditBundle(b: AuditBundle, signerPublicKeyPem: string): AuditVerification {
  const problems: string[] = [];
  const { signature, ...unsigned } = b;
  try {
    if (!edVerify(null, signingBytes(unsigned as Unsigned), createPublicKey(signerPublicKeyPem), Buffer.from(signature, 'base64')))
      problems.push('signature does not verify');
  } catch {
    problems.push('signature could not be checked');
  }
  if (merkleRoot(b.runs.map((r) => r.headHash)) !== b.merkleRoot) problems.push('merkle root does not match the run heads');
  for (const r of b.runs) {
    let prev = '0'.repeat(64);
    r.entries.forEach((e, i) => {
      const { hash, ...body } = e;
      if (e.seq !== i + 1 || e.prev !== prev || sha256Hex(canonicalJson(body)) !== hash)
        problems.push(`run ${r.runId}: chain breaks at entry ${e.seq}`);
      prev = hash;
    });
    if (r.entries.at(-1)?.hash !== r.headHash) problems.push(`run ${r.runId}: head hash does not match the last entry`);
  }
  return { ok: problems.length === 0, problems };
}
