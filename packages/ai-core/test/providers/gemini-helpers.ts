import type { Logger, LogFields, LogLevel } from '@xo/logger';

export const TEST_API_KEY = 'AIzaSyTESTKEY0123456789abcdefghijklmno';

export interface RecordedCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
  readonly rawBody: string;
}

export type Step = Response | Error | ((call: RecordedCall, init: RequestInit) => Response | Promise<Response>);

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function okText(
  text: string,
  usage: Record<string, unknown> | null = { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  finishReason = 'STOP',
): Response {
  return json({
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason }],
    ...(usage ? { usageMetadata: usage } : {}),
  });
}

export function errorBody(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return json({ error: { code: status, status: code, message, ...extra } }, status, headers);
}

/** A scripted `fetch`: each call consumes the next step; records every call for assertions. Never touches the network. */
export function scriptedFetch(steps: Step[]): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const rawBody = typeof init.body === 'string' ? init.body : '';
    const call: RecordedCall = {
      url: String(input),
      headers,
      body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {},
      rawBody,
    };
    calls.push(call);
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step === undefined) throw new Error('scriptedFetch: no steps');
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(call, init) : step.clone();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export function hangUntilAborted(_call: RecordedCall, init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true });
  });
}

export interface CapturedLog {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

export function capturingLogger(): { logger: Logger; records: CapturedLog[] } {
  const records: CapturedLog[] = [];
  const make = (bound: LogFields): Logger => {
    const log =
      (level: LogLevel) =>
      (message: string, fields?: LogFields): void => {
        records.push({ level, message, fields: { ...bound, ...fields } });
      };
    return {
      level: 'trace',
      trace: log('trace'),
      debug: log('debug'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
      fatal: log('fatal'),
      child: (fields: LogFields) => make({ ...bound, ...fields }),
    };
  };
  return { logger: make({}), records };
}

export const noSleep = { sleep: async (): Promise<void> => {}, jitter: (ms: number): number => ms };
