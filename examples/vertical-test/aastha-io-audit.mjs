import { readFile } from 'node:fs/promises';
import { compileSources } from '@xo/compiler';

async function main() {
  const bytes = new Uint8Array(await readFile(new URL('./Aastha.pdf', import.meta.url)));
  const result = await compileSources([{ kind: 'pdf', bytes, sourcePath: 'Aastha.pdf' }], {});
  if (!result.ok) {
    console.error('COMPILE FAILED', result.error);
    return;
  }
  const { graph } = result.value;
  const capNodes = graph.allNodes().filter((n) => n.kind === 'capability');
  console.log(`capabilities: ${capNodes.length}\n`);
  for (const n of capNodes) {
    console.log(`--- ${n.id} ---`);
    console.log(`name: ${n.properties.name}`);
    console.log(`description: ${n.properties.description}`);
    console.log(`inputs: ${JSON.stringify(n.properties.inputs)}`);
    console.log(`outputs: ${JSON.stringify(n.properties.outputs)}`);
    const outgoing = graph.allEdges().filter((e) => e.fromId === n.id);
    const incoming = graph.allEdges().filter((e) => e.toId === n.id);
    for (const e of outgoing) {
      const target = graph.allNodes().find((x) => x.id === e.toId);
      console.log(`  --[${e.kind}]--> (${target?.kind}) ${target?.properties.name ?? target?.properties.summary ?? target?.properties.definition ?? ''}`);
    }
    for (const e of incoming) {
      const source = graph.allNodes().find((x) => x.id === e.fromId);
      console.log(`  <--[${e.kind}]-- (${source?.kind}) ${source?.properties.name ?? source?.properties.summary ?? source?.properties.definition ?? ''}`);
    }
    console.log();
  }

  console.log('\n=== all concept nodes (name/text) ===');
  for (const n of graph.allNodes().filter((n) => n.kind === 'concept')) {
    console.log(`${n.id}: subtype=${n.metadata?.subtype ?? '(none)'} props=${JSON.stringify(n.properties)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
