import { assertExpressionParses } from '@xo/capability-layer';
import type { Extraction, UnrecognizedClause } from './extract.js';
import { synthesizeTree } from './synthesize.js';
import { identifiersIn, type FactType, type PolicyFact, type PolicyProgram, type Step } from './program.js';

/**
 * Model-assisted clause extraction with strict deterministic checks.
 *
 * A model is asked, for ONE sentence the pattern extractor did not recognise, to propose a fact/step. The proposal is
 * never trusted: `checkProposal` accepts it only if
 *   - its quote is verbatim in the sentence,
 *   - every number in its expressions appears in the quote (as a digit or a number word),
 *   - every expression parses and reads only declared facts or earlier-defined quantities,
 *   - its outcome uses a permitted decision, and an escalation names a target found in the quote,
 *   - adding it does not introduce a new problem into the synthesized tree.
 * Anything else goes to a review list with the reasons. Nothing here knows any industry; the model supplies names.
 */

/** Provider-neutral port: prompt in, text out. Adapt an `@xo/ai-core` ModelProvider with `providerClauseModel`. */
export type ClauseModel = (prompt: string) => Promise<string>;

export interface ProposedFact {
  readonly name: string;
  readonly type: FactType;
  readonly description: string;
  readonly enum?: readonly string[];
}
export type ProposedStep =
  | { readonly kind: 'gate'; readonly when: string; readonly decision: string; readonly target?: string; readonly reason: string }
  | { readonly kind: 'assign'; readonly set: Readonly<Record<string, string>> }
  | { readonly kind: 'finish'; readonly when?: string; readonly decision: string; readonly amount?: string; readonly reason: string };
export interface ClauseProposal {
  readonly quote: string;
  readonly facts: readonly ProposedFact[];
  readonly step: ProposedStep;
}

export interface ReviewItem {
  readonly sentence: string;
  readonly rule: string;
  readonly section: string;
  readonly reasons: readonly string[];
  /** the rejected proposal, when the model produced a parseable one — a reviewer can edit and accept it */
  readonly proposal?: ClauseProposal;
}

export interface ModelExtractionResult {
  readonly extraction: Extraction;
  readonly accepted: number;
  readonly review: readonly ReviewItem[];
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  ninety: 90,
  hundred: 100,
};
const BASE_DECISIONS = ['approve', 'deny', 'escalate', 'pay', 'partial'];
const IDENT = /^[a-z][a-z0-9_]*$/;
const OPERATORS = new Set(['and', 'or', 'not']);

function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.add(Number(m[0].replace(/,/g, '')));
  for (const w of norm(text).split(' ')) if (w in NUMBER_WORDS) out.add(NUMBER_WORDS[w] as number);
  // "15%" is written 0.15 in expressions
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(?:%|percent)/gi)) out.add(Number(m[1]) / 100);
  return out;
}
function numberLiterals(expr: string): number[] {
  const stripped = expr.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, ' ').replace(/[A-Za-z_][A-Za-z0-9_]*/g, ' ');
  return [...stripped.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
}
const stringLiterals = (expr: string): string[] =>
  [...expr.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] ?? m[2]) as string);

export function stepExpressions(step: ProposedStep): string[] {
  if (step.kind === 'assign') return Object.values(step.set);
  if (step.kind === 'gate') return [step.when];
  return [step.when, step.amount].filter((x): x is string => x !== undefined);
}

function definedNames(steps: readonly Step[]): Set<string> {
  const out = new Set<string>();
  for (const s of steps) if (s.kind === 'assign') for (const k of Object.keys(s.set)) out.add(k);
  return out;
}

/** Returns the list of reasons the proposal is not acceptable; empty means it passed every deterministic check. */
export function checkProposal(p: ClauseProposal, sentence: string, program: PolicyProgram): string[] {
  const reasons: string[] = [];
  if (typeof p.quote !== 'string' || norm(p.quote).length < 8) reasons.push('quote missing or too short');
  else if (!norm(sentence).includes(norm(p.quote))) reasons.push('quote is not verbatim in the source sentence');
  const quoteNorm = norm(typeof p.quote === 'string' ? p.quote : '');
  const evidence = numbersIn(typeof p.quote === 'string' ? p.quote : '');

  const declared = new Map(program.facts.map((f) => [f.name, f] as const));
  for (const f of p.facts ?? []) {
    if (!IDENT.test(f.name)) reasons.push(`fact name "${f.name}" is not a lower_snake identifier`);
    if (!['number', 'boolean', 'string'].includes(f.type)) reasons.push(`fact "${f.name}" has invalid type`);
    const prior = declared.get(f.name);
    if (prior !== undefined && prior.type !== f.type) reasons.push(`fact "${f.name}" conflicts with existing type ${prior.type}`);
    if (f.enum !== undefined && f.type !== 'string') reasons.push(`fact "${f.name}": enum only applies to strings`);
    if (prior === undefined) declared.set(f.name, { name: f.name, type: f.type, description: f.description ?? '' });
  }
  const defined = definedNames(program.steps);
  if (p.step?.kind === 'assign') for (const k of Object.keys(p.step.set)) defined.add(k);

  if (p.step === undefined) return [...reasons, 'no step proposed'];
  for (const expr of stepExpressions(p.step)) {
    try {
      assertExpressionParses(expr);
    } catch {
      reasons.push(`expression does not parse: ${expr}`);
      continue;
    }
    for (const id of identifiersIn(expr)) {
      if (OPERATORS.has(id)) continue;
      if (!declared.has(id) && !defined.has(id)) reasons.push(`expression reads undeclared name "${id}"`);
    }
    // 0 and 1 are structural ("otherwise nothing", unit factors), not figures the document states
    for (const n of numberLiterals(expr))
      if (n !== 0 && n !== 1 && !evidence.has(n)) reasons.push(`number ${n} in "${expr}" does not appear in the quoted text`);
    for (const lit of stringLiterals(expr))
      if (quoteNorm !== '' && !quoteNorm.includes(norm(lit))) {
        // a label value may be a snake_case rendering of words in the quote
        if (!quoteNorm.includes(norm(lit.replace(/_/g, ' '))))
          reasons.push(`string "${lit}" in "${expr}" does not appear in the quoted text`);
      }
  }
  if (p.step.kind === 'assign')
    for (const k of Object.keys(p.step.set)) if (!IDENT.test(k)) reasons.push(`assigned name "${k}" is not a lower_snake identifier`);
  if (p.step.kind !== 'assign') {
    const allowed = new Set([...BASE_DECISIONS, ...program.steps.flatMap((s) => (s.kind === 'assign' ? [] : [s.outcome.decision]))]);
    if (!allowed.has(p.step.decision)) reasons.push(`decision "${p.step.decision}" is not one of: ${[...allowed].join(', ')}`);
    if (typeof p.step.reason !== 'string' || p.step.reason.trim() === '') reasons.push('reason missing');
    if (p.step.kind === 'gate' && p.step.decision === 'escalate') {
      if (p.step.target === undefined || p.step.target.trim() === '') reasons.push('escalation has no target');
      else if (!quoteNorm.includes(norm(p.step.target)))
        reasons.push(`escalation target "${p.step.target}" does not appear in the quoted text`);
    }
  }
  return reasons;
}

const stepFromProposal = (p: ClauseProposal, c: UnrecognizedClause, id: string, order: number, origin: 'model' | 'operator'): Step => {
  const source = { rule: c.rule, section: c.section, sentence: c.sentence };
  const base = { id, order, note: p.quote, source, origin } as const;
  const s = p.step;
  if (s.kind === 'assign') return { ...base, kind: 'assign', set: s.set };
  if (s.kind === 'gate')
    return {
      ...base,
      kind: 'gate',
      when: s.when,
      outcome: { decision: s.decision, ...(s.target ? { target: s.target } : {}), reason: s.reason },
    };
  return {
    ...base,
    kind: 'finish',
    ...(s.when ? { when: s.when } : {}),
    ...(s.amount ? { amount: s.amount.startsWith('=') ? s.amount : `=round(${s.amount}, 2)` } : {}),
    outcome: { decision: s.decision, reason: s.reason },
  };
};

/** Adds a checked proposal to the program; returns the new program or the reasons it could not be added. */
export function addProposal(
  program: PolicyProgram,
  p: ClauseProposal,
  c: UnrecognizedClause,
  origin: 'model' | 'operator',
  index: number,
): { readonly program: PolicyProgram } | { readonly reasons: string[] } {
  const reasons = checkProposal(p, c.sentence, program);
  if (reasons.length > 0) return { reasons };
  const known = new Set(program.facts.map((f) => f.name));
  const newFacts: PolicyFact[] = p.facts
    .filter((f) => !known.has(f.name))
    .map((f) => ({ name: f.name, type: f.type, description: f.description, ...(f.enum ? { enum: f.enum } : {}) }));
  const step = stepFromProposal(p, c, `${origin}${index}`, (c.order ?? 1000) + index / 10000, origin);
  // a finish step that pays an amount needs an output field to put it in, when the document gave none
  const needsAmountField = p.step.kind === 'finish' && p.step.amount !== undefined && program.amountField === undefined;
  const candidate: PolicyProgram = {
    ...program,
    facts: [...program.facts, ...newFacts],
    steps: [...program.steps, step],
    ...(needsAmountField ? { amountField: 'amount_usd' } : {}),
  };
  // the synthesized tree must not get worse: every problem it has now, it had before
  const before = new Set(synthesizeTree(program).treeProblems);
  const fresh = synthesizeTree(candidate).treeProblems.filter((x) => !before.has(x));
  if (fresh.length > 0) return { reasons: fresh.map((x) => `would break the tree: ${x}`) };
  return { program: candidate };
}

export function clausePrompt(c: UnrecognizedClause, program: PolicyProgram): string {
  const facts = program.facts.map((f) => `${f.name}:${f.type}${f.enum ? `(${f.enum.join('|')})` : ''}`).join(', ');
  return [
    'You turn ONE policy sentence into a machine-checkable rule. Reply with JSON only.',
    'Shape: {"skip":true} if the sentence states no decision rule, else',
    '{"quote":"<exact words copied from the sentence>","facts":[{"name":"lower_snake","type":"number|boolean|string","description":"..."}],',
    ' "step":{"kind":"gate","when":"<expr>","decision":"deny|escalate|approve","target":"<who, if escalate>","reason":"..."}',
    '   | {"kind":"assign","set":{"name":"<expr>"}} | {"kind":"finish","when":"<expr>","decision":"approve|pay|partial","amount":"<expr>","reason":"..."}}',
    'Rules: copy the quote verbatim; every number in an expression must appear in the quote; use only the facts listed or ones you declare in "facts".',
    `Facts already declared: ${facts || '(none)'}`,
    `Section: ${c.section}`,
    `Sentence: ${c.sentence}`,
  ].join('\n');
}

export function parseProposal(text: string): ClauseProposal | 'skip' | undefined {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return undefined;
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    if (j['skip'] === true) return 'skip';
    if (typeof j['quote'] !== 'string' || typeof j['step'] !== 'object' || j['step'] === null) return undefined;
    return { quote: j['quote'], facts: Array.isArray(j['facts']) ? (j['facts'] as ProposedFact[]) : [], step: j['step'] as ProposedStep };
  } catch {
    return undefined;
  }
}

/** Runs the model over every unrecognised clause; accepted proposals extend the program, the rest become review items. */
export async function extendWithModel(extraction: Extraction, model: ClauseModel): Promise<ModelExtractionResult> {
  let program = extraction.program;
  const review: ReviewItem[] = [];
  const stillUnrecognized: UnrecognizedClause[] = [];
  let accepted = 0;
  let i = 0;
  for (const c of extraction.unrecognized) {
    i += 1;
    let reply: string;
    try {
      reply = await model(clausePrompt(c, program));
    } catch (e) {
      review.push({ ...c, reasons: [`model call failed: ${(e as Error).message}`] });
      stillUnrecognized.push(c);
      continue;
    }
    const proposal = parseProposal(reply);
    if (proposal === 'skip') {
      // the model says no rule here; that is a claim, so it stays visible to a reviewer
      review.push({ ...c, reasons: ['model judged the sentence not to state a decision rule'] });
      stillUnrecognized.push(c);
      continue;
    }
    if (proposal === undefined) {
      review.push({ ...c, reasons: ['model reply was not a valid proposal'] });
      stillUnrecognized.push(c);
      continue;
    }
    const res = addProposal(program, proposal, c, 'model', i);
    if ('reasons' in res) {
      review.push({ ...c, reasons: res.reasons, proposal });
      stillUnrecognized.push(c);
    } else {
      program = res.program;
      accepted += 1;
    }
  }
  return { extraction: { ...extraction, program, unrecognized: stillUnrecognized }, accepted, review };
}
