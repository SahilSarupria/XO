import type {
  CapabilityDescriptor,
  CapabilityPort,
  Evidence,
  KnowledgePort,
  KnowledgeQuery,
  KnowledgeResult,
  Principal,
} from '@xo/intelligence';
import { CORPUS, PERSONAS, STOPWORDS } from './corpus.js';
import type { CorpusDoc, PersonaId } from './types.js';

const tokens = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
    .filter((t) => !STOPWORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));

/**
 * An authorization-aware KEYWORD source over the eval corpus. It stands in for C6 so the harness can run without one.
 * It is a test double: it matches words, not meaning, and says so (`method: 'lexical'`). Run the same dataset against a
 * real C6 adapter to measure C6.
 */
export class CorpusKnowledgePort implements KnowledgePort {
  /** Doc ids returned by the most recent retrieval (what the orchestrator was actually handed). */
  lastRetrieved: string[] = [];

  constructor(
    private readonly corpus: readonly CorpusDoc[] = CORPUS,
    /** `false` builds the deliberately broken variant used to prove the security checks can fail. */
    private readonly enforceAcl = true,
  ) {}

  protected visibleTo(principal: Principal): readonly CorpusDoc[] {
    if (!this.enforceAcl) return this.corpus;
    const groups = PERSONAS[principal.identityId as PersonaId]?.groups ?? [];
    return this.corpus.filter((d) => d.acl.includes('*') || d.acl.some((g) => groups.includes(g)));
  }

  async retrieve(query: KnowledgeQuery): Promise<KnowledgeResult> {
    const wanted = new Set(tokens(query.query));
    const scored: { doc: CorpusDoc; score: number }[] = [];
    for (const doc of this.visibleTo(query.principal)) {
      const hay = new Set(tokens(`${doc.name} ${doc.text}`));
      let hits = 0;
      for (const w of wanted) if (hay.has(w)) hits += 1;
      if (hits > 0) scored.push({ doc, score: hits / wanted.size });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, query.limit);
    this.lastRetrieved = top.map((s) => s.doc.id);
    const evidence: Evidence[] = top.map(({ doc, score }) => ({
      id: doc.id,
      sourceId: doc.id,
      sourceName: doc.name,
      sourceType: doc.type,
      excerpt: doc.text,
      asOf: doc.asOf,
      score,
    }));
    return { status: 'ok', method: 'lexical', evidence };
  }
}

/** Ignores the ACL. If the security checks pass against THIS, they check nothing. */
export class LeakyKnowledgePort extends CorpusKnowledgePort {
  constructor(corpus: readonly CorpusDoc[] = CORPUS) {
    super(corpus, false);
  }
}

const CREATE_TASK: CapabilityDescriptor = {
  id: 'cap.create_task',
  name: 'Create task',
  description: 'Creates a task and assigns it to a person.',
  inputs: [
    { name: 'title', type: 'string', required: true },
    { name: 'assignee', type: 'string', required: true },
    { name: 'due', type: 'string', required: false },
  ],
};
const SCHEDULE_REVIEW: CapabilityDescriptor = {
  id: 'cap.schedule_review',
  name: 'Schedule review',
  description: 'Schedules a review meeting about a topic on a date.',
  inputs: [
    { name: 'topic', type: 'string', required: true },
    { name: 'date', type: 'string', required: true },
  ],
};

/** Only ops managers and executives may use actions; analysts and finance get none. */
export class PersonaCapabilityPort implements CapabilityPort {
  async listAuthorized(principal: Principal): Promise<readonly CapabilityDescriptor[]> {
    return principal.identityId === 'ops_manager' || principal.identityId === 'exec' ? [CREATE_TASK, SCHEDULE_REVIEW] : [];
  }
}
