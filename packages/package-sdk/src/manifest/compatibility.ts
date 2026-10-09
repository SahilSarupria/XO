import type { ComponentKind, HostCapability, XoManifest } from '@xo/types';
import type { CompatibilityResolution, HostProfile } from '../types.js';

/**
 * Maps a component kind to the compatibility level it contributes, per
 * SPECIFICATION.md §2.2's table. `knowledge_graph`/`long_term_memory_graph`
 * are L1, `reasoning_traces`/`case_library` are L2, `decision_trees` is L3,
 * `lora`/`finetune` are L4. `prompt_strategies` and `safety_rules` /
 * `benchmark_suite` don't gate a level on their own (every level already
 * includes L0's prompt-only baseline).
 */
const COMPONENT_LEVEL: Readonly<Partial<Record<ComponentKind, CompatibilityResolution['reachedLevel']>>> = {
  knowledge_graph: 'L1',
  long_term_memory_graph: 'L1',
  reasoning_traces: 'L2',
  case_library: 'L2',
  decision_trees: 'L3',
  lora: 'L4',
  finetune: 'L4',
};

const LEVEL_ORDER: readonly CompatibilityResolution['reachedLevel'][] = ['L0', 'L1', 'L2', 'L3', 'L4'];

/**
 * Implements SPECIFICATION.md §2.1 steps 3-5: find the host's declared
 * model family in the manifest's compatibility declaration, intersect its
 * `minCapability` against what the host actually reports, and resolve the
 * component set to the ones both (a) the manifest offers to that family
 * and (b) the host's capabilities can satisfy. A host whose family isn't
 * declared at all in the manifest, or whose capabilities fall short of
 * every declared family, reaches L0 with no resolved components —
 * unsupported components are skipped, never errored (§2.1's explicit
 * "this is what makes the format model-agnostic").
 */
export function resolveCompatibility(manifest: XoManifest, host: HostProfile): CompatibilityResolution {
  const declaration = manifest.compatibility.modelFamilies.find((mf) => mf.family === host.family);
  if (!declaration) {
    return { reachedLevel: 'L0', resolvedComponents: [], skippedComponents: Object.keys(manifest.components) as ComponentKind[] };
  }

  const hostCaps = new Set<HostCapability>(host.capabilities);
  const capsSatisfied = declaration.minCapability.every((cap) => hostCaps.has(cap));
  if (!capsSatisfied) {
    return { reachedLevel: 'L0', resolvedComponents: [], skippedComponents: Object.keys(manifest.components) as ComponentKind[] };
  }

  const offeredAndPresent = declaration.consumes.filter((kind) => kind in manifest.components);
  const skipped = (Object.keys(manifest.components) as ComponentKind[]).filter((kind) => !offeredAndPresent.includes(kind));

  let reachedLevel: CompatibilityResolution['reachedLevel'] = 'L0';
  for (const kind of offeredAndPresent) {
    const level = COMPONENT_LEVEL[kind];
    if (level && LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(reachedLevel)) reachedLevel = level;
  }

  return { reachedLevel, resolvedComponents: offeredAndPresent, skippedComponents: skipped };
}
