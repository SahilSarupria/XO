import { PackageInstaller } from '@xo/package-sdk';
import type { Evidence, KnowledgeCatalog, KnowledgePort, KnowledgeQuery, KnowledgeResult, Principal } from '@xo/intelligence';
import { keywords } from './keyword.js';
import type { BlobStore } from '@xo/storage';

/**
 * INTERIM knowledge source: what is installed in this workspace.
 *
 * Until the C6 Knowledge SDK is connected (`intelligenceKnowledge` in server deps), the customer chat answers from the
 * knowledge graphs and declared capabilities of the XOs installed in the workspace. This is deliberately naive —
 * word overlap over node text, no embeddings, no cross-source reconciliation — and it is NOT the organizational
 * knowledge layer: it knows nothing about Microsoft 365, SharePoint, CRMs or any connected enterprise source.
 *
 * Authorization: every workspace member with `read` can already read installed XOs, so the adapter applies no further
 * per-user filter. C6 is where per-user authorization of organizational data belongs.
 */
const MAX_NODES_PER_PACKAGE = 5000;
const MAX_EXCERPT_CHARS = 1200;
const TITLE_KEYS = ['label', 'name', 'title', 'term', 'id'] as const;

const tokens = keywords;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A graph node as readable text: its title, then its other string/number fields (and short string lists). */
function describeNode(node: Record<string, unknown>): { title: string; text: string } | undefined {
  const titleKey = TITLE_KEYS.find((k) => typeof node[k] === 'string' && (node[k] as string).trim().length > 0);
  if (titleKey === undefined) return undefined;
  const title = (node[titleKey] as string).trim();
  const parts: string[] = [];
  for (const [k, v] of Object.entries(node)) {
    if (k === titleKey || k === 'id') continue;
    if (typeof v === 'string' && v.trim().length > 0) parts.push(`${k}: ${v.trim()}`);
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}: ${String(v)}`);
    else if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string'))
      parts.push(`${k}: ${(v as string[]).slice(0, 10).join('; ')}`);
  }
  return { title, text: `${title}${parts.length > 0 ? ` — ${parts.join('. ')}` : ''}`.slice(0, MAX_EXCERPT_CHARS) };
}

export class InstalledXoKnowledgePort implements KnowledgePort {
  constructor(private readonly packages: BlobStore) {}

  async retrieve(query: KnowledgeQuery): Promise<KnowledgeResult> {
    try {
      const installer = new PackageInstaller(this.packages);
      const installed = await installer.listInstalled();
      const scope = query.scope !== undefined && query.scope.length > 0 ? new Set(query.scope) : undefined;
      const wanted = new Set(tokens(query.query));
      const scored: { evidence: Evidence; score: number }[] = [];

      for (const record of installed) {
        if (scope !== undefined && !scope.has(record.name)) continue;
        const asOf = record.installedAt;
        const consider = (id: string, text: string, sourceType: string): void => {
          if (wanted.size === 0) return;
          const hay = new Set(tokens(text));
          let hits = 0;
          for (const w of wanted) if (hay.has(w)) hits += 1;
          if (hits === 0) return;
          const score = hits / wanted.size;
          scored.push({
            score,
            evidence: {
              id: `${record.name}@${record.version}#${id}`,
              sourceId: `${record.name}@${record.version}`,
              sourceName: record.name,
              sourceType,
              excerpt: text,
              asOf,
              score,
            },
          });
        };

        const manifest = await installer.getManifest(record.name, record.version);
        if (manifest.ok) {
          for (const c of manifest.value.capabilities ?? [])
            consider(`capability:${c.id}`, `Capability "${c.name}": ${c.description}`.slice(0, MAX_EXCERPT_CHARS), 'xo-capability');
        }

        const graph = await installer.getComponent(record.name, record.version, 'knowledge_graph');
        if (!graph.ok) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(graph.value));
        } catch {
          continue; // one unparseable graph must not fail the others
        }
        if (!isRecord(parsed) || !Array.isArray(parsed['nodes'])) continue;
        for (const node of (parsed['nodes'] as unknown[]).slice(0, MAX_NODES_PER_PACKAGE)) {
          if (!isRecord(node)) continue;
          const d = describeNode(node);
          if (d === undefined) continue;
          consider(`node:${typeof node['id'] === 'string' ? node['id'] : d.title}`, d.text, 'xo-knowledge');
        }
      }

      scored.sort((a, b) => b.score - a.score);
      return { status: 'ok', method: 'lexical', evidence: scored.slice(0, query.limit).map((s) => s.evidence) };
    } catch {
      return { status: 'unavailable', reason: 'error' };
    }
  }

  async describe(_principal: Principal): Promise<KnowledgeCatalog> {
    const installed = await new PackageInstaller(this.packages).listInstalled();
    return {
      sources: installed.map((i) => ({ name: i.name, kind: 'installed XO', detail: `version ${i.version}` })),
      searchMethod: 'keyword matching',
    };
  }
}
