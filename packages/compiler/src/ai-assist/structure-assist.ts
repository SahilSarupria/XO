/**
 * UW-3b (H) — optional model assistance for sections the deterministic structure reader could not route.
 *
 * OFF BY DEFAULT. Nothing here runs unless a caller passes a provider. When it does, a model may PROPOSE what kind of
 * content an unrouted section carries (procedure, guideline, checklist, form). The proposal is a candidate, never an
 * authority, exactly like `candidates.ts`:
 *
 *   - What is sent is a SHAPE DESCRIPTOR of the section — counts of numbered, bulleted and ticked items, table rows and
 *     form fields, and the shares of items that read as instructions, prohibitions or modal statements. No document text
 *     is sent unless the residency policy is `open` (or the provider is local) AND the caller asks for text. Under
 *     `strict_local` a hosted provider is never called; under `masked_hosted` only a contracted provider, and only shape.
 *     The residency rule is UW-14's `checkResidency`, applied before any call.
 *   - A proposal survives only if the deterministic evidence can carry it: a procedure needs at least two numbered or
 *     step-table units, a checklist at least two list items, a guideline at least two list items of which half read as
 *     instructions, a form at least three fields. Anything else is rejected with the reason.
 *   - A validated proposal is reported (`status: 'proposed'`); it is never applied to the graph. Routing stays
 *     deterministic; a person who agrees can restructure the source or confirm it through the review flow.
 */
import { checkResidency, type ProviderId, type ProviderLocality, type ResidencyPolicy } from '@xo/ai-core';
import type { ExperienceDocument, SectionKind } from '../semantic/types.js';
import { directiveOf, isImperative } from '../semantic/directive.js';

export type AssistableKind = Extract<SectionKind, 'procedure' | 'guideline' | 'checklist' | 'form'>;
const ASSISTABLE: ReadonlySet<string> = new Set<AssistableKind>(['procedure', 'guideline', 'checklist', 'form']);

/** What a provider is told about one section. Text fields are present only when text egress is allowed and requested. */
export interface SectionShape {
  readonly sectionId: string;
  readonly units: number;
  readonly orderedItems: number;
  readonly unorderedItems: number;
  readonly checkboxItems: number;
  readonly titledItems: number;
  readonly tableRows: number;
  readonly formFields: number;
  readonly proseUnits: number;
  /** Shares (0..1) of list items that read as an instruction / a prohibition / a modal statement. */
  readonly instructionShare: number;
  readonly prohibitionShare: number;
  readonly deterministicKind: SectionKind;
  readonly deterministicConfidence: number;
  readonly heading?: string;
  readonly sampleItems?: readonly string[];
}

export interface StructureProposal {
  readonly sectionId: string;
  readonly kind: string;
  readonly rationale?: string;
}

export interface StructureAssistProvider {
  readonly providerId: ProviderId;
  readonly locality: ProviderLocality;
  proposeSectionKinds(sections: readonly SectionShape[]): Promise<readonly StructureProposal[]>;
}

export interface StructureAssistOptions {
  readonly residency: ResidencyPolicy;
  /** Send each section's heading and first items. Honoured only under `open` residency or for a local provider. */
  readonly includeText?: boolean;
  readonly maxSampleItems?: number;
}

export interface StructureAssistResult {
  readonly status: 'not_called' | 'denied' | 'completed' | 'failed';
  /** Why the provider was not called, or failed (never contains request content). */
  readonly message?: string;
  readonly textSent: boolean;
  readonly proposals: readonly (StructureProposal & {
    readonly validation: 'validated' | 'rejected';
    readonly reasons: readonly string[];
  })[];
}

function share(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 100) / 100;
}

/** The shape of every section the deterministic reader did NOT route (the only sections assistance is asked about). */
export function unroutedSectionShapes(doc: ExperienceDocument, withText: boolean, maxSampleItems = 3): readonly SectionShape[] {
  const out: SectionShape[] = [];
  for (const section of doc.structure?.sections ?? []) {
    if (section.routed) continue;
    const key = section.sectionPath.join('\u0000');
    const units = doc.units.filter((u) => u.provenance.sectionPath.join('\u0000') === key);
    const items = units.filter((u) => u.listKind !== undefined);
    if (items.length === 0 && units.every((u) => u.tableRow === undefined && u.formFields === undefined)) continue;
    const instructions = items.filter((u) => isImperative(u.content)).length;
    const prohibitions = items.filter((u) => directiveOf(u.content)?.modality === 'prohibition').length;
    out.push({
      sectionId: `s${out.length + 1}`,
      units: units.length,
      orderedItems: items.filter((u) => u.listKind === 'ordered').length,
      unorderedItems: items.filter((u) => u.listKind === 'unordered').length,
      checkboxItems: items.filter((u) => u.listItem?.checkbox !== undefined).length,
      titledItems: items.filter((u) => u.listItem?.title !== undefined).length,
      tableRows: units.filter((u) => u.tableRow !== undefined).length,
      formFields: units.reduce((n, u) => n + (u.formFields?.length ?? 0), 0),
      proseUnits: units.filter((u) => u.listKind === undefined && u.tableRow === undefined && u.formFields === undefined).length,
      instructionShare: share(instructions, items.length),
      prohibitionShare: share(prohibitions, items.length),
      deterministicKind: section.kind,
      deterministicConfidence: section.confidence,
      ...(withText
        ? {
            heading: section.sectionPath[section.sectionPath.length - 1] ?? '',
            sampleItems: items.slice(0, maxSampleItems).map((u) => u.content.slice(0, 200)),
          }
        : {}),
    });
  }
  return out;
}

/** Whether the deterministic evidence of a section can carry a proposed kind. Empty = it can. */
export function proposalProblems(shape: SectionShape, kind: string): readonly string[] {
  if (!ASSISTABLE.has(kind)) return [`"${kind}" is not a kind assistance may propose (procedure, guideline, checklist, form)`];
  const listItems = shape.orderedItems + shape.unorderedItems;
  switch (kind as AssistableKind) {
    case 'procedure':
      return shape.orderedItems + shape.tableRows >= 2 ? [] : ['a procedure needs at least two numbered items or step-table rows'];
    case 'checklist':
      return listItems >= 2 ? [] : ['a checklist needs at least two list items'];
    case 'guideline':
      return listItems >= 2 && shape.instructionShare + shape.prohibitionShare >= 0.5
        ? []
        : ['a guideline needs at least two list items, half of which read as instructions or prohibitions'];
    case 'form':
      return shape.formFields >= 3 ? [] : ['a form needs at least three fields'];
  }
}

/**
 * Asks `provider` about the sections `doc` left unrouted, under `options.residency`. Never throws on the provider's
 * account; never changes `doc`.
 */
export async function assistStructure(
  doc: ExperienceDocument,
  provider: StructureAssistProvider | undefined,
  options: StructureAssistOptions,
): Promise<StructureAssistResult> {
  if (provider === undefined)
    return { status: 'not_called', message: 'no structure-assist provider configured (off by default)', textSent: false, proposals: [] };
  const textAllowed = options.includeText === true && (options.residency.mode === 'open' || provider.locality === 'local');
  const shapes = unroutedSectionShapes(doc, textAllowed, options.maxSampleItems);
  if (shapes.length === 0)
    return {
      status: 'not_called',
      message: 'every section was routed or carries no structure to ask about',
      textSent: false,
      proposals: [],
    };
  const denied = checkResidency(options.residency, { providerId: provider.providerId, locality: provider.locality, typed: !textAllowed });
  if (denied !== undefined) return { status: 'denied', message: denied.message, textSent: false, proposals: [] };
  let raw: readonly StructureProposal[];
  try {
    raw = await provider.proposeSectionKinds(shapes);
  } catch {
    return {
      status: 'failed',
      message: 'the structure-assist provider failed; nothing was proposed',
      textSent: textAllowed,
      proposals: [],
    };
  }
  const byId = new Map(shapes.map((s) => [s.sectionId, s]));
  const proposals = raw.map((p) => {
    const shape = byId.get(p.sectionId);
    const reasons = shape === undefined ? [`unknown section "${p.sectionId}"`] : proposalProblems(shape, p.kind);
    return { ...p, validation: reasons.length === 0 ? ('validated' as const) : ('rejected' as const), reasons };
  });
  return { status: 'completed', textSent: textAllowed, proposals };
}
