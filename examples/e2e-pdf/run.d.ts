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
export {};
//# sourceMappingURL=run.d.ts.map