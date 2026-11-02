import { compileSources, type Extraction, type PolicyArtifacts } from '@xo/compiler';
import { evaluateTree } from '@xo/capability-layer';
import { bindFacts, type Binding } from './bind-facts.js';
import {
  INSURANCE_INPUTS,
  INSURANCE_MANUAL,
  INSURANCE_TITLE,
  generateInsuranceTasks,
  type InsuranceTask,
} from '../scenario/insurance/index.js';

export interface SecondDomainScore {
  readonly tasks: number;
  readonly treeEmitted: boolean;
  readonly decisionRecognized: number;
  readonly decisionSentences: number;
  readonly unrecognized: readonly string[];
  readonly treeProblems: readonly string[];
  /** share of tasks where decision AND payout match the independent oracle */
  readonly agreement: number | null;
  /** share where the decision alone matches */
  readonly decisionAgreement: number | null;
  /** of the tasks that disagree, how many the tree answered with an escalation (fail closed) rather than a wrong approve/deny */
  readonly failedClosed: number;
  readonly wrongConfident: number;
  readonly byStratum: Readonly<Record<string, { readonly n: number; readonly ok: number }>>;
  readonly binding: readonly Binding[];
  readonly disagreements: readonly { readonly id: string; readonly expected: string; readonly got: string }[];
}

/** Compiles the held-out insurance manual with the production policy path (nothing tuned to it) and scores the tree against the oracle. */
export async function compileInsurance(policy: { readonly extraction?: Extraction } = {}): Promise<PolicyArtifacts> {
  const r = await compileSources(
    [{ kind: 'document', text: INSURANCE_MANUAL, title: INSURANCE_TITLE, sourcePath: 'meridian-claims-manual.md' }],
    { policy },
  );
  if (!r.ok) throw new Error(`compile failed: ${r.error.message}`);
  if (r.value.policy === undefined) throw new Error('no policy artifacts');
  return r.value.policy;
}

/** Operator field mapping: an explicit way to read one tree input from a case when the proxy binder cannot (e.g. a yes/no derived from a count). */
export type FieldMapping = Readonly<Record<string, (facts: Record<string, unknown>) => unknown>>;

export async function scoreSecondDomain(
  tasks: readonly InsuranceTask[] = generateInsuranceTasks(),
  art?: PolicyArtifacts,
  mapping: FieldMapping = {},
): Promise<SecondDomainScore> {
  art ??= await compileInsurance();
  const tree = art.trees?.[0];
  const base = {
    tasks: tasks.length,
    decisionRecognized: art.review.recognizedSentences,
    decisionSentences: art.review.decisionSentences,
    unrecognized: art.review.unrecognized.map((u) => u.sentence),
    treeProblems: art.review.treeProblems,
  };
  if (tree === undefined)
    return {
      ...base,
      treeEmitted: false,
      agreement: null,
      decisionAgreement: null,
      failedClosed: 0,
      wrongConfident: 0,
      byStratum: {},
      binding: [],
      disagreements: [],
    };
  const amount = art.program.amountField ?? 'payout_usd';
  let ok = 0;
  let decOk = 0;
  let closed = 0;
  let wrong = 0;
  let binding: Binding[] = [];
  const byStratum: Record<string, { n: number; ok: number }> = {};
  const disagreements: { id: string; expected: string; got: string }[] = [];
  for (const t of tasks) {
    const b = bindFacts(tree.inputs, INSURANCE_INPUTS, t.facts as unknown as Record<string, unknown>);
    binding = b.binding;
    const facts = { ...b.facts };
    for (const [k, f] of Object.entries(mapping)) facts[k] = f(t.facts as unknown as Record<string, unknown>) as never;
    const r = evaluateTree(tree, facts);
    const dec = r.ok ? String(r.output['decision']) : 'error';
    const pay = r.ok ? Number(r.output[amount] ?? 0) : NaN;
    const match = dec === t.expected.decision && Math.abs(pay - t.expected.payout_usd) <= 0.5;
    if (dec === t.expected.decision) decOk++;
    const s = (byStratum[t.stratum] ??= { n: 0, ok: 0 });
    s.n++;
    if (match) {
      ok++;
      s.ok++;
    } else {
      if (dec === 'escalate' || dec === 'error') closed++;
      else wrong++;
      disagreements.push({
        id: t.id,
        expected: `${t.expected.decision} ${t.expected.payout_usd}`,
        got: `${dec} ${Number.isNaN(pay) ? '' : pay}`,
      });
    }
  }
  return {
    ...base,
    treeEmitted: true,
    agreement: ok / tasks.length,
    decisionAgreement: decOk / tasks.length,
    failedClosed: closed,
    wrongConfident: wrong,
    byStratum,
    binding,
    disagreements,
  };
}

/** Share of the gold facts that appear together in one compiled knowledge node (the same test freight uses). */
export async function insuranceKnowledgeCoverage(
  art?: PolicyArtifacts,
): Promise<{ readonly present: number; readonly total: number; readonly missing: readonly string[] }> {
  const { INSURANCE_GOLD_FACTS } = await import('../scenario/insurance/gold-xo.js');
  const a = art ?? (await compileInsurance());
  const texts = a.knowledge.nodes.map((n) => `${n.properties.title} ${n.properties.text}`);
  const have = INSURANCE_GOLD_FACTS.filter((f) => texts.some((t) => f.patterns.every((p) => p.test(t))));
  return {
    present: have.length,
    total: INSURANCE_GOLD_FACTS.length,
    missing: INSURANCE_GOLD_FACTS.filter((f) => !have.includes(f)).map((f) => f.id),
  };
}
