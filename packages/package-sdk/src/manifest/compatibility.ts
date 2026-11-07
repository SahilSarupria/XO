import type { ComponentKind, HostCapability, XoManifest } from '@xo/types';
import type { CompatibilityResolution, HostProfile } from '../types.js';

/**
 * Maps a component kind to the compatibility level it contributes, per
 * SPECIFICATION.md §2.2's table. `knowledge_graph`/`long_term_memory_graph`
 * are L1, `reasoning_traces`/`case_library` are L2, `decision_trees` is L3,
 * `workflows` are L3, `lora`/`finetune` are L4. `prompt_strategies` and `safety_rules` /
 * `benchmark_suite` don't gate a level on their own (every level already
 * includes L0's prompt-only baseline).
 */
const COMPONENT_LEVEL: Readonly<Partial<Record<ComponentKind, CompatibilityResolution['reachedLevel']>>> = {
  knowledge_graph: 'L1',
  long_term_memory_graph: 'L1',
  reasoning_traces: 'L2',
  case_library: 'L2',
  decision_trees: 'L3',
  // Workflows reach L3: their decide steps are decision-tree/rule evaluations a host runs as deterministic tools. A host
  // that only has a prompt-only or retrieval level skips the component (and never runs a workflow with part of it missing).
  workflows: 'L3',
  lora: 'L4',
  finetune: 'L4',
};

const LEVEL_ORDER: readonly CompatibilityResolution['reachedLevel'][] = ['L0', 'L1', 'L2', 'L3', 'L4'];

export type FamilyDeclaration = XoManifest['compatibility']['modelFamilies'][number];

/**
 * What a component needs from the HOST beyond a chat model. One table, used by the loader/resolve API and by the capability layer, so they cannot
 * disagree. A component whose need is unmet is SKIPPED with a stated reason (SPECIFICATION.md §2.1: "unsupported components are skipped, not
 * errored"), never half-used: decision trees are exposed as callable tools, so a host that cannot call tools gets no trees and no tools, and is
 * served the context-only level instead.
 */
const COMPONENT_NEEDS: Readonly<Partial<Record<ComponentKind, { readonly capability: HostCapability; readonly because: string }>>> = {
  decision_trees: { capability: 'tool_use', because: 'decision trees are exposed as callable tools' },
};

/** Why `host` cannot use this component, or undefined when it can. */
export function componentHostProblem(kind: ComponentKind, host: HostProfile): string | undefined {
  const need = COMPONENT_NEEDS[kind];
  return need !== undefined && !host.capabilities.includes(need.capability)
    ? `host lacks ${need.capability}, which this component needs (${need.because})`
    : undefined;
}

export interface FamilySelection {
  /** The declaration this host is served from, or undefined when none can serve it (the host reaches L0). */
  readonly declaration?: FamilyDeclaration;
  readonly usedFamily?: string;
  /** Why the host is not being served exactly as its own family declares; absent when it is. */
  readonly degradedBecause?: string;
}

/**
 * The ONE place a host is matched to a manifest's family declarations (SPECIFICATION.md `fallback_policy: degrade_gracefully`):
 *  - a host without `chat` cannot converse at all, so no declaration serves it (it still gets the local safety rules);
 *  - the host's own family when the manifest declares it. Capabilities that family lists as `minCapability` but the host lacks do NOT discard the
 *    family: they are reported, and each component that needs one is skipped individually (see COMPONENT_NEEDS);
 *  - otherwise the manifest's `generic` family;
 *  - otherwise nothing.
 */
export function selectFamilyDeclaration(manifest: XoManifest, host: HostProfile): FamilySelection {
  const caps = new Set<HostCapability>(host.capabilities);
  if (!caps.has('chat')) return { degradedBecause: 'host lacks chat, the baseline every model family requires' };
  const families = manifest.compatibility.modelFamilies;
  const own = families.find((f) => f.family === host.family);
  if (own !== undefined) {
    const lacking = own.minCapability.filter((c) => !caps.has(c));
    return lacking.length === 0
      ? { declaration: own, usedFamily: own.family }
      : {
          declaration: own,
          usedFamily: own.family,
          degradedBecause: `host lacks ${lacking.join(', ')}, which family "${own.family}" lists as required; components that need it are skipped`,
        };
  }
  const generic = families.find((f) => f.family === 'generic');
  if (generic !== undefined)
    return { declaration: generic, usedFamily: 'generic', degradedBecause: `the manifest declares no family "${host.family}"` };
  return { degradedBecause: `the manifest declares no family "${host.family}" and no generic family` };
}

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
  const { declaration } = selectFamilyDeclaration(manifest, host);
  if (!declaration) {
    return { reachedLevel: 'L0', resolvedComponents: [], skippedComponents: Object.keys(manifest.components) as ComponentKind[] };
  }

  const offeredAndPresent = declaration.consumes.filter(
    (kind) => kind in manifest.components && componentHostProblem(kind, host) === undefined,
  );
  const skipped = (Object.keys(manifest.components) as ComponentKind[]).filter((kind) => !offeredAndPresent.includes(kind));

  let reachedLevel: CompatibilityResolution['reachedLevel'] = 'L0';
  for (const kind of offeredAndPresent) {
    const level = COMPONENT_LEVEL[kind];
    if (level && LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(reachedLevel)) reachedLevel = level;
  }

  return { reachedLevel, resolvedComponents: offeredAndPresent, skippedComponents: skipped };
}
