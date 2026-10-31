// Builds examples/host-app-demo/halvorsen.xo from the evaluation scenario's gold package, so the demo has a real .xo file to load.
// This is the ONLY file in the demo that touches evaluation code; the host app itself (host.mjs) uses the public layer API alone.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildGoldXo } from '@xo/ab-eval';
import { packBundle } from '@xo/package-sdk';

const out = fileURLToPath(new URL('./halvorsen.xo', import.meta.url));
writeFileSync(out, await packBundle(buildGoldXo()));
console.log(`wrote ${out}`);
