import { createHash } from 'node:crypto';
import type { ModelProvider } from '@xo/ai-core';
import { runAgent, type ToolCallRecord } from './agent.js';
import { assembleContext } from './context.js';
import { evaluateTree, parseTrees, type DecisionTree, type TreeEvaluation } from './decision-tree.js';
import type { CapabilityLayer, SafetyDecision } from './layer.js';

/** Pulls the last top-level JSON object out of free text (models sometimes wrap answers in prose or fences). */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  let last: Record<string, unknown> | null = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j] as string;
      if (inStr) {
        if (c === '\\') j++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          const v = JSON.parse(text.slice(i, j + 1)) as unknown;
          if (typeof v === 'object' && v !== null && !Array.isArray(v)) last = v as Record<string, unknown>;
        } catch {
          /* not JSON; keep scanning */
        }
        i = j;
        break;
      }
    }
  }
  return last;
}

export type ExecutionPath = 'cache' | 'deterministic' | 'model' | 'refused';

export interface ExecuteInput {
  /** The case as free text (what a person or upstream system wrote). */
  readonly text: string;
  /** Optional structured facts for the same case (e.g. from an intake form). When complete enough, the model is never called. */
  readonly facts?: Readonly<Record<string, unknown>>;
}

export interface ExecuteResult {
  readonly path: ExecutionPath;
  readonly output: Record<string, unknown> | null;
  readonly rawText: string;
  readonly modelCalls: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly toolCalls: readonly ToolCallRecord[];
  readonly ruleTrace: readonly string[];
  readonly safety: SafetyDecision | null;
  /** The safety gate replaced the model's output with a safe override. */
  readonly overridden: boolean;
  readonly latencyMs: number;
  readonly error?: string;
}

export interface ExecutorOptions {
  readonly provider?: ModelProvider;
  readonly model?: string;
  /** Text present in every request regardless of knowledge (e.g. the output contract). */
  readonly preamble: string;
  readonly taskType?: (input: ExecuteInput) => string | undefined;
  readonly knowledgeK?: number;
  readonly exemplarK?: number;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /** Total model calls this executor may make over its lifetime. Exceeding it refuses (never silently degrades). */
  readonly maxModelCalls?: number;
  readonly maxTokensPerRequest?: number;
  /** Reuse results for identical inputs. Deterministic results are always safe to reuse; model results only when `cacheModelResults` is set (and `temperature` is 0). */
  readonly cache?: boolean;
  readonly cacheModelResults?: boolean;
  readonly cacheMaxEntries?: number;
  readonly clock?: () => number;
  /**
   * Where decision trees run. Defaults to in-process. Automated/server deployments inject a sandboxed evaluator
   * (separate process, no filesystem/network/spawn) so that evaluating package-supplied logic can never touch the host.
   */
  readonly evaluate?: (tree: DecisionTree, facts: Readonly<Record<string, unknown>>) => TreeEvaluation | Promise<TreeEvaluation>;
}

/** Recursively key-sorted JSON, so equal values always hash equally and *different* nested values never collide. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}
const hash = (v: unknown): string => createHash('sha256').update(canonicalJson(v)).digest('hex').slice(0, 32);

/**
 * Router-first execution — the "intelligence layer between any LLM and its
 * work". For every request, in order:
 *
 *   1. cache      — an identical, previously verified result is reused (0 calls)
 *   2. deterministic — if structured facts are complete enough for an executable
 *                  decision tree, run it locally (0 calls, no GPU, offline)
 *   3. model      — otherwise the model gets assembled expertise + tools, under a
 *                  hard call/token budget
 *
 * Every output, whichever path produced it, goes through the package's safety
 * gate, which fails closed. The model never gets unrestricted authority: it can
 * only propose; XO validates, computes and gates.
 */
export class XoExecutor {
  private readonly cache = new Map<string, ExecuteResult>();
  private modelCallsMade = 0;
  private readonly trees: DecisionTree[];
  private readonly now: () => number;

  constructor(
    private readonly layer: CapabilityLayer,
    private readonly opts: ExecutorOptions,
    treesJson?: unknown,
  ) {
    this.trees = treesJson !== undefined ? (parseTrees(treesJson) ?? []) : [];
    this.now = opts.clock ?? (() => performance.now());
  }

  private evalTree(tree: DecisionTree, facts: Readonly<Record<string, unknown>>): Promise<TreeEvaluation> {
    return Promise.resolve((this.opts.evaluate ?? evaluateTree)(tree, facts));
  }

  /** Routes the model's evaluate_decision_tree calls through the same (possibly sandboxed) evaluator as the deterministic path. */
  private async runTool(name: string, input: Readonly<Record<string, unknown>>): Promise<{ isError: boolean; content: string }> {
    if (name === 'evaluate_decision_tree' && this.opts.evaluate !== undefined) {
      const id = typeof input['tree_id'] === 'string' ? input['tree_id'] : this.trees.length === 1 ? this.trees[0]?.id : undefined;
      const tree = this.trees.find((t) => t.id === id);
      if (tree === undefined)
        return { isError: true, content: `unknown or missing tree_id; available: ${this.trees.map((t) => t.id).join(', ')}` };
      const facts = typeof input['facts'] === 'object' && input['facts'] !== null ? (input['facts'] as Record<string, unknown>) : {};
      const r = await this.evalTree(tree, facts);
      return r.ok
        ? { isError: false, content: JSON.stringify({ outcome: r.output, rules_applied: r.rules, trace: r.trace.map((x) => x.detail) }) }
        : { isError: true, content: JSON.stringify(r) };
    }
    return this.layer.executeTool(name, input);
  }

  get totalModelCalls(): number {
    return this.modelCallsMade;
  }

  async execute(input: ExecuteInput): Promise<ExecuteResult> {
    const t0 = this.now();
    const finish = (r: Omit<ExecuteResult, 'latencyMs'>): ExecuteResult => ({ ...r, latencyMs: this.now() - t0 });

    const key =
      this.opts.cache === true ? hash({ t: input.text, f: input.facts ?? null, r: this.layer.emitLoadReceipt().merkleRoot }) : undefined;
    if (key !== undefined) {
      const hit = this.cache.get(key);
      if (hit !== undefined) {
        this.cache.delete(key);
        this.cache.set(key, hit); // refresh LRU position
        return finish({ ...hit, path: 'cache', modelCalls: 0, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [] });
      }
    }
    const remember = (r: ExecuteResult): ExecuteResult => {
      if (key !== undefined && r.error === undefined && (r.path === 'deterministic' || this.opts.cacheModelResults === true)) {
        this.cache.set(key, r);
        const max = this.opts.cacheMaxEntries ?? 1000;
        while (this.cache.size > max) this.cache.delete(this.cache.keys().next().value as string);
      }
      return r;
    };

    // 1. deterministic path
    if (input.facts !== undefined && this.trees.length > 0) {
      for (const tree of this.trees) {
        const r = await this.evalTree(tree, input.facts);
        if (r.ok) {
          const gate = this.layer.safetyGate({ output: r.output });
          const out = gate.override !== undefined ? { ...r.output, ...gate.override } : r.output;
          return remember(
            finish({
              path: 'deterministic',
              output: out,
              rawText: JSON.stringify(out),
              modelCalls: 0,
              usage: { inputTokens: 0, outputTokens: 0 },
              toolCalls: [],
              ruleTrace: r.trace.map((s) => s.detail),
              safety: gate,
              overridden: gate.override !== undefined,
            }),
          );
        }
        // missing/invalid facts → fall through to the model path (it can read the free text)
      }
    }

    // 2. model path
    const provider = this.opts.provider;
    if (provider === undefined || this.opts.model === undefined) {
      return finish({
        path: 'refused',
        output: null,
        rawText: '',
        modelCalls: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        toolCalls: [],
        ruleTrace: [],
        safety: null,
        overridden: false,
        error: 'no deterministic route and no model configured',
      });
    }
    if (this.opts.maxModelCalls !== undefined && this.modelCallsMade >= this.opts.maxModelCalls) {
      return finish({
        path: 'refused',
        output: null,
        rawText: '',
        modelCalls: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        toolCalls: [],
        ruleTrace: [],
        safety: null,
        overridden: false,
        error: `model-call budget of ${this.opts.maxModelCalls} exhausted`,
      });
    }
    const taskType = this.opts.taskType?.(input);
    const ctx = assembleContext(this.layer, {
      query: input.text,
      ...(taskType !== undefined ? { taskType } : {}),
      ...(this.opts.knowledgeK !== undefined ? { knowledgeK: this.opts.knowledgeK } : {}),
      ...(this.opts.exemplarK !== undefined ? { exemplarK: this.opts.exemplarK } : {}),
      preamble: this.opts.preamble,
    });
    let run;
    try {
      run = await runAgent(provider, input.text, {
        model: this.opts.model,
        systemPrompt: ctx.systemPrompt,
        tools: ctx.tools,
        executeTool: (n, i) => this.runTool(n, i),
        temperature: this.opts.temperature ?? 0,
        ...(this.opts.maxOutputTokens !== undefined ? { maxOutputTokens: this.opts.maxOutputTokens } : {}),
        ...(this.opts.maxTokensPerRequest !== undefined ? { maxTotalTokens: this.opts.maxTokensPerRequest } : {}),
      });
    } catch (e) {
      this.modelCallsMade += 1;
      return finish({
        path: 'model',
        output: null,
        rawText: '',
        modelCalls: 1,
        usage: { inputTokens: 0, outputTokens: 0 },
        toolCalls: [],
        ruleTrace: [],
        safety: null,
        overridden: false,
        error: (e as Error).message,
      });
    }
    this.modelCallsMade += run.turns;
    const parsed = extractJsonObject(run.text);
    const inputGate = this.layer.safetyGate({ input: input.text });
    let output = parsed;
    let gate: SafetyDecision | null = inputGate.violations.length > 0 ? inputGate : null;
    let overridden = false;
    if (parsed !== null) {
      const og = this.layer.safetyGate({ output: parsed });
      if (og.violations.length > 0)
        gate = {
          allowed: og.allowed && inputGate.allowed,
          violations: [...inputGate.violations, ...og.violations],
          ...(og.override !== undefined ? { override: og.override } : {}),
        };
      if (og.override !== undefined) {
        output = { ...parsed, ...og.override };
        overridden = true;
      }
    }
    return remember(
      finish({
        path: 'model',
        output,
        rawText: run.text,
        modelCalls: run.turns,
        usage: run.usage,
        toolCalls: run.toolCalls,
        ruleTrace: [],
        safety: gate,
        overridden,
        ...(run.truncated
          ? { error: `model loop stopped: ${run.stoppedBy ?? 'unknown'}` }
          : parsed === null
            ? { error: 'model did not return a JSON object' }
            : {}),
      }),
    );
  }
}
