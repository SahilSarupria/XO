import type { ParsedDocument } from '../document/types.js';
import { createDefaultBoundaryResolver, type BoundaryAmbiguityResolver } from './boundary-resolver.js';
import { buildRelationships } from './relationship-builder.js';
import { buildExperienceUnitsForSection } from './unit-builder.js';
import type { ExperienceDocument } from './types.js';

export interface SemanticChunkerOptions {
  /** Defaults to `RuleBasedOnlyResolver` (via `createDefaultBoundaryResolver()`) — see boundary-resolver.ts. */
  readonly resolver?: BoundaryAmbiguityResolver;
}

/**
 * Stage 3: turns Stage 2's structural `ParsedDocument` into an
 * `ExperienceDocument` — semantic-boundary-detected `ExperienceUnit`s
 * plus their relationship graph. Entirely deterministic given the same
 * `ParsedDocument` and the same resolver (the default resolver is itself
 * deterministic — see boundary-resolver.ts): re-running produces
 * byte-for-byte identical unit ids, content, and relationships, every
 * time (see `semantic-chunker.test.ts`'s determinism tests).
 *
 * This is NOT XOIR. It's the semantic intermediate representation
 * Stages 4-9 consume via `@xo/ai-core` — Stage 10 is what eventually
 * lowers an `ExperienceDocument` (plus Stage 4-9's output) into a real
 * `@xo/xoir` graph.
 */
export async function chunkDocument(parsed: ParsedDocument, documentPath: string, documentTitle: string | undefined, options: SemanticChunkerOptions = {}): Promise<ExperienceDocument> {
  const resolver = options.resolver ?? createDefaultBoundaryResolver();
  const { units: draftUnits } = await buildExperienceUnitsForSection(parsed.root, documentPath, [], undefined, resolver);
  const { units, relationshipGraph } = buildRelationships(draftUnits);
  return { documentPath, documentTitle, units, relationshipGraph };
}
