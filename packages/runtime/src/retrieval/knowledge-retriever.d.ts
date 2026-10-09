import type { ComponentKind } from '@xo/types';
import { type Result } from '@xo/types';
import { RuntimeError } from '@xo/errors';
import type { PackageInstaller } from '@xo/package-sdk';
import type { Logger } from '@xo/logger';
import type { RankedCandidate } from '../execution/execution-plan.js';
import type { MountedPackage, PackageRegistry } from '../registry/mounted-package.js';
import type { RuntimeInstrumentation } from '../observability/instrumentation.js';
import { type RetrievedSlice } from './retrieved-slice.js';
export interface KnowledgeRetrieverOptions {
    readonly logger?: Logger;
    readonly instrumentation?: RuntimeInstrumentation;
    readonly now?: () => Date;
}
/**
 * Stage 2's "Retrieve Required Components" + "Knowledge Retrieval" steps.
 * Delegates all actual byte reading to `@xo/package-sdk`'s
 * `PackageInstaller.getComponent` — never touches a `BlobStore` or a
 * storage key convention directly, the same boundary `PackageLoader`
 * (Stage 1) already respects.
 */
export declare class KnowledgeRetriever {
    private readonly installer;
    private readonly logger;
    private readonly instrumentation;
    private readonly now;
    constructor(installer: PackageInstaller, options?: KnowledgeRetrieverOptions);
    /** Retrieves every component kind in `componentKinds` for one mounted package. */
    retrieveForPackage(mounted: MountedPackage, componentKinds: readonly ComponentKind[]): Promise<Result<readonly RetrievedSlice[], RuntimeError>>;
    /**
     * Retrieves for the negotiator's selected candidate plus any auxiliary
     * candidates (see `ExecutionRequest.auxiliaryCapabilityIds`) — the
     * "multiple installed XOs" source feeding `mergeKnowledgeGraphs`.
     * Stops and returns the first failure rather than partially retrieving
     * (a capability missing a required component it declared is an
     * inconsistency `PackageValidator.validateCapabilities` should have
     * caught at validation time; seeing it here means something changed
     * out from under an already-mounted package).
     */
    retrieveForCandidates(candidates: readonly RankedCandidate[], registry: PackageRegistry): Promise<Result<readonly RetrievedSlice[], RuntimeError>>;
}
//# sourceMappingURL=knowledge-retriever.d.ts.map