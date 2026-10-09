import type { GraphMetadata } from '../model/types.js';
import type { GraphAdapter } from './types.js';
export interface DependencyGraphPackage {
    readonly id: string;
    readonly label: string;
    readonly version?: string;
    readonly metadata?: GraphMetadata;
}
export interface DependencyGraphDependency {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly versionRange?: string;
    readonly metadata?: GraphMetadata;
}
export interface DependencyGraphSource {
    readonly packages: readonly DependencyGraphPackage[];
    readonly dependencies: readonly DependencyGraphDependency[];
}
/** Converts a package/dependency graph into a generic GraphModel. */
export declare const DependencyGraphAdapter: GraphAdapter<DependencyGraphSource>;
//# sourceMappingURL=DependencyGraphAdapter.d.ts.map