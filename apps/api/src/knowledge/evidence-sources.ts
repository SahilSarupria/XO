/**
 * UW-4a — the workspace's stored sources, as the evidence resolver sees them (`EvidenceSourcePort` of @xo/knowledge-base).
 *
 * A cited source version is found by the SHA-256 of its bytes; the bytes are read from the workspace source store and hashed
 * again now (a stored file that changed on disk does not count as the version the evidence cites). Text, pages and sheets
 * come from the compiler's own source readers, the ones that produced the evidence, so a page number means the same thing
 * here as it did when the knowledge was compiled. Pages without a text layer are reported as such (their text was recovered
 * at compile time and is not re-read here).
 */
import { createHash } from 'node:crypto';
import { createDefaultSourceFrontendRegistry, type CanonicalSource, type DocumentSection } from '@xo/compiler';
import type { EvidenceSourcePort, SourceView } from '@xo/knowledge-base';
import type { BlobStore } from '@xo/storage';
import { buildCompilerSourceInput } from '../compilations/source-input-adapter.js';
import { FsSourceStore } from '../sources/fs-source-store.js';

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function pagesOf(root: DocumentSection): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const add = (page: number, text: string): void => {
    const list = out.get(page) ?? [];
    list.push(text);
    out.set(page, list);
  };
  const walk = (s: DocumentSection): void => {
    if (s.heading !== undefined) add(s.heading.provenance.page, s.heading.text);
    for (const b of s.blocks) add(b.provenance.page, b.kind === 'table_row' ? b.cells.join(' ') : b.text);
    for (const sub of s.subsections) walk(sub);
  };
  walk(root);
  return out;
}

/** What a canonical source offers the resolver (exported for tests). */
export function viewOfCanonicalSource(name: string, digestVerified: boolean, src: CanonicalSource): SourceView {
  if (src.content.kind !== 'document') return { name, digestVerified };
  const content = src.content;
  const sheets =
    content.tables === undefined
      ? undefined
      : Object.fromEntries(
          content.tables.sheets.map((g) => [g.name ?? 'Sheet1', { rows: g.rows.reduce((m, r) => Math.max(m, r.row), 0) }] as const),
        );
  const declared = Number(src.metadata.pageCount);
  if (src.sourceType === 'pdf' && Number.isInteger(declared) && declared > 0) {
    const byPage = pagesOf(content.parsed.root);
    const pageTexts = Array.from({ length: declared }, (_, i) => (byPage.get(i + 1) ?? []).join('\n'));
    const unreadable = (src.metadata.ocrRequiredPages ?? '')
      .split(',')
      .filter((x) => x !== '')
      .map(Number);
    return {
      name,
      digestVerified,
      pageCount: declared,
      pageTexts,
      ...(unreadable.length > 0 ? { unreadablePages: unreadable } : {}),
      ...(sheets !== undefined ? { sheets } : {}),
    };
  }
  return { name, digestVerified, text: content.plainText, ...(sheets !== undefined ? { sheets } : {}) };
}

export class WorkspaceEvidenceSources implements EvidenceSourcePort {
  private readonly registry = createDefaultSourceFrontendRegistry();
  private readonly views = new Map<string, Promise<SourceView | undefined>>();

  constructor(private readonly sources: BlobStore) {}

  source(digestSha256: string): Promise<SourceView | undefined> {
    let v = this.views.get(digestSha256);
    if (v === undefined) {
      v = this.read(digestSha256);
      this.views.set(digestSha256, v);
    }
    return v;
  }

  private async read(digestSha256: string): Promise<SourceView | undefined> {
    const store = new FsSourceStore(this.sources);
    const list = await store.list();
    if (!list.ok) throw list.error;
    const record = [...list.value].reverse().find((r) => r.digestSha256 === digestSha256);
    if (record === undefined) return undefined;
    const bytes = await store.getContent(record.sourceId);
    if (!bytes.ok) return undefined;
    const digestVerified = sha256(bytes.value) === digestSha256;
    if (!digestVerified) return { name: record.originalFilename, digestVerified };
    const ingested = this.registry.ingest(buildCompilerSourceInput(record.extension, bytes.value, record.originalFilename));
    // A source the readers cannot open still stands as bytes: its locators and quotes are unverifiable, not wrong.
    if (!ingested.ok) return { name: record.originalFilename, digestVerified };
    return viewOfCanonicalSource(record.originalFilename, digestVerified, ingested.value);
  }
}
