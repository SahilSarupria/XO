import type { McpConfig } from './config.js';

/**
 * P1.1 M5 — the ONLY path from the adapter to XO. There is no runtime, adapter or store import anywhere in this package: every
 * discovery and every invocation is an authenticated HTTP request to the XO API, which re-resolves, re-authorizes and audits it.
 */

export type ApiResult =
  | { readonly kind: 'ok'; readonly status: number; readonly body: unknown }
  /** The API answered with a non-2xx status. `code`/`message` are the API's own stable error fields, passed through verbatim. */
  | { readonly kind: 'api_error'; readonly status: number; readonly code: string | undefined; readonly message: string | undefined }
  /** No usable answer: the request may or may not have been processed. NEVER interpret this as "failed" or "not run". */
  | { readonly kind: 'no_answer'; readonly reason: 'timeout' | 'cancelled' | 'network' | 'unreadable_response' };

export interface XoApi {
  listProcedures(signal: AbortSignal): Promise<ApiResult>;
  getProcedure(procedureId: string, version: number, signal: AbortSignal): Promise<ApiResult>;
  startProcedure(
    procedureId: string,
    version: number,
    input: Readonly<Record<string, unknown>>,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<ApiResult>;
}

/** A response above this size is treated as unreadable rather than buffered. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

async function readCapped(res: Response): Promise<string | undefined> {
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function errorFields(body: unknown): { code: string | undefined; message: string | undefined } {
  if (typeof body !== 'object' || body === null) return { code: undefined, message: undefined };
  const e = (body as Record<string, unknown>)['error'];
  if (typeof e !== 'object' || e === null) return { code: undefined, message: undefined };
  const r = e as Record<string, unknown>;
  return {
    code: typeof r['code'] === 'string' ? r['code'].slice(0, 128) : undefined,
    message: typeof r['message'] === 'string' ? r['message'].slice(0, 512) : undefined,
  };
}

export class HttpXoApi implements XoApi {
  constructor(
    private readonly config: McpConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private ws(path: string): string {
    return `${this.config.apiBaseUrl}/workspaces/${encodeURIComponent(this.config.workspaceId)}${path}`;
  }

  private async send(
    method: 'GET' | 'POST',
    url: string,
    signal: AbortSignal,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<ApiResult> {
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        redirect: 'error', // a redirect would forward the credential to another origin
        signal: combined,
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...extra,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      // Nothing about the thrown value is surfaced (it could echo the URL or request details).
      if (timeout.aborted) return { kind: 'no_answer', reason: 'timeout' };
      if (signal.aborted) return { kind: 'no_answer', reason: 'cancelled' };
      return { kind: 'no_answer', reason: 'network' };
    }
    let text: string | undefined;
    try {
      text = await readCapped(res);
    } catch {
      if (timeout.aborted) return { kind: 'no_answer', reason: 'timeout' };
      if (signal.aborted) return { kind: 'no_answer', reason: 'cancelled' };
      return { kind: 'no_answer', reason: 'unreadable_response' };
    }
    let parsed: unknown;
    if (text !== undefined && text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (res.status >= 200 && res.status < 300) {
      if (text === undefined || parsed === undefined) return { kind: 'no_answer', reason: 'unreadable_response' };
      return { kind: 'ok', status: res.status, body: parsed };
    }
    return { kind: 'api_error', status: res.status, ...errorFields(parsed) };
  }

  listProcedures(signal: AbortSignal): Promise<ApiResult> {
    return this.send('GET', this.ws('/procedures'), signal);
  }

  getProcedure(procedureId: string, version: number, signal: AbortSignal): Promise<ApiResult> {
    return this.send('GET', `${this.ws(`/procedures/${encodeURIComponent(procedureId)}`)}?version=${version}`, signal);
  }

  startProcedure(
    procedureId: string,
    version: number,
    input: Readonly<Record<string, unknown>>,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<ApiResult> {
    return this.send(
      'POST',
      this.ws(`/procedures/${encodeURIComponent(procedureId)}/versions/${version}/executions`),
      signal,
      { input },
      {
        'idempotency-key': idempotencyKey,
      },
    );
  }
}
