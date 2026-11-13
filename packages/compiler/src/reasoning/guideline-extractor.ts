/**
 * UW-3b — guidelines and checklists as constraints.
 *
 * A unit `semantic/structure.ts` routed to a structural extractor is read here instead of by the conditional-rule
 * patterns, which expect policy language ("if X then Y", "subject to", thresholds) and found nothing in "Never commit
 * secrets.":
 *
 *   guideline             a constraint carrying its directive, its MODALITY and POLARITY as decided from the language
 *                         (prohibition for "Never ..."/"Do not ...", obligation for an instruction or "must", advisory for
 *                         "should"), its title and its rationale. A prohibition is `blocking`, the rest `warning`.
 *   acceptance_criterion  a checklist item: a condition that must hold when the work is done — an obligation, attached
 *                         to the document's procedure when it has exactly one.
 *   procedure_step        a step capability (procedure-extractor.ts); only a PROHIBITION stated inside the step becomes a
 *                         constraint here, scoped to the step ("Never reuse an old gasket.").
 *   procedure_header, form_field
 *                         no reasoning node: a table header and an input.
 *
 * Every node keeps the unit's full span as provenance. Nothing here becomes an executable rule: a constraint has no
 * decision outcome (execution-readiness reports it as not executable, with that blocker), and no structured condition is
 * parsed out of a directive ("Understand before you build" is not a deadline).
 */
import type { CandidateReasoningNode } from './extractor-types.js';
import { splitSentences } from '../capabilities/sentence-split.js';
import { directiveOf } from '../semantic/directive.js';
import type { ExperienceUnit } from '../semantic/types.js';
import type { KnowledgeProvenance } from '../knowledge/types.js';

/** Metadata keys that override the language classifier's modality/polarity on the XOIR constraint (reasoning-to-xoir.ts). */
export const MODALITY_KEY = 'modality';
export const POLARITY_KEY = 'polarity';

function provenanceOf(unit: ExperienceUnit, confidence: number): KnowledgeProvenance {
  return {
    experienceUnitId: unit.id,
    documentPath: unit.provenance.documentPath,
    pages: unit.provenance.pages,
    sectionPath: unit.provenance.sectionPath,
    charOffsetRange: [0, unit.content.length],
    confidence,
  };
}

const STRUCTURAL_CONFIDENCE = 0.7;

function clean(text: string): string {
  return text.trim().replace(/[.;:]+$/, '');
}

/**
 * The reasoning nodes for a routed unit, or `undefined` when the unit was not routed (the caller then runs the ordinary
 * sentence patterns over it, exactly as before).
 */
export function structuralReasoningNodes(unit: ExperienceUnit): readonly CandidateReasoningNode[] | undefined {
  const structure = unit.structure;
  if (structure?.role === undefined) return undefined;
  if (structure.role === 'context') return [];
  const confidence = unit.layoutSuspect === true ? Math.min(unit.confidence, 0.4) : STRUCTURAL_CONFIDENCE;
  if (structure.role === 'guideline' && structure.guideline !== undefined) {
    const g = structure.guideline;
    const directive = clean(g.directive);
    const rationale = [g.title !== undefined && clean(g.title) !== directive ? clean(g.title) : undefined, g.rationale?.trim()]
      .filter((t): t is string => t !== undefined && t.length > 0)
      .join('. ');
    const nodeType = g.modality === 'prohibition' ? 'prohibition' : 'policy';
    return [
      {
        localId: '0:0',
        nodeType,
        canonicalLabel: directive,
        action: directive,
        ...(rationale.length > 0 ? { rationale } : {}),
        exceptionConditions: [],
        confidence,
        provenance: provenanceOf(unit, confidence),
        metadata: {
          matchedPattern: 'guideline:list-item',
          [MODALITY_KEY]: g.modality,
          [POLARITY_KEY]: g.polarity,
          ...(g.title !== undefined ? { title: clean(g.title) } : {}),
          severity: g.modality === 'prohibition' ? 'blocking' : 'warning',
        },
        sourceUnitId: unit.id,
      },
    ];
  }
  if (structure.role === 'acceptance_criterion') {
    const criterion = clean(unit.content);
    if (criterion.length === 0) return [];
    const negative = /^(?:no|never|nothing|none)\b/i.test(criterion);
    return [
      {
        localId: '0:0',
        nodeType: 'acceptance_criterion',
        canonicalLabel: criterion,
        action: criterion,
        exceptionConditions: [],
        confidence,
        provenance: provenanceOf(unit, confidence),
        metadata: {
          matchedPattern: 'checklist:acceptance-criterion',
          [MODALITY_KEY]: 'obligation',
          [POLARITY_KEY]: negative ? 'negative' : 'positive',
          severity: 'warning',
          ...(unit.listItem?.checkbox !== undefined ? { checkbox: unit.listItem.checkbox } : {}),
          ...(structure.appliesTo !== undefined
            ? { appliesTo: structure.appliesTo.procedureKey, appliesToTitle: structure.appliesTo.procedureTitle }
            : {}),
        },
        sourceUnitId: unit.id,
      },
    ];
  }
  // A procedure step is a step capability (procedure-extractor.ts). A prohibition stated inside it ("Fit the new seal kit.
  // Never reuse an old gasket.") is also a rule of conduct in its own right, so it becomes a prohibition constraint scoped
  // to that step; the step's positive instructions stay its actions, not constraints.
  if (structure.role === 'procedure_step' && structure.step !== undefined) {
    const step = structure.step;
    return splitSentences(step.action)
      .map((s) => s.text.trim())
      .filter((sentence) => directiveOf(sentence)?.modality === 'prohibition')
      .map((sentence, k) => {
        const directive = clean(sentence);
        return {
          localId: `0:${k}`,
          nodeType: 'prohibition' as const,
          canonicalLabel: directive,
          action: directive,
          exceptionConditions: [],
          confidence,
          provenance: provenanceOf(unit, confidence),
          metadata: {
            matchedPattern: 'guideline:step-prohibition',
            [MODALITY_KEY]: 'prohibition',
            [POLARITY_KEY]: 'negative',
            severity: 'blocking',
            appliesTo: step.procedureKey,
            appliesToTitle: `${step.procedureTitle}, step ${step.ordinal}${step.label !== undefined ? ` (${step.label})` : ''}`,
          },
          sourceUnitId: unit.id,
        };
      });
  }
  // A step-table header and a form field are represented elsewhere (nothing, an input).
  return [];
}
