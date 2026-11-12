import { err, ok, type Result } from '@xo/types';
import type { AiError } from '@xo/errors';
import { noopLogger, type Logger } from '@xo/logger';
import type { ConversationLayer, ConversationResponseMeta, ConversationTaskId, JsonSchema, ProviderMessage } from '@xo/ai-core';
import type { CapabilityDescriptor, CapabilityPort, KnowledgePort, LearningPort } from './ports.js';
import {
  CitationRegistry,
  DEFAULT_EVIDENCE_LIMITS,
  escapeForPrompt,
  prepareEvidence,
  renderEvidence,
  stripCitationMarkers,
  type EvidenceLimits,
  type PreparedEvidence,
} from './evidence.js';
import { ASK_PROMPT, CONVERSE_PROMPT, DECIDE_PROMPT, LEARN_PROMPT, PROMPT_VERSION, PROPOSE_PROMPT, ROUTER_PROMPT } from './prompts.js';
import {
  ASK_SCHEMA,
  DECIDE_SCHEMA,
  LEARN_SCHEMA,
  PROPOSE_SCHEMA,
  ROUTE_SCHEMA,
  type AskOutput,
  type DecideOutput,
  type LearnOutput,
  type ProposeOutput,
  type RawConflict,
  type RouteOutput,
} from './schemas.js';
import type {
  ActionProposal,
  AskPayload,
  Confidence,
  Contradiction,
  DecidePayload,
  HistoryTurn,
  InputValue,
  LearningOutcome,
  ModelCallRecord,
  Notice,
  Route,
  TurnInput,
  TurnResult,
} from './types.js';

export { PROMPT_VERSION };

/** The slice of `ConversationLayer` the orchestrator needs — a seam, so tests (and other model stacks) can stand in. */
export type ConversationModel = Pick<ConversationLayer, 'converse' | 'converseStructured'>;

export interface OrchestratorLimits {
  readonly retrievalLimit: number;
  readonly retrievalTimeoutMs: number;
  readonly historyTurns: number;
  readonly historyTurnChars: number;
  readonly messageChars: number;
  readonly evidence: EvidenceLimits;
}

const DEFAULT_LIMITS: OrchestratorLimits = {
  retrievalLimit: 12,
  retrievalTimeoutMs: 15_000,
  historyTurns: 10,
  historyTurnChars: 2000,
  messageChars: 8000,
  evidence: DEFAULT_EVIDENCE_LIMITS,
};

export interface OrchestratorOptions {
  readonly model: ConversationModel;
  readonly knowledge: KnowledgePort;
  /** Omit and DO is reported as unavailable. */
  readonly capabilities?: CapabilityPort;
  /** Omit and LEARN is reported as unavailable. */
  readonly learning?: LearningPort;
  readonly logger?: Logger;
  readonly limits?: Partial<OrchestratorLimits>;
}

/** Below this, a DO or LEARN reading of the message is not trusted: the turn is handled as a read-only ASK instead. */
const SIDE_EFFECT_ROUTE_MIN_CONFIDENCE = 0.6;
const MAX_CAPABILITIES_SHOWN = 30;

interface Ctx {
  readonly input: TurnInput;
  readonly message: string;
  readonly history: readonly HistoryTurn[];
  readonly traceId: string;
  readonly calls: ModelCallRecord[];
  readonly notices: Notice[];
}

interface Routing {
  readonly confidence: number;
  readonly reasoning: string;
  readonly standaloneQuery: string;
}

type Retrieved =
  | { status: 'ok'; prepared: PreparedEvidence[]; method?: 'lexical' | 'semantic' | 'hybrid'; unsearched: readonly string[] }
  | { status: 'unavailable'; reason: 'not_configured' | 'error' | 'denied' };

type Body = Omit<TurnResult, 'routing' | 'usage' | 'notices'>;

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const clean = (items: readonly string[], max: number): string[] =>
  items
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, max);
const confidenceRank: Record<Confidence, number> = { none: 0, low: 1, medium: 2, high: 3 };
const capConfidence = (c: Confidence, max: Confidence): Confidence => (confidenceRank[c] > confidenceRank[max] ? max : c);

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The XO Intelligence Orchestrator.
 *
 * One entry point, `handle`, for a customer's message. There are no modes: the orchestrator reads the message and
 * decides whether it is an ASK, a DECIDE, a DO or a LEARN, then handles it.
 *
 *   ASK     retrieve authorized evidence -> answer with verified citations, contradictions and gaps stated
 *   DECIDE  retrieve authorized evidence -> options, consequences, risks, a recommendation that is advice only
 *   DO      list the capabilities this principal may use -> propose one with validated inputs; never run it
 *   LEARN   file the correction / outcome / feedback for authorized review; never edit knowledge directly
 *
 * Guard rails that do not depend on the model behaving:
 *  - No evidence, no organizational answer. If the knowledge port has nothing (or is down), the model is not asked.
 *  - Citations are verified against what was retrieved; invented ones are removed, and an answer that claims to be
 *    answerable but cites nothing is downgraded and flagged.
 *  - A recommendation that cites no evidence is dropped. Conflicting sources cap confidence at "medium".
 *  - DO and LEARN need a confident reading of the message; otherwise the turn is treated as a read-only ASK.
 *  - DO can only propose capabilities the port listed for this principal, with inputs the capability declares.
 */
export class IntelligenceOrchestrator {
  private readonly limits: OrchestratorLimits;
  private readonly logger: Logger;

  constructor(private readonly options: OrchestratorOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.logger = options.logger ?? noopLogger;
  }

  async handle(input: TurnInput): Promise<Result<TurnResult, AiError>> {
    const ctx: Ctx = {
      input,
      message: input.message.trim().slice(0, this.limits.messageChars),
      history: this.trimHistory(input.history ?? []),
      traceId: input.traceId ?? 'turn',
      calls: [],
      notices: [],
    };

    const routed = await this.structured<RouteOutput>(ctx, 'conversation.route', ROUTE_SCHEMA, ROUTER_PROMPT, ctx.message, 400);
    if (!routed.ok) return err(routed.error);
    const r = routed.value;

    const routing: Routing = {
      confidence: clamp01(r.confidence),
      reasoning: r.reasoning.trim().slice(0, 300),
      standaloneQuery: (r.standaloneQuery.trim() || ctx.message).slice(0, 1000),
    };

    if (r.needsClarification && r.clarifyingQuestion.trim().length > 0) {
      const question = r.clarifyingQuestion.trim().slice(0, 400);
      return ok(
        this.done(ctx, routing, {
          route: 'clarify',
          text: question,
          confidence: 'none',
          grounded: false,
          citations: [],
          clarifyingQuestion: question,
          evidenceConsidered: 0,
        }),
      );
    }

    let route: Route = r.route;
    if ((route === 'do' || route === 'learn') && routing.confidence < SIDE_EFFECT_ROUTE_MIN_CONFIDENCE) {
      ctx.notices.push({
        code: 'routing_low_confidence',
        message: `I wasn't sure this was a request to ${route === 'do' ? 'take an action' : 'record feedback'}, so I treated it as a question instead.`,
      });
      route = 'ask';
    }

    switch (route) {
      case 'ask':
        return this.ask(ctx, routing);
      case 'decide':
        return this.decide(ctx, routing);
      case 'do':
        return this.act(ctx, routing);
      case 'learn':
        return this.learn(ctx, routing);
      case 'converse':
        return this.converse(ctx, routing);
    }
  }

  // ----------------------------------------------------------------------------------------------------- plumbing

  private trimHistory(history: readonly HistoryTurn[]): HistoryTurn[] {
    const recent = history
      .slice(-this.limits.historyTurns)
      .map((h) => ({ ...h, content: h.content.slice(0, this.limits.historyTurnChars) }));
    while (recent[0]?.role === 'assistant') recent.shift(); // providers expect a conversation to open with the user
    return recent;
  }

  private build(system: string, ctx: Ctx, finalUser: string): ProviderMessage[] {
    return [
      { role: 'system', content: system },
      ...ctx.history.map((h): ProviderMessage => ({
        role: h.role,
        content: h.role === 'assistant' ? stripCitationMarkers(h.content) : h.content,
      })),
      { role: 'user', content: finalUser },
    ];
  }

  private candidates(ctx: Ctx) {
    return ctx.input.modelCandidates !== undefined
      ? { candidates: ctx.input.modelCandidates.map((c) => ({ providerId: c.providerId, model: c.model })) }
      : {};
  }

  private record(ctx: Ctx, meta: ConversationResponseMeta): void {
    ctx.calls.push({
      task: meta.task,
      provider: meta.providerUsed,
      model: meta.modelUsed,
      inputTokens: meta.usage.inputTokens,
      outputTokens: meta.usage.outputTokens,
      costUsd: meta.costUsd,
      latencyMs: Math.round(meta.latencyMs),
      fellBack: meta.candidatesTried > 1,
    });
  }

  private async structured<T>(
    ctx: Ctx,
    task: ConversationTaskId,
    schema: JsonSchema,
    system: string,
    finalUser: string,
    maxOutputTokens: number,
  ): Promise<Result<T, AiError>> {
    const res = await this.options.model.converseStructured<T>({
      task,
      messages: this.build(system, ctx, finalUser),
      traceId: ctx.traceId,
      responseSchema: schema,
      maxOutputTokens,
      temperature: 0.1,
      ...this.candidates(ctx),
    });
    if (!res.ok) return err(res.error);
    this.record(ctx, res.value.meta);
    return ok(res.value.output);
  }

  private done(ctx: Ctx, routing: Routing, body: Body): TurnResult {
    return {
      ...body,
      routing,
      notices: ctx.notices,
      usage: { calls: ctx.calls, totalCostUsd: ctx.calls.reduce((sum, c) => sum + c.costUsd, 0) },
    };
  }

  private async retrieve(ctx: Ctx, query: string): Promise<Retrieved> {
    try {
      const result = await withTimeout(
        this.options.knowledge.retrieve({
          principal: ctx.input.principal,
          query,
          limit: this.limits.retrievalLimit,
          ...(ctx.input.scope !== undefined && ctx.input.scope.length > 0 ? { scope: ctx.input.scope } : {}),
        }),
        this.limits.retrievalTimeoutMs,
      );
      if (result.status === 'unavailable') return result;
      return {
        status: 'ok',
        prepared: prepareEvidence(result.evidence, this.limits.evidence),
        ...(result.method !== undefined ? { method: result.method } : {}),
        unsearched: (result.unsearchedSources ?? []).slice(0, 10),
      };
    } catch (error) {
      // The cause stays in the log; the user is told only that knowledge could not be reached.
      this.logger.warn('knowledge retrieval failed', {
        traceId: ctx.traceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: 'unavailable', reason: 'error' };
    }
  }

  /** The refusal used by ASK and DECIDE when there is nothing to ground an answer in. Costs no model call. */
  private ungroundable(ctx: Ctx, routing: Routing, route: 'ask' | 'decide', retrieved: Retrieved): TurnResult {
    let text: string;
    if (retrieved.status === 'unavailable') {
      if (retrieved.reason === 'denied') {
        text =
          "You don't have access to search your organization's knowledge, so I can't answer from it. If you think you should, ask a workspace admin.";
        ctx.notices.push({ code: 'knowledge_denied', message: text });
      } else {
        text =
          retrieved.reason === 'error'
            ? "I couldn't reach your organization's knowledge just now, so I can't answer from it. Please try again in a moment."
            : "No organizational knowledge source is connected to this workspace yet, so I can't answer questions about your organization. A workspace admin can connect sources.";
        ctx.notices.push({ code: 'knowledge_unavailable', message: text });
      }
    } else {
      text =
        route === 'ask'
          ? "I couldn't find anything about that in the sources you have access to. It may not be written down, or you may not have access to where it is."
          : "I couldn't find enough in the sources you have access to to base a recommendation on, so I won't guess.";
      if (retrieved.unsearched.length > 0) text += ` I also couldn't search: ${retrieved.unsearched.join(', ')}.`;
      ctx.notices.push({ code: 'no_sources_found', message: text });
    }
    return this.done(ctx, routing, { route, text, confidence: 'none', grounded: false, citations: [], evidenceConsidered: 0 });
  }

  // ------------------------------------------------------------------------------------------------------- ASK

  private async ask(ctx: Ctx, routing: Routing): Promise<Result<TurnResult, AiError>> {
    const retrieved = await this.retrieve(ctx, routing.standaloneQuery);
    if (retrieved.status === 'unavailable' || retrieved.prepared.length === 0) return ok(this.ungroundable(ctx, routing, 'ask', retrieved));
    const { prepared } = retrieved;
    this.noteRetrieval(ctx, retrieved);

    const res = await this.structured<AskOutput>(
      ctx,
      'conversation.answer',
      ASK_SCHEMA,
      ASK_PROMPT,
      `${renderEvidence(prepared)}\n\nQuestion: ${ctx.message}`,
      1500,
    );
    if (!res.ok) return err(res.error);
    const out = res.value;

    const registry = new CitationRegistry(prepared);
    const answer = registry.rewrite(out.answer);
    const contradictions = this.contradictions(registry, out.contradictions);
    const gaps = clean(out.gaps, 6);
    const grounded = registry.citations().length > 0;

    let confidence: Confidence = out.answerable ? out.confidence : 'none';
    if (out.answerable && !grounded) {
      confidence = 'low';
      ctx.notices.push({ code: 'ungrounded_answer', message: 'This answer is not tied to any of your sources, so treat it with caution.' });
    }
    confidence = this.applyConflictCap(ctx, confidence, contradictions);
    if (retrieved.unsearched.length > 0) confidence = capConfidence(confidence, 'medium');
    this.noteDropped(ctx, registry);

    const text = this.compose(answer.length > 0 ? answer : "I couldn't put together an answer from the sources.", contradictions, gaps);
    const ask: AskPayload = {
      answerable: out.answerable,
      confidence,
      confidenceReason: out.confidenceReason.trim().slice(0, 400),
      contradictions,
      gaps,
      followUps: clean(out.followUps, 3),
    };
    return ok(
      this.done(ctx, routing, {
        route: 'ask',
        text,
        confidence,
        grounded,
        citations: registry.citations(),
        ask,
        evidenceConsidered: prepared.length,
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------------- DECIDE

  private async decide(ctx: Ctx, routing: Routing): Promise<Result<TurnResult, AiError>> {
    const retrieved = await this.retrieve(ctx, routing.standaloneQuery);
    if (retrieved.status === 'unavailable' || retrieved.prepared.length === 0)
      return ok(this.ungroundable(ctx, routing, 'decide', retrieved));
    const { prepared } = retrieved;
    this.noteRetrieval(ctx, retrieved);

    const res = await this.structured<DecideOutput>(
      ctx,
      'conversation.decide',
      DECIDE_SCHEMA,
      DECIDE_PROMPT,
      `${renderEvidence(prepared)}\n\nRequest: ${ctx.message}`,
      2500,
    );
    if (!res.ok) return err(res.error);
    const out = res.value;

    const registry = new CitationRegistry(prepared);
    const summary = registry.rewrite(out.summary);
    const problems = out.problems
      .map((p) => ({ description: p.description.trim(), citations: registry.refs(p.evidenceIds) }))
      .filter((p) => p.description.length > 0);
    const options = out.options
      .map((o) => ({
        title: o.title.trim(),
        description: o.description.trim(),
        pros: clean(o.pros, 6),
        cons: clean(o.cons, 6),
        consequences: clean(o.consequences, 6),
        dependencies: clean(o.dependencies, 6),
        citations: registry.refs(o.evidenceIds),
      }))
      .filter((o) => o.title.length > 0)
      .slice(0, 4);
    const contradictions = this.contradictions(registry, out.contradictions);
    const grounded = registry.citations().length > 0;

    // Advice that cites nothing is a guess about the organization: drop it, and drop one that names no real option.
    let recommendation: DecidePayload['recommendation'];
    const wanted = out.recommendedOption.trim().toLowerCase();
    if (wanted.length > 0) {
      const match = options.find((o) => o.title.toLowerCase() === wanted);
      if (match !== undefined && grounded) {
        recommendation = { optionTitle: match.title, rationale: registry.rewrite(out.recommendationRationale) };
      } else {
        ctx.notices.push({
          code: 'recommendation_dropped',
          message: grounded
            ? 'The draft recommendation did not match any option, so I left it out.'
            : 'I left out a recommendation because none of it is backed by your sources.',
        });
      }
    }

    let confidence: Confidence = out.confidence;
    if (!grounded) {
      confidence = 'low';
      ctx.notices.push({ code: 'ungrounded_answer', message: 'None of this analysis is tied to your sources, so treat it with caution.' });
    }
    if (options.length === 0) confidence = capConfidence(confidence, 'low');
    confidence = this.applyConflictCap(ctx, confidence, contradictions);
    if (retrieved.unsearched.length > 0) confidence = capConfidence(confidence, 'medium');
    this.noteDropped(ctx, registry);

    const gaps = clean(out.gaps, 6);
    const decide: DecidePayload = {
      advisory: true,
      summary,
      problems,
      options,
      ...(recommendation !== undefined ? { recommendation } : {}),
      risks: out.risks
        .map((r) => ({ description: r.description.trim(), severity: r.severity }))
        .filter((r) => r.description.length > 0)
        .slice(0, 8),
      assumptions: clean(out.assumptions, 8),
      confidence,
      confidenceReason: out.confidenceReason.trim().slice(0, 400),
      contradictions,
      gaps,
    };
    const text = this.compose(this.renderDecision(decide), contradictions, gaps);
    return ok(
      this.done(ctx, routing, {
        route: 'decide',
        text,
        confidence,
        grounded,
        citations: registry.citations(),
        decide,
        evidenceConsidered: prepared.length,
      }),
    );
  }

  private renderDecision(d: DecidePayload): string {
    const lines: string[] = [];
    if (d.summary.length > 0) lines.push(d.summary);
    if (d.options.length > 0) {
      lines.push('', 'Options:');
      d.options.forEach((o, i) => {
        const cites = o.citations.length > 0 ? ` [${o.citations.join(', ')}]` : '';
        lines.push(`${i + 1}. ${o.title}: ${o.description}${cites}`);
        if (o.pros.length > 0) lines.push(`   Pros: ${o.pros.join('; ')}`);
        if (o.cons.length > 0) lines.push(`   Cons: ${o.cons.join('; ')}`);
        if (o.consequences.length > 0) lines.push(`   Likely consequences: ${o.consequences.join('; ')}`);
        if (o.dependencies.length > 0) lines.push(`   Depends on: ${o.dependencies.join('; ')}`);
      });
    }
    if (d.recommendation !== undefined)
      lines.push(
        '',
        `Suggested: ${d.recommendation.optionTitle}. ${d.recommendation.rationale}`.trim(),
        'This is advice for you to weigh, not a decision.',
      );
    if (d.risks.length > 0) lines.push('', 'Risks:', ...d.risks.map((r) => `- (${r.severity}) ${r.description}`));
    if (d.assumptions.length > 0) lines.push('', 'Assumptions I made:', ...d.assumptions.map((a) => `- ${a}`));
    return lines.join('\n').trim();
  }

  // ------------------------------------------------------------------------------------------- shared ASK/DECIDE bits

  private contradictions(registry: CitationRegistry, raw: readonly RawConflict[]): Contradiction[] {
    return raw
      .map((c) => ({ summary: c.summary.trim(), citations: registry.refs(c.evidenceIds) }))
      .filter((c) => c.summary.length > 0)
      .slice(0, 5);
  }

  private applyConflictCap(ctx: Ctx, confidence: Confidence, contradictions: readonly Contradiction[]): Confidence {
    if (contradictions.length === 0) return confidence;
    ctx.notices.push({ code: 'contradiction_detected', message: 'Your sources disagree on part of this; both sides are shown below.' });
    return capConfidence(confidence, 'medium');
  }

  /** Tells the user how the evidence was found and what could not be searched — limits of the source, not of the model. */
  private noteRetrieval(ctx: Ctx, retrieved: Extract<Retrieved, { status: 'ok' }>): void {
    if (retrieved.method === 'lexical') {
      ctx.notices.push({
        code: 'keyword_search_only',
        message:
          'These sources were found by matching keywords, not meaning, so relevant material that uses different words may be missing.',
      });
    }
    if (retrieved.unsearched.length > 0) {
      ctx.notices.push({
        code: 'sources_unsearched',
        message: `I couldn't search ${retrieved.unsearched.join(', ')} just now, so this may be incomplete.`,
      });
    }
  }

  private noteDropped(ctx: Ctx, registry: CitationRegistry): void {
    if (registry.dropped() > 0) {
      ctx.notices.push({
        code: 'citations_removed',
        message: 'Some source references in the draft did not match any retrieved source and were removed.',
      });
    }
  }

  private compose(body: string, contradictions: readonly Contradiction[], gaps: readonly string[]): string {
    const parts = [body];
    if (contradictions.length > 0) {
      parts.push(
        '',
        'Conflicting information:',
        ...contradictions.map((c) => `- ${c.summary}${c.citations.length > 0 ? ` [${c.citations.join(', ')}]` : ''}`),
      );
    }
    if (gaps.length > 0) parts.push('', "What the sources don't say:", ...gaps.map((g) => `- ${g}`));
    return parts.join('\n').trim();
  }

  // --------------------------------------------------------------------------------------------------------- DO

  private async act(ctx: Ctx, routing: Routing): Promise<Result<TurnResult, AiError>> {
    const unavailable = (text: string): Result<TurnResult, AiError> => {
      ctx.notices.push({ code: 'action_unavailable', message: text });
      return ok(this.done(ctx, routing, { route: 'do', text, confidence: 'none', grounded: false, citations: [], evidenceConsidered: 0 }));
    };

    if (this.options.capabilities === undefined)
      return unavailable(
        "Actions aren't enabled for this workspace, so I can't set that up. I can still help you work out what needs to happen.",
      );

    let listed: readonly CapabilityDescriptor[];
    try {
      listed = await this.options.capabilities.listAuthorized(ctx.input.principal);
    } catch (error) {
      this.logger.warn('capability listing failed', {
        traceId: ctx.traceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return unavailable(
        "I couldn't check which actions are available to you just now, so I haven't set anything up. Please try again in a moment.",
      );
    }
    const capabilities = listed.slice(0, MAX_CAPABILITIES_SHOWN);
    if (capabilities.length === 0)
      return unavailable(
        "There are no actions available to you here, so I can't set that up. I can still help you work out what needs to happen.",
      );

    const byAlias = new Map<string, CapabilityDescriptor>();
    const catalog = capabilities
      .map((c, i) => {
        const alias = `C${i + 1}`;
        byAlias.set(alias, c);
        const inputs = c.inputs.map(
          (p) =>
            `- ${escapeForPrompt(p.name)} (${p.type}, ${p.required ? 'required' : 'optional'})${p.description ? `: ${escapeForPrompt(p.description)}` : ''}`,
        );
        return `<xo-capability id="${alias}" name="${escapeForPrompt(c.name).replace(/"/g, '&quot;')}">\n${escapeForPrompt(c.description)}\nInputs:\n${inputs.join('\n') || '(none)'}\n</xo-capability>`;
      })
      .join('\n');

    const res = await this.structured<ProposeOutput>(
      ctx,
      'conversation.propose',
      PROPOSE_SCHEMA,
      PROPOSE_PROMPT,
      `${catalog}\n\nRequest: ${ctx.message}`,
      600,
    );
    if (!res.ok) return err(res.error);
    const out = res.value;

    const chosen = byAlias.get(out.capability.trim().toUpperCase());
    if (chosen === undefined) {
      const names = capabilities
        .slice(0, 5)
        .map((c) => c.name)
        .join(', ');
      return unavailable(
        `None of the actions available to you match that request. What I can set up: ${names}${capabilities.length > 5 ? ', and more' : ''}.`,
      );
    }

    // Only inputs the capability declares, coerced strictly; anything missing or malformed is asked for, never guessed.
    const declared = new Map(chosen.inputs.map((p) => [p.name, p]));
    const inputs: Record<string, InputValue> = {};
    const invalid = new Set<string>();
    for (const given of out.inputs) {
      const spec = declared.get(given.name);
      if (spec === undefined) continue;
      const value = coerceInput(spec.type, given.value);
      if (value === undefined) invalid.add(spec.name);
      else inputs[spec.name] = value;
    }
    const missing = chosen.inputs.filter((p) => p.required && inputs[p.name] === undefined).map((p) => p.name);
    if (missing.length > 0) {
      const question =
        out.question.trim().length > 0 && invalid.size === 0
          ? out.question.trim().slice(0, 400)
          : `To set up "${chosen.name}" I still need: ${missing.join(', ')}.`;
      ctx.notices.push({ code: 'action_needs_input', message: `Missing or unusable input: ${missing.join(', ')}.` });
      return ok(
        this.done(ctx, routing, {
          route: 'do',
          text: question,
          confidence: 'none',
          grounded: false,
          citations: [],
          clarifyingQuestion: question,
          evidenceConsidered: 0,
        }),
      );
    }

    const proposal: ActionProposal = {
      capabilityId: chosen.id,
      capabilityName: chosen.name,
      inputs,
      rationale: out.rationale.trim().slice(0, 400),
      requiresApproval: true,
      status: 'proposed',
    };
    const shown = Object.entries(inputs).map(([k, v]) => `- ${k}: ${String(v)}`);
    const text = [
      `I've prepared "${chosen.name}"${shown.length > 0 ? ' with:' : '.'}`,
      ...shown,
      '',
      "It hasn't been run. It needs approval before anything happens.",
    ].join('\n');
    return ok(
      this.done(ctx, routing, { route: 'do', text, confidence: 'none', grounded: false, citations: [], proposal, evidenceConsidered: 0 }),
    );
  }

  // ------------------------------------------------------------------------------------------------------ LEARN

  private async learn(ctx: Ctx, routing: Routing): Promise<Result<TurnResult, AiError>> {
    const plain = (text: string, learning?: LearningOutcome): TurnResult =>
      this.done(ctx, routing, {
        route: 'learn',
        text,
        confidence: 'none',
        grounded: false,
        citations: [],
        ...(learning !== undefined ? { learning } : {}),
        evidenceConsidered: 0,
      });

    const res = await this.structured<LearnOutput>(ctx, 'conversation.learn', LEARN_SCHEMA, LEARN_PROMPT, ctx.message, 300);
    if (!res.ok) return err(res.error);
    const { kind } = res.value;
    const statement = (res.value.statement.trim() || ctx.message).slice(0, 2000);

    if (this.options.learning === undefined) {
      ctx.notices.push({ code: 'learning_unavailable', message: "Feedback isn't being recorded in this workspace." });
      return ok(
        plain("Thanks for telling me. Feedback isn't being recorded in this workspace yet, so I haven't saved this.", {
          kind,
          recorded: false,
          reviewRequired: false,
        }),
      );
    }

    const about = [...ctx.history].reverse().find((h) => h.role === 'assistant');
    try {
      const record = await this.options.learning.record({
        principal: ctx.input.principal,
        kind,
        statement,
        ...(about?.turnId !== undefined ? { aboutTurnId: about.turnId } : {}),
        aboutEvidenceIds: about?.citedEvidenceIds ?? [],
      });
      const review = record.reviewRequired
        ? " It's been sent for review; until someone with the right access confirms it, my answers won't change."
        : '';
      const verb = kind === 'correction' ? 'your correction' : kind === 'outcome' ? 'the outcome' : 'your feedback';
      return ok(
        plain(`Thanks. I've recorded ${verb}.${review}`, {
          kind,
          recorded: true,
          eventId: record.eventId,
          reviewRequired: record.reviewRequired,
        }),
      );
    } catch (error) {
      this.logger.warn('learning record failed', { traceId: ctx.traceId, error: error instanceof Error ? error.message : String(error) });
      ctx.notices.push({ code: 'learning_unavailable', message: "I couldn't save that just now." });
      return ok(plain("I couldn't save that just now. Please try again in a moment.", { kind, recorded: false, reviewRequired: false }));
    }
  }

  // ---------------------------------------------------------------------------------------------------- CONVERSE

  private async converse(ctx: Ctx, routing: Routing): Promise<Result<TurnResult, AiError>> {
    // XO can only describe its own sources if the knowledge system can enumerate them; otherwise it says it cannot.
    const catalog = await this.catalog(ctx);
    const res = await this.options.model.converse({
      task: 'conversation.answer',
      messages: this.build(CONVERSE_PROMPT, ctx, catalog === undefined ? ctx.message : `${catalog}\n\n${ctx.message}`),
      traceId: ctx.traceId,
      maxOutputTokens: 500,
      temperature: 0.4,
      ...this.candidates(ctx),
    });
    if (!res.ok) return err(res.error);
    this.record(ctx, res.value.meta);
    return ok(
      this.done(ctx, routing, {
        route: 'converse',
        text: res.value.output,
        confidence: 'none',
        grounded: false,
        citations: [],
        evidenceConsidered: 0,
      }),
    );
  }

  private async catalog(ctx: Ctx): Promise<string | undefined> {
    const describe = this.options.knowledge.describe?.bind(this.options.knowledge);
    if (describe === undefined) return undefined;
    try {
      const c = await withTimeout(describe(ctx.input.principal), 5000);
      const lines = c.sources
        .slice(0, 40)
        .map((s) => `- ${escapeForPrompt(s.name)} (${escapeForPrompt(s.kind)})${s.detail ? `: ${escapeForPrompt(s.detail)}` : ''}`);
      return `<xo-catalog search_method="${escapeForPrompt(c.searchMethod ?? 'unspecified').replace(/"/g, '&quot;')}">\n${lines.join('\n') || '(no sources are connected)'}\n</xo-catalog>`;
    } catch (error) {
      this.logger.warn('knowledge catalog failed', { traceId: ctx.traceId, error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }
}

function coerceInput(type: 'string' | 'number' | 'boolean', raw: string): InputValue | undefined {
  const v = raw.trim();
  if (v.length === 0) return undefined;
  switch (type) {
    case 'string':
      return v.slice(0, 2000);
    case 'number': {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean': {
      const b = v.toLowerCase();
      return b === 'true' ? true : b === 'false' ? false : undefined;
    }
  }
}
