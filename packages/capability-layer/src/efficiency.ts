import type { ModelProvider, ProviderRequest, ProviderResponse } from '@xo/ai-core';
import type { PackageBundle } from '@xo/package-sdk';
import { createCapabilityLayer, type CapabilityLayer, type LayerOptions } from './layer.js';

/**
 * Efficiency helpers for the hot path. Every one is a mechanism with a deterministic, testable contract; none of them claims a saving. How much
 * latency, money or memory they save on real traffic is NOT MEASURED. Token counts here are estimates (see {@link estimateTokens}), not a provider's counts.
 */

/** A rough, provider-independent estimate: one token per four characters, rounded up. Over- and under-counts by language and content; pass a real counter where one exists. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class PromptBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptBudgetError';
  }
}

/** What `lowResource` changes: smaller retrieval, no worked examples, fewer turns, shorter answers, one fan-out item at a time. Defaults, overridable per call. */
export const LOW_RESOURCE = Object.freeze({
  knowledgeK: 3,
  exemplarK: 0,
  maxTurns: 4,
  maxOutputTokens: 512,
  forEachConcurrency: 1,
  trackedRuns: 64,
  segmentBytes: 1024 * 1024,
});

// ---- request coalescing -------------------------------------------------------------------------------------------------------------------------------

export interface CoalesceOptions {
  /**
   * `deterministic` (default): only requests with temperature 0 share a call, because a sampled request may legitimately want its own sample.
   * `all`: every identical in-flight request shares one call.
   */
  readonly mode?: 'deterministic' | 'all';
  /** Most callers that may wait on one in-flight call; further identical requests start their own. Default 64. */
  readonly maxWaiters?: number;
}

export interface CoalescingStats {
  /** Calls actually made to the wrapped provider. */
  calls: number;
  /** Requests answered by an already in-flight call. */
  coalesced: number;
}

const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );

/**
 * Concurrent identical requests share one provider call. Nothing is cached after the call settles (no staleness, no memory growth): this only removes
 * duplicate in-flight work. A failure is shared with every waiter that joined it, and the next request after it starts fresh. Streaming is not wrapped.
 */
export function coalescingProvider(inner: ModelProvider, o: CoalesceOptions = {}): ModelProvider & { readonly stats: CoalescingStats } {
  const mode = o.mode ?? 'deterministic';
  const maxWaiters = o.maxWaiters ?? 64;
  const inflight = new Map<string, { promise: Promise<ProviderResponse>; waiters: number }>();
  const stats: CoalescingStats = { calls: 0, coalesced: 0 };
  return {
    id: inner.id,
    stats,
    describeCapabilities: () => inner.describeCapabilities(),
    complete(req: ProviderRequest): Promise<ProviderResponse> {
      const eligible = mode === 'all' || req.temperature === 0;
      const key = eligible ? canon(req) : undefined;
      const hit = key === undefined ? undefined : inflight.get(key);
      if (hit !== undefined && hit.waiters < maxWaiters) {
        hit.waiters++;
        stats.coalesced++;
        return hit.promise;
      }
      stats.calls++;
      const promise = inner.complete(req);
      if (key !== undefined && hit === undefined) {
        const entry = { promise, waiters: 1 };
        inflight.set(key, entry);
        const clear = (): void => {
          if (inflight.get(key) === entry) inflight.delete(key);
        };
        promise.then(clear, clear);
      }
      return promise;
    },
  };
}

// ---- reuse of the loaded layer ------------------------------------------------------------------------------------------------------------------------

/**
 * Reuses a loaded {@link CapabilityLayer} (integrity check, parsing and the retrieval index are done once) for the SAME bundle object and the same options.
 * Keyed by object identity, so a bundle must be treated as immutable after it is loaded; mutating its bytes afterwards is not detected. Bounded (LRU, default 16);
 * entries for bundles that are no longer referenced elsewhere are still held until evicted, so keep `maxEntries` small. A load that throws is not cached.
 */
export class LayerCache {
  private readonly byBundle = new WeakMap<PackageBundle, Map<string, CapabilityLayer>>();
  private readonly order: { bundle: WeakRef<PackageBundle>; key: string }[] = [];
  hits = 0;
  misses = 0;
  constructor(
    private readonly maxEntries = 16,
    private readonly create: (b: PackageBundle, o: LayerOptions) => CapabilityLayer = createCapabilityLayer,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('maxEntries must be a positive integer');
  }

  get(bundle: PackageBundle, options: LayerOptions): CapabilityLayer {
    // Everything that changes how the layer is built is part of the key; a function-valued option (`now`) cannot be compared, so it makes the call uncacheable.
    if (options.now !== undefined || options.signing !== undefined) {
      this.misses++;
      return this.create(bundle, options);
    }
    const key = canon({ h: options.host, i: options.integrity ?? null, t: options.trust ?? null, e: options.requireEvidence ?? false });
    const per = this.byBundle.get(bundle) ?? new Map<string, CapabilityLayer>();
    const hit = per.get(key);
    if (hit !== undefined) {
      this.hits++;
      const at = this.order.findIndex((x) => x.key === key && x.bundle.deref() === bundle);
      if (at >= 0) this.order.push(...this.order.splice(at, 1)); // most recently used goes last
      return hit;
    }
    this.misses++;
    const layer = this.create(bundle, options);
    per.set(key, layer);
    this.byBundle.set(bundle, per);
    this.order.push({ bundle: new WeakRef(bundle), key });
    while (this.order.length > this.maxEntries) {
      const old = this.order.shift() as { bundle: WeakRef<PackageBundle>; key: string };
      this.byBundle.get(old.bundle.deref() as PackageBundle)?.delete(old.key);
    }
    return layer;
  }
}
