import type {
  ApprovalRequest,
  JournalEntry,
  Lease,
  LeaseClient,
  RunResult,
  RunStore,
  SignedDecision,
  IngestResult,
} from '@xo/workflow-runtime';
import { LeaseError } from '@xo/workflow-runtime';

export class XoApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'XoApiError';
  }
}

export interface XoClientOptions {
  /** e.g. http://127.0.0.1:7433 */
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Thin typed client for the XO HTTP API. It also implements LeaseClient, so a local runner can take its lease from the server. */
export class XoClient implements LeaseClient {
  private readonly f: typeof fetch;
  constructor(private readonly o: XoClientOptions) {
    this.f = o.fetch ?? fetch;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.f(new URL(path, this.o.baseUrl), {
      method,
      headers: { authorization: `Bearer ${this.o.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text === '' ? {} : JSON.parse(text);
    } catch {
      throw new XoApiError(res.status, 'BAD_RESPONSE');
    }
    if (!res.ok && !(path.includes('/ledger/') && typeof (json as { status?: unknown }).status === 'string')) {
      const e = json as { error?: string; message?: string };
      throw new XoApiError(res.status, e.error ?? 'ERROR', e.message);
    }
    return json as T;
  }

  health = (): Promise<{ ok: boolean }> => this.call('GET', '/v1/health');
  decide = (
    treeId: string,
    facts: Record<string, unknown>,
  ): Promise<{ ok: boolean; output?: Record<string, unknown>; rules?: string[]; escalate?: boolean }> =>
    this.call('POST', '/v1/decide', { treeId, facts });
  startRun = (workflow: string, inputs: Record<string, unknown>, dedupeKey?: string): Promise<RunResult> =>
    this.call('POST', `/v1/workflows/${encodeURIComponent(workflow)}/runs`, { inputs, ...(dedupeKey !== undefined ? { dedupeKey } : {}) });
  listRuns = (workflow: string): Promise<{ runs: { runId: string; state: string }[] }> =>
    this.call('GET', `/v1/workflows/${encodeURIComponent(workflow)}/runs`);
  getRun = (runId: string): Promise<Omit<RunResult, 'accepted'>> => this.call('GET', `/v1/runs/${encodeURIComponent(runId)}`);
  listApprovals = async (): Promise<ApprovalRequest[]> =>
    (await this.call<{ approvals: ApprovalRequest[] }>('GET', '/v1/approvals')).approvals;
  getApproval = (id: string): Promise<ApprovalRequest> => this.call('GET', `/v1/approvals/${encodeURIComponent(id)}`);
  decideApproval = (runId: string, decision: SignedDecision): Promise<RunResult> =>
    this.call('POST', `/v1/approvals/${encodeURIComponent(decision.payload.approvalId)}/decision`, { runId, decision });
  resolveLoader = (host: {
    family: string;
    capabilities: string[];
  }): Promise<{ level: string; consumed: string[]; skipped: unknown[]; workflows: unknown }> =>
    this.call('POST', '/v1/loader/resolve', { host });
  receipts = async (): Promise<unknown[]> => (await this.call<{ receipts: unknown[] }>('GET', '/v1/receipts')).receipts;

  // ---- LeaseClient
  async acquire(runId: string, owner: string, ttlMs: number): Promise<Lease> {
    return this.lease(runId, { action: 'acquire', owner, ttlMs });
  }
  async heartbeat(runId: string, owner: string, token: number, ttlMs: number): Promise<Lease> {
    return this.lease(runId, { action: 'heartbeat', owner, token, ttlMs });
  }
  async release(runId: string, owner: string, token: number): Promise<void> {
    await this.lease(runId, { action: 'release', owner, token, ttlMs: 1000 });
  }
  private async lease(runId: string, body: Record<string, unknown>): Promise<Lease> {
    try {
      return await this.call<Lease>('POST', `/v1/runs/${encodeURIComponent(runId)}/lease`, body);
    } catch (e) {
      if (e instanceof XoApiError && e.code.startsWith('LEASE_'))
        throw new LeaseError(e.code.slice(6) as 'HELD' | 'LOST' | 'UNKNOWN', e.message);
      throw e;
    }
  }

  // ---- ledger sync
  getLedger = (runId: string, from = 1): Promise<{ entries: JournalEntry[]; tail: number }> =>
    this.call('GET', `/v1/ledger/${encodeURIComponent(runId)}?from=${from}`);
  syncLedger = (runId: string, owner: string, token: number, entries: readonly JournalEntry[]): Promise<IngestResult> =>
    this.call('POST', `/v1/ledger/${encodeURIComponent(runId)}`, { owner, token, entries });
}

/**
 * Pushes a local run's hash chain to the server in batches, resuming from the server's tail. A `fork` or `quarantined` answer is surfaced,
 * never retried or worked around: it needs a human.
 */
export async function replicateRun(client: XoClient, local: RunStore, runId: string, owner: string, token: number): Promise<IngestResult> {
  const mine = await local.read(runId);
  const server = await client.getLedger(runId, 1).catch(() => ({ entries: [] as JournalEntry[], tail: 0 }));
  let from = Math.max(1, server.tail - 1); // overlap one entry so a divergence at the tail is noticed
  let last: IngestResult = { status: 'duplicate', tail: server.tail };
  // Always send at least one batch, even when the server looks caught up: the push is also the fencing check, so a runner that lost its
  // lease is refused (LEASE_LOST) instead of silently believing it is in sync.
  do {
    const batch = mine.slice(Math.min(from, Math.max(1, mine.length)) - 1, from - 1 + 500);
    if (batch.length === 0) break;
    last = await client.syncLedger(runId, owner, token, batch);
    if (last.status !== 'appended' && last.status !== 'duplicate') return last;
    from += batch.length;
  } while (from <= mine.length);
  return last;
}
