import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, sha256Hex, type WorkflowComponent } from '@xo/workflow-ir';
import { digestOfJson } from '../approvals/batch-approval.js';

/**
 * RX-1b (ADR 0048) — the run manifest: what a run was bound to when it was admitted, written once before its first journal entry.
 * Everything in it is already bound elsewhere (the definition, the certificate, the bindings and sending accounts, the input, the
 * batch approval, the Domain Knowledge Packs); the manifest puts the digests in one signed-over place, so an audit bundle and a
 * replay can say exactly what ran. It holds digests and ids, never the input itself.
 */
export interface RunManifest {
  readonly v: 1;
  readonly runId: string;
  readonly workspaceId: string;
  readonly definitionId: string;
  readonly workflowName: string;
  readonly compilationId: string;
  /** sha256 (hex) of the canonical JSON of the Workflow IR component that runs. */
  readonly componentSha256: string;
  readonly workflow?: { readonly workflowId: string; readonly version: number };
  readonly certificate: { readonly certificateId: string; readonly digest: string };
  /** Per connector of the definition: the digest of its workspace bindings and of the account it sends as. */
  readonly bindings: Readonly<Record<string, string>>;
  readonly inputDigest: string;
  readonly batch?: { readonly approvalId: string; readonly previewId: string; readonly root: string };
  /** RX-1d: the Domain Knowledge Packs the certificate pinned (id, namespace, version, digest). */
  readonly packs: readonly { readonly packId: string; readonly namespace: string; readonly version: string; readonly digest: string }[];
  readonly initiator: { readonly kind: string; readonly id: string };
  readonly admittedAt: string;
}

export interface StoredManifest {
  readonly manifest: RunManifest;
  /** digestOfJson(manifest): what a reader compares. */
  readonly digest: string;
}

export const componentSha256 = (component: WorkflowComponent): string => sha256Hex(canonicalJson(component as never));

const pathOf = (runsDir: string, runId: string): string => join(runsDir, 'manifests', `${runId}.json`);

/** Written once: a retry of the same start keeps the first manifest (the run is the same run). */
export async function writeManifest(runsDir: string, m: RunManifest): Promise<StoredManifest> {
  await mkdir(join(runsDir, 'manifests'), { recursive: true });
  const stored: StoredManifest = { manifest: m, digest: digestOfJson(m) };
  await writeFile(pathOf(runsDir, m.runId), JSON.stringify(stored), { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e;
  });
  return (await readManifest(runsDir, m.runId)) ?? stored;
}

/** The manifest of a run, or undefined for a run admitted before manifests existed (or an item of a batch: see its batch). */
export async function readManifest(runsDir: string, runId: string): Promise<StoredManifest | undefined> {
  try {
    const s = JSON.parse(await readFile(pathOf(runsDir, runId), 'utf8')) as StoredManifest;
    // A manifest whose digest no longer matches its content was changed after admission: it is reported, never trusted.
    return digestOfJson(s.manifest) === s.digest ? s : { ...s, digest: 'mismatch' };
  } catch {
    return undefined;
  }
}
