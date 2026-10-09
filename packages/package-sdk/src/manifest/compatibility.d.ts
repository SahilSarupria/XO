import type { XoManifest } from '@xo/types';
import type { CompatibilityResolution, HostProfile } from '../types.js';
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
export declare function resolveCompatibility(manifest: XoManifest, host: HostProfile): CompatibilityResolution;
//# sourceMappingURL=compatibility.d.ts.map