import { ok, type Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import type { ExperienceUnit } from '../semantic/types.js';
import type { KnowledgeProvenance } from '../knowledge/types.js';
import { splitSentences } from '../capabilities/sentence-split.js';
import { parseSentence, type ParsedReasoningCandidate } from './rule-pattern-parser.js';
import type { CandidateReasoningEdgeRef, CandidateReasoningNode, ReasoningExtractionResult, ReasoningExtractor } from './extractor-types.js';
import { buildStructuredSemantics } from './structured-semantics.js';

interface Paragraph {
  readonly text: string;
  readonly start: number;
}

function isBlank(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r';
}

/**
 * Splits `content` on blank-line paragraph boundaries before handing each
 * paragraph to `splitSentences`. `splitSentences` (Phase 0, frozen, shared
 * with capability extraction) only breaks on terminal punctuation
 * (`.`/`!`/`?`) — a deliberate, documented simplification for its own
 * purpose. Real source documents (see `examples/vertical-test/burglary-
 * policy.pdf`'s "Special Conditions and Exclusions" section) routinely
 * reconstruct as several distinct rule-bearing clauses separated only by
 * blank lines, with no terminal punctuation on any but the last: without
 * this pre-split, `splitSentences` would silently fuse five or six
 * separate exclusion/warranty clauses into a single unparseable run-on
 * "sentence," which is a real rule-recall loss, not a rule-pattern
 * problem. Splitting on paragraph breaks first — additive, since it only
 * ever introduces *more* boundaries than `splitSentences` would find on
 * its own — fixes this at the rule-candidate-generation stage without
 * touching `sentence-split.ts` itself (so Phase 0's capability-extraction
 * behavior, which depends on that module's exact current behavior, is
 * untouched).
 */
function splitIntoParagraphs(content: string): readonly Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const n = content.length;
  let paraStart = 0;
  let i = 0;
  while (i < n) {
    if (content[i] === '\n') {
      let j = i + 1;
      while (j < n && isBlank(content[j])) j += 1;
      if (content[j] === '\n') {
        paragraphs.push({ text: content.slice(paraStart, i), start: paraStart });
        let k = j;
        while (k < n && (content[k] === '\n' || isBlank(content[k]))) k += 1;
        paraStart = k;
        i = k;
        continue;
      }
    }
    i += 1;
  }
  paragraphs.push({ text: content.slice(paraStart), start: paraStart });
  return paragraphs;
}

function splitSentencesByParagraph(content: string): readonly { text: string; startOffset: number; endOffset: number }[] {
  const sentences: { text: string; startOffset: number; endOffset: number }[] = [];
  for (const paragraph of splitIntoParagraphs(content)) {
    for (const sentence of splitSentences(paragraph.text)) {
      sentences.push({
        text: sentence.text,
        startOffset: sentence.startOffset + paragraph.start,
        endOffset: sentence.endOffset + paragraph.start,
      });
    }
  }
  return sentences;
}

function baseProvenance(unit: ExperienceUnit, confidence: number, charOffsetRange: readonly [number, number]): KnowledgeProvenance {
  return {
    experienceUnitId: unit.id,
    documentPath: unit.provenance.documentPath,
    pages: unit.provenance.pages,
    sectionPath: unit.provenance.sectionPath,
    charOffsetRange,
    confidence,
  };
}

/**
 * The always-available Stage 7 extractor: never calls a network, never
 * fails (always returns `ok`), and runs `rule-pattern-parser.ts`'s
 * conservative sentence patterns over every sentence of every unit.
 *
 * Local ids are `${sentenceIndex}:${candidateIndexWithinSentence}`,
 * scoped to this unit — `merge.ts` resolves them to final,
 * content-hash-derived `ReasoningNodeId`s, exactly the same two-phase
 * candidate → merge design `../knowledge/rule-based-extractor.ts` and
 * `../knowledge/merge.ts` use.
 */
export class RuleBasedReasoningExtractor implements ReasoningExtractor {
  readonly name = 'rule-based';

  async extract(unit: ExperienceUnit): Promise<Result<ReasoningExtractionResult, XoError>> {
    const nodes: CandidateReasoningNode[] = [];
    const edges: CandidateReasoningEdgeRef[] = [];

    const sentences = splitSentencesByParagraph(unit.content);
    for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
      const sentence = sentences[sentenceIndex]!;
      const parsed = parseSentence(sentence.text);
      if (parsed.candidates.length === 0) continue;

      const labelToLocalId = new Map<string, string>();
      parsed.candidates.forEach((candidate: ParsedReasoningCandidate, candidateIndex: number) => {
        const localId = `${sentenceIndex}:${candidateIndex}`;
        labelToLocalId.set(candidate.canonicalLabel, localId);
        const confidence = Math.min(unit.confidence, candidate.confidence);
        const structuredSemantics = buildStructuredSemantics({
          nodeType: candidate.nodeType,
          ...(candidate.condition !== undefined ? { condition: candidate.condition } : {}),
          ...(candidate.action !== undefined ? { action: candidate.action } : {}),
          ...(candidate.outcome !== undefined ? { outcome: candidate.outcome } : {}),
          exceptionConditions: candidate.exceptionConditions,
        });
        nodes.push({
          localId,
          nodeType: candidate.nodeType,
          canonicalLabel: candidate.canonicalLabel,
          ...(candidate.condition !== undefined ? { condition: candidate.condition } : {}),
          ...(candidate.action !== undefined ? { action: candidate.action } : {}),
          ...(candidate.outcome !== undefined ? { outcome: candidate.outcome } : {}),
          ...(candidate.rationale !== undefined ? { rationale: candidate.rationale } : {}),
          exceptionConditions: candidate.exceptionConditions,
          confidence,
          provenance: baseProvenance(unit, confidence, [sentence.startOffset, sentence.endOffset]),
          metadata: { matchedPattern: candidate.matchedPattern },
          sourceUnitId: unit.id,
          ...structuredSemantics,
        });
      });

      for (const edge of parsed.edges) {
        const fromLocalId = labelToLocalId.get(edge.fromLabel);
        const toLocalId = labelToLocalId.get(edge.toLabel);
        if (fromLocalId === undefined) continue; // toLabel referencing another sentence's node is resolved later, in linking.ts — not this extractor's job
        if (toLocalId !== undefined) {
          const confidence = Math.min(unit.confidence, edge.confidence);
          edges.push({
            type: edge.type,
            fromLocalId,
            toLocalId,
            confidence,
            provenance: baseProvenance(unit, confidence, [sentence.startOffset, sentence.endOffset]),
          });
        }
      }
    }

    return ok({ nodes, edges });
  }
}
