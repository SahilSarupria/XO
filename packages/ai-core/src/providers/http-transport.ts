import { RetryPolicy } from '../retry.js';
import { getProviderFailure, isTransportRetryable, providerFailure, type ProviderFailureCategory } from '../provider-errors.js';
import { redactSecrets, truncate } from '../redaction.js';
import type { ProviderId } from '../provider-types.js';

/**
 * Shared HTTP transport for provider adapters. This is the generic part of
 * `GeminiProvider`'s request path, extracted so every adapter gets identical
 * semantics (the Gemini adapter itself is deliberately NOT migrated onto this
 * helper — it is the golden reference and is left untouched):
 *
 * - per-request timeout via `AbortController`, covering the response body read too;
 * - caller-signal propagation, with timeout vs caller-abort distinguished;
 * - HTTP status → `ProviderFailureCategory` classification;
 * - `Retry-After` parsing; a vendor wait longer than `maxRetryAfterMs` fails fast instead of sleeping;
 * - bounded transport retry with abort-aware backoff, retrying ONLY `isTransportRetryable` categories.
 *   The router never retries a classified provider failure, so this helper owns the bounded retry —
 *   without it a 503/429 would never be retried;
 * - vendor text is redacted and truncated before it reaches an error; raw response bodies never appear in messages.
 *
 * Network access is only through the injected `fetchImpl`.
 */

/** Defaults mirror `GeminiProvider`'s (`timeoutMs` 30s; 2 retries; 500ms→8s backoff; refuse a vendor wait over 15s). */
export const TRANSPORT_DEFAULT_TIMEOUT_MS = 30_000;
export const TRANSPORT_DEFAULT_MAX_RETRIES = 2;
export const TRANSPORT_DEFAULT_INITIAL_DELAY_MS = 500;
export const TRANSPORT_DEFAULT_MAX_DELAY_MS = 8000;
export const TRANSPORT_DEFAULT_MAX_RETRY_AFTER_MS = 15_000;
/** Hard ceiling on `maxRetries` (same as Gemini). */
export const TRANSPORT_MAX_RETRIES_CEILING = 5;

export interface TransportRetryOptions {
  /** Retries AFTER the first attempt. `0` disables retries entirely (use this in tests). Hard-capped at 5. */
  readonly maxRetries: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  /** If the vendor asks us to wait longer than this (Retry-After), fail fast instead of sleeping. */
  readonly maxRetryAfterMs: number;
  /** Injected so tests are deterministic and instant. Defaults to full jitter. */
  readonly jitter?: (delayMs: number) => number;
  /** Injected so tests are instant. The default sleep is abort-aware: a caller abort ends the wait early. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const DEFAULT_TRANSPORT_RETRY: TransportRetryOptions = {
  maxRetries: TRANSPORT_DEFAULT_MAX_RETRIES,
  initialDelayMs: TRANSPORT_DEFAULT_INITIAL_DELAY_MS,
  maxDelayMs: TRANSPORT_DEFAULT_MAX_DELAY_MS,
  maxRetryAfterMs: TRANSPORT_DEFAULT_MAX_RETRY_AFTER_MS,
};

export interface HttpTransportOptions {
  readonly providerId: ProviderId;
  /** Human label used in error messages, e.g. "Anthropic". */
  readonly displayName: string;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs?: number;
  readonly retry?: Partial<TransportRetryOptions>;
  /** Credentials held by this process; redacted (exact match, in addition to pattern match) from anything vendor-supplied. */
  readonly secrets: readonly string[];
}

export interface HttpPostRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly model: string;
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export interface HttpPostResult<T> {
  readonly data: T;
  readonly status: number;
  /** Total HTTP attempts made (1 = no retry). */
  readonly attempts: number;
}

export interface ResolvedTransport {
  readonly timeoutMs: number;
  readonly retry: TransportRetryOptions;
}

/** Validates and resolves transport tuning. Throws `invalid_request` (never retried) on bad configuration. */
export function resolveTransportOptions(
  providerId: ProviderId,
  options: { readonly timeoutMs?: number; readonly retry?: Partial<TransportRetryOptions> },
): ResolvedTransport {
  const timeoutMs = options.timeoutMs ?? TRANSPORT_DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw providerFailure('invalid_request', providerId, 'timeoutMs must be a positive integer');
  }
  const maxRetries = options.retry?.maxRetries ?? TRANSPORT_DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > TRANSPORT_MAX_RETRIES_CEILING) {
    throw providerFailure(
      'invalid_request',
      providerId,
      `retry.maxRetries must be an integer between 0 and ${TRANSPORT_MAX_RETRIES_CEILING}`,
    );
  }
  return { timeoutMs, retry: { ...DEFAULT_TRANSPORT_RETRY, ...options.retry, maxRetries } };
}

/**
 * POSTs a JSON body with timeout, abort propagation, classification and bounded transport retry. Resolves with the parsed
 * JSON body of the first 2xx response; otherwise throws a classified `providerFailure(...)` (and nothing else).
 */
export async function postJsonWithRetry<T>(transport: HttpTransportOptions, request: HttpPostRequest): Promise<HttpPostResult<T>> {
  const { timeoutMs, retry } = resolveTransportOptions(transport.providerId, transport);
  let lastRetryAfterMs: number | undefined;

  const retryPolicy = new RetryPolicy({
    maxAttempts: retry.maxRetries + 1,
    initialDelayMs: retry.initialDelayMs,
    maxDelayMs: retry.maxDelayMs,
    backoffMultiplier: 2,
    jitter: retry.jitter ?? ((ms) => Math.floor(Math.random() * ms) + 1),
    isRetryable: (error) => {
      const failure = getProviderFailure(error);
      if (!failure || !isTransportRetryable(failure.category)) return false;
      // Respect the vendor's own guidance; refuse to sleep an unbounded time (anti retry-storm / anti hang).
      if (failure.retryAfterMs !== undefined && failure.retryAfterMs > retry.maxRetryAfterMs) return false;
      lastRetryAfterMs = failure.retryAfterMs;
      return true;
    },
    sleep: async (ms) => {
      const wait = Math.max(ms, lastRetryAfterMs ?? 0);
      lastRetryAfterMs = undefined;
      await (retry.sleep ?? abortAwareSleep)(wait, request.signal);
    },
  });

  const outcome = await retryPolicy.execute(async () => {
    // Checked before EVERY attempt (including the first and any attempt after a backoff sleep): a pre-aborted or
    // mid-backoff-aborted caller makes zero further network calls.
    if (request.signal?.aborted) {
      throw providerFailure('aborted', transport.providerId, `${transport.displayName} request aborted by caller before sending`, {
        model: request.model,
        requestId: request.requestId,
      });
    }
    return attemptOnce<T>(transport, timeoutMs, request);
  });
  return { data: outcome.value.data, status: outcome.value.status, attempts: outcome.attempts };
}

async function attemptOnce<T>(
  transport: HttpTransportOptions,
  timeoutMs: number,
  request: HttpPostRequest,
): Promise<{ data: T; status: number }> {
  const { providerId, displayName, secrets } = transport;
  const ctx = { model: request.model, requestId: request.requestId };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = (): void => controller.abort();
  request.signal?.addEventListener('abort', onCallerAbort, { once: true });

  try {
    let response: Response;
    try {
      response = await transport.fetchImpl(request.url, {
        method: 'POST',
        headers: { ...request.headers },
        body: request.body,
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw providerFailure(
          'timeout',
          providerId,
          `${displayName} request timed out after ${timeoutMs}ms (remote work may still complete and be billed)`,
          ctx,
        );
      }
      if (request.signal?.aborted) {
        throw providerFailure(
          'aborted',
          providerId,
          `${displayName} request aborted by caller (remote work may still complete and be billed)`,
          ctx,
        );
      }
      throw providerFailure('transient', providerId, `Network error calling the ${displayName} API`, ctx, sanitizeCause(error, secrets));
    }

    if (!response.ok) throw await classifyHttpError(transport, response, ctx);

    try {
      return { data: (await response.json()) as T, status: response.status };
    } catch (error) {
      if (timedOut) {
        throw providerFailure('timeout', providerId, `${displayName} response body timed out after ${timeoutMs}ms`, ctx);
      }
      if (request.signal?.aborted) {
        throw providerFailure('aborted', providerId, `${displayName} request aborted by caller while reading the response`, ctx);
      }
      throw providerFailure(
        'malformed_response',
        providerId,
        `${displayName} returned a non-JSON response body`,
        { ...ctx, httpStatus: response.status },
        sanitizeCause(error, secrets),
      );
    }
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/** Error-body fields that mean "the vendor's content/safety filter rejected the request" (Azure OpenAI reports this as HTTP 400). */
const CONTENT_FILTER_CODES = new Set(['content_filter', 'content_policy_violation', 'responsibleaipolicyviolation']);
/** Error-body codes that mean a long-window / billing quota (not a short rate limit). OpenAI reports `insufficient_quota` as HTTP 429. */
const QUOTA_CODES = new Set(['insufficient_quota', 'quota_exceeded', 'billing_hard_limit_reached', 'billing_not_active']);

async function classifyHttpError(
  transport: HttpTransportOptions,
  response: Response,
  ctx: { model: string; requestId: string },
): Promise<Error> {
  const { providerId, displayName, secrets } = transport;
  const status = response.status;
  const raw = await response.text().catch(() => '');
  let providerCode: string | undefined;
  let providerMessage = '';
  let details: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const e = (parsed as { error?: unknown } | null)?.error;
    if (typeof e === 'string') {
      // Ollama-style `{ "error": "message" }`.
      providerMessage = e;
    } else if (e !== null && typeof e === 'object') {
      const err = e as { status?: unknown; code?: unknown; type?: unknown; message?: unknown; details?: unknown };
      const rawCode = [err.status, err.code, err.type].find((v): v is string => typeof v === 'string');
      // Vendor-controlled string that is logged and embedded in messages: accept only a short enum-like token, else drop it.
      providerCode =
        rawCode !== undefined && /^[A-Za-z0-9_.:-]{1,64}$/.test(rawCode) && redactSecrets(rawCode, secrets) === rawCode
          ? rawCode
          : undefined;
      providerMessage = typeof err.message === 'string' ? err.message : '';
      details = Array.isArray(err.details) ? err.details : [];
    }
  } catch {
    /* non-JSON error body: classify by HTTP status alone; the body is discarded, never echoed */
  }
  const safeMessage = truncate(redactVendorText(providerMessage, secrets), 300);
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
    providerFailure(category, providerId, `${message} (HTTP ${status}${providerCode ? ` ${providerCode}` : ''})`, base);

  if (
    status === 401 ||
    code === 'authentication' ||
    code === 'unauthenticated' ||
    code === 'authentication_error' ||
    code === 'invalid_api_key' ||
    lowerMsg.includes('api key not valid') ||
    lowerMsg.includes('api_key_invalid') ||
    lowerMsg.includes('api key expired')
  ) {
    return fail('authentication', `${displayName} rejected the API key`);
  }
  if (CONTENT_FILTER_CODES.has(code)) return fail('content_blocked', `${displayName} blocked the request (content filter)`);
  if (status === 403 || code === 'permission_denied' || code === 'permission_error') {
    return fail('permission_denied', `${displayName} denied permission for this key/project`);
  }
  if (status === 404 || code === 'model_not_found' || code === 'not_found' || code === 'not_found_error' || code === 'deploymentnotfound') {
    return fail('unsupported_model', `${displayName} does not recognise model "${truncate(ctx.model, 80)}"`);
  }
  if (status === 429) {
    const quota = QUOTA_CODES.has(code) || /per\s?day|daily|exceeded your current quota/.test(lowerMsg);
    return quota ? fail('quota_exhausted', `${displayName} quota exhausted`) : fail('rate_limited', `${displayName} rate limit hit`);
  }
  if (status === 400 && (QUOTA_CODES.has(code) || lowerMsg.includes('billing') || lowerMsg.includes('not available in your country'))) {
    return fail('permission_denied', `${displayName} request failed a precondition (region/billing)`);
  }
  if (status === 400 || status === 413 || status === 416 || status === 422)
    return fail('invalid_request', `${displayName} rejected the request`);
  if (status === 501) return fail('unsupported_feature', `${displayName} does not implement the requested operation`);
  if (status === 504 || code === 'deadline_exceeded') return fail('timeout', `${displayName} reported a deadline exceeded`);
  // 5xx (including 502/503 and Anthropic's 529 "overloaded") is transient.
  if (status >= 500) return fail('transient', `${displayName} server error`);
  return fail('invalid_request', `${displayName} returned an unexpected status`);
}

// ---- helpers ------------------------------------------------------------------

/**
 * `redactSecrets` (exact credentials + Google-key/auth-header patterns) plus patterns for the other vendors' key shapes
 * (`sk-…`, `sk-ant-…`, `Bearer …`), because vendors sometimes echo a (partially masked) key in a 401 message. Kept local so the
 * shared `redaction.ts` — and therefore Gemini's behavior — is unchanged.
 */
export function redactVendorText(text: string, secrets: readonly string[]): string {
  // The vendor-specific patterns run FIRST: `redactSecrets`' auth-header pattern would otherwise consume only the word
  // "Bearer" in `Authorization: Bearer <token>` and leave the token itself behind.
  const preRedacted = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '[REDACTED]');
  return redactSecrets(preRedacted, secrets);
}

export function sanitizeCause(error: unknown, secrets: readonly string[]): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(truncate(redactVendorText(message, secrets), 200));
}

export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Reads Google's `google.rpc.RetryInfo` detail (`retryDelay: "12s"`) from an error body, if a vendor sends one. */
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

/** Sleeps `ms`, resolving early if the caller aborts (the next attempt's pre-flight abort check then throws `aborted`). */
function abortAwareSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---- response-normalization helpers shared by the adapters -----------------------

export function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
