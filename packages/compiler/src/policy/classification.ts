import type { ClassificationEntry, ClassificationSpec, DecisionTree } from '@xo/capability-layer';
import type { PolicyEntry } from './segment.js';

/**
 * Closed-set classification glossary for a compiled tree input (typically commodity_class).
 *
 * Two sources, never mixed up:
 *   - `manual`   : terms the DOCUMENT itself assigns to a class ("Hazmat includes aerosols and lithium batteries."),
 *                  each carrying the sentence it came from;
 *   - `operator` : a glossary the customer supplies (a TMS class table, say) for what the document does not define.
 * The report says, per class, which source covers it and which classes have no coverage at all (the model alone decides those).
 */
export interface ClassificationGlossaryInput {
  readonly entries: readonly { readonly term: string; readonly value: string; readonly note?: string }[];
  /** classes where a miss is costly (default: every class a gate in the document escalates on) */
  readonly highRisk?: readonly string[];
  readonly onConflict?: { readonly target: string; readonly reason_code?: string };
}

export interface ClassificationReport {
  readonly field: string;
  readonly classesInTree: readonly string[];
  /** terms the document itself defines, per class */
  readonly definedByManual: Readonly<Record<string, readonly string[]>>;
  /** classes for which the document defines no member goods */
  readonly notDefinedByManual: readonly string[];
  readonly operatorSupplied: number;
  /** classes with neither source: the model alone classifies these, so they stay model-assisted */
  readonly uncovered: readonly string[];
  readonly highRisk: readonly string[];
  readonly onConflict: { readonly target: string; readonly reason_code: string };
}

const cleanTerm = (t: string): string =>
  t
    .replace(/^(?:and|or|such as|like|e\.g\.,?|for example|the|a|an|any|all)\s+/i, '')
    .replace(/[.;:()"“”]+/g, '')
    .trim();

function splitList(list: string): string[] {
  return list
    .split(/,|;|\band\b|\bor\b/i)
    .map(cleanTerm)
    .filter((t) => t.length >= 3 && t.split(/\s+/).length <= 4);
}

const surface = (cls: string): string => cls.replace(/_/g, '[ _]');

/** Definitional sentences only: "<Class> freight includes a, b and c." / "a, b and c are <class> freight." */
export function extractClassificationDefinitions(entries: readonly PolicyEntry[], classes: readonly string[]): ClassificationEntry[] {
  const out: ClassificationEntry[] = [];
  for (const e of entries)
    for (const sentence of e.sentences) {
      for (const cls of classes) {
        const s = surface(cls);
        const forward = new RegExp(
          `\\b${s}\\b[^.]{0,30}?\\b(?:includes?|comprises?|covers?|consists? of|such as|e\\.g\\.,?|for example)\\s+([^.]+)`,
          'i',
        ).exec(sentence);
        const backward = new RegExp(
          `^([^.]+?)\\s+(?:are|is|count(?:s)? as|(?:are|is) (?:treated|classed|classified|considered|handled) as)\\s+(?:the\\s+)?(?:commodity\\s+)?(?:class\\s+)?${s}\\b`,
          'i',
        ).exec(sentence);
        const list = forward?.[1] ?? backward?.[1];
        if (list === undefined) continue;
        for (const term of splitList(list)) out.push({ term, value: cls, origin: 'manual', evidence: sentence });
      }
    }
  return out;
}

export function buildClassificationSpec(
  field: string,
  tree: DecisionTree,
  entries: readonly PolicyEntry[],
  classes: readonly string[],
  gateClasses: readonly string[],
  glossary: ClassificationGlossaryInput | undefined,
): { spec?: ClassificationSpec; report: ClassificationReport } {
  void tree;
  const manual = classes.length > 0 ? extractClassificationDefinitions(entries, classes) : [];
  const operator: ClassificationEntry[] = (glossary?.entries ?? [])
    .filter((g) => classes.includes(g.value))
    .map((g) => ({ term: g.term, value: g.value, origin: 'operator' as const, ...(g.note !== undefined ? { evidence: g.note } : {}) }));
  const highRisk = [...(glossary?.highRisk ?? gateClasses)].filter((c) => classes.includes(c));
  const onConflict = {
    target: glossary?.onConflict?.target ?? 'Manual review',
    reason_code: glossary?.onConflict?.reason_code ?? 'CLASSIFICATION_CONFLICT',
  };
  const definedByManual: Record<string, string[]> = {};
  for (const m of manual) (definedByManual[m.value] ??= []).push(m.term);
  const covered = new Set([...manual, ...operator].map((e) => e.value));
  const report: ClassificationReport = {
    field,
    classesInTree: classes,
    definedByManual,
    notDefinedByManual: classes.filter((c) => definedByManual[c] === undefined),
    operatorSupplied: operator.length,
    uncovered: classes.filter((c) => !covered.has(c)),
    highRisk,
    onConflict,
  };
  const all = [...manual, ...operator];
  return all.length === 0 ? { report } : { spec: { entries: all, highRisk, onConflict }, report };
}
