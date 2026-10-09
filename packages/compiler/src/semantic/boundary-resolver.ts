import type { AiCapabilityLayer } from '@xo/ai-core';
import type { SemanticType } from './types.js';

/**
 * The hybrid-strategy seam the compiler spec asked for: deterministic
 * rule-based classification (semantic-type-classifier.ts) remains the
 * default whenever its own confidence is high; only a genuinely
 * ambiguous block (confidence below `AMBIGUITY_CONFIDENCE_THRESHOLD`) is
 * ever offered to a `BoundaryAmbiguityResolver` for a second opinion.
 *
 * This stage does NOT wire in a real AI-backed resolver — doing so
 * would mean calling one of `@xo/ai-core`'s six extraction capabilities
 * (there is no dedicated "resolve this boundary" capability, and adding
 * one is exactly the kind of judgment call Stage 4+ is scoped to make,
 * per this stage's explicit "do not implement Entity/Knowledge/...
 * Extraction"). What's real here: the seam itself, typed against the
 * actual `AiCapabilityLayer` export, so a future stage can supply a real
 * resolver without this file changing — `createDefaultBoundaryResolver`
 * already accepts one, and simply doesn't yet have anything productive
 * to ask it to do.
 */
export interface BoundaryAmbiguityContext {
  readonly ruleBasedType: SemanticType;
  readonly ruleBasedConfidence: number;
  readonly text: string;
}

export interface BoundaryAmbiguityResolution {
  readonly semanticType: SemanticType;
  readonly confidence: number;
  readonly resolvedBy: 'rule' | 'ai_assisted';
}

export interface BoundaryAmbiguityResolver {
  resolve(context: BoundaryAmbiguityContext): Promise<BoundaryAmbiguityResolution>;
}

/** Below this confidence, the chunker consults a `BoundaryAmbiguityResolver` instead of accepting the rule-based classification outright. */
export const AMBIGUITY_CONFIDENCE_THRESHOLD = 0.6;

/** Accepts the rule-based classification as-is — the only resolver this stage ships, and the correct default until a real AI-assisted resolver exists (see the module doc comment above for why one isn't built yet). */
export class RuleBasedOnlyResolver implements BoundaryAmbiguityResolver {
  async resolve(context: BoundaryAmbiguityContext): Promise<BoundaryAmbiguityResolution> {
    return { semanticType: context.ruleBasedType, confidence: context.ruleBasedConfidence, resolvedBy: 'rule' };
  }
}

/**
 * Constructs the resolver the chunker uses by default. Accepts an
 * optional `AiCapabilityLayer` so a caller that already has one wired up
 * (e.g. the eventual `xo compile` CLI command) can pass it through today
 * — this constructor is the one place a future AI-assisted resolver
 * would be instantiated instead of `RuleBasedOnlyResolver`, once one
 * exists.
 */
export function createDefaultBoundaryResolver(_aiCore?: AiCapabilityLayer): BoundaryAmbiguityResolver {
  return new RuleBasedOnlyResolver();
}
