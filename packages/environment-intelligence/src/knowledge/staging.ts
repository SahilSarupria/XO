import { ok, type Result } from '@xo/types';
import type { Connector, ConnectorContext, SyncOutcome, SyncRequest, DiscoveryScopeBase } from '../connector.js';
import type { DiscoveryError } from '../errors.js';
import type { Evidence } from '../evidence.js';
import type { EvidenceId } from '../ids.js';

/** Where `deriveKnowledge` gets evidence PAYLOADS from. EI keeps no content, so this is a port, never a store of record. */
export interface EvidenceReader {
  read(ids: readonly EvidenceId[]): readonly Evidence[];
}

export const MAX_STAGED = 10_000;

/**
 * An in-memory, bounded holding area for the payloads of evidence a connector just returned. It is NOT a source of truth and NOT
 * durable (a restart empties it; nothing here is persisted or logged). It exists because `ingestSource` indexes and checkpoints evidence
 * but, by design (C0: no content retention), does not hand the payloads back; this lets the derivation step see exactly what the
 * connector returned without changing the Connector contract or the ingestion module.
 *
 * Trust: payloads come from the connector's own return value (the wrapper below), not from a caller. Staged payloads are used only
 * for evidence that the ledger reports eligible AND the durable resource index lists; anything else staged (a discarded or timed-out
 * batch) is ignored and eventually evicted.
 */
export class EvidenceStaging implements EvidenceReader {
  private readonly staged = new Map<string, Evidence>();

  stage(evidence: readonly Evidence[]): void {
    for (const e of evidence) {
      this.staged.delete(e.id);
      this.staged.set(e.id, e);
    }
    while (this.staged.size > MAX_STAGED) {
      const oldest = this.staged.keys().next();
      if (oldest.done === true) break;
      this.staged.delete(oldest.value);
    }
  }

  read(ids: readonly EvidenceId[]): readonly Evidence[] {
    const out: Evidence[] = [];
    for (const id of ids) {
      const e = this.staged.get(id);
      if (e !== undefined) out.push(e);
    }
    return out;
  }

  drop(ids: readonly EvidenceId[]): void {
    for (const id of ids) this.staged.delete(id);
  }

  get size(): number {
    return this.staged.size;
  }
}

/**
 * Wraps a connector so what its `incrementalSync` returns is also staged. Everything else (descriptor, authorization, audit, every
 * other operation) is the wrapped connector's, untouched, so the framework's enforcement and the registry checks see the same connector.
 */
export function capturingConnector<TScope extends DiscoveryScopeBase>(
  inner: Connector<TScope>,
  staging: EvidenceStaging,
): Connector<TScope> {
  const base: Connector<TScope> = {
    descriptor: inner.descriptor,
    detectSource: (r, c) => inner.detectSource(r, c),
    validateConnection: (r, c) => inner.validateConnection(r, c),
    discover: (r, c) => inner.discover(r, c),
    acquireContent: (r, c) => inner.acquireContent(r, c),
    ...(inner.health !== undefined ? { health: inner.health.bind(inner) } : {}),
  };
  if (inner.incrementalSync === undefined) return base;
  const sync = inner.incrementalSync.bind(inner);
  return {
    ...base,
    incrementalSync: async (request: SyncRequest<TScope>, ctx: ConnectorContext): Promise<Result<SyncOutcome, DiscoveryError>> => {
      const out = await sync(request, ctx);
      if (out.ok && Array.isArray(out.value.evidence)) staging.stage(out.value.evidence);
      return out.ok ? ok(out.value) : out;
    },
  };
}
