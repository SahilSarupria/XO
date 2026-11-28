import type { ModelProvider } from '@xo/ai-core';
import { createCapabilityLayer, type EvidenceLexicon, extractJsonObject, runAgent, XoExecutor, type ToolCallRecord } from '@xo/capability-layer';
import type { PackageBundle } from '@xo/package-sdk';
import { OUTPUT_CONTRACT } from '../scenario/freight/gold-xo.js';
import type { FreightTask } from '../scenario/freight/generate.js';
import { manualMarkdown, PROMPT_ONLY_BRIEF } from '../scenario/freight/rules.js';

export type ArmId =
  'plain' | 'prompt' | 'dump' | 'xo_context' | 'xo_tools' | 'xo_tools_grounded' | 'xo_tools_classified' | 'xo_router' | 'compiled_context' | 'compiled_tools_grounded' | 'compiled_tools_hinted';

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
  /** Set by the runner: how much of latencyMs was spent waiting on retries or the rate pacer. */
  readonly waits?: { readonly retryMs: number; readonly pacedMs: number; readonly retries: number };
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
  /** Domain vocabulary for evidence checking, loaded from the Business Knowledge Base. Arms that use it say so; the rest run without. */
  readonly lexicon?: EvidenceLexicon;
  /** Gold XO built with `classification: true` (needed only for the xo_tools_classified arm). */
  readonly goldClassified?: PackageBundle;
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
  const xo = (bundle: PackageBundle, tools: boolean, withTrees: boolean, requireEvidence = false, trustedFactSources?: readonly string[], lexicon?: EvidenceLexicon): XoExecutor => {
    const layer = createCapabilityLayer(bundle, {
      host: { family: 'claude', capabilities: tools ? ['chat', 'tool_use'] : ['chat'] },
      ...(requireEvidence ? { requireEvidence: true } : { requireEvidence: false, groundingWaiver: { reason: 'experiment baseline arm: ungrounded on purpose, to measure what grounding adds' } }),
      ...(trustedFactSources !== undefined ? { trustedFactSources } : {}),
      ...(lexicon !== undefined ? { evidenceLexicon: lexicon } : {}),
    });
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
  /**
   * Decision commit (fail closed). With grounding on, the model only supplies facts: the committed decision is the tree's own outcome
   * from the last successful evaluation. If no evaluation ever succeeded (tool errors, malformed calls, ungrounded facts), the case
   * escalates; the model's free-text answer is never used. Without this the model can shrug off a refused tool call and answer itself.
   */
  const commit = (r: Awaited<ReturnType<XoExecutor['execute']>>): ArmRun => {
    const base = fromExecutor(r);
    let outcome: { decision?: unknown; payout_usd?: unknown; escalation_target?: unknown; reason_code?: unknown } | undefined;
    for (const c of r.toolCalls) {
      if (c.isError) continue;
      try {
        const o2 = (JSON.parse(c.result) as { outcome?: typeof outcome }).outcome;
        if (o2 !== undefined && typeof o2 === 'object') outcome = o2;
      } catch {
        /* not a tree result */
      }
    }
    const committed =
      outcome !== undefined
        ? { decision: outcome.decision, payout_usd: outcome.payout_usd, escalation_target: outcome.escalation_target ?? null, reason: String(outcome.reason_code ?? 'tree outcome') }
        : { decision: 'escalate', payout_usd: 0, escalation_target: 'Claims Manager', reason: 'no validated tree evaluation: escalated by the runtime' };
    return { ...base, output: committed as unknown as ArmRun['output'], overridden: true };
  };
  const manual = manualMarkdown(o.handbook);
  const goldContext = xo(o.gold, false, false);
  const goldTools = xo(o.gold, true, false);
  const goldToolsGrounded = xo(o.gold, true, false, true, undefined, o.lexicon);
  const goldClassified = o.goldClassified !== undefined ? xo(o.goldClassified, true, false) : undefined;
  // structured intake: every field arrives from the trusted intake form, with provenance, like any other grounded input
  const goldRouter = xo(o.gold, true, true, true, ['intake_form']);
  const compiledContext = o.compiled !== undefined ? xo(o.compiled, false, false) : undefined;
  // the compiler's own decision tree as the tool, through the same grounding + decision commit as the hand-built tree
  const compiledToolsGrounded = o.compiled !== undefined ? xo(o.compiled, true, false, true) : undefined;
  const compiledToolsHinted = o.compiled !== undefined && o.lexicon !== undefined ? xo(o.compiled, true, false, true, undefined, o.lexicon) : undefined;
  const refused = (why: string): ArmRun => ({ output: null, rawText: '', modelCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: [], path: 'refused', overridden: false, latencyMs: 0, error: why });

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
    xo_tools_grounded: {
      id: 'xo_tools_grounded',
      label: 'XO L3 + fact grounding: every tool fact needs a verbatim quote from the claim',
      input: 'narrative',
      run: async (t) => commit(await goldToolsGrounded.execute({ text: t.narrative })),
    },
    xo_tools_classified: {
      id: 'xo_tools_classified',
      label: 'XO L3 + deterministic classification: glossary lookup reconciled with the model’s commodity class',
      input: 'narrative',
      run: async (t) =>
        goldClassified === undefined
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
              error: 'no classified bundle supplied',
            }
          : fromExecutor(await goldClassified.execute({ text: t.narrative })),
    },
    xo_router: {
      id: 'xo_router',
      label: 'XO router: structured intake solved locally, no model call',
      input: 'structured',
      run: async (t) =>
        fromExecutor(await goldRouter.execute({ text: JSON.stringify(t.statedFacts), facts: t.statedFacts as Record<string, unknown>, provenance: Object.fromEntries(Object.keys(t.statedFacts).map((k) => [k, { kind: 'form_field' as const, source: 'intake_form' }])) })),
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
    compiled_tools_grounded: {
      id: 'compiled_tools_grounded',
      label: 'COMPILED XO L3 grounded: the compiler-built decision tree as the tool, automatic evidence cues, decision commit',
      input: 'narrative',
      run: async (t) => (compiledToolsGrounded === undefined ? refused('no compiled bundle supplied') : commit(await compiledToolsGrounded.execute({ text: t.narrative }))),
    },
    compiled_tools_hinted: {
      id: 'compiled_tools_hinted',
      label: 'COMPILED XO L3 grounded + BKB evidence vocabulary: same compiled tree, cues and value patterns from the knowledge base',
      input: 'narrative',
      run: async (t) => (compiledToolsHinted === undefined ? refused('no compiled bundle or no BKB lexicon supplied') : commit(await compiledToolsHinted.execute({ text: t.narrative }))),
    },
  };
  return arms;
}
