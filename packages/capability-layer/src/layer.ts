import { verifyBundle, type IntegrityOptions } from './integrity.js';
import type { ProviderToolDefinition } from '@xo/ai-core';
import { Ed25519Signer, Sha256Hasher } from '@xo/crypto';
import { componentHostProblem, selectFamilyDeclaration, type PackageBundle } from '@xo/package-sdk';
import type { ComponentKind, HostCapability, ModelFamily } from '@xo/types';
import { evaluateTree, parseTrees, type DecisionTree } from './decision-tree.js';
import { evaluateExpression, type Scope } from './expr.js';
import { collectText, KnowledgeIndex, tokenize, type GraphNode } from './retrieval.js';

export type { GraphNode } from './retrieval.js';

export interface ReasoningTrace {
  readonly id: string;
  readonly taskType: string;
  readonly text: string;
  readonly score: number;
}

export interface SafetyViolation {
  readonly ruleId: string;
  readonly action: 'block' | 'warn';
  readonly message: string;
}

export interface SafetyDecision {
  readonly allowed: boolean;
  readonly violations: readonly SafetyViolation[];
  /** Present when a blocking rule supplies a safe replacement output (fail closed, e.g. force escalation). */
  readonly override?: Readonly<Record<string, unknown>>;
}

export type CompatibilityLevel = 'L0' | 'L1' | 'L2' | 'L3';

export interface LoadReceipt {
  readonly xoName: string;
  readonly xoVersion: string;
  readonly merkleRoot: string;
  readonly hostFamily: ModelFamily;
  readonly level: CompatibilityLevel;
  readonly consumed: readonly ComponentKind[];
  readonly skipped: readonly { readonly kind: ComponentKind; readonly reason: string }[];
  readonly executableSafetyRules: number;
  readonly executableDecisionTrees: number;
  readonly loadedAt: string;
  /** base64 Ed25519 signature over the canonical receipt body, or null if no signing key was supplied. */
  readonly signature: string | null;
}

export interface ToolResult {
  readonly isError: boolean;
  readonly content: string;
}

/** SPECIFICATION.md §2.3, made concrete. `weightsPatch` is always null in this build (no L4). */
export interface CapabilityLayer {
  systemPromptFragments(): string[];
  /** Empty when the host lacks `tool_use`: such a host is served context-only (see `assembleContext`), never handed tools it cannot call. */
  toolDefinitions(): ProviderToolDefinition[];
  executeTool(name: string, input: Readonly<Record<string, unknown>>): ToolResult;
  retrieve(query: string, k: number): GraphNode[];
  exemplars(taskType: string | undefined, k: number, query?: string): ReasoningTrace[];
  weightsPatch(): null;
  safetyGate(ctx: { readonly input?: string; readonly output?: Readonly<Record<string, unknown>> }): SafetyDecision;
  emitLoadReceipt(): LoadReceipt;
  /** True when tool calls must carry evidence for each fact (see grounding.ts); enforced by XoExecutor, which knows the case text. */
  readonly requiresEvidence: boolean;
  /** The decision trees this layer exposes as tools (empty when the host lacks tool use). */
  decisionTrees(): readonly DecisionTree[];
  /**
   * The integrity-verified bytes of a component this layer consumed (undefined when absent or skipped). This is how a
   * workflow runner obtains `workflows/workflows.json` without re-implementing bundle verification.
   */
  componentBytes(kind: ComponentKind): Uint8Array | undefined;
}

export interface LayerOptions {
  readonly host: { readonly family: ModelFamily; readonly capabilities: readonly HostCapability[] };
  readonly signing?: { readonly privateKeyPem: string };
  readonly now?: () => Date;
  /** See {@link IntegrityOptions}. Default `enforce`: a tampered or unsealed package is refused before anything is read from it. */
  readonly integrity?: IntegrityOptions['integrity'];
  /** Operator trust policy; when set, the package must verify against it (signatures, publisher, roles). */
  readonly trust?: IntegrityOptions['trust'];
  /** Require a verbatim evidence quote for every fact passed to a decision tree. Off by default (existing behaviour). */
  readonly requireEvidence?: boolean;
}

interface PromptStrategies {
  persona?: string;
  fragments?: { id?: string; text: string; requires?: HostCapability }[];
}

interface SafetyRule {
  id: string;
  description?: string;
  applies_to: 'input' | 'output';
  when: string;
  action: 'block' | 'warn';
  message?: string;
  override_output?: Record<string, unknown>;
}

function component(bundle: PackageBundle, kind: ComponentKind): Uint8Array | undefined {
  return bundle.components.find((c) => c.kind === kind)?.data;
}

function json(bytes: Uint8Array | undefined): unknown {
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

function jsonl(bytes: Uint8Array | undefined): unknown[] {
  if (bytes === undefined) return [];
  const out: unknown[] = [];
  for (const line of new TextDecoder().decode(bytes).split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a malformed line is skipped, not fatal — traces are exemplars, not load-bearing */
    }
  }
  return out;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/**
 * Negotiates which components this host can consume (SPECIFICATION.md §2.1
 * steps 3–5), then exposes them through the §2.3 interface. Unsupported
 * components are *skipped and recorded* in the load receipt, never errored.
 */
export function createCapabilityLayer(bundle: PackageBundle, options: LayerOptions): CapabilityLayer {
  verifyBundle(bundle, {
    ...(options.integrity !== undefined ? { integrity: options.integrity } : {}),
    ...(options.trust !== undefined ? { trust: options.trust } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const manifest = bundle.manifest;
  // The same selection the loader/resolve API uses: the host's own family if it has what that family needs, else the manifest's `generic` family
  // if it has what THAT needs, else nothing. Safety rules are local and need no model capability, so they are consumed whatever the family.
  const selection = selectFamilyDeclaration(manifest, options.host);
  const declaredConsumes = new Set<ComponentKind>(selection.declaration?.consumes ?? []);
  declaredConsumes.add('safety_rules');
  const hostHas = (c: HostCapability): boolean => options.host.capabilities.includes(c);

  const consumed: ComponentKind[] = [];
  const skipped: { kind: ComponentKind; reason: string }[] = [];
  const present = bundle.components.map((c) => c.kind);
  const decide = (kind: ComponentKind): boolean => {
    if (!present.includes(kind)) return false;
    if (!declaredConsumes.has(kind)) {
      skipped.push({
        kind,
        reason:
          selection.declaration === undefined
            ? `${selection.degradedBecause ?? 'no family declaration fits this host'}, so only the safety rules are used`
            : selection.degradedBecause !== undefined
              ? `served from family "${selection.usedFamily}" (${selection.degradedBecause}), which does not list it`
              : `manifest does not list it as consumable by family "${options.host.family}"`,
      });
      return false;
    }
    const problem = componentHostProblem(kind, options.host);
    if (problem !== undefined) {
      skipped.push({ kind, reason: problem });
      return false;
    }
    consumed.push(kind);
    return true;
  };

  const useKnowledge = decide('knowledge_graph');
  const useTraces = decide('reasoning_traces');
  const useTrees = decide('decision_trees');
  const useStrategies = decide('prompt_strategies');
  const useSafety = decide('safety_rules');
  // Workflows are data a workflow runner executes (docs/WORKFLOW_IR.md); the layer only verifies and hands over the bytes.
  const useWorkflows = decide('workflows');
  // lora / finetune: never consumed in this build (L4 not implemented)
  for (const k of ['lora', 'finetune'] as const)
    if (present.includes(k)) skipped.push({ kind: k, reason: 'weight-level adaptation (L4) is not implemented by this host binding' });
  // The benchmark suite ships in the package (required component) but is deliberately never exposed to the model.

  const kg = useKnowledge
    ? (json(component(bundle, 'knowledge_graph')) as { nodes?: unknown[]; edges?: unknown[] } | undefined)
    : undefined;
  const safetyJson0 = (useSafety ? json(component(bundle, 'safety_rules')) : undefined) as
    { rules?: unknown[]; nodes?: unknown[] } | undefined;
  // Compiler output files normative statements ("must be filed within 9 days") under safety_rules as constraint
  // *nodes*. They are not executable rules, but they are exactly the knowledge a model needs, so they are indexed
  // as retrievable 'constraint' knowledge rather than silently ignored.
  const constraintNodes = (Array.isArray(safetyJson0?.nodes) ? safetyJson0.nodes : []).map((n) => ({
    ...(n as object),
    kind: 'constraint',
  }));
  const index = new KnowledgeIndex([...(kg?.nodes ?? []), ...constraintNodes], kg?.edges ?? []);
  const traces = useTraces ? jsonl(component(bundle, 'reasoning_traces')) : [];
  const traceDocs = traces.map((t, i) => {
    const o = (typeof t === 'object' && t !== null ? t : {}) as { id?: unknown; task_type?: unknown };
    return {
      id: typeof o.id === 'string' ? o.id : `trace_${i}`,
      taskType: typeof o.task_type === 'string' ? o.task_type : 'unspecified',
      text: renderTrace(t),
    };
  });
  const trees: DecisionTree[] = useTrees ? (parseTrees(json(component(bundle, 'decision_trees'))) ?? []) : [];
  if (useTrees && trees.length === 0) {
    const i = consumed.indexOf('decision_trees');
    if (i >= 0) consumed.splice(i, 1);
    skipped.push({
      kind: 'decision_trees',
      reason: 'component is present but not in the executable tree format (no callable tool can be built from it)',
    });
  }
  const strategies = (useStrategies ? json(component(bundle, 'prompt_strategies')) : undefined) as PromptStrategies | undefined;
  const safetyJson = (useSafety ? json(component(bundle, 'safety_rules')) : undefined) as { rules?: SafetyRule[] } | undefined;
  const safetyRules: SafetyRule[] = Array.isArray(safetyJson?.rules) ? (safetyJson?.rules as SafetyRule[]) : [];

  const level: CompatibilityLevel = trees.length > 0 || useWorkflows ? 'L3' : traceDocs.length > 0 ? 'L2' : index.size > 0 ? 'L1' : 'L0';
  const loadedAt = (options.now ?? (() => new Date()))().toISOString();

  return {
    systemPromptFragments(): string[] {
      const out: string[] = [];
      if (strategies?.persona) out.push(strategies.persona);
      for (const f of strategies?.fragments ?? []) {
        if (f.requires !== undefined && !hostHas(f.requires)) continue;
        if (f.requires === 'tool_use' && trees.length === 0) continue;
        out.push(f.text);
      }
      return out;
    },

    toolDefinitions(): ProviderToolDefinition[] {
      // A host that cannot call tools is offered none (passing tools to such a model is an API error at best). It still gets the context-only level:
      // `assembleContext` puts retrieved knowledge and exemplars into the prompt, and `safetyGate` still applies.
      if (!hostHas('tool_use')) return [];
      const defs: ProviderToolDefinition[] = [];
      if (trees.length > 0) {
        const catalog = trees
          .map(
            (t) =>
              `- ${t.id}: ${t.description}\n  inputs:\n${t.inputs.map((i) => `    * ${i.name} (${i.type}${i.enum ? `: ${i.enum.join('|')}` : ''}) — ${i.description}`).join('\n')}`,
          )
          .join('\n');
        defs.push({
          name: 'evaluate_decision_tree',
          description: `Run one of this expert package's decision trees deterministically over facts you extracted from the case. Returns the outcome, the rules applied and a step trace. If a needed fact is missing it tells you which; supply only facts the case actually states.${options.requireEvidence === true ? ` You MUST also pass \`evidence\`: for EVERY fact you supply (except fixed-label classifications such as an enum), an object {quote} where quote is exact words copied from the case text that state it (an array of separate excerpts is fine). Computed quantities (${trees.flatMap((t) => t.inputs.filter((i) => i.derivable === true).map((i) => i.name)).join(', ') || 'none'}) may add derived: true and must quote the figures they were computed from (e.g. both dates). Any other fact without an exact quote is rejected. If the case text does not state a fact the tree needs, do NOT guess a value: leave it out, say it is missing and escalate.` : ''}}\nAvailable trees:\n${catalog}`,
          inputSchema: {
            type: 'object',
            properties: {
              tree_id: { type: 'string', enum: trees.map((t) => t.id) },
              facts: { type: 'object', description: 'fact name → value, using exactly the input names listed for the tree' },
              ...(options.requireEvidence === true
                ? {
                    evidence: {
                      type: 'object',
                      description: 'fact name → {quote: verbatim excerpt(s) of the case, derived?: true if computed from the quote}',
                    },
                  }
                : {}),
            },
            required: ['facts'],
          },
        });
      }
      if (index.size > 0) {
        defs.push({
          name: 'lookup_knowledge',
          description: "Search this expert package's knowledge base for rules, definitions and procedures relevant to a question.",
          inputSchema: { type: 'object', properties: { query: { type: 'string' }, k: { type: 'number' } }, required: ['query'] },
        });
      }
      return defs;
    },

    executeTool(name, input): ToolResult {
      if (name === 'evaluate_decision_tree') {
        const treeId = typeof input['tree_id'] === 'string' ? input['tree_id'] : trees.length === 1 ? trees[0]?.id : undefined;
        const tree = trees.find((t) => t.id === treeId);
        if (tree === undefined)
          return { isError: true, content: `unknown or missing tree_id; available: ${trees.map((t) => t.id).join(', ')}` };
        const facts = typeof input['facts'] === 'object' && input['facts'] !== null ? (input['facts'] as Record<string, unknown>) : {};
        const r = evaluateTree(tree, facts);
        if (r.ok)
          return {
            isError: false,
            content: JSON.stringify({ outcome: r.output, rules_applied: r.rules, trace: r.trace.map((s) => s.detail) }),
          };
        return { isError: true, content: JSON.stringify(r) };
      }
      if (name === 'lookup_knowledge') {
        const q = typeof input['query'] === 'string' ? input['query'] : '';
        const k = typeof input['k'] === 'number' ? Math.min(10, Math.max(1, Math.floor(input['k']))) : 4;
        return { isError: false, content: JSON.stringify(index.search(q, k).map((n) => ({ id: n.id, text: n.text }))) };
      }
      return { isError: true, content: `unknown tool "${name}"` };
    },

    retrieve: (query, k) => index.search(query, k),

    exemplars(taskType, k, query): ReasoningTrace[] {
      const pool = taskType === undefined ? traceDocs : traceDocs.filter((d) => d.taskType === taskType);
      const effective = pool.length > 0 ? pool : traceDocs;
      if (query === undefined) return effective.slice(0, k).map((d) => ({ ...d, score: 0 }));
      const qTok = new Set(tokenize(query));
      return effective
        .map((d) => ({ ...d, score: tokenize(d.text).filter((t) => qTok.has(t)).length / Math.sqrt(tokenize(d.text).length || 1) }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, k);
    },

    weightsPatch: () => null,

    safetyGate(ctx): SafetyDecision {
      const violations: SafetyViolation[] = [];
      let override: Record<string, unknown> | undefined;
      for (const rule of safetyRules) {
        let scope: Scope;
        if (rule.applies_to === 'input') {
          if (ctx.input === undefined) continue;
          scope = { input_text: ctx.input };
        } else {
          if (ctx.output === undefined) continue;
          scope = ctx.output as Scope;
        }
        let hit = false;
        try {
          hit = Boolean(evaluateExpression(rule.when, scope));
        } catch {
          // A rule that cannot be evaluated on this output (missing field) is treated as not triggered for
          // 'warn' and as triggered for 'block': safety fails closed.
          hit = rule.action === 'block';
        }
        if (!hit) continue;
        violations.push({ ruleId: rule.id, action: rule.action, message: rule.message ?? rule.description ?? rule.id });
        if (rule.action === 'block' && override === undefined && rule.override_output !== undefined) override = rule.override_output;
      }
      return { allowed: !violations.some((v) => v.action === 'block'), violations, ...(override !== undefined ? { override } : {}) };
    },

    requiresEvidence: options.requireEvidence === true,
    decisionTrees: () => trees,
    componentBytes: (kind) => (consumed.includes(kind) ? component(bundle, kind) : undefined),

    emitLoadReceipt(): LoadReceipt {
      const body = {
        xoName: manifest.name,
        xoVersion: manifest.version,
        merkleRoot: String(manifest.merkleRoot ?? ''),
        hostFamily: options.host.family,
        level,
        consumed,
        skipped,
        executableSafetyRules: safetyRules.length,
        executableDecisionTrees: trees.length,
        loadedAt,
      };
      const signature =
        options.signing !== undefined
          ? new Ed25519Signer().sign(new Sha256Hasher().hash(canonical(body)), options.signing.privateKeyPem)
          : null;
      return { ...body, signature };
    },
  };
}

function renderTrace(t: unknown): string {
  if (typeof t !== 'object' || t === null) return collectText(t);
  const o = t as { scenario?: unknown; steps?: unknown; conclusion?: unknown };
  if (typeof o.scenario === 'string' && Array.isArray(o.steps)) {
    const steps = (o.steps as unknown[]).map((s, i) => `  ${i + 1}. ${collectText(s)}`).join('\n');
    return `Case: ${o.scenario}\nReasoning:\n${steps}\nOutcome: ${collectText(o.conclusion)}`;
  }
  return collectText(t);
}
