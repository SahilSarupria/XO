import type { SourceGraph } from '../src/source-graph.js';
/**
 * This fixture is a direct, faithful mapping of the hardcoded
 * `experiences` / `lines` arrays currently inline in app/page.tsx
 * into the SourceGraph contract \u2014 it is not imported from page.tsx
 * (that file exports nothing reusable) and it does not modify
 * page.tsx in any way. It exists purely so this package's tests run
 * against something resembling real content instead of only synthetic
 * data. See README.md for the exact mapping.
 *
 * page.tsx's `lines` array connects nodes by coordinate pairs; here
 * those pairs are resolved back to ids as explicit `dependsOn`
 * relationships.
 */
export declare const SAMPLE_GRAPH: SourceGraph;
//# sourceMappingURL=sample-graph.d.ts.map