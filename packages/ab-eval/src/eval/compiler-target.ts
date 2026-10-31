import { compileSources, packageXoirGraph, synthesizePolicyArtifacts } from '@xo/compiler';
import { createCapabilityLayer, evaluateTree, nodeDisplayText, parseTrees } from '@xo/capability-layer';
import type { PackageBundle } from '@xo/package-sdk';
import { GOLD_FACTS, type GoldFact } from '../scenario/freight/gold-facts.js';
import type { FreightTask } from '../scenario/freight/generate.js';
import { manualMarkdown } from '../scenario/freight/rules.js';

/** Thresholds a compiler build must reach for "the compiled XO is as good as the hand-authored one" to be claimed. */
export const COMPILER_TARGETS = {
  /** compiled knowledge coverage as a fraction of the gold XO's */
  coverageVsGold: 0.9,
  /** retrieval recall@k as a fraction of the gold XO's */
  recallVsGold: 0.8,
  /** the compiler must emit at least one decision tree the runtime can execute */
  executableTree: true,
  /** …and that tree must agree with the oracle on at least this fraction of eval tasks */
  treeAgreement: 0.9,
  /** with a real model: (compiled − plain) / (gold − plain) on the same arm */
  upliftRatio: 0.8,
} as const;

export interface PackageScore {
  readonly nodes: number;
  readonly factsPresent: number;
  readonly factsTotal: number;
  readonly coverage: number;
  readonly missingFacts: readonly string[];
  readonly recallAtK: number;
  readonly k: number;
  readonly executableTrees: number;
  readonly treeAgreement: number | null;
  readonly traces: number;
  readonly hasPromptStrategies: boolean;
  readonly executableSafetyRules: number;
  readonly level: string;
  readonly manifestCapabilities: number;
}

function comp(bundle: PackageBundle, kind: string): Uint8Array | undefined {
  return bundle.components.find((c) => c.kind === kind)?.data;
}
const text = (b: Uint8Array | undefined): string => (b === undefined ? '' : new TextDecoder().decode(b));

/** Every node the capability layer can show a model (knowledge nodes + compiler constraint nodes), as display text. */
export function knowledgeTexts(bundle: PackageBundle): string[] {
  const kg = comp(bundle, 'knowledge_graph');
  const sr = comp(bundle, 'safety_rules');
  const nodes = [
    ...((kg === undefined ? {} : (JSON.parse(text(kg)) as { nodes?: unknown[] })).nodes ?? []),
    ...((sr === undefined ? {} : (JSON.parse(text(sr)) as { nodes?: unknown[] })).nodes ?? []),
  ];
  return nodes.map((n) => nodeDisplayText(n)).filter((t) => t.length > 0);
}

const present = (f: GoldFact, texts: readonly string[]): boolean => texts.some((t) => f.patterns.every((p) => p.test(t)));

/** Scores any XO against the Halvorsen gold standard with no LLM involved. */
export function scorePackage(bundle: PackageBundle, tasks: readonly FreightTask[], k = 9): PackageScore {
  const texts = knowledgeTexts(bundle);
  const have = GOLD_FACTS.filter((f) => present(f, texts));
  const layer = createCapabilityLayer(bundle, { host: { family: 'claude', capabilities: ['chat', 'tool_use'] } });
  const receipt = layer.emitLoadReceipt();

  const recalls = tasks.map((t) => {
    const retrieved = layer.retrieve(t.narrative, k).map((n) => n.text);
    const need = GOLD_FACTS.filter((f) => t.factsUsed.includes(f.id));
    return need.length === 0 ? 1 : need.filter((f) => present(f, retrieved)).length / need.length;
  });

  const trees = parseTrees(JSON.parse(text(comp(bundle, 'decision_trees')) || 'null') ?? undefined) ?? [];
  let agreement: number | null = null;
  if (trees.length > 0) {
    const tree = trees[0]!;
    let ok = 0;
    for (const t of tasks) {
      const r = evaluateTree(tree, t.statedFacts as Record<string, unknown>);
      if (
        r.ok &&
        r.output['decision'] === t.expected.decision &&
        Math.abs(Number(r.output['payout_usd'] ?? 0) - t.expected.payout_usd) <= 0.5
      )
        ok++;
    }
    agreement = ok / tasks.length;
  }
  return {
    nodes: texts.length,
    factsPresent: have.length,
    factsTotal: GOLD_FACTS.length,
    coverage: have.length / GOLD_FACTS.length,
    missingFacts: GOLD_FACTS.filter((f) => !have.includes(f)).map((f) => f.id),
    recallAtK: recalls.reduce((a, b) => a + b, 0) / (recalls.length || 1),
    k,
    executableTrees: trees.length,
    treeAgreement: agreement,
    traces: text(comp(bundle, 'reasoning_traces'))
      .split('\n')
      .filter((l) => l.trim()).length,
    hasPromptStrategies: comp(bundle, 'prompt_strategies') !== undefined,
    executableSafetyRules: receipt.executableSafetyRules,
    level: receipt.level,
    manifestCapabilities: bundle.manifest.capabilities?.length ?? 0,
  };
}

export interface CompileManualOptions {
  /** Run the policy-synthesis stage (default). `false` reproduces the pre-synthesis compiler for before/after comparison. */
  readonly policy?: boolean;
  readonly handbook?: number;
}

export async function compileManual(
  handbookOrOptions?: number | CompileManualOptions,
): Promise<{ bundle: PackageBundle; diagnostics: number; policy?: ReturnType<typeof synthesizePolicyArtifacts> }> {
  const opts: CompileManualOptions = typeof handbookOrOptions === 'number' ? { handbook: handbookOrOptions } : (handbookOrOptions ?? {});
  const text = manualMarkdown(opts.handbook);
  const compiled = await compileSources([
    {
      kind: 'document',
      text,
      sourcePath: 'halvorsen-claims-manual.md',
      title: 'Halvorsen Freight — Claims Desk Manual (Rev 7)',
    },
  ]);
  if (!compiled.ok) throw new Error(`compile failed: ${compiled.error.message}`);
  const policy =
    opts.policy === false
      ? undefined
      : synthesizePolicyArtifacts([
          { text, title: 'Halvorsen Freight — Claims Desk Manual (Rev 7)', sourcePath: 'halvorsen-claims-manual.md' },
        ]);
  const packaged = packageXoirGraph(compiled.value.graph, {
    identity: { name: 'halvorsen-freight-claims-desk-compiled', version: '0.1.0', creatorDid: 'did:xo:compiler' },
    metadata: {
      domain: 'freight claims adjudication (fictional carrier)',
      description: 'Compiled from the Halvorsen claims manual by the XO compiler.',
      scope: ['freight claims'],
      limitations: ['compiler output; unreviewed'],
    },
    ...(policy !== undefined ? { policy } : {}),
  });
  if (!packaged.ok) throw new Error(`packaging failed: ${packaged.error.message}`);
  return { bundle: packaged.value.bundle, diagnostics: packaged.value.diagnostics.length, ...(policy !== undefined ? { policy } : {}) };
}

export interface CompilerGap {
  readonly gold: PackageScore;
  readonly compiled: PackageScore;
  readonly ratios: { readonly coverage: number; readonly recall: number };
  readonly checks: readonly { readonly name: string; readonly target: string; readonly actual: string; readonly pass: boolean }[];
  readonly passed: boolean;
}

export function compilerGap(gold: PackageScore, compiled: PackageScore): CompilerGap {
  const ratio = (c: number, g: number): number => (g === 0 ? 0 : c / g);
  const coverage = ratio(compiled.coverage, gold.coverage);
  const recall = ratio(compiled.recallAtK, gold.recallAtK);
  const T = COMPILER_TARGETS;
  const checks = [
    {
      name: 'knowledge coverage vs gold',
      target: `≥ ${T.coverageVsGold * 100}%`,
      actual: `${(coverage * 100).toFixed(0)}% (${compiled.factsPresent}/${compiled.factsTotal} facts; missing ${compiled.missingFacts.join(', ') || 'none'})`,
      pass: coverage >= T.coverageVsGold,
    },
    {
      name: `retrieval recall@${compiled.k} vs gold`,
      target: `≥ ${T.recallVsGold * 100}%`,
      actual: `${(recall * 100).toFixed(0)}% (${(compiled.recallAtK * 100).toFixed(0)}% vs ${(gold.recallAtK * 100).toFixed(0)}%)`,
      pass: recall >= T.recallVsGold,
    },
    {
      name: 'executable decision tree emitted',
      target: 'yes',
      actual: compiled.executableTrees > 0 ? `${compiled.executableTrees}` : 'none',
      pass: compiled.executableTrees > 0,
    },
    {
      name: 'tree agrees with oracle',
      target: `≥ ${T.treeAgreement * 100}%`,
      actual: compiled.treeAgreement === null ? 'n/a (no tree)' : `${(compiled.treeAgreement * 100).toFixed(0)}%`,
      pass: compiled.treeAgreement !== null && compiled.treeAgreement >= T.treeAgreement,
    },
    { name: 'worked examples (reasoning traces)', target: '≥ 1', actual: String(compiled.traces), pass: compiled.traces >= 1 },
    {
      name: 'prompt strategy emitted',
      target: 'yes',
      actual: compiled.hasPromptStrategies ? 'yes' : 'no',
      pass: compiled.hasPromptStrategies,
    },
    {
      name: 'executable safety rules',
      target: '≥ 1',
      actual: String(compiled.executableSafetyRules),
      pass: compiled.executableSafetyRules >= 1,
    },
  ];
  return { gold, compiled, ratios: { coverage, recall }, checks, passed: checks.every((c) => c.pass) };
}

/** With a real model: how much of the gold XO's uplift over the plain model did the compiled XO capture? */
export function upliftRatio(plain: number, compiled: number, gold: number): number | null {
  return gold - plain <= 0.0001 ? null : (compiled - plain) / (gold - plain);
}
