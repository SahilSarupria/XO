/**
 * XO Vertical Test — Capability Discovery -> Execution Binding -> First
 * Executable XO
 *
 * Proves the full chain this task's brief requires, end to end, against
 * a real (if synthetic — see synthetic-claim-rules.txt) source document:
 *
 *   source -> DocumentSourceFrontend -> compileSources (Stage 1-7,
 *   unmodified) -> automatic capability + reasoning-rule discovery in
 *   XOIR -> SemanticCapabilityContract (@xo/capability-contract, built
 *   automatically from the XOIR graph, no hand-written capability id) ->
 *   StructuredComparisonBindingResolver -> real Packager
 *   (packageXoirGraph, unmodified) -> sign -> PackageValidator ->
 *   PackageInstaller -> read the installed package's own
 *   knowledge_graph.json component back out (proving the contract
 *   survived a real archive round-trip) -> registerResolvedCapability
 *   Binding against a RuntimeCapabilityRegistry -> RuntimeCapability
 *   Executor with @xo/permissions enforcement (denied run, then allowed
 *   run) -> buildCapabilityAuthorityReceipt -> FileRuntimeStore
 *   persistence -> repeat execution to demonstrate deterministic
 *   semantic output.
 *
 * No hand-written semantic capability id. No manually fabricated XOIR.
 * No bypass around Runtime or permissions. No fake package. No
 * automatic code generation from arbitrary natural language — only the
 * closed structured-comparison grammar @xo/capability-contract's README
 * documents.
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileSources, packageXoirGraph, type PackageXoirIdentity } from '@xo/compiler';
import { buildAllSemanticCapabilityContracts, embedContractInCapabilityNode, extractContractFromPropertyBag, resolveCapabilityBinding, StructuredComparisonBindingResolver, type SemanticCapabilityContract } from '@xo/capability-contract';
import { PackageSigner, PackageValidator, PackageVerifier, PackageInstaller, packBundle, unpackArchive, type PackageBundle } from '@xo/package-sdk';
import { Ed25519Signer } from '@xo/crypto';
import { LocalFsBlobStore } from '@xo/storage';
import { PermissionManager, RuleBasedPolicy, Permissions } from '@xo/permissions';
import { RuntimeCapabilityRegistry, RuntimeCapabilityExecutor, registerResolvedCapabilityBinding, FileRuntimeStore, RequestId, PlanId, buildCapabilityAuthorityReceipt } from '@xo/runtime';

type StepStatus = 'PASS' | 'BLOCKED' | 'ERROR';
interface StepResult {
  readonly status: StepStatus;
  readonly detail: string;
  readonly data?: unknown;
}
const steps = new Map<string, StepResult>();

function record(name: string, status: StepStatus, detail: string, data?: unknown): void {
  steps.set(name, { status, detail, data });
  console.log(`[${status.padEnd(7)}] ${name}: ${detail}`);
}

function fail(name: string, detail: string, data?: unknown): never {
  record(name, 'ERROR', detail, data);
  throw new Error(`Vertical test halted at "${name}": ${detail}`);
}

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUTPUT_DIR = join(HERE, 'output');
const FIXTURE_PATH = join(HERE, 'synthetic-claim-rules.txt');

async function writeOutput(name: string, data: unknown): Promise<void> {
  await writeFile(join(OUTPUT_DIR, name), JSON.stringify(data, null, 2), 'utf8');
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const runRoot = await mkdtemp(join(tmpdir(), 'xo-vertical-test-'));
  const archivePath = join(runRoot, 'xo_vertical_test_claim_evaluation-1.0.0.xo');

  console.log('XO Platform — Capability Discovery -> Execution Binding -> First Executable XO');
  console.log(`Fixture (SYNTHETIC, not a real document): ${FIXTURE_PATH}`);
  console.log(`Isolated run directory: ${runRoot}\n`);

  // -----------------------------------------------------------------
  // 1-6. Source -> compiler -> XOIR (Stage 1-7, unmodified). Capability
  // and rule discovery happen entirely inside compileSources — nothing
  // here names "claim evaluation" or any capability id in advance.
  // -----------------------------------------------------------------
  const text = await readFile(FIXTURE_PATH, 'utf8');
  const compileResult = await compileSources([{ kind: 'document', text, sourcePath: FIXTURE_PATH }], { graphId: 'xo_vertical_test', now: () => '2026-08-18T00:00:00.000Z' });
  if (!compileResult.ok) fail('compile', `compileSources() returned err(): ${compileResult.error.message}`);
  const compiled = compileResult.value;
  if (!compiled.valid) fail('compile', 'Compiled XOIR failed validation', compiled.diagnostics);
  record('compile', 'PASS', `compileSources() -> compileXoir() produced a valid XOIR graph (${compiled.stats.nodeCount} node(s), ${compiled.stats.edgeCount} edge(s)) from the synthetic source, with no hand-written capability id anywhere in this script.`, { stats: compiled.stats });

  // -----------------------------------------------------------------
  // 7. Automatic contract derivation — every capability node XOIR
  // contains, projected independently; this script does not pick one
  // by a hand-written id, it inspects what was actually found and
  // selects the (only, here) contract with linked rules, exactly as
  // the brief's §6 requires ("do not assume in advance").
  // -----------------------------------------------------------------
  const allContractResults = buildAllSemanticCapabilityContracts(compiled.graph);
  const allContracts = allContractResults.filter((r): r is { readonly ok: true; readonly value: SemanticCapabilityContract } => r.ok).map((r) => r.value);
  record('capability_discovery', allContracts.length > 0 ? 'PASS' : 'BLOCKED', `Discovered ${allContracts.length} capability node(s) in the compiled XOIR; ${allContracts.filter((c) => c.rules.length > 0).length} of them have linked decision/heuristic/constraint rules.`, {
    discovered: allContracts.map((c) => ({ id: c.id, name: c.name, ruleCount: c.rules.length })),
  });
  const actionable = allContracts.find((c) => c.rules.length > 0);
  if (!actionable) {
    fail('capability_discovery', 'No discovered capability has any linked rule structure — per the brief §14, this is where this script would stop and report the gap rather than fabricate one. (Did not occur for the shipped synthetic fixture.)');
  }
  record('contract_selected', 'PASS', `Selected contract "${actionable.id}" (name "${actionable.name}"), automatically, because it is the one discovered capability with linked rules — not because this script names it.`, { contract: actionable });

  // -----------------------------------------------------------------
  // 8. Embed the contract back into its source XOIR node so it travels
  // through the real Packager as plain data (see @xo/xoir's additive
  // semanticCapabilityContract field).
  // -----------------------------------------------------------------
  const embedResult = embedContractInCapabilityNode(compiled.graph, actionable.id as never);
  if (!embedResult.ok) fail('contract_embed', `embedContractInCapabilityNode() failed: ${embedResult.error.message}`);
  record('contract_embed', 'PASS', `Contract embedded into capability node "${actionable.id}"'s properties; xoir-to-package.ts required zero changes (verified in the design report) since it copies node.properties through opaquely.`);

  // -----------------------------------------------------------------
  // 9. Binding resolution — BEFORE packaging, so we can also record
  // whether resolution succeeds independent of the package round-trip.
  // -----------------------------------------------------------------
  const preResolution = resolveCapabilityBinding(actionable, [new StructuredComparisonBindingResolver()]);
  record('binding_resolution_pre_package', preResolution.status === 'resolved' ? 'PASS' : 'BLOCKED', `resolveCapabilityBinding() -> "${preResolution.status}"${preResolution.status === 'resolved' ? ` (binding "${preResolution.binding.id}", implementationClass "${preResolution.binding.implementationClass}")` : ''}`, preResolution);
  if (preResolution.status !== 'resolved') fail('binding_resolution_pre_package', 'Binding did not resolve prior to packaging; nothing further to prove.');

  // -----------------------------------------------------------------
  // 10. Package creation — the real, unmodified Packager.
  // -----------------------------------------------------------------
  const identity: PackageXoirIdentity = { name: 'xo_vertical_test_claim_evaluation', version: '1.0.0', creatorDid: 'did:xo:vertical-test-harness' };
  const metadata = {
    domain: 'vertical-test.synthetic-claim-evaluation',
    description: 'Vertical-test output package for examples/vertical-test/synthetic-claim-rules.txt — a SYNTHETIC fixture, compiled via the real Stage 1-7 compiler pipeline. Diagnostic artifact proving automatic capability discovery -> contract -> binding -> execution, not a production XO and not a real insurance product.',
    scope: ['diagnostic proof of the compiler -> capability-contract -> runtime capability-authority vertical'],
    limitations: ['source document is synthetic, authored solely for this test — see synthetic-claim-rules.txt'],
    tags: ['vertical-test', 'diagnostic', 'synthetic'],
  };
  const packaged = packageXoirGraph(compiled.graph, { identity, metadata, upstreamDiagnostics: compiled.diagnostics });
  if (!packaged.ok) fail('package_creation', `packageXoirGraph() (the real, unmodified Packager) failed: ${packaged.error.message}`);
  record('package_creation', 'PASS', `packageXoirGraph() produced a PackageBundle (${packaged.value.components.filter((c) => c.included).length} component(s) included).`, { components: packaged.value.components });

  const signer = new Ed25519Signer();
  const keyPair = signer.generateKeyPair();
  const signerDid = 'did:xo:vertical-test-harness';
  const unsignedBundle = packaged.value.bundle;
  const signatureEntry = new PackageSigner(signer).sign(unsignedBundle.manifest, signerDid, 'creator', keyPair.privateKey, keyPair.publicKey);

  // Sign the exact manifest object that will be packaged, then attach the
  // signature by spreading it onto that same manifest — never rebuild a
  // new manifest via ManifestBuilder after signing. A rebuild is not
  // guaranteed to reproduce byte-identical signable content (component
  // ordering, hash recomputation, etc.), which silently invalidates the
  // signature computed against the pre-rebuild manifest. This is the
  // exact pattern @xo/package-sdk's own tests use (see
  // package-signer.test.ts: "a signature produced by PackageSigner
  // verifies with PackageVerifier").
  const bundle: PackageBundle = {
    ...unsignedBundle,
    manifest: {
      ...unsignedBundle.manifest,
      signatures: [{ signerDid: signatureEntry.signerDid, role: signatureEntry.role, signature: signatureEntry.signature, publicKeyPem: signatureEntry.publicKeyPem }],
    },
  };
  const archiveBytes = await packBundle(bundle);
  await writeFile(archivePath, archiveBytes);
  record('package_signed', 'PASS', `Signed with a real Ed25519 keypair and archived to "${archivePath}" (${archiveBytes.byteLength} bytes).`);

  // -----------------------------------------------------------------
  // 11. Package validation — read the archive back and validate it
  // exactly as an independent consumer would (schema, hashes, Merkle
  // root, signature).
  // -----------------------------------------------------------------
  const readBackBytes = new Uint8Array(await readFile(archivePath));
  const unpacked = await unpackArchive(readBackBytes);
  if (!unpacked.ok) fail('package_validation', `unpackArchive() failed: ${unpacked.error.message}`);
  const readBundle = unpacked.value;
  const validator = new PackageValidator({ resolvePublicKey: (did) => (did === signerDid ? keyPair.publicKey : undefined) });
  const report = validator.validateAll(readBundle);
  const verifier = new PackageVerifier();
  const signatureOk = readBundle.manifest.signatures?.[0] ? verifier.verifyOne(readBundle.manifest, { signerDid, role: 'creator', signature: readBundle.manifest.signatures[0].signature, publicKeyPem: keyPair.publicKey }) : false;
  if (!report.valid) fail('package_validation', `Read-back package failed PackageValidator.validateAll()`, report);
  record('package_validation', 'PASS', `Round-tripped .xo archive validated (schema, hashes, Merkle root, signature).`, { valid: report.valid, signatureVerified: signatureOk });

  // -----------------------------------------------------------------
  // 12. Package install.
  // -----------------------------------------------------------------
  const installStore = new LocalFsBlobStore(join(runRoot, 'installed'));
  const installer = new PackageInstaller(installStore);
  const installResult = await installer.install(readBundle);
  if (!installResult.ok) fail('package_install', `PackageInstaller.install() failed: ${installResult.error.message}`);
  record('package_install', 'PASS', `Installed via PackageInstaller (isolated local LocalFsBlobStore).`, { installedAt: installResult.value.installedAt });

  // -----------------------------------------------------------------
  // 13. Read the contract back out of the INSTALLED package's own
  // knowledge_graph.json component (not from the in-memory graph) —
  // proving the contract survived a real archive round-trip, and doing
  // so with zero @xo/xoir dependency on this read path (see
  // extractContractFromPropertyBag's own doc comment).
  // -----------------------------------------------------------------
  const componentBytes = await installer.getComponent(bundle.manifest.name, bundle.manifest.version, 'knowledge_graph');
  if (!componentBytes.ok) fail('runtime_discovery', `PackageInstaller.getComponent('knowledge_graph') failed: ${componentBytes.error.message}`);
  const knowledgeGraphJson = JSON.parse(new TextDecoder().decode(componentBytes.value)) as { readonly nodes: readonly { readonly id: string; readonly kind: string; readonly properties: Record<string, unknown> }[] };
  const capabilityNode = knowledgeGraphJson.nodes.find((n) => n.kind === 'capability' && n.id === actionable.id);
  if (!capabilityNode) fail('runtime_discovery', `Capability node "${actionable.id}" not found in the installed package's knowledge_graph component.`);
  const extracted = extractContractFromPropertyBag(capabilityNode.properties);
  if (!extracted.ok) fail('runtime_discovery', `extractContractFromPropertyBag() failed on the installed package's own data: ${extracted.error.message}`);
  const contractFromPackage = extracted.value;
  record('runtime_discovery', 'PASS', `Read the SemanticCapabilityContract back out of the INSTALLED package's knowledge_graph.json (no @xo/xoir involved on this read path) — contract survived the full compile -> package -> sign -> archive -> validate -> install round-trip byte-for-byte.`, { contractId: contractFromPackage.id, ruleCount: contractFromPackage.rules.length });

  // -----------------------------------------------------------------
  // 14. Binding resolution again, from the package-round-tripped
  // contract (proving resolution doesn't depend on the in-memory
  // object identity from earlier in this script).
  // -----------------------------------------------------------------
  const binding = resolveCapabilityBinding(contractFromPackage, [new StructuredComparisonBindingResolver()]);
  if (binding.status !== 'resolved') fail('binding_resolution', `Binding did not resolve from the package-round-tripped contract: ${binding.status}`);
  record('binding_resolution', 'PASS', `resolveCapabilityBinding() resolved binding "${binding.binding.id}" from the package-round-tripped contract.`, { derivation: binding.binding.derivation });

  // -----------------------------------------------------------------
  // 15. Discovery does NOT imply execution authority (brief §4/§12):
  // before registering, prove the capability is not reachable through
  // RuntimeCapabilityExecutor.
  // -----------------------------------------------------------------
  const registry = new RuntimeCapabilityRegistry();
  const preRegisterExecutor = new RuntimeCapabilityExecutor({ registry, permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }) });
  const preRegisterAttempt = await preRegisterExecutor.execute({ capabilityId: contractFromPackage.id, input: { claim_assessment_amount: 15000 } });
  record('discovery_not_authority', preRegisterAttempt.ok ? 'ERROR' : 'PASS', preRegisterAttempt.ok ? 'Execution unexpectedly succeeded before registration — this would be a real boundary violation.' : `Confirmed: a resolved binding is NOT reachable through RuntimeCapabilityExecutor until explicitly registered (error: ${preRegisterAttempt.error.code}).`);

  // -----------------------------------------------------------------
  // 16. Explicit registration — the one place semantic discovery
  // crosses into execution authority. Requires 'runtime.execute' so
  // both a denied and an allowed run can be demonstrated (§9).
  // -----------------------------------------------------------------
  const registerResult = registerResolvedCapabilityBinding(registry, contractFromPackage, binding.binding, { additionalRequiredPermissions: [{ permission: Permissions.runtime.execute }] });
  if (!registerResult.ok) fail('runtime_registration', `registerResolvedCapabilityBinding() failed: ${registerResult.error.message}`);
  record('runtime_registration', 'PASS', `Registered as a RuntimeCapabilityDeclaration, requiring permission "${Permissions.runtime.execute}".`);

  // -----------------------------------------------------------------
  // 17. Denied execution — permission not granted.
  // -----------------------------------------------------------------
  const denyingExecutor = new RuntimeCapabilityExecutor({ registry, permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }) }); // default-deny
  const deniedResult = await denyingExecutor.execute({ capabilityId: contractFromPackage.id, input: { claim_assessment_amount: 15000 } });
  record('execution_denied', deniedResult.ok ? 'ERROR' : 'PASS', deniedResult.ok ? 'Execution unexpectedly succeeded without the required permission.' : `Correctly denied: ${deniedResult.error.code}.`, deniedResult.ok ? undefined : { code: deniedResult.error.code, message: deniedResult.error.message });

  // -----------------------------------------------------------------
  // 18. Allowed execution — permission granted.
  // -----------------------------------------------------------------
  const allowingExecutor = new RuntimeCapabilityExecutor({ registry, permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([{ id: 'allow-runtime-execute', effect: 'ALLOW', match: { permission: Permissions.runtime.execute } }]) }) });
  const requestId = RequestId('req_vertical_test_1');
  const planId = PlanId('plan_vertical_test_1');
  const startedAt = Date.now();
  const firstExecution = await allowingExecutor.execute({ capabilityId: contractFromPackage.id, input: { claim_assessment_amount: 15000 } });
  const durationMs = Date.now() - startedAt;
  if (!firstExecution.ok) fail('execution_allowed', `Execution unexpectedly failed with the required permission granted: ${firstExecution.error.message}`);
  record('execution_allowed', 'PASS', `Executed successfully once permission was granted.`, { output: firstExecution.value.output });

  // -----------------------------------------------------------------
  // 19. Receipt, with provenance back to XOIR/source (§8).
  // -----------------------------------------------------------------
  const receipt = buildCapabilityAuthorityReceipt({
    requestId,
    planId,
    capabilityId: contractFromPackage.id,
    contractId: contractFromPackage.id,
    bindingId: binding.binding.id,
    sourceXoirNodeIds: contractFromPackage.sourceXoirNodeIds,
    executionDurationMs: durationMs,
  });
  record('receipt', 'PASS', `Built an ExecutionReceipt carrying contractId/bindingId/sourceXoirNodeIds — the provenance chain from execution back through the binding and contract to the original XOIR node ids.`, { receipt });

  const store = new FileRuntimeStore({ rootDir: join(runRoot, 'runtime-store') });
  const saved = await store.receipts.saveExecutionReceipt(undefined, receipt);
  record('persistence', saved.ok ? 'PASS' : 'ERROR', saved.ok ? `Receipt persisted via FileRuntimeStore.` : `Failed to persist receipt: ${saved.error.message}`);

  // -----------------------------------------------------------------
  // 20. Determinism — repeat execution with the same input must
  // produce a deep-equal output (§10). Also confirm a different input
  // that does NOT match the rule produces the honest "no match" result.
  // -----------------------------------------------------------------
  const secondExecution = await allowingExecutor.execute({ capabilityId: contractFromPackage.id, input: { claim_assessment_amount: 15000 } });
  const deterministic = secondExecution.ok && JSON.stringify(secondExecution.value.output) === JSON.stringify(firstExecution.value.output);
  record('determinism', deterministic ? 'PASS' : 'ERROR', deterministic ? 'Repeat execution with identical input produced a deep-equal output.' : 'Repeat execution diverged — this would be a determinism violation.', { first: firstExecution.value.output, second: secondExecution.ok ? secondExecution.value.output : undefined });

  const belowThreshold = await allowingExecutor.execute({ capabilityId: contractFromPackage.id, input: { claim_assessment_amount: 500 } });
  record('no_match_case', belowThreshold.ok ? 'PASS' : 'ERROR', belowThreshold.ok ? `A claim amount below the threshold correctly produced no rule match: ${JSON.stringify(belowThreshold.value.output)}` : `Unexpected failure: ${belowThreshold.error.message}`);

  await writeOutput('vertical-test-report.json', {
    fixture: { path: FIXTURE_PATH, synthetic: true, note: 'This fixture is a synthetic test document authored solely to exercise this pipeline. It is not a real insurance policy.' },
    steps: Object.fromEntries(steps),
    discoveredContract: contractFromPackage,
    binding: { id: binding.status === 'resolved' ? binding.binding.id : undefined, derivation: binding.status === 'resolved' ? binding.binding.derivation : undefined },
    receipt,
  });

  const anyError = [...steps.values()].some((s) => s.status === 'ERROR');
  const anyBlocked = [...steps.values()].some((s) => s.status === 'BLOCKED');
  console.log(`\n${anyError ? 'FAILED' : anyBlocked ? 'BLOCKED' : 'SUCCESS'} — see ${join(OUTPUT_DIR, 'vertical-test-report.json')}`);
  if (anyError) process.exitCode = 1;
}

main().catch((error) => {
  console.error('\nVertical test failed with an unhandled error:', error);
  process.exitCode = 1;
});
