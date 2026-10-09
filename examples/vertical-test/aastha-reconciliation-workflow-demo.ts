import { readFile } from 'node:fs/promises';
import { compileSources } from '@xo/compiler';
import { composeWorkflows } from '@xo/workflow-composer';

/**
 * Phase 4 deliverable: SOURCE -> process/action realization -> candidate
 * workflow -> workflow steps -> capability references, for the real
 * Aastha reconciliation fixture. Every field printed here traces back to
 * something `@xo/compiler` and `@xo/workflow-composer` actually
 * produced — nothing in this script invents evidence.
 *
 * Run with: node --import tsx examples/vertical-test/aastha-reconciliation-workflow-demo.ts
 */
async function main() {
  const bytes = new Uint8Array(await readFile(new URL('./Aastha.pdf', import.meta.url)));
  const input = { kind: 'pdf' as const, bytes, sourcePath: 'Aastha.pdf' };
  const result = await compileSources([input], {});
  if (!result.ok) {
    console.error('Compilation failed:', result.error);
    return;
  }
  const { graph } = result.value;

  const capabilityCount = graph.allNodes().filter((n) => n.kind === 'capability').length;
  console.log(`Discovered capability nodes: ${capabilityCount}`);

  const composed = composeWorkflows(graph, { now: () => new Date().toISOString() });
  if (!composed.ok) {
    console.error('Workflow composition failed:', composed.error);
    return;
  }

  console.log(`Candidate workflows: ${composed.value.length}\n`);

  for (const workflow of composed.value) {
    console.log('='.repeat(72));
    console.log(`Workflow: ${workflow.name}`);
    console.log(`  id: ${workflow.id}`);
    if (workflow.processGrouping) {
      console.log(`  process (source section): ${workflow.processGrouping.sectionPath.join(' > ')}`);
      if (workflow.processGrouping.processConceptNodeId) {
        console.log(`  process concept node: ${workflow.processGrouping.processConceptNodeId}`);
      }
    } else {
      console.log('  process (source section): none — steps do not share one exact sectionPath');
    }
    console.log(`  confidence: ${workflow.confidence}   requiresHumanDecision: ${workflow.requiresHumanDecision}`);
    console.log('  steps:');
    for (const step of workflow.steps) {
      console.log(`    [${step.order}] ${step.capabilityName}  (capability id: ${step.capabilityId})`);
      console.log(`         confidence: ${step.confidence}`);
      console.log(`         source evidence: ${JSON.stringify(step.evidence)}`);
      const logical = step.rationale.orderedAfter.filter((o) => o.evidenceStrength === 'logical');
      const sourceDerived = step.rationale.orderedAfter.filter((o) => o.evidenceStrength === 'source_derived');
      if (logical.length > 0) {
        console.log(`         ordered after (real dependency): ${logical.map((o) => `${o.capabilityId} via ${o.viaEdgeKind}`).join(', ')}`);
      }
      if (sourceDerived.length > 0) {
        console.log(`         ordered after (source sequence only — NOT a proven dependency): ${sourceDerived.map((o) => `${o.capabilityId} via ${o.viaEdgeKind}`).join(', ')}`);
      }
      if (step.rationale.tieBroken && step.rationale.orderedAfter.length === 0) {
        console.log('         position: no relationship to any sibling step — placed by deterministic tie-break');
      }
    }
    if (workflow.gaps.length > 0) {
      console.log('  gaps (why you should not treat this order as fully authoritative):');
      for (const gap of workflow.gaps) {
        console.log(`    - [${gap.kind}] ${gap.description}`);
      }
    }
    console.log();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
