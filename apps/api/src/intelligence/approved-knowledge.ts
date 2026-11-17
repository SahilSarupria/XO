/**
 * UW-4c — chat answers from APPROVED knowledge first.
 *
 * The workspace knowledge base holds what a reviewer approved: claims, entities and relationships with their evidence. This
 * port searches the head state's retrieval index (approved records only, BM25) and hands the chat each hit as evidence, with
 * the cited source and page. Raw compiled output (`WorkspaceSourcesKnowledgePort`) is still searched, but ranks after reviewed
 * knowledge (the composite's `tier`), so an answer stands on what a person approved whenever approved knowledge covers it.
 *
 * Record text is customer content: it reaches the model as evidence (data), never as instructions (trust rule T2; the chat
 * path's own handling of evidence applies).
 */
import type { Evidence, KnowledgeCatalog, KnowledgePort, KnowledgeQuery, KnowledgeResult, Principal } from '@xo/intelligence';
import type { KnowledgeBase, SearchHit } from '@xo/knowledge-base';

const MAX_EXCERPT = 1000;

function where(hit: SearchHit): string {
  const parts = hit.evidence.slice(0, 3).map((e) => {
    const pages = e.locator.pages !== undefined && e.locator.pages.length > 0 ? ` page ${e.locator.pages.join(', ')}` : '';
    const sheet =
      e.locator.sheet !== undefined ? ` sheet ${e.locator.sheet}${e.locator.row !== undefined ? ` row ${e.locator.row}` : ''}` : '';
    return `${e.sourceName}${pages}${sheet}`;
  });
  return parts.length === 0 ? 'asserted by a person' : parts.join('; ');
}

export class ApprovedKnowledgePort implements KnowledgePort {
  constructor(private readonly kb: () => Promise<KnowledgeBase>) {}

  async retrieve(q: KnowledgeQuery): Promise<KnowledgeResult> {
    try {
      const kb = await this.kb();
      const head = await kb.head();
      if (head.entries.length === 0) return { status: 'ok', method: 'lexical', evidence: [] };
      const scope = q.scope !== undefined && q.scope.length > 0 ? new Set(q.scope) : undefined;
      const hits = (await kb.search(head.stateId, q.query, Math.max(q.limit * 3, q.limit))).filter(
        (h) => scope === undefined || h.evidence.some((e) => scope.has(e.sourceName)),
      );
      const top = hits[0]?.score ?? 0;
      const evidence: Evidence[] = hits.slice(0, q.limit).map((h) => ({
        id: `kb:${head.stateId}:${h.recordId}`,
        sourceId: h.evidence[0]?.sourceDigestSha256 ?? h.recordId,
        sourceName: h.evidence[0]?.sourceName ?? 'approved knowledge',
        sourceType: 'approved-knowledge',
        excerpt:
          `${h.text}`.slice(0, MAX_EXCERPT) +
          ` (approved knowledge, ${h.kind}${h.authority !== undefined ? `, ${h.authority.basis}` : ''}; from ${where(h)})`,
        asOf: head.createdAt,
        score: top > 0 ? Math.round((h.score / top) * 1000) / 1000 : 0,
      }));
      return { status: 'ok', method: 'lexical', evidence };
    } catch {
      return { status: 'unavailable', reason: 'error' };
    }
  }

  async describe(_principal: Principal): Promise<KnowledgeCatalog> {
    const kb = await this.kb();
    const head = await kb.head();
    const records = head.entries.filter((e) => e.lifecycle === 'active').length;
    // Nothing approved yet: this port is not a source, so it names no source and no search method in the catalog.
    if (records === 0) return { sources: [] };
    return {
      sources: [
        { name: 'approved knowledge', kind: 'knowledge base', detail: `${records} approved record(s) in knowledge state ${head.stateId}` },
      ],
      searchMethod: 'keyword ranking (BM25)',
    };
  }
}
