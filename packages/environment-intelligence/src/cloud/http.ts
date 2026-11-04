import { err, ok, type Result } from '@xo/types';
import { revealSecret, type Secret } from './secret.js';

/**
 * C3: the single outbound HTTP seam of Environment Intelligence. Not a general HTTP client.
 *
 * `PinnedHttpsTransport` only ever talks to an explicit host allow-list over HTTPS: no redirects (a redirect could carry a bearer
 * token to a host nobody approved), no cookies, no credentials in the URL, no non-default port, a hard timeout, and a hard cap on the
 * response body. Failures are FIXED codes: the URL, headers, status text and body are never echoed, so a provider response cannot
 * put a token, a path or free text into an error or a log.
 *
 * It uses the platform `fetch` (no new dependency); `fetchImpl` is injectable so the request shaping is testable offline.
 */
export type TransportFailureCode = 'blocked_url' | 'network' | 'timeout' | 'cancelled' | 'too_large' | 'not_json';
export interface TransportFailure {
  readonly code: TransportFailureCode;
}

export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly bearer?: Secret;
  readonly form?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  /** Parsed JSON, or `undefined` for an empty body. Untrusted: callers validate every field they use. */
  readonly body: unknown;
}

export interface HttpTransport {
  send(request: HttpRequest): Promise<Result<HttpResponse, TransportFailure>>;
}

export interface PinnedHttpsOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;
const fail = (code: TransportFailureCode): Result<never, TransportFailure> => err({ code });

export class PinnedHttpsTransport implements HttpTransport {
  private readonly hosts: ReadonlySet<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(allowedHosts: readonly string[], options: PinnedHttpsOptions = {}) {
    this.hosts = new Set(allowedHosts.map((h) => h.toLowerCase()));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    this.maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  async send(request: HttpRequest): Promise<Result<HttpResponse, TransportFailure>> {
    return this.sendInner(request);
  }

  private async sendInner(request: HttpRequest): Promise<Result<HttpResponse, TransportFailure>> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return fail('blocked_url');
    }
    // ENFORCE:http-url-pinning
    if (
      url.protocol !== 'https:' ||
      !this.hosts.has(url.hostname.toLowerCase()) ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.hash !== ''
    )
      return fail('blocked_url');
    if (isAborted(request.signal)) return fail('cancelled');

    // A ref'd timer (AbortSignal.timeout is unref'd and could let the process exit mid-request).
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), this.timeoutMs);
    const timeout = timeoutController.signal;
    const signal = request.signal === undefined ? timeout : AbortSignal.any([timeout, request.signal]);
    try {
      return await this.exchange(request, url, signal, timeout);
    } finally {
      clearTimeout(timer);
    }
  }

  private async exchange(
    request: HttpRequest,
    url: URL,
    signal: AbortSignal,
    timeout: AbortSignal,
  ): Promise<Result<HttpResponse, TransportFailure>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    let body: string | undefined;
    if (request.form !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(request.form as Record<string, string>).toString();
    }
    if (request.bearer !== undefined) headers['authorization'] = `Bearer ${revealSecret(request.bearer)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: request.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: 'error',
        credentials: 'omit',
        signal,
      });
    } catch {
      if (timeout.aborted) return fail('timeout');
      if (isAborted(request.signal)) return fail('cancelled');
      return fail('network');
    }
    try {
      const text = await this.readBounded(response, signal);
      // ENFORCE:http-size-cap
      if (text === undefined) return fail('too_large');
      if (text.length === 0) return ok({ status: response.status, body: undefined });
      const type = response.headers.get('content-type') ?? '';
      // ENFORCE:http-json-only
      if (!/^application\/(?:[a-z0-9.+-]+\+)?json\b/i.test(type)) return fail('not_json');
      try {
        return ok({ status: response.status, body: JSON.parse(text) as unknown });
      } catch {
        return fail('not_json');
      }
    } catch {
      if (timeout.aborted) return fail('timeout');
      if (isAborted(request.signal)) return fail('cancelled');
      return fail('network');
    }
  }

  /** Reads at most `maxBytes`; `undefined` when the body is larger (the stream is cancelled, not drained). */
  private async readBounded(response: Response, signal: AbortSignal): Promise<string | undefined> {
    const reader = response.body?.getReader();
    if (reader === undefined) return '';
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      if (signal.aborted) throw new Error('aborted');
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}
