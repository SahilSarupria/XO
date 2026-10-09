import { ok, type Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import type { KnowledgeGraph, KnowledgeProvenance } from '../knowledge/types.js';
import type { ExperienceUnit } from '../semantic/types.js';
import { UNKNOWN_SIGNATURE } from './types.js';
import type { CandidateCapability, CapabilityExtractionResult, CapabilityExtractor } from './extractor-types.js';

const OPERATION_NAME_FIELD = 'operation:name';
const OPERATION_INPUT_PREFIX = 'operation:input:';
const OPERATION_OUTPUT_PREFIX = 'operation:output:';
const OPERATION_REQUIRES_PREFIX = 'operation:requires:';

function baseProvenance(unit: ExperienceUnit, confidence: number): KnowledgeProvenance {
  return {
    experienceUnitId: unit.id,
    documentPath: unit.provenance.documentPath,
    pages: unit.provenance.pages,
    sectionPath: unit.provenance.sectionPath,
    charOffsetRange: [0, unit.content.length],
    confidence,
  };
}

function paramName(fieldName: string, prefix: string): string {
  return fieldName.slice(prefix.length);
}

/**
 * Structural-only, deterministic, never calls a network — same
 * "never fails" philosophy as `RuleBasedCapabilityExtractor`, and
 * composed alongside it (see `hybrid-extractor.ts`). Reads ONLY the
 * `operation:name` / `operation:input:*` / `operation:output:*`
 * structured-field namespace `structured-frontend.ts`'s explicit
 * `type: "operation"` recognition produces — never inspects prose, a
 * capability name, a rule outcome, `PRODUCES` edges, or any other
 * signal. A unit with none of these fields (the overwhelming majority —
 * every non-JSON/CSV unit, and every ordinary/non-operation JSON/CSV
 * record) yields zero candidates, unconditionally.
 *
 * This is the ONLY place in the compiler that ever populates
 * `CandidateCapability.outputs` with a real, non-empty value — see the
 * "Authoritative Capability I/O" milestone series (prior audits) for
 * why every other extractor correctly emits `outputs: []`. The
 * resulting `derivedFrom: 'declared'` classification (assigned later,
 * unchanged, by `@xo/capability-contract#parseParam` from the plain
 * `"name: type"` strings this extractor writes) reflects exactly what
 * it is: the source recording explicitly said so, nothing was inferred.
 */
export class StructuredOperationCapabilityExtractor implements CapabilityExtractor {
  readonly name = 'structured-operation';

  async extract(unit: ExperienceUnit, _knowledgeGraph: KnowledgeGraph): Promise<Result<CapabilityExtractionResult, XoError>> {
    const fields = unit.structuredFields ?? [];
    const nameField = fields.find((f) => f.fieldName === OPERATION_NAME_FIELD);
    if (!nameField || typeof nameField.rawValue !== 'string' || nameField.rawValue.trim().length === 0) {
      return ok({ capabilities: [], edges: [] });
    }

    const inputs = fields
      .filter((f) => f.fieldName.startsWith(OPERATION_INPUT_PREFIX))
      .map((f) => `${paramName(f.fieldName, OPERATION_INPUT_PREFIX)}: ${String(f.rawValue)}`);
    const outputs = fields
      .filter((f) => f.fieldName.startsWith(OPERATION_OUTPUT_PREFIX))
      .map((f) => `${paramName(f.fieldName, OPERATION_OUTPUT_PREFIX)}: ${String(f.rawValue)}`);
    const requires = fields.filter((f) => f.fieldName.startsWith(OPERATION_REQUIRES_PREFIX)).map((f) => String(f.rawValue));

    // P0.9A area B (Semantic I/O independence): the same input fields
    // that build the flattened `"name: type"` strings above genuinely
    // carry a real structured type (`f.rawValue`, e.g. `"number"`,
    // sourced from `structured-frontend.ts`'s OpenAPI/JSON-Schema
    // `type:` recognition — never a guess). Capture that structured map
    // *in addition to*, never instead of, the existing `inputs` strings,
    // so `@xo/capability-contract` can read it directly instead of
    // re-parsing it out of prose-shaped text.
    const inputTypeEntries = fields
      .filter((f) => f.fieldName.startsWith(OPERATION_INPUT_PREFIX))
      .map((f) => [paramName(f.fieldName, OPERATION_INPUT_PREFIX), String(f.rawValue)] as const);
    const inputTypes = inputTypeEntries.length > 0 ? Object.fromEntries(inputTypeEntries) : undefined;

    // Reuses `@xo/compiler`'s EXISTING, already-tested "content-mention
    // depends_on" mechanism (`relationship-builder.ts`, section 4)
    // completely unchanged: it scans every merged capability's
    // `description` for another capability's exact `canonicalName` and
    // creates a real `depends_on` (XOIR `DEPENDS_ON`) edge when found.
    // No new edge-resolution code, no cross-unit id plumbing — the
    // dependency shows up here as ordinary description text, exactly
    // like any other capability's description, and the existing
    // mechanism does the rest. `DEPENDS_ON` is neither `COMPLEMENTS`
    // nor `custom:sequence`, so `auditWorkflowDataFlow`'s structural
    // corroboration check accepts it — this is independent evidence
    // from a separately-declared source fact (`requires`), never
    // derived from the input/output parameter names themselves.
    const requiresClause = requires.length > 0 ? ` Requires: ${requires.join(', ')}.` : '';

    const capability: CandidateCapability = {
      localId: `structured-operation:${unit.id}`,
      category: 'action',
      name: nameField.rawValue,
      description: `Operation explicitly declared in a structured (JSON/CSV) source: ${nameField.rawValue}.${requiresClause}`,
      confidence: 0.95, // explicit source declaration, not inferred — matches rule-based-extractor's high-confidence explicit-command tier
      provenance: baseProvenance(unit, 0.95),
      inputs,
      outputs,
      ...(inputTypes !== undefined ? { inputTypes } : {}),
      requiredKnowledgeNodeIds: [],
      relatedConcepts: [],
      invocationHints: [],
      examples: [],
      signature: UNKNOWN_SIGNATURE,
      metadata: { sourceExtractor: this.name },
      sourceUnitId: unit.id,
    };

    return ok({ capabilities: [capability], edges: [] });
  }
}
