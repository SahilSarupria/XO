import type { DecisionTree } from '@xo/capability-layer';
import {
  DETERMINISTIC_HOST,
  WORKFLOW_COMPONENT_PATH,
  determinismReport,
  looksLikeSecret,
  negotiateWorkflows,
  usedFeatures,
  validateAgainstBundle,
  validateWorkflowComponent,
  type ConnectorDecl,
  type Determinism,
  type FieldSpec,
  type Step,
  type StepDeterminism,
  type WorkflowComponent,
  type WorkflowDef,
} from '@xo/workflow-ir';
import type { PolicyArtifacts } from './artifacts.js';
import { identifiersIn, type Step as PolicyStep, type StepSource } from './program.js';
import { policyCapabilityName } from './to-graph.js';

/**
 * Emits the `workflows` package component from the policy-synthesis output (EXPERIENCE_COMPILER.md §9.1 lowering).
 *
 * Nothing here reads the document again: the workflow is a lowering of the SAME program, tree and review data the
 * decision-tree component comes from, so the two cannot drift. What the policy states is carried over; what it does
 * not state is never invented:
 *   - the decision is the compiled tree (deterministic, no model);
 *   - reading free text into facts is the only model-assisted step, and structured input bypasses it;
 *   - a clause the compiler did not understand has no step: every path that reaches it ends in the tree's
 *     `UNFORMALIZED_RULE` escalation leaf, and the report lists the sentence as a review item;
 *   - the policy describes no external systems, so the only action emitted records the decision through a file
 *     connector the operator binds. Other actions (tickets, email, payments) are NOT inferred.
 *
 * Every number in the report is a count of declared step classes or of recognized sentences. None is a measurement of
 * accuracy, real-traffic coverage, cost or savings.
 */

export const DECLARED_NOT_MEASURED = 'declared, not measured' as const;

export type NonDeterministicCause = 'free_text_input' | 'documented_escalation' | 'unrecognized_rule' | 'judgement_call';

export interface NonDeterministicFinding {
  readonly workflow: string;
  readonly step: string;
  readonly class: Exclude<Determinism, 'deterministic'>;
  readonly cause: NonDeterministicCause;
  readonly reason: string;
  /** exact source sentences (prefixed with the rule tag or section), clipped to the schema's limits */
  readonly provenance: readonly string[];
  /** true when paths that depend on it fail closed (escalate) until a reviewer resolves it */
  readonly blocking: boolean;
}

export interface ReviewFinding {
  readonly sentence: string;
  readonly rule: string;
  readonly section: string;
  readonly kind: 'unrecognized_rule' | 'judgement_call';
  readonly reason: string;
  readonly effect: string;
}

export interface WorkflowDeterminismEntry {
  readonly workflow: string;
  /** `structured`: facts arrive as typed inputs. `text`: a free-text narrative is read into facts by a model. */
  readonly path: 'structured' | 'text';
  readonly label: typeof DECLARED_NOT_MEASURED;
  readonly counts: Readonly<Record<Determinism, number>>;
  /** deterministic steps / all steps, as declared */
  readonly ratio: number;
  /** from the same negotiation a runtime performs: false means it runs on a host with no model */
  readonly needsModel: boolean;
  readonly steps: readonly StepDeterminism[];
  readonly nonDeterministic: readonly NonDeterministicFinding[];
}

export interface CapabilityDeterminismEntry {
  readonly capability: string;
  readonly treeId: string;
  readonly label: typeof DECLARED_NOT_MEASURED;
  /** normative sentences the extractor saw in rule sections */
  readonly decisionSentences: number;
  readonly recognizedSentences: number;
  readonly unrecognizedSentences: number;
  /** recognizedSentences / decisionSentences; undefined when the document has no decision sentences */
  readonly ruleCoverage?: number;
  /** the workflows that invoke this capability, with their declared step classes */
  readonly workflows: readonly {
    readonly workflow: string;
    readonly path: 'structured' | 'text';
    readonly counts: Readonly<Record<Determinism, number>>;
    readonly ratio: number;
    readonly needsModel: boolean;
  }[];
  /** decisions the compiled tree can reach */
  readonly outcomes: readonly string[];
  readonly failClosedPaths: readonly string[];
  /** rules whose approving outcome is recognized but held (cases escalate instead) while review items are open */
  readonly approvalsHeld: readonly string[];
}

export interface WorkflowCompileReport {
  readonly label: typeof DECLARED_NOT_MEASURED;
  readonly workflows: readonly WorkflowDeterminismEntry[];
  readonly capabilities: readonly CapabilityDeterminismEntry[];
  readonly reviewItems: readonly ReviewFinding[];
  /** what this emission does not do, stated so a reader does not assume it */
  readonly limits: readonly string[];
}

export interface WorkflowEmission {
  readonly component: WorkflowComponent;
  readonly report: WorkflowCompileReport;
}

export type WorkflowEmitResult =
  | { readonly emission: WorkflowEmission; readonly problems: readonly [] }
  | { readonly emission?: undefined; readonly problems: readonly string[] };

export interface WorkflowEmitOptions {
  /** workflow version (semver); defaults to 1.0.0 */
  readonly version?: string;
  /**
   * Where non-escalated decisions go. The policy document does not name any external system, so this is the operator's
   * choice at compile time, never inferred:
   *   - `file` (default): record the decision through a `file` connector the operator binds to a directory;
   *   - `none`: emit no action at all. The decision is the run's result; the host application or API client reads it
   *     and does whatever it needs. Nothing needs binding or creating, and no connector is declared.
   * Slack, webhook, database and other sinks arrive with the connectors that implement them (not yet built).
   */
  readonly decisionSink?: 'file' | 'none';
}

const MAX_PROVENANCE = 64;
const MAX_PROVENANCE_CHARS = 300;
const HUMAN_TARGET = 'Human Review';
const RECORD_CONNECTOR = 'decision_records';
const RECORD_ROOT = 'records';
const FACT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SAFE_DECISION = /^[A-Za-z0-9_ -]{1,64}$/;

/**
 * Language that grants a person discretion. A keyword heuristic: it surfaces sentences a reviewer should look at, it
 * does not decide anything, and a hit is labelled as such in the report.
 */
const JUDGEMENT =
  /\b(discretion|judg(?:e)?ment|case[- ]by[- ]case|deems?|reasonable|appropriate|at (?:its|their|the [a-z]+'s) (?:option|choice)|may (?:use|exercise|choose|decide|elect|offer|waive|grant|consider)|where (?:necessary|appropriate)|circumstances|seems?)\b/i;

const WITHHELD = '(source sentence withheld: it looks like a credential)';
/** Quoted policy text is scrubbed with the validator's own secret test before it can reach the component OR the report. */
const safe = (s: string): string => (looksLikeSecret(s) ? WITHHELD : s);
const clip = (s: string): string => safe(s.length <= MAX_PROVENANCE_CHARS ? s : `${s.slice(0, MAX_PROVENANCE_CHARS - 1)}…`);
const cite = (src: StepSource): string => clip(`${src.rule !== '' ? src.rule : src.section}: ${src.sentence}`);

function capProvenance(items: readonly string[]): string[] {
  const unique = [...new Set(items)];
  if (unique.length <= MAX_PROVENANCE) return unique;
  return [...unique.slice(0, MAX_PROVENANCE - 1), `(+${unique.length - (MAX_PROVENANCE - 1)} more source sentences omitted)`];
}

const slugId = (s: string, fallback: string, max = 56): string => {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
    .replace(/_+$/g, '');
  return /^[a-z]/.test(slug) ? slug : slug === '' ? fallback : `${fallback}_${slug}`.slice(0, 64);
};

const factSpec = (i: DecisionTree['inputs'][number]): FieldSpec => ({
  type: i.enum !== undefined ? 'enum' : i.type,
  ...(i.enum !== undefined ? { enum: i.enum } : {}),
  description: i.description,
  nullable: true,
});

function leafDecisions(tree: DecisionTree): string[] {
  const out = new Set<string>();
  for (const n of Object.values(tree.nodes))
    if (n.type === 'leaf' && typeof n.output['decision'] === 'string') out.add(n.output['decision']);
  return [...out];
}

const hasNullTarget = (tree: DecisionTree): boolean =>
  Object.values(tree.nodes).some(
    (n) =>
      n.type === 'leaf' &&
      n.output['decision'] === 'escalate' &&
      (n.output['escalation_target'] === null || n.output['escalation_target'] === undefined),
  );

/** Emits the workflow component and its determinism report, or explains (never throws) why it could not. */
export function emitPolicyWorkflows(policy: PolicyArtifacts, options: WorkflowEmitOptions = {}): WorkflowEmitResult {
  try {
    return emit(policy, options);
  } catch (e) {
    return { problems: [`workflow emission failed: ${(e as Error).message}`] };
  }
}

function emit(policy: PolicyArtifacts, options: WorkflowEmitOptions): WorkflowEmitResult {
  const tree = policy.trees?.[0];
  if (tree === undefined) return { problems: ['no executable decision tree was synthesized, so there is nothing to build a workflow on'] };
  const problems: string[] = [];
  for (const i of tree.inputs)
    if (i.name === 'case_id') problems.push('a fact named "case_id" collides with the workflow\'s case identifier input');
  for (const i of tree.inputs) if (!FACT_NAME.test(i.name)) problems.push(`fact name "${i.name}" is not a valid workflow field name`);
  const decisions = leafDecisions(tree);
  for (const d of decisions) if (!SAFE_DECISION.test(d)) problems.push(`decision value "${d}" cannot be used in a workflow expression`);
  if (problems.length > 0) return { problems };

  const program = policy.program;
  const baseId = slugId(program.title, 'policy_workflow', 44);
  const version = options.version !== undefined && /^\d+\.\d+\.\d+$/.test(options.version) ? options.version : '1.0.0';

  // ── provenance: which source sentences each fact and each outcome came from ─────────────────────────────────
  const inTree = (s: PolicyStep): boolean => tree.nodes[s.id] !== undefined;
  const liveSteps = program.steps.filter(inTree);
  const readsOf = (s: PolicyStep): string[] =>
    s.kind === 'gate'
      ? identifiersIn(s.when)
      : s.kind === 'assign'
        ? Object.values(s.set).flatMap(identifiersIn)
        : [
            ...(s.when !== undefined ? identifiersIn(s.when) : []),
            ...(s.amount !== undefined ? identifiersIn(s.amount.replace(/^=/, '')) : []),
          ];
  const factReaders = new Map<string, string[]>();
  for (const s of liveSteps) for (const r of readsOf(s)) factReaders.set(r, [...(factReaders.get(r) ?? []), cite(s.source)]);
  const factProvenance = tree.inputs.flatMap((i) => factReaders.get(i.name) ?? []);
  const treeProvenance = liveSteps.map((s) => cite(s.source));
  const escalationSteps = liveSteps.filter((s) => (s.kind === 'gate' || s.kind === 'finish') && s.outcome.decision === 'escalate');

  // ── steps ─────────────────────────────────────────────────────────────────────────────────────────────────
  const nonEscalate = decisions.filter((d) => d !== 'escalate');
  const routes = new Map<string, string>();
  for (const d of nonEscalate) {
    let id = slugId(d, 'route');
    while ([...routes.values()].includes(id) || id === 'escalate') id = `${id}_x`.slice(0, 64);
    routes.set(d, id);
  }
  const sink = options.decisionSink ?? 'file';
  const hasRoute = nonEscalate.length > 0 && sink === 'file';
  const amountField = program.amountField;
  const nullTarget = hasNullTarget(tree);

  const structuredId = `${baseId}_structured`;
  const textId = `${baseId}_from_text`;
  const connectors: ConnectorDecl[] = hasRoute
    ? [{ id: RECORD_CONNECTOR, kind: 'file', operations: [{ name: 'write_record', sideEffect: 'write' }] }]
    : [];
  const build = (variant: 'structured' | 'text'): WorkflowDef => {
    const steps: Step[] = [];
    if (variant === 'text')
      steps.push({
        id: 'extract_facts',
        type: 'extract',
        determinism: 'model_assisted',
        description: 'Structured intake bypasses the model; a bare narrative is read once into facts that must be quoted from the text.',
        instruction:
          'Extract the case facts exactly as stated in the narrative. Leave a fact null when the narrative does not state it. Quote the sentence each fact comes from.',
        requires: ['structured_output'],
        structuredFirst: true,
        grounding: 'quote_required',
        maxModelCalls: 1,
        inputs: { text: { from: 'input.narrative', optional: true }, structured: { from: 'input.facts', optional: true } },
        outputs: Object.fromEntries(tree.inputs.map((i) => [i.name, factSpec(i)])),
        timeoutMs: 60_000,
        retry: { maxAttempts: 2, backoff: { kind: 'exponential', baseMs: 500, maxMs: 5_000, jitter: 'full' } },
        onError: 'escalate',
        provenance: capProvenance(factProvenance),
      });
    steps.push({
      id: 'decide_case',
      type: 'decide',
      determinism: 'deterministic',
      ...(variant === 'text' ? { needs: ['extract_facts'] } : {}),
      method: { kind: 'tree', treeId: tree.id },
      // structured intake: a fact the caller did not supply is simply absent, and the tree escalates on it (fails closed)
      inputs: Object.fromEntries(
        tree.inputs.map((i) => [
          i.name,
          variant === 'text' ? { from: `steps.extract_facts.${i.name}`, optional: false } : { from: `input.${i.name}`, optional: true },
        ]),
      ),
      outputs: {
        decision: { type: 'enum', enum: [...new Set([...decisions, 'escalate'])] },
        ...(amountField !== undefined ? { [amountField]: { type: 'number' as const } } : {}),
        escalation_target: { type: 'string', nullable: true },
        reason_code: { type: 'string' },
      },
      timeoutMs: 5_000,
      onError: 'escalate',
      provenance: capProvenance(treeProvenance),
    });

    if (hasRoute) {
      const routeEnum = [...routes.values(), 'escalate'];
      steps.push({
        id: 'route',
        type: 'branch',
        determinism: 'deterministic',
        needs: ['decide_case'],
        inputs: { decision: { from: 'steps.decide_case.decision' } },
        cases: nonEscalate.map((d) => ({ route: routes.get(d)!, when: `decision == '${d}'` })),
        default: 'escalate',
        outputs: { route: { type: 'enum', enum: routeEnum } },
        timeoutMs: 1_000,
      });
      steps.push({
        id: 'record_fields',
        type: 'decide',
        determinism: 'deterministic',
        needs: ['route'],
        method: {
          kind: 'formula',
          set: {
            path: "'decisions/' + route + '/' + case_id + '.json'",
            // fields the policy computed come first; the caller-supplied case_id is LAST so that text in it can never
            // pose as an earlier field (a reader that takes the first occurrence of a key cannot be fooled)
            content:
              "'decision=' + decision + ';reason_code=' + reason_code" +
              (amountField !== undefined ? " + ';amount=' + amount" : '') +
              " + ';case_id=' + case_id",
          },
        },
        inputs: {
          case_id: { from: 'input.case_id' },
          route: { from: 'steps.route.route' },
          decision: { from: 'steps.decide_case.decision' },
          reason_code: { from: 'steps.decide_case.reason_code' },
          ...(amountField !== undefined ? { amount: { from: `steps.decide_case.${amountField}` } } : {}),
        },
        outputs: { path: { type: 'string' }, content: { type: 'string' } },
        timeoutMs: 1_000,
      });
      steps.push({
        id: 'record_decision',
        type: 'act',
        determinism: 'deterministic',
        needs: ['record_fields'],
        runIf: "route != 'escalate'",
        inputs: {
          route: { from: 'steps.route.route' },
          root: { const: RECORD_ROOT },
          path: { from: 'steps.record_fields.path' },
          content: { from: 'steps.record_fields.content' },
        },
        timeoutMs: 10_000,
        retry: { maxAttempts: 3, backoff: { kind: 'exponential', baseMs: 200, maxMs: 5_000, jitter: 'full' } },
        connector: RECORD_CONNECTOR,
        operation: 'write_record',
        sideEffect: 'write',
        idempotencyKey: 'decision:{{input.case_id}}',
        onError: 'escalate',
      });
    }
    if (nullTarget) {
      steps.push({
        id: 'handoff',
        type: 'decide',
        determinism: 'deterministic',
        needs: ['decide_case'],
        method: { kind: 'formula', set: { target: `escalation_target != null ? escalation_target : '${HUMAN_TARGET}'` } },
        inputs: { escalation_target: { from: 'steps.decide_case.escalation_target', optional: false } },
        outputs: { target: { type: 'string' } },
        timeoutMs: 1_000,
      });
    }
    const escalateNeeds = [...(hasRoute ? ['route'] : ['decide_case']), ...(nullTarget ? ['handoff'] : [])];
    steps.push({
      id: 'escalate_to_human',
      type: 'escalate',
      determinism: 'human',
      needs: escalateNeeds,
      ...(hasRoute ? { runIf: "route == 'escalate'" } : { runIf: "decision == 'escalate'" }),
      inputs: {
        ...(hasRoute ? { route: { from: 'steps.route.route' } } : { decision: { from: 'steps.decide_case.decision' } }),
        ...(nullTarget ? {} : { escalation_target: { from: 'steps.decide_case.escalation_target', optional: false } }),
        reason_code: { from: 'steps.decide_case.reason_code' },
      },
      target: nullTarget ? '{{steps.handoff.target}}' : '{{steps.decide_case.escalation_target}}',
      reason: 'Case {{input.case_id}} needs a person ({{steps.decide_case.reason_code}}).',
      lane: 'escalations',
      timeoutMs: 10_000,
      provenance: capProvenance(escalationSteps.map((s) => cite(s.source))),
    });

    const wfBase: Omit<WorkflowDef, 'requiresFeatures'> = {
      id: variant === 'text' ? textId : structuredId,
      version,
      description: `Compiled from the policy "${program.title.replace(/["\r\n]+/g, ' ').slice(0, 120)}". ${variant === 'structured' ? 'Facts arrive as typed inputs; no model is involved.' : 'A free-text narrative is read into facts by a model, each quoted from the text.'} Decisions come from the compiled decision tree; anything the rules cannot decide goes to a person.`,
      triggers: [{ id: 'case_api', kind: 'api' }],
      inputs:
        variant === 'text'
          ? {
              case_id: { type: 'string', required: true },
              narrative: { type: 'string', maxBytes: 65_536 },
              facts: { type: 'json', maxBytes: 16_384 },
            }
          : { case_id: { type: 'string', required: true }, ...Object.fromEntries(tree.inputs.map((i) => [i.name, factSpec(i)])) },
      steps,
      result: {
        decision: { from: 'steps.decide_case.decision' },
        ...(hasRoute ? { route: { from: 'steps.route.route' } } : {}),
        ...(amountField !== undefined ? { [amountField]: { from: `steps.decide_case.${amountField}` } } : {}),
      },
      maxConcurrency: 4,
      runTimeoutMs: 300_000,
      cancellation: { onCancel: 'abandon' },
    };
    const wf: WorkflowDef = { ...wfBase, requiresFeatures: usedFeatures(wfBase as WorkflowDef) };
    return wf;
  };
  const structuredWf = build('structured');
  const textWf = build('text');
  let component: WorkflowComponent = { formatVersion: '1.0', semanticsVersion: '1.0', connectors, workflows: [structuredWf, textWf] };

  // ── validate exactly as a host will; a credential-lookalike in a quoted sentence is redacted, once, not hidden ──
  const validate = (c: WorkflowComponent) => {
    const structural = validateWorkflowComponent(JSON.parse(JSON.stringify(c)));
    if (!structural.valid) return structural;
    const bundle = validateAgainstBundle(c, { decisionTrees: { trees: policy.trees } });
    return { valid: bundle.valid, issues: [...structural.issues, ...bundle.issues] };
  };
  let v = validate(component);
  if (!v.valid) {
    const secretPaths = v.issues.filter((i) => i.code === 'SECRET_IN_DOCUMENT' && /\.provenance\[\d+\]$/.test(i.path));
    if (secretPaths.length > 0) {
      const copy = JSON.parse(JSON.stringify(component)) as { workflows: { steps: { provenance?: string[] }[] }[] };
      for (const i of secretPaths) {
        const m = /\.workflows\[(\d+)\]\.steps\[(\d+)\]\.provenance\[(\d+)\]$/.exec(i.path);
        const prov = m === null ? undefined : copy.workflows[Number(m[1])]?.steps[Number(m[2])]?.provenance;
        if (prov !== undefined && m !== null) prov[Number(m[3])] = WITHHELD;
      }
      component = copy as unknown as WorkflowComponent;
      v = validate(component);
    }
  }
  if (!v.valid)
    return {
      problems: v.issues
        .filter((i) => i.severity === 'error')
        .map((i) => `${i.code} at ${i.path}: ${i.message}`)
        .slice(0, 20),
    };

  // ── the report ────────────────────────────────────────────────────────────────────────────────────────────
  const claimed = new Set(program.steps.map((st) => st.source.sentence));
  const reviewItems: ReviewFinding[] = [];
  /** items whose paths fail closed (the unrecognized clauses); tracked by identity because their text may be scrubbed */
  const blockingItems = new Set<ReviewFinding>();
  for (const u of policy.review.unrecognized) {
    const judgement = JUDGEMENT.test(u.sentence);
    const item: ReviewFinding = {
      sentence: safe(u.sentence),
      rule: safe(u.rule),
      section: safe(u.section),
      kind: judgement ? 'judgement_call' : 'unrecognized_rule',
      reason: judgement
        ? 'the sentence reads like a judgement call (keyword heuristic; a reviewer should confirm) and the extractor found no deterministic form for it'
        : 'the extractor did not recognize this sentence as a rule it can compile',
      effect: `cases whose decision depends on this clause end in the "UNFORMALIZED_RULE" escalation instead of an automatic decision`,
    };
    reviewItems.push(item);
    blockingItems.add(item);
    claimed.add(u.sentence);
  }
  for (const e of policy.entries)
    for (const sentence of e.sentences)
      if (!claimed.has(sentence) && JUDGEMENT.test(sentence) && /\b(must|may|shall|can|should|discretion|judg|deems?)\b/i.test(sentence))
        reviewItems.push({
          sentence: safe(sentence),
          rule: safe(e.title),
          section: safe(e.section),
          kind: 'judgement_call',
          reason:
            'grants a person discretion (keyword heuristic; a reviewer should confirm); not a rule the compiler can make deterministic',
          effect: 'not automated: the workflow never exercises this discretion and no automatic decision is made on its behalf',
        });

  const humanFindings = (workflow: string): NonDeterministicFinding[] => [
    ...escalationSteps.map((st): NonDeterministicFinding => ({
      workflow,
      step: 'escalate_to_human',
      class: 'human',
      cause: 'documented_escalation',
      reason: `the policy hands this case to ${(st.kind === 'gate' || st.kind === 'finish') && st.outcome.target !== undefined ? st.outcome.target : 'a person'}`,
      provenance: [cite(st.source)],
      blocking: false,
    })),
    ...reviewItems.map((r): NonDeterministicFinding => ({
      workflow,
      step: 'escalate_to_human',
      class: 'human',
      cause: r.kind,
      reason: r.reason,
      provenance: [clip(`${r.rule !== '' ? r.rule : r.section}: ${r.sentence}`)],
      blocking: blockingItems.has(r),
    })),
  ];
  const extractFinding = (workflow: string): NonDeterministicFinding => ({
    workflow,
    step: 'extract_facts',
    class: 'model_assisted',
    cause: 'free_text_input',
    reason: `reads a free-text narrative into ${tree.inputs.length} structured fact(s) with a model; every fact must be backed by a quote from the text, otherwise the case escalates. The structured workflow exists so callers who already have the facts never need this step`,
    provenance: capProvenance(factProvenance),
    blocking: false,
  });

  // "needs a model" is asked of the same negotiation a runtime uses, not assumed from the step list
  const negotiation = negotiateWorkflows(component, DETERMINISTIC_HOST);
  const entries: WorkflowDeterminismEntry[] = component.workflows.map((w) => {
    const det = determinismReport(w);
    return {
      workflow: w.id,
      path: w.id === structuredId ? 'structured' : 'text',
      label: DECLARED_NOT_MEASURED,
      counts: det.counts,
      ratio: det.ratio,
      needsModel: !negotiation.modelFree.includes(w.id),
      steps: det.steps,
      nonDeterministic: w.id === textId ? [extractFinding(w.id), ...humanFindings(w.id)] : humanFindings(w.id),
    };
  });

  const outcomes = [...new Set([...decisions, 'escalate'])];
  const limits: string[] = [
    'Determinism ratios count declared step classes and recognized sentences. They are not measurements of accuracy, coverage of real cases, cost or savings.',
    ...(sink === 'file'
      ? [
          'The policy document does not describe external systems, so the only action emitted records the decision through a file connector the operator binds (the root directory is created on first use only when the operator opts in). Tickets, email, payments and other actions are not inferred; choose decisionSink "none" to emit no action and act on the run result instead.',
        ]
      : []),
    'Free-text reading (the _from_text workflow) needs a model and is only as reliable as that model; grounding rejects facts that are not quoted from the text and escalates the case.',
    'A fact the caller does not supply to the structured workflow is treated as unknown: the tree escalates rather than guessing.',
  ];
  const held = policy.review.heldApprovals;
  if (held.length > 0)
    limits.push(
      `An approving rule is recognized (${held.join(', ')}) but HELD: ${policy.review.unrecognized.length} decision sentence(s) are still unreviewed, so every case that would be approved escalates (APPROVAL_HELD_UNREVIEWED_RULES) instead of being approved over rules the compiler did not understand. Resolving every review item releases the hold.`,
    );
  else if (!outcomes.some((d) => d !== 'deny' && d !== 'escalate'))
    limits.push(
      'The compiled tree reaches no approving outcome: it can deny or escalate only. Every case that passes the recognized checks escalates (UNFORMALIZED_RULE) because the document states no approval rule the compiler recognized.',
    );
  if (sink === 'none')
    limits.push('No action is emitted (decisionSink "none"): the decision is the run result and the host application acts on it.');

  const report: WorkflowCompileReport = {
    label: DECLARED_NOT_MEASURED,
    workflows: entries,
    capabilities: [
      {
        capability: policyCapabilityName(program),
        treeId: tree.id,
        label: DECLARED_NOT_MEASURED,
        decisionSentences: policy.review.decisionSentences,
        recognizedSentences: policy.review.recognizedSentences,
        unrecognizedSentences: policy.review.unrecognized.length,
        ...(policy.review.decisionSentences > 0
          ? { ruleCoverage: policy.review.recognizedSentences / policy.review.decisionSentences }
          : {}),
        workflows: entries.map((e) => ({ workflow: e.workflow, path: e.path, counts: e.counts, ratio: e.ratio, needsModel: e.needsModel })),
        outcomes,
        failClosedPaths: policy.review.failClosedPaths,
        approvalsHeld: held,
      },
    ],
    reviewItems,
    limits,
  };
  return { emission: { component, report }, problems: [] };
}

export { WORKFLOW_COMPONENT_PATH };
