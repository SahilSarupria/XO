export * from './types.js';
export * from './comparison-grammar.js';
// Phase 2 — generalized structured semantic expression grammar (numeric
// comparisons, ranges, categorical/boolean state, AND/OR, a narrow
// temporal subset, and action verb+target parsing). Additive, independent
// of comparison-grammar.ts — see that module's own doc comment.
export * from './structured-expression-grammar.js';
export * from './structured-comparison-resolver.js';
// Action Capability Binding v1 — the first generic implementationClass
// this package resolves beyond deterministic_rule. Additive, independent
// of structured-comparison-resolver.js — see that module and this one's
// own doc comments for how the two partition contracts disjointly.
export * from './action-escalation-resolver.js';
export * from './resolve-binding.js';
export * from './standard-resolvers.js';
export * from './contract-extract.js';
// contract-builder.ts and contract-embed.ts are the only two modules in
// this package that import from @xo/xoir — see README.md's "Known
// limitation." Every other module (including contract-extract.ts above,
// the runtime-facing read path) is pure data/logic.
export * from './contract-builder.js';
export * from './contract-embed.js';
export * from './input-schema.js';
export * from './contract-hash.js';
export * from './provenance-projection.js';
