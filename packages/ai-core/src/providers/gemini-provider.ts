import { randomUUID } from 'node:crypto';
import type { Logger } from '@xo/logger';
import { noopLogger } from '@xo/logger';
import { RetryPolicy } from '../retry.js';
import { validateJsonSchema, type JsonSchema } from '../json-schema.js';
import { getProviderFailure, isTransportRetryable, providerFailure, type ProviderFailureCategory } from '../provider-errors.js';
import { redactSecrets, truncate } from '../redaction.js';
import type {
  ModelProvider,
  ProviderCapabilityDescriptor,
  ProviderMessage,
  ProviderRequest,
  ProviderResponse,
  ProviderToolCall,
  ProviderToolDefinition,
  TokenUsage,
} from '../provider-types.js';

/**
 * Default model: `gemini-3.5-flash-lite`. Selection rationale (verified against
 * Google's pricing + deprecations pages on 2026-10-22): a Flash-family model,
 * listed as free-tier on the pricing page, generally available (not a
 * `-preview` id), no shutdown announced, and named by Google as the
 * recommended model for new projects and for "simple data processing"
 * (which is what XO's extraction capabilities are). Always overridable via
 * `XO_GEMINI_MODEL`. Google's model availability and free-tier terms change —
 * re-verify before relying on this.
 */
export const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash-lite';
export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const GEMINI_API_VERSION_PATH = 'v1beta';
const GEMINI_MODEL_ID_PATTERN = /^gemini-[a-z0-9][a-z0-9.-]*$/;

export interface GeminiRetryOptions {
  /** Retries AFTER the first attempt. `0` disables retries entirely (use this in tests). Hard-capped at 5. */
  readonly maxRetries: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  /** If the vendor asks us to wait longer than this (Retry-After / RetryInfo), fail fast instead of sleeping. */
  readonly maxRetryAfterMs: number;
  /** Injected so tests are deterministic and instant. Defaults to full-jitter. */
  readonly jitter?: (delayMs: number) => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface GeminiProviderOptions {
  readonly apiKey: string;
  /** Endpoint override — only for tests/proxies. Must be https unless it is a loopback address. */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Upper bound enforced on `request.maxOutputTokens`. */
  readonly maxOutputTokensCap?: number;
  /** Upper bound on total characters across all messages (a cheap, deterministic pre-network size guard). */
  readonly maxInputChars?: number;
  readonly retry?: Partial<GeminiRetryOptions>;
  /** Applied when a request does not set `temperature`. Absent = let the model default apply. */
  readonly defaultTemperature?: number;
  /** Telemetry sink. Receives only low-sensitivity fields — never prompts, responses or credentials. */
  readonly logger?: Logger;
  /** Extra model ids to advertise in `describeCapabilities()`. Does not restrict which `gemini-*` ids may be requested. */
  readonly knownModels?: readonly string[];
  readonly now?: () => number;
  /**
   * Thinking-token budget for thinking-capable models (0 disables thinking where the model allows it, -1 = dynamic). Omitted = the model's own
   * default. Thinking tokens count against `maxOutputTokens`, so a small output cap on a thinking model can end with an empty answer.
   */
  readonly thinkingBudget?: number;
}

interface GeminiPart {
  readonly text?: string;
  readonly thought?: boolean;
  readonly thoughtSignature?: string;
  readonly functionCall?: { readonly id?: string; readonly name?: string; readonly args?: unknown };
}
interface GeminiCandidate {
  readonly content?: { readonly parts?: readonly GeminiPart[] };
  readonly finishReason?: string;
}
interface GeminiUsage {
  readonly promptTokenCount?: unknown;
  readonly candidatesTokenCount?: unknown;
  readonly thoughtsTokenCount?: unknown;
  readonly totalTokenCount?: unknown;
  readonly toolUsePromptTokenCount?: unknown;
}
interface GeminiGenerateContentResponse {
  readonly candidates?: readonly GeminiCandidate[];
  readonly promptFeedback?: { readonly blockReason?: string };
  readonly usageMetadata?: GeminiUsage;
}

const DEFAULTS = {
  timeoutMs: 30_000,
  maxOutputTokensCap: 8192,
  maxInputChars: 400_000,
  retry: { maxRetries: 2, initialDelayMs: 500, maxDelayMs: 8000, maxRetryAfterMs: 15_000 } satisfies GeminiRetryOptions,
} as const;

/** Finish reasons that mean "the vendor refused / filtered" (unknown values fall through to 'error'). */
const FILTER_FINISH_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE', 'IMAGE_SAFETY']);

type JsonObject = Record<string, unknown>;

/** Prefix of ids this adapter invents (Gemini's generateContent usually returns function calls without ids). */
const SYNTH_ID_PREFIX = 'gemini_call_';

/**
 * Google Gemini Developer API adapter (`generateContent`, stateless).
 *
 * Why `generateContent` over the newer Interactions API: Google states
 * `generateContent` "remains fully supported", it is stateless (matching
 * the stateless `ModelProvider.complete()` contract), and the Interactions
 * API (`v1beta2`) is a different, step-based, server-stateful shape with
 * no benefit for single-shot extraction. Revisit if Google deprecates it.
 *
 * Why raw `fetch` instead of `@google/genai`: every other `@xo/ai-core`
 * provider is dependency-free over an injectable `fetch`, which keeps the
 * package dependency-light and makes the test transport trivial. The cost
 * is that request/response shapes here are maintained by us, pinned to the
 * REST shapes in Google's docs.
 *
 * Security: the API key is sent ONLY in the `x-goog-api-key` header, never
 * in the URL (URLs end up in proxy logs, error messages and stack traces).
 */
export class GeminiProvider implements ModelProvider {
  readonly id = 'gemini' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxOutputTokensCap: number;
  private readonly maxInputChars: number;
  private readonly retry: GeminiRetryOptions;
  private readonly logger: Logger;
  private readonly now: () => number;
  private callSeq = 0;

  constructor(private readonly options: GeminiProviderOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.trim().length === 0) {
      throw providerFailure('invalid_request', 'gemini', 'GeminiProvider requires a non-empty apiKey');
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = validateBaseUrl(options.baseUrl ?? GEMINI_DEFAULT_BASE_URL);
    this.timeoutMs = positiveInt(options.timeoutMs, DEFAULTS.timeoutMs, 'timeoutMs');
    this.maxOutputTokensCap = positiveInt(options.maxOutputTokensCap, DEFAULTS.maxOutputTokensCap, 'maxOutputTokensCap');
    this.maxInputChars = positiveInt(options.maxInputChars, DEFAULTS.maxInputChars, 'maxInputChars');
    const maxRetries = options.retry?.maxRetries ?? DEFAULTS.retry.maxRetries;
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
      throw providerFailure('invalid_request', 'gemini', 'retry.maxRetries must be an integer between 0 and 5');
    }
    this.retry = { ...DEFAULTS.retry, ...options.retry, maxRetries };
    if (
      options.defaultTemperature !== undefined &&
      !(Number.isFinite(options.defaultTemperature) && options.defaultTemperature >= 0 && options.defaultTemperature <= 2)
    ) {
      throw providerFailure('invalid_request', 'gemini', 'defaultTemperature must be a finite number in [0, 2]');
    }
    this.logger = (options.logger ?? noopLogger).child({ component: 'ai-core.gemini' });
    this.now = options.now ?? (() => performance.now());
  }

  describeCapabilities(): ProviderCapabilityDescriptor {
    return {
      providerId: 'gemini',
      models: [...new Set([GEMINI_DEFAULT_MODEL, ...(this.options.knownModels ?? [])])],
      // The adapter implements `complete()` only; streaming is NOT implemented, so it is not advertised.
      supportsStreaming: false,
      supportsStructuredOutput: true,
      // The adapter maps text messages only; image/audio parts are not implemented.
      supportsVision: false,
      supportsToolCalling: true,
      // Per-model context windows differ and are not asserted here; this is a conservative planning figure, not a guarantee.
      maxContextTokens: 1_000_000,
      features: {
        systemInstructions: true,
        schemaConstrainedOutput: true,
        usageReporting: true,
        temperature: true,
        hiddenReasoningTokens: true,
      },
    };
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const requestId = request.requestId ?? randomUUID();
    const startedAt = this.now();
    let attempts = 0;
    let lastRetryAfterMs: number | undefined;

    const logFailure = (error: unknown): void => {
      const failure = getProviderFailure(error);
      this.logger.warn('inference.request.failed', {
        provider: this.id,
        model: request.model,
        requestId,
        durationMs: Math.round(this.now() - startedAt),
        outcome: 'failure',
        category: failure?.category ?? 'unknown',
        httpStatus: failure?.httpStatus,
        providerCode: failure?.providerCode,
        attempts,
        retryCount: Math.max(0, attempts - 1),
        timedOut: failure?.category === 'timeout',
        rateLimited: failure?.category === 'rate_limited' || failure?.category === 'quota_exhausted',
        retryAfterMs: failure?.retryAfterMs,
      });
    };

    let body: string;
    try {
      body = this.buildRequestBody(request, requestId);
    } catch (error) {
      logFailure(error);
      throw error;
    }

    const retryPolicy = new RetryPolicy({
      maxAttempts: this.retry.maxRetries + 1,
      initialDelayMs: this.retry.initialDelayMs,
      maxDelayMs: this.retry.maxDelayMs,
      backoffMultiplier: 2,
      jitter: this.retry.jitter ?? ((ms) => Math.floor(Math.random() * ms) + 1),
      isRetryable: (error) => {
        const failure = getProviderFailure(error);
        if (!failure || !isTransportRetryable(failure.category)) return false;
        // Respect the vendor's own guidance; refuse to sleep an unbounded time (anti retry-storm / anti hang).
        if (failure.retryAfterMs !== undefined && failure.retryAfterMs > this.retry.maxRetryAfterMs) return false;
        lastRetryAfterMs = failure.retryAfterMs;
        return true;
      },
      sleep: async (ms) => {
        const wait = Math.max(ms, lastRetryAfterMs ?? 0);
        lastRetryAfterMs = undefined;
        await (this.retry.sleep ?? defaultSleep)(wait);
      },
    });

    try {
      const outcome = await retryPolicy.execute(async (attempt) => {
        attempts = attempt;
        if (request.signal?.aborted) {
          throw providerFailure('aborted', this.id, 'Gemini request aborted by caller before sending', { model: request.model, requestId });
        }
        return this.attemptOnce(request, body, requestId);
      });
      const response = this.normalize(outcome.value, request, requestId, startedAt, outcome.attempts);
      this.logger.info('inference.request.completed', {
        provider: this.id,
        model: response.modelUsed,
        requestId,
        durationMs: response.meta?.durationMs,
        outcome: 'success',
        attempts: outcome.attempts,
        retryCount: outcome.attempts - 1,
        finishReason: response.finishReason,
        usageKnown: response.usageKnown,
        inputTokens: response.usageKnown ? response.usage.inputTokens : undefined,
        outputTokens: response.usageKnown ? response.usage.outputTokens : undefined,
      });
      return response;
    } catch (error) {
      logFailure(error);
      throw error;
    }
  }

  // ---- request ----------------------------------------------------------------

  private buildRequestBody(request: ProviderRequest, requestId: string): string {
    const fail = (category: ProviderFailureCategory, message: string): Error =>
      providerFailure(category, this.id, message, { model: truncate(String(request.model), 80), requestId });

    if (typeof request.model !== 'string' || !GEMINI_MODEL_ID_PATTERN.test(request.model)) {
      throw fail(
        'unsupported_model',
        `Model "${truncate(String(request.model), 60)}" is not a Gemini model id (expected "gemini-…"). Set XO_GEMINI_MODEL.`,
      );
    }
    if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > this.maxOutputTokensCap) {
      throw fail('invalid_request', `maxOutputTokens must be an integer in [1, ${this.maxOutputTokensCap}]`);
    }
    const temperature = request.temperature ?? this.options.defaultTemperature;
    if (temperature !== undefined && !(Number.isFinite(temperature) && temperature >= 0 && temperature <= 2)) {
      throw fail('invalid_request', 'temperature must be a finite number in [0, 2]');
    }
    if (request.messages.length === 0) throw fail('invalid_request', 'At least one message is required');
    let totalChars = 0;
    for (const m of request.messages) {
      if (typeof m.content !== 'string') throw fail('invalid_request', 'Message content must be a string');
      totalChars += m.content.length;
    }
    if (totalChars > this.maxInputChars) {
      throw fail('invalid_request', `Input is ${totalChars} characters; the configured limit is ${this.maxInputChars}`);
    }

    const systemText = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const contents = toGeminiContents(request.messages);
    const declared = (request.tools ?? []).map((t) => declareTool(t));
    if (contents.length === 0)
      throw fail('invalid_request', 'At least one user or assistant message is required (system-only requests are not valid)');

    const generationConfig: Record<string, unknown> = { maxOutputTokens: request.maxOutputTokens };
    if (this.options.thinkingBudget !== undefined) generationConfig['thinkingConfig'] = { thinkingBudget: this.options.thinkingBudget };
    if (temperature !== undefined) generationConfig['temperature'] = temperature;
    if (request.responseSchema) {
      generationConfig['responseMimeType'] = 'application/json';
      generationConfig['responseSchema'] = toGeminiSchema(request.responseSchema);
    }

    return JSON.stringify({
      contents,
      ...(declared.length > 0 ? { tools: [{ functionDeclarations: declared.map((d) => d.declaration) }] } : {}),
      ...(systemText.length > 0 ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
      generationConfig,
    });
  }

  private async attemptOnce(request: ProviderRequest, body: string, requestId: string): Promise<GeminiGenerateContentResponse> {
    const secrets = [this.options.apiKey];
    const ctx = { model: request.model, requestId };
    const url = `${this.baseUrl}/${GEMINI_API_VERSION_PATH}/models/${encodeURIComponent(request.model)}:generateContent`;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onCallerAbort = (): void => controller.abort();
    request.signal?.addEventListener('abort', onCallerAbort, { once: true });

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.options.apiKey },
          body,
          signal: controller.signal,
        });
      } catch (error) {
        if (timedOut) {
          throw providerFailure(
            'timeout',
            this.id,
            `Gemini request timed out after ${this.timeoutMs}ms (remote work may still complete and be billed)`,
            ctx,
          );
        }
        if (request.signal?.aborted) {
          throw providerFailure('aborted', this.id, 'Gemini request aborted by caller (remote work may still complete and be billed)', ctx);
        }
        throw providerFailure('transient', this.id, 'Network error calling the Gemini API', ctx, sanitizeCause(error, secrets));
      }

      if (!response.ok) throw await this.classifyHttpError(response, ctx, secrets);

      try {
        return (await response.json()) as GeminiGenerateContentResponse;
      } catch (error) {
        if (timedOut) {
          throw providerFailure('timeout', this.id, `Gemini response body timed out after ${this.timeoutMs}ms`, ctx);
        }
        throw providerFailure(
          'malformed_response',
          this.id,
          'Gemini returned a non-JSON response body',
          { ...ctx, httpStatus: response.status },
          sanitizeCause(error, secrets),
        );
      }
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  private async classifyHttpError(
    response: Response,
    ctx: { model: string; requestId: string },
    secrets: readonly string[],
  ): Promise<Error> {
    const status = response.status;
    const raw = await response.text().catch(() => '');
    let providerCode: string | undefined;
    let providerMessage = '';
    let details: unknown[] = [];
    try {
      const parsed = JSON.parse(raw) as { error?: { status?: unknown; code?: unknown; message?: unknown; details?: unknown } };
      const e = parsed.error;
      if (e) {
        const rawCode = typeof e.status === 'string' ? e.status : typeof e.code === 'string' ? e.code : undefined;
        // Vendor-controlled string that is logged and embedded in messages: accept only a short enum-like token, else drop it.
        providerCode =
          rawCode !== undefined && /^[A-Za-z0-9_.:-]{1,64}$/.test(rawCode) && redactSecrets(rawCode, secrets) === rawCode
            ? rawCode
            : undefined;
        providerMessage = typeof e.message === 'string' ? e.message : '';
        details = Array.isArray(e.details) ? e.details : [];
      }
    } catch {
      /* non-JSON error body: classify by HTTP status alone */
    }
    const safeMessage = truncate(redactSecrets(providerMessage, secrets), 300);
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after')) ?? parseRetryInfoMs(details);
    const base = {
      ...ctx,
      httpStatus: status,
      ...(providerCode ? { providerCode } : {}),
      ...(safeMessage ? { providerMessage: safeMessage } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
    const lowerMsg = providerMessage.toLowerCase();
    const code = (providerCode ?? '').toLowerCase();
    const fail = (category: ProviderFailureCategory, message: string): Error =>
      providerFailure(category, this.id, `${message} (HTTP ${status}${providerCode ? ` ${providerCode}` : ''})`, base);

    // Gemini historically reports an invalid key as 400 INVALID_ARGUMENT ("API key not valid"), not 401.
    if (
      status === 401 ||
      code === 'authentication' ||
      code === 'unauthenticated' ||
      lowerMsg.includes('api key not valid') ||
      lowerMsg.includes('api_key_invalid') ||
      lowerMsg.includes('api key expired')
    ) {
      return fail('authentication', 'Gemini rejected the API key');
    }
    if (status === 403 || code === 'permission_denied') return fail('permission_denied', 'Gemini denied permission for this key/project');
    if (status === 404 || code === 'model_not_found' || code === 'not_found')
      return fail('unsupported_model', `Gemini does not recognise model "${ctx.model}"`);
    if (status === 429) {
      const perDay =
        JSON.stringify(details).toLowerCase().includes('perday') || code === 'quota_exceeded' || /per\s?day|daily/.test(lowerMsg);
      return perDay ? fail('quota_exhausted', 'Gemini daily quota exhausted') : fail('rate_limited', 'Gemini rate limit hit');
    }
    if (
      status === 400 &&
      (code === 'failed_precondition' || lowerMsg.includes('billing') || lowerMsg.includes('not available in your country'))
    ) {
      return fail('permission_denied', 'Gemini request failed a precondition (region/billing)');
    }
    if (status === 400 || status === 413 || status === 416 || status === 422) return fail('invalid_request', 'Gemini rejected the request');
    if (status === 501) return fail('unsupported_feature', 'Gemini does not implement the requested operation');
    if (status === 504 || code === 'deadline_exceeded') return fail('timeout', 'Gemini reported a deadline exceeded');
    if (status >= 500) return fail('transient', 'Gemini server error');
    return fail('invalid_request', 'Gemini returned an unexpected status');
  }

  // ---- response ---------------------------------------------------------------

  private normalize(
    data: GeminiGenerateContentResponse,
    request: ProviderRequest,
    requestId: string,
    startedAt: number,
    attempts: number,
  ): ProviderResponse {
    const ctx = { model: request.model, requestId, attempts };
    const candidate = data.candidates?.[0];

    if (!candidate) {
      const blockReason = data.promptFeedback?.blockReason;
      if (blockReason) {
        throw providerFailure('content_blocked', this.id, `Gemini blocked the prompt (reason: ${truncate(blockReason, 60)})`, ctx);
      }
      throw providerFailure('empty_response', this.id, 'Gemini returned no candidates', ctx);
    }

    const rawFinish = candidate.finishReason;
    if (rawFinish !== undefined && FILTER_FINISH_REASONS.has(rawFinish)) {
      throw providerFailure('content_blocked', this.id, `Gemini filtered the output (finishReason: ${rawFinish})`, ctx);
    }

    // Skip hidden-reasoning ("thought") parts; they are not the answer.
    const parts = candidate.content?.parts ?? [];
    const text = parts
      .filter((p) => p.thought !== true)
      .map((p) => p.text ?? '')
      .join('');

    const freeformByTool = new Map((request.tools ?? []).map((t) => [t.name, isObj(t.inputSchema) ? t.inputSchema : undefined] as const));
    const toolCalls: ProviderToolCall[] = [];
    for (const p of parts) {
      const fc = p.functionCall;
      if (fc === undefined || typeof fc.name !== 'string' || fc.name.length === 0) continue;
      // Fail closed: a call whose arguments are not a JSON object is never executed as `{}`.
      if (fc.args !== undefined && !isObj(fc.args))
        throw providerFailure('malformed_response', this.id, `gemini: tool call "${fc.name}" arguments are not a JSON object`, ctx);
      const args = restoreFreeform(fc.args ?? {}, freeformByTool.get(fc.name)) as JsonObject;
      toolCalls.push({
        id: typeof fc.id === 'string' && fc.id.length > 0 ? fc.id : `${SYNTH_ID_PREFIX}${++this.callSeq}`,
        name: fc.name,
        input: args,
        ...(typeof p.thoughtSignature === 'string' ? { providerState: p.thoughtSignature } : {}),
      });
    }
    // A reply cut off by the token limit may carry truncated arguments; refuse it.
    if (toolCalls.length > 0 && rawFinish === 'MAX_TOKENS')
      throw providerFailure(
        'malformed_response',
        this.id,
        'gemini: tool call arrived on a length-truncated reply; refusing to act on possibly cut-off arguments',
        ctx,
      );
    if (text.trim().length === 0 && toolCalls.length === 0) {
      throw providerFailure(
        'empty_response',
        this.id,
        `Gemini returned empty output (finishReason: ${rawFinish ?? 'none'}). If this is MAX_TOKENS, hidden reasoning may have consumed the output budget — raise maxOutputTokens.`,
        ctx,
      );
    }

    const finishReason: ProviderResponse['finishReason'] = toolCalls.length > 0 ? 'tool_use' : mapFinishReason(rawFinish);
    if (finishReason === 'error') {
      throw providerFailure(
        'malformed_response',
        this.id,
        `Gemini ended generation abnormally (finishReason: ${rawFinish ?? 'none'})`,
        ctx,
      );
    }

    if (request.responseSchema && toolCalls.length === 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw providerFailure(
          'malformed_response',
          this.id,
          `Gemini structured output was not valid JSON${finishReason === 'length' ? ' (truncated by the token limit)' : ''}`,
          ctx,
        );
      }
      const issues = validateJsonSchema(request.responseSchema as unknown as JsonSchema, parsed);
      if (issues.length > 0) {
        // Paths and rule messages only — never the offending values, which may contain source text.
        const summary = issues
          .slice(0, 5)
          .map((i) => `${i.path}: ${i.message}`)
          .join('; ');
        throw providerFailure('malformed_response', this.id, `Gemini structured output failed local schema validation: ${summary}`, ctx);
      }
    }

    const { usage, known } = extractUsage(data.usageMetadata);
    return {
      text,
      usage,
      usageKnown: known,
      modelUsed: request.model,
      finishReason,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      meta: {
        providerId: this.id,
        requestId,
        durationMs: Math.round(this.now() - startedAt),
        attempts,
        ...(rawFinish !== undefined ? { rawFinishReason: rawFinish } : {}),
      },
    };
  }
}

// ---- helpers ------------------------------------------------------------------

function mapFinishReason(reason: string | undefined): ProviderResponse['finishReason'] {
  if (reason === undefined || reason === 'STOP') return 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  if (FILTER_FINISH_REASONS.has(reason)) return 'content_filter';
  return 'error';
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Output tokens include hidden reasoning tokens: Google's pricing page bills
 * "output (including thinking tokens)". Never fabricates: if the vendor
 * omitted usage, returns a `{0,0}` placeholder flagged `known: false`.
 */
function extractUsage(usage: GeminiUsage | undefined): { usage: TokenUsage; known: boolean } {
  if (!usage || !isCount(usage.promptTokenCount)) return { usage: { inputTokens: 0, outputTokens: 0 }, known: false };
  const input = usage.promptTokenCount + (isCount(usage.toolUsePromptTokenCount) ? usage.toolUsePromptTokenCount : 0);
  const candidates = isCount(usage.candidatesTokenCount) ? usage.candidatesTokenCount : 0;
  let output = candidates;
  if (isCount(usage.thoughtsTokenCount)) output = candidates + usage.thoughtsTokenCount;
  else if (isCount(usage.totalTokenCount) && usage.totalTokenCount >= input) output = Math.max(candidates, usage.totalTokenCount - input);
  return { usage: { inputTokens: input, outputTokens: output }, known: true };
}

const GEMINI_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
]);

/**
 * Converts XO's JSON-Schema-shaped output schema into the OpenAPI-subset
 * Gemini's `responseSchema` accepts (uppercase types; unsupported keywords
 * such as `additionalProperties` / `$schema` dropped). This only narrows
 * what the vendor is *asked* to do — the full schema is always re-validated
 * locally after the response arrives.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
    if (key === 'type' && typeof value === 'string') out[key] = value.toUpperCase();
    else if (key === 'properties' && value !== null && typeof value === 'object') {
      out[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toGeminiSchema(v)]));
    } else if (key === 'items') out[key] = toGeminiSchema(value);
    else out[key] = value;
  }
  return out;
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Reads Google's `google.rpc.RetryInfo` detail (`retryDelay: "12s"`) from an error body. */
function parseRetryInfoMs(details: readonly unknown[]): number | undefined {
  for (const d of details) {
    const delay = (d as { retryDelay?: unknown } | null)?.retryDelay;
    if (typeof delay === 'string') {
      const m = /^(\d+(?:\.\d+)?)s$/.exec(delay);
      if (m?.[1]) return Math.round(Number(m[1]) * 1000);
    }
  }
  return undefined;
}

function sanitizeCause(error: unknown, secrets: readonly string[]): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(truncate(redactSecrets(message, secrets), 200));
}

function validateBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw providerFailure('invalid_request', 'gemini', 'Gemini baseUrl is not a valid URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw providerFailure('invalid_request', 'gemini', 'Gemini baseUrl must be https (http is allowed only for loopback test servers)');
  }
  if (url.username || url.password || url.search) {
    throw providerFailure('invalid_request', 'gemini', 'Gemini baseUrl must not embed credentials or a query string');
  }
  return url.toString().replace(/\/+$/, '');
}

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  const v = value ?? fallback;
  if (!Number.isInteger(v) || v < 1) throw providerFailure('invalid_request', 'gemini', `${name} must be a positive integer`);
  return v;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Maps vendor-neutral messages onto Gemini `contents`. Tool results are matched to calls by function *name*, so the
 * name is recovered from the assistant message that issued the call; a result whose call id is unknown is rejected
 * (fail closed) rather than sent as an unattributable response. Consecutive tool results (parallel calls) are merged
 * into one `user` turn, which the API requires.
 */
export function toGeminiContents(messages: readonly ProviderMessage[]): { role: 'user' | 'model'; parts: JsonObject[] }[] {
  const out: { role: 'user' | 'model'; parts: JsonObject[] }[] = [];
  const nameById = new Map<string, string>();
  let lastWasToolResult = false;

  for (const m of messages) {
    if (m.role === 'system') continue;

    if (m.role === 'tool') {
      const id = m.toolCallId;
      const name = id !== undefined ? nameById.get(id) : undefined;
      if (id === undefined || name === undefined)
        throw providerFailure('invalid_request', 'gemini', `gemini: tool result references unknown tool call id "${String(id)}"`);
      const part: JsonObject = {
        functionResponse: {
          name,
          ...(id.startsWith(SYNTH_ID_PREFIX) ? {} : { id }),
          response: m.isError === true ? { error: m.content } : { output: m.content },
        },
      };
      const last = out[out.length - 1];
      if (lastWasToolResult && last !== undefined) last.parts.push(part);
      else out.push({ role: 'user', parts: [part] });
      lastWasToolResult = true;
      continue;
    }

    lastWasToolResult = false;
    if (m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0) {
      const parts: JsonObject[] = [];
      if (m.content.length > 0) parts.push({ text: m.content });
      for (const c of m.toolCalls) {
        nameById.set(c.id, c.name);
        parts.push({
          functionCall: { name: c.name, args: { ...c.input }, ...(c.id.startsWith(SYNTH_ID_PREFIX) ? {} : { id: c.id }) },
          ...(c.providerState !== undefined ? { thoughtSignature: c.providerState } : {}),
        });
      }
      out.push({ role: 'model', parts });
      continue;
    }
    out.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }, ...(m.images ?? []).map((i) => ({ inlineData: { mimeType: i.mediaType, data: i.dataBase64 } }))],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Tool schema translation (JSON Schema -> Gemini's OpenAPI subset)
// ---------------------------------------------------------------------------------------------------------------

/** Keywords that change meaning if dropped; a tool using one is refused rather than silently weakened. */
const REJECTED_KEYWORDS = ['$ref', '$defs', 'definitions', 'allOf', 'not', 'if', 'then', 'else', 'patternProperties', 'dependentSchemas'];
const COPIED_SCALARS = ['description', 'title', 'minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern'] as const;
const FREEFORM_NOTE = ' (provide this value as a JSON-encoded object string)';

function fail(toolName: string, why: string): never {
  throw providerFailure('invalid_request', 'gemini', `gemini: tool "${toolName}" cannot be declared: ${why}`);
}

function isObj(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFreeformObject(node: JsonObject): boolean {
  const types = Array.isArray(node['type']) ? node['type'] : [node['type']];
  if (!types.includes('object')) return false;
  const props = node['properties'];
  return !isObj(props) || Object.keys(props).length === 0;
}

function toGeminiToolSchema(toolName: string, node: unknown, path: string): JsonObject {
  if (!isObj(node)) fail(toolName, `schema at ${path} is not an object`);
  for (const k of REJECTED_KEYWORDS) if (k in node) fail(toolName, `schema at ${path} uses unsupported keyword "${k}"`);

  const out: JsonObject = {};
  for (const k of COPIED_SCALARS) if (node[k] !== undefined) out[k] = node[k];

  const alt = node['anyOf'] ?? node['oneOf'];
  if (Array.isArray(alt)) {
    out['anyOf'] = alt.map((s, i) => toGeminiToolSchema(toolName, s, `${path}.anyOf[${i}]`));
    return out;
  }

  let type = node['type'];
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== 'null');
    if (nonNull.length !== type.length) out['nullable'] = true;
    if (nonNull.length === 1) type = nonNull[0];
    else {
      out['anyOf'] = nonNull.map((t) => toGeminiToolSchema(toolName, { ...node, type: t }, path));
      return out;
    }
  }
  if (node['const'] !== undefined) {
    if (typeof node['const'] !== 'string') fail(toolName, `non-string const at ${path}`);
    out['type'] = 'string';
    out['enum'] = [node['const']];
    return out;
  }
  if (typeof type !== 'string') fail(toolName, `schema at ${path} has no usable "type"`);

  if (node['enum'] !== undefined) {
    if (!Array.isArray(node['enum']) || !node['enum'].every((e) => typeof e === 'string'))
      fail(toolName, `enum at ${path} must contain only strings`);
    out['enum'] = node['enum'];
  }

  switch (type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
      out['type'] = type;
      return out;
    case 'array': {
      if (!isObj(node['items'])) fail(toolName, `array at ${path} has no "items" schema`);
      out['type'] = 'array';
      out['items'] = toGeminiToolSchema(toolName, node['items'], `${path}.items`);
      return out;
    }
    case 'object': {
      if (isFreeformObject(node)) {
        out['type'] = 'string';
        out['description'] = `${typeof node['description'] === 'string' ? node['description'] : 'object'}${FREEFORM_NOTE}`;
        return out;
      }
      const props = node['properties'] as JsonObject;
      const converted: JsonObject = {};
      for (const [k, v] of Object.entries(props)) converted[k] = toGeminiToolSchema(toolName, v, `${path}.${k}`);
      out['type'] = 'object';
      out['properties'] = converted;
      if (Array.isArray(node['required'])) {
        const req = node['required'].filter((r): r is string => typeof r === 'string' && r in converted);
        if (req.length > 0) out['required'] = req;
      }
      return out;
    }
    default:
      return fail(toolName, `unsupported type "${type}" at ${path}`);
  }
}

interface DeclaredTool {
  readonly name: string;
  readonly declaration: JsonObject;
  /** The original JSON Schema, kept so decoded arguments can be restored to their declared shape. */
  readonly source: JsonObject | undefined;
}

function declareTool(tool: ProviderToolDefinition): DeclaredTool {
  const source = tool.inputSchema;
  const root = isObj(source) ? source : undefined;
  const declaration: JsonObject = { name: tool.name, description: tool.description };
  // A parameterless tool must omit `parameters` entirely (an empty OBJECT is rejected by the API).
  if (root !== undefined && !isFreeformObject(root)) declaration['parameters'] = toGeminiToolSchema(tool.name, root, '$');
  return { name: tool.name, declaration, source: root };
}

/**
 * Inverse of the free-form-object shim: wherever the original schema declared an object without properties and the
 * model sent a JSON string, decode it. Anything that does not decode to a plain object is left untouched so the tool
 * executor sees (and can reject) exactly what the model sent.
 */
export function restoreFreeform(value: unknown, schema: JsonObject | undefined): unknown {
  if (schema === undefined) return value;
  if (isFreeformObject(schema)) {
    if (typeof value !== 'string') return value;
    try {
      const parsed: unknown = JSON.parse(value);
      return isObj(parsed) ? parsed : value;
    } catch {
      return value;
    }
  }
  if (isObj(value) && isObj(schema['properties'])) {
    const out: JsonObject = { ...value };
    for (const [k, sub] of Object.entries(schema['properties'])) {
      if (k in out && isObj(sub)) out[k] = restoreFreeform(out[k], sub);
    }
    return out;
  }
  if (Array.isArray(value) && isObj(schema['items'])) return value.map((v) => restoreFreeform(v, schema['items'] as JsonObject));
  return value;
}
