import type { BlobStore } from '@xo/storage';
import type { Evidence, KnowledgeCatalog, KnowledgePort, KnowledgeQuery, KnowledgeResult, Principal } from '@xo/intelligence';
import { FsCompilationStore } from '../compilations/fs-compilation-store.js';
import type { CapabilityProjection, CompilationRecord } from '../compilations/compilation.js';
import { FsSourceStore } from '../sources/fs-source-store.js';
import type { SourceRecord } from '../sources/source.js';
import { keywords, overlap } from './keyword.js';

/**
 * INTERIM knowledge source: the files uploaded to this workspace and what Studio compiled from them.
 *
 * It lets the chat answer questions like "what can I automate with aastha.pdf?" from the capabilities and knowledge the
 * compiler extracted, with page provenance. Like `InstalledXoKnowledgePort` it is keyword matching only — not semantic
 * search and not the C6 organizational knowledge layer — and says so (`method: 'lexical'`). A file that was uploaded but
 * never compiled is reported as exactly that, so the chat can tell the user to compile it instead of claiming it has
 * nothing. Sources are workspace-level, as they are in Studio's own Sources screen, so no per-user filter applies here.
 */
const MAX_NODES_PER_COMPILATION = 400;
const MAX_EXCERPT = 1000;
const TITLE_KEYS = ['name', 'label', 'title', 'statement', 'term'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function runnable(c: CapabilityProjection): string {
  if (c.status === 'resolved') return `can be run${c.executionClass ? ` (${c.executionClass})` : ''}`;
  return `found but not runnable yet (${c.status}${c.reason ? `: ${c.reason}` : ''})`;
}

function pages(c: { provenance?: readonly { pages?: readonly number[] }[] }): string {
  const p = [...new Set((c.provenance ?? []).flatMap((x) => x.pages ?? []))].sort((a, b) => a - b);
  return p.length === 0 ? '' : ` Found on page${p.length > 1 ? 's' : ''} ${p.join(', ')}.`;
}

interface Item {
  readonly evidence: Evidence;
}

export class WorkspaceSourcesKnowledgePort implements KnowledgePort {
  constructor(
    private readonly sources: BlobStore,
    private readonly compilations: BlobStore,
  ) {}

  /** Every searchable item in the workspace right now (small scale by design: a workspace's uploaded files). */
  private async items(): Promise<{ items: Item[]; catalog: KnowledgeCatalog['sources'][number][] }> {
    const sourceStore = new FsSourceStore(this.sources);
    const compStore = new FsCompilationStore(this.compilations);
    const [sources, comps] = await Promise.all([sourceStore.list(), compStore.list()]);
    if (!sources.ok) throw sources.error;
    const records: readonly CompilationRecord[] = comps.ok ? comps.value : [];
    const items: Item[] = [];
    const catalog: KnowledgeCatalog['sources'][number][] = [];

    for (const src of sources.value as readonly SourceRecord[]) {
      const latest = records.filter((c) => c.sourceId === src.sourceId && c.status === 'succeeded').at(-1);
      const caps = latest ? await compStore.getCapabilities(latest.compilationId) : undefined;
      const capList: readonly CapabilityProjection[] = caps?.ok ? caps.value : [];
      const ready = capList.filter((c) => c.status === 'resolved');
      const base = { sourceId: src.sourceId, sourceName: src.originalFilename };

      const overview =
        latest === undefined
          ? `Uploaded file "${src.originalFilename}" (${src.extension.replace('.', '')}, ${src.byteSize} bytes). It has not been compiled yet, so its contents are not searchable and no capabilities or workflows have been extracted from it.`
          : `Uploaded file "${src.originalFilename}" (${src.extension.replace('.', '')}). Compiled: ${capList.length} capabilit${capList.length === 1 ? 'y' : 'ies'} found, ${ready.length} that can be run${
              capList.length > 0
                ? `. Capabilities: ${capList
                    .slice(0, 12)
                    .map((c) => c.name)
                    .join('; ')}`
                : ''
            }.`;
      items.push({
        evidence: {
          ...base,
          id: `src:${src.sourceId}`,
          sourceType: 'uploaded-file',
          excerpt: overview.slice(0, MAX_EXCERPT),
          asOf: latest?.completedAt ?? src.createdAt,
        },
      });
      catalog.push({
        name: src.originalFilename,
        kind: 'uploaded file',
        detail:
          latest === undefined
            ? 'not compiled yet — contents not searchable'
            : `compiled: ${capList.length} capabilities (${ready.length} runnable)`,
      });

      for (const c of capList) {
        items.push({
          evidence: {
            ...base,
            id: `cmp:${latest?.compilationId}#cap:${c.capabilityId}`,
            sourceType: 'compiled-capability',
            excerpt: `Capability "${c.name}" from ${src.originalFilename}: ${c.description} It ${runnable(c)}.${pages(c)}`.slice(
              0,
              MAX_EXCERPT,
            ),
            asOf: latest?.completedAt ?? src.createdAt,
          },
        });
      }

      if (latest !== undefined) {
        const graph = await compStore.getCompiledGraph(latest.compilationId);
        const nodes = graph.ok && isRecord(graph.value) && Array.isArray(graph.value['nodes']) ? (graph.value['nodes'] as unknown[]) : [];
        for (const n of nodes.slice(0, MAX_NODES_PER_COMPILATION)) {
          if (!isRecord(n) || n['kind'] === 'capability' || !isRecord(n['properties'])) continue;
          const props = n['properties'];
          const titleKey = TITLE_KEYS.find((k) => typeof props[k] === 'string' && (props[k] as string).trim() !== '');
          if (titleKey === undefined) continue;
          const rest = Object.entries(props)
            .filter(([k, v]) => k !== titleKey && typeof v === 'string' && v.trim() !== '')
            .map(([k, v]) => `${k}: ${(v as string).trim()}`);
          const meta = isRecord(n['metadata']) ? n['metadata'] : {};
          const refs = Array.isArray(meta['sourceRefs']) ? (meta['sourceRefs'] as { pages?: readonly number[] }[]) : [];
          items.push({
            evidence: {
              ...base,
              id: `cmp:${latest.compilationId}#node:${typeof n['id'] === 'string' ? n['id'] : (props[titleKey] as string)}`,
              sourceType: `compiled-${String(n['kind'])}`,
              excerpt:
                `${(props[titleKey] as string).trim()}${rest.length ? ` — ${rest.join('. ')}` : ''} (from ${src.originalFilename}.${pages({ provenance: refs }).trim()})`.slice(
                  0,
                  MAX_EXCERPT,
                ),
              asOf: latest.completedAt ?? src.createdAt,
            },
          });
        }
      }
    }
    return { items, catalog };
  }

  async retrieve(q: KnowledgeQuery): Promise<KnowledgeResult> {
    try {
      const wanted = new Set(keywords(q.query));
      const scope = q.scope !== undefined && q.scope.length > 0 ? new Set(q.scope) : undefined;
      const { items } = await this.items();
      const scored = items
        .filter((i) => scope === undefined || scope.has(i.evidence.sourceName))
        .map((i) => ({ evidence: i.evidence, score: overlap(wanted, `${i.evidence.sourceName} ${i.evidence.excerpt}`) }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, q.limit);
      return { status: 'ok', method: 'lexical', evidence: scored.map((s) => ({ ...s.evidence, score: s.score })) };
    } catch {
      return { status: 'unavailable', reason: 'error' };
    }
  }

  async describe(_principal: Principal): Promise<KnowledgeCatalog> {
    const { catalog } = await this.items();
    return { sources: catalog, searchMethod: 'keyword matching' };
  }
}
