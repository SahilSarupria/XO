/**
 * UW-13 (ADR 0053) — labelled V1 sets. A set is a client list, a folder of documents and a labels file that states, for every row and
 * every document, the truth (not what XO is expected to do). A real set is read where it lies and never copied: only its hash, its
 * sizes and the measures leave this module.
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { ExcludedDocumentReason, ExcludedRowReason } from '@xo/connect';

export interface V1SetLabels {
  readonly format: 'xo-v1-set/1';
  readonly provenance: 'real' | 'synthetic';
  /** A role, never a person's email. */
  readonly labelledBy: string;
  readonly labelledWith: 'blind' | 'code-in-view' | 'construction';
  /** Relative path of the list: .csv or .xlsx. */
  readonly list: string;
  readonly sheet?: string;
  readonly nameColumn: string;
  readonly emailColumn: string;
  /** Relative folder of the documents. */
  readonly documents: string;
  readonly rows: readonly {
    readonly row: number;
    readonly name: string;
    readonly email: string;
    readonly expected: { readonly document: string } | { readonly excluded: ExcludedRowReason };
  }[];
  readonly documentsExpected: readonly {
    readonly name: string;
    readonly expected: { readonly row: number } | { readonly excluded: ExcludedDocumentReason };
  }[];
}

export interface LoadedV1Set {
  readonly labels: V1SetLabels;
  readonly listBytes: Buffer;
  /** Names of the documents, one per file; their bytes are hashed, never parsed. */
  readonly documentNames: string[];
  /** SHA-256 over the sorted `<relative path>\0<sha256 of bytes>\n` lines of labels.json, the list and every document. */
  readonly hash: string;
  readonly files: number;
  readonly bytes: number;
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const inside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

export async function loadV1Set(dir: string, repoRoot: string): Promise<LoadedV1Set> {
  const root = await realpath(dir);
  const repo = await realpath(repoRoot);
  const labelsBytes = await readFile(join(root, 'labels.json'));
  const labels = JSON.parse(labelsBytes.toString('utf8')) as V1SetLabels;
  if (labels.format !== 'xo-v1-set/1') throw new Error('the labels file is not format "xo-v1-set/1"');
  if (labels.provenance === 'real' && inside(root, repo)) throw new Error('a real labelled set must be kept outside the repository');
  if (labels.list.includes('..') || labels.documents.includes('..')) throw new Error('paths in the labels file stay inside the set');
  const lines: string[] = [];
  let bytes = labelsBytes.length;
  const add = (rel: string, data: Uint8Array): void => {
    lines.push(`${rel}\0${sha(data)}\n`);
    bytes += data.length;
  };
  add('labels.json', labelsBytes);
  const listPath = join(root, labels.list);
  if ((await lstat(listPath)).isSymbolicLink()) throw new Error('a symbolic link in a labelled set is refused');
  const listBytes = await readFile(listPath);
  add(labels.list, listBytes);
  const docDir = join(root, labels.documents);
  if ((await lstat(docDir)).isSymbolicLink()) throw new Error('a symbolic link in a labelled set is refused');
  const documentNames: string[] = [];
  for (const entry of (await readdir(docDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(docDir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('a symbolic link in a labelled set is refused');
    if (!entry.isFile()) continue;
    add(relative(root, full).split(sep).join('/'), await readFile(full));
    documentNames.push(entry.name);
  }
  lines.sort();
  return { labels, listBytes, documentNames, hash: sha(Buffer.from(lines.join(''))), files: lines.length, bytes };
}
