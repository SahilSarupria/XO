import type { ModelProvider } from '@xo/ai-core';
import { createCapabilityLayer, extractJsonObject, runAgent, XoExecutor, type ToolCallRecord } from '@xo/capability-layer';
import type { PackageBundle } from '@xo/package-sdk';
import { OUTPUT_CONTRACT } from '../scenario/freight/gold-xo.js';
import type { FreightTask } from '../scenario/freight/generate.js';
import { manualMarkdown, PROMPT_ONLY_BRIEF } from '../scenario/freight/rules.js';

export type ArmId = 'plain' | 'prompt' | 'dump' | 'xo_context' | 'xo_tools' | 'xo_router' | 'compiled_context';

export interface ArmRun {
  readonly output: Record<string, unknown> | null;
  readonly rawText: string;
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly path: 'model' | 'deterministic' | 'cache' | 'refused';
  readonly overridden: boolean;
  readonly latencyMs: number;
  readonly error?: string;
}

export interface Arm {
  readonly id: ArmId;
  readonly label: string;
  /** What the arm is shown: free-text claim notes, or the structured intake form. */
  readonly input: 'narrative' | 'structured';
  run(task: FreightTask): Promise<ArmRun>;
}

export interface ArmFactoryOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly gold: PackageBundle;
  readonly compiled?: PackageBundle;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly knowledgeK?: number;
  readonly exemplarK?: number;
  readonly handbook?: number;
}

function treesOf(bundle: PackageBundle): unknown {
  const c = bundle.components.find((x) => x.kind === 'decision_trees');
  return c === undefined ? undefined : JSON.parse(new TextDecoder().decode(c.data));
}

async function plainRun(
  provider: ModelProvider,
  model: string,
  system: string,
  user: string,
  temperature: number,
  maxOutputTokens: number,
): Promise<ArmRun> {
  const t0 = performance.now();
  try {
    const run = await runAgent(provider, user, { model, systemPrompt: system, temperature, maxOutputTokens });
    const output = extractJsonObject(run.text);
    return {
      output,
      rawText: run.text,
      modelCalls: run.turns,
      inputTokens: run.usage.inputTokens,
      outputTokens: run.usage.outputTokens,
      toolCalls: [],
      path: 'model',
      overridden: false,
      latencyMs: performance.now() - t0,
      ...(output === null ? { error: 'no JSON object in reply' } : {}),
    };
  } catch (e) {
    return {
      output: null,
      rawText: '',
      modelCalls: 1,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: [],
      path: 'model',
      overridden: false,
      latencyMs: performance.now() - t0,
      error: (e as Error).message,
    };
  }
}

export function buildArms(o: ArmFactoryOptions): Record<ArmId, Arm> {
  const temperature = o.temperature ?? 0;
  const maxOut = o.maxOutputTokens ?? 1024;
  const fromExecutor = (r: Awaited<ReturnType<XoExecutor['execute']>>): ArmRun => ({
    output: r.output,
    rawText: r.rawText,
    modelCalls: r.modelCalls,
    inputTokens: r.usage.inputTokens,
    outputTokens: r.usage.outputTokens,
    toolCalls: r.toolCalls,
    path: r.path,
    overridden: r.overridden,
    latencyMs: r.latencyMs,
    ...(r.error !== undefined ? { error: r.error } : {}),
  });
  const xo = (bundle: PackageBundle, tools: boolean, withTrees: boolean): XoExecutor => {
    const layer = createCapabilityLayer(bundle, { host: { family: 'claude', capabilities: tools ? ['chat', 'tool_use'] : ['chat'] } });
    return new XoExecutor(
      layer,
      {
        provider: o.provider,
        model: o.model,
        preamble: OUTPUT_CONTRACT,
        temperature,
        maxOutputTokens: maxOut,
        cache: false,
        ...(o.knowledgeK !== undefined ? { knowledgeK: o.knowledgeK } : { knowledgeK: 9 }),
        ...(o.exemplarK !== undefined ? { exemplarK: o.exemplarK } : {}),
      },
      withTrees ? treesOf(bundle) : undefined,
    );
  };
  const manual = manualMarkdown(o.handbook);
  const goldContext = xo(o.gold, false, false);
  const goldTools = xo(o.gold, true, false);
  const goldRouter = xo(o.gold, true, true);
  const compiledContext = o.compiled !== undefined ? xo(o.compiled, false, false) : undefined;

  const arms: Record<ArmId, Arm> = {
    plain: {
      id: 'plain',
      label: 'Model alone (output format only)',
      input: 'narrative',
      run: (t) => plainRun(o.provider, o.model, OUTPUT_CONTRACT, t.narrative, temperature, maxOut),
    },
    prompt: {
      id: 'prompt',
      label: 'Strong expert prompt (procedure, no house numbers)',
      input: 'narrative',
      run: (t) => plainRun(o.provider, o.model, `${OUTPUT_CONTRACT}\n\n${PROMPT_ONLY_BRIEF}`, t.narrative, temperature, maxOut),
    },
    dump: {
      id: 'dump',
      label: 'Full manual pasted into the prompt',
      input: 'narrative',
      run: (t) =>
        plainRun(
          o.provider,
          o.model,
          `${OUTPUT_CONTRACT}\n\n${PROMPT_ONLY_BRIEF}\n\nThe claims desk manual follows. Apply it exactly.\n\n${manual}`,
          t.narrative,
          temperature,
          maxOut,
        ),
    },
    xo_context: {
      id: 'xo_context',
      label: 'XO L2: retrieval + worked examples + prompt strategy (no tools)',
      input: 'narrative',
      run: async (t) => fromExecutor(await goldContext.execute({ text: t.narrative })),
    },
    xo_tools: {
      id: 'xo_tools',
      label: 'XO L3: + decision-tree tool + safety gate',
      input: 'narrative',
      run: async (t) => fromExecutor(await goldTools.execute({ text: t.narrative })),
    },
    xo_router: {
      id: 'xo_router',
      label: 'XO router: structured intake solved locally, no model call',
      input: 'structured',
      run: async (t) =>
        fromExecutor(await goldRouter.execute({ text: JSON.stringify(t.statedFacts), facts: t.statedFacts as Record<string, unknown> })),
    },
    compiled_context: {
      id: 'compiled_context',
      label: 'COMPILED XO L2: same as xo_context but built by the compiler from the manual',
      input: 'narrative',
      run: async (t) =>
        compiledContext === undefined
          ? {
              output: null,
              rawText: '',
              modelCalls: 0,
              inputTokens: 0,
              outputTokens: 0,
              toolCalls: [],
              path: 'refused',
              overridden: false,
              latencyMs: 0,
              error: 'no compiled bundle supplied',
            }
          : fromExecutor(await compiledContext.execute({ text: t.narrative })),
    },
  };
  return arms;
}
