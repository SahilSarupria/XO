import type { DecisionTree } from '@xo/capability-layer';
import type { ConnectorDecl, FieldSpec, Step, WorkflowComponent } from '@xo/workflow-ir';
import { FREIGHT_TREE } from './gold-xo.js';

/**
 * The freight claim desk expressed as Workflow IR 1.0 — the reference example for
 * docs/WORKFLOW_IR.md. It is the same behaviour `freightClaimWorkflow` wires by hand
 * (structured intake solved locally with no model; free-text narrative extracted once,
 * grounded; then a deterministic tree; then routed by decision), but as portable data:
 * no code, no host paths, no provider names.
 *
 * Extract outputs are generated from the tree's declared inputs so the two cannot drift.
 */

const factSpec = (i: DecisionTree['inputs'][number]): FieldSpec => ({
  type: i.enum !== undefined ? 'enum' : i.type,
  ...(i.enum !== undefined ? { enum: i.enum } : {}),
  description: i.description,
  nullable: true,
});

export function freightClaimWorkflowIr(tree: DecisionTree = FREIGHT_TREE): WorkflowComponent {
  const facts = Object.fromEntries(tree.inputs.map((i) => [i.name, factSpec(i)]));
  const factInputs = Object.fromEntries(tree.inputs.map((i) => [i.name, { from: `steps.extract_facts.${i.name}`, optional: false }]));

  const connectors: ConnectorDecl[] = [
    {
      id: 'desk_records',
      kind: 'file',
      operations: [{ name: 'write_record', sideEffect: 'write' }],
    },
  ];

  const writeRecord = (id: string, lane: string, branch: 'approved' | 'denied'): Step => ({
    id,
    type: 'act',
    determinism: 'deterministic',
    needs: ['route'],
    runIf: `route == '${branch}'`,
    inputs: {
      route: { from: 'steps.route.route' },
      claim_id: { from: 'input.claim_id' },
      decision: { from: 'steps.adjudicate.decision' },
      payout_usd: { from: 'steps.adjudicate.payout_usd' },
      reason_code: { from: 'steps.adjudicate.reason_code' },
      lane: { const: lane },
    },
    timeoutMs: 10_000,
    retry: { maxAttempts: 3, backoff: { kind: 'exponential', baseMs: 200, maxMs: 5_000, jitter: 'full' } },
    connector: 'desk_records',
    operation: 'write_record',
    sideEffect: 'write',
    idempotencyKey: `${lane}:{{input.claim_id}}`,
    onError: 'escalate',
  });

  return {
    formatVersion: '1.0',
    semanticsVersion: '1.0',
    connectors,
    workflows: [
      {
        id: 'freight_claims',
        version: '1.0.0',
        description:
          'Adjudicate a freight claim: structured intake or narrative in, decision out, anything the rules cannot decide goes to a person.',
        triggers: [
          { id: 'claim_webhook', kind: 'webhook', route: 'claims/intake', auth: 'hmac' },
          { id: 'claim_dropbox', kind: 'directory', source: 'claim_inbox', pattern: '*.json' },
          { id: 'claim_api', kind: 'api' },
        ],
        inputs: {
          claim_id: { type: 'string', required: true },
          narrative: { type: 'string', maxBytes: 65_536 },
          facts: { type: 'json', maxBytes: 16_384 },
        },
        steps: [
          {
            id: 'extract_facts',
            type: 'extract',
            determinism: 'model_assisted',
            description:
              'Structured intake bypasses the model; a bare narrative is read once into facts that must be quoted from the text.',
            instruction:
              'Extract the claim facts exactly as stated in the narrative. Leave a fact null when the narrative does not state it. Quote the sentence each fact comes from.',
            requires: ['structured_output'],
            structuredFirst: true,
            grounding: 'quote_required',
            maxModelCalls: 1,
            inputs: { text: { from: 'input.narrative', optional: true }, structured: { from: 'input.facts', optional: true } },
            outputs: facts,
            timeoutMs: 60_000,
            retry: { maxAttempts: 2, backoff: { kind: 'exponential', baseMs: 500, maxMs: 5_000, jitter: 'full' } },
            onError: 'escalate',
          },
          {
            id: 'adjudicate',
            type: 'decide',
            determinism: 'deterministic',
            needs: ['extract_facts'],
            method: { kind: 'tree', treeId: tree.id },
            inputs: factInputs,
            outputs: {
              decision: { type: 'enum', enum: ['approve', 'partial', 'deny', 'escalate'] },
              payout_usd: { type: 'number' },
              escalation_target: { type: 'string', nullable: true },
              reason_code: { type: 'string' },
            },
            timeoutMs: 5_000,
            onError: 'escalate',
          },
          {
            id: 'route',
            type: 'branch',
            determinism: 'deterministic',
            needs: ['adjudicate'],
            inputs: { decision: { from: 'steps.adjudicate.decision' } },
            cases: [
              { route: 'escalate', when: "decision == 'escalate'" },
              { route: 'denied', when: "decision == 'deny'" },
            ],
            default: 'approved',
            outputs: { route: { type: 'enum', enum: ['escalate', 'denied', 'approved'] } },
            timeoutMs: 1_000,
          },
          writeRecord('file_approved', 'decisions/approved', 'approved'),
          writeRecord('file_denied', 'decisions/denied', 'denied'),
          {
            id: 'escalate_to_manager',
            type: 'escalate',
            determinism: 'human',
            needs: ['route'],
            runIf: "route == 'escalate'",
            inputs: {
              route: { from: 'steps.route.route' },
              claim_id: { from: 'input.claim_id' },
              escalation_target: { from: 'steps.adjudicate.escalation_target', optional: false },
              reason_code: { from: 'steps.adjudicate.reason_code' },
            },
            target: '{{steps.adjudicate.escalation_target}}',
            reason: 'Claim {{input.claim_id}} is outside the desk authority ({{steps.adjudicate.reason_code}}).',
            lane: 'escalations',
            timeoutMs: 10_000,
          },
        ],
        result: {
          decision: { from: 'steps.adjudicate.decision' },
          payout_usd: { from: 'steps.adjudicate.payout_usd' },
        },
        maxConcurrency: 4,
        runTimeoutMs: 300_000,
        cancellation: { onCancel: 'abandon' },
        requiresFeatures: ['model_extract'],
      },
    ],
  };
}
