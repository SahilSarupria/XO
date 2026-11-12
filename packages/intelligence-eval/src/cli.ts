#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AnthropicProvider, ConversationLayer, GeminiProvider, OpenAiProvider, type ModelProvider } from '@xo/ai-core';
import type { ConversationModel } from '@xo/intelligence';
import { pathToFileURL } from 'node:url';
import type { Evidence, KnowledgePort } from '@xo/intelligence';
import { CORPUS, PERSONAS } from './corpus.js';
import { DATASET } from './dataset.js';
import { OracleModel } from './oracle.js';
import { buildReport, renderMarkdown } from './report.js';
import { runEval } from './runner.js';
import { CATEGORIES, type Category } from './types.js';

const out_ = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i] as string;
  if (a.startsWith('--'))
    args.set(
      a.slice(2),
      process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? 'true' : (process.argv[++i] as string),
    );
}

if (args.has('help')) {
  out_(
    [
      'xo-intelligence-eval [--mode oracle|live] [--provider gemini|anthropic|openai --model <name>] [--category <name>] [--out <dir>] [--concurrency <n>]',
      '  --export-corpus <dir>      write the eval corpus + personas as JSON, to load into a knowledge system under test (e.g. a C6 test organization)',
      '  --knowledge-module <path>  run against your own knowledge source: an ES module exporting createKnowledge(): KnowledgePort and optionally docIdOf(evidence): string',
    ].join('\n'),
  );
  process.exit(0);
}

if (args.has('export-corpus')) {
  const dir = args.get('export-corpus') as string;
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'corpus.json'),
    JSON.stringify(
      {
        documents: CORPUS,
        personas: Object.values(PERSONAS),
        note: 'Synthetic. Persona ids are the identityId the harness passes in Principal; a document is visible to a persona if its acl contains "*" or one of the persona groups.',
      },
      null,
      2,
    ),
  );
  out_(`wrote ${join(dir, 'corpus.json')} (${CORPUS.length} documents, ${Object.keys(PERSONAS).length} personas)`);
  process.exit(0);
}

let knowledgeFactory: (() => KnowledgePort) | undefined;
let docIdOf: ((e: Evidence) => string) | undefined;
let knowledgeLabel = 'fixture corpus (keyword match, authorization-aware test double — not C6)';
if (args.has('knowledge-module')) {
  const path = args.get('knowledge-module') as string;
  const mod = (await import(pathToFileURL(path).href)) as { createKnowledge?: () => KnowledgePort; docIdOf?: (e: Evidence) => string };
  if (typeof mod.createKnowledge !== 'function') throw new Error(`${path} must export createKnowledge()`);
  knowledgeFactory = mod.createKnowledge;
  docIdOf = mod.docIdOf;
  knowledgeLabel = `custom: ${path}`;
}

const mode = (args.get('mode') ?? 'oracle') as 'oracle' | 'live';
const cat = args.get('category');
if (cat !== undefined && !CATEGORIES.includes(cat as Category)) throw new Error(`unknown category "${cat}" (${CATEGORIES.join(', ')})`);

let model: ConversationModel;
let modelName = 'oracle';
let candidates: { providerId: string; model: string }[] | undefined;
if (mode === 'live') {
  const name = args.get('provider');
  const modelId = args.get('model');
  if (name === undefined || modelId === undefined) throw new Error('--mode live needs --provider and --model');
  const keyVar = { gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' }[name];
  if (keyVar === undefined) throw new Error(`unknown provider "${name}"`);
  const apiKey = process.env[keyVar];
  if (!apiKey) throw new Error(`${keyVar} is not set`);
  const provider: ModelProvider =
    name === 'gemini'
      ? new GeminiProvider({ apiKey })
      : name === 'anthropic'
        ? new AnthropicProvider({ apiKey })
        : new OpenAiProvider({ apiKey });
  model = new ConversationLayer({ providers: [provider] });
  candidates = [{ providerId: provider.id, model: modelId }];
  modelName = `${name}:${modelId}`;
} else {
  model = new OracleModel(DATASET);
}

const results = await runEval({
  model,
  items: DATASET,
  ...(knowledgeFactory ? { knowledge: knowledgeFactory } : {}),
  ...(docIdOf ? { docIdOf } : {}),
  ...(cat ? { categories: [cat as Category] } : {}),
  concurrency: Number(args.get('concurrency') ?? (mode === 'live' ? 4 : 1)),
  ...(candidates ? { modelCandidates: candidates } : {}),
  onProgress: (done, total, r) => process.stderr.write(`\r${done}/${total} ${r.pass ? 'ok  ' : 'FAIL'} ${r.id}        `),
});
process.stderr.write('\n');

const report = buildReport(results, {
  mode,
  model: modelName,
  knowledgeSource: knowledgeLabel,
});
const out = args.get('out') ?? 'eval-out';
await mkdir(out, { recursive: true });
await writeFile(join(out, 'report.json'), JSON.stringify({ report, results }, null, 2));
await writeFile(join(out, 'report.md'), renderMarkdown(report));
out_(renderMarkdown(report));
process.exit(report.passed ? 0 : 1);
