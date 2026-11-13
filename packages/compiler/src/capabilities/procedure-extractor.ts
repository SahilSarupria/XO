/**
 * UW-3b — a procedure's steps as capabilities.
 *
 * `semantic/structure.ts` gives each step of a routed procedure section (a step table's row, or a numbered instruction)
 * its facts: the procedure it belongs to, its position, the author's short name for it, what to do and when it is done.
 * Each step becomes ONE capability:
 *
 *   name         the author's step name ("Set up") when the table has a step column, else verb + object from the first
 *                clause of what to do ("Pull latest code"); never text from two columns
 *   description  what to do, exactly as written (one column)
 *   metadata     step.* — procedure, ordinal, label, the individual actions, done-when, inputs/outputs/owner columns
 *
 * The steps are ordered by `custom:sequence` edges (`relationship-builder.ts`), so the workflow composer reads them as
 * one ordered workflow. When the procedure starts from a fill-in form, the form's fields are the FIRST step's inputs; a
 * definition-of-done checklist becomes acceptance-criterion constraints tied to the procedure (`reasoning/guideline-extractor.ts`).
 *
 * A step is a MANUAL step: the document says what a person does, not which system operation does it, so the step has no
 * operation contract and is never bound to a connector or made executable by this module (`understanding: manual-step`).
 */
import type { KnowledgeProvenance } from '../knowledge/types.js';
import type { ExperienceUnit } from '../semantic/types.js';
import { imperativeClause, isActionVerb } from '../semantic/directive.js';
import { isBaseVerb } from '../semantic/english-verbs.js';
import { CAPABILITY_VERBS } from './capability-lexicon.js';
import { nameFromClause } from './clause.js';
import { isPlausibleCandidateName } from './candidate-plausibility.js';
import { splitSentences } from './sentence-split.js';
import { synthesizeTitle } from '../semantic/title.js';
import { UNKNOWN_SIGNATURE, type CapabilityCategory } from './types.js';
import type { CandidateCapability } from './extractor-types.js';

export const PROCEDURE_STEP_EXTRACTOR = 'procedure-step';

/** The producer that `producedBy` records for step and procedure capabilities (a named extractor, like the others). */
export class ProcedureStepCapabilityExtractor {
  readonly name = 'procedure-step';
  readonly step = stepCandidate;
}
export const STRUCTURE_ROLE_KEY = 'structure.role';
export const UNDERSTANDING_KEY = 'understanding';
export const MANUAL_STEP = 'manual-step';

/** Confidence of a step read from explicit structure (a numbered step table or numbered list). */
const STEP_CONFIDENCE = 0.75;
/** ... when the unit's text was joined across columns (should not happen for a reconstructed table, but is checked). */
const SUSPECT_STEP_CONFIDENCE = 0.4;

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

function listCell(text: string | undefined): readonly string[] {
  if (text === undefined) return [];
  return text
    .split(/[,;]|\band\b/)
    .map((s) => s.trim().replace(/\.$/, ''))
    .filter((s) => s.length > 0);
}

/** "Read the task. Write the goal in one sentence." → one entry per instruction. */
export function actionsOf(action: string): readonly string[] {
  return splitSentences(action)
    .map((s) => s.text.trim())
    .filter((s) => s.length > 0);
}

/** A step's name keeps its whole first clause, up to this many words after the verb. */
const STEP_NAME_MAX_OBJECT_WORDS = 12;

function stepNameAndCategory(label: string | undefined, action: string): { name: string; category: CapabilityCategory } {
  const first = actionsOf(action)[0] ?? action;
  // UW-3c: the name starts at the instruction's verb, past a lead clause ("When complete, paste ..." → "Paste ...").
  const main = imperativeClause(first) ?? first;
  const words = main.split(/\s+/).filter((w) => w.length > 0);
  const lead = (words[0] ?? '').replace(/[^\p{L}-]/gu, '').toLowerCase();
  const category: CapabilityCategory = CAPABILITY_VERBS[lead] ?? 'action';
  if (label !== undefined && isPlausibleCandidateName(label)) return { name: label, category };
  if (isActionVerb(lead) || isBaseVerb(lead))
    return { name: nameFromClause(words, 0, lead, STEP_NAME_MAX_OBJECT_WORDS).name.replace(/[,;:]+$/, ''), category };
  return { name: synthesizeTitle(first).replace(/[.…,;:]+$/, ''), category };
}

/** The step capability for a unit whose role is `procedure_step`; undefined for any other unit. */
export function stepCandidate(unit: ExperienceUnit): CandidateCapability | undefined {
  const step = unit.structure?.role === 'procedure_step' ? unit.structure.step : undefined;
  if (step === undefined) return undefined;
  const { name, category } = stepNameAndCategory(step.label, step.action);
  if (!isPlausibleCandidateName(name)) return undefined;
  const confidence = unit.layoutSuspect === true ? SUSPECT_STEP_CONFIDENCE : STEP_CONFIDENCE;
  const actions = actionsOf(step.action);
  const entry = (step.entryInputs ?? [])
    .map((f) => ({ name: fieldName(f.label), description: f.hint ?? '' }))
    .filter((f) => f.name.length > 0);
  return {
    localId: 'step',
    category,
    name,
    description: step.action,
    confidence,
    provenance: provenanceOf(unit, confidence),
    inputs: [...entry.map((f) => f.name), ...listCell(step.inputs)],
    outputs: listCell(step.outputs),
    requiredKnowledgeNodeIds: [],
    relatedConcepts: [],
    invocationHints: [],
    examples: [],
    signature: entry.length > 0 ? { ...UNKNOWN_SIGNATURE, inputs: entry } : UNKNOWN_SIGNATURE,
    metadata: {
      [STRUCTURE_ROLE_KEY]: 'procedure-step',
      [UNDERSTANDING_KEY]: MANUAL_STEP,
      'step.procedure': step.procedureKey,
      'step.procedureTitle': step.procedureTitle,
      'step.ordinal': String(step.ordinal),
      ...(step.label !== undefined ? { 'step.label': step.label } : {}),
      'step.actions': actions.join('\n'),
      ...(step.doneWhen !== undefined ? { 'step.doneWhen': step.doneWhen } : {}),
      ...(step.owner !== undefined ? { 'step.owner': step.owner } : {}),
      ...(entry.length > 0 ? { 'step.inputsFrom': 'form' } : {}),
      ...(unit.layoutSuspect === true ? { 'quality.flags': 'cross-column', 'quality.review': 'possible-extraction-error' } : {}),
    },
    sourceUnitId: unit.id,
    extractorName: PROCEDURE_STEP_EXTRACTOR,
  };
}

/** "Goal (1-2 lines)" → "Goal". */
function fieldName(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, '').trim();
}
