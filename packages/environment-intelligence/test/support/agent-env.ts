import { connect } from 'node:net';
import { join } from 'node:path';
import { MockClock } from '@xo/testing';
import {
  AuditErrorCode,
  ConnectorRegistry,
  DevelopmentOperatorAuthorization,
  EiStateStore,
  EnvironmentInventory,
  EvidenceLedger,
  FrameDecoder,
  InMemoryAuditRecorder,
  LocalAgent,
  LocalFilesystemConnector,
  MAX_RESPONSE_BYTES,
  auditError,
  callAgent,
  decodeJson,
  encodeFrame,
  mintDevelopmentDecision,
  type AgentCall,
  type AgentResultBody,
  type AuditRecorder,
  type AuditTrust,
  type AuthorizationDecision,
  type AuthorizationPort,
  type AuthorizationRequest,
  type CallOptions,
  type ConnectorContext,
  type DiscoveryDeps,
  type DiscoveryError,
  type LocalAgentOptions,
} from '../../src/index.js';
import type { FsOps } from '../../src/filesystem/fd-walk.js';
import { NODE_FS_OPS } from '../../src/filesystem/fd-walk.js';
import { ok, type Result } from '@xo/types';
import { authenticated, withSandbox, type Sandbox } from '../helpers.js';
import { readGrant } from './audit-grants.js';

/** Records every request the gate was asked, and can withdraw authorization mid-test (a revoked source). */
export class RevocableAuthorization implements AuthorizationPort {
  revoked = false;
  readonly requests: AuthorizationRequest[] = [];

  constructor(private readonly inner: AuthorizationPort) {}

  async decide(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    this.requests.push(request);
    if (this.revoked) return mintDevelopmentDecision('deny', 'revoked by the test');
    return this.inner.decide(request);
  }
}

/** Accepts every attempt but refuses the matching terminal record, so the connector's completion audit is never accepted. */
export class TerminalRefusingAudit implements AuditRecorder {
  constructor(private readonly inner: AuditRecorder) {}

  async record(...args: Parameters<AuditRecorder['record']>): ReturnType<AuditRecorder['record']> {
    if (args[0].phase === 'terminal') return { ok: false, error: auditError(AuditErrorCode.UNAVAILABLE, 'refused by the test') };
    return this.inner.record(...args);
  }
}

/** An `FsOps` whose `open` can be held, to make a real connector slow without changing it. */
export class Hold {
  private release: (() => void) | undefined;
  private gate: Promise<void> | undefined;
  opens = 0;

  engage(): void {
    this.gate = new Promise<void>((done) => (this.release = done));
  }

  free(): void {
    this.release?.();
    this.gate = undefined;
  }

  get ops(): FsOps {
    return {
      ...NODE_FS_OPS,
      open: async (p, f) => {
        this.opens += 1;
        if (this.gate !== undefined) await this.gate;
        return NODE_FS_OPS.open(p, f);
      },
    };
  }
}

/** A real connector that never looks at the cancellation signal (a stand-in for a connector that ignores it). */
export class SignalBlindConnector extends LocalFilesystemConnector {
  override acquireContent(
    request: Parameters<LocalFilesystemConnector['acquireContent']>[0],
    ctx: ConnectorContext,
  ): ReturnType<LocalFilesystemConnector['acquireContent']> {
    const { signal: _ignored, ...rest } = ctx;
    return super.acquireContent(request, rest);
  }
}

/** A rogue connector whose discovery reports its evidence as derived from content (discovery must never yield content). */
export class ContentLeakingConnector extends LocalFilesystemConnector {
  override async discover(
    request: Parameters<LocalFilesystemConnector['discover']>[0],
    ctx: ConnectorContext,
  ): ReturnType<LocalFilesystemConnector['discover']> {
    const r = await super.discover(request, ctx);
    if (!r.ok) return r;
    return ok({ ...r.value, evidence: r.value.evidence.map((e) => ({ ...e, sensitivity: 'derived_from_content' as const })) });
  }
}

export interface AgentEnv extends Sandbox {
  readonly socketDir: string;
  readonly socketPath: string;
  readonly agent: LocalAgent;
  readonly authz: RevocableAuthorization;
  readonly audit: InMemoryAuditRecorder;
  readonly ledger: EvidenceLedger;
  readonly deps: DiscoveryDeps;
  readonly hold: Hold;
  readonly store: EiStateStore | undefined;
  readonly stateDir: string;
  call(call: AgentCall, options?: CallOptions): Promise<Result<AgentResultBody, DiscoveryError>>;
  discover(root?: string, options?: CallOptions): Promise<Result<AgentResultBody, DiscoveryError>>;
  acquire(
    sourceId: string,
    keys: readonly string[],
    root?: string,
    options?: CallOptions,
  ): Promise<Result<AgentResultBody, DiscoveryError>>;
}

export interface AgentEnvOptions {
  readonly durable?: boolean;
  readonly grants?: readonly string[];
  readonly agent?: Partial<LocalAgentOptions>;
  readonly audit?: (inner: InMemoryAuditRecorder) => AuditRecorder;
  readonly stateDir?: string;
  /** Register a connector that ignores the cancellation signal. */
  readonly signalBlind?: boolean;
  readonly leakContentInDiscovery?: boolean;
}

export const SECRET = 'TOP-SECRET-MARKER-7f3a9c';
export const principalIdForThisProcess = `local-agent-uid-${process.geteuid?.() ?? -1}`;

export async function bootStore(dir: string, ledger: EvidenceLedger, inventory: EnvironmentInventory): Promise<EiStateStore> {
  const opened = await EiStateStore.open({ dir });
  if (!opened.ok) throw new Error('state store did not open');
  const trust: AuditTrust = { principal: authenticated('operator-1') };
  const started = await opened.value.start({ grant: await readGrant(), trust, inventory, ledger });
  if (!started.ok) throw new Error('state store did not start');
  return opened.value;
}

export async function withAgentEnv(options: AgentEnvOptions, fn: (env: AgentEnv) => Promise<void>): Promise<void> {
  await withSandbox(async (box) => {
    const hold = new Hold();
    const registry = new ConnectorRegistry();
    registry.register(
      options.leakContentInDiscovery === true
        ? new ContentLeakingConnector({ fsOps: hold.ops })
        : options.signalBlind === true
          ? new SignalBlindConnector({ fsOps: hold.ops })
          : new LocalFilesystemConnector({ fsOps: hold.ops }),
    );
    const inventory = new EnvironmentInventory();
    const ledger = new EvidenceLedger();
    const stateDir = options.stateDir ?? join(box.base, 'state');
    const store = options.durable === true ? await bootStore(stateDir, ledger, inventory) : undefined;
    const deps: DiscoveryDeps = { registry, inventory };
    const clock = new MockClock('2026-10-10T00:00:00.000Z');
    const authz = new RevocableAuthorization(
      new DevelopmentOperatorAuthorization(
        (options.grants ?? ['filesystem.list', 'filesystem.read']).map((permission) => ({ permission, path: box.root })),
      ),
    );
    const audit = new InMemoryAuditRecorder(() => clock.now());
    const socketDir = join(box.base, 'sock');
    const started = await LocalAgent.start({
      socketDir,
      deps,
      clock,
      authorization: authz,
      audit: options.audit?.(audit) ?? audit,
      ledger,
      ...(store !== undefined ? { state: store } : {}),
      ...options.agent,
    });
    if (!started.ok) throw new Error(`agent did not start: ${started.error.code} ${JSON.stringify(started.error.context)}`);
    const agent = started.value;
    const socketPath = agent.socketPath;
    const env: AgentEnv = {
      ...box,
      socketDir,
      socketPath,
      agent,
      authz,
      audit,
      ledger,
      deps,
      hold,
      store,
      stateDir,
      call: (c, o) => callAgent(socketPath, c, o),
      discover: (root = box.root, o) => callAgent(socketPath, { op: 'discover', scope: { kind: 'filesystem_root', root } }, o),
      acquire: (sourceId, keys, root = box.root, o) =>
        callAgent(socketPath, { op: 'acquire', sourceId, scope: { kind: 'filesystem_root', root }, resourceKeys: keys }, o),
    };
    try {
      await fn(env);
    } finally {
      hold.free();
      await agent.stop();
      await store?.close();
    }
  });
}

// ── raw wire access, for requests the typed client refuses to build ─────────────────────────────────────────────────────────

export interface RawReply {
  readonly responses: readonly unknown[];
  readonly closed: boolean;
}

/** Sends exact bytes and collects decoded responses until the peer closes or `waitMs` passes. */
export function rawExchange(socketPath: string, bytes: Uint8Array | undefined, waitMs = 400, keepOpen = false): Promise<RawReply> {
  return new Promise((resolveRaw) => {
    const socket = connect(socketPath);
    const decoder = new FrameDecoder(MAX_RESPONSE_BYTES);
    const responses: unknown[] = [];
    let closed = false;
    socket.on('connect', () => {
      if (bytes !== undefined) socket.write(bytes);
    });
    socket.on('data', (chunk: Buffer) => {
      const framed = decoder.push(chunk);
      if (!framed.ok) return;
      for (const f of framed.frames) {
        const j = decodeJson(f);
        if (j.ok) responses.push(j.value);
      }
    });
    socket.on('close', () => (closed = true));
    socket.on('error', () => (closed = true));
    setTimeout(() => {
      if (!keepOpen) socket.destroy();
      resolveRaw({ responses, closed });
    }, waitMs);
  });
}

export const frameOf = (value: unknown): Buffer => encodeFrame(Buffer.from(JSON.stringify(value), 'utf8'));
export const reqId = (n: number): string => `req-test-${String(n).padStart(6, '0')}`;
export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
