import type { Result } from '@xo/types';
import type { PackageError } from '@xo/errors';
import type { XoirGraph } from '@xo/xoir';
import { packageXoirGraph } from './packager.js';
import type { LowerCapabilitiesResult } from './capability-lowering.js';

/**
 * P0.9B Step 5 — the one "discover + resolve" step that runs after
 * `compileSources` when a caller wants the RESOLVED capability view
 * (`LowerCapabilitiesResult`: per-capability contract id, binding status,
 * lowered declaration incl. `contractContentHash`) but is NOT producing a
 * package.
 *
 * Previously `apps/cli`'s `xo capabilities`, `apps/api`'s
 * `compile-source.ts`, and `@xo/benchmark`'s observer each wrote out the
 * same preview `packageXoirGraph(graph, { placeholder identity/metadata })`
 * call and then read `.capabilities` off it. This is that call, once.
 *
 * It is deliberately NOT a second lowering implementation: it runs the
 * real Packager (`packageXoirGraph`) — the same call `xo create` makes —
 * in memory, discarding the bundle. Binding resolution depends only on the
 * compiled graph and the resolvers, never on the placeholder package
 * identity, so the result is exactly what a real package would carry.
 *
 * NOTE (unchanged, pre-existing behavior): like `packageXoirGraph`
 * itself, this embeds each resolved contract into the graph's capability
 * nodes — it mutates `graph`. Callers that persist the graph afterwards
 * (`apps/api`) persist the embedded form, exactly as before.
 */
export interface DiscoverCapabilitiesOptions {
  /** Purely descriptive placeholder text for the throwaway package; e.g. `'xo capabilities preview'`. No bearing on resolution. */
  readonly previewLabel: string;
}

export function discoverAndResolveCapabilities(graph: XoirGraph, options: DiscoverCapabilitiesOptions): Result<LowerCapabilitiesResult, PackageError> {
  const preview = packageXoirGraph(graph, {
    identity: { name: 'preview', version: '0.0.0', creatorDid: 'did:xo:preview' },
    metadata: { domain: 'preview', description: `${options.previewLabel} — not a real package`, scope: [], limitations: [] },
  });
  if (!preview.ok) return preview;
  return { ok: true, value: preview.value.capabilities };
}
