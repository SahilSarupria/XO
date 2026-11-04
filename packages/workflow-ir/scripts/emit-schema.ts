import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WORKFLOW_SCHEMA } from '../src/schema.js';

const out = fileURLToPath(new URL('../schema/workflow-1.0.schema.json', import.meta.url));
writeFileSync(out, `${JSON.stringify(WORKFLOW_SCHEMA, null, 2)}\n`);
console.log(`wrote ${out}`);
