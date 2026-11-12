import { IntelligenceOrchestrator, MemoryLearningPort, type ConversationModel, type Evidence, type KnowledgePort } from '@xo/intelligence';
import { PERSONAS } from './corpus.js';
import { PersonaCapabilityPort, CorpusKnowledgePort } from './fixtures.js';
import { gradeItem } from './graders.js';
import { RecordingModel } from './oracle.js';
import type { Category, EvalItem, ItemResult } from './types.js';

/** Wraps any knowledge source (the fixture, or a real C6 adapter) and records which documents it returned. */
export class RecordingKnowledge implements KnowledgePort {
  retrieved: string[] = [];
  constructor(
    private readonly inner: KnowledgePort,
    /** Maps returned evidence to the corpus document id it came from (identity for the fixture). */
    private readonly docIdOf: (e: Evidence) => string = (e) => e.id,
  ) {}
  async retrieve(q: Parameters<KnowledgePort['retrieve']>[0]) {
    const r = await this.inner.retrieve(q);
    this.retrieved = r.status === 'ok' ? r.evidence.map(this.docIdOf) : [];
    return r;
  }
}

export interface RunOptions {
  readonly model: ConversationModel;
  /** Builds a fresh knowledge source per item (so retrieval records never mix). Default: the authorization-aware fixture. */
  readonly knowledge?: () => KnowledgePort;
  readonly docIdOf?: (e: Evidence) => string;
  readonly items: readonly EvalItem[];
  readonly categories?: readonly Category[];
  readonly concurrency?: number;
  readonly modelCandidates?: readonly { providerId: string; model: string }[];
  readonly onProgress?: (done: number, total: number, last: ItemResult) => void;
}

async function runOne(item: EvalItem, opts: RunOptions): Promise<ItemResult> {
  const persona = PERSONAS[item.persona];
  const recording = new RecordingKnowledge(opts.knowledge?.() ?? new CorpusKnowledgePort(), opts.docIdOf);
  const model = new RecordingModel(opts.model);
  const learning = new MemoryLearningPort();
  const orchestrator = new IntelligenceOrchestrator({ model, knowledge: recording, capabilities: new PersonaCapabilityPort(), learning });
  const started = performance.now();
  let result;
  let error: string | undefined;
  try {
    const r = await orchestrator.handle({
      principal: { identityId: persona.id, workspaceId: 'ws_eval', role: persona.role },
      message: item.message,
      ...(item.history ? { history: item.history } : {}),
      ...(opts.modelCandidates ? { modelCandidates: opts.modelCandidates } : {}),
      traceId: item.id,
    });
    if (r.ok) result = r.value;
    else error = r.error.message;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const latencyMs = Math.round(performance.now() - started);
  const checks = gradeItem(item, {
    result,
    ...(error !== undefined ? { error } : {}),
    retrieved: recording.retrieved,
    prompts: model.sent.join('\n'),
    modelCalls: model.calls,
    learningEvents: learning.events,
  });

  const gold = item.expect.goldDocs ?? [];
  const cited = result?.citations.map((c) => c.evidenceId) ?? [];
  return {
    id: item.id,
    category: item.category,
    pass: checks.every((c) => c.pass),
    knownLimit: item.knownLimit !== undefined,
    checks,
    ...(result ? { route: result.route, confidence: result.confidence } : {}),
    modelCalls: model.calls,
    costUsd: result?.usage.totalCostUsd ?? 0,
    latencyMs,
    ...(gold.length > 0
      ? { retrieval: { goldDocs: gold.length, retrieved: gold.filter((d) => recording.retrieved.includes(d)).length } }
      : {}),
    ...(gold.length > 0
      ? {
          citations: {
            goldDocs: gold.length,
            cited: gold.filter((d) => cited.includes(d)).length,
            total: cited.length,
            unsupported: cited.filter((d) => !gold.includes(d)).length,
          },
        }
      : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

export async function runEval(opts: RunOptions): Promise<ItemResult[]> {
  const items = opts.items.filter((i) => opts.categories === undefined || opts.categories.includes(i.category));
  const results: ItemResult[] = new Array(items.length);
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const r = await runOne(items[i] as EvalItem, opts);
      results[i] = r;
      opts.onProgress?.(++done, items.length, r);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 1) }, worker));
  return results;
}
