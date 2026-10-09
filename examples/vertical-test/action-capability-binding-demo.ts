import { readFile } from 'node:fs/promises';
import { compileSources } from '@xo/compiler';
import { buildSemanticCapabilityContract } from '@xo/capability-contract';
import { ActionEscalationBindingResolver, StructuredComparisonBindingResolver, resolveCapabilityBinding } from '@xo/capability-contract';
import { RuntimeCapabilityRegistry, RuntimeCapabilityExecutor, registerResolvedCapabilityBinding } from '@xo/runtime';
import { PermissionManager, RuleBasedPolicy } from '@xo/permissions';

async function main() {
  const bytes = new Uint8Array(await readFile(new URL('./Aastha.pdf', import.meta.url)));
  const input = { kind: 'pdf', bytes, sourcePath: 'Aastha.pdf' };
  const result = await compileSources([input], {});
  if (!result.ok) { console.error(result.error); return; }
  const { graph } = result.value;

  const capNodes = graph.allNodes().filter(n => n.kind === 'capability');
  console.log(`Discovered capability nodes: ${capNodes.length}`);

  const contracts = [];
  for (const cap of capNodes) {
    const c = buildSemanticCapabilityContract(graph, cap.id);
    if (c.ok) contracts.push(c.value);
  }
  console.log(`Contracted: ${contracts.length}`);

  const resolvers = [new StructuredComparisonBindingResolver(), new ActionEscalationBindingResolver()];
  let hitlCount = 0, detCount = 0, unresolvedCount = 0;
  let firstHitl: any = null;
  for (const c of contracts) {
    const outcome = resolveCapabilityBinding(c, resolvers);
    if (outcome.status === 'resolved' && outcome.binding.implementationClass === 'human_in_the_loop') {
      hitlCount++;
      if (!firstHitl) firstHitl = { contract: c, binding: outcome.binding };
    } else if (outcome.status === 'resolved' && outcome.binding.implementationClass === 'deterministic_rule') {
      detCount++;
    } else {
      unresolvedCount++;
    }
  }
  console.log(`Bound (human_in_the_loop): ${hitlCount}`);
  console.log(`Bound (deterministic_rule): ${detCount}`);
  console.log(`Unresolved: ${unresolvedCount}`);

  if (!firstHitl) { console.log('No HITL binding found — nothing to demo end-to-end'); return; }

  console.log('\n--- Real capability demonstration ---');
  console.log('Capability:', firstHitl.contract.name);
  console.log('Contract id:', firstHitl.contract.id);
  console.log('actionKnowledgeRefs:', JSON.stringify(firstHitl.contract.actionKnowledgeRefs));
  console.log('sourceXoirNodeIds:', JSON.stringify(firstHitl.contract.sourceXoirNodeIds));
  console.log('binding.implementationClass:', firstHitl.binding.implementationClass);
  console.log('binding.derivation:', JSON.stringify(firstHitl.binding.derivation));

  const registry = new RuntimeCapabilityRegistry();
  const regResult = registerResolvedCapabilityBinding(registry, firstHitl.contract, firstHitl.binding);
  console.log('Registered:', regResult.ok);

  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }) });
  const execResult = await executor.execute({ capabilityId: firstHitl.contract.id, input: { demo: true }, confidenceScore: firstHitl.contract.confidence, minConfidence: 0.4 });
  console.log('Execution result ok:', execResult.ok);
  if (execResult.ok) console.log('Execution output:', JSON.stringify(execResult.value.output, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
