import { ok, type Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import { detectDefinedTerm } from '../semantic/lexical-cues.js';
import type { ExperienceUnit } from '../semantic/types.js';
import { detectOperationalContent } from './action-process-detector.js';
import { detectCapitalizedRuns } from './capitalized-run-detector.js';
import type { CandidateKnowledgeNode, ExtractionResult, KnowledgeExtractor } from './extractor-types.js';
import type { KnowledgeNodeType, KnowledgeProvenance } from './types.js';

const CORPORATE_SUFFIX_WORDS = new Set(['inc', 'inc.', 'llc', 'ltd', 'ltd.', 'corp', 'corp.', 'corporation', 'co', 'co.']);

/** Maps a Stage 3 `SemanticType` to the knowledge node type its unit-level node should carry. `right` has no direct counterpart in the compiler spec's node-type list, so it becomes `custom:right` — an honest, explicit extension rather than forcing it into an unrelated known type. */
function mapSemanticTypeToNodeType(semanticType: ExperienceUnit['semanticType']): KnowledgeNodeType {
  switch (semanticType) {
    case 'definition':
      return 'definition';
    case 'obligation':
      return 'obligation';
    case 'exception':
      return 'exception';
    case 'right':
      return 'custom:right';
    case 'explanatory_note':
      return 'reference';
    case 'clause':
    case 'general':
      return 'concept';
    default:
      return 'concept';
  }
}

function baseProvenance(unit: ExperienceUnit, confidence: number, charOffsetRange: readonly [number, number] | undefined): KnowledgeProvenance {
  return {
    experienceUnitId: unit.id,
    documentPath: unit.provenance.documentPath,
    pages: unit.provenance.pages,
    sectionPath: unit.provenance.sectionPath,
    charOffsetRange,
    confidence,
  };
}

function stripTrailingPeriod(word: string): string {
  return word.endsWith('.') ? word.slice(0, -1) : word;
}

function lastWordOf(text: string): string {
  const trimmed = text.trimEnd();
  const lastSpace = trimmed.lastIndexOf(' ');
  return stripTrailingPeriod((lastSpace === -1 ? trimmed : trimmed.slice(lastSpace + 1)).toLowerCase());
}

/**
 * The always-available extractor: never calls a network, never fails
 * (always returns `ok`), and produces a lower-confidence but structurally
 * grounded graph purely from Stage 3's own output plus manual
 * capitalized-run detection. Two things per unit:
 *
 * 1. One "unit primary" node (`localId: 'primary'`), mapping the unit's
 *    own Stage 3 `semanticType` onto a knowledge node type (a
 *    `definition` unit's node uses the actual defined term, via
 *    `detectDefinedTerm`, as its label — falling back to the unit's own
 *    title when no quoted-term pattern is present).
 * 2. Zero or more `entity`/`organization` candidates, one per detected
 *    capitalized word run in the unit's content (`organization` when the
 *    run's last word is a corporate suffix like "Inc"/"LLC", `entity`
 *    otherwise).
 *
 * Produces no edges of its own — Stage 3's relationship graph is
 * projected onto unit-primary nodes centrally, in
 * `relationship-builder.ts`, regardless of which extractor(s) ran.
 */
export class RuleBasedKnowledgeExtractor implements KnowledgeExtractor {
  readonly name = 'rule-based';

  async extract(unit: ExperienceUnit): Promise<Result<ExtractionResult, XoError>> {
    const nodes: CandidateKnowledgeNode[] = [];

    const definedTerm = unit.semanticType === 'definition' ? detectDefinedTerm(unit.content) : undefined;
    const primaryLabel = definedTerm ?? unit.title;
    const primaryConfidence = definedTerm !== undefined ? Math.min(unit.confidence, 0.85) : Math.min(unit.confidence, 0.7);
    const mappedType = mapSemanticTypeToNodeType(unit.semanticType);
    // Stage 4 operational-content detection only ever runs where Stage 3
    // found no higher-confidence cue at all (the `concept` fallback) —
    // every established classification (definition/obligation/exception/
    // right/reference) stays exactly as `mapSemanticTypeToNodeType`
    // already produced it, unexamined and unchanged. See
    // `action-process-detector.ts`'s doc comment for why this ordering
    // is what makes existing classifications authoritative.
    const primaryType = mappedType === 'concept' ? (detectOperationalContent(unit.content) ?? mappedType) : mappedType;
    nodes.push({
      localId: 'primary',
      semanticType: primaryType,
      label: primaryLabel,
      confidence: primaryConfidence,
      provenance: baseProvenance(unit, primaryConfidence, [0, unit.content.length]),
      metadata: { summary: unit.content.slice(0, 280) },
      isUnitPrimary: true,
      sourceUnitId: unit.id,
    });

    let entityIndex = 0;
    for (const run of detectCapitalizedRuns(unit.content)) {
      if (run.wordCount === 1 && CORPORATE_SUFFIX_WORDS.has(stripTrailingPeriod(run.text.toLowerCase()))) continue; // a bare "Inc." with nothing before it isn't a usable name
      const isOrganization = CORPORATE_SUFFIX_WORDS.has(lastWordOf(run.text));
      const confidence = run.wordCount >= 2 ? 0.65 : 0.5;
      nodes.push({
        localId: `entity-${entityIndex}`,
        semanticType: isOrganization ? 'organization' : 'entity',
        label: run.text,
        confidence,
        provenance: baseProvenance(unit, confidence, [run.startOffset, run.endOffset]),
        metadata: {},
        isUnitPrimary: false,
        sourceUnitId: unit.id,
      });
      entityIndex += 1;
    }

    return ok({ nodes, edges: [] });
  }
}
