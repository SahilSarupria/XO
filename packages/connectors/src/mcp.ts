import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Confinement } from './confine.js';
import { isPrivateAddress } from './net.js';
import { ConnectorError, type Connector, type Json } from './types.js';

/**
 * MCP client connector. Hard rules (each has a test):
 *  - Only tools in the operator's allowlist are callable; the operator declares each tool's side-effect class (default `write`).
 *  - Arguments are validated against the tool's own declared input schema before the call. A schema using keywords this validator
 *    does not understand is refused (fail closed), never skipped.
 *  - Results are untrusted content: capped in size, returned as data with provenance, never interpreted as instructions.
 *  - Secrets are injected by the host from a vault reference; they never appear in tool arguments the model or workflow can see.
 *  - stdio servers run with a CLEARED environment and inside a confinement plan (see confine.ts). There is no default of "unconfined": the caller
 *    must pass a plan, and a plan of kind `none` exists only when the operator opted in (and that is recorded). Without it the connector refuses to start.
 */

export type McpServer =
  | {
      readonly transport: 'stdio';
      readonly command: string;
      readonly args?: readonly string[];
      /** Only these variables reach the child (the host environment is NOT inherited). Values may be `secret:NAME` references. */
      readonly env?: Readonly<Record<string, string>>;
      readonly cwd?: string;
      /** How the child is launched. Required: build it with `planConfinement`, which refuses rather than return a weaker plan than policy allows. */
      readonly confinement: Confinement;
    }
  | {
      readonly transport: 'http';
      readonly url: string;
      readonly bearerSecret?: string;
      readonly allowPrivateNetwork?: boolean;
    };

export interface McpToolPolicy {
  /** Name of the tool on the server. */
  readonly tool: string;
  /** Declared by the operator. Defaults to `write` (the safe assumption) when omitted by the caller's config loader. */
  readonly sideEffect: 'read' | 'write' | 'irreversible';
}

export interface McpConfig {
  readonly server: McpServer;
  /** Operation name used in workflows -> tool policy. Anything not listed is not callable. */
  readonly tools: Readonly<Record<string, McpToolPolicy>>;
  readonly maxResponseBytes: number;
  /** Secret reader for `secret:NAME` env values and bearerSecret; supplied per call by the host. */
  readonly startupTimeoutMs?: number;
}

export interface McpConnector extends Connector {
  /** How a stdio server is confined (undefined for http servers). Record it with `confinementRecord`. */
  readonly isolation?: Confinement;
  close(): Promise<void>;
}

// ---- argument validation against the tool's JSON Schema (strict subset; unknown keyword => refuse) ----
const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', 'default', 'examples', 'deprecated', '$comment']);
const SUPPORTED = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'format',
]);

export function validateArgs(schema: unknown, value: unknown, path = 'args', depth = 0): string | undefined {
  if (depth > 12) return `${path}: schema nesting too deep`;
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return `${path}: schema is not an object`;
  const s = schema as Record<string, unknown>;
  for (const k of Object.keys(s))
    if (!SUPPORTED.has(k) && !ANNOTATIONS.has(k))
      return `${path}: schema keyword "${k}" is not supported; refusing rather than skipping validation`;
  if (s['const'] !== undefined && JSON.stringify(s['const']) !== JSON.stringify(value)) return `${path}: must equal the declared constant`;
  if (Array.isArray(s['enum']) && !s['enum'].some((e) => JSON.stringify(e) === JSON.stringify(value)))
    return `${path}: not one of the allowed values`;
  const t = s['type'];
  if (t !== undefined) {
    const types = Array.isArray(t) ? (t as string[]) : [t as string];
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
    if (!types.some((x) => x === actual || (x === 'number' && actual === 'integer')))
      return `${path}: expected ${types.join('|')}, got ${actual}`;
  }
  if (typeof value === 'string') {
    if (typeof s['minLength'] === 'number' && value.length < s['minLength']) return `${path}: too short`;
    if (typeof s['maxLength'] === 'number' && value.length > s['maxLength']) return `${path}: too long`;
    if (typeof s['pattern'] === 'string' && !new RegExp(s['pattern'], 'u').test(value))
      return `${path}: does not match the required pattern`;
  }
  if (typeof value === 'number') {
    if (typeof s['minimum'] === 'number' && value < s['minimum']) return `${path}: below minimum`;
    if (typeof s['maximum'] === 'number' && value > s['maximum']) return `${path}: above maximum`;
  }
  if (Array.isArray(value)) {
    if (typeof s['minItems'] === 'number' && value.length < s['minItems']) return `${path}: too few items`;
    if (typeof s['maxItems'] === 'number' && value.length > s['maxItems']) return `${path}: too many items`;
    if (s['items'] !== undefined)
      for (let i = 0; i < value.length; i++) {
        const p = validateArgs(s['items'], value[i], `${path}[${i}]`, depth + 1);
        if (p !== undefined) return p;
      }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    const props = (s['properties'] ?? {}) as Record<string, unknown>;
    for (const r of (s['required'] as string[] | undefined) ?? []) if (!(r in o)) return `${path}.${r}: is required`;
    for (const [k, v] of Object.entries(o)) {
      if (k in props) {
        const p = validateArgs(props[k], v, `${path}.${k}`, depth + 1);
        if (p !== undefined) return p;
      } else if (s['additionalProperties'] === false) return `${path}.${k}: unknown argument`;
      else if (typeof s['additionalProperties'] === 'object' && s['additionalProperties'] !== null) {
        const p = validateArgs(s['additionalProperties'], v, `${path}.${k}`, depth + 1);
        if (p !== undefined) return p;
      }
    }
  }
  return undefined;
}

// ---- transports ----
interface Rpc {
  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  close(): Promise<void>;
}

class StdioRpc implements Rpc {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf = '';
  constructor(
    cfg: Extract<McpServer, { transport: 'stdio' }>,
    env: Record<string, string>,
    private readonly maxBytes: number,
  ) {
    const argv = [...cfg.confinement.prefix, cfg.command, ...(cfg.args ?? [])];
    this.child = spawn(argv[0] as string, argv.slice(1), { env, cwd: cfg.cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d: string) => {
      this.buf += d;
      // A single unterminated message larger than this is treated as hostile; the response text itself is truncated to maxResponseBytes later.
      if (!this.buf.includes('\n') && this.buf.length > Math.max(4_194_304, this.maxBytes * 4))
        return void this.fail(new Error('server output exceeded the host limit'));
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line === '') continue;
        try {
          const m = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
          if (typeof m.id === 'number') {
            const p = this.pending.get(m.id);
            if (p !== undefined) {
              this.pending.delete(m.id);
              if (m.error !== undefined) p.reject(new ConnectorError('FAILED', `mcp error: ${m.error.message ?? 'unknown'}`));
              else p.resolve(m.result);
            }
          } // notifications and server requests are ignored: this client offers no capabilities
        } catch {
          // non-JSON noise on stdout is ignored, never interpreted
        }
      }
    });
    this.child.stderr.on('data', () => undefined); // drained and discarded; never forwarded
    this.child.on('exit', () => this.fail(new ConnectorError('FAILED', 'mcp server exited')));
    this.child.on('error', (e) => this.fail(new ConnectorError('FAILED', `mcp server failed to start: ${e.message}`)));
  }
  private fail(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    this.child.kill('SIGKILL');
  }
  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      signal.addEventListener('abort', () => {
        this.pending.delete(id);
        reject(new ConnectorError('TIMEOUT', 'mcp call aborted'));
      });
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
        (err) => err && reject(new ConnectorError('FAILED', 'write to mcp server failed')),
      );
    });
  }
  async notify(method: string, params: unknown): Promise<void> {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
  async close(): Promise<void> {
    this.child.stdin.end();
    this.child.kill('SIGKILL');
  }
}

class HttpRpc implements Rpc {
  private nextId = 1;
  private session: string | undefined;
  constructor(
    private readonly url: URL,
    private readonly headers: Record<string, string>,
    private readonly maxBytes: number,
    private readonly allowPrivate: boolean,
  ) {}
  private async guard(): Promise<void> {
    if (this.allowPrivate) return;
    const addrs =
      isIP(this.url.hostname) !== 0
        ? [this.url.hostname.replace(/^\[|\]$/g, '')]
        : (await lookup(this.url.hostname, { all: true })).map((r) => r.address);
    if (addrs.length === 0 || addrs.some(isPrivateAddress))
      throw new ConnectorError('DENIED', `mcp host ${this.url.hostname} resolves to a private or unresolvable address`);
  }
  private async post(body: unknown, signal: AbortSignal): Promise<Response> {
    await this.guard();
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...this.headers,
        ...(this.session !== undefined ? { 'mcp-session-id': this.session } : {}),
      },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal,
    });
    if (res.status >= 300 && res.status < 400) throw new ConnectorError('DENIED', 'redirect refused');
    const sid = res.headers.get('mcp-session-id');
    if (sid !== null) this.session = sid;
    return res;
  }
  private async readBody(res: Response): Promise<string> {
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > this.maxBytes) throw new ConnectorError('DENIED', 'response exceeds the limit');
    const reader = res.body?.getReader();
    if (reader === undefined) return '';
    const chunks: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > this.maxBytes) {
        await reader.cancel();
        throw new ConnectorError('DENIED', 'response exceeds the limit');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  async request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: '2.0', id, method, params }, signal);
    if (res.status >= 400) throw new ConnectorError(res.status >= 500 ? 'FAILED' : 'DENIED', `mcp http status ${res.status}`);
    const text = await this.readBody(res);
    const ct = res.headers.get('content-type') ?? '';
    const messages: unknown[] = [];
    if (ct.includes('text/event-stream'))
      for (const block of text.split(/\n\n/)) {
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (data !== '')
          try {
            messages.push(JSON.parse(data));
          } catch {
            /* ignore malformed events */
          }
      }
    else
      try {
        messages.push(JSON.parse(text));
      } catch {
        throw new ConnectorError('FAILED', 'mcp server returned non-JSON');
      }
    const mine = messages.find((m) => (m as { id?: number }).id === id) as { result?: unknown; error?: { message?: string } } | undefined;
    if (mine === undefined) throw new ConnectorError('FAILED', 'mcp server returned no matching response');
    if (mine.error !== undefined) throw new ConnectorError('FAILED', `mcp error: ${mine.error.message ?? 'unknown'}`);
    return mine.result;
  }
  async notify(method: string, params: unknown): Promise<void> {
    await this.post({ jsonrpc: '2.0', method, params }, AbortSignal.timeout(10_000)).catch(() => undefined);
  }
  async close(): Promise<void> {
    this.session = undefined;
  }
}

export interface McpDeps {
  readonly secret: (name: string) => string | undefined;
}

export function mcpConnector(cfg: McpConfig, deps: McpDeps): McpConnector {
  if (cfg.server.transport === 'stdio' && (cfg.server.confinement as Confinement | undefined) === undefined)
    throw new ConnectorError('DENIED', 'a stdio MCP server needs a confinement plan (planConfinement); there is no unconfined default');
  let rpc: Rpc | undefined;
  let schemas: Map<string, unknown> | undefined;
  let starting: Promise<void> | undefined;

  async function start(signal: AbortSignal): Promise<void> {
    if (cfg.server.transport === 'stdio') {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(cfg.server.env ?? {})) {
        if (v.startsWith('secret:')) {
          const sv = deps.secret(v.slice(7));
          if (sv === undefined)
            throw new ConnectorError('SECRET_UNAVAILABLE', `secret ${v.slice(7)} is not available for the mcp server environment`);
          env[k] = sv;
        } else env[k] = v;
      }
      rpc = new StdioRpc(cfg.server, env, cfg.maxResponseBytes);
    } else {
      const u = new URL(cfg.server.url);
      if (u.protocol !== 'https:' && cfg.server.allowPrivateNetwork !== true)
        throw new ConnectorError('DENIED', 'mcp http transport requires https');
      const headers: Record<string, string> = {};
      if (cfg.server.bearerSecret !== undefined) {
        const t = deps.secret(cfg.server.bearerSecret);
        if (t === undefined) throw new ConnectorError('SECRET_UNAVAILABLE', `secret ${cfg.server.bearerSecret} is not available`);
        headers['authorization'] = `Bearer ${t}`;
      }
      rpc = new HttpRpc(u, headers, cfg.maxResponseBytes, cfg.server.allowPrivateNetwork === true);
    }
    await rpc.request(
      'initialize',
      { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'xo', version: '0.1.0' } },
      signal,
    );
    await rpc.notify('notifications/initialized', {});
    const list = (await rpc.request('tools/list', {}, signal)) as { tools?: { name: string; inputSchema?: unknown }[] };
    schemas = new Map((list.tools ?? []).map((t) => [t.name, t.inputSchema ?? { type: 'object' }]));
  }

  async function ready(signal: AbortSignal): Promise<Rpc> {
    if (rpc === undefined || schemas === undefined) {
      starting ??= start(signal).catch((e: unknown) => {
        starting = undefined;
        void rpc?.close();
        rpc = undefined;
        throw e;
      });
      await starting;
    }
    return rpc as Rpc;
  }

  const operations: Connector['operations'] = Object.fromEntries(
    Object.entries(cfg.tools).map(([op, policy]) => [
      op,
      {
        sideEffect: policy.sideEffect,
        execute: async (args, ctx): Promise<Json> => {
          const r = await ready(ctx.signal);
          const schema = schemas?.get(policy.tool);
          if (schema === undefined) throw new ConnectorError('DENIED', `the server does not offer tool "${policy.tool}"`);
          const problem = validateArgs(schema, args);
          if (problem !== undefined) throw new ConnectorError('DENIED', `arguments refused: ${problem}`);
          const result = (await r.request('tools/call', { name: policy.tool, arguments: args }, ctx.signal)) as {
            content?: { type?: string; text?: string }[];
            isError?: boolean;
            structuredContent?: Json;
          };
          let text = (result.content ?? [])
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('\n');
          if (Buffer.byteLength(text) > cfg.maxResponseBytes) text = text.slice(0, cfg.maxResponseBytes);
          if (result.isError === true) throw new ConnectorError('DENIED', `tool reported an error: ${text.slice(0, 200)}`);
          return {
            source: 'mcp',
            tool: policy.tool,
            text,
            ...(result.structuredContent !== undefined ? { structured: result.structuredContent } : {}),
          };
        },
      },
    ]),
  );

  return {
    kind: 'mcp',
    ...(cfg.server.transport === 'stdio' ? { isolation: cfg.server.confinement } : {}),
    operations,
    close: async () => {
      await rpc?.close();
      rpc = undefined;
      schemas = undefined;
      starting = undefined;
    },
  };
}
