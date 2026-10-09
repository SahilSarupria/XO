/**
 * End-to-end walkthrough of @xo/package-sdk, exercising the public API
 * exactly as a real caller would — no mocks, no stubs, nothing faked. It
 * builds a small but genuinely valid Experience Object, signs it with a
 * freshly generated Ed25519 keypair, packs it into a real `.xo` archive
 * on disk, reads that archive back from scratch, validates it, installs
 * it into a real filesystem-backed `BlobStore`, and inspects the result.
 *
 * Run with: `npm run example` (from packages/package-sdk), or directly:
 *   node --import tsx examples/create-demo-package.ts
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { cwd } from 'node:process';
import type { CompatibilityDeclaration, XoMetadata } from '@xo/types';
import { Ed25519Signer } from '@xo/crypto';
import { LocalFsBlobStore } from '@xo/storage';

import { ManifestBuilder } from '../src/manifest/manifest-builder.js';
import { PackageSigner, PackageVerifier } from '../src/signing/package-signer.js';
import { packBundle } from '../src/archive/package-writer.js';
import { unpackArchive } from '../src/archive/package-reader.js';
import { PackageValidator } from '../src/validation/package-validator.js';
import { PackageInstaller } from '../src/install/package-installer.js';
import { inspectBundle } from '../src/inspect/package-inspector.js';
import type { PackageBundle } from '../src/types.js';

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
  const workDir = join(cwd(), "demo-output");

  await mkdir(workDir, {
      recursive: true
  });
  const archivePath = join(workDir, 'xo-demo-package-1.0.0.xo');

  try {
    // ------------------------------------------------------------------
    // 1-2. Build a minimal valid Experience Object package + its manifest
    // ------------------------------------------------------------------
    section('1-2. Building manifest identity + compatibility');

    const compatibility: CompatibilityDeclaration = {
      modelFamilies: [
        { family: 'claude', minCapability: ['chat', 'tool_use'], consumes: ['knowledge_graph', 'safety_rules', 'benchmark_suite'] },
        { family: 'generic', minCapability: ['chat'], consumes: ['knowledge_graph'] },
      ],
      fallbackPolicy: 'degrade_gracefully',
    };
    console.log(`Declared families: ${compatibility.modelFamilies.map((f) => f.family).join(', ')}`);

    // ------------------------------------------------------------------
    // 3. Add at least one knowledge graph component
    // 4. Add metadata
    // ------------------------------------------------------------------
    section('3-4. Adding a knowledge graph component + metadata');

    const knowledgeGraph = {
      nodes: [
        { id: 'contract_clause_indemnification', type: 'clause_type', label: 'Indemnification Clause' },
        { id: 'contract_clause_limitation_of_liability', type: 'clause_type', label: 'Limitation of Liability Clause' },
      ],
      edges: [{ from: 'contract_clause_indemnification', to: 'contract_clause_limitation_of_liability', relation: 'commonly_paired_with' }],
    };

    const safetyRules = {
      rules: [{ id: 'unauthorized_practice_of_law', trigger: 'hard', description: 'Never represent output as formal legal advice from a licensed attorney.' }],
    };

    const benchmarkSuite = {
      categories: [{ name: 'reasoning_quality', taskCount: 12 }],
    };

    const metadata: XoMetadata = {
      domain: 'demo.contract-clause-lookup',
      description: 'A minimal end-to-end demo XO used to exercise every stage of @xo/package-sdk. Not a real professional-capability package.',
      scope: ['contract clause identification', 'clause pairing suggestions'],
      limitations: ['not legal advice', 'covers only two example clause types', 'demo data, not production-quality'],
      tags: ['demo', 'package-sdk-example'],
    };
    console.log(`Metadata domain: "${metadata.domain}"`);

    const unsignedBuild = ManifestBuilder.create()
      .setIdentity({ formatVersion: '1.0', name: 'xo_demo_contract_clause_lookup', version: '1.0.0', creatorDid: 'did:xo:package-sdk-example' })
      .setCompatibility(compatibility)
      .setMetadata(metadata)
      .addComponent({ kind: 'knowledge_graph', path: 'knowledge/graph.json', data: new TextEncoder().encode(JSON.stringify(knowledgeGraph, null, 2)), required: false })
      .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new TextEncoder().encode(JSON.stringify(safetyRules, null, 2)), required: true })
      .addComponent({ kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', data: new TextEncoder().encode(JSON.stringify(benchmarkSuite, null, 2)), required: true })
      .build();

    if (!unsignedBuild.ok) throw new Error(`Manifest build failed: ${unsignedBuild.error.message}`);

    // ------------------------------------------------------------------
    // 5. Compute hashes and Merkle root
    // ------------------------------------------------------------------
    section('5. Hashes + Merkle root (computed by the builder itself)');
    for (const [kind, entry] of Object.entries(unsignedBuild.value.manifest.components)) {
      console.log(`  ${kind.padEnd(16)} ${entry.hash}`);
    }
    console.log(`  merkleRoot       ${unsignedBuild.value.manifest.merkleRoot}`);

    // ------------------------------------------------------------------
    // 6. Sign the package (development key)
    // ------------------------------------------------------------------
    section('6. Signing with a freshly generated development Ed25519 key');

    const signer = new Ed25519Signer();
    const devKeyPair = signer.generateKeyPair();
    console.log('Generated a fresh Ed25519 development keypair (not persisted anywhere).');

    const signatureEntry = new PackageSigner(signer).sign(
      unsignedBuild.value.manifest,
      'did:xo:package-sdk-example-creator',
      'creator',
      devKeyPair.privateKey,
      devKeyPair.publicKey,
    );
    console.log(`Signature (truncated): ${signatureEntry.signature.slice(0, 32)}...`);

    const signedBuild = ManifestBuilder.create()
      .setIdentity({ formatVersion: '1.0', name: 'xo_demo_contract_clause_lookup', version: '1.0.0', creatorDid: 'did:xo:package-sdk-example' })
      .setCompatibility(compatibility)
      .setMetadata(metadata)
      .addComponent({ kind: 'knowledge_graph', path: 'knowledge/graph.json', data: new TextEncoder().encode(JSON.stringify(knowledgeGraph, null, 2)), required: false })
      .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new TextEncoder().encode(JSON.stringify(safetyRules, null, 2)), required: true })
      .addComponent({ kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', data: new TextEncoder().encode(JSON.stringify(benchmarkSuite, null, 2)), required: true })
      .addSignature({ signerDid: signatureEntry.signerDid, role: signatureEntry.role, signature: signatureEntry.signature, publicKeyPem: signatureEntry.publicKeyPem })
      .build();

    if (!signedBuild.ok) throw new Error(`Signed manifest build failed: ${signedBuild.error.message}`);
    const bundle: PackageBundle = signedBuild.value;
    console.log(`Manifest now carries ${bundle.manifest.signatures?.length ?? 0} signature(s).`);

    // ------------------------------------------------------------------
    // 7. Serialize it into a real .xo archive
    // ------------------------------------------------------------------
    section('7. Packing into a real .xo archive (tar + zstd)');
    const archiveBytes = await packBundle(bundle);
    await writeFile(archivePath, archiveBytes);
    console.log(`Wrote ${archiveBytes.byteLength} bytes to ${archivePath}`);

    // ------------------------------------------------------------------
    // 8. Read the archive back
    // ------------------------------------------------------------------
    section('8. Reading the archive back from disk (fresh, no shared state with step 7)');
    const readBackBytes = new Uint8Array(await readFile(archivePath));
    const readResult = await unpackArchive(readBackBytes);
    if (!readResult.ok) throw new Error(`Failed to read archive back: ${readResult.error.message}`);
    const readBundle = readResult.value;
    console.log(`Read back "${readBundle.manifest.name}@${readBundle.manifest.version}" with ${readBundle.components.length} component(s).`);

    // ------------------------------------------------------------------
    // 9. Validate hashes and signatures
    // ------------------------------------------------------------------
    section('9. Validating the read-back bundle (schema, hashes, Merkle root, signatures)');
    const publicKeysByDid = new Map([[signatureEntry.signerDid, devKeyPair.publicKey]]);
    const validator = new PackageValidator({ resolvePublicKey: (did) => publicKeysByDid.get(did) });
    const report = validator.validateAll(readBundle);
    for (const issue of report.issues) {
      console.log(`  [${issue.severity.toUpperCase()}] ${issue.code}: ${issue.message}`);
    }
    console.log(`Validation result: ${report.valid ? 'VALID' : 'INVALID'}`);
    if (!report.valid) throw new Error('Demo archive failed validation — this should never happen for an untouched round-trip.');

    // Double-check the signature explicitly too, independent of the validator.
    const verifier = new PackageVerifier();
    const signatureOk = verifier.verifyOne(readBundle.manifest, {
      signerDid: signatureEntry.signerDid,
      role: signatureEntry.role,
      signature: readBundle.manifest.signatures?.[0]?.signature ?? '',
      publicKeyPem: devKeyPair.publicKey,
    });
    console.log(`Explicit signature re-check: ${signatureOk ? 'VALID' : 'INVALID'}`);

    // ------------------------------------------------------------------
    // 10. Install it into a local BlobStore
    // ------------------------------------------------------------------
    section('10. Installing into a real LocalFsBlobStore');
    const installRoot = join(workDir, 'installed');
    const blobStore = new LocalFsBlobStore(installRoot);
    const installer = new PackageInstaller(blobStore);
    const installResult = await installer.install(readBundle);
    if (!installResult.ok) throw new Error(`Install failed: ${installResult.error.message}`);
    console.log(`Installed "${installResult.value.name}@${installResult.value.version}" at ${installResult.value.installedAt}`);
    console.log(`Install root: ${installRoot}`);

    // ------------------------------------------------------------------
    // 11. List installed packages
    // ------------------------------------------------------------------
    section('11. Listing installed packages');
    const installed = await installer.listInstalled();
    for (const pkg of installed) {
      console.log(`  ${pkg.name}@${pkg.version}  (${pkg.componentPaths.length} component file(s), installed ${pkg.installedAt})`);
    }

    // ------------------------------------------------------------------
    // 12. Inspect the installed package and print a human-readable summary
    // ------------------------------------------------------------------
    section('12. Inspecting the installed package');
    const verifyResult = await installer.verifyInstallation(readBundle.manifest.name, readBundle.manifest.version);
    if (!verifyResult.ok) throw new Error(`verifyInstallation failed: ${verifyResult.error.message}`);
    console.log(`On-disk integrity check: ${verifyResult.value.valid ? 'VALID' : 'INVALID'}`);

    const summary = inspectBundle(bundle);
    console.log('\nPackage summary');
    console.log('---------------');
    console.log(`Name:              ${summary.name}`);
    console.log(`Version:           ${summary.version}`);
    console.log(`Creator DID:       ${summary.creatorDid}`);
    console.log(`Fingerprint:       ${summary.fingerprint}`);
    console.log(`Merkle root:       ${summary.merkleRoot ?? '(none)'}`);
    console.log(`Signatures:        ${summary.signatureCount}`);
    console.log(`Declared families: ${summary.declaredFamilies.join(', ')}`);
    console.log(`Total bytes:       ${summary.totalComponentBytes}`);
    console.log('Components:');
    for (const component of summary.components) {
      console.log(`  - ${component.kind.padEnd(16)} ${component.path.padEnd(36)} ${component.size.toString().padStart(6)} bytes  required=${component.required}  ${component.hash}`);
    }

    section("Done");

console.log("Output written to:");
console.log(workDir);

console.log("Archive:");
console.log(archivePath);

console.log("Installed package:");
console.log(installRoot);

console.log("Every stage completed successfully.");

} finally {
    // Clean up the temporary working directory if you want to keep it for inspection, comment out the next line.
    // await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error('\nDemo failed:', error);
  process.exitCode = 1;
});
