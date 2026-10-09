import { err, ok, type Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import { PassManager, validateGraph, type XoirGraph } from '@xo/xoir';
import { knowledgeGraphToXoir, collectKnowledgeRuleSources } from '../xoir/knowledge-to-xoir.js';
import { capabilityGraphToXoir } from '../xoir/capability-to-xoir.js';
import { reasoningGraphToXoir } from '../xoir/reasoning-to-xoir.js';
import { linkRuleSourcesToReferencedNodes } from '../xoir/rule-capability-linking.js';
import { createXoirValidationPass } from './validate-pass.js';
import { createReasoningValidationPass } from './reasoning-validate-pass.js';
import { createXoirNormalizationPass } from './normalize-pass.js';
import type { CompiledXoirResult, CompileXoirOptions, PipelineInput } from './types.js';

/**
 * The domain-model -> XOIR conversion step (Stage 6 §5's "the critical
 * architectural change"). Every branch terminates at a `XoirGraph` —
 * nothing past this function ever touches `KnowledgeGraph`/
 * `CapabilityGraph`/`ReasoningGraph` internals again. The `'combined'`
 * branch (and every branch's optional `reasoning` field, Stage 7) reuses
 * the Stage 5.5 `into` mechanism exactly as Stage 6 §13 directs ("Use the
 * existing Stage 5.5 `into` functionality where appropriate rather than
 * duplicating its semantics") rather than converting graphs independently
 * and merging them — Knowledge, Capability, and Reasoning ids all live in
 * disjoint id spaces (`computeKnowledgeNodeId` / `computeCapabilityId` /
 * `computeReasoningNodeId`), so there is no genuine merge conflict to
 * resolve here, only composition, which `into` already does for free.
 *
 * Ordering matters for two independent reasons, both the same shape:
 * best-effort content-mention rule -> capability linking
 * (`../xoir/rule-capability-linking.ts`) can only find a real
 * Capability/Concept node to point a rule node at once that node already
 * exists in the target graph. So:
 * - The `'combined'` branch's own knowledge-stage rule linking
 *   (`../xoir/knowledge-to-xoir.ts#collectKnowledgeRuleSources`, applied
 *   here via `linkRuleSourcesToReferencedNodes`) runs immediately after
 *   `capabilityGraphToXoir`, once capability nodes exist — not inside
 *   `knowledgeGraphToXoir` itself, which necessarily runs *before* any
 *   capability node exists yet (knowledge converts first precisely so
 *   `capabilityGraphToXoir`'s own `requiredKnowledgeNodeIds` edges can
 *   resolve — see that adapter's doc comment).
 * - Stage 7's best-effort linking (`../xoir/reasoning-to-xoir.ts`) can
 *   only find a real Capability/Concept node to link a rule/prerequisite
 *   to if that node was already composed into the target graph *before*
 *   `reasoningGraphToXoir` runs — so `reasoning`, when present, is always
 *   converted last, after Knowledge and/or Capability (and after the
 *   knowledge-stage rule linking above).
 */
function convertToXoir(input: PipelineInput, options: CompileXoirOptions): Result<XoirGraph, XoError> {
  const graphId = options.graphId;
  const nowOpt = options.now !== undefined ? { now: options.now } : {};

  let base: Result<XoirGraph, XoError>;
  switch (input.kind) {
    case 'knowledge':
      base = knowledgeGraphToXoir(input.graph, { ...(graphId !== undefined ? { graphId } : {}), ...nowOpt });
      break;
    case 'capability':
      base = capabilityGraphToXoir(input.graph, { ...(graphId !== undefined ? { graphId } : {}), ...nowOpt });
      break;
    case 'combined': {
      const knowledgeResult = knowledgeGraphToXoir(input.knowledge, { ...(graphId !== undefined ? { graphId } : {}), ...nowOpt });
      if (!knowledgeResult.ok) return err(knowledgeResult.error);
      const capabilityResult = capabilityGraphToXoir(input.capability, { into: knowledgeResult.value, ...nowOpt });
      if (!capabilityResult.ok) return err(capabilityResult.error);
      // Stage 4's own rule nodes (constraint/obligation/exception) can only be linked to a
      // capability node now that both are in the same merged graph — see this function's doc
      // comment on why ordering matters, and rule-capability-linking.ts / collectKnowledgeRuleSources
      // for what this call does and does not link.
      linkRuleSourcesToReferencedNodes(capabilityResult.value, collectKnowledgeRuleSources(input.knowledge), options.now);
      base = capabilityResult;
      break;
    }
    case 'xoir':
      return ok(input.graph);
  }

  if (!base.ok) return err(base.error);
  if (input.reasoning === undefined) return base;
  return reasoningGraphToXoir(input.reasoning, { into: base.value, ...nowOpt });
}

/**
 * The Stage 6 compiler pipeline entry point: domain input (or an
 * already-produced `XoirGraph`, for future adapters — see
 * `types.ts#PipelineInput`) all the way through to a validated,
 * normalized canonical `XoirGraph`. This is the one function meant to be
 * a source adapter's whole interface into the compiler going forward
 * (Stage 6 §11/§14): `extract() -> convertToXoir() -> compileXoir()`,
 * without that adapter ever needing to know a `PassManager` or
 * `ValidationReport` exists.
 *
 * Stages, explicitly:
 * 1. **Convert** (`convertToXoir` above) — domain model(s) -> XOIR,
 *    including Stage 7 reasoning/decision enrichment (`input.reasoning`,
 *    composed in last via the same `into` mechanism — see
 *    `convertToXoir`'s doc comment for why order matters here).
 * 2. **Validate** (`validate-pass.ts` + `reasoning-validate-pass.ts`,
 *    one `PassManager`, registered in that order) — first
 *    `@xo/xoir#validateGraph` (generic structural validity), then Stage
 *    7's conservative semantic validation (`reasoning-validate-pass.ts`)
 *    — "does this reasoning structure actually make sense," a check the
 *    domain-agnostic structural validator cannot make. Both are wrapped
 *    as registered `Pass`es so they're inspectable/diagnosable the same
 *    way every future pass will be, and both gate step 3 identically:
 *    an error-severity diagnostic from *either* stops downstream
 *    compilation.
 * 3. **Normalize** (`normalize-pass.ts`) — canonical deterministic form —
 *    **only runs if both validation stages passed.** This is Stage 6
 *    §12's "Invalid XOIR: the XOIR validation pass should stop
 *    downstream compilation," extended to Stage 7's semantic layer,
 *    implemented by simply not invoking the second `PassManager` at all
 *    rather than a cancellation-token side channel — the control flow is
 *    visible directly in this function's body, not hidden inside a pass.
 *
 * Never throws for a validation failure or a structural pass problem —
 * those come back as `ok({ valid: false, ... })`, consistent with
 * `validateGraph`'s own "never throws, caller branches on `report.valid`"
 * contract (see `validate-pass.ts`'s doc comment). `Result`'s `err` path
 * is reserved for genuine system-level failure: the domain -> XOIR
 * conversion itself failing (a duplicate id inside a single input graph,
 * for instance — see `../xoir/knowledge-to-xoir.ts`), or a pass throwing
 * unexpectedly.
 */
export async function compileXoir(input: PipelineInput, options: CompileXoirOptions = {}): Promise<Result<CompiledXoirResult, XoError>> {
  const conversionResult = convertToXoir(input, options);
  if (!conversionResult.ok) return err(conversionResult.error);
  const rawGraph = conversionResult.value;

  const validationManager = new PassManager();
  validationManager.register(createXoirValidationPass());
  validationManager.register(createReasoningValidationPass());
  const validationRun = await validationManager.run(rawGraph, options.logger !== undefined ? { logger: options.logger } : {});
  if (!validationRun.ok) return err(validationRun.error);

  const structuralValidation = validateGraph(rawGraph);
  const hasSemanticErrors = validationRun.value.diagnostics.some((d) => d.severity === 'error');
  const valid = structuralValidation.valid && !hasSemanticErrors;

  if (!valid) {
    return ok({
      graph: rawGraph,
      valid: false,
      validation: structuralValidation,
      diagnostics: validationRun.value.diagnostics,
      passRuns: validationRun.value.runs,
      stats: rawGraph.stats(),
    });
  }

  const normalizationManager = new PassManager();
  normalizationManager.register(createXoirNormalizationPass());
  const normalizationRun = await normalizationManager.run(rawGraph, options.logger !== undefined ? { logger: options.logger } : {});
  if (!normalizationRun.ok) return err(normalizationRun.error);

  return ok({
    graph: normalizationRun.value.graph,
    valid: true,
    validation: structuralValidation,
    diagnostics: [...validationRun.value.diagnostics, ...normalizationRun.value.diagnostics],
    passRuns: [...validationRun.value.runs, ...normalizationRun.value.runs],
    stats: normalizationRun.value.graph.stats(),
  });
}
