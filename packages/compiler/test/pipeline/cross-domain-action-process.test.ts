import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleBasedKnowledgeExtractor } from '../../src/knowledge/rule-based-extractor.js';
import { RuleBasedCapabilityExtractor } from '../../src/capabilities/rule-based-extractor.js';
import { RuleBasedReasoningExtractor } from '../../src/reasoning/rule-based-extractor.js';
import type { ExperienceUnit } from '../../src/semantic/types.js';
import type { KnowledgeGraph } from '../../src/knowledge/types.js';

/**
 * Checked-in version of the 29-sentence, 4-domain measurement harness
 * used by the Action/Process Realization investigation to establish the
 * baseline this milestone improves on. Verifies the *semantic outcome*
 * (does the primary knowledge node become `action`/`process` where it
 * should, does a capability candidate appear where it should) rather
 * than merely "some node exists" — and pins the reasoning-node count at
 * zero throughout, since this milestone must not move that number at
 * all (§9 of the milestone brief: any increase there is category
 * leakage from the knowledge layer into the reasoning layer).
 */

function makeUnit(content: string, semanticType: ExperienceUnit['semanticType'] = 'general'): ExperienceUnit {
  return {
    id: `u_${content.length}_${content.charCodeAt(0)}` as ExperienceUnit['id'],
    title: content.slice(0, 40),
    semanticType,
    content,
    provenance: { documentPath: 'cross-domain.md', pages: [1], sectionPath: ['Measurement'], blockProvenance: [], blockIndexRange: [0, 0] },
    hierarchy: { depth: 1, parentUnitId: undefined, siblingUnitIds: [] },
    confidence: 1,
    relationships: [],
    documentReferences: [],
    metadata: {},
  };
}

const knowledgeExtractor = new RuleBasedKnowledgeExtractor();
const capabilityExtractor = new RuleBasedCapabilityExtractor();
const reasoningExtractor = new RuleBasedReasoningExtractor();
const emptyGraph: KnowledgeGraph = { nodes: [], edges: [] };

interface Case {
  readonly domain: string;
  readonly text: string;
  readonly expectedKnowledgeKind: 'action' | 'process' | 'concept';
  readonly expectCapability: boolean;
  /** Reasoning-node count Stage 7 already produced for this sentence *before* this milestone (via its unrelated, unmodified `if`/`must` cue patterns) — pinned explicitly so the harness proves "unchanged from baseline", not "always zero". Defaults to 0. */
  readonly expectedReasoningCount?: number;
}

const CASES: readonly Case[] = [
  // A. Insurance/operations (Aastha)
  { domain: 'A-insurance', text: 'Identify Actual brokerage (Basic + Incentives).', expectedKnowledgeKind: 'action', expectCapability: true },
  { domain: 'A-insurance', text: 'Match CRM records vs. Insurer statements.', expectedKnowledgeKind: 'action', expectCapability: true },
  { domain: 'A-insurance', text: 'Verify Expected Brokerage vs. Actual Brokerage.', expectedKnowledgeKind: 'action', expectCapability: true },
  { domain: 'A-insurance', text: 'Reconcile invoice amounts vs. receipt amounts.', expectedKnowledgeKind: 'action', expectCapability: true },
  { domain: 'A-insurance', text: 'Validate TDS and GST figures.', expectedKnowledgeKind: 'action', expectCapability: true },
  { domain: 'A-insurance', text: 'Calculate and book TDS for each receipt.', expectedKnowledgeKind: 'action', expectCapability: true },
  { domain: 'A-insurance', text: 'Generate monthly MIS reports.', expectedKnowledgeKind: 'action', expectCapability: true },
  // B. API documentation
  { domain: 'B-api', text: 'Create a resource.', expectedKnowledgeKind: 'action', expectCapability: true },
  { domain: 'B-api', text: 'Validate parameters.', expectedKnowledgeKind: 'action', expectCapability: true },
  { domain: 'B-api', text: 'Send a request.', expectedKnowledgeKind: 'action', expectCapability: true },
  { domain: 'B-api', text: 'Handle a response.', expectedKnowledgeKind: 'action', expectCapability: true },
  { domain: 'B-api', text: 'Retry a failed request.', expectedKnowledgeKind: 'action', expectCapability: true },
  { domain: 'B-api', text: 'Calculate a value.', expectedKnowledgeKind: 'action', expectCapability: true },
  { domain: 'B-api', text: 'Authenticate before calling an endpoint.', expectedKnowledgeKind: 'action', expectCapability: true },
  // Capability presence flips to true here relative to the original investigation harness:
  // "retry" is now a recognized capability verb (§3 of this milestone), so this sentence
  // correctly gains a capability candidate even though it is *also* still a Stage 7 `rule`
  // node (unchanged, unrelated) — the two analyses are independent and this sentence
  // legitimately satisfies both.
  { domain: 'B-api', text: 'If the response status is 429, wait and retry.', expectedKnowledgeKind: 'concept', expectCapability: true, expectedReasoningCount: 1 },
  // C. Technical procedure/checklist
  { domain: 'C-checklist', text: 'Install the dependency.', expectedKnowledgeKind: 'action', expectCapability: true },
  { domain: 'C-checklist', text: 'Configure the environment.', expectedKnowledgeKind: 'action', expectCapability: true },
  { domain: 'C-checklist', text: 'Restart the service.', expectedKnowledgeKind: 'action', expectCapability: true },
  { domain: 'C-checklist', text: 'Verify the health endpoint.', expectedKnowledgeKind: 'action', expectCapability: true },
  { domain: 'C-checklist', text: 'Collect logs.', expectedKnowledgeKind: 'action', expectCapability: true },
  { domain: 'C-checklist', text: 'Deploy the service.', expectedKnowledgeKind: 'action', expectCapability: true },
  // D. General/non-technical (handbook-style)
  { domain: 'D-handbook', text: 'Review the submitted information.', expectedKnowledgeKind: 'action', expectCapability: true },
  { domain: 'D-handbook', text: 'Record the result in the system.', expectedKnowledgeKind: 'action', expectCapability: true },
  { domain: 'D-handbook', text: 'Confirm the customer details.', expectedKnowledgeKind: 'action', expectCapability: true },
  { domain: 'D-handbook', text: 'Collect the required documents.', expectedKnowledgeKind: 'action', expectCapability: true },
  { domain: 'D-handbook', text: 'Escalate unresolved cases.', expectedKnowledgeKind: 'action', expectCapability: true },
  // Layer 1A (P0.9 Beta, see benchmark/CHANGELOG.md) closed exactly this pattern: a headless
  // unit whose synthesized title equals its content and happens to contain a
  // CATEGORY_TITLE_KEYWORDS word ("process") no longer gets title-path capability evidence —
  // only a genuine authored heading (unit.headingTitle, which makeUnit above never sets) does.
  // This sentence has no capability verb of its own ("consists of" is descriptive, not
  // actionable), so it correctly produces no capability candidate post-Layer-1A; it did
  // pre-Layer-1A only via the now-closed false-positive path. expectCapability flips true -> false.
  { domain: 'D-handbook', text: 'The process consists of A, B, and C.', expectedKnowledgeKind: 'process', expectCapability: false },
  { domain: 'D-handbook', text: 'Employees must complete the training within 30 days of hire.', expectedKnowledgeKind: 'concept', expectCapability: false, expectedReasoningCount: 1 },
];

for (const c of CASES) {
  test(`[${c.domain}] "${c.text}" -> knowledge:${c.expectedKnowledgeKind}, capability:${c.expectCapability}, reasoning:${c.expectedReasoningCount ?? 0}`, async () => {
    const unit = makeUnit(c.text);

    const kResult = await knowledgeExtractor.extract(unit);
    assert.ok(kResult.ok);
    if (!kResult.ok) return;
    const primary = kResult.value.nodes.find((n) => n.isUnitPrimary)!;
    assert.equal(primary.semanticType, c.expectedKnowledgeKind, `knowledge kind mismatch for "${c.text}"`);

    const cResult = await capabilityExtractor.extract(unit, emptyGraph);
    assert.ok(cResult.ok);
    if (!cResult.ok) return;
    assert.equal(cResult.value.capabilities.length > 0, c.expectCapability, `capability presence mismatch for "${c.text}"`);

    // Pinned per the milestone brief §9: this milestone must never increase reasoning-node counts beyond whatever Stage 7 already, independently produced before this milestone existed.
    const rResult = await reasoningExtractor.extract(unit);
    assert.ok(rResult.ok);
    if (!rResult.ok) return;
    assert.equal(rResult.value.nodes.length, c.expectedReasoningCount ?? 0, `reasoning node count regressed for "${c.text}" — category leakage from knowledge into reasoning`);
  });
}
