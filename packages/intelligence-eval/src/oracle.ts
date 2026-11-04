import { err, ok, type Result } from '@xo/types';
import type { AiError } from '@xo/errors';
import type { ConversationRequest, ConversationResponse, ConversationResponseMeta, StructuredConversationRequest } from '@xo/ai-core';
import type { ConversationModel } from '@xo/intelligence';
import { CORPUS } from './corpus.js';
import type { CorpusDoc, EvalItem } from './types.js';

const META: ConversationResponseMeta = {
  task: 'conversation.answer',
  providerUsed: 'oracle',
  modelUsed: 'oracle',
  usage: { inputTokens: 0, outputTokens: 0 },
  costUsd: 0,
  latencyMs: 0,
  attempts: 1,
  candidatesTried: 1,
  finishReason: 'stop',
};

const unescape = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
const tidy = (s: string): string =>
  s
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:])/g, '$1')
    .trim();

/**
 * A deterministic REFERENCE model: it answers each item from that item's gold labels, so it plays an ideal model.
 *
 * What that buys: it can only cite what retrieval actually put in front of it, so a retrieval miss, an authorization
 * leak, a broken guard rail or a regression in prompt assembly shows up as a failed check. What it cannot tell you:
 * how well any real model routes, reads, writes or calibrates. Model-quality numbers come only from a live run.
 */
export class OracleModel implements ConversationModel {
  private readonly byMessage = new Map<string, EvalItem>();

  constructor(
    items: readonly EvalItem[],
    private readonly corpus: readonly CorpusDoc[] = CORPUS,
  ) {
    for (const i of items) this.byMessage.set(i.message, i);
  }

  private find(request: ConversationRequest): EvalItem | undefined {
    const last = request.messages[request.messages.length - 1]?.content ?? '';
    const m = /(?:\n\n)(?:Question|Request): ([\s\S]*)$/.exec(last);
    return this.byMessage.get((m ? (m[1] as string) : last).trim());
  }

  /** alias ("E1") by document id, read back from the evidence blocks the orchestrator actually rendered. */
  private aliases(request: ConversationRequest): Map<string, string> {
    const text = request.messages[request.messages.length - 1]?.content ?? '';
    const out = new Map<string, string>();
    for (const m of text.matchAll(/<xo-evidence id="(E\d+)"[^>]*>\n([\s\S]*?)\n<\/xo-evidence>/g)) {
      const body = unescape(m[2] as string).trim();
      const doc = this.corpus.find((d) => d.text.trim() === body);
      if (doc) out.set(doc.id, m[1] as string);
    }
    return out;
  }

  private fill(template: string, aliases: Map<string, string>): { text: string; present: number; referenced: number } {
    let present = 0;
    let referenced = 0;
    const text = template.replace(/\{\{(d\d+)\}\}/g, (_m, id: string) => {
      referenced += 1;
      const a = aliases.get(id);
      if (a === undefined) return '';
      present += 1;
      return `[${a}]`;
    });
    return { text: tidy(text), present, referenced };
  }

  async converse(_request: ConversationRequest): Promise<Result<ConversationResponse<string>, AiError>> {
    return ok({
      output:
        "Hi! I can answer questions from your organization's knowledge with sources, help you weigh decisions, propose approved actions, and take corrections.",
      meta: META,
    });
  }

  async converseStructured<T>(request: StructuredConversationRequest): Promise<Result<ConversationResponse<T>, AiError>> {
    const keys = Object.keys((request.responseSchema as { properties?: Record<string, unknown> }).properties ?? {});
    const item = this.find(request);
    const out = this.answer(keys, request, item);
    return out === undefined
      ? err(new Error('oracle: no matching item') as AiError)
      : ok({ output: out as T, meta: { ...META, task: request.task } });
  }

  private answer(keys: string[], request: ConversationRequest, item: EvalItem | undefined): unknown {
    if (item === undefined) return undefined;
    const o = item.oracle ?? {};
    if (keys.includes('route')) {
      const clarify = item.expect.route === 'clarify';
      return {
        route: clarify ? 'ask' : item.expect.route,
        confidence: 0.95,
        reasoning: 'oracle',
        standaloneQuery: o.query ?? item.message,
        needsClarification: clarify,
        clarifyingQuestion: clarify ? (o.clarify ?? 'Which one do you mean?') : '',
      };
    }
    const aliases = this.aliases(request);
    if (keys.includes('answerable')) {
      const filled = this.fill(o.answer ?? '', aliases);
      const answerable = o.answer !== undefined && filled.present > 0;
      return {
        answerable,
        answer: answerable ? filled.text : "The sources I was given don't answer this.",
        confidence: answerable ? (o.confidence ?? 'high') : 'low',
        confidenceReason: 'oracle',
        contradictions: (o.contradictions ?? []).map((c) => ({
          summary: c.summary,
          evidenceIds: c.docs.flatMap((d) => (aliases.has(d) ? [aliases.get(d) as string] : [])),
        })),
        gaps: answerable ? [] : (o.gaps ?? ['Not stated in the sources']),
        followUps: [],
      };
    }
    if (keys.includes('recommendedOption')) {
      const d = o.decide;
      const ids = (docs: readonly string[]) => docs.flatMap((x) => (aliases.has(x) ? [aliases.get(x) as string] : []));
      const options = (d?.options ?? []).map((op) => ({
        title: op.title,
        description: op.description,
        pros: [],
        cons: [],
        consequences: [],
        dependencies: [],
        evidenceIds: ids(op.docs),
      }));
      const grounded = options.some((op) => op.evidenceIds.length > 0) || (d !== undefined && this.fill(d.summary, aliases).present > 0);
      return {
        summary: d ? this.fill(d.summary, aliases).text : 'Not covered by the sources.',
        problems: [],
        options,
        recommendedOption: d && grounded ? d.recommended : '',
        recommendationRationale: d && grounded ? this.fill(d.rationale, aliases).text : '',
        risks: d?.risks ?? [],
        assumptions: [],
        confidence: grounded ? 'medium' : 'low',
        confidenceReason: 'oracle',
        contradictions: [],
        gaps: [],
      };
    }
    if (keys.includes('capability')) {
      const text = request.messages[request.messages.length - 1]?.content ?? '';
      let alias = 'none';
      for (const m of text.matchAll(/<xo-capability id="(C\d+)" name="([^"]*)">/g))
        if (unescape(m[2] as string) === o.capabilityName) alias = m[1] as string;
      return { capability: alias, inputs: o.inputs ?? [], rationale: 'It fits the request.', question: o.question ?? '' };
    }
    if (keys.includes('kind')) return { kind: o.learnKind ?? 'feedback', statement: o.statement ?? item.message };
    return undefined;
  }
}

/** Records everything sent to the model for one turn, so leaks can be checked in the prompts, not only the answer. */
export class RecordingModel implements ConversationModel {
  readonly sent: string[] = [];
  calls = 0;
  constructor(private readonly inner: ConversationModel) {}
  converse(request: ConversationRequest) {
    this.calls += 1;
    this.sent.push(request.messages.map((m) => m.content).join('\n'));
    return this.inner.converse(request);
  }
  converseStructured<T>(request: StructuredConversationRequest) {
    this.calls += 1;
    this.sent.push(request.messages.map((m) => m.content).join('\n'));
    return this.inner.converseStructured<T>(request);
  }
}
