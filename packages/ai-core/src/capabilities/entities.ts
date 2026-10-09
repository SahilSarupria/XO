/** Stage 4's target shape: extractEntities(). Legal entities per the compiler frontend's spec — organizations, clauses, laws, jurisdictions, people, contract types, legal concepts, obligations, rights, risks, deadlines. */

export type LegalEntityType = 'organization' | 'person' | 'clause' | 'law' | 'jurisdiction' | 'contract_type' | 'legal_concept' | 'obligation' | 'right' | 'risk' | 'deadline';

export interface ExtractedEntity {
  readonly type: LegalEntityType;
  readonly text: string;
  /** Character offsets into the request's `excerpt.text` — provenance down to the exact substring, not just "somewhere in this chunk." */
  readonly startOffset: number;
  readonly endOffset: number;
  readonly normalizedValue?: string;
  readonly confidence: number; // 0.0-1.0
}

export interface EntityExtractionInput {
  readonly entityTypes?: readonly LegalEntityType[]; // omit to extract every known type
}

export interface EntityExtractionOutput {
  readonly entities: readonly ExtractedEntity[];
}
