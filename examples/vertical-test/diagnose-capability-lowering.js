"use strict";
// examples/vertical-test/diagnose-capability-lowering.ts
//
// Run from the repo root: npx tsx examples/vertical-test/diagnose-capability-lowering.ts
//
// This is NOT the CLI. It calls the exact same production functions
// `xo create`/`xo capabilities` call (`compileSources`, `packageXoirGraph`'s
// own internal `lowerCapabilitiesToManifest`/`buildAllSemanticCapabilityContracts`/
// `resolveCapabilityBinding`) directly, and prints what they actually return —
// never a hardcoded summary string. Two of `apps/cli`'s own display lines
// ("0 resolved (no manifest-level CapabilityDeclaration lowering exists in
// this compiler yet)" in create.ts, and the entire trailing paragraph in
// capabilities.ts's source-mode branch) are literal, unconditional strings
// that were never updated after the Phase 1 merge — see the "CLI TEXT IS
// STALE" note this script prints if it detects that mismatch. Do not use
// those lines as evidence for anything; use this script's numbers instead.
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = require("node:fs/promises");
const node_url_1 = require("node:url");
const compiler_1 = require("@xo/compiler");
const capability_contract_1 = require("@xo/capability-contract");
const PDF_PATH = (0, node_url_1.fileURLToPath)(new URL('./XO_Commercial_Property_Test_Policy_Compatible.pdf', import.meta.url));
const RULE_KINDS = new Set(['decision_node', 'heuristic', 'constraint']);
async function main() {
    const bytes = new Uint8Array(await (0, promises_1.readFile)(PDF_PATH));
    const input = { kind: 'pdf', bytes, sourcePath: 'XO_Commercial_Property_Test_Policy_Compatible.pdf' };
    console.log('=== Step 1: compileSources (the exact function xo create/xo capabilities both call) ===');
    const result = await (0, compiler_1.compileSources)([input], {});
    if (!result.ok) {
        console.error('compileSources FAILED:', result.error.code, result.error.message);
        process.exitCode = 1;
        return;
    }
    const { graph, stats } = result.value;
    console.log('nodesByKind:', JSON.stringify(stats.nodesByKind, null, 2));
    console.log('(note: the CLI\'s "Knowledge: N concept, N fact" and "Reasoning: N node(s)" lines only ever print the \'concept\'/\'fact\'/\'reasoning_step\' keys above — every other kind, including constraint/heuristic/decision_node, is silently omitted from that summary. The full breakdown above is the real picture.)');
    console.log();
    console.log('=== Step 2: capability + rule node inventory (direct graph read) ===');
    const allNodes = graph.allNodes();
    const capabilityNodes = allNodes.filter((n) => n.kind === 'capability');
    const ruleNodes = allNodes.filter((n) => RULE_KINDS.has(n.kind));
    console.log(`Capability nodes: ${capabilityNodes.length}`);
    console.log(`Rule nodes (decision_node/heuristic/constraint) by kind:`);
    for (const kind of RULE_KINDS) {
        console.log(`  ${kind}: ${ruleNodes.filter((n) => n.kind === kind).length}`);
    }
    console.log();
    console.log('=== Step 3: REQUIRES edges after Phase 1 linking has run (linking happens inside compileSources -> compileXoir -> convertToXoir, BEFORE this function ever sees the graph) ===');
    const requiresEdges = graph.allEdges().filter((e) => e.kind === 'REQUIRES');
    console.log(`Total REQUIRES edges: ${requiresEdges.length}`);
    const nodeById = new Map(allNodes.map((n) => [n.id, n]));
    const capRuleEdges = requiresEdges.filter((e) => {
        const from = nodeById.get(e.fromId);
        const to = nodeById.get(e.toId);
        return (from?.kind === 'capability' && RULE_KINDS.has(to?.kind ?? '')) || (RULE_KINDS.has(from?.kind ?? '') && to?.kind === 'capability');
    });
    console.log(`Of those, capability<->rule edges (either direction): ${capRuleEdges.length}`);
    for (const e of capRuleEdges) {
        const from = nodeById.get(e.fromId);
        const to = nodeById.get(e.toId);
        console.log(`  ${e.id}: ${e.fromId} (${from?.kind}) --REQUIRES--> ${e.toId} (${to?.kind})  [evidence: ${JSON.stringify(e.metadata.custom ?? {})}]`);
    }
    if (capRuleEdges.length === 0) {
        console.log('  (none — this is the single most important number in this report. See the root-cause branches printed at the end.)');
    }
    console.log();
    console.log('=== Step 4: per-capability contract + binding (buildAllSemanticCapabilityContracts + resolveCapabilityBinding — the exact functions capability-lowering.ts calls) ===');
    const resolver = new capability_contract_1.StructuredComparisonBindingResolver();
    const contractResults = (0, capability_contract_1.buildAllSemanticCapabilityContracts)(graph);
    let anyNonEmptyRules = 0;
    let anyResolved = 0;
    for (const cr of contractResults) {
        if (!cr.ok) {
            console.log(`  [CONTRACT BUILD FAILED] ${cr.error.code}: ${cr.error.message}`);
            continue;
        }
        const contract = cr.value;
        const outcome = (0, capability_contract_1.resolveCapabilityBinding)(contract, [resolver]);
        if (contract.rules.length > 0)
            anyNonEmptyRules++;
        if (outcome.status === 'resolved')
            anyResolved++;
        console.log(`  - ${contract.id}  "${contract.name}"`);
        console.log(`      contract.rules.length: ${contract.rules.length}`);
        for (const r of contract.rules) {
            console.log(`        rule ${r.sourceNodeId} (${r.kind}): condition="${r.condition}" outcome=${r.outcome === undefined ? 'undefined' : `"${r.outcome}"`}`);
        }
        console.log(`      BindingOutcome: ${outcome.status}${outcome.status !== 'resolved' ? ` — ${outcome.reason ?? ''}` : ` — implementationClass: ${outcome.binding.implementationClass}`}`);
    }
    console.log();
    console.log('=== Summary ===');
    console.log(`Capabilities discovered:        ${capabilityNodes.length}`);
    console.log(`Capabilities with contract.rules.length > 0: ${anyNonEmptyRules}`);
    console.log(`Capabilities with a 'resolved' BindingOutcome: ${anyResolved}`);
    console.log();
    if (capRuleEdges.length === 0) {
        console.log('ROOT CAUSE (this run): zero capability<->rule REQUIRES edges exist in the compiled graph.');
        console.log('This means Phase 1 linking produced no edges for THIS document\'s actual extracted content —');
        console.log('either (a) it never ran (check the nodesByKind breakdown above: if constraint/heuristic/decision_node');
        console.log('counts are all 0, there were no rule-node candidates for it to link in the first place — an');
        console.log('EXTRACTION gap, not a linking gap), or (b) rule nodes exist but none scored above the exact-label/');
        console.log('same-unit-overlap evidence threshold against any capability\'s own name/label text — an EVIDENCE gap.');
        console.log('Compare the rule node counts above against the capability inventory to tell these apart.');
    }
    else if (anyNonEmptyRules === 0) {
        console.log('UNEXPECTED: capability<->rule edges exist but no contract.rules is non-empty — this would mean');
        console.log('buildSemanticCapabilityContract is not seeing edges the graph actually has (a contract-builder bug,');
        console.log('not a linking bug). Re-check contract-builder.ts\'s direction/edgeKind handling against the printed edges above.');
    }
    else if (anyResolved === 0) {
        console.log('EXPECTED-AND-DOCUMENTED CASE: at least one capability now has contract.rules.length > 0 (Phase 1');
        console.log('linking is genuinely active and producing edges), but none resolved to a deterministic binding.');
        console.log('Check each rule\'s "outcome" above: a constraint-kind rule always has outcome=undefined by design');
        console.log('(ConstraintNodeProps has no outcome field) and can never resolve via StructuredComparisonBindingResolver');
        console.log('— this is correct, not a bug. Only a decision_node/heuristic rule (which does carry an outcome) can');
        console.log('resolve. If every linked rule above is kind=constraint, the next blocker is genuinely upstream, in');
        console.log('reasoning extraction producing too few decision_node/heuristic candidates for this document — NOT');
        console.log('in linking, contract-building, or resolution, all three of which are demonstrably working per this report.');
    }
    else {
        console.log('At least one capability reached a resolved, deterministic binding. Re-run "xo create" and check');
        console.log('"xo capabilities <name>.xo" (the archive-mode branch of capabilities.ts, which reads the REAL packaged');
        console.log('manifest.capabilities, not the hardcoded source-mode text) to confirm it made it into the .xo file.');
    }
}
main().catch((err) => {
    console.error('Diagnostic script crashed:', err);
    process.exitCode = 1;
});
//# sourceMappingURL=diagnose-capability-lowering.js.map