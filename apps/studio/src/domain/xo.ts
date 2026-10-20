import type { Compilation, Source } from '../platform/wire';

/**
 * An "XO" in Studio is an analysed document: a succeeded compilation, named after the document it came from.
 * Nothing here is a version, a publisher or a score: the platform's compilation records carry none of those.
 */
export interface XoItem {
  readonly id: string;
  readonly label: string;
  readonly sourceId: string;
  readonly at: string;
}

export function documentLabel(filename: string): string {
  const base = filename.replace(/\.[A-Za-z0-9]{1,6}$/, '').trim();
  return base === '' ? filename : base;
}

export function xoItems(compilations: readonly Compilation[], sources: readonly Source[]): XoItem[] {
  const names = new Map(sources.map((s) => [s.sourceId, documentLabel(s.originalFilename)]));
  return compilations
    .filter((c) => c.status === 'succeeded')
    .map((c) => ({ id: c.compilationId, label: names.get(c.sourceId) ?? 'Analysed document', sourceId: c.sourceId, at: c.completedAt ?? c.createdAt }))
    .sort((a, b) => b.at.localeCompare(a.at));
}
