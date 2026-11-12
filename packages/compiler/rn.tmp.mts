import { readFileSync } from 'node:fs';
import { collectSources } from '../../apps/cli/dist/commands/compiler/source-collection.js';
import { compileSources } from './src/pipeline/compile-sources.js';
const f=process.argv[2]!; 
const c:any = await collectSources([f]); 
const r:any = await compileSources(c.inputs,{});
import { nodesOfKind } from '@xo/xoir';
for (const n of nodesOfKind(r.value.graph,'constraint') as any[]) console.log('constraint', JSON.stringify({label:n.label ?? n.properties.rule, sev:n.properties.severity, meta: n.metadata ?? undefined, refs:(n.sourceRefs??[]).length}).slice(0,200), Object.keys(n));
