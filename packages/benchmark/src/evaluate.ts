import { attributeCase } from './attribution.js';
import type {
  BenchmarkCaseDefinition,
  CapabilityExecutionCase,
  CapabilityExpectation,
  EvidenceSpec,
  ExpectedExecutionClass,
  FactExpectation,
  WorkflowExecutionCase,
  WorkflowExpectation,
} from './definition.js';
import type { CaseEvaluation, ItemOutcome, ObservedSummary } from './evaluation-types.js';
import { compareStrings } from './json.js';
import { describeMatcher, describePredicate, deepEqualNormalized, evalAll, evalPredicate, isSubsetMatch, matchesName, normalizeText, perfectAssignment } from './match.js';
import { MetricBuilder, type MetricResult } from './metrics.js';
import { STAMPING_ORIGINS, classifyProducerOrigin } from './producer.js';
import type { ObservedAgreement, ObservedExecutionProvenance } from './observation.js';
import { compareViews, type CrossPathPair, type CrossPathId } from './cross-path.js';
import type {
  ObservedCapabilityExecution,
  ObservedNode,
  ObservedSourceRef,
  ObservedWorkflow,
  ObservedWorkflowExecution,
  PipelineObservation,
  StageName,
} from './observation.js';

/**
 * PURE evaluation: `(definition, observation) -> CaseEvaluation`. No I/O,
 * no clock, no randomness; every choice between equally valid candidates
 * is made by sorting on ids, and no result depends on the order of the
 * definition's lists or of the observation's lists (both are sorted
 * before use), so ordering that is semantically irrelevant never changes
 * a number.
 */

function count(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of [...values].sort(compareStrings)) out[v] = (out[v] ?? 0) + 1;
  return out;
}

function summarize(obs: PipelineObservation): ObservedSummary {
  return {
    nodeCountsByKind: count(obs.nodes.map((n) => n.kind)),
    capabilities: {
      total: obs.capabilities.length,
      byResolution: count(obs.capabilities.map((c) => c.resolution)),
      byExecutionClass: count(obs.capabilities.map((c) => c.executionClass)),
    },
    workflows: {
      total: obs.workflows.length,
      totalSteps: obs.workflows.reduce((n, w) => n + w.steps.length, 0),
      byExecutability: count(obs.workflows.map((w) => w.executability)),
    },
    executions: { total: obs.executions.length, byOutcome: count(obs.executions.map((e) => (e.kind === 'capability' ? e.outcome : `workflow:${e.runStatus ?? e.outcome}`))) },
  };
}

function stageFailureNote(obs: PipelineObservation, stage: StageName): string | undefined {
  const s = obs.stages[stage];
  return s.status === 'failed' ? `${stage} stage failed: [${s.errorCode ?? 'UNKNOWN'}] ${s.errorMessage ?? ''}`.trim() : undefined;
}

/** First failed stage at or before `stage` (a failure upstream explains a downstream absence). */
function upstreamFailure(obs: PipelineObservation, stage: StageName): { readonly stage: StageName; readonly note: string } | undefined {
  const order: StageName[] = ['compile', 'capabilities', 'workflows', 'execution'];
  for (const s of order.slice(0, order.indexOf(stage) + 1)) {
    const note = stageFailureNote(obs, s);
    if (note !== undefined) return { stage: s, note };
  }
  return undefined;
}

function evidenceProblem(spec: EvidenceSpec, refs: readonly ObservedSourceRef[]): string | undefined {
  const min = spec.minSourceRefs ?? 1;
  if (refs.length < min) return `has ${refs.length} source ref(s), expected at least ${min}`;
  if (spec.documentPath !== undefined && !refs.some((r) => r.documentPath.endsWith(spec.documentPath!))) return `no source ref from a document ending in "${spec.documentPath}" (cites: ${[...new Set(refs.map((r) => r.documentPath))].sort(compareStrings).join(', ') || 'none'})`;
  if (spec.pages !== undefined) {
    const cited = new Set(refs.flatMap((r) => r.pages ?? []));
    const absent = spec.pages.filter((p) => !cited.has(p));
    if (absent.length > 0) return `page(s) ${absent.join(', ')} not cited (cites: ${[...cited].sort((a, b) => a - b).join(', ') || 'none'})`;
  }
  return undefined;
}

/**
 * A SEMANTIC identity for an observed node, used as the item id wherever an
 * observed (not expected) thing is reported: `<kind>|<its text>`. Node ids
 * are content hashes and can change when a compiler change alters even an
 * irrelevant detail; a text key does not, so the regression comparator
 * does not report one unexpected node as "resolved" and a re-hashed twin as
 * "newly failing".
 */
function nodeKey(node: ObservedNode): string {
  const props = node.properties;
  const text = ['question', 'condition', 'definition', 'rule', 'name', 'text'].map((k) => props[k]).find((v) => typeof v === 'string');
  return `${node.kind}|${typeof text === 'string' ? normalizeText(text).slice(0, 100) : node.id}`;
}

function brief(node: ObservedNode): string {
  const props = node.properties;
  const text = ['question', 'condition', 'definition', 'rule', 'name', 'text'].map((k) => props[k]).find((v) => typeof v === 'string');
  return `${node.kind} ${typeof text === 'string' ? JSON.stringify(text.length > 90 ? `${text.slice(0, 90)}…` : text) : node.id}`;
}

// ---------------------------------------------------------------------------
// Semantics (XOIR facts)
// ---------------------------------------------------------------------------

function evaluateSemantics(def: BenchmarkCaseDefinition, obs: PipelineObservation, items: ItemOutcome[], out: MetricResult[], provenance: MetricBuilder): void {
  const sem = def.expect.semantics;
  const compileFailure = stageFailureNote(obs, 'compile');
  const facts = [...(sem?.facts ?? [])].sort((a, b) => compareStrings(a.id, b.id));
  const forbidden = [...(sem?.forbidden ?? [])].sort((a, b) => compareStrings(a.id, b.id));
  const closedKinds = [...new Set(sem?.closedWorldKinds ?? [])].sort(compareStrings);

  const nodesByKind = new Map<string, ObservedNode[]>();
  for (const n of obs.nodes) nodesByKind.set(n.kind, [...(nodesByKind.get(n.kind) ?? []), n]);

  const recall = new MetricBuilder('semanticRecall', 'compile', 'expected semantic facts located AND correct / expected semantic facts');
  const correctness = new MetricBuilder('semanticCorrectness', 'compile', 'expected facts located and correct / expected facts located (identity matched) — isolates "wrong" from "absent"');
  const precision = new MetricBuilder('semanticPrecision', 'compile', 'observed nodes (of closed-world kinds) matched by a correct expected fact / all observed nodes of those kinds');
  const avoidance = new MetricBuilder('spuriousFactAvoidance', 'compile', 'forbidden facts absent from the output / forbidden facts');
  const correctNodes = new Set<string>();
  const incorrectNodes = new Set<string>();
  const claimed = new Set<string>();

  for (const fact of facts as readonly FactExpectation[]) {
    const candidates = (nodesByKind.get(fact.kind) ?? []).filter((n) => evalAll(n.properties, fact.identify)).sort((a, b) => compareStrings(a.id, b.id));
    if (candidates.length === 0) {
      const reason = compileFailure ?? `no ${fact.kind} node matches: ${fact.identify.map(describePredicate).join(' AND ')}`;
      items.push({ id: fact.id, dimension: 'fact', outcome: 'missing', detail: reason, attributedStage: 'compile' });
      recall.record(false).missing({ id: fact.id, reason, attributedStage: 'compile' });
      continue;
    }
    const passing = candidates.filter((n) => (fact.assert ?? []).every((p) => evalPredicate(n.properties, p)));
    const chosen = passing.find((n) => !claimed.has(n.id)) ?? passing[0] ?? candidates.find((n) => !claimed.has(n.id)) ?? candidates[0]!;
    claimed.add(chosen.id);
    correctness.record(passing.length > 0);
    if (passing.length > 0) {
      correctNodes.add(chosen.id);
      recall.record(true);
      items.push({ id: fact.id, dimension: 'fact', outcome: 'found', ref: chosen.id });
    } else {
      incorrectNodes.add(chosen.id);
      const failed = (fact.assert ?? []).filter((p) => !evalPredicate(chosen.properties, p));
      const reason = `located ${brief(chosen)} but ${failed.map(describePredicate).join(' AND ')} does not hold`;
      recall.record(false).mismatched({ id: fact.id, reason, attributedStage: 'compile' });
      items.push({ id: fact.id, dimension: 'fact', outcome: 'incorrect', ref: chosen.id, detail: reason, attributedStage: 'compile' });
    }
    if (fact.evidence !== undefined) {
      const problem = evidenceProblem(fact.evidence, chosen.sourceRefs);
      provenance.record(problem === undefined);
      if (problem !== undefined) provenance.mismatched({ id: fact.id, reason: problem, attributedStage: 'compile' });
    }
  }

  for (const kind of closedKinds) {
    for (const node of nodesByKind.get(kind) ?? []) {
      precision.record(correctNodes.has(node.id));
      if (correctNodes.has(node.id)) continue;
      if (incorrectNodes.has(node.id)) precision.mismatched({ id: nodeKey(node), reason: `${brief(node)} matched an expected fact but is semantically incorrect`, attributedStage: 'compile' });
      else {
        precision.unexpected({ id: nodeKey(node), reason: `${brief(node)} is not among the expected ${kind} facts`, attributedStage: 'compile' });
        items.push({ id: nodeKey(node), dimension: 'fact', outcome: 'unexpected', ref: node.id, detail: brief(node), attributedStage: 'compile' });
      }
    }
  }

  for (const f of forbidden) {
    const hits = (nodesByKind.get(f.kind) ?? []).filter((n) => evalAll(n.properties, f.identify)).sort((a, b) => compareStrings(a.id, b.id));
    avoidance.record(hits.length === 0);
    for (const hit of hits) {
      const reason = `forbidden ${brief(hit)}${f.reason !== undefined ? ` — ${f.reason}` : ''}`;
      avoidance.unexpected({ id: f.id, reason, attributedStage: 'compile' });
      items.push({ id: f.id, dimension: 'fact', outcome: 'spurious', ref: hit.id, detail: reason, attributedStage: 'compile' });
    }
  }

  if (facts.length > 0) {
    out.push(recall.build(), correctness.build());
  }
  if (closedKinds.length > 0) out.push(precision.build());
  if (forbidden.length > 0) out.push(avoidance.build());
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

function paramMatches(expected: string, p: { readonly name: string; readonly runtimeKey: string }): boolean {
  const e = normalizeText(expected);
  return normalizeText(p.name) === e || normalizeText(p.runtimeKey) === e;
}

function evaluateParams(expected: readonly string[], actual: readonly { readonly name: string; readonly runtimeKey: string }[]): { readonly missing: readonly string[]; readonly unexpected: readonly string[] } {
  const missing = expected.filter((e) => !actual.some((p) => paramMatches(e, p))).map(normalizeText);
  const unexpected = actual.filter((p) => !expected.some((e) => paramMatches(e, p))).map((p) => normalizeText(p.name));
  return { missing: [...new Set(missing)].sort(compareStrings), unexpected: [...new Set(unexpected)].sort(compareStrings) };
}

function evaluateCapabilities(def: BenchmarkCaseDefinition, obs: PipelineObservation, items: ItemOutcome[], out: MetricResult[], provenance: MetricBuilder): void {
  const spec = def.expect.capabilities;
  const expected = [...(spec?.items ?? [])].sort((a, b) => compareStrings(a.id, b.id)) as readonly CapabilityExpectation[];
  const forbidden = [...(spec?.forbidden ?? [])].sort((a, b) => compareStrings(a.id, b.id));
  const observed = [...obs.capabilities].sort((a, b) => compareStrings(a.capabilityId, b.capabilityId));
  const failure = upstreamFailure(obs, 'capabilities');

  const recall = new MetricBuilder('capabilityRecall', 'capabilities', 'expected capabilities discovered (identity matched) / expected capabilities');
  const precision = new MetricBuilder('capabilityPrecision', 'capabilities', 'discovered capabilities matched by an expectation / all discovered capabilities (closed-world suites only)');
  const avoidance = new MetricBuilder('spuriousCapabilityAvoidance', 'capabilities', 'forbidden capabilities absent / forbidden capabilities');
  const resolution = new MetricBuilder('resolutionAccuracy', 'capabilities', 'discovered capabilities whose binding resolution equals the expected one / discovered capabilities with an expected resolution');
  const klass = new MetricBuilder('executionClassAccuracy', 'capabilities', 'discovered capabilities whose execution class equals the expected one / discovered capabilities with an expected class (deterministic_rule | human_in_the_loop | not_executable)');
  const producer = new MetricBuilder('producerAttributionCorrectness', 'capabilities', 'located capabilities created by a capability extractor whose producedBy equals the expected producer / such capabilities with an expected producer and an observed producer (P0.9C Step 4)');
  const nodeById = new Map(obs.nodes.map((n) => [n.id, n] as const));
  const io = new MetricBuilder('structuredIoAccuracy', 'capabilities', 'declared input/output parameter sets exactly equal to the expected sets / expected parameter-set assertions');

  const claimed = new Set<string>();

  for (const exp of expected) {
    const candidates = observed.filter((c) => matchesName(c.name, exp.name));
    if (candidates.length === 0) {
      const reason = failure?.note ?? `no discovered capability with ${describeMatcher(exp.name)}`;
      const stage: StageName = failure?.stage ?? (obs.stages.compile.status === 'failed' ? 'compile' : 'capabilities');
      recall.record(false).missing({ id: exp.id, reason, attributedStage: stage });
      items.push({ id: exp.id, dimension: 'capability', outcome: 'missing', detail: reason, attributedStage: stage });
      continue;
    }
    const actual = candidates.find((c) => !claimed.has(c.capabilityId)) ?? candidates[0]!;
    claimed.add(actual.capabilityId);
    recall.record(true);
    const problems: string[] = [];

    if (exp.resolution !== undefined) {
      const pass = actual.resolution === exp.resolution;
      resolution.record(pass);
      if (!pass) {
        const reason = `expected resolution "${exp.resolution}", got "${actual.resolution}"${actual.notExecutableReason !== undefined ? ` (${actual.notExecutableReason.slice(0, 160)})` : ''}`;
        resolution.mismatched({ id: exp.id, reason, attributedStage: 'capabilities' });
        problems.push(reason);
      }
    }
    if (exp.executionClass !== undefined) {
      const pass = actual.executionClass === exp.executionClass;
      klass.record(pass).count(`${exp.executionClass}->${actual.executionClass}`);
      if (!pass) {
        const reason = `expected execution class "${exp.executionClass}", got "${actual.executionClass}"`;
        klass.mismatched({ id: exp.id, reason, attributedStage: 'capabilities' });
        problems.push(reason);
      }
    }
    for (const [label, expectedNames, actualParams] of [
      ['inputs', exp.inputs, actual.inputs],
      ['outputs', exp.outputs, actual.outputs],
    ] as const) {
      if (expectedNames === undefined) continue;
      const diff = evaluateParams(expectedNames, actualParams);
      const pass = diff.missing.length === 0 && diff.unexpected.length === 0;
      io.record(pass);
      if (!pass) {
        const reason = `${label}: ${diff.missing.length > 0 ? `missing [${diff.missing.join(', ')}]` : ''}${diff.missing.length > 0 && diff.unexpected.length > 0 ? '; ' : ''}${diff.unexpected.length > 0 ? `unexpected [${diff.unexpected.join(', ')}]` : ''}`;
        if (diff.missing.length > 0) io.missing({ id: `${exp.id}.${label}`, reason, attributedStage: 'capabilities' });
        if (diff.unexpected.length > 0) io.unexpected({ id: `${exp.id}.${label}`, reason, attributedStage: 'capabilities' });
        problems.push(reason);
      }
    }
    if (exp.producedBy !== undefined) {
      // Asserted ONLY for a capability an extractor created (premise) and only when a producer is present (absence is
      // `producerAttributionCoverage`'s question). A capability created another way, or with no node, is outside the assertion.
      const node = nodeById.get(actual.capabilityId);
      if (node === undefined || classifyProducerOrigin(node) !== 'capability_extractor') producer.count('excluded.premise_not_met');
      else if (node.producedBy === undefined) producer.count('excluded.no_observed_producer');
      else {
        const pass = node.producedBy === exp.producedBy;
        producer.record(pass).count(`${exp.producedBy}->${node.producedBy}`);
        if (!pass) {
          const reason = `expected producedBy \"${exp.producedBy}\", got \"${node.producedBy}\"`;
          producer.mismatched({ id: exp.id, reason, attributedStage: 'compile' });
          problems.push(reason);
        }
      }
    }
    if (exp.evidence !== undefined) {
      const problem = evidenceProblem(exp.evidence, actual.sourceRefs);
      provenance.record(problem === undefined);
      if (problem !== undefined) {
        provenance.mismatched({ id: exp.id, reason: problem, attributedStage: 'compile' });
        problems.push(`evidence: ${problem}`);
      }
    }
    items.push(problems.length === 0 ? { id: exp.id, dimension: 'capability', outcome: 'found', ref: actual.capabilityId } : { id: exp.id, dimension: 'capability', outcome: 'incorrect', ref: actual.capabilityId, detail: problems.join(' | '), attributedStage: 'capabilities' });
  }

  if (spec?.closedWorld === true) {
    for (const cap of observed) {
      precision.record(claimed.has(cap.capabilityId));
      if (!claimed.has(cap.capabilityId)) {
        precision.unexpected({ id: `capability|${normalizeText(cap.name)}`, reason: `discovered "${cap.name}" (${cap.resolution}/${cap.executionClass}) matches no expected capability`, attributedStage: 'capabilities' });
        items.push({ id: `capability|${normalizeText(cap.name)}`, dimension: 'capability', outcome: 'unexpected', ref: cap.capabilityId, detail: cap.name, attributedStage: 'capabilities' });
      }
    }
  }
  for (const f of forbidden) {
    const hits = observed.filter((c) => matchesName(c.name, f.name));
    avoidance.record(hits.length === 0);
    for (const hit of hits) {
      const reason = `forbidden capability "${hit.name}"${f.reason !== undefined ? ` — ${f.reason}` : ''}`;
      avoidance.unexpected({ id: f.id, reason, attributedStage: 'capabilities' });
      items.push({ id: f.id, dimension: 'capability', outcome: 'spurious', ref: hit.capabilityId, detail: reason, attributedStage: 'capabilities' });
    }
  }

  if (expected.length > 0) out.push(recall.build());
  if (spec?.closedWorld === true) out.push(precision.build());
  if (forbidden.length > 0) out.push(avoidance.build());
  for (const b of [resolution, klass, io, producer]) {
    const built = b.build();
    if (built.measured) out.push(built);
  }
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

function workflowKey(wf: ObservedWorkflow): string {
  return `workflow|${[...wf.steps].sort((a, b) => a.order - b.order).map((s) => normalizeText(s.name)).join(' > ')}`;
}

function classOfStep(step: { readonly executionClass: string }): ExpectedExecutionClass | string {
  return step.executionClass;
}

function evaluateWorkflows(def: BenchmarkCaseDefinition, obs: PipelineObservation, items: ItemOutcome[], out: MetricResult[]): void {
  const spec = def.expect.workflows;
  const expected = [...(spec?.items ?? [])].sort((a, b) => compareStrings(a.id, b.id)) as readonly WorkflowExpectation[];
  const observed = [...obs.workflows].sort((a, b) => compareStrings(a.workflowId, b.workflowId));
  const failure = upstreamFailure(obs, 'workflows');

  const recall = new MetricBuilder('workflowRecall', 'workflows', 'expected workflows found (steps match exactly, any order) / expected workflows');
  const precision = new MetricBuilder('workflowPrecision', 'workflows', 'observed workflows matched by an expectation / all observed workflows (closed-world suites only)');
  const executability = new MetricBuilder('workflowExecutabilityAccuracy', 'workflows', 'found workflows whose audit status equals the expected executability / found workflows with an expected executability');
  const structure = new MetricBuilder('workflowStructureAccuracy', 'workflows', 'found workflows whose step order / per-step execution classes equal the expected ones / such assertions');
  const dataFlow = new MetricBuilder('dataFlowCorrectness', 'workflows', 'data-flow assertions satisfied (proven bindings present, not_proven bindings absent, no extra proven bindings in closed-world workflows) / data-flow assertions, over found workflows');

  const claimed = new Set<string>();
  for (const exp of expected) {
    const candidates = observed.filter((w) => perfectAssignment(exp.steps, w.steps, (s) => s.name));
    if (candidates.length === 0) {
      const anyMissingCap = exp.steps.some((m) => !obs.capabilities.some((c) => matchesName(c.name, m)));
      const stage: StageName = failure?.stage ?? (anyMissingCap ? 'capabilities' : 'workflows');
      const reason = failure?.note ?? (anyMissingCap ? `no workflow with steps [${exp.steps.map(describeMatcher).join('; ')}] — at least one step matches no discovered capability` : `no workflow with exactly the steps [${exp.steps.map(describeMatcher).join('; ')}]`);
      recall.record(false).missing({ id: exp.id, reason, attributedStage: stage });
      items.push({ id: exp.id, dimension: 'workflow', outcome: 'missing', detail: reason, attributedStage: stage });
      continue;
    }
    const wf: ObservedWorkflow = candidates.find((w) => !claimed.has(w.workflowId)) ?? candidates[0]!;
    claimed.add(wf.workflowId);
    recall.record(true);
    const problems: string[] = [];
    const sortedSteps = [...wf.steps].sort((a, b) => a.order - b.order);

    if (exp.executability !== undefined) {
      const pass = wf.executability === exp.executability;
      executability.record(pass);
      if (!pass) {
        const reason = `expected executability "${exp.executability}", got "${wf.executability}"${wf.blockerKinds.length > 0 ? ` (blockers: ${wf.blockerKinds.join(', ')})` : ''}`;
        executability.mismatched({ id: exp.id, reason, attributedStage: 'workflows' });
        problems.push(reason);
      }
    }
    if (exp.ordered === true) {
      const pass = sortedSteps.length === exp.steps.length && exp.steps.every((m, i) => matchesName(sortedSteps[i]!.name, m));
      structure.record(pass);
      if (!pass) {
        const reason = `step order differs: expected [${exp.steps.map(describeMatcher).join(' -> ')}], got [${sortedSteps.map((s) => s.name).join(' -> ')}]`;
        structure.mismatched({ id: `${exp.id}.order`, reason, attributedStage: 'workflows' });
        problems.push(reason);
      }
    }
    if (exp.stepClasses !== undefined) {
      const actualClasses = sortedSteps.map(classOfStep);
      const pass = actualClasses.length === exp.stepClasses.length && exp.stepClasses.every((c, i) => actualClasses[i] === c);
      structure.record(pass);
      if (!pass) {
        const reason = `step classes differ: expected [${exp.stepClasses.join(', ')}], got [${actualClasses.join(', ')}]`;
        structure.mismatched({ id: `${exp.id}.stepClasses`, reason, attributedStage: 'capabilities' });
        problems.push(reason);
      }
    }
    if (exp.dataFlow !== undefined) {
      const matchedProven = new Set<number>();
      exp.dataFlow.bindings.forEach((b, i) => {
        const bindingId = `${exp.id}.dataFlow[${i}]`;
        const hits = wf.bindings.map((ob, idx) => ({ ob, idx })).filter(({ ob }) => matchesName(ob.producerName, b.producer) && matchesName(ob.consumerName, b.consumer) && normalizeText(ob.output) === normalizeText(b.output) && normalizeText(ob.input) === normalizeText(b.input));
        const provenHits = hits.filter(({ ob }) => ob.status === 'proven');
        const label = `${describeMatcher(b.producer)}.${b.output} -> ${describeMatcher(b.consumer)}.${b.input}`;
        if (b.status === 'proven') {
          const pass = provenHits.length > 0;
          dataFlow.record(pass);
          for (const h of provenHits) matchedProven.add(h.idx);
          if (!pass) {
            const reason = `expected PROVEN binding ${label}; ${hits.length > 0 ? `audit reports it as "${hits[0]!.ob.status}"` : 'the audit reports no such binding'}`;
            dataFlow.missing({ id: bindingId, reason, attributedStage: 'workflows' });
            problems.push(reason);
          }
        } else {
          const pass = provenHits.length === 0;
          dataFlow.record(pass);
          if (!pass) {
            const reason = `binding ${label} must NOT be proven, but the audit proves it`;
            dataFlow.unexpected({ id: bindingId, reason, attributedStage: 'workflows' });
            problems.push(reason);
          }
        }
      });
      if (exp.dataFlow.closedWorld === true) {
        wf.bindings.forEach((ob, idx) => {
          if (ob.status !== 'proven') return;
          // A proven binding that an expectation already claimed was counted as that expectation's assertion; only UNCLAIMED ones add (failing) assertions.
          if (!matchedProven.has(idx)) {
            dataFlow.record(false);
            const reason = `extra PROVEN binding ${ob.producerName}.${ob.output} -> ${ob.consumerName}.${ob.input} is not expected`;
            dataFlow.unexpected({ id: `${exp.id}.dataFlow.extra:${normalizeText(ob.producerName)}.${ob.output}->${normalizeText(ob.consumerName)}.${ob.input}`, reason, attributedStage: 'workflows' });
            problems.push(reason);
          }
        });
      }
    }
    items.push(problems.length === 0 ? { id: exp.id, dimension: 'workflow', outcome: 'found', ref: wf.workflowId } : { id: exp.id, dimension: 'workflow', outcome: 'incorrect', ref: wf.workflowId, detail: problems.join(' | '), attributedStage: 'workflows' });
  }

  if (spec?.closedWorld === true) {
    for (const wf of observed) {
      precision.record(claimed.has(wf.workflowId));
      if (!claimed.has(wf.workflowId)) {
        const reason = `observed workflow [${[...wf.steps].sort((a, b) => a.order - b.order).map((s) => s.name).join(' -> ')}] (${wf.executability}) matches no expected workflow`;
        precision.unexpected({ id: workflowKey(wf), reason, attributedStage: 'workflows' });
        items.push({ id: workflowKey(wf), dimension: 'workflow', outcome: 'unexpected', ref: wf.workflowId, detail: reason, attributedStage: 'workflows' });
      }
    }
  }
  if (expected.length > 0) out.push(recall.build());
  if (spec?.closedWorld === true) out.push(precision.build());
  for (const b of [executability, structure, dataFlow]) {
    const built = b.build();
    if (built.measured) out.push(built);
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function attributeCapabilityRun(exp: CapabilityExecutionCase, got: ObservedCapabilityExecution): StageName {
  if (got.outcome === 'target_not_found' || got.outcome === 'target_ambiguous') return 'capabilities';
  if (got.outcome === 'not_executable' && exp.expect.outcome !== 'not_executable') return 'capabilities';
  if (exp.expect.outcome === 'not_executable' && got.outcome !== 'not_executable') return 'capabilities';
  return 'execution';
}

function evaluateCapabilityRun(exp: CapabilityExecutionCase, got: ObservedCapabilityExecution | undefined, obs: PipelineObservation): { readonly pass: boolean; readonly reason?: string; readonly stage?: StageName } {
  if (got === undefined) {
    const f = upstreamFailure(obs, 'execution');
    return { pass: false, reason: f?.note ?? 'the request was not run', stage: f?.stage ?? 'execution' };
  }
  const reasons: string[] = [];
  if (got.outcome !== exp.expect.outcome) reasons.push(`expected outcome "${exp.expect.outcome}", got "${got.outcome}"${got.message !== undefined ? ` (${got.message.slice(0, 160)})` : ''}`);
  if (exp.expect.output !== undefined) {
    const subset = isSubsetMatch(got.output, exp.expect.output);
    if (!subset.ok) reasons.push(`output mismatch: ${subset.mismatches.join('; ')}`);
  }
  if (exp.expect.errorCode !== undefined && got.errorCode !== exp.expect.errorCode) reasons.push(`expected error code "${exp.expect.errorCode}", got "${got.errorCode ?? 'none'}"`);
  return reasons.length === 0 ? { pass: true } : { pass: false, reason: reasons.join(' | '), stage: attributeCapabilityRun(exp, got) };
}

function evaluateWorkflowRun(exp: WorkflowExecutionCase, got: ObservedWorkflowExecution | undefined, obs: PipelineObservation, transfer: MetricBuilder): { readonly pass: boolean; readonly reason?: string; readonly stage?: StageName } {
  if (got === undefined) {
    const f = upstreamFailure(obs, 'execution');
    (exp.expect.injections ?? []).forEach(() => transfer.record(false));
    return { pass: false, reason: f?.note ?? 'the request was not run', stage: f?.stage ?? 'execution' };
  }
  if (got.outcome === 'target_not_found' || got.outcome === 'target_ambiguous') {
    (exp.expect.injections ?? []).forEach(() => transfer.record(false));
    const anyMissingCap = exp.steps.some((m) => !obs.capabilities.some((c) => matchesName(c.name, m)));
    return { pass: false, reason: got.outcome === 'target_not_found' ? `no workflow with exactly the steps [${exp.steps.map(describeMatcher).join('; ')}]` : `${got.candidateCount} workflows match the requested steps`, stage: anyMissingCap ? 'capabilities' : 'workflows' };
  }
  const reasons: string[] = [];
  let stage: StageName = 'execution';
  if (got.outcome === 'refused') {
    // Refused = not run: nothing further to check except that "not executable" was what the case expected.
    (exp.expect.injections ?? []).forEach(() => transfer.record(false));
    return exp.expect.status === 'not_executable_yet' ? { pass: true } : { pass: false, reason: `expected run status "${exp.expect.status}", but the workflow was refused as not executable (${got.workflowExecutability}): ${got.message ?? ''}`, stage: 'workflows' };
  }
  if (got.runStatus !== exp.expect.status) {
    reasons.push(`expected run status "${exp.expect.status}", got "${got.runStatus}"`);
    if (got.runStatus === 'not_executable_yet' || exp.expect.status === 'not_executable_yet') stage = 'workflows';
  }
  for (const stepExp of exp.expect.steps ?? []) {
    const runs = got.steps.filter((s) => matchesName(s.name, stepExp.capability));
    if (runs.length !== 1) {
      reasons.push(`${describeMatcher(stepExp.capability)}: ${runs.length === 0 ? 'step was not run' : 'ambiguous step match'}`);
      continue;
    }
    const run = runs[0]!;
    if (stepExp.outputStatus !== undefined && run.outputStatus !== stepExp.outputStatus) reasons.push(`${describeMatcher(stepExp.capability)}: expected output status "${stepExp.outputStatus}", got "${run.outputStatus ?? 'none'}"`);
    if (stepExp.output !== undefined) {
      const subset = isSubsetMatch(run.output, stepExp.output);
      if (!subset.ok) reasons.push(`${describeMatcher(stepExp.capability)}: output mismatch: ${subset.mismatches.join('; ')}`);
    }
  }
  for (const inj of exp.expect.injections ?? []) {
    const producers = got.steps.filter((s) => matchesName(s.name, inj.producer));
    const consumers = got.steps.filter((s) => matchesName(s.name, inj.consumer));
    const producerOut = producers.length === 1 && typeof producers[0]!.output === 'object' && producers[0]!.output !== null ? (producers[0]!.output as Record<string, unknown>)[inj.output] : undefined;
    const injected = consumers.length === 1 ? consumers[0]!.actualInput?.[inj.input] : undefined;
    const pass = producerOut !== undefined && injected !== undefined && deepEqualNormalized(producerOut, injected);
    transfer.record(pass);
    if (!pass) {
      const reason = `${describeMatcher(inj.producer)}.${inj.output} -> ${describeMatcher(inj.consumer)}.${inj.input}: producer produced ${JSON.stringify(producerOut)}, consumer actually received ${JSON.stringify(injected)}`;
      transfer.missing({ id: exp.id, reason, attributedStage: 'execution' });
      reasons.push(reason);
    }
  }
  return reasons.length === 0 ? { pass: true } : { pass: false, reason: reasons.join(' | '), stage };
}

function evaluateExecution(def: BenchmarkCaseDefinition, obs: PipelineObservation, items: ItemOutcome[], out: MetricResult[]): void {
  const cases = [...(def.execution ?? [])].sort((a, b) => compareStrings(a.id, b.id));
  if (cases.length === 0) return;
  const correctness = new MetricBuilder('executionCorrectness', 'execution', 'execution requests whose observed outcome (status/output/steps) equals the expected one / execution requests');
  const transfer = new MetricBuilder('runtimeDataFlowTransfer', 'execution', 'expected producer->consumer injections the RUNTIME actually performed (consumer received the producer value) / expected injections');
  const byId = new Map<string, ObservedCapabilityExecution | ObservedWorkflowExecution>(obs.executions.map((e) => [e.requestId, e]));
  for (const exp of cases) {
    const got = byId.get(exp.id);
    const verdict =
      exp.kind === 'capability'
        ? evaluateCapabilityRun(exp, got?.kind === 'capability' ? got : undefined, obs)
        : evaluateWorkflowRun(exp, got?.kind === 'workflow' ? got : undefined, obs, transfer);
    correctness.record(verdict.pass);
    if (verdict.pass) {
      items.push({ id: exp.id, dimension: 'execution', outcome: 'passed' });
    } else {
      const outcome = got === undefined ? 'not_run' : 'failed';
      items.push({ id: exp.id, dimension: 'execution', outcome, detail: verdict.reason ?? '', attributedStage: verdict.stage ?? 'execution' });
      (got === undefined ? correctness.missing.bind(correctness) : correctness.mismatched.bind(correctness))({ id: exp.id, reason: verdict.reason ?? '', attributedStage: verdict.stage ?? 'execution' });
    }
  }
  out.push(correctness.build());
  const t = transfer.build();
  if (t.measured) out.push(t);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function evaluateCase(def: BenchmarkCaseDefinition, obs: PipelineObservation): CaseEvaluation {
  const observed = summarize(obs);
  const attribution = attributeCase(def, obs);
  if (obs.harnessError !== undefined) {
    return { caseId: def.caseId, status: 'harness_error', harnessError: obs.harnessError, entry: obs.entry, attribution, stages: obs.stages, fingerprints: obs.fingerprints, observed, metrics: [], items: [] };
  }
  const items: ItemOutcome[] = [];
  const metrics: MetricResult[] = [];

  if (def.expect.compile !== undefined) {
    const compile = obs.stages.compile;
    const exp = def.expect.compile;
    const actualFailed = compile.status === 'failed';
    const pass = exp.outcome === 'fails' ? actualFailed && (exp.errorCode === undefined || compile.errorCode === exp.errorCode) : !actualFailed;
    const m = new MetricBuilder('compileOutcomeAccuracy', 'compile', 'compile outcome (succeeds / fails with the expected code) equals the expected outcome / 1');
    m.record(pass);
    if (!pass) {
      const reason = `expected compile to ${exp.outcome}${exp.errorCode !== undefined ? ` with ${exp.errorCode}` : ''}; ${actualFailed ? `it failed: [${compile.errorCode}] ${compile.errorMessage}` : 'it succeeded'}`;
      m.mismatched({ id: 'compile', reason, attributedStage: 'compile' });
      items.push({ id: 'compile', dimension: 'compile', outcome: 'failed', detail: reason, attributedStage: 'compile' });
    } else {
      items.push({ id: 'compile', dimension: 'compile', outcome: 'passed' });
    }
    metrics.push(m.build());
  }

  // Facts and capabilities both contribute evidence specs to ONE provenanceCompleteness metric.
  const provenance = new MetricBuilder('provenanceCompleteness', 'compile', 'expected evidence specs satisfied by the located item / evidence specs on located items (facts and capabilities)');
  evaluateSemantics(def, obs, items, metrics, provenance);
  evaluateCapabilities(def, obs, items, metrics, provenance);
  const provenanceResult = provenance.build();
  if (provenanceResult.measured) metrics.push(provenanceResult);
  evaluateWorkflows(def, obs, items, metrics);
  evaluateExecution(def, obs, items, metrics);

  // Descriptive (expectation-free) provenance coverage over every observed node.
  if (obs.stages.compile.status !== 'failed' && obs.nodes.length > 0) {
    const cov = new MetricBuilder('observedSourceRefCoverage', 'compile', 'observed XOIR nodes carrying at least one source reference / observed XOIR nodes (descriptive; no expectation involved)');
    for (const n of obs.nodes) {
      cov.record(n.sourceRefs.length > 0);
      if (n.sourceRefs.length === 0) cov.missing({ id: nodeKey(n), reason: `${brief(n)} carries no source reference`, attributedStage: 'compile' });
    }
    metrics.push(cov.build());
  }

  // Producer attribution coverage (P0.9C Step 4). Population = nodes created through a path that HAS a stamping site (knowledge
  // extractor, capability extractor), decided from kind / subtype / the minter's marker — never from `producedBy` itself. Nodes
  // from paths with no stamping site (reasoning-derived, rule-minted) are not judged: whether they should be attributed is not
  // established by the repository. Only where a single extractor can have produced each node (AI not exercised) and a compile ran.
  if (obs.stages.compile.status === 'ok' && attribution.configuration.ai === 'not_exercised') {
    const coverage = new MetricBuilder('producerAttributionCoverage', 'compile', 'nodes created through a producer-stamping path (knowledge / capability extractor) that carry producedBy / such nodes (P0.9C Step 4; reasoning-derived and rule-minted nodes have no stamping site and are not judged)');
    for (const n of obs.nodes) {
      const origin = classifyProducerOrigin(n);
      const stamped = STAMPING_ORIGINS.includes(origin);
      if (stamped) {
        coverage.record(n.producedBy !== undefined);
        if (n.producedBy === undefined) coverage.missing({ id: nodeKey(n), reason: `${brief(n)} was created by the ${origin.replace('_', ' ')} path but carries no producedBy`, attributedStage: 'compile' });
      }
      coverage.count(`${stamped ? 'in_population' : 'not_judged'}.${origin}.${n.producedBy === undefined ? 'unattributed' : 'attributed'}`);
    }
    const built = coverage.build();
    if (built.measured) metrics.push(built);
  }

  // Provenance chain coverage (P0.9C Step 5). Population = every observed capability of a compiled case. A chain is COMPLETE when each
  // required link is internally connected, judged against independent structure (declared source paths, graph node ids, a second hash
  // projection) — never against an id merely being present. Binding state is observed (breakdown), not required: an `unresolved` binding is a
  // legitimate outcome. ExperienceUnit existence, manifest and runtime links are not observable here (L14).
  if (obs.stages.compile.status === 'ok' && obs.provenance !== undefined) {
    const chain = new MetricBuilder('provenanceChainCoverage', 'capabilities', 'observed capabilities whose compile-side chain (source -> node -> capability -> contract) is internally connected / all observed capabilities (P0.9C Step 5; descriptive, structural connectedness, not semantic correctness)');
    const sourcePaths = new Set((obs.sourceReports ?? []).map((r) => r.path));
    const nodesById = new Map(obs.nodes.map((n) => [n.id, n] as const));
    const refKey = (r: { readonly documentPath: string; readonly pages?: readonly number[] | undefined }): string => `${r.documentPath}|${(r.pages ?? []).join(',')}`;
    for (const p of [...obs.provenance.capabilities].sort((a, b) => compareStrings(a.capabilityId, b.capabilityId))) {
      const linked = p.sourceXoirNodeIds.map((id) => nodesById.get(id));
      const carried = new Set(linked.flatMap((n) => (n?.sourceRefs ?? []).map(refKey)));
      const links: Record<string, boolean> = {
        source_resolves: p.sourceRefs.length > 0 && p.sourceRefs.every((r) => sourcePaths.has(r.documentPath)),
        nodes_resolve: p.sourceXoirNodeIds.length > 0 && linked.every((n) => n !== undefined) && p.sourceXoirNodeIds.includes(p.capabilityId),
        refs_carried: p.sourceRefs.length > 0 && p.sourceRefs.every((r) => carried.has(refKey(r))),
        hash_deterministic: p.contractContentHash !== '' && p.contractContentHash === p.contractContentHashRecomputed,
      };
      const broken = Object.entries(links).filter(([, ok]) => !ok).map(([k]) => k).sort(compareStrings);
      chain.record(broken.length === 0);
      for (const [k, ok] of Object.entries(links).sort(([a], [b]) => compareStrings(a, b))) chain.count(`link.${k}.${ok ? 'ok' : 'broken'}`);
      chain.count(`binding.${p.binding.status}`);
      if (broken.length > 0) chain.missing({ id: `capability|${p.capabilityId}`, reason: `capability "${p.name}": broken chain link(s) ${broken.join(', ')}`, attributedStage: 'capabilities' });
    }
    const built = chain.build();
    if (built.measured) metrics.push(built);
  }

  // Execution provenance agreement (P0.9C Step 5). One unit per capability the runtime actually executed (a capability request, or a
  // workflow step). `agreement` is P0.9B's own field-by-field equality between what the execution recorded and the live-graph projection;
  // `unknown` (one side absent) and not-run / not-recorded units are reported, never scored as failures.
  {
    const agreement = new MetricBuilder('executionProvenanceAgreement', 'execution', 'executed capabilities whose recorded graphHash / contractContentHash / bindingId / contractId all match the live-graph projection / executed capabilities where agreement is determinable (match or mismatch); unknown, not_exercised and not_observable are reported in the breakdown (P0.9C Step 5; descriptive)');
    const stateOf = (p: ObservedExecutionProvenance): 'match' | 'mismatch' | 'unknown' => {
      const vals = Object.values(p.agreement) as ObservedAgreement[];
      return vals.includes('mismatch') ? 'mismatch' : vals.every((v) => v === 'match') ? 'match' : 'unknown';
    };
    const judge = (id: string, p: ObservedExecutionProvenance): void => {
      const state = stateOf(p);
      agreement.count(`state.${state}`);
      if (state === 'unknown') return;
      agreement.record(state === 'match');
      if (state === 'mismatch') {
        const fields = Object.entries(p.agreement).filter(([, v]) => v === 'mismatch').map(([k]) => k).sort(compareStrings);
        agreement.mismatched({ id, reason: `recorded provenance disagrees with the live-graph view on ${fields.join(', ')}`, attributedStage: 'execution' });
      }
    };
    for (const e of [...obs.executions].sort((a, b) => compareStrings(a.requestId, b.requestId))) {
      if (e.kind === 'capability') {
        if (e.provenance !== undefined) judge(`execution|${e.requestId}`, e.provenance);
        else agreement.count(e.outcome === 'succeeded' || e.outcome === 'waiting_for_human' ? 'state.not_observable' : 'state.not_exercised');
      } else if (e.outcome !== 'ran') agreement.count('state.not_exercised');
      else
        for (const [i, step] of e.steps.entries()) {
          if (step.provenance !== undefined) judge(`execution|${e.requestId}#${i + 1}`, step.provenance);
          else agreement.count(step.engineStepStatus === 'completed' ? 'state.not_observable' : 'state.not_exercised');
        }
    }
    const built = agreement.build();
    if (built.measured) metrics.push(built);
  }

  // Cross-path consistency (P0.9C Step 6). Units = (pair, dimension, subject) over the in-process paths the benchmark builds from the same compiled
  // graph. Only `match` and `mismatch` are judged; unknown / not_comparable / not_exercised / not_observable go to the breakdown and are never a
  // pass or a fail. Absent (never 100%) when nothing was judged, and for serialized-XOIR entries (no source compile to compare).
  if (obs.paths !== undefined) {
    const live = obs.paths.find((p) => p.path === 'live_graph');
    if (live !== undefined) {
      const cross = new MetricBuilder('crossPathConsistency', 'capabilities', 'cross-path units (pair x dimension x subject) on which the compared paths agree / units where both paths were observed and comparable (match or mismatch); unknown, not_comparable, not_exercised and not_observable are reported in the breakdown (P0.9C Step 6; descriptive)');
      const pairs: readonly (readonly [CrossPathPair, CrossPathId])[] = [['live_vs_serialized', 'serialized_graph'], ['live_vs_package', 'package_boundary']];
      for (const [pair, id] of pairs) {
        const other = obs.paths.find((p) => p.path === id);
        if (other === undefined) { cross.count(`${pair}.*.not_exercised`); continue; }
        for (const u of compareViews(pair, live, other)) {
          cross.count(`${pair}.${u.dimension}.${u.state}`);
          if (u.state !== 'match' && u.state !== 'mismatch') continue;
          cross.record(u.state === 'match');
          if (u.state === 'mismatch') cross.mismatched({ id: `${pair}|${u.dimension}|${u.subject}`, reason: `${u.dimension}: live ${JSON.stringify(u.left)} vs ${id} ${JSON.stringify(u.right)}${u.reason ? ` (${u.reason})` : ''}`, attributedStage: 'capabilities' });
        }
      }
      const built = cross.build();
      if (built.measured) metrics.push(built);
    }
  }

  metrics.sort((a, b) => compareStrings(a.id, b.id));
  items.sort((a, b) => compareStrings(`${a.dimension}|${a.id}|${a.outcome}|${a.ref ?? ''}`, `${b.dimension}|${b.id}|${b.outcome}|${b.ref ?? ''}`));
  return { caseId: def.caseId, status: 'evaluated', entry: obs.entry, attribution, stages: obs.stages, fingerprints: obs.fingerprints, observed, metrics, items };
}
