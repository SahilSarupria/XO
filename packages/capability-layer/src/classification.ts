import type { DecisionTree, TreeInput } from './decision-tree.js';

/**
 * Deterministic classification of free text into a closed set of labels (e.g. goods → commodity class).
 *
 * Why: when a model both reads the case text AND picks the class, every later step (a deterministic tree) inherits its mistake.
 * A glossary lookup runs first; the model's value is then reconciled against it:
 *   agree            → proceed
 *   filled           → the model gave nothing, the glossary matched one class → use it
 *   high_risk        → the glossary matched a high-risk class (e.g. hazmat) and the model said otherwise → the high-risk class wins,
 *                      so the tree's own escalation rule fires; both values are written to the trace
 *   conflict         → the glossary disagrees with the model on a normal class, or matches several classes → escalate, both values in the trace
 *   unknown          → no glossary match → the model's value is used and flagged `model_assisted`
 */
export interface ClassificationEntry {
  /** word or phrase to find in the case text (case-insensitive, whole words, simple plural tolerated) */
  readonly term: string;
  /** the label it indicates; must be one of the input's enum values */
  readonly value: string;
  /** where the entry came from: a sentence of the compiled document, or the operator's own glossary */
  readonly origin: 'manual' | 'operator';
  /** for `manual`: the source sentence; for `operator`: a note or a glossary reference */
  readonly evidence?: string;
}

export interface ClassificationSpec {
  readonly entries: readonly ClassificationEntry[];
  /** labels where a miss is costly; a glossary match on one of these overrides a model that says anything else */
  readonly highRisk: readonly string[];
  /** where a conflict is escalated to */
  readonly onConflict: { readonly target: string; readonly reason_code: string };
}

export type ClassificationStatus = 'agree' | 'filled' | 'high_risk' | 'conflict' | 'unknown' | 'missing';

export interface ClassificationFinding {
  readonly field: string;
  readonly status: ClassificationStatus;
  readonly modelValue: unknown;
  readonly lookupValues: readonly string[];
  readonly matchedTerms: readonly { readonly term: string; readonly value: string; readonly origin: string }[];
  readonly finalValue?: string;
  /** true when the value rests on the model alone */
  readonly modelAssisted: boolean;
  readonly note: string;
}

export interface ClassificationResult {
  readonly facts: Record<string, unknown>;
  readonly findings: readonly ClassificationFinding[];
  readonly escalation?: { readonly target: string; readonly reason_code: string; readonly field: string };
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function compileMatchers(spec: ClassificationSpec): { re: RegExp; entry: ClassificationEntry }[] {
  return spec.entries
    .filter((e) => e.term.trim().length >= 3)
    .map((entry) => ({
      entry,
      re: new RegExp(`(?<![A-Za-z0-9])${esc(entry.term.trim()).replace(/\s+/g, '[\\s-]+')}(?:s|es)?(?![A-Za-z0-9])`, 'i'),
    }));
}

export function lookupClassification(
  spec: ClassificationSpec,
  text: string,
): { values: string[]; matches: { term: string; value: string; origin: string }[] } {
  const matches = compileMatchers(spec)
    .filter((m) => m.re.test(text))
    .map((m) => ({ term: m.entry.term, value: m.entry.value, origin: m.entry.origin }));
  return { values: [...new Set(matches.map((m) => m.value))], matches };
}

/** Applies every classification-bearing input of the tree to the model-supplied facts. Pure and deterministic. */
export function applyClassifications(tree: DecisionTree, facts: Readonly<Record<string, unknown>>, caseText: string): ClassificationResult {
  const out: Record<string, unknown> = { ...facts };
  const findings: ClassificationFinding[] = [];
  let escalation: ClassificationResult['escalation'];
  for (const input of tree.inputs as readonly TreeInput[]) {
    const spec = input.classification;
    if (spec === undefined) continue;
    const field = input.name;
    const raw = facts[field];
    const model = typeof raw === 'string' && raw.trim() !== '' ? raw.trim().toLowerCase() : undefined;
    const { values, matches } = lookupClassification(spec, caseText);
    const base = { field, modelValue: raw ?? null, lookupValues: values, matchedTerms: matches };
    const allowed = input.enum === undefined ? undefined : new Set(input.enum);

    if (values.length === 0) {
      findings.push({
        ...base,
        status: model === undefined ? 'missing' : 'unknown',
        ...(model !== undefined ? { finalValue: model } : {}),
        modelAssisted: model !== undefined,
        note:
          model === undefined
            ? `${field}: no glossary match and the model gave no value`
            : `${field}: no glossary match; using the model's value "${model}" (model-assisted)`,
      });
      continue;
    }
    const highRisk = values.filter((v) => spec.highRisk.includes(v));
    if (highRisk.length > 0) {
      const final = highRisk[0] as string;
      const differs = model !== final;
      if (differs) out[field] = final;
      findings.push({
        ...base,
        status: differs ? 'high_risk' : 'agree',
        finalValue: final,
        modelAssisted: false,
        note: differs
          ? `${field}: glossary matched high-risk "${final}" (${matches.map((m) => m.term).join(', ')}) but the model said ${model === undefined ? 'nothing' : `"${model}"`}; high-risk class applied`
          : `${field}: glossary and model agree on high-risk "${final}"`,
      });
      continue;
    }
    if (values.length > 1) {
      escalation = { ...spec.onConflict, field };
      findings.push({
        ...base,
        status: 'conflict',
        modelAssisted: false,
        note: `${field}: the case text matches several classes (${values.join(', ')}; terms: ${matches.map((m) => m.term).join(', ')}); model said ${model === undefined ? 'nothing' : `"${model}"`}; escalated`,
      });
      continue;
    }
    const only = values[0] as string;
    if (allowed !== undefined && !allowed.has(only)) {
      escalation = { ...spec.onConflict, field };
      findings.push({
        ...base,
        status: 'conflict',
        modelAssisted: false,
        note: `${field}: glossary value "${only}" is not a declared label; escalated`,
      });
      continue;
    }
    if (model === undefined) {
      out[field] = only;
      findings.push({
        ...base,
        status: 'filled',
        finalValue: only,
        modelAssisted: false,
        note: `${field}: model gave nothing; glossary supplied "${only}"`,
      });
    } else if (model === only) {
      findings.push({
        ...base,
        status: 'agree',
        finalValue: only,
        modelAssisted: false,
        note: `${field}: glossary and model agree on "${only}"`,
      });
    } else if (spec.highRisk.includes(model)) {
      // the model is MORE cautious than the glossary: keep its (high-risk) value, record the disagreement
      findings.push({
        ...base,
        status: 'agree',
        finalValue: model,
        modelAssisted: true,
        note: `${field}: model said high-risk "${model}", glossary said "${only}"; the cautious value was kept`,
      });
    } else {
      escalation = { ...spec.onConflict, field };
      findings.push({
        ...base,
        status: 'conflict',
        modelAssisted: false,
        note: `${field}: model said "${model}" but the glossary says "${only}" (${matches.map((m) => m.term).join(', ')}); escalated`,
      });
    }
  }
  return { facts: out, findings, ...(escalation !== undefined ? { escalation } : {}) };
}

export const treeHasClassification = (tree: DecisionTree): boolean => tree.inputs.some((i) => i.classification !== undefined);
