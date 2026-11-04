import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BundleIntegrityError, createCapabilityLayer } from '@xo/capability-layer';
import {
  DETERMINISTIC_HOST,
  determinismReport,
  evaluateDecide,
  negotiateWorkflows,
  validateAgainstBundle,
  validateWorkflowComponent,
  type DecideStep,
} from '@xo/workflow-ir';
import { FREIGHT_TREE, adjudicate, buildGoldXo, freightClaimWorkflowIr, generateEvalTasks } from '../src/index.js';
import { WorkflowLoadError, workflowsFromLayer } from '@xo/workflow-ir';

describe('freight claims as Workflow IR 1.0 (reference example)', () => {
  const ir = freightClaimWorkflowIr();

  it('validates strictly and against the gold XO decision tree', () => {
    const v = validateWorkflowComponent(ir);
    assert.deepEqual(
      v.issues.filter((i) => i.severity === 'error'),
      [],
    );
    const x = validateAgainstBundle(ir, { decisionTrees: { trees: [FREIGHT_TREE] } });
    assert.deepEqual(x.issues, []);
  });

  it('refuses when the tree is missing from the package', () => {
    const x = validateAgainstBundle(ir, { decisionTrees: { trees: [] } });
    assert.ok(x.issues.some((i) => i.code === 'TREE_NOT_FOUND'));
  });

  it('its decide step reproduces the independent oracle on fresh seeds (no model, no network)', () => {
    const step = ir.workflows[0]!.steps.find((s) => s.id === 'adjudicate') as DecideStep;
    const trees = new Map([[FREIGHT_TREE.id, FREIGHT_TREE]]);
    let n = 0;
    for (const seed of [9101, 9202]) {
      for (const t of generateEvalTasks(seed)) {
        const facts = Object.fromEntries(Object.entries(t.facts).map(([k, v]) => [k, v ?? null]));
        const r = evaluateDecide(step, facts, { trees });
        assert.ok(r.ok, `${t.id}: ${JSON.stringify(r)}`);
        const o = adjudicate(t.facts);
        assert.equal(r.outputs['decision'], o.decision, t.id);
        assert.equal(r.outputs['payout_usd'], o.payout_usd, t.id);
        n++;
      }
    }
    assert.ok(n >= 50);
  });

  it('an absent fact escalates instead of guessing', () => {
    const step = ir.workflows[0]!.steps.find((s) => s.id === 'adjudicate') as DecideStep;
    const r = evaluateDecide(step, { claim_type: 'damage' }, { trees: new Map([[FREIGHT_TREE.id, FREIGHT_TREE]]) });
    assert.equal(r.ok, false);
  });

  it('needs a model only for the free-text extract step; a deterministic-only host refuses it whole', () => {
    const rep = determinismReport(ir.workflows[0]!);
    assert.equal(rep.counts.model_assisted, 1);
    assert.equal(rep.steps.find((s) => s.step === 'extract_facts')?.bypassable, true);
    assert.deepEqual(negotiateWorkflows(ir, DETERMINISTIC_HOST).runnable, []);
    const withModel = negotiateWorkflows(ir, {
      ...DETERMINISTIC_HOST,
      features: [...DETERMINISTIC_HOST.features, 'model_extract'],
      modelCapabilities: ['structured_output'],
    });
    assert.deepEqual(withModel.runnable, ['freight_claims']);
  });

  it('ships as a hash-covered package component: verified by the layer, loaded with cross-checks, L3', () => {
    const bundle = buildGoldXo({ workflows: ir });
    const layer = createCapabilityLayer(bundle, { host: { family: 'claude', capabilities: ['chat', 'tool_use'] } });
    assert.equal(layer.emitLoadReceipt().level, 'L3');
    assert.ok(layer.emitLoadReceipt().consumed.includes('workflows'));
    const loaded = workflowsFromLayer(layer);
    assert.equal(loaded?.component.workflows[0]?.id, 'freight_claims');
  });

  it('a family whose manifest entry does not list workflows skips them (recorded, not errored); no component means undefined', () => {
    const bundle = buildGoldXo({ workflows: ir });
    const generic = createCapabilityLayer(bundle, { host: { family: 'generic', capabilities: ['chat'] } });
    assert.equal(workflowsFromLayer(generic), undefined);
    assert.ok(generic.emitLoadReceipt().skipped.some((x) => x.kind === 'workflows'));
    const none = createCapabilityLayer(buildGoldXo(), { host: { family: 'claude', capabilities: ['chat', 'tool_use'] } });
    assert.equal(workflowsFromLayer(none), undefined);
  });

  it('tampering with the workflow bytes is caught by bundle integrity, before any workflow is parsed', () => {
    const bundle = buildGoldXo({ workflows: ir });
    const tampered = {
      ...bundle,
      components: bundle.components.map((c) =>
        c.kind === 'workflows'
          ? { ...c, data: new TextEncoder().encode(new TextDecoder().decode(c.data).replace('decisions/approved', 'decisions/evil')) }
          : c,
      ),
    };
    assert.throws(
      () => createCapabilityLayer(tampered, { host: { family: 'claude', capabilities: ['chat', 'tool_use'] } }),
      BundleIntegrityError,
    );
  });

  it('a signed-but-invalid workflow component is refused at load (never partially loaded)', () => {
    const bad = {
      ...ir,
      workflows: [
        {
          ...ir.workflows[0]!,
          steps: ir.workflows[0]!.steps.map((s) => (s.id === 'file_approved' ? { ...s, idempotencyKey: undefined } : s)),
        },
      ],
    };
    const bundle = buildGoldXo({ workflows: bad });
    const layer = createCapabilityLayer(bundle, { host: { family: 'claude', capabilities: ['chat', 'tool_use'] } });
    assert.throws(() => workflowsFromLayer(layer), WorkflowLoadError);
  });
});
