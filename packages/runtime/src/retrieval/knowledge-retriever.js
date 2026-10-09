import { err, ok } from '@xo/types';
import { ErrorCode, RuntimeError } from '@xo/errors';
import { noopLogger } from '@xo/logger';
import { estimateTokens } from './retrieved-slice.js';
/**
 * Stage 2's "Retrieve Required Components" + "Knowledge Retrieval" steps.
 * Delegates all actual byte reading to `@xo/package-sdk`'s
 * `PackageInstaller.getComponent` — never touches a `BlobStore` or a
 * storage key convention directly, the same boundary `PackageLoader`
 * (Stage 1) already respects.
 */
export class KnowledgeRetriever {
    installer;
    logger;
    instrumentation;
    now;
    constructor(installer, options = {}) {
        this.installer = installer;
        this.logger = options.logger ?? noopLogger;
        this.instrumentation = options.instrumentation;
        this.now = options.now ?? (() => new Date());
    }
    /** Retrieves every component kind in `componentKinds` for one mounted package. */
    async retrieveForPackage(mounted, componentKinds) {
        const startedAt = this.now().getTime();
        const slices = [];
        for (const kind of componentKinds) {
            const result = await this.installer.getComponent(mounted.name, mounted.version, kind);
            if (!result.ok) {
                return err(new RuntimeError(ErrorCode.RUNTIME_RETRIEVAL_FAILED, `Failed to retrieve "${kind}" for "${mounted.name}@${mounted.version}": ${result.error.message}`, { cause: result.error }));
            }
            const content = new TextDecoder().decode(result.value);
            slices.push({ packageName: mounted.name, packageVersion: mounted.version, componentKind: kind, content, estimatedTokens: estimateTokens(content) });
        }
        this.instrumentation?.recordRetrievalLatency(this.now().getTime() - startedAt, { package: mounted.name, version: mounted.version, componentCount: componentKinds.length });
        this.logger.debug('retrieved components', { package: mounted.name, version: mounted.version, kinds: componentKinds.join(',') });
        return ok(slices);
    }
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
    async retrieveForCandidates(candidates, registry) {
        const all = [];
        for (const candidate of candidates) {
            const mounted = registry.get(candidate.capability.packageName, candidate.capability.packageVersion);
            if (!mounted)
                continue; // defensive: registry and plan are built from the same context
            const result = await this.retrieveForPackage(mounted, candidate.capability.declaration.requiredComponents);
            if (!result.ok)
                return result;
            all.push(...result.value);
        }
        return ok(all);
    }
}
//# sourceMappingURL=knowledge-retriever.js.map