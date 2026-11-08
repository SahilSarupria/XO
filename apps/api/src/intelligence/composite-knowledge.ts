import type { Evidence, KnowledgeCatalog, KnowledgePort, KnowledgeQuery, KnowledgeResult, Principal } from '@xo/intelligence';

/**
 * Searches several knowledge sources and merges the results by relevance. Used to combine the interim development
 * sources. If every source fails the result is "unavailable"; if only some fail the result is still returned and the
 * failed ones are named in `unsearchedSources`, so the answer says it may be incomplete instead of silently dropping them.
 */
export class CompositeKnowledgePort implements KnowledgePort {
  constructor(private readonly parts: readonly { readonly name: string; readonly port: KnowledgePort }[]) {}

  async retrieve(q: KnowledgeQuery): Promise<KnowledgeResult> {
    const settled = await Promise.all(
      this.parts.map(async (p) => {
        try {
          return { name: p.name, result: await p.port.retrieve(q) };
        } catch {
          return { name: p.name, result: { status: 'unavailable', reason: 'error' } as KnowledgeResult };
        }
      }),
    );
    const ok = settled.filter((s) => s.result.status === 'ok');
    if (ok.length === 0) {
      const reasons = settled.map((s) => (s.result.status === 'unavailable' ? s.result.reason : 'error'));
      return { status: 'unavailable', reason: reasons.includes('error') ? 'error' : 'not_configured' };
    }
    const evidence: Evidence[] = ok
      .flatMap((s) => (s.result.status === 'ok' ? s.result.evidence : []))
      .map((e, order) => ({ e, order }))
      .sort((a, b) => (b.e.score ?? 0) - (a.e.score ?? 0) || a.order - b.order)
      .slice(0, q.limit)
      .map((x) => x.e);
    const methods = new Set(ok.map((s) => (s.result.status === 'ok' ? s.result.method : undefined)));
    const failed = settled
      .filter((s) => s.result.status !== 'ok' && !(s.result.status === 'unavailable' && s.result.reason === 'not_configured'))
      .map((s) => s.name);
    return {
      status: 'ok',
      evidence,
      ...(methods.size === 1 && !methods.has(undefined) ? { method: [...methods][0] as 'lexical' | 'semantic' | 'hybrid' } : {}),
      ...(failed.length > 0 ? { unsearchedSources: failed } : {}),
    };
  }

  async describe(principal: Principal): Promise<KnowledgeCatalog> {
    const catalogs = await Promise.all(
      this.parts.map((p) => p.port.describe?.(principal).catch(() => undefined) ?? Promise.resolve(undefined)),
    );
    const present = catalogs.filter((c): c is KnowledgeCatalog => c !== undefined);
    const methods = [...new Set(present.map((c) => c.searchMethod).filter((m): m is string => m !== undefined))];
    return { sources: present.flatMap((c) => c.sources), ...(methods.length > 0 ? { searchMethod: methods.join(' / ') } : {}) };
  }
}
