import { compileSources, discoverAndResolveCapabilities } from '@xo/compiler';
import { nodesOfKind, toJson, type XoirNode, type CapabilityNodeProps } from '@xo/xoir';
import { XoError, ErrorCode } from '@xo/errors';
import type { CompilationStore, CapabilityProjection } from './compilation.js';
import type { SourceRecord } from '../sources/source.js';
import { buildCompilerSourceInput } from './source-input-adapter.js';

/**
 * Runs `@xo/compiler`'s own, unmodified pipeline against one already
 * ownership-checked, already-loaded source's bytes and persists the
 * outcome as a `CompilationRecord` via the given `CompilationStore`.
 * This is the only file in this milestone that imports `@xo/compiler` —
 * every route handler (`source-compilation-routes.ts`) calls this
 * function rather than touching the compiler directly, matching the
 * milestone brief's "avoid duplicating compiler logic in the API"
 * requirement in the most literal way available: there is exactly one
 * call site.
 *
 * Two existing compiler calls, in the exact sequence `apps/cli`'s own
 * `xo capabilities <source>` already uses (`apps/cli/src/commands/compiler/capabilities.ts`,
 * `capabilitiesFromSource`) — reused here for identical reasons, not
 * reimplemented:
 *
 *   1. `compileSources([input])` — produces the compiled XOIR graph.
 *      Its raw `capability`-kind nodes are the DISCOVERED capability
 *      list (semantic surfacing from source text, independent of
 *      whether any of them resolve to an executable binding).
 *   2. `packageXoirGraph(graph, { identity, metadata })` — a
 *      preview-only in-memory packaging call (nothing signed, validated,
 *      or written to disk; placeholder identity/metadata have no
 *      bearing on resolution, exactly as in the CLI's own doc comment)
 *      run purely to obtain its `capabilities: LowerCapabilitiesResult`
 *      — the RESOLVED view (execution mode, contract id, confidence)
 *      that only exists after binding resolution runs.
 *
 * No workflow composition (`@xo/workflow-composer`) and no runtime
 * (`@xo/runtime`) are invoked anywhere in this file — those stay exactly
 * where P0 through P0.3 left them (CLI-only), per this milestone's
 * explicit scope limits.
 */
export async function compileSourceRecord(store: CompilationStore, compilationId: string, source: SourceRecord, bytes: Uint8Array): Promise<void> {
  try {
    const input = buildCompilerSourceInput(source.extension, bytes, source.originalFilename);
    const compiled = await compileSources([input], {});
    if (!compiled.ok) {
      await store.markFailed(compilationId, { errorCode: compiled.error.code, errorMessage: compiled.error.message });
      return;
    }

    const capabilityNodes = nodesOfKind(compiled.value.graph, 'capability');

    const resolved = discoverAndResolveCapabilities(compiled.value.graph, { previewLabel: 'API compilation preview' });
    if (!resolved.ok) {
      await store.markFailed(compilationId, { errorCode: resolved.error.code, errorMessage: resolved.error.message });
      return;
    }

    const nodesById = new Map<string, XoirNode>(capabilityNodes.map((n) => [n.id as unknown as string, n]));

    const capabilities: CapabilityProjection[] = resolved.value.outcomes.map((outcome) => {
      const declaration = outcome.declaration;
      // `contractId` is typically, but not guaranteed to be, the discovered node's own id (see CapabilityExecutionDeclaration's doc comment) — matched directly against the node map; if it misses, this outcome simply carries no provenance/raw-node fields rather than a guessed match.
      const node = nodesById.get(outcome.contractId);
      const nodeProps = node?.properties as CapabilityNodeProps | undefined;
      return {
        capabilityId: node?.id !== undefined ? (node.id as unknown as string) : outcome.contractId,
        contractId: outcome.contractId,
        name: declaration?.name ?? nodeProps?.name ?? outcome.name,
        description: declaration?.description ?? nodeProps?.description ?? '',
        status: outcome.status,
        ...(declaration?.execution?.mode !== undefined ? { executionClass: declaration.execution.mode } : {}),
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        confidence: node?.metadata.confidence ?? 0,
        ...(declaration?.confidence !== undefined ? { declaredConfidence: { score: declaration.confidence.score, basis: declaration.confidence.basis } } : {}),
        provenance: (node?.metadata.sourceRefs ?? []).map((ref) => ({ documentPath: ref.documentPath, ...(ref.locator !== undefined ? { locator: ref.locator } : {}), ...(ref.pages !== undefined ? { pages: ref.pages } : {}) })),
      };
    });

    await store.markSucceeded(compilationId, {
      capabilities,
      discoveredCount: resolved.value.discoveredCount,
      resolvedCount: resolved.value.resolvedCount,
      graph: toJson(compiled.value.graph),
    });
  } catch (cause) {
    // Defensive: a compiler-internal throw (as opposed to a `Result`
    // failure) is still an honest compilation failure, never an
    // unexplained partial record or an uncaught 500 — per the
    // milestone's "malformed compiler result" requirement.
    const message = cause instanceof Error ? cause.message : String(cause);
    await store.markFailed(compilationId, { errorCode: ErrorCode.UNKNOWN, errorMessage: `compiler pipeline threw unexpectedly: ${message}` });
  }
}

/** Re-exported so route code can construct a well-typed failure without importing `@xo/errors` directly for this one case. */
export const COMPILER_ERROR_UNKNOWN = ErrorCode.UNKNOWN;
export { XoError };
