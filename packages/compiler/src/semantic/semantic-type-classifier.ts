import type { DocumentBlock } from '../document/types.js';
import { containsAnyPhrase, DEFINITION_CUES, detectDefinedTerm, EXAMPLE_CUES, EXCEPTION_CUES, OBLIGATION_CUES, RIGHT_CUES } from './lexical-cues.js';
import type { SemanticType } from './types.js';

export interface ClassificationResult {
  readonly semanticType: SemanticType;
  readonly confidence: number;
  readonly definedTerm: string | undefined;
}

function textOf(block: DocumentBlock): string {
  return block.kind === 'table_row' ? block.cells.join(' ') : block.text;
}

/**
 * Classifies one block by structural kind first (a footnote block is
 * unambiguously `explanatory_note`, full confidence — no lexical
 * judgment needed), then by lexical cue for everything else, in a fixed
 * priority order (a defined-term pattern is checked first since it is
 * the most specific signal; an exception marker next, since "shall...
 * unless..." reads primarily as an exception, not a bare obligation).
 * List items with no lexical hit default to `clause` (an enumerated
 * point is a clause by structure, even with no rhetorical cue); plain
 * paragraphs with no hit default to `general`.
 */
export function classifyBlock(block: DocumentBlock): ClassificationResult {
  if (block.kind === 'footnote') {
    return { semanticType: 'explanatory_note', confidence: 1, definedTerm: undefined };
  }

  const text = textOf(block);

  const definedTerm = detectDefinedTerm(text);
  if (definedTerm !== undefined) {
    return { semanticType: 'definition', confidence: 0.9, definedTerm };
  }
  if (containsAnyPhrase(text, EXCEPTION_CUES)) {
    return { semanticType: 'exception', confidence: 0.8, definedTerm: undefined };
  }
  if (containsAnyPhrase(text, EXAMPLE_CUES)) {
    return { semanticType: 'example', confidence: 0.8, definedTerm: undefined };
  }
  if (containsAnyPhrase(text, OBLIGATION_CUES)) {
    return { semanticType: 'obligation', confidence: 0.75, definedTerm: undefined };
  }
  if (containsAnyPhrase(text, RIGHT_CUES)) {
    return { semanticType: 'right', confidence: 0.75, definedTerm: undefined };
  }
  if (block.kind === 'list_item') {
    return { semanticType: 'clause', confidence: 0.6, definedTerm: undefined };
  }
  return { semanticType: 'general', confidence: 0.5, definedTerm: undefined };
}

// Re-exported so callers of this module never need to import lexical-cues.ts directly for the common "does this look like a definition" check.
export { DEFINITION_CUES };
