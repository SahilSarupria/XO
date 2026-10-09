/**
 * XO Platform — First Real PDF E2E Vertical Harness
 * ===================================================
 *
 * Exercises the CURRENT real public APIs of the platform against a real
 * PDF and reports exactly how far the document travels through the
 * pipeline:
 *
 *   PDF -> PdfLoader -> DocumentParser -> SemanticChunker
 *       -> KnowledgeExtractor -> CapabilityExtractor -> ReasoningExtractor
 *       -> compileXoir() -> XOIR validation/normalization
 *       -> Package (ManifestBuilder/Signer/Archive/Validator)
 *       -> Registry (RegistryClient publish/search/get)
 *       -> Install/Load (PackageInstaller/PackageLoader/Runtime)
 *       -> Capability discovery -> Execution (ExecutionEngine, if an
 *          executable capability legitimately exists)
 *       -> Persistence/Receipt/Memory (RuntimeStore, only if execution
 *          actually happened)
 *
 * No stage here is faked, mocked, or hand-constructed to force a PASS.
 * Every function called below is a real, currently-exported public API
 * from packages/compiler, packages/xoir, packages/package-sdk,
 * packages/registry, and packages/runtime — nothing in this file
 * duplicates Stage 8 (the not-yet-built compiler orchestrator), and
 * nothing here modifies any core package.
 *
 * Three known, honestly-reported architectural boundaries (see
 * README.md "Known limitations" for the full writeup):
 *
 *   1. Registry artifact storage — RegistryClient only stores/returns a
 *      PackageRecord (manifest + publishedAt), never component bytes.
 *      Resolving a package from the registry alone cannot reconstitute
 *      an installable .xo bundle; the local archive remains the actual
 *      install/load source.
 *   2. Compiler Capability vs. Runtime CapabilityDeclaration — the
 *      compiler's `Capability` (capabilities/types.ts) and the
 *      manifest's `CapabilityDeclaration` (@xo/types#xo-capability.ts)
 *      are structurally unrelated types with no existing converter
 *      anywhere in the repo. This harness never fabricates one; a
 *      package's manifest only declares a capability the harness can
 *      honestly attribute to real extraction output.
 *   3. XOIR has no manifest ComponentKind — `@xo/types`' ComponentKind
 *      union (knowledge_graph, long_term_memory_graph, decision_trees,
 *      reasoning_traces, case_library, prompt_strategies, lora,
 *      finetune, safety_rules, benchmark_suite) has no "xoir" entry.
 *      This harness does not invent one; it embeds the compiled XOIR's
 *      canonical JSON serialization inside the existing
 *      `knowledge_graph` component slot, and separately preserves the
 *      full compiled XOIR as a first-class harness output artifact
 *      (output/compiled-xoir.json) so nothing is silently lost.
 *
 * Run with:
 *   npx tsx examples/e2e-pdf/run.ts
 * or:
 *   npm run e2e:pdf   (from the repo root, once wired into package.json)
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NodePdfLoader,
  parseDocument,
  chunkDocument,
  extractKnowledgeGraph,
  extractCapabilityGraph,
  extractReasoningGraph,
  compileXoir,
  type PipelineInput,
} from '@xo/compiler';
import { toJson as xoirToJson } from '@xo/xoir';
import {
  ManifestBuilder,
  PackageSigner,
  PackageVerifier,
  packBundle,
  unpackArchive,
  PackageValidator,
  PackageInstaller,
  inspectBundle,
  type PackageBundle,
} from '@xo/package-sdk';
import { Ed25519Signer } from '@xo/crypto';
import { LocalFsBlobStore } from '@xo/storage';
import { RegistryClient } from '@xo/registry';
import {
  Runtime,
  PackageLoader,
  ExecutionEngine,
  FileRuntimeStore,
  RequestId,
  EnvironmentId,
  type ExecutionRequest,
} from '@xo/runtime';
import { ScriptableTestProvider, jsonResponse } from '@xo/ai-core';

// ---------------------------------------------------------------------
// Report scaffolding
// ---------------------------------------------------------------------

type BoundaryStatus = 'PASS' | 'BLOCKED' | 'NOT_APPLICABLE' | 'ERROR';

interface BoundaryResult {
  readonly status: BoundaryStatus;
  readonly reason: string;
  readonly detail?: unknown;
}

const BOUNDARY_KEYS = [
  'pdf_ingestion',
  'document_parsing',
  'semantic_chunking',
  'knowledge_extraction',
  'capability_extraction',
  'reasoning_extraction',
  'xoir_compilation',
  'xoir_validation',
  'package_creation',
  'package_verification',
  'registry_publish',
  'registry_resolve',
  'package_install_load',
  'runtime_capability_discovery',
  'runtime_execution',
  'persistence',
  'memory',
] as const;
type BoundaryKey = (typeof BOUNDARY_KEYS)[number];

const results = new Map<BoundaryKey, BoundaryResult>();
let firstBlocker: { boundary: BoundaryKey; reason: string } | undefined;
let hardError: { boundary: BoundaryKey; error: unknown } | undefined;

function record(key: BoundaryKey, status: BoundaryStatus, reason: string, detail?: unknown): void {
  results.set(key, { status, reason, detail });
  if (status === 'BLOCKED' && firstBlocker === undefined) {
    firstBlocker = { boundary: key, reason };
  }
  const label = status.padEnd(14);
  console.log(`[${label}] ${key}: ${reason}`);
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const OUTPUT_DIR = join(HERE, 'output');
const FIXTURE_PATH = join(REPO_ROOT, 'examples', 'vertical-test', 'burglary-policy.pdf');

async function writeOutput(name: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2);
  await writeFile(join(OUTPUT_DIR, name), json, 'utf8');
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  // Isolated temp state for this run — never touches the repo's own
  // node_modules, any developer's real install, or a shared registry.
  const runTmpRoot = await mkdtemp(join(tmpdir(), 'xo-e2e-pdf-'));
  const registryDir = join(runTmpRoot, 'registry');
  const installDir = join(runTmpRoot, 'installed');
  const runtimeStoreDir = join(runTmpRoot, 'runtime-store');
  const archivePath = join(runTmpRoot, 'xo_e2e_burglary_policy-1.0.0.xo');

  console.log('XO Platform — First Real PDF E2E Vertical Harness');
  console.log(`Fixture: ${FIXTURE_PATH}`);
  console.log(`Isolated run directory: ${runTmpRoot}`);

  // ---------------------------------------------------------------
  // 1. PDF ingestion (Stage 1)
  // ---------------------------------------------------------------
  section('1. PDF ingestion');
  const pdfBytes = new Uint8Array(await readFile(FIXTURE_PATH));
  const loader = new NodePdfLoader();
  const loaded = loader.load(pdfBytes, FIXTURE_PATH);
  if (!loaded.ok) {
    record('pdf_ingestion', 'ERROR', `NodePdfLoader.load() failed: ${loaded.error.message}`);
    hardError = { boundary: 'pdf_ingestion', error: loaded.error };
    return finish(runTmpRoot);
  }
  const loadedDoc = loaded.value;
  record('pdf_ingestion', 'PASS', `Loaded ${loadedDoc.pageCount} page(s) from a real PDF via NodePdfLoader.`, {
    pageCount: loadedDoc.pageCount,
    metadata: loadedDoc.metadata,
    pagesRequiringOcr: loadedDoc.pages.filter((p) => p.requiresOcr).length,
  });
  await writeOutput('source.json', {
    sourcePath: loadedDoc.sourcePath,
    pageCount: loadedDoc.pageCount,
    metadata: loadedDoc.metadata,
    pages: loadedDoc.pages.map((p) => ({
      pageNumber: p.pageNumber,
      requiresOcr: p.requiresOcr,
      textLength: p.plainText.length,
      textRunCount: p.textRuns.length,
    })),
  });

  // ---------------------------------------------------------------
  // 2. Document parsing (Stage 2)
  // ---------------------------------------------------------------
  section('2. Document parsing');
  let parsed;
  try {
    parsed = parseDocument(loadedDoc);
  } catch (error) {
    record('document_parsing', 'ERROR', `parseDocument() threw unexpectedly: ${describeError(error)}`);
    hardError = { boundary: 'document_parsing', error };
    return finish(runTmpRoot);
  }
  const blockCount = countBlocks(parsed.root);
  record('document_parsing', 'PASS', `parseDocument() produced a structural tree (${blockCount} block(s), body font ${parsed.root ? parsed.bodyFontSizePt : 'n/a'}pt).`, {
    bodyFontSizePt: parsed.bodyFontSizePt,
    topLevelSubsections: parsed.root.subsections.length,
    totalBlocks: blockCount,
  });

  // ---------------------------------------------------------------
  // 3. Semantic chunking (Stage 3)
  // ---------------------------------------------------------------
  section('3. Semantic chunking');
  let chunked;
  try {
    chunked = await chunkDocument(parsed, FIXTURE_PATH, loadedDoc.metadata?.title);
  } catch (error) {
    record('semantic_chunking', 'ERROR', `chunkDocument() threw unexpectedly: ${describeError(error)}`);
    hardError = { boundary: 'semantic_chunking', error };
    return finish(runTmpRoot);
  }
  record('semantic_chunking', 'PASS', `chunkDocument() produced ${chunked.units.length} ExperienceUnit(s).`, {
    unitCount: chunked.units.length,
    relationshipCount: chunked.relationshipGraph.relationships.length,
  });

  // ---------------------------------------------------------------
  // 4. Knowledge extraction (Stage 4) — rule-based only; no @xo/ai-core
  //    AiCapabilityLayer is wired in, so this is the honest
  //    lower-confidence-but-correct path the package's own docs describe
  //    for a caller with no live/replay AI provider configured.
  // ---------------------------------------------------------------
  section('4. Knowledge extraction');
  let knowledgeGraph;
  try {
    knowledgeGraph = await extractKnowledgeGraph(chunked);
  } catch (error) {
    record('knowledge_extraction', 'ERROR', `extractKnowledgeGraph() threw unexpectedly: ${describeError(error)}`);
    hardError = { boundary: 'knowledge_extraction', error };
    return finish(runTmpRoot);
  }
  record('knowledge_extraction', 'PASS', `extractKnowledgeGraph() (rule-based) produced ${knowledgeGraph.nodes.length} node(s), ${knowledgeGraph.edges.length} edge(s).`, {
    nodeCount: knowledgeGraph.nodes.length,
    edgeCount: knowledgeGraph.edges.length,
  });

  // ---------------------------------------------------------------
  // 5. Capability extraction (Stage 5)
  // ---------------------------------------------------------------
  section('5. Capability extraction');
  let capabilityGraph;
  try {
    capabilityGraph = await extractCapabilityGraph(chunked, knowledgeGraph);
  } catch (error) {
    record('capability_extraction', 'ERROR', `extractCapabilityGraph() threw unexpectedly: ${describeError(error)}`);
    hardError = { boundary: 'capability_extraction', error };
    return finish(runTmpRoot);
  }
  record(
    'capability_extraction',
    'PASS',
    capabilityGraph.capabilities.length > 0
      ? `extractCapabilityGraph() (rule-based) produced ${capabilityGraph.capabilities.length} compiler Capability object(s).`
      : `extractCapabilityGraph() (rule-based) ran successfully but found 0 capability-shaped content in this document. This is a real, honest result — not an error. The rule-based extractor found nothing in "burglary-policy.pdf" (a blank policy template) that matches its capability-signature patterns; a document with more explicit action/procedure language would likely produce non-zero capabilities from the same, unmodified extractor.`,
    { capabilityCount: capabilityGraph.capabilities.length, sample: capabilityGraph.capabilities.slice(0, 3) },
  );

  // ---------------------------------------------------------------
  // 6. Reasoning extraction (Stage 7)
  // ---------------------------------------------------------------
  section('6. Reasoning extraction');
  let reasoningGraph;
  try {
    reasoningGraph = await extractReasoningGraph(chunked);
  } catch (error) {
    record('reasoning_extraction', 'ERROR', `extractReasoningGraph() threw unexpectedly: ${describeError(error)}`);
    hardError = { boundary: 'reasoning_extraction', error };
    return finish(runTmpRoot);
  }
  record(
    'reasoning_extraction',
    'PASS',
    reasoningGraph.nodes.length > 0
      ? `extractReasoningGraph() (rule-based) produced ${reasoningGraph.nodes.length} node(s).`
      : `extractReasoningGraph() (rule-based) ran successfully but found 0 rule/decision-shaped content in this document — an honest result, not an error.`,
    { nodeCount: reasoningGraph.nodes.length, edgeCount: reasoningGraph.edges.length },
  );

  // ---------------------------------------------------------------
  // 7. XOIR compilation (Stage 6) — the real compiler pipeline, via
  //    compileXoir()'s 'combined' input. This is NOT a hand-rolled
  //    Stage 8 orchestrator: it is this harness, as a caller, invoking
  //    the exact three already-public extraction functions above and
  //    handing their real output to the one already-public conversion
  //    entry point. No KnowledgeGraph/CapabilityGraph/ReasoningGraph/
  //    XoirGraph is constructed by hand anywhere in this file.
  // ---------------------------------------------------------------
  section('7. XOIR compilation');
  const pipelineInput: PipelineInput = { kind: 'combined', knowledge: knowledgeGraph, capability: capabilityGraph, reasoning: reasoningGraph };
  let compiled;
  try {
    const compileResult = await compileXoir(pipelineInput, { graphId: 'xo_e2e_burglary_policy', now: () => '2026-08-17T00:00:00.000Z' });
    if (!compileResult.ok) {
      record('xoir_compilation', 'ERROR', `compileXoir() returned err(): ${compileResult.error.message}`);
      hardError = { boundary: 'xoir_compilation', error: compileResult.error };
      return finish(runTmpRoot);
    }
    compiled = compileResult.value;
  } catch (error) {
    record('xoir_compilation', 'ERROR', `compileXoir() threw unexpectedly: ${describeError(error)}`);
    hardError = { boundary: 'xoir_compilation', error };
    return finish(runTmpRoot);
  }
  record('xoir_compilation', 'PASS', `compileXoir() ran the full convert -> validate -> normalize pipeline and returned a CompiledXoirResult.`, {
    stats: compiled.stats,
  });

  // ---------------------------------------------------------------
  // 8. XOIR validation
  // ---------------------------------------------------------------
  section('8. XOIR validation');
  if (!compiled.valid) {
    const errorDiagnostics = compiled.diagnostics.filter((d) => d.severity === 'error');
    record('xoir_validation', 'BLOCKED', `Compiled XOIR failed validation (${errorDiagnostics.length} error-severity diagnostic(s)); downstream stages cannot proceed on invalid XOIR.`, {
      diagnostics: compiled.diagnostics,
    });
    await writeOutput('compiled-xoir.json', xoirToJson(compiled.graph));
    await writeOutput('diagnostics.json', { validation: compiled.validation, diagnostics: compiled.diagnostics, passRuns: compiled.passRuns });
    return finish(runTmpRoot);
  }
  record('xoir_validation', 'PASS', `Compiled XOIR is valid and normalized (${compiled.stats.nodeCount} node(s), ${compiled.stats.edgeCount} edge(s)).`, {
    stats: compiled.stats,
  });
  const compiledXoirJson = xoirToJson(compiled.graph);
  await writeOutput('compiled-xoir.json', compiledXoirJson);
  await writeOutput('diagnostics.json', { validation: compiled.validation, diagnostics: compiled.diagnostics, passRuns: compiled.passRuns });

  // ---------------------------------------------------------------
  // 9. Package creation (Package SDK)
  //
  //    Boundary #3 (XOIR has no manifest ComponentKind): @xo/types'
  //    ComponentKind union has no "xoir" entry (checked directly against
  //    packages/types/src/compatibility.ts — the full union is
  //    knowledge_graph, long_term_memory_graph, decision_trees,
  //    reasoning_traces, case_library, prompt_strategies, lora,
  //    finetune, safety_rules, benchmark_suite). This harness does not
  //    invent a new kind. The compiled XOIR's own canonical
  //    serialization (@xo/xoir#toJson) is embedded verbatim inside the
  //    existing `knowledge_graph` component slot — the closest existing,
  //    legitimate fit — and is separately preserved unmodified as
  //    output/compiled-xoir.json so no information is lost to that
  //    choice of container.
  //
  //    Boundary #2 (Compiler Capability vs. Runtime CapabilityDeclaration):
  //    manifest.capabilities is left as [] here, honestly, because
  //    extractCapabilityGraph() produced 0 compiler Capability objects
  //    for this document (see step 5) and — independently of that
  //    count — there is no existing function anywhere in this repo that
  //    converts a compiler `Capability` (packages/compiler/src/
  //    capabilities/types.ts) into a manifest `CapabilityDeclaration`
  //    (packages/types/src/xo-capability.ts); the two shapes share no
  //    fields (id/name/description aside) and the manifest shape
  //    requires operational data — estimatedCost, estimatedLatencyMs,
  //    a ModelFamily-based providerCompatibility — that compiler
  //    extraction never produces. Fabricating one here to force a
  //    non-empty capability list would misrepresent what the compiler
  //    actually inferred from the source PDF.
  // ---------------------------------------------------------------
  section('9. Package creation');
  let bundle: PackageBundle;
  let devPublicKeyPem: string;
  let signerDid: string;
  try {
    const compatibility = {
      modelFamilies: [{ family: 'claude' as const, minCapability: ['chat' as const], consumes: ['knowledge_graph' as const] }],
      fallbackPolicy: 'degrade_gracefully' as const,
    };
    const metadata = {
      domain: 'e2e-harness.burglary-policy',
      description: 'E2E harness output package for examples/vertical-test/burglary-policy.pdf — compiled via the real Stage 1-7 compiler pipeline. Diagnostic artifact, not a production XO.',
      scope: ['diagnostic measurement of the current compiler->package->registry->runtime vertical'],
      limitations: ['manifest declares zero capabilities: extractCapabilityGraph() found none in this document, and no compiler-Capability -> manifest-CapabilityDeclaration converter exists in this repo'],
      tags: ['e2e-harness', 'diagnostic'],
    };

    const signer = new Ed25519Signer();
    const devKeyPair = signer.generateKeyPair();
    devPublicKeyPem = devKeyPair.publicKey;
    signerDid = 'did:xo:e2e-pdf-harness';

    const unsignedBuild = ManifestBuilder.create()
      .setIdentity({ formatVersion: '1.0', name: 'xo_e2e_burglary_policy', version: '1.0.0', creatorDid: 'did:xo:e2e-pdf-harness' })
      .setCompatibility(compatibility)
      .setMetadata(metadata)
      .setCapabilities([]) // see boundary #2 above — honestly empty, not fabricated
      .setPermissions([])
      .addComponent({ kind: 'knowledge_graph', path: 'knowledge/compiled-xoir.json', data: new TextEncoder().encode(JSON.stringify(compiledXoirJson)), required: false })
      .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new TextEncoder().encode(JSON.stringify({ rules: [] })), required: true })
      .addComponent({ kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', data: new TextEncoder().encode(JSON.stringify({ categories: [] })), required: true })
      .build();
    if (!unsignedBuild.ok) throw new Error(`ManifestBuilder.build() failed: ${unsignedBuild.error.message}`);

    const signatureEntry = new PackageSigner(signer).sign(unsignedBuild.value.manifest, signerDid, 'creator', devKeyPair.privateKey, devKeyPair.publicKey);

    const signedBuild = ManifestBuilder.create()
      .setIdentity({ formatVersion: '1.0', name: 'xo_e2e_burglary_policy', version: '1.0.0', creatorDid: 'did:xo:e2e-pdf-harness' })
      .setCompatibility(compatibility)
      .setMetadata(metadata)
      .setCapabilities([])
      .setPermissions([])
      .addComponent({ kind: 'knowledge_graph', path: 'knowledge/compiled-xoir.json', data: new TextEncoder().encode(JSON.stringify(compiledXoirJson)), required: false })
      .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', data: new TextEncoder().encode(JSON.stringify({ rules: [] })), required: true })
      .addComponent({ kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', data: new TextEncoder().encode(JSON.stringify({ categories: [] })), required: true })
      .addSignature({ signerDid: signatureEntry.signerDid, role: signatureEntry.role, signature: signatureEntry.signature, publicKeyPem: signatureEntry.publicKeyPem })
      .build();
    if (!signedBuild.ok) throw new Error(`Signed ManifestBuilder.build() failed: ${signedBuild.error.message}`);
    bundle = signedBuild.value;

    const archiveBytes = await packBundle(bundle);
    await writeFile(archivePath, archiveBytes);

    record('package_creation', 'PASS', `Built and signed a real .xo package (${archiveBytes.byteLength} bytes) via ManifestBuilder + Ed25519Signer + packBundle().`, {
      name: bundle.manifest.name,
      version: bundle.manifest.version,
      merkleRoot: bundle.manifest.merkleRoot,
      componentCount: bundle.components.length,
      archiveBytes: archiveBytes.byteLength,
      archivePath,
    });
  } catch (error) {
    record('package_creation', 'ERROR', `Package creation threw unexpectedly: ${describeError(error)}`);
    hardError = { boundary: 'package_creation', error };
    return finish(runTmpRoot);
  }

  // ---------------------------------------------------------------
  // 10. Package verification
  // ---------------------------------------------------------------
  section('10. Package verification');
  let readBundle: PackageBundle;
  try {
    const readBackBytes = new Uint8Array(await readFile(archivePath));
    const readResult = await unpackArchive(readBackBytes);
    if (!readResult.ok) throw new Error(`unpackArchive() failed: ${readResult.error.message}`);
    readBundle = readResult.value;

    const publicKeysByDid = new Map([[signerDid, devPublicKeyPem]]);
    const validator = new PackageValidator({ resolvePublicKey: (did) => publicKeysByDid.get(did) });
    const report = validator.validateAll(readBundle);

    const verifier = new PackageVerifier();
    const signatureOk = readBundle.manifest.signatures?.[0]
      ? verifier.verifyOne(readBundle.manifest, { signerDid, role: 'creator', signature: readBundle.manifest.signatures[0].signature, publicKeyPem: devPublicKeyPem })
      : false;

    await writeOutput('package-inspect.json', { inspection: inspectBundle(readBundle), validationReport: report, signatureVerified: signatureOk });

    if (!report.valid) {
      record('package_verification', 'BLOCKED', `Read-back package failed PackageValidator.validateAll() (${report.issues.filter((i) => i.severity === 'error').length} error(s)).`, report);
      return finish(runTmpRoot);
    }
    record('package_verification', 'PASS', `Round-tripped .xo archive validated (schema, hashes, Merkle root, signature) via PackageValidator + PackageVerifier.`, {
      valid: report.valid,
      signatureVerified: signatureOk,
    });
  } catch (error) {
    record('package_verification', 'ERROR', `Package verification threw unexpectedly: ${describeError(error)}`);
    hardError = { boundary: 'package_verification', error };
    return finish(runTmpRoot);
  }

  // ---------------------------------------------------------------
  // 11. Registry publish / search / resolve
  //
  //    Boundary #1 (registry artifact storage): RegistryClient.publish()
  //    verifies the *full* PackageBundle but only ever constructs and
  //    stores a PackageRecord — { id, manifest, publishedAt } — via
  //    FsPackageRepository (see registry/src/client/registry-client.ts
  //    and registry/src/package/fs-package-repository.ts). There is no
  //    method on RegistryClient, FsPackageRepository, or PackageRepository
  //    (@xo/registry-core) that accepts or returns component bytes. So
  //    "resolve" genuinely only resolves the manifest record — it cannot
  //    reconstruct an installable .xo bundle by itself. This harness
  //    does not pretend otherwise: install/load below deliberately uses
  //    the local archivePath, not anything read back from the registry.
  // ---------------------------------------------------------------
  section('11. Registry publish / search / resolve');
  let publishedId: string | undefined;
  try {
    const registryStore = new LocalFsBlobStore(registryDir);
    const registryClient = new RegistryClient(registryStore);

    const published = await registryClient.publish(bundle);
    if (!published.ok) {
      record('registry_publish', 'BLOCKED', `RegistryClient.publish() rejected the package: ${published.error.message}`, published.error);
      return finish(runTmpRoot);
    }
    publishedId = published.value.id;
    record('registry_publish', 'PASS', `Published to an isolated local FsPackageRepository, content-addressed by manifest.merkleRoot ("${publishedId}"), with a ledger entry.`, {
      id: published.value.id,
      publishedAt: published.value.publishedAt,
      ledgerEntryHash: published.value.ledgerEntryHash,
    });

    const searchHits = await registryClient.search('burglary');
    const resolved = await registryClient.get(publishedId);
    if (!resolved.ok) {
      record('registry_resolve', 'ERROR', `RegistryClient.get() failed immediately after a successful publish: ${resolved.error.message}`);
    } else {
      record(
        'registry_resolve',
        'PASS',
        `RegistryClient.get() resolved the published PackageRecord by content-addressed id. LIMITATION (boundary #1, see README): this record carries only { id, manifest, publishedAt } — no component bytes. It cannot, by itself, be turned back into an installable .xo bundle; step 12 below installs from the local archive at "${archivePath}" instead, exactly because the registry does not offer a byte-level resolve path.`,
        { record: resolved.value, searchHitCount: searchHits.length, ledgerVerified: await registryClient.verifyLedgerEntry(published.value.ledgerEntryHash) },
      );
    }
    await writeOutput('registry-result.json', {
      publish: published.ok ? published.value : { error: published.error.message },
      search: searchHits.map((r) => ({ id: r.id, name: r.manifest.name })),
      resolve: resolved.ok ? resolved.value : { error: resolved.error.message },
      limitation: 'RegistryClient/FsPackageRepository store and return PackageRecord (manifest + publishedAt) only — no component-byte storage or retrieval API exists anywhere in packages/registry or packages/registry-core.',
    });
  } catch (error) {
    record('registry_publish', 'ERROR', `Registry stage threw unexpectedly: ${describeError(error)}`);
    hardError = { boundary: 'registry_publish', error };
    return finish(runTmpRoot);
  }

  // ---------------------------------------------------------------
  // 12. Package install / load (from the LOCAL archive — see boundary #1)
  // ---------------------------------------------------------------
  section('12. Package install / load');
  let installer: PackageInstaller;
  let runtime: Runtime;
  try {
    const installStore = new LocalFsBlobStore(installDir);
    installer = new PackageInstaller(installStore);
    const installResult = await installer.install(readBundle);
    if (!installResult.ok) {
      record('package_install_load', 'ERROR', `PackageInstaller.install() failed: ${installResult.error.message}`);
      hardError = { boundary: 'package_install_load', error: installResult.error };
      return finish(runTmpRoot);
    }

    runtime = new Runtime(installer);
    const mounted = await runtime.mount(bundle.manifest.name, bundle.manifest.version);
    if (!mounted.ok) {
      record('package_install_load', 'BLOCKED', `Installed successfully, but PackageLoader/Runtime.mount() rejected it: ${mounted.error.message}`, mounted.error);
      return finish(runTmpRoot);
    }
    record('package_install_load', 'PASS', `Installed via PackageInstaller (local LocalFsBlobStore) and mounted via Runtime.mount() — both from the local .xo archive, not the registry (see boundary #1).`, {
      installedAt: installResult.value.installedAt,
      mountedPackages: mounted.value.registry.all().map((p) => `${p.name}@${p.version}`),
    });
  } catch (error) {
    record('package_install_load', 'ERROR', `Install/load stage threw unexpectedly: ${describeError(error)}`);
    hardError = { boundary: 'package_install_load', error };
    return finish(runTmpRoot);
  }

  // ---------------------------------------------------------------
  // 13. Runtime capability discovery
  // ---------------------------------------------------------------
  section('13. Runtime capability discovery');
  const context = runtime.context();
  const discoveredCapabilities = context.capabilities.all();
  record(
    'runtime_capability_discovery',
    'PASS',
    discoveredCapabilities.length > 0
      ? `CapabilityRegistry.all() discovered ${discoveredCapabilities.length} executable capability descriptor(s) from the mounted package.`
      : `CapabilityRegistry.all() ran successfully and (accurately) discovered 0 capabilities — the mounted manifest declares none, because extractCapabilityGraph() found none in the source PDF (step 5) and this harness never fabricates a manifest CapabilityDeclaration from compiler output (boundary #2). Discovery itself is not blocked; there is simply nothing to discover for this specific document.`,
    { capabilities: discoveredCapabilities, mountedPackageCount: context.registry.all().length },
  );

  // ---------------------------------------------------------------
  // 14. Runtime execution — only if an actually executable capability
  //     exists. It does not for this document (see step 13), so this is
  //     NOT_APPLICABLE, not a forced PASS or a fabricated BLOCKED.
  // ---------------------------------------------------------------
  section('14. Runtime execution');
  if (discoveredCapabilities.length === 0) {
    record(
      'runtime_execution',
      'NOT_APPLICABLE',
      `No executable capability is declared on the mounted package, so there is nothing for ExecutionEngine.execute() to legitimately run against. This is boundary #2's concrete consequence for this document, not a bug in ExecutionEngine, CapabilityNegotiator, or CapabilityRegistry, all of which are confirmed real/working (see runtime/test/execution-engine.test.ts, which exercises the identical ExecutionEngine class against a fixture package that DOES declare capabilities). A future document/domain hint that causes extractCapabilityGraph() to produce real Capability output, PLUS a hand-authored manifest CapabilityDeclaration attributable to that output (there is still no automatic converter — see boundary #2), would be the way to reach this stage for real.`,
    );
    record('persistence', 'NOT_APPLICABLE', 'No execution occurred (see runtime_execution) — nothing to persist.');
    record('memory', 'NOT_APPLICABLE', 'No execution occurred (see runtime_execution) — no memory was read or written.');
    await writeOutput('execution-result.json', { executed: false, reason: results.get('runtime_execution')?.reason });
    return finish(runTmpRoot);
  }

  // (Not reached for burglary-policy.pdf today, kept real/functional for
  // whichever future document actually produces a discoverable capability.)
  const chosen = discoveredCapabilities[0];
  if (chosen === undefined) {
    record('runtime_execution', 'ERROR', 'discoveredCapabilities.length > 0 but index [0] was undefined — unreachable under normal operation.');
    record('persistence', 'NOT_APPLICABLE', 'No execution occurred.');
    record('memory', 'NOT_APPLICABLE', 'No execution occurred.');
    return finish(runTmpRoot);
  }
  const provider = new ScriptableTestProvider('e2e-harness-scripted-provider', [
    { kind: 'success', response: jsonResponse({ summary: 'Scripted deterministic test response — no live model call.' }) },
  ]);
  const engine = new ExecutionEngine(() => runtime.context(), installer, provider);
  const request: ExecutionRequest = {
    requestId: RequestId('req_e2e_pdf_1'),
    capabilityId: chosen.declaration.id,
    input: 'E2E harness probe request.',
    environment: {
      environmentId: EnvironmentId('env_e2e_pdf_1'),
      hostProfile: { family: 'claude', capabilities: ['chat', 'tool_use'] },
      provider: 'e2e-harness-scripted-provider',
      tokenBudget: 8000,
      createdAt: new Date().toISOString(),
    },
    requestedAt: new Date().toISOString(),
  };
  const executionResult = await engine.execute(request);
  await writeOutput('execution-result.json', executionResult);

  if (executionResult.session.status !== 'completed') {
    record('runtime_execution', 'BLOCKED', `ExecutionEngine.execute() did not complete: status="${executionResult.session.status}", error="${executionResult.error?.message}"`, executionResult);
    record('persistence', 'NOT_APPLICABLE', 'Execution did not complete — nothing durable to persist.');
    record('memory', 'NOT_APPLICABLE', 'Execution did not complete — no memory was read or written.');
    return finish(runTmpRoot);
  }
  record('runtime_execution', 'PASS', `ExecutionEngine.execute() completed against capability "${chosen.declaration.id}".`, { receipt: executionResult.receipt });

  // ---------------------------------------------------------------
  // 15/16. Persistence + memory — only because execution actually
  //         completed above.
  // ---------------------------------------------------------------
  section('15. Persistence');
  const store = new FileRuntimeStore({ rootDir: runtimeStoreDir });
  const savedSession = await store.sessions.create(executionResult.session);
  const savedReceipt = executionResult.receipt ? await store.receipts.saveExecutionReceipt(undefined, executionResult.receipt) : undefined;
  if (!savedSession.ok || (savedReceipt && !savedReceipt.ok)) {
    record('persistence', 'ERROR', `FileRuntimeStore failed to persist a real completed session/receipt.`);
  } else {
    record('persistence', 'PASS', `Persisted the real ExecutionSession and ExecutionReceipt via FileRuntimeStore.`, { sessionId: executionResult.session.sessionId });
    await writeOutput('receipt.json', executionResult.receipt ?? null);
  }

  section('16. Memory');
  record('memory', 'NOT_APPLICABLE', 'This execution path (single-capability, no workflowGraph) never touches RuntimeMemory — memory is only exercised by a workflow or a capability that explicitly reads/writes it, neither of which applies here. Not fabricating a memory entry just to mark this PASS.');

  return finish(runTmpRoot);
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

interface BlockCountable {
  readonly blocks: readonly unknown[];
  readonly subsections: readonly BlockCountable[];
}

function countBlocks(section: BlockCountable): number {
  let total = section.blocks.length;
  for (const sub of section.subsections) {
    total += countBlocks(sub);
  }
  return total;
}

async function finish(runTmpRoot: string): Promise<void> {
  const overall: 'PASS' | 'BLOCKED' | 'ERROR' = hardError
    ? 'ERROR'
    : firstBlocker
      ? 'BLOCKED'
      : 'PASS';

  const report = {
    harness: 'examples/e2e-pdf',
    fixture: FIXTURE_PATH,
    generatedAt: new Date().toISOString(),
    overallResult: overall,
    firstBlockingBoundary: firstBlocker ?? null,
    firstHardError: hardError ? { boundary: hardError.boundary, message: describeError(hardError.error) } : null,
    boundaries: Object.fromEntries(BOUNDARY_KEYS.map((k) => [k, results.get(k) ?? { status: 'NOT_APPLICABLE', reason: 'Not reached — an earlier boundary stopped the run.' }])),
    knownArchitecturalBoundaries: {
      registry_artifact_storage: 'RegistryClient/FsPackageRepository store and return only { id, manifest, publishedAt } (a PackageRecord). No component-byte storage/retrieval API exists in packages/registry or packages/registry-core, so a package cannot be reconstituted from the registry alone; the local .xo archive remains the real install/load source.',
      compiler_capability_vs_runtime_capability_declaration: "packages/compiler's Capability (capabilities/types.ts) and @xo/types' manifest CapabilityDeclaration (xo-capability.ts) are structurally unrelated types. No converter between them exists anywhere in this repo. This harness never fabricates one; a package's manifest.capabilities only ever reflects capabilities this harness can honestly attribute to real extraction output.",
      xoir_has_no_manifest_component_kind: "@xo/types' ComponentKind union has no \"xoir\" entry. This harness embeds the compiled XOIR's canonical JSON (@xo/xoir#toJson) inside the existing knowledge_graph component slot as the closest legitimate fit, and separately preserves it unmodified as output/compiled-xoir.json.",
    },
    isolatedRunDirectory: runTmpRoot,
    note: 'Temporary package/registry/install/runtime-store state lived under isolatedRunDirectory for this run only and is not committed to the repository.',
  };

  await writeOutput('e2e-report.json', report);

  section('FINAL REPORT');
  console.log(`Overall: ${overall}`);
  if (firstBlocker) console.log(`First blocking boundary: ${firstBlocker.boundary} — ${firstBlocker.reason}`);
  if (hardError) console.log(`First hard error: ${hardError.boundary} — ${describeError(hardError.error)}`);
  console.log(`Full report written to: ${join(OUTPUT_DIR, 'e2e-report.json')}`);

  // Clean up isolated temp state — everything meaningful is already
  // captured in examples/e2e-pdf/output/*.json.
  await rm(runTmpRoot, { recursive: true, force: true });

  if (hardError) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('FATAL: harness crashed outside its own error handling:', error);
  process.exitCode = 1;
});
