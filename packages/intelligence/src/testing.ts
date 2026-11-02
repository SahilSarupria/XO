import type {
  CapabilityDescriptor,
  CapabilityPort,
  KnowledgePort,
  KnowledgeQuery,
  KnowledgeResult,
  LearningEvent,
  LearningPort,
  LearningRecord,
} from './ports.js';
import type { Evidence, Principal } from './types.js';

/**
 * In-memory implementations of the three ports, for tests and local demos.
 *
 * `StaticKnowledgePort` is a TEST DOUBLE, not a retrieval system: it matches words in a fixed list. Real retrieval is
 * the C6 Knowledge SDK's job and enters through `KnowledgePort`; do not grow this into a second knowledge engine.
 */
export class StaticKnowledgePort implements KnowledgePort {
  readonly queries: KnowledgeQuery[] = [];

  constructor(
    private readonly evidence: readonly Evidence[],
    /** Stand-in for C6's authorization: which evidence a principal may see. Default: all of it. */
    private readonly authorize: (principal: Principal, evidence: Evidence) => boolean = () => true,
  ) {}

  async retrieve(query: KnowledgeQuery): Promise<KnowledgeResult> {
    this.queries.push(query);
    const words = new Set(query.query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
    const scored = this.evidence
      .filter((e) => this.authorize(query.principal, e))
      .map((e) => {
        const hay = new Set(`${e.sourceName} ${e.excerpt}`.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
        let hits = 0;
        for (const w of words) if (hay.has(w)) hits += 1;
        return { e, score: words.size === 0 ? 0 : hits / words.size };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, query.limit);
    return { status: 'ok', evidence: scored.map((x) => ({ ...x.e, score: x.score })) };
  }
}

export class StaticCapabilityPort implements CapabilityPort {
  constructor(
    private readonly capabilities: readonly CapabilityDescriptor[] | ((principal: Principal) => readonly CapabilityDescriptor[]),
  ) {}
  async listAuthorized(principal: Principal): Promise<readonly CapabilityDescriptor[]> {
    return typeof this.capabilities === 'function' ? this.capabilities(principal) : this.capabilities;
  }
}

export class MemoryLearningPort implements LearningPort {
  readonly events: LearningEvent[] = [];
  async record(event: LearningEvent): Promise<LearningRecord> {
    this.events.push(event);
    return { eventId: `lrn_${this.events.length}`, reviewRequired: true };
  }
}
