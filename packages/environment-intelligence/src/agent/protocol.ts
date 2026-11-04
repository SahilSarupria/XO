import { err, ok, type Result } from '@xo/types';
import { DiscoveryErrorCode, discoveryError, type DiscoveryError } from '../errors.js';
import { isStateRepresentableId } from '../state-journal.js';

/**
 * C2 - Linux Local Agent wire protocol (version 1).
 *
 * Length-prefixed JSON over a Unix domain socket: a 4-byte big-endian length, then that many bytes of UTF-8 JSON. The decoder is
 * incremental and enforces the size cap BEFORE buffering a frame, so an oversized or lying length prefix costs the agent nothing.
 *
 * The schema is closed and strict: every message names exactly the fields it may carry and ANY other field is rejected. There is
 * deliberately no field that carries identity (a principal, a user, a token): the caller's identity is established by the agent
 * from the socket's trust boundary, never read from a message. There is no field that carries limits or exclusions either, so a
 * caller can only narrow what the agent's own configuration allows, never widen it. There is no command, shell or exec verb.
 */
export const AGENT_PROTOCOL_VERSION = 1;
/** Hard cap on one request frame. Requests are small (a root path and at most {@link MAX_RESOURCE_KEYS} keys). */
export const MAX_REQUEST_BYTES = 64 * 1024;
/** Hard cap on one response frame. A result that would exceed it is withheld and reported as an error, never truncated into a success. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_RESOURCE_KEYS = 50;
export const MAX_RESOURCE_KEY_LENGTH = 1024;
export const MAX_ROOT_LENGTH = 4096;

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface AgentScope {
  readonly kind: 'filesystem_root';
  readonly root: string;
}

export interface DiscoverMessage {
  readonly v: 1;
  readonly id: string;
  readonly op: 'discover';
  readonly scope: AgentScope;
}

export interface AcquireMessage {
  readonly v: 1;
  readonly id: string;
  readonly op: 'acquire';
  readonly sourceId: string;
  readonly scope: AgentScope;
  readonly resourceKeys: readonly string[];
}

export interface CancelMessage {
  readonly v: 1;
  readonly op: 'cancel';
  readonly id: string;
}

export type AgentRequest = DiscoverMessage | AcquireMessage | CancelMessage;

const malformed = (what: string): DiscoveryError =>
  discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'the agent request is not valid', { what });

const hasNul = (s: string): boolean => s.includes('\u0000');

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** A message may carry exactly the listed fields; anything else (a principal, limits, a command) is refused. */
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(value, k)); // ENFORCE:unknown_fields
}

function parseScope(value: unknown): Result<AgentScope, DiscoveryError> {
  if (!isPlainObject(value)) return err(malformed('scope'));
  if (!exactKeys(value, ['kind', 'root'])) return err(malformed('scope_fields'));
  const { kind, root } = value;
  if (kind !== 'filesystem_root') return err(malformed('scope_kind'));
  if (typeof root !== 'string' || root.length === 0 || root.length > MAX_ROOT_LENGTH || hasNul(root)) return err(malformed('scope_root'));
  return ok({ kind: 'filesystem_root', root });
}

/** The request id, when one can be read from a message that otherwise failed validation (so the error can be correlated). */
export function requestIdOf(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined;
  const id = value['id'];
  return typeof id === 'string' && REQUEST_ID.test(id) ? id : undefined;
}

export function parseRequest(value: unknown): Result<AgentRequest, DiscoveryError> {
  if (!isPlainObject(value)) return err(malformed('message'));
  if (value['v'] !== AGENT_PROTOCOL_VERSION) return err(malformed('version'));
  const id = value['id'];
  if (typeof id !== 'string' || !REQUEST_ID.test(id)) return err(malformed('id'));
  const op = value['op'];
  if (op === 'cancel') {
    if (!exactKeys(value, ['v', 'op', 'id'])) return err(malformed('cancel_fields'));
    return ok({ v: 1, op: 'cancel', id });
  }
  if (op === 'discover') {
    if (!exactKeys(value, ['v', 'id', 'op', 'scope'])) return err(malformed('discover_fields'));
    const scope = parseScope(value['scope']);
    if (!scope.ok) return scope;
    return ok({ v: 1, id, op: 'discover', scope: scope.value });
  }
  if (op === 'acquire') {
    if (!exactKeys(value, ['v', 'id', 'op', 'sourceId', 'scope', 'resourceKeys'])) return err(malformed('acquire_fields'));
    const sourceId = value['sourceId'];
    if (typeof sourceId !== 'string' || hasNul(sourceId) || !isStateRepresentableId(sourceId)) return err(malformed('sourceId'));
    const scope = parseScope(value['scope']);
    if (!scope.ok) return scope;
    const keys = value['resourceKeys'];
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_RESOURCE_KEYS) return err(malformed('resourceKeys'));
    for (const key of keys as unknown[]) {
      if (typeof key !== 'string' || key.length === 0 || key.length > MAX_RESOURCE_KEY_LENGTH || hasNul(key))
        return err(malformed('resourceKey'));
    }
    return ok({ v: 1, id, op: 'acquire', sourceId, scope: scope.value, resourceKeys: [...(keys as string[])] });
  }
  return err(discoveryError(DiscoveryErrorCode.UNSUPPORTED_OPERATION, 'the agent does not support this operation', {}));
}

// ── framing ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function encodeFrame(body: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  frame.set(body, 4);
  return frame;
}

export type FrameResult =
  { readonly ok: true; readonly frames: readonly Buffer[] } | { readonly ok: false; readonly reason: 'too_large' | 'empty' };

/** Incremental length-prefixed frame decoder with the cap enforced on the declared length, before any payload is buffered. */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes: number) {}

  /** True when a partial frame is buffered (used for the incomplete-frame deadline). */
  get pending(): boolean {
    return this.buffer.length > 0;
  }

  push(chunk: Buffer): FrameResult {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Buffer[] = [];
    for (;;) {
      if (this.buffer.length < 4) break;
      const length = this.buffer.readUInt32BE(0);
      if (length === 0) return { ok: false, reason: 'empty' };
      if (length > this.maxFrameBytes) return { ok: false, reason: 'too_large' }; // ENFORCE:size_cap
      if (this.buffer.length < 4 + length) break;
      frames.push(this.buffer.subarray(4, 4 + length));
      this.buffer = this.buffer.subarray(4 + length);
    }
    return { ok: true, frames };
  }
}

/** Strict UTF-8 JSON decode of one frame. */
export function decodeJson(frame: Buffer): Result<unknown, DiscoveryError> {
  try {
    return ok(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)) as unknown);
  } catch {
    return err(malformed('json'));
  }
}

// ── responses ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AgentErrorBody {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly context: Readonly<Record<string, string | number | boolean | null>>;
}

export type AgentResponse<T = unknown> =
  | { readonly v: 1; readonly id: string | null; readonly ok: true; readonly result: T }
  | { readonly v: 1; readonly id: string | null; readonly ok: false; readonly error: AgentErrorBody };

export const errorBody = (e: DiscoveryError): AgentErrorBody => ({
  code: e.code,
  message: e.message,
  retryable: e.retryable,
  context: e.context,
});
