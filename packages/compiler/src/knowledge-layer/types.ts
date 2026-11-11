/**
 * Domain Knowledge Pack: reusable REFERENCE knowledge about one domain, used to help the compiler recognise what a document
 * is about and which concepts a term denotes.
 *
 * Authority model: the structured fields below ARE the knowledge. Retrieval (structured lookup, BM25, vectors) is only an
 * access path over them and never an authority. A pack never says what a particular document CONTAINS — extraction stays
 * grounded in the document — and it is not the Business Knowledge Base, which holds instance-specific, evidence-backed facts
 * about one organisation (different namespace, trust model and lifecycle).
 */
export type ConceptKind = 'entity' | 'term' | 'action' | 'condition' | 'constraint' | 'process';

export interface DomainConcept {
  readonly id: string;
  readonly label: string;
  readonly kind: ConceptKind;
  readonly definition: string;
  readonly synonyms: readonly string[];
  /**
   * Specificity in (0, 1]: how strongly an occurrence signals THIS domain. Words that are common outside the domain
   * ("policy", "claim", "interest", "delivery") carry a low weight so they cannot identify a domain on their own.
   */
  readonly weight: number;
}

export interface DomainRelationship {
  readonly from: string;
  readonly type: string;
  readonly to: string;
}

/** A recurring way the domain phrases a rule, with a grounded example. Descriptive only; not an extraction rule. */
export interface SemanticPattern {
  readonly id: string;
  readonly description: string;
  readonly example: string;
  readonly conceptIds: readonly string[];
}

export interface DomainKnowledgePack {
  readonly id: string;
  readonly version: string;
  readonly domain: string;
  readonly description: string;
  /** Where this knowledge came from and who vouches for it. */
  readonly provenance: string;
  /** `draft` until reviewed by a domain expert. Built-in packs are drafts authored for this compiler. */
  readonly status: 'draft' | 'reviewed';
  readonly concepts: readonly DomainConcept[];
  readonly relationships: readonly DomainRelationship[];
  readonly patterns: readonly SemanticPattern[];
}
