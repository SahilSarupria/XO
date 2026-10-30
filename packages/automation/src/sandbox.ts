import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DecisionTree, TreeEvaluation } from '@xo/capability-layer';

export type NetworkIsolation = 'required' | 'best_effort' | 'none';

export interface SandboxOptions {
  /** Worker processes kept warm. Default 2. */
  readonly workers?: number;
  /** Per-evaluation wall-clock limit; a worker that exceeds it is SIGKILLed and replaced. Default 2000 ms. */
  readonly timeoutMs?: number;
  /** V8 old-space cap per worker. Default 96 MB. */
  readonly maxOldSpaceMb?: number;
  /**
   * Node's permission model blocks filesystem writes, reads outside an allowlist, process spawning and worker threads,
   * but it does NOT block network access. Network isolation therefore comes from a Linux network namespace
   * (`unshare -rn`). `required` (the default) refuses to start if that is unavailable — it never silently runs
   * with network access while claiming to be sandboxed.
   */
  readonly networkIsolation?: NetworkIsolation;
  /** Enables a CPU-spin message in the worker so the timeout path can be tested. Never set in production. */
  readonly testHooks?: boolean;
}

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

let netnsProbe: boolean | undefined;
/** True when a rootless network namespace can be created on this host. */
export function networkNamespaceAvailable(): boolean {
  if (netnsProbe === undefined) {
    const r = spawnSync('unshare', ['-rn', 'true'], { stdio: 'ignore' });
    netnsProbe = r.status === 0;
  }
  return netnsProbe;
}

export interface IsolationReport {
  readonly fs_write: string;
  readonly fs_read_outside: string;
  readonly env_secrets: string;
  readonly code_gen: string;
  readonly spawn: string;
  readonly net: string;
}

interface Slot {
  child: ChildProcess | undefined;
  ready: Promise<void> | undefined;
  busy: boolean;
}

interface Pending {
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly slot: Slot;
}

/**
 * A small pool of long-lived, locked-down child processes that evaluate
 * decision trees. The tree and facts come from untrusted places (a package; a
 * webhook), so the evaluator runs where it cannot do harm even if it were
 * buggy: no write access, no read access beyond its own code, no spawning, no
 * code generation, no secrets in its environment, no network (netns), a hard
 * memory cap, and a wall-clock kill. {@link selfTest} proves each of those at
 * runtime so the claim is checked, not assumed.
 */
export class TreeSandbox {
  private readonly slots: Slot[];
  private readonly waiters: ((s: Slot) => void)[] = [];
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  /** The worker is compiled JS. When this module itself runs from TypeScript sources (tests, tsx), fall back to the built copy in dist/. */
  private readonly workerPath = [new URL('./sandbox-worker.js', import.meta.url), new URL('../dist/sandbox-worker.js', import.meta.url)]
    .map((u) => fileURLToPath(u))
    .find((p) => existsSync(p)) as string;
  private readonly evaluatorDir: string;
  readonly isolation: { readonly network: boolean };
  private evalCount = 0;
  private restartCount = 0;

  constructor(private readonly opts: SandboxOptions = {}) {
    const mode = opts.networkIsolation ?? 'required';
    const haveNs = mode === 'none' ? false : networkNamespaceAvailable();
    if (mode === 'required' && !haveNs)
      throw new SandboxUnavailableError(
        'network isolation is required but a network namespace (unshare -rn) is not available on this host; refusing to run unsandboxed',
      );
    if (this.workerPath === undefined) throw new SandboxUnavailableError('sandbox worker is not built (run the build for @xo/automation)');
    this.isolation = { network: haveNs };
    this.evaluatorDir = dirname(fileURLToPath(import.meta.resolve('@xo/capability-layer')));
    this.slots = Array.from({ length: Math.max(1, opts.workers ?? 2) }, () => ({ child: undefined, ready: undefined, busy: false }));
  }

  get stats(): { evaluations: number; restarts: number; networkIsolated: boolean } {
    return { evaluations: this.evalCount, restarts: this.restartCount, networkIsolated: this.isolation.network };
  }

  private start(slot: Slot): Promise<void> {
    const flags = [
      '--permission',
      `--allow-fs-read=${this.workerPath}`,
      `--allow-fs-read=${this.evaluatorDir}/*`,
      `--max-old-space-size=${this.opts.maxOldSpaceMb ?? 96}`,
      '--disallow-code-generation-from-strings',
      this.workerPath,
      this.evaluatorDir,
    ];
    const [cmd, args] = this.isolation.network
      ? (['unshare', ['-rn', process.execPath, ...flags]] as const)
      : ([process.execPath, flags] as const);
    // Scrubbed environment: nothing from the parent (API keys included) reaches the worker.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'] ?? '',
      ...(this.opts.testHooks === true ? { XO_SANDBOX_TEST_HOOKS: '1' } : {}),
    };
    const child = spawn(cmd, [...args], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env, cwd: '/' });
    slot.child = child;
    slot.ready = new Promise<void>((resolve, reject) => {
      const onMsg = (m: { ready?: boolean }): void => {
        if (m.ready === true) {
          child.off('message', onMsg);
          resolve();
        }
      };
      child.on('message', onMsg);
      child.once('exit', () => reject(new Error('sandbox worker exited before becoming ready')));
    });
    slot.ready.catch(() => undefined);
    child.on('message', (m: { id?: number; result?: unknown; error?: string }) => {
      if (m.id === undefined) return;
      const p = this.pending.get(m.id);
      if (p === undefined) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      p.slot.busy = false;
      this.release(p.slot);
      if (m.error !== undefined) p.reject(new Error(`sandbox: ${m.error}`));
      else p.resolve(m.result);
    });
    child.on('exit', () => {
      for (const [id, p] of this.pending) {
        if (p.slot === slot) {
          this.pending.delete(id);
          clearTimeout(p.timer);
          p.reject(new Error('sandbox worker died (killed, out of memory, or crashed)'));
        }
      }
      if (slot.child === child) {
        slot.child = undefined;
        slot.ready = undefined;
        slot.busy = false;
        if (!this.closed) this.restartCount++;
      }
    });
    return slot.ready;
  }

  private release(slot: Slot): void {
    const w = this.waiters.shift();
    if (w !== undefined) {
      slot.busy = true;
      w(slot);
    }
  }

  private acquire(): Promise<Slot> {
    const free = this.slots.find((s) => !s.busy);
    if (free !== undefined) {
      free.busy = true;
      return Promise.resolve(free);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private async call(msg: { kind: 'eval' | 'probe' | 'spin'; tree?: unknown; facts?: unknown }): Promise<unknown> {
    if (this.closed) throw new Error('sandbox is closed');
    const slot = await this.acquire();
    try {
      if (slot.child === undefined) await this.start(slot);
      await slot.ready;
    } catch (e) {
      slot.busy = false;
      this.release(slot);
      throw e;
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        slot.child?.kill('SIGKILL');
        reject(new Error(`sandbox evaluation exceeded ${this.opts.timeoutMs ?? 2000} ms and the worker was killed`));
      }, this.opts.timeoutMs ?? 2000);
      this.pending.set(id, { resolve, reject, timer, slot });
      slot.child?.send({ id, ...msg });
    });
  }

  async evaluate(tree: DecisionTree, facts: Readonly<Record<string, unknown>>): Promise<TreeEvaluation> {
    this.evalCount++;
    return (await this.call({ kind: 'eval', tree, facts })) as TreeEvaluation;
  }

  /** Attempts forbidden operations from inside a worker and reports what happened. */
  async selfTest(): Promise<IsolationReport & { readonly enforced: boolean; readonly failures: readonly string[] }> {
    const r = (await this.call({ kind: 'probe' })) as IsolationReport;
    const failures: string[] = [];
    if (r.fs_write !== 'ERR_ACCESS_DENIED') failures.push(`filesystem write was not denied (${r.fs_write})`);
    if (r.fs_read_outside !== 'ERR_ACCESS_DENIED') failures.push(`read outside the allowlist was not denied (${r.fs_read_outside})`);
    if (!/^EvalError$|ERR_/.test(r.code_gen)) failures.push(`code generation from strings was not denied (${r.code_gen})`);
    if (r.spawn !== 'ERR_ACCESS_DENIED') failures.push(`process spawning was not denied (${r.spawn})`);
    if (r.env_secrets !== 'ALLOWED') failures.push(`secrets leaked into the worker environment (${r.env_secrets})`);
    if (this.isolation.network && !r.net.startsWith('BLOCKED')) failures.push(`network was not blocked (${r.net})`);
    return { ...r, enforced: failures.length === 0, failures };
  }

  /** @internal test hook (requires `testHooks: true`): makes the worker spin so the timeout path can be exercised. */
  spinForTest(): Promise<unknown> {
    return this.call({ kind: 'spin' });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('sandbox closed'));
    }
    this.pending.clear();
    await Promise.all(
      this.slots.map(
        (s) =>
          new Promise<void>((resolve) => {
            if (s.child === undefined) return resolve();
            s.child.once('exit', () => resolve());
            s.child.kill('SIGKILL');
          }),
      ),
    );
  }
}
