import { chmod, unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { establishAuthenticatedPrincipal, type Principal } from '@xo/permissions';
import { err, ok, type Result } from '@xo/types';
import type { AuditRecorder } from '../audit.js';
import type { AuditOptions } from '../audited-operation.js';
import type { AuthorizationPort } from '../authorization.js';
import type { Clock, ConnectorContext } from '../connector.js';
import { DiscoveryErrorCode, discoveryError, internalError, type DiscoveryError } from '../errors.js';
import type { Evidence } from '../evidence.js';
import type { EvidenceLedger } from '../evidence-ledger.js';
import type { FilesystemLimits, FilesystemScope } from '../filesystem/config.js';
import { SourceId, stableDigest } from '../ids.js';
import { acquireSourceContent, discoverSource, type DiscoveryDeps } from '../orchestrator.js';
import { trustFromContext, type EiStateStore } from '../state-journal.js';
import {
  AGENT_PROTOCOL_VERSION,
  FrameDecoder,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  decodeJson,
  encodeFrame,
  errorBody,
  parseRequest,
  requestIdOf,
  type AcquireMessage,
  type AgentResponse,
  type DiscoverMessage,
} from './protocol.js';
import {
  checkSocketFile,
  ensurePrivateDirectory,
  removeStaleSocket,
  requireLinux,
  socketPathIn,
  validateSocketPath,
} from './socket-guard.js';

/**
 * C2 - Linux Local Agent: a long-lived local process that serves exactly two read-only operations, `discover` and `acquire`, over
 * a private Unix domain socket. It is a TRANSPORT and a TRUST BOUNDARY around the existing, C1-enforced pipeline; it adds no new
 * way to read anything:
 *
 *   socket (private dir, 0700 / 0600, re-verified) -> strict schema -> `discoverSource` / `acquireSourceContent`
 *     -> `runEnforced` (authorization verified honoured, audit attempt + terminal verified, evidence identity checked, rejected
 *        evidence quarantined) -> response
 *
 * Identity: the agent mints ONE service principal for itself with `establishAuthenticatedPrincipal` at startup and uses it for every
 * request. The wire protocol has no identity field, so a caller can neither supply nor choose a principal. What the caller may read is
 * decided by the injected `AuthorizationPort` (the existing gate), not by the agent and not by the request.
 *
 * Nothing here reads content directly, executes anything, spawns a process, or opens a network listener.
 */

export interface LocalAgentOptions {
  /** Private directory that will hold the socket. Created (0700) if absent; refused unless private, owned by this uid and symlink-free. */
  readonly socketDir: string;
  readonly socketName?: string;
  readonly deps: DiscoveryDeps;
  readonly clock: Clock;
  /** The existing authorization gate's port. The agent has no allow-list of its own. */
  readonly authorization: AuthorizationPort;
  /** REQUIRED: with no audit recorder the agent does not start (protected operations would be refused anyway). */
  readonly audit: AuditRecorder;
  readonly ledger: EvidenceLedger;
  /** Optional durable lifecycle store (C0.4). When given it must be started and attached to `ledger`; otherwise requests fail closed. */
  readonly state?: EiStateStore;
  readonly auditOptions?: AuditOptions;
  /** Limits applied to every filesystem request. Callers cannot widen or change them. */
  readonly limits?: Partial<FilesystemLimits>;
  readonly requestTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly frameDeadlineMs?: number;
  readonly maxConnections?: number;
  readonly maxInFlightPerConnection?: number;
  readonly idempotencyCacheSize?: number;
  /** Cap on one response frame (default and maximum {@link MAX_RESPONSE_BYTES}). Larger results are withheld, never truncated. */
  readonly maxResponseBytes?: number;
  /** Id of the agent's own service principal. Defaults to `local-agent-uid-<euid>`. */
  readonly principalId?: string;
}

const DEFAULTS = {
  requestTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
  frameDeadlineMs: 10_000,
  maxConnections: 16,
  maxInFlightPerConnection: 4,
  idempotencyCacheSize: 128,
  maxResponseBytes: MAX_RESPONSE_BYTES,
} as const;
const MAX_REQUEST_TIMEOUT_MS = 300_000;

type AbortReason = 'cancelled' | 'timeout' | 'shutdown' | 'disconnect';

interface Connection {
  readonly socket: Socket;
  readonly decoder: FrameDecoder;
  readonly inflight: Map<string, AbortController & { reason?: AbortReason }>;
  frameTimer: NodeJS.Timeout | undefined;
}

interface Executed {
  readonly result: Record<string, unknown>;
  /** Evidence this result carries, so it can be contained if the result is discarded after the connector already released it. */
  readonly evidence: readonly Evidence[];
}

interface CacheEntry {
  readonly digest: string;
  /** Present once the request finished successfully. In-flight and failed requests are not cached. */
  response: AgentResponse | undefined;
}

const abortError = (reason: AbortReason): DiscoveryError =>
  reason === 'timeout'
    ? discoveryError(DiscoveryErrorCode.LIMIT_EXCEEDED, 'the request exceeded its time limit and was not completed', {
        limit: 'request_timeout',
      })
    : discoveryError(DiscoveryErrorCode.CANCELLED, 'the request was cancelled and was not completed', { reason });

const malformed = (what: string): DiscoveryError =>
  discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'the agent request is not valid', { what });

function positive(value: number | undefined, fallback: number, max: number): number | undefined {
  if (value === undefined) return fallback;
  return Number.isInteger(value) && value > 0 && value <= max ? value : undefined;
}

export class LocalAgent {
  private readonly connections = new Set<Connection>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly active = new Set<Promise<void>>();
  private stopping: Promise<void> | undefined;
  private containmentFailureCount = 0;

  private constructor(
    private readonly server: Server,
    readonly socketPath: string,
    private readonly principal: Principal,
    private readonly options: LocalAgentOptions,
    private readonly cfg: Readonly<Record<keyof typeof DEFAULTS, number>>,
  ) {}

  /** How many discarded results the agent could not contain (should stay 0). Counts only; never content. */
  get containmentFailures(): number {
    return this.containmentFailureCount;
  }

  static async start(options: LocalAgentOptions): Promise<Result<LocalAgent, DiscoveryError>> {
    const linux = requireLinux();
    if (!linux.ok) return linux;
    const cfg = {
      requestTimeoutMs: positive(options.requestTimeoutMs, DEFAULTS.requestTimeoutMs, MAX_REQUEST_TIMEOUT_MS),
      idleTimeoutMs: positive(options.idleTimeoutMs, DEFAULTS.idleTimeoutMs, 3_600_000),
      frameDeadlineMs: positive(options.frameDeadlineMs, DEFAULTS.frameDeadlineMs, 300_000),
      maxConnections: positive(options.maxConnections, DEFAULTS.maxConnections, 256),
      maxInFlightPerConnection: positive(options.maxInFlightPerConnection, DEFAULTS.maxInFlightPerConnection, 32),
      idempotencyCacheSize: positive(options.idempotencyCacheSize, DEFAULTS.idempotencyCacheSize, 4096),
      maxResponseBytes: positive(options.maxResponseBytes, DEFAULTS.maxResponseBytes, MAX_RESPONSE_BYTES),
    };
    if (Object.values(cfg).some((v) => v === undefined)) return err(malformed('agent_option'));
    const resolved = cfg as Record<keyof typeof DEFAULTS, number>;

    const euid = process.geteuid?.();
    if (euid === undefined) return err(discoveryError(DiscoveryErrorCode.UNSUPPORTED_OPERATION, 'the local agent needs a POSIX uid', {}));
    const minted = establishAuthenticatedPrincipal({ kind: 'service', id: options.principalId ?? `local-agent-uid-${euid}` });
    if (!minted.ok) return err(malformed('principal_id'));

    const socketPath = socketPathIn(options.socketDir, options.socketName ?? 'agent.sock');
    const shape = validateSocketPath(socketPath);
    if (!shape.ok) return shape;
    const dir = await ensurePrivateDirectory(options.socketDir, { create: true });
    if (!dir.ok) return dir;
    const stale = await removeStaleSocket(socketPath);
    if (!stale.ok) return stale;

    const server = createServer({ allowHalfOpen: false });
    const agent = new LocalAgent(server, socketPath, minted.value, options, resolved);
    server.on('connection', (socket) => agent.accept(socket));
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(socketPath, () => {
          server.off('error', rejectListen);
          resolveListen();
        });
      });
      await chmod(socketPath, 0o600);
    } catch {
      server.close();
      await unlink(socketPath).catch(() => undefined);
      return err(discoveryError(DiscoveryErrorCode.CONNECTION_FAILED, 'the agent could not bind its socket', {}));
    }
    const verified = await checkSocketFile(socketPath);
    if (!verified.ok) {
      server.close();
      await unlink(socketPath).catch(() => undefined);
      return verified;
    }
    server.on('error', () => undefined); // a late server error must never crash the process; connections handle their own
    return ok(agent);
  }

  /** Stops accepting, aborts in-flight requests (none is reported as success), waits for them to settle, removes the socket. Idempotent. */
  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    const closed = new Promise<void>((done) => this.server.close(() => done()));
    for (const c of this.connections) for (const ctl of c.inflight.values()) this.abort(ctl, 'shutdown');
    await Promise.allSettled([...this.active]);
    for (const c of this.connections) c.socket.destroy();
    await closed;
    await unlink(this.socketPath).catch(() => undefined);
  }

  // ── connections ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  private accept(socket: Socket): void {
    if (this.stopping !== undefined || this.connections.size >= this.cfg.maxConnections) {
      // ENFORCE:max_connections
      socket.destroy();
      return;
    }
    const conn: Connection = { socket, decoder: new FrameDecoder(MAX_REQUEST_BYTES), inflight: new Map(), frameTimer: undefined };
    this.connections.add(conn);
    socket.setTimeout(this.cfg.idleTimeoutMs, () => {
      if (conn.inflight.size === 0) socket.destroy();
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      if (conn.frameTimer !== undefined) clearTimeout(conn.frameTimer);
      for (const ctl of conn.inflight.values()) this.abort(ctl, 'disconnect');
      this.connections.delete(conn);
    });
    socket.on('data', (chunk: Buffer) => this.onData(conn, chunk));
  }

  private onData(conn: Connection, chunk: Buffer): void {
    const framed = conn.decoder.push(chunk);
    if (!framed.ok) {
      this.send(conn, null, err(malformed(framed.reason === 'too_large' ? 'frame_too_large' : 'frame_empty')));
      conn.socket.end();
      conn.socket.destroy();
      return;
    }
    if (conn.frameTimer !== undefined) clearTimeout(conn.frameTimer);
    conn.frameTimer = undefined;
    if (conn.decoder.pending) {
      // ENFORCE:frame_deadline - a peer that sends half a frame and stalls does not hold the connection.
      conn.frameTimer = setTimeout(() => conn.socket.destroy(), this.cfg.frameDeadlineMs);
      conn.frameTimer.unref();
    }
    for (const frame of framed.frames) {
      const json = decodeJson(frame);
      if (!json.ok) {
        this.send(conn, null, json);
        conn.socket.end();
        conn.socket.destroy();
        return;
      }
      this.dispatch(conn, json.value);
    }
  }

  private dispatch(conn: Connection, raw: unknown): void {
    const parsed = parseRequest(raw);
    if (!parsed.ok) {
      this.send(conn, requestIdOf(raw) ?? null, parsed);
      return;
    }
    const msg = parsed.value;
    if (msg.op === 'cancel') {
      const ctl = conn.inflight.get(msg.id);
      if (ctl !== undefined) this.abort(ctl, 'cancelled');
      return;
    }
    if (conn.inflight.size >= this.cfg.maxInFlightPerConnection) {
      // ENFORCE:max_in_flight
      this.send(
        conn,
        msg.id,
        err(discoveryError(DiscoveryErrorCode.LIMIT_EXCEEDED, 'too many requests in flight on this connection', { limit: 'in_flight' })),
      );
      return;
    }
    const task = this.handle(conn, msg).finally(() => this.active.delete(task));
    this.active.add(task);
  }

  private abort(ctl: AbortController & { reason?: AbortReason }, reason: AbortReason): void {
    if (ctl.signal.aborted) return;
    ctl.reason = reason;
    ctl.abort();
  }

  private send(conn: Connection, id: string | null, result: Result<unknown, DiscoveryError>): AgentResponse {
    const response: AgentResponse = result.ok
      ? { v: AGENT_PROTOCOL_VERSION, id, ok: true, result: result.value }
      : { v: AGENT_PROTOCOL_VERSION, id, ok: false, error: errorBody(result.error) };
    this.write(conn, response);
    return response;
  }

  private write(conn: Connection, response: AgentResponse): void {
    if (conn.socket.destroyed || !conn.socket.writable) return;
    conn.socket.write(encodeFrame(Buffer.from(JSON.stringify(response), 'utf8')));
  }

  // ── requests ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

  private async handle(conn: Connection, msg: DiscoverMessage | AcquireMessage): Promise<void> {
    const digest = stableDigest([JSON.stringify(msg)]);
    const known = this.cache.get(msg.id);
    if (known !== undefined) {
      // One id means one request; the same id with a different body is refused, never merged.
      if (known.digest !== digest) {
        // ENFORCE:idempotency_conflict
        this.send(conn, msg.id, err(malformed('request_id_reused_with_different_request')));
        return;
      }
      if (known.response !== undefined) {
        this.write(conn, known.response);
        return;
      }
      this.send(conn, msg.id, err(malformed('request_in_progress')));
      return;
    }
    this.remember(msg.id, { digest, response: undefined });

    const ctl: AbortController & { reason?: AbortReason } = new AbortController();
    conn.inflight.set(msg.id, ctl);
    const timer = setTimeout(() => this.abort(ctl, 'timeout'), this.cfg.requestTimeoutMs);
    const ctx = this.contextFor(ctl.signal);
    let outcome: Result<Record<string, unknown>, DiscoveryError>;
    try {
      const work = this.execute(msg, ctx).catch((e: unknown): Result<Executed, DiscoveryError> => err(internalError(e, 'local agent')));
      const aborted = new Promise<'aborted'>((done) => ctl.signal.addEventListener('abort', () => done('aborted'), { once: true }));
      const first = await Promise.race([work, aborted]);
      // A cancelled, timed-out or interrupted request is an error even if the connector later returns ok.
      // ENFORCE:abort_not_success
      if (first === 'aborted' || ctl.signal.aborted) {
        if (first !== 'aborted') await this.containResult(ctx, first);
        else void work.then((late) => this.containResult(ctx, late));
        outcome = err(abortError(ctl.reason ?? 'cancelled'));
      } else {
        outcome = first.ok ? await this.bounded(ctx, first.value) : first;
      }
    } finally {
      clearTimeout(timer);
      conn.inflight.delete(msg.id);
    }
    const response = this.send(conn, msg.id, outcome);
    if (outcome.ok) this.cacheSuccess(msg.id, response);
    else this.cache.delete(msg.id);
  }

  /** An over-size result is withheld (and contained), never truncated into a success. */
  private async bounded(ctx: ConnectorContext, executed: Executed): Promise<Result<Record<string, unknown>, DiscoveryError>> {
    if (Buffer.byteLength(JSON.stringify(executed.result), 'utf8') > this.cfg.maxResponseBytes - 1024) {
      // ENFORCE:response_cap
      await this.containResult(ctx, ok(executed));
      return err(
        discoveryError(DiscoveryErrorCode.LIMIT_EXCEEDED, 'the result is too large to return and was withheld', {
          limit: 'response_bytes',
        }),
      );
    }
    return ok(executed.result);
  }

  private contextFor(signal: AbortSignal): ConnectorContext {
    const o = this.options;
    return {
      clock: o.clock,
      authorization: o.authorization,
      principal: this.principal,
      audit: o.audit,
      ledger: o.ledger,
      signal,
      ...(o.state !== undefined ? { state: o.state } : {}),
      ...(o.auditOptions !== undefined ? { auditOptions: o.auditOptions } : {}),
    };
  }

  private scopeFor(root: string): FilesystemScope {
    return { kind: 'filesystem_root', root, ...(this.options.limits !== undefined ? { limits: this.options.limits } : {}) };
  }

  private async execute(msg: DiscoverMessage | AcquireMessage, ctx: ConnectorContext): Promise<Result<Executed, DiscoveryError>> {
    const scope = this.scopeFor(msg.scope.root);
    if (msg.op === 'discover') {
      const run = await discoverSource(this.options.deps, { sourceType: 'local_filesystem', scope }, ctx);
      if (!run.ok) return run;
      // A run that stopped at a later gate is not a success, whatever it already did to the inventory.
      if (run.value.stoppedBecause !== undefined) return err(run.value.stoppedBecause); // ENFORCE:stopped_is_error
      const outcome = run.value.outcome;
      if (outcome === undefined) return err(internalError(new Error('discovery produced no outcome'), 'local agent'));
      const evidence = run.value.evidence;
      // Discovery only ever yields existence/shape metadata; anything derived from content is withheld.
      if (evidence.some((e) => e.sensitivity !== 'metadata' || e.kind === 'document_content')) {
        // ENFORCE:discovery_no_content
        await this.containResult(ctx, ok({ result: {}, evidence }));
        return err(
          discoveryError(DiscoveryErrorCode.MALFORMED_INPUT, 'discovery returned content-derived evidence and it was withheld', {
            what: 'discovery_content',
          }),
        );
      }
      return ok({
        evidence,
        result: {
          sourceId: run.value.record.source.sourceId,
          status: run.value.record.status,
          partial: outcome.status === 'partial',
          evidence,
          skipped: outcome.skipped,
          limits: outcome.limits,
          errors: outcome.errors,
        },
      });
    }
    const outcome = await acquireSourceContent(
      this.options.deps,
      { sourceId: SourceId(msg.sourceId), kind: 'document_content', resourceKeys: msg.resourceKeys, scope },
      ctx,
    );
    if (!outcome.ok) return outcome;
    return ok({
      evidence: outcome.value.evidence,
      result: {
        sourceId: msg.sourceId,
        partial: outcome.value.status === 'partial',
        evidence: outcome.value.evidence,
        skipped: outcome.value.skipped,
        limits: outcome.value.limits,
        errors: outcome.value.errors,
      },
    });
  }

  /**
   * A result the agent decides not to deliver (cancelled, timed out, interrupted, oversized, content in discovery) may already have had
   * its evidence RELEASED by the connector's own completion audit. Delivering nothing while leaving it released would be an
   * inconsistent state, so it is quarantined through the existing C0.4 path (the durable store when configured). Adds no state or schema.
   */
  private async containResult(ctx: ConnectorContext, result: Result<Executed, DiscoveryError>): Promise<void> {
    if (!result.ok || result.value.evidence.length === 0) return;
    const evidence = result.value.evidence;
    const operationId = `agent_discarded_${stableDigest(evidence.map((e) => e.id as string).sort()).slice(0, 24)}`;
    try {
      const trust = trustFromContext(ctx);
      if (ctx.state !== undefined && trust !== undefined) {
        const done = await ctx.state.quarantine(trust, operationId, evidence);
        if (!done.ok) this.containmentFailureCount += 1;
      } else if (ctx.ledger !== undefined) ctx.ledger.quarantine(operationId, evidence);
      else this.containmentFailureCount += 1;
    } catch {
      this.containmentFailureCount += 1;
    }
  }

  // ── idempotency cache (bounded, FIFO) ─────────────────────────────────────────────────────────────────────────────────────

  private remember(id: string, entry: CacheEntry): void {
    this.cache.set(id, entry);
    for (const key of this.cache.keys()) {
      if (this.cache.size <= this.cfg.idempotencyCacheSize) break;
      const candidate = this.cache.get(key);
      if (candidate?.response !== undefined) this.cache.delete(key); // never evict an in-flight marker
    }
  }

  private cacheSuccess(id: string, response: AgentResponse): void {
    const entry = this.cache.get(id);
    if (entry !== undefined) entry.response = response;
  }
}
