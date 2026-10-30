/**
 * Evaluates the rule-proposal pipeline (WS1-09) against the SYNTHETIC labelled set `proposal-labels.json`.
 *
 *   node --import tsx examples/insurance-dev-corpus/proposal-eval.mts            replay the recorded replies
 *   node --import tsx examples/insurance-dev-corpus/proposal-eval.mts --model-cmd "<shell command>"
 *       pipes each prompt to the command's stdin and reads the model's reply from stdout (any model, any provider)
 *
 * Replay mode measures the VALIDATION layer (does it accept good proposals and reject hallucinated ones?). It says
 * nothing about model quality: only --model-cmd runs a model, and only real documents make that number meaningful.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proposeRules, modelProposer, type RuleProposer, type UnclassifiedSentence } from '../../packages/compiler/src/reasoning/index.js';

interface Reply {
  kind: string;
  condition?: string;
  outcome?: string;
  declined?: boolean;
}
interface Item {
  text: string;
  gold: { condition: string; outcome: string } | null;
  replies: Reply[];
}
const here = dirname(fileURLToPath(import.meta.url));
const labels = JSON.parse(readFileSync(join(here, 'proposal-labels.json'), 'utf8')) as { items: Item[] };
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const sentence = (text: string): UnclassifiedSentence => ({
  text,
  cues: [],
  sourceUnitId: 'eval',
  provenance: { documentPath: 'proposal-labels.json' } as UnclassifiedSentence['provenance'],
});
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

const modelCmd = arg('--model-cmd');
if (modelCmd !== undefined) {
  const propose: RuleProposer = modelProposer(async (prompt) => execFileSync('sh', ['-c', modelCmd], { input: prompt, encoding: 'utf8' }));
  let accepted = 0;
  let matchesGold = 0;
  let wrongAccepted = 0;
  let goldCount = 0;
  const rules = labels.items.filter((i) => i.gold !== null);
  goldCount = rules.length;
  for (const item of labels.items) {
    const [p] = await proposeRules([sentence(item.text)], propose);
    if (p?.status === 'valid') {
      accepted += 1;
      if (item.gold !== null && norm(p.condition) === norm(item.gold.condition)) matchesGold += 1;
      else wrongAccepted += 1;
    }
  }
  console.log(
    JSON.stringify(
      {
        mode: 'model',
        items: labels.items.length,
        goldRules: goldCount,
        validProposals: accepted,
        validAndMatchesGold: matchesGold,
        validButWrongOrNotARule: wrongAccepted,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

let goodTotal = 0;
let goodAccepted = 0;
let goodMatching = 0;
let badTotal = 0;
let badRejected = 0;
const leaks: string[] = [];
for (const item of labels.items) {
  for (const reply of item.replies) {
    const replayed: RuleProposer = async () =>
      reply.declined === true || reply.condition === undefined || reply.outcome === undefined
        ? undefined
        : { condition: reply.condition, outcome: reply.outcome };
    const [p] = await proposeRules([sentence(item.text)], replayed);
    const shouldAccept = reply.kind === 'good';
    if (shouldAccept) {
      goodTotal += 1;
      if (p?.status === 'valid') {
        goodAccepted += 1;
        if (item.gold !== null && norm(p.condition) === norm(item.gold.condition)) goodMatching += 1;
      } else console.log(`REJECTED a good proposal: ${item.text} -> ${p?.reasons.join('; ')}`);
    } else {
      badTotal += 1;
      if (p === undefined || p.status === 'rejected') badRejected += 1;
      else leaks.push(`${reply.kind}: ${item.text}`);
    }
  }
}
console.log(
  JSON.stringify(
    {
      mode: 'replay (validation layer only; not a model measurement)',
      goodProposalsAccepted: `${goodAccepted}/${goodTotal}`,
      acceptedAndMatchGold: `${goodMatching}/${goodTotal}`,
      badProposalsRejected: `${badRejected}/${badTotal}`,
      leaks,
    },
    null,
    2,
  ),
);
if (leaks.length > 0 || goodAccepted !== goodTotal) process.exitCode = 1;
