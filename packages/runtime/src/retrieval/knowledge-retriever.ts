import type { ComponentKind } from '@xo/types';
import { err, ok, type Result } from '@xo/types';
import { ErrorCode, RuntimeError } from '@xo/errors';
import type { PackageInstaller } from '@xo/package-sdk';
import type { Logger } from '@xo/logger';
import { noopLogger } from '@xo/logger';
import type { RankedCandidate } from '../execution/execution-plan.js';
import type { MountedPackage, PackageRegistry } from '../registry/mounted-package.js';
import type { RuntimeInstrumentation } from '../observability/instrumentation.js';
import { estimateTokens, type RetrievedSlice } from './retrieved-slice.js';

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
export class KnowledgeRetriever {
  private readonly logger: Logger;
  private readonly instrumentation: RuntimeInstrumentation | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly installer: PackageInstaller,
    options: KnowledgeRetrieverOptions = {},
  ) {
    this.logger = options.logger ?? noopLogger;
    this.instrumentation = options.instrumentation;
    this.now = options.now ?? (() => new Date());
  }

  /** Retrieves every component kind in `componentKinds` for one mounted package. */
  async retrieveForPackage(mounted: MountedPackage, componentKinds: readonly ComponentKind[]): Promise<Result<readonly RetrievedSlice[], RuntimeError>> {
    const startedAt = this.now().getTime();
    const slices: RetrievedSlice[] = [];

    for (const kind of componentKinds) {
      const result = await this.installer.getComponent(mounted.name, mounted.version, kind);
      if (!result.ok) {
        return err(
          new RuntimeError(ErrorCode.RUNTIME_RETRIEVAL_FAILED, `Failed to retrieve "${kind}" for "${mounted.name}@${mounted.version}": ${result.error.message}`, { cause: result.error }),
        );
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
  async retrieveForCandidates(candidates: readonly RankedCandidate[], registry: PackageRegistry): Promise<Result<readonly RetrievedSlice[], RuntimeError>> {
    const all: RetrievedSlice[] = [];
    for (const candidate of candidates) {
      const mounted = registry.get(candidate.capability.packageName, candidate.capability.packageVersion);
      if (!mounted) continue; // defensive: registry and plan are built from the same context
      const result = await this.retrieveForPackage(mounted, candidate.capability.declaration.requiredComponents);
      if (!result.ok) return result;
      all.push(...result.value);
    }
    return ok(all);
  }
}
