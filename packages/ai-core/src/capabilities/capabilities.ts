/** Stage 6's target shape: extractCapabilities(). Professional capabilities the source material demonstrates (e.g. Contract Review, Risk Analysis, Negotiation, Clause Comparison, Compliance Analysis) — named "AiExtractedCapability" here to avoid colliding with this package's own "AI capability" terminology (extractEntities() etc. are AI capabilities; a "Contract Review" finding is a professional capability the source demonstrates). */

export interface AiExtractedCapability {
  readonly name: string;
  readonly description: string;
  readonly evidenceExcerptOffsets: readonly (readonly [number, number])[]; // [startOffset, endOffset] pairs into the request excerpt
  readonly confidence: number;
}

export interface CapabilityExtractionInput {
  readonly domainHint?: string;
}

export interface CapabilityExtractionOutput {
  readonly capabilities: readonly AiExtractedCapability[];
}
