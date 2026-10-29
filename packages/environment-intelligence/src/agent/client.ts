import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { err, ok, type Result } from '@xo/types';
import { DiscoveryErrorCode, discoveryError, type DiscoveryError } from '../errors.js';
import type { Evidence } from '../evidence.js';
import {
  AGENT_PROTOCOL_VERSION,
  FrameDecoder,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  decodeJson,
  encodeFrame,
  type AgentScope,
} from './protocol.js';
import { verifySocketForConnect } from './socket-guard.js';

/** What one agent call asks for. The agent decides identity and limits; the call can carry neither. */
export type AgentCall =
  | { readonly op: 'discover'; readonly scope: AgentScope }
  | { readonly op: 'acquire'; readonly sourceId: string; readonly scope: AgentScope; readonly resourceKeys: readonly string[] };

export interface AgentResultBody {
  readonly sourceId: string;
  readonly status?: string;
  readonly partial: boolean;
  readonly evidence: readonly Evidence[];
  readonly skipped: unknown;
  readonly limits: unknown;
  readonly errors: readonly unknown[];
}

export interface CallOptions {
  /** Reuse the same id to retry the SAME request idempotently. Defaults to a fresh random id. */
  readonly id?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const KNOWN_CODES: ReadonlySet<string> = new Set(Object.values(DiscoveryErrorCode));

const fail = (
  code: DiscoveryErrorCode,
  message: string,
  context: Record<string, string | number | boolean> = {},
): Result<never, DiscoveryError> => err(discoveryError(code, message, context));

/**
 * One request over one connection. Before connecting it re-verifies the socket trust boundary (private owned directory, private owned
 * socket), so a socket path alone is never trusted. Cancellation or a local timeout sends a `cancel` and returns an ERROR at once: a
 * call that did not complete is never reported as success.
 */
export async function callAgent(
  socketPath: string,
  call: AgentCall,
  options: CallOptions = {},
): Promise<Result<AgentResultBody, DiscoveryError>> {
  const id = options.id ?? randomUUID();
  const verified = await verifySocketForConnect(socketPath);
  if (!verified.ok) return verified;
  if (options.signal?.aborted === true) return fail(DiscoveryErrorCode.CANCELLED, 'cancelled before the request was sent');

  const body = Buffer.from(JSON.stringify({ v: AGENT_PROTOCOL_VERSION, id, ...call }), 'utf8');
  if (body.length > MAX_REQUEST_BYTES)
    return fail(DiscoveryErrorCode.MALFORMED_INPUT, 'the request is too large', { what: 'request_too_large' });

  return new Promise((resolveCall) => {
    const socket = connect(socketPath);
    const decoder = new FrameDecoder(MAX_RESPONSE_BYTES);
    let settled = false;
    const finish = (result: Result<AgentResultBody, DiscoveryError>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      resolveCall(result);
    };
    const abandon = (result: Result<never, DiscoveryError>): void => {
      if (!socket.destroyed && socket.writable)
        socket.write(encodeFrame(Buffer.from(JSON.stringify({ v: AGENT_PROTOCOL_VERSION, op: 'cancel', id }))));
      finish(result);
    };
    const onAbort = (): void =>
      abandon(fail(DiscoveryErrorCode.CANCELLED, 'the request was cancelled and was not completed', { reason: 'cancelled' }));
    const timer = setTimeout(
      () =>
        abandon(
          fail(DiscoveryErrorCode.LIMIT_EXCEEDED, 'the request exceeded its time limit and was not completed', { limit: 'client_timeout' }),
        ),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    options.signal?.addEventListener('abort', onAbort, { once: true });

    socket.once('connect', () => socket.write(encodeFrame(body)));
    socket.once('error', () => finish(fail(DiscoveryErrorCode.CONNECTION_FAILED, 'could not reach the local agent')));
    socket.once('close', () => finish(fail(DiscoveryErrorCode.CONNECTION_FAILED, 'the agent closed the connection before answering')));
    socket.on('data', (chunk: Buffer) => {
      const framed = decoder.push(chunk);
      if (!framed.ok)
        return finish(fail(DiscoveryErrorCode.MALFORMED_INPUT, 'the agent response is not valid', { what: 'response_frame' }));
      for (const frame of framed.frames) {
        const json = decodeJson(frame);
        if (!json.ok) return finish(json);
        const reply = interpret(json.value, id);
        if (reply !== undefined) return finish(reply);
      }
    });
  });
}

/** `undefined` = a reply for a different request id (ignored). Anything not exactly the documented shape is an error, never a success. */
function interpret(value: unknown, id: string): Result<AgentResultBody, DiscoveryError> | undefined {
  const bad = fail(DiscoveryErrorCode.MALFORMED_INPUT, 'the agent response is not valid', { what: 'response_shape' });
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return bad;
  const r = value as Record<string, unknown>;
  if (r['v'] !== AGENT_PROTOCOL_VERSION) return bad;
  if (r['id'] !== id && r['id'] !== null) return undefined;
  if (r['ok'] === true) {
    const result = r['result'];
    if (r['id'] !== id || typeof result !== 'object' || result === null || Array.isArray(result)) return bad;
    const o = result as Record<string, unknown>;
    if (typeof o['sourceId'] !== 'string' || typeof o['partial'] !== 'boolean' || !Array.isArray(o['evidence'])) return bad;
    return ok(o as unknown as AgentResultBody);
  }
  const e = r['error'];
  if (r['ok'] !== false || typeof e !== 'object' || e === null) return bad;
  const code = (e as { code?: unknown }).code;
  const message = (e as { message?: unknown }).message;
  const context = (e as { context?: unknown }).context;
  if (typeof code !== 'string' || !KNOWN_CODES.has(code) || typeof message !== 'string') return bad;
  const safeContext: Record<string, string | number | boolean | null> = {};
  if (typeof context === 'object' && context !== null) {
    for (const [k, v] of Object.entries(context as Record<string, unknown>)) {
      if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') safeContext[k] = v;
    }
  }
  return err(discoveryError(code as DiscoveryErrorCode, message, safeContext));
}
