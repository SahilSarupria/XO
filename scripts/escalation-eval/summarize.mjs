#!/usr/bin/env node
// Summarizes the JSON report written by the live escalation evaluation (packages/compiler/test/knowledge/escalation-eval.test.ts)
// and applies its PRE-REGISTERED criteria mechanically. Usage: node summarize.mjs <report.json> [summary.md]
import { readFileSync, writeFileSync } from 'node:fs';

const [, , reportPath, mdPath] = process.argv;
if (!reportPath) {
  console.error('usage: node summarize.mjs <report.json> [summary.md]');
  process.exit(2);
}
let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (e) {
  console.error(`cannot read report "${reportPath}": ${e.message}`);
  process.exit(2);
}
const R = report.results;
if (!R || !R['dev:always'] || !R['held:always']) {
  console.error('report is missing the required arms (dev:always, held:always); the run did not complete');
  process.exit(2);
}

// ---- pre-registered criteria (keep in sync with the header of escalation-eval.test.ts) -------------------------------
const F1_TOLERANCE = 0.02; // gated must be within this of always-escalate
const MIN_SAVINGS = 0.1; // and must save at least this share of model calls (calls <= 0.90 x always)
const MIN_GAIN_OVER_RULES = 0.05; // and the model must actually help: F1 > rules-only + this
const lines = [];
const out = (s = '') => {
  lines.push(s);
  console.log(s);
};
const f = (n) => (typeof n === 'number' ? n.toFixed(3) : String(n));

function row(name, a) {
  const c = a.counts;
  return `| ${name} | ${f(a.prf.precision)} | ${f(a.prf.recall)} | ${f(a.prf.f1)} | ${c.fp} | ${c.missed} | ${a.escalated}/${a.escalated + a.skipped} | ${a.freshModelCalls} | ${a.cacheReplays} | ${a.denied} | ${a.rejectedInvalid} | ${a.failed} |`;
}
const HEAD =
  '| Arm | Precision | Recall | F1 | False pos. | Missed gold | Units escalated | Fresh model calls | Cache replays | Budget-denied | Rejected invalid | Provider failed |\n|---|---|---|---|---|---|---|---|---|---|---|---|';

if (report.scripted === true) {
  out('# !!! SCRIPTED-PROVIDER REPORT: NOT REAL-MODEL EVIDENCE !!!');
  out('This report came from the offline plumbing test, not a real model. Do not read any number below as a result.');
  out();
}
out(`# Escalation-policy evaluation${report.scripted === true ? ' (PLUMBING ONLY)' : ': REAL-MODEL results'}`);
out(`Model: ${report.model ?? 'unknown'}`);
out();
out(
  'Read this against the pre-registered criteria. A small, single-annotator set: no significance claims. Fresh calls and token use below are real; "cache replays" reuse an earlier answer for the same unit at no cost.',
);
out();

// ---- validity ----------------------------------------------------------------------------------------------------------
const confounded = Object.entries(R).filter(([, a]) => a.denied > 0 || a.failed > 0);
const rejected = Object.entries(R).filter(([, a]) => a.rejectedInvalid > 0);
if (confounded.length > 0) {
  out(
    '> WARNING: THIS RUN IS CONFOUNDED. Some arms had budget denials or provider failures, so their model output is incomplete and the comparison is NOT valid.',
  );
  for (const [n, a] of confounded) out(`> - ${n}: ${a.denied} budget-denied, ${a.failed} provider-failed`);
  out('> Fix the cause (raise the budget, slow the pacing, check the key/quota/model) and re-run before drawing any conclusion.');
  out();
}
if (rejected.length > 0) {
  out(
    `> NOTE: model output was rejected by compile-side validation in: ${rejected.map(([n, a]) => `${n} (${a.rejectedInvalid})`).join(', ')}. Those units fell back to rule-only. A high count means the grounding check may be too strict, or the model output was unusable.`,
  );
  out();
}

// ---- dev ---------------------------------------------------------------------------------------------------------------
const thresholds = Object.keys(R)
  .filter((k) => /^dev:gated@/.test(k))
  .map((k) => Number(k.split('@')[1]))
  .sort((a, b) => a - b);
out('## Development set (used ONLY to choose a threshold)');
out();
out(HEAD);
out(row('rules-only', R['dev:rules-only']));
out(row('always-escalate', R['dev:always']));
for (const t of thresholds) out(row(`gated @ ${t}`, R[`dev:gated@${t}`]));
out();

const alwaysDev = R['dev:always'];
const eligible = thresholds
  .filter((t) => R[`dev:gated@${t}`].prf.f1 >= alwaysDev.prf.f1 - F1_TOLERANCE)
  .sort((a, b) => R[`dev:gated@${a}`].escalated - R[`dev:gated@${b}`].escalated || b - a);
const chosen =
  eligible.length > 0 && R[`dev:gated@${eligible[0]}`].escalated <= (1 - MIN_SAVINGS) * alwaysDev.escalated ? eligible[0] : null;
out(
  `Selection rule: highest-savings threshold with dev F1 >= always F1 (${f(alwaysDev.prf.f1)}) - ${F1_TOLERANCE}, and calls <= ${(1 - MIN_SAVINGS) * 100}% of always (${alwaysDev.escalated}).`,
);
out(
  chosen === null
    ? '**Result: no threshold qualifies. Confidence-based skipping is NOT supported on the development set.**'
    : `**Result: dev-selected threshold = ${chosen}.**`,
);
if (report.chosenThreshold !== undefined && report.chosenThreshold !== chosen)
  out(`(note: the harness recorded chosenThreshold=${report.chosenThreshold}; this summary recomputed ${chosen}. They should match.)`);
out();

// ---- held-out ----------------------------------------------------------------------------------------------------------
out('## Held-out set (evaluated ONCE, no re-tuning)');
out();
out(HEAD);
const heldArms = Object.keys(R).filter((k) => k.startsWith('held:'));
const order = ['held:rules-only', 'held:always', ...heldArms.filter((k) => /gated/.test(k))];
for (const k of order) if (R[k]) out(row(k.replace('held:', ''), R[k]));
out();

function verdict(label, arm) {
  const a = R['held:always'];
  const rules = R['held:rules-only'];
  if (!arm || !rules) return;
  const c1 = arm.prf.f1 >= a.prf.f1 - F1_TOLERANCE;
  const c2 = arm.escalated <= (1 - MIN_SAVINGS) * a.escalated;
  const c3 = arm.prf.f1 > rules.prf.f1 + MIN_GAIN_OVER_RULES;
  const all = c1 && c2 && c3 && confounded.length === 0;
  out(`### Verdict for ${label}: ${all ? 'SUPPORTED' : 'NOT SUPPORTED'}`);
  out(`- Quality kept: held-out F1 ${f(arm.prf.f1)} >= always ${f(a.prf.f1)} - ${F1_TOLERANCE}: **${c1 ? 'yes' : 'no'}**`);
  out(`- Real savings: ${arm.escalated} calls <= ${(1 - MIN_SAVINGS) * 100}% of always (${a.escalated}): **${c2 ? 'yes' : 'no'}**`);
  out(`- The model actually helps: F1 ${f(arm.prf.f1)} > rules-only ${f(rules.prf.f1)} + ${MIN_GAIN_OVER_RULES}: **${c3 ? 'yes' : 'no'}**`);
  if (confounded.length > 0) out('- Run confounded by denials/failures: **verdict withheld as invalid**');
  out();
}
verdict('the default threshold 0.75', R['held:gated@0.75']);
const chosenKey = heldArms.find((k) => /dev-selected/.test(k));
if (chosenKey) verdict(`the dev-selected threshold ${chosen}`, R[chosenKey]);
else if (chosen === null) out('No dev-selected threshold, so no further held-out arm was run.\n');

const a = R['held:always'];
const r = R['held:rules-only'];
out(
  `Does the MODEL help at all (held-out, always-escalate vs rules-only)? F1 ${f(r.prf.f1)} -> ${f(a.prf.f1)} (${a.prf.f1 - r.prf.f1 >= MIN_GAIN_OVER_RULES ? 'improvement beyond the +' + MIN_GAIN_OVER_RULES + ' bar' : 'NO clear improvement'}); false positives ${r.counts.fp} -> ${a.counts.fp}; missed gold ${r.counts.missed} -> ${a.counts.missed}.`,
);
out();

// ---- spend -------------------------------------------------------------------------------------------------------------
out('## Spend (whole run, all arms)');
out();
if (report.spend) {
  out(
    `- Tokens charged to the budget: ${report.spend.tokensSpent} (provider-reported usage; a call with unreported usage is charged at its reservation).`,
  );
  out(
    `- Cost: ${report.estimatedCostUsd === 'unavailable' ? 'unavailable (no price supplied; the repository has no verified Gemini price)' : '$' + report.estimatedCostUsd + ' (ESTIMATE from the prices you supplied, assuming a 50/50 input/output split)'}`,
  );
} else out('- No spend recorded.');
out(`- Budget denials (whole run): ${JSON.stringify(report.denials ?? {})}`);
const fresh = Object.values(R).reduce((n, x) => n + x.freshModelCalls, 0);
out(`- Fresh model calls counted across arms: ${fresh}`);
out();
out('## Limits that still apply');
out(
  '- 43 units, one annotator who also built the gate; no inter-annotator agreement; many form-fragment units. Treat as a directional check, not a benchmark.',
);
out('- Matching is lenient (a candidate matches a gold term if it equals it or contains it as a whole phrase).');
out(
  '- A single model, a single run: LLM output varies between runs; the shared cache makes arms comparable but hides run-to-run variance.',
);

if (mdPath) writeFileSync(mdPath, lines.join('\n') + '\n');
