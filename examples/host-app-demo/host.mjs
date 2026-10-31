// A host application that consumes an .xo package. It imports ONLY the public surface:
//   @xo/package-sdk       unpackArchive            (read the .xo file)
//   @xo/capability-layer  createCapabilityLayer    (verify + expose the package)
// and works with NO model, NO network and NO API key. A model, if you have one, plugs in through layer.systemPromptFragments()
// and layer.toolDefinitions() (see the last section).
//
//   node examples/host-app-demo/make-package.mjs && node examples/host-app-demo/host.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unpackArchive } from '@xo/package-sdk';
import { BundleIntegrityError, createCapabilityLayer } from '@xo/capability-layer';

const bytes = readFileSync(fileURLToPath(new URL('./halvorsen.xo', import.meta.url)));
const unpacked = await unpackArchive(bytes);
if (!unpacked.ok) throw new Error(`cannot read package: ${unpacked.error.message}`);
const bundle = unpacked.value;

// 1. Load. Integrity (component hashes + Merkle root) is verified before anything is exposed; pass `trust` to also require signatures.
let layer;
try {
  layer = createCapabilityLayer(bundle, { host: { family: 'claude', capabilities: ['chat', 'tool_use'] } });
} catch (e) {
  if (e instanceof BundleIntegrityError) {
    console.error('REFUSED:', e.problems);
    process.exit(1);
  }
  throw e;
}
const receipt = layer.emitLoadReceipt();
console.log(`loaded ${receipt.xoName}@${receipt.xoVersion}  level=${receipt.level}  consumed=${receipt.consumed.join(',')}`);

// 2. Solve locally: structured facts go straight to the decision tree. Zero model calls.
const facts = {
  claim_type: 'damage',
  commodity_class: 'electronics',
  claimant_claims_last_90d: 0,
  days_to_file: 6,
  pod_damage_noted: false,
  packaging: 'carrier_packed',
  weight_lb: 400,
  declared_value_usd: 5000,
  full_value_coverage: false,
  damage_pct: 40,
  salvage_value_usd: 200,
};
const solved = layer.executeTool('evaluate_decision_tree', { facts });
console.log('\nlocal decision (no model):', solved.content.slice(0, 300));

// 3. A missing fact is reported, never guessed.
const missing = layer.executeTool('evaluate_decision_tree', { facts: { claim_type: 'damage' } });
console.log('\nincomplete input:', missing.isError ? 'error ->' : 'ok ->', missing.content.slice(0, 200));

// 4. The safety gate fails closed on an output outside the desk's authority.
const verdict = layer.safetyGate({ output: { decision: 'approve', payout_usd: 90000, escalation_target: null } });
console.log(
  '\nsafety gate on an approval of $90,000:',
  JSON.stringify({ allowed: verdict.allowed, override: verdict.override, why: verdict.violations.map((v) => v.message) }),
);

// 5. Retrieval for a model prompt, if you do call one.
console.log('\nretrieved context for a narrative:');
for (const n of layer.retrieve('Delivery was 4 days late because of a blizzard; the consignee wants compensation', 3))
  console.log(`  - [${n.kind}] ${n.text.slice(0, 90)}…`);
console.log(
  '\nto use a model: pass layer.systemPromptFragments() as the system prompt and layer.toolDefinitions() as its tools; route each tool call to layer.executeTool(name, input).',
);
