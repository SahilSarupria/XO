import { ok, type Result } from '@xo/types';
import { parseStructuredCondition } from '@xo/capability-contract';
import type { XoError } from '@xo/errors';
import type { ExperienceUnit } from '../semantic/types.js';
import type { KnowledgeProvenance } from '../knowledge/types.js';
import { splitSentences } from '../capabilities/sentence-split.js';
import { parseSentence, type ParsedReasoningCandidate } from './rule-pattern-parser.js';
import type {
  CandidateReasoningEdgeRef,
  CandidateReasoningNode,
  ReasoningExtractionResult,
  ReasoningExtractor,
} from './extractor-types.js';
import { buildStructuredSemantics } from './structured-semantics.js';
import { findDecisionCues, tableRowStatement } from './decision-cues.js';
import type { UnclassifiedSentence } from './types.js';
import { sourceKey, type ConfirmedRule } from './rule-proposals.js';

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
/** A confirmed proposal as an ordinary rule candidate. The human confirmation stands in for the pattern match; the grammar check is repeated here so a stale or hand-edited confirmation cannot smuggle in a condition the runtime cannot run. */
function confirmedParse(text: string, rule: ConfirmedRule): ReturnType<typeof parseSentence> {
  if (parseStructuredCondition(rule.condition) === undefined) return { candidates: [], edges: [] };
  return {
    candidates: [
      {
        nodeType: 'rule',
        canonicalLabel: text.trim(),
        condition: rule.condition,
        action: rule.outcome,
        rationale: text.trim(),
        exceptionConditions: [],
        confidence: 0.75,
        matchedPattern: 'rule:confirmed-proposal',
      },
    ],
    edges: [],
  };
}

export class RuleBasedReasoningExtractor implements ReasoningExtractor {
  readonly name = 'rule-based';
  private readonly confirmed: ReadonlyMap<string, ConfirmedRule>;

  /** `confirmedRules`: human-confirmed proposals (WS1-09), matched to a sentence by its normalised text. */
  constructor(confirmedRules: readonly ConfirmedRule[] = []) {
    this.confirmed = new Map(confirmedRules.map((r) => [sourceKey(r.sourceText), r]));
  }

  async extract(unit: ExperienceUnit): Promise<Result<ReasoningExtractionResult, XoError>> {
    const nodes: CandidateReasoningNode[] = [];
    const edges: CandidateReasoningEdgeRef[] = [];
    const unclassified: UnclassifiedSentence[] = [];

    // WS1-03: a table row is read as header-bound facts ("Coverage: Buildings; Limit: 1000000; Excess: 1000"). When a
    // decision-bearing column has a value, the row becomes a `policy` (constraint) node: a recorded term of the
    // document, never an executable rule (no condition, no outcome). Rows stay out of the sentence patterns because
    // their cell text is not prose.
    if (unit.tableRow !== undefined) {
      const row = tableRowStatement(unit.tableRow.header, unit.tableRow.cells);
      if (row !== undefined) {
        const confidence = Math.min(unit.confidence, 0.65);
        const structuredSemantics = buildStructuredSemantics({
          nodeType: 'policy',
          action: row.text,
          exceptionConditions: [],
        });
        nodes.push({
          localId: '0:0',
          nodeType: 'policy',
          canonicalLabel: row.text,
          action: row.text,
          exceptionConditions: [],
          confidence,
          provenance: baseProvenance(unit, confidence, [0, unit.content.length]),
          metadata: { matchedPattern: 'policy:table-row-term' },
          sourceUnitId: unit.id,
          ...structuredSemantics,
        });
      }
      return ok({ nodes, edges, unclassified });
    }

    const sentences = splitSentencesByParagraph(unit.content);
    for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
      const sentence = sentences[sentenceIndex]!;
      const confirmedRule = this.confirmed.get(sourceKey(sentence.text));
      const parsed =
        parseSentence(sentence.text).candidates.length === 0 && confirmedRule !== undefined
          ? confirmedParse(sentence.text, confirmedRule)
          : parseSentence(sentence.text);
      if (parsed.candidates.length === 0) {
        // WS1-04: a sentence the patterns rejected is reported when it looks decision-bearing,
        // never silently dropped. It is a review item only; nothing downstream consumes it as a rule.
        const cues = findDecisionCues(sentence.text);
        if (cues.length > 0) {
          unclassified.push({
            text: sentence.text.trim(),
            cues,
            sourceUnitId: unit.id,
            provenance: baseProvenance(unit, unit.confidence, [sentence.startOffset, sentence.endOffset]),
          });
        }
        continue;
      }

      const labelToLocalId = new Map<string, string>();
      parsed.candidates.forEach((candidate: ParsedReasoningCandidate, candidateIndex: number) => {
        const localId = `${sentenceIndex}:${candidateIndex}`;
        labelToLocalId.set(candidate.canonicalLabel, localId);
        // A normalised rule (or an explicit rule whose condition parses in the runtime grammar) matched an exact pattern and its condition was re-validated by
        // the runtime's own parser, so the paragraph-type classifier's uncertainty about the surrounding unit does
        // not cap it. Every other pattern keeps the conservative min().
        const groundedRule =
          candidate.matchedPattern.startsWith('rule:normalized-') ||
          ((candidate.nodeType === 'rule' || candidate.nodeType === 'decision') &&
            candidate.condition !== undefined &&
            parseStructuredCondition(candidate.condition) !== undefined);
        const confidence = groundedRule ? candidate.confidence : Math.min(unit.confidence, candidate.confidence);
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

    return ok({ nodes, edges, unclassified });
  }
}
