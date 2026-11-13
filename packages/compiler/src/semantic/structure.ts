/**
 * UW-3b — document-kind routing.
 *
 * Decides, per section, what kind of content it carries (a procedure, guidelines, a checklist, a fill-in form, a data
 * table, policy rules or reference text) from the section's STRUCTURE (step tables, numbered or ticked items, form
 * fields) and LANGUAGE (instructions, prohibitions, conditions), and gives each unit of a routed section its role. The
 * capability and reasoning extractors read that role: a procedure step becomes an ordered step, a guideline a
 * constraint with its modality, a checklist item an acceptance criterion, a form field an input. Units of an unrouted
 * section (policy, reference, data, or anything the evidence does not clearly support) keep today's extraction exactly.
 *
 * Deterministic and domain-neutral. Every decision carries its evidence and a confidence, and the document-level result
 * is a PROPOSAL (`status: 'proposed'`), like the document-kind proposals in `sources/kind-proposals.ts`. Routing is
 * fail-closed: a section is routed only when one kind clearly dominates (ROUTE_CONFIDENCE) and enough units support it.
 * Document text is data: nothing here follows or executes what the text says.
 */
import type {
  DocumentStructure,
  ExperienceDocument,
  ExperienceUnit,
  GuidelineFacts,
  ProcedureStepFacts,
  SectionKind,
  SectionStructure,
  StructureEvidence,
  UnitStructure,
} from './types.js';
import { directiveOf, isImperative, isQuestion } from './directive.js';
import { splitSentences } from '../capabilities/sentence-split.js';

/** A section is routed only when its winning kind holds at least this share of the section's structural evidence. */
export const ROUTE_CONFIDENCE = 0.6;
/** ... and at least this many units carry that kind's role (forms: fields). */
const MIN_ROUTED_UNITS = 2;
const MIN_FORM_FIELDS = 3;

const HEADING_CUES: readonly { readonly kind: SectionKind; readonly pattern: RegExp }[] = [
  { kind: 'checklist', pattern: /\b(?:check-?list|definition of done|acceptance criteria|done criteria|exit criteria)\b/i },
  {
    kind: 'procedure',
    pattern: /\b(?:procedures?|process|workflow|steps?|how to|instructions?|runbook|playbook|walkthrough|sop)\b/i,
  },
  {
    kind: 'guideline',
    pattern:
      /\b(?:rules?|guidelines?|principles?|standards?|conventions?|best practices?|do'?s and don'?ts|tips|code of conduct|etiquette|when you get stuck|troubleshooting)\b/i,
  },
  { kind: 'form', pattern: /\b(?:form|brief|fill in|details to provide|questionnaire|intake)\b/i },
];

const CHECKLIST_HEADING = HEADING_CUES.find((c) => c.kind === 'checklist')!.pattern;

const STEP_HEADER = /^(?:steps?|actions?|tasks?|activit(?:y|ies)|what to do|procedure|instructions?|how)$/i;
const ORDINAL_HEADER = /^(?:#|no\.?|nos?\.?|step\s*(?:#|no\.?)|sr\.?\s*no\.?|s\.?\s*no\.?|seq(?:uence)?|order)$/i;
const DONE_HEADER =
  /\b(?:done when|done|completion|complete when|acceptance|exit criteria|expected (?:result|outcome)|result|outcome|deliverables?|definition of done)\b/i;
const INPUT_HEADER = /\b(?:inputs?|prerequisites?|pre-?conditions?|needs?|requires?)\b/i;
const OUTPUT_HEADER = /\b(?:outputs?|produces?|artifacts?)\b/i;
const OWNER_HEADER = /\b(?:owner|who|responsible|role|assignee|actor)\b/i;
const DESCRIPTION_HEADER = /\b(?:what to do|description|details?|instructions?|actions?|how)\b/i;

/** "3. Step-by-Step Workflow" → "Step-by-Step Workflow". */
export function cleanHeading(text: string): string {
  return text
    .replace(/^\s*(?:\d+(?:\.\d+)*[.)]?|[A-Z][.)]|[ivxIVX]+[.)])\s+/, '')
    .replace(/\s*\((?:checklist|fill in first|optional)\)\s*$/i, '')
    .trim();
}

interface StepColumns {
  readonly ordinal?: number;
  readonly label?: number;
  readonly action: number;
  readonly doneWhen?: number;
  readonly inputs?: number;
  readonly outputs?: number;
  readonly owner?: number;
}

/** Which column of a table header is which, when the header describes steps. Undefined when it does not. */
export function stepColumns(header: readonly string[]): StepColumns | undefined {
  const cells = header.map((h) => h.trim());
  const find = (re: RegExp, exclude: readonly (number | undefined)[] = []): number | undefined => {
    const k = cells.findIndex((c, i) => re.test(c) && !exclude.includes(i));
    return k < 0 ? undefined : k;
  };
  const ordinal = find(ORDINAL_HEADER);
  const label = find(STEP_HEADER, [ordinal]);
  const doneWhen = find(DONE_HEADER, [ordinal, label]);
  const owner = find(OWNER_HEADER, [ordinal, label, doneWhen]);
  const inputs = find(INPUT_HEADER, [ordinal, label, doneWhen, owner]);
  const outputs = find(OUTPUT_HEADER, [ordinal, label, doneWhen, owner, inputs]);
  // The action column: an explicit description header, else the step column itself.
  let action = find(DESCRIPTION_HEADER, [ordinal, label, doneWhen, owner, inputs, outputs]);
  const labelIsShortName = label !== undefined && action !== undefined;
  if (action === undefined) action = label;
  if (action === undefined) return undefined;
  return {
    ...(ordinal !== undefined ? { ordinal } : {}),
    ...(labelIsShortName ? { label } : {}),
    action,
    ...(doneWhen !== undefined ? { doneWhen } : {}),
    ...(inputs !== undefined ? { inputs } : {}),
    ...(outputs !== undefined ? { outputs } : {}),
    ...(owner !== undefined ? { owner } : {}),
  };
}

function firstSentence(text: string): string {
  return splitSentences(text)[0]?.text ?? text.trim();
}

/** The directive an item states: its title when the title is an instruction, else the first instruction in its body. */
export function guidelineOf(text: string, title: string | undefined, body: string | undefined): GuidelineFacts | undefined {
  const titleDirective = title !== undefined ? directiveOf(title) : undefined;
  if (title !== undefined && titleDirective !== undefined) {
    return { directive: title, title, ...(body !== undefined ? { rationale: body } : {}), ...titleDirective };
  }
  if (title !== undefined && body !== undefined) {
    const sentences = splitSentences(body).map((s) => s.text);
    const k = sentences.findIndex((s) => directiveOf(s) !== undefined);
    if (k >= 0) {
      const rest = sentences.filter((_, i) => i !== k).join(' ');
      return { directive: sentences[k]!, title, ...(rest.length > 0 ? { rationale: rest } : {}), ...directiveOf(sentences[k]!)! };
    }
    return undefined;
  }
  const lead = firstSentence(text);
  const d = directiveOf(lead);
  if (d === undefined) return undefined;
  const rest = text.trim().slice(lead.length).trim();
  return { directive: lead, ...(rest.length > 0 ? { rationale: rest } : {}), ...d };
}

interface SectionGroup {
  readonly path: readonly string[];
  readonly heading: string | undefined;
  readonly units: ExperienceUnit[];
}

interface Scored {
  readonly kind: SectionKind;
  readonly score: number;
  readonly units: number;
  readonly evidence: StructureEvidence[];
}

function scoreSection(group: SectionGroup): { readonly scores: readonly Scored[]; readonly total: number } {
  const tally = new Map<SectionKind, { score: number; units: Set<string>; evidence: StructureEvidence[] }>();
  const add = (kind: SectionKind, score: number, unitId: string | undefined, signal: string, detail: string): void => {
    const t = tally.get(kind) ?? { score: 0, units: new Set<string>(), evidence: [] };
    t.score += score;
    if (unitId !== undefined) t.units.add(unitId);
    if (t.evidence.length < 6) t.evidence.push({ signal, detail });
    tally.set(kind, t);
  };

  let headerColumns: StepColumns | undefined;
  const checklistHeading = group.heading !== undefined && CHECKLIST_HEADING.test(group.heading);
  const topDepth = Math.min(
    ...group.units.filter((u) => u.listKind !== undefined).map((u) => u.listItem?.depth ?? 0),
    Number.MAX_SAFE_INTEGER,
  );
  for (const unit of group.units) {
    if (unit.tableRow !== undefined) {
      if (unit.tableRow.header === undefined) {
        headerColumns = stepColumns(unit.tableRow.cells);
        if (headerColumns !== undefined) add('procedure', 2, unit.id, 'step-table-header', unit.tableRow.cells.join(' | '));
        else add('data_table', 1, unit.id, 'table-header', unit.tableRow.cells.join(' | '));
      } else if (headerColumns !== undefined && stepColumns(unit.tableRow.header) !== undefined) {
        add('procedure', 2, unit.id, 'step-row', (unit.tableRow.cells[headerColumns.label ?? headerColumns.action] ?? '').slice(0, 60));
      } else {
        add('data_table', 1, unit.id, 'table-row', unit.tableRow.cells.slice(0, 3).join(' | ').slice(0, 60));
      }
      continue;
    }
    if (unit.formFields !== undefined) {
      for (const f of unit.formFields) add('form', 1, `${unit.id}:${f.label}`, 'form-field', f.label);
      continue;
    }
    if (unit.listKind !== undefined) {
      const item = unit.listItem;
      if (isQuestion(unit.content)) {
        add('reference', 1, unit.id, 'question', unit.content.slice(0, 60));
        continue;
      }
      if (item?.checkbox !== undefined) {
        add('checklist', 2, unit.id, 'checkbox-item', unit.content.slice(0, 60));
        continue;
      }
      // UW-3c: the items of a list under a heading that names a checklist are its items, numbered or not.
      if (checklistHeading) {
        add('checklist', 2, unit.id, 'checklist-heading-item', unit.content.slice(0, 60));
        continue;
      }
      const guideline = guidelineOf(unit.content, item?.title, item?.body);
      const imperative = isImperative(unit.content);
      const topLevel = (item?.depth ?? 0) <= topDepth;
      const weight = topLevel ? 1 : 0.25; // an item nested under another says little about what the section is
      if (item?.title !== undefined && guideline !== undefined) add('guideline', 2 * weight, unit.id, 'titled-rule', item.title);
      else if (guideline?.modality === 'prohibition')
        add('guideline', 2 * weight, unit.id, 'prohibition', guideline.directive.slice(0, 60));
      else if (unit.listKind === 'ordered' && imperative && topLevel)
        add('procedure', 1.5, unit.id, 'ordered-instruction', unit.content.slice(0, 60));
      else if (guideline !== undefined) add('guideline', weight, unit.id, 'instruction', guideline.directive.slice(0, 60));
      else add('reference', weight, unit.id, 'list-item', unit.content.slice(0, 60));
      continue;
    }
    // Prose: conditional rules point at policy, which stays with the existing extractors.
    if (
      /\b(?:if|unless|provided that|subject to|in the event|where)\b[^.]{3,},/i.test(unit.content) ||
      /\b(?:shall|must)\b/i.test(unit.content)
    ) {
      add('policy', 1, unit.id, 'conditional-or-deontic-prose', unit.content.slice(0, 60));
    } else {
      add('reference', 0.5, unit.id, 'prose', unit.content.slice(0, 60));
    }
  }
  if (group.heading !== undefined) {
    for (const cue of HEADING_CUES) {
      if (cue.pattern.test(group.heading) && tally.has(cue.kind)) add(cue.kind, 2, undefined, 'heading', group.heading);
    }
  }
  const scores = [...tally.entries()]
    .map(([kind, t]) => ({ kind, score: t.score, units: t.units.size, evidence: t.evidence }))
    .sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind));
  return { scores, total: scores.reduce((s, x) => s + x.score, 0) };
}

const ROUTABLE: ReadonlySet<SectionKind> = new Set<SectionKind>(['procedure', 'guideline', 'checklist', 'form']);

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function stepFacts(
  unit: ExperienceUnit,
  group: SectionGroup,
  columns: StepColumns,
  fallbackOrdinal: number,
): ProcedureStepFacts | undefined {
  const cells = unit.tableRow?.cells ?? [];
  const at = (k: number | undefined): string | undefined => {
    if (k === undefined) return undefined;
    const v = (cells[k] ?? '').trim();
    return v.length > 0 ? v : undefined;
  };
  const action = at(columns.action);
  if (action === undefined) return undefined;
  const ordinalText = at(columns.ordinal);
  const ordinal =
    ordinalText !== undefined && /^\d{1,3}[.)]?$/.test(ordinalText) ? Number(ordinalText.replace(/[.)]$/, '')) : fallbackOrdinal;
  const label = at(columns.label);
  return {
    procedureKey: group.path.join(' / '),
    procedureTitle: cleanHeading(group.heading ?? 'Procedure'),
    ordinal,
    ...(label !== undefined ? { label } : {}),
    action,
    ...(at(columns.doneWhen) !== undefined ? { doneWhen: at(columns.doneWhen)! } : {}),
    ...(at(columns.inputs) !== undefined ? { inputs: at(columns.inputs)! } : {}),
    ...(at(columns.outputs) !== undefined ? { outputs: at(columns.outputs)! } : {}),
    ...(at(columns.owner) !== undefined ? { owner: at(columns.owner)! } : {}),
  };
}

/**
 * Classifies every section of `doc`, assigns unit roles in the routed ones, and returns the document with each unit's
 * `structure` and the document's `structure` proposal. Units of unrouted sections are returned unchanged (no field
 * added), so their downstream extraction is exactly what it was.
 */
export function analyzeDocumentStructure(doc: ExperienceDocument): ExperienceDocument {
  const groups = new Map<string, SectionGroup>();
  for (const unit of doc.units) {
    const key = unit.provenance.sectionPath.join('\u0000');
    let g = groups.get(key);
    if (g === undefined) {
      g = { path: unit.provenance.sectionPath, heading: unit.provenance.sectionPath[unit.provenance.sectionPath.length - 1], units: [] };
      groups.set(key, g);
    }
    g.units.push(unit);
  }

  const sections: SectionStructure[] = [];
  const roles = new Map<string, UnitStructure>();
  for (const group of groups.values()) {
    const { scores, total } = scoreSection(group);
    const best = scores[0];
    if (best === undefined || total === 0) continue;
    const confidence = round2(best.score / total);
    // A tick box is the author's own mark: one checkbox item is enough to read a checklist.
    const boxedChecklist = best.kind === 'checklist' && best.evidence.some((e) => e.signal === 'checkbox-item');
    const enoughUnits = best.kind === 'form' ? best.units >= MIN_FORM_FIELDS : best.units >= (boxedChecklist ? 1 : MIN_ROUTED_UNITS);
    const routed = ROUTABLE.has(best.kind) && confidence >= ROUTE_CONFIDENCE && enoughUnits;
    sections.push({ sectionPath: group.path, kind: best.kind, confidence, routed, evidence: best.evidence });
    if (!routed) continue;

    let columns: StepColumns | undefined;
    let fallbackOrdinal = 0;
    const listUnits = group.units.filter((u) => u.listKind !== undefined);
    const topDepth = Math.min(...listUnits.map((u) => u.listItem?.depth ?? 0), Number.MAX_SAFE_INTEGER);
    const boxed = listUnits.some((u) => u.listItem?.checkbox !== undefined);
    for (let ui = 0; ui < group.units.length; ui++) {
      const unit = group.units[ui]!;
      const base = { sectionKind: best.kind };
      // UW-3c: a question in a routed section asks; it is read as context, never a step, rule or criterion.
      if (unit.listKind !== undefined && isQuestion(unit.content)) {
        roles.set(unit.id, { ...base, role: 'context' });
        continue;
      }
      const depth = unit.listItem?.depth ?? 0;
      const nextUnit = group.units[ui + 1];
      const hasChildren = nextUnit?.listKind !== undefined && (nextUnit.listItem?.depth ?? 0) > depth;
      if (best.kind === 'procedure') {
        if (unit.tableRow !== undefined && unit.tableRow.header === undefined) {
          columns = stepColumns(unit.tableRow.cells);
          if (columns !== undefined) roles.set(unit.id, { ...base, role: 'procedure_header' });
          continue;
        }
        if (unit.tableRow?.header !== undefined && columns !== undefined) {
          fallbackOrdinal += 1;
          const step = stepFacts(unit, group, columns, fallbackOrdinal);
          if (step !== undefined) {
            fallbackOrdinal = step.ordinal;
            roles.set(unit.id, { ...base, role: 'procedure_step', step });
          }
          continue;
        }
        if (unit.listKind !== undefined && depth > topDepth) {
          // An item nested under a step is guidance for that step: a rule when it states a directive, context otherwise.
          const g = guidelineOf(unit.content, unit.listItem?.title, unit.listItem?.body);
          roles.set(
            unit.id,
            g !== undefined ? { ...base, sectionKind: 'guideline', role: 'guideline', guideline: g } : { ...base, role: 'context' },
          );
          continue;
        }
        if (unit.listKind === 'ordered' && isImperative(unit.content)) {
          fallbackOrdinal += 1;
          const ordinal = unit.listItem?.ordinal ?? fallbackOrdinal;
          fallbackOrdinal = ordinal;
          roles.set(unit.id, {
            ...base,
            role: 'procedure_step',
            step: {
              procedureKey: group.path.join(' / '),
              procedureTitle: cleanHeading(group.heading ?? 'Procedure'),
              ordinal,
              action: unit.content.trim(),
            },
          });
        }
        continue;
      }
      if (best.kind === 'guideline' && unit.listKind !== undefined) {
        const g = guidelineOf(unit.content, unit.listItem?.title, unit.listItem?.body);
        if (g !== undefined) roles.set(unit.id, { ...base, role: 'guideline', guideline: g });
        continue;
      }
      if (best.kind === 'checklist' && unit.listKind !== undefined) {
        if (boxed && unit.listItem?.checkbox === undefined) {
          // In a checklist of tick boxes, an item without a box is a group label or a note: a directive is a rule, the rest
          // is context ("Protect matching branches", "Note: the list will not populate until ...").
          const g = hasChildren ? undefined : guidelineOf(unit.content, unit.listItem?.title, unit.listItem?.body);
          roles.set(
            unit.id,
            g !== undefined ? { ...base, sectionKind: 'guideline', role: 'guideline', guideline: g } : { ...base, role: 'context' },
          );
          continue;
        }
        roles.set(unit.id, { ...base, role: 'acceptance_criterion' });
        continue;
      }
      if (best.kind === 'form' && unit.formFields !== undefined) roles.set(unit.id, { ...base, role: 'form_field' });
    }
  }

  // UW-3c: a list item that is only a question is never a rule or an action, in any section, routed or not.
  for (const unit of doc.units) {
    if (!roles.has(unit.id) && unit.listKind !== undefined && isQuestion(unit.content))
      roles.set(unit.id, { sectionKind: 'reference', role: 'context' });
  }

  // An acceptance criterion applies to the document's procedure when there is exactly one.
  const procedures = new Map<string, string>();
  for (const r of roles.values()) if (r.step !== undefined) procedures.set(r.step.procedureKey, r.step.procedureTitle);
  const sole = procedures.size === 1 ? [...procedures.entries()][0]! : undefined;
  if (sole !== undefined) {
    for (const [id, r] of roles) {
      if (r.role === 'acceptance_criterion') roles.set(id, { ...r, appliesTo: { procedureKey: sole[0], procedureTitle: sole[1] } });
    }
  }

  // The fields of a fill-in form that comes before the document's only procedure are what the procedure starts from:
  // they become its first step's inputs.
  if (sole !== undefined) {
    const stepUnits = doc.units.filter((u) => roles.get(u.id)?.step?.procedureKey === sole[0]);
    const first = [...stepUnits].sort((a, b) => roles.get(a.id)!.step!.ordinal - roles.get(b.id)!.step!.ordinal)[0];
    const firstIndex = first === undefined ? -1 : doc.units.indexOf(first);
    const formUnits = doc.units.filter((u) => roles.get(u.id)?.role === 'form_field' && u.formFields !== undefined);
    if (first !== undefined && formUnits.length > 0 && formUnits.every((f) => doc.units.indexOf(f) < firstIndex)) {
      const r = roles.get(first.id)!;
      roles.set(first.id, { ...r, step: { ...r.step!, entryInputs: formUnits.flatMap((f) => f.formFields!) } });
    }
  }

  const units = doc.units.map((u) => (roles.has(u.id) ? { ...u, structure: roles.get(u.id)! } : u));
  return { ...doc, units, structure: documentStructure(sections) };
}

function documentStructure(sections: readonly SectionStructure[]): DocumentStructure {
  const weight = new Map<SectionKind, number>();
  for (const s of sections) weight.set(s.kind, (weight.get(s.kind) ?? 0) + s.confidence);
  const ranked = [...weight.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = ranked.reduce((s, [, w]) => s + w, 0);
  const top = ranked[0];
  const routedKinds = new Set(sections.filter((s) => s.routed).map((s) => s.kind));
  const share = top !== undefined && total > 0 ? top[1] / total : 0;
  const kind: DocumentStructure['kind'] = top === undefined ? 'reference' : routedKinds.size > 1 || share < 0.5 ? 'mixed' : top[0];
  return {
    kind,
    confidence: round2(share),
    sections,
    evidence: ranked.map(([k, w]) => ({
      signal: `sections:${k}`,
      detail: `${sections.filter((s) => s.kind === k).length} section(s), weight ${round2(w)}`,
    })),
    status: 'proposed',
  };
}
