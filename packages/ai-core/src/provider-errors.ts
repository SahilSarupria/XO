import { AiError, ErrorCode } from '@xo/errors';
import type { ProviderId } from './provider-types.js';

/**
 * Normalized, vendor-neutral failure categories. A category tells a caller
 * (and the router) what KIND of failure happened and whether retrying the
 * identical request could plausibly help — without leaking vendor error
 * strings into call sites.
 */
export type ProviderFailureCategory =
  | 'invalid_request' // bad request or bad local configuration; never retried
  | 'authentication' // missing/invalid credential; never retried
  | 'permission_denied' // credential valid but not allowed (region, billing precondition, API disabled); never retried
  | 'rate_limited' // short-window limit (per minute/second); retryable with backoff / Retry-After
  | 'quota_exhausted' // longer-window quota (e.g. daily); never retried
  | 'timeout' // no response within the configured deadline; retryable (bounded)
  | 'transient' // 5xx / network failure; retryable (bounded)
  | 'aborted' // the caller aborted; never retried
  | 'unsupported_model' // unknown/unavailable model id; never retried
  | 'unsupported_feature' // request needs a feature this provider/model lacks; never retried
  | 'malformed_response' // unparseable, schema-invalid or otherwise unusable body
  | 'empty_response' // success status but no usable text
  | 'content_blocked' // vendor safety/policy filter blocked the output; never retried
  | 'output_truncated'; // the vendor stopped at the output-token limit; the body is incomplete and deterministic to reproduce, so never retried

const RETRYABLE_AT_TRANSPORT: ReadonlySet<ProviderFailureCategory> = new Set(['rate_limited', 'timeout', 'transient']);

export function isTransportRetryable(category: ProviderFailureCategory): boolean {
  return RETRYABLE_AT_TRANSPORT.has(category);
}

/** Structured, secret-free diagnostic context attached to every provider-originated `AiError`. */
export interface ProviderFailureContext {
  readonly providerFailure: true;
  readonly category: ProviderFailureCategory;
  readonly providerId: ProviderId;
  readonly model?: string;
  readonly requestId?: string;
  readonly httpStatus?: number;
  /** Vendor's own machine-readable status/code string, if any (e.g. "RESOURCE_EXHAUSTED"). */
  readonly providerCode?: string;
  readonly retryAfterMs?: number;
  readonly attempts?: number;
  /** Redacted, truncated vendor message — diagnostic only. */
  readonly providerMessage?: string;
}

export type ProviderFailureDetails = Omit<ProviderFailureContext, 'providerFailure' | 'category' | 'providerId'>;

/**
 * Builds the `AiError` every adapter throws. Reuses the existing error codes
 * (rate-limit-like → `AI_RATE_LIMITED`, everything else →
 * `AI_PROVIDER_REQUEST_FAILED`) so no shared `@xo/errors` change is needed;
 * the precise category lives in `error.context.category`.
 */
export function providerFailure(
  category: ProviderFailureCategory,
  providerId: ProviderId,
  message: string,
  details: ProviderFailureDetails = {},
  cause?: unknown,
): AiError {
  const code =
    category === 'rate_limited' || category === 'quota_exhausted' ? ErrorCode.AI_RATE_LIMITED : ErrorCode.AI_PROVIDER_REQUEST_FAILED;
  const context: ProviderFailureContext = { providerFailure: true, category, providerId, ...details };
  return new AiError(code, message, { context: { ...context }, ...(cause !== undefined ? { cause } : {}) });
}

/** Type guard / accessor: returns the failure context when `error` came from a provider adapter, else `undefined`. */
export function getProviderFailure(error: unknown): ProviderFailureContext | undefined {
  if (!(error instanceof AiError)) return undefined;
  const ctx = error.context as Partial<ProviderFailureContext>;
  return ctx.providerFailure === true && typeof ctx.category === 'string' ? (ctx as ProviderFailureContext) : undefined;
}
