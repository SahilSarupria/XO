import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { estimateInputTokensUpperBound } from '@xo/ai-core';
import { createDefaultSourceFrontendRegistry } from '../../src/sources/default-registry.js';
import { chunkDocument } from '../../src/semantic/semantic-chunker.js';
import { RuleBasedKnowledgeExtractor } from '../../src/knowledge/rule-based-extractor.js';
import {
  DEFAULT_ESCALATION_POLICY,
  decideEscalation,
  isUsableLabel,
  type EscalationPolicyConfig,
} from '../../src/knowledge/escalation-policy.js';
import type { CandidateKnowledgeNode } from '../../src/knowledge/extractor-types.js';
import type { ExperienceUnit } from '../../src/semantic/types.js';
import { GOLD } from './escalation-gold.js';

/**
 * MEASUREMENT HARNESS (not a benchmark of a model). It answers: given the rules' real output on real units, how well does each
 * escalation policy AIM its model calls, and what does it leave behind?
 *
 * No live model is available offline, so "after escalation" is computed against an ORACLE that fixes every escalated unit
 * perfectly. That makes the oracle numbers a CEILING on what a policy could achieve with a flawless model — useful for comparing
 * policies against each other and against always-escalate, but NOT evidence that a real model would improve anything. Whether a
 * real model improves extraction must be measured with a live provider (see docs).
 */
const dir = fileURLToPath(new URL('../../../../examples/vertical-test/', import.meta.url));
const FILES: Record<string, string> = {
  XO_Com: 'XO_Commercial_Property_Test_Policy_Compatible.pdf',
  burgla: 'burglary-policy.pdf',
  Aastha: 'Aastha.pdf',
};

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,:;"')(]+$/, '')
    .replace(/^the /, '');

interface Row {
  readonly key: string;
  readonly unit: ExperienceUnit;
  readonly nodes: readonly CandidateKnowledgeNode[];
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly gold: number;
  readonly primaryOk: boolean;
  readonly needsHelp: boolean;
}

async function loadRows(): Promise<Row[]> {
  const registry = createDefaultSourceFrontendRegistry();
  const rb = new RuleBasedKnowledgeExtractor();
  const byFile = new Map<string, { unit: ExperienceUnit; nodes: CandidateKnowledgeNode[] }[]>();
  for (const [prefix, name] of Object.entries(FILES)) {
    const ing = registry.ingest({ kind: 'pdf', bytes: new Uint8Array(await readFile(dir + name)), sourcePath: name });
    assert.ok(ing.ok && ing.value.content.kind === 'document');
    if (!ing.ok || ing.value.content.kind !== 'document') continue;
    const doc = await chunkDocument(ing.value.content.parsed, name, ing.value.content.documentTitle);
    const list: { unit: ExperienceUnit; nodes: CandidateKnowledgeNode[] }[] = [];
    for (const unit of doc.units) {
      if (unit.isTableQuarantined) continue;
      const r = await rb.extract(unit);
      if (r.ok) list.push({ unit, nodes: [...r.value.nodes] });
    }
    byFile.set(prefix, list);
  }
  return GOLD.map((g) => {
    const found = (byFile.get(g.file) ?? []).find(
      (x) => x.unit.content.split(/\s+/).filter(Boolean).join(' ').slice(0, 50) === g.textStart,
    );
    assert.ok(found, `gold unit not found: ${g.file} / ${g.textStart}`);
    const predicted = new Set(found.nodes.filter((n) => !n.isUnitPrimary).map((n) => norm(n.label)));
    const gold = new Set(g.entities.map(norm));
    const tp = [...predicted].filter((p) => gold.has(p)).length;
    const fp = predicted.size - tp;
    const fn = gold.size - tp;
    return {
      key: `${g.file}:${g.textStart}`,
      unit: found.unit,
      nodes: found.nodes,
      tp,
      fp,
      fn,
      gold: gold.size,
      primaryOk: g.primaryOk,
      needsHelp: fp > 0 || fn > 0 || !g.primaryOk,
    };
  });
}

type Strategy = { readonly name: string; readonly escalate: (row: Row) => boolean; readonly exploratory?: boolean };

const gated = (over: Partial<EscalationPolicyConfig>) => (row: Row) =>
  decideEscalation(row.unit, row.nodes, { ...DEFAULT_ESCALATION_POLICY, ...over }).escalate;

/** EXPLORATORY ONLY (not shipped): also escalate when fewer than half of the non-primary candidates are usable and >= 0.65. */
const noisyRule = (row: Row): boolean => {
  const ents = row.nodes.filter((n) => !n.isUnitPrimary);
  if (ents.length === 0) return false;
  const good = ents.filter((n) => isUsableLabel(n.label, DEFAULT_ESCALATION_POLICY.maxLabelWords) && n.confidence >= 0.65).length;
  return good / ents.length < 0.5;
};

function evaluate(rows: readonly Row[], s: Strategy) {
  const escalated = rows.filter(s.escalate);
  const skipped = rows.filter((r) => !s.escalate(r));
  // ORACLE: escalated units become perfect; skipped units keep the rule output.
  const tp = escalated.reduce((n, r) => n + r.gold, 0) + skipped.reduce((n, r) => n + r.tp, 0);
  const fp = skipped.reduce((n, r) => n + r.fp, 0);
  const fn = skipped.reduce((n, r) => n + r.fn, 0);
  const primaryWrong = skipped.filter((r) => !r.primaryOk).length;
  const helpTotal = rows.filter((r) => r.needsHelp).length;
  const helped = escalated.filter((r) => r.needsHelp).length;
  const p = tp + fp === 0 ? 1 : tp / (tp + fp);
  const r = tp + fn === 0 ? 1 : tp / (tp + fn);
  return {
    strategy: s.name,
    exploratory: s.exploratory === true,
    calls: escalated.length,
    skippedUnits: skipped.length,
    // Upper-bound input-token proxy for the calls made (not a price and not a measurement).
    inputTokenUpperBound: escalated.reduce((n, x) => n + estimateInputTokensUpperBound([{ content: x.unit.content }]), 0),
    needsHelpUnitsCaptured: `${helped}/${helpTotal}`,
    gateRecall: helpTotal === 0 ? 1 : +(helped / helpTotal).toFixed(3),
    gatePrecision: escalated.length === 0 ? null : +(helped / escalated.length).toFixed(3),
    residualEntityFP: fp,
    residualEntityFN: fn,
    residualPrimaryWrong: primaryWrong,
    oracleEntityPrecision: +p.toFixed(3),
    oracleEntityRecall: +r.toFixed(3),
    oracleEntityF1: +(p + r === 0 ? 0 : (2 * p * r) / (p + r)).toFixed(3),
  };
}

test('measurement: how well does each escalation policy aim its calls on real, hand-annotated units?', async () => {
  const rows = await loadRows();
  assert.equal(rows.length, GOLD.length);

  const strategies: Strategy[] = [
    { name: 'rules-only (never escalate)', escalate: () => false },
    { name: 'always (legacy: every unit)', escalate: gated({ mode: 'always' }) },
    ...[0.6, 0.65, 0.7, 0.75].map((t) => ({ name: `gated threshold=${t}`, escalate: gated({ confidenceThreshold: t }) })),
    {
      name: 'gated threshold=0.7 + noisy-candidate rule (EXPLORATORY)',
      escalate: (r: Row) => gated({ confidenceThreshold: 0.7 })(r) || noisyRule(r),
      exploratory: true,
    },
  ];
  const results = strategies.map((s) => evaluate(rows, s));

  // Rule-only baseline, by gate decision class at the default policy.
  const byClass: Record<string, { units: number; needsHelp: number; fp: number; fn: number; primaryWrong: number }> = {};
  for (const r of rows) {
    const reason = decideEscalation(r.unit, r.nodes, DEFAULT_ESCALATION_POLICY).reason;
    const c = (byClass[reason] ??= { units: 0, needsHelp: 0, fp: 0, fn: 0, primaryWrong: 0 });
    c.units += 1;
    c.needsHelp += r.needsHelp ? 1 : 0;
    c.fp += r.fp;
    c.fn += r.fn;
    c.primaryWrong += r.primaryOk ? 0 : 1;
  }
  const baseline = {
    goldUnits: rows.length,
    unitsWhereRulesNeedHelp: rows.filter((r) => r.needsHelp).length,
    ruleEntityTP: rows.reduce((n, r) => n + r.tp, 0),
    ruleEntityFP: rows.reduce((n, r) => n + r.fp, 0),
    ruleEntityFN: rows.reduce((n, r) => n + r.fn, 0),
    rulePrimaryWrong: rows.filter((r) => !r.primaryOk).length,
  };

  const report = { baseline, byClassAtDefault: byClass, results };
  if (process.env['XO_ESCALATION_REPORT_PATH']) await writeFile(process.env['XO_ESCALATION_REPORT_PATH'], JSON.stringify(report, null, 2));

  // Invariants only. Deliberately NO assertion that gating "improves" anything: that is for the reader of the numbers to judge.
  const always = results.find((x) => x.strategy.startsWith('always'))!;
  const never = results.find((x) => x.strategy.startsWith('rules-only'))!;
  assert.equal(always.calls, rows.length);
  assert.equal(never.calls, 0);
  for (const g of results.filter((x) => x.strategy.startsWith('gated'))) {
    assert.ok(g.calls <= always.calls, `${g.strategy} must never call more than always-escalate`);
    assert.ok(
      g.residualEntityFN <= never.residualEntityFN && g.residualEntityFP <= never.residualEntityFP,
      'an oracle can only remove errors',
    );
  }
});
