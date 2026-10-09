# XO Phase 2 — Structured Semantic Expressions: Final Report

## 1. Phase 2 diagnosis

**What was lost, and where.** Phase 0/1's `rule-pattern-parser.ts` correctly *finds* rules and splits them into `condition`/`action`/`outcome`/`exceptionConditions` — but every one of those fields is a plain string. That string flowed verbatim through `ReasoningNode` → `reasoning-to-xoir.ts#buildProperties` → XOIR `heuristic`/`decision_node`/`constraint` node properties → `contract-builder.ts` → `SemanticCapabilityRule.condition`/`outcome`, with meaning (which field, which comparison, which threshold, which logical relationship) never extracted anywhere along that chain. The **only** place any structure existed was `@xo/capability-contract`'s `comparison-grammar.ts`, applied very late (at binding-resolution time) and deliberately narrow: exactly one numeric comparison per rule, no AND/OR, no ranges, no categorical state, no temporal, no exceptions — and its output was never written back into XOIR/EIR, so nothing downstream of the resolver (packaging, benchmarking, other consumers) could see it either.

## 2. Structured representation

Reused, not reinvented: `@xo/capability-contract` already owned "the one closed deterministic grammar" as its architectural charter (see its `comparison-grammar.ts`). Phase 2 adds a second, additive module in the same package — `structured-expression-grammar.ts` — rather than inventing a new IR layer, a second competing representation, or touching XOIR's node/edge *taxonomy*. The new type is:

```ts
type StructuredCondition =
  | { type: 'comparison';  field: string; operator: '>'|'<'|'>='|'<='|'=='|'!='; value: number; unit?: string }
  | { type: 'categorical'; field: string; operator: '=='|'!='; value: string }
  | { type: 'range';       field: string; min: number; max: number; unit?: string }
  | { type: 'temporal';    relation: 'within'|'after'|'before'|'during'; amount?: number; unit?: string; anchor?: string }
  | { type: 'and'; operands: StructuredCondition[] }
  | { type: 'or';  operands: StructuredCondition[] };

type StructuredAction = { type: 'action'; action: string; target?: string };
type StructuredExceptionCondition = { raw: string; condition?: StructuredCondition };
```

- `field`/`action`/`operator`/`value` — self-explanatory; `field` is kept as the natural-language noun phrase (e.g. `"the claim assessment amount"`), never forced into a synthetic identifier — identifier resolution is `capability-contract`'s existing `resolveFieldKey`'s job, unchanged.
- `unit` — currency code/symbol, carried when present (`"INR 10,000"` → `value: 10000, unit: 'INR'`).
- `temporal` — **structure only**, never evaluated. Exactly one of `{amount,unit}` or `anchor` is set. No wall-clock/reference-date model exists anywhere in this code — by design (see §8, out of scope).
- `and`/`or` — built only when *every* operand independently parses; one bad operand fails the whole expression (never a silently-smaller, wrong conjunction).

**Where it's attached:** optional fields on `ReasoningNode` (compiler-internal), on XOIR's `HeuristicNodeProps`/`DecisionNodeNodeProps`/`ConstraintNodeProps` (the three kinds `contract-builder.ts` actually consumes — `reasoning_step`/`escalation_rule`/`risk_policy` deliberately untouched, see §8), and on `SemanticCapabilityRule`. All additive; every existing field is unchanged, and the fields are always absent (never emitted as `null`/best-effort-wrong) when the source text doesn't confidently parse.

## 3. Before → after

| | Real `burglary-policy.pdf` | Synthetic `synthetic-claim-rules.txt` | Phase 2 synthetic benchmark (46→47¹ cases) |
|---|---|---|---|
| Rules discovered (unchanged from Phase 1) | 8 | 1 | — |
| Rules with `structuredCondition` | 6 | 1 | 29 (of 30 non-`unresolved`-expected cases) |
| Rules with `structuredAction` | 0² | 1 | 6 (of 6 non-`unresolved`-expected action cases) |
| Unresolved (correctly, no shape matched) | 2 | 0 | 18 |
| Structured semantic **precision** | 6/6 = 100% | 1/1 = 100% | **29/29 = 100%** |
| Structured semantic **recall** (of confidently-structurable ground truth) | 6/6 = 100% | 1/1 = 100% | **29/29 = 100%** |

¹ 47 after the `<=`-category negative case added during test-driven fixture completion (see §6).
² The real corpus's 8 rules are exclusion/obligation statements (`constraint` kind, no action/outcome slot in that XOIR shape) — action structuring only applies to `heuristic`/`decision_node` kinds, and none of the 8 real rules are `decision`/`rule` type. This is a real, honest property of this specific document, not a Phase 2 limitation — the synthetic fixture (§4) demonstrates action structuring works correctly where the shape applies.

Zero false positives, zero false negatives, across every category in both the real-source validation and the synthetic benchmark.

## 4. Concrete real-source examples

**Synthetic fixture, `synthetic-claim-rules.txt`** (the brief's own flagship example, verified byte-for-byte):

```
SOURCE:   "If the claim assessment amount exceeds 10000, then deny the claim."
STRUCTURED CONDITION: {type:'comparison', field:'the claim assessment amount', operator:'>', value:10000}
STRUCTURED ACTION:    {type:'action', action:'deny', target:'the claim'}
XOIR (decision_node): {question:"the claim assessment amount exceeds 10000", outcome:"deny the claim",
                        structuredCondition:{...as above...}, structuredAction:{...as above...}}
LOWERING: StructuredComparisonBindingResolver -> status "resolved", implementationClass "deterministic_rule".
          evaluate({claim_assessment_amount: 15000}) -> {matched:true, outcome:"deny the claim"}
          evaluate({claim_assessment_amount: 5000})  -> {matched:false}
```
(Verified against a live `capability` node + `REQUIRES` edge, end to end, not just unit-tested in isolation.)

**Real `burglary-policy.pdf`, categorical exclusions:**

```
SOURCE:   "Terrorism cover is excluded."
STRUCTURED CONDITION: {type:'categorical', field:'Terrorism cover', operator:'==', value:'excluded'}
XOIR (constraint):    {rule:"Terrorism cover is excluded", severity:"blocking", structuredCondition:{...}}
LOWERING: categorical leaf compiles to a deterministic string-equality check; not exercised by run.ts's
          fixture (no capability node links to this constraint), but StructuredComparisonBindingResolver's
          own test suite verifies categorical lowering against synthetic contracts (§6).
```

```
SOURCE:   "Theft and RSMD is Excluded"
STRUCTURED CONDITION: {type:'categorical', field:'Theft and RSMD', operator:'==', value:'excluded'}
```
(Demonstrates the grammar correctly does NOT tear this apart into a false "Theft AND RSMD-is-excluded" conjunction — neither "Theft" nor "RSMD is Excluded" independently parses as a condition, so the whole phrase is kept as one field.)

```
SOURCE:   "any of the information provided is incorrect"   [rule condition; action text is "valid" — see §8]
STRUCTURED CONDITION: {type:'categorical', field:'any of the information provided', operator:'==', value:'incorrect'}
STRUCTURED ACTION:    unresolved — "valid" is not a recognized imperative verb (correctly refused, not guessed)
```

**Real `burglary-policy.pdf`, correctly left unresolved (precision over recall):**

```
SOURCE: "there is 24 hours security in the premises"                                 -> unresolved (no supported shape)
SOURCE: "...maintained in well working condition throughout policy period"           -> unresolved ("throughout" is not a recognized temporal cue)
```

## 5. Files changed

New files:
- `packages/capability-contract/src/structured-expression-grammar.ts` — the Phase 2 grammar.
- `packages/capability-contract/test/structured-expression-grammar.test.ts` (32 tests)
- `packages/capability-contract/test/structured-comparison-resolver-phase2.test.ts` (10 tests)
- `packages/compiler/src/reasoning/structured-semantics.ts` — per-`nodeType` source-text dispatch glue.
- `packages/compiler/test/reasoning/structured-semantics.test.ts` (10 tests)
- `packages/compiler/test/reasoning/phase2-semantic-benchmark.test.ts` (2 tests)
- `examples/vertical-test/phase2-semantic-fixture.ts` — the 47-case ground-truth benchmark fixture.
- `examples/vertical-test/phase2-semantic-benchmark.ts` — benchmark runner/report script.

Modified files:
- `packages/capability-contract/src/types.ts` — `SemanticCapabilityRule.structuredCondition`/`structuredAction`/`structuredExceptions` (optional, additive).
- `packages/capability-contract/src/index.ts` — export the new module.
- `packages/capability-contract/src/contract-builder.ts` — projects XOIR structured properties into the contract.
- `packages/capability-contract/src/structured-comparison-resolver.ts` — generalized to compile AND/OR/range/categorical `structuredCondition` trees, with temporal-leaf and no-structured-condition fallback to the original (unmodified) narrow grammar.
- `packages/xoir/src/node-kinds.ts` — optional `structuredCondition`/`structuredAction`/`structuredExceptions` on `HeuristicNodeProps`/`DecisionNodeNodeProps`/`ConstraintNodeProps`.
- `packages/compiler/src/reasoning/types.ts`, `extractor-types.ts` — same optional fields on `ReasoningNode`/`CandidateReasoningNode`.
- `packages/compiler/src/reasoning/rule-based-extractor.ts` — calls `buildStructuredSemantics` per candidate.
- `packages/compiler/src/reasoning/merge.ts` — carries `structuredCondition`/`structuredAction` through merge (`pickField`); **rebuilds** `structuredExceptions` fresh from the final merged `exceptionConditions` list rather than picking a candidate's own array (order-safety, see the file's own doc comment).
- `packages/compiler/src/xoir/reasoning-to-xoir.ts` — `buildProperties` attaches structured fields for the three consumed kinds, JSON-round-tripped for `XoirValue` safety (same technique `contract-embed.ts` already uses).
- `packages/compiler/test/reasoning/reasoning-extractor.test.ts` — +4 Phase 2 integration tests.
- `packages/compiler/test/xoir/reasoning-to-xoir.test.ts` — +5 Phase 2 integration tests.

**Not touched:** `comparison-grammar.ts`, `rule-pattern-parser.ts`, any Phase 0/1 extraction pattern, `xoir-to-package.ts`, the Packager, the Runtime, `registry`, `apps/api`.

## 6. Tests

| | Total | Passed | Failed | Skipped | New | Notes |
|---|---|---|---|---|---|---|
| `@xo/compiler` | 555 | 555 | 0 | 0 | 21 | 534 Phase 0/1 baseline + 21 Phase 2 |
| `@xo/capability-contract` | 78 | 78 | 0 | 0 | 42 | 36 baseline + 32 grammar + 10 resolver |
| `@xo/xoir` | 119 | 119 | 0 | 0 | 0 | Unaffected (only optional property-type additions) |

During test-driven development I found and fixed **3 real grammar bugs** before they reached production code: a range parser capturing a trailing copula word into `field`; comparison/temporal atoms silently spanning a top-level `"or"`, swallowing an unrelated clause into a wrong field; and a categorical atom similarly swallowing a genuine `"A and B"` conjunction where both operands independently parsed. All three are now covered by explicit regression tests. I also found and fixed one incomplete fixture category (`<=` had no negative case) during writing the benchmark's own category-completeness test.

Pre-existing failures found (not introduced by Phase 2, not fixed — see §7/§8): `examples/vertical-test/run.ts`'s package-signature round-trip fails `PackageValidator.validateAll()` with `SIGNATURE_INVALID` on the **pristine, unmodified Phase 1 checkpoint** (verified by re-extracting the original zip and running it independently, before any Phase 2 code existed).

## 7. Regression status

- **Phase 0**: confirmed intact — extraction quality, candidate plausibility, and every existing pattern-matching test pass unchanged (534/534 baseline compiler tests still pass verbatim).
- **Phase 1**: confirmed intact — real `burglary-policy.pdf` still produces exactly 8 reasoning nodes (both via direct extraction and via `examples/e2e-pdf/run.ts`'s full harness); provenance remains 100% (unaffected — Phase 2 adds fields, never touches provenance construction).
- **Provenance**: 100%, unchanged.
- **Real `burglary-policy.pdf`**: `examples/e2e-pdf/run.ts` passes identically before/after Phase 2 (same node/edge counts at every stage: 8 reasoning nodes, 262 XOIR nodes, 417 edges); the only observed difference is the packaged `.xo` archive being 106 bytes larger — exactly the expected footprint of the new structured properties on the 6 rules that now carry them.
- **Fresh-zip verification**: re-extracted the final deliverable zip into a clean directory, ran `npm install && npm run build` and all three affected packages' test suites from scratch — 555/555, 78/78, 119/119, all green.

## 8. Deferred findings

- **Pre-existing bug, `examples/vertical-test/run.ts`**: `PackageValidator.validateAll()` fails with `SIGNATURE_INVALID` on the round-tripped package, reproduced identically on the pristine Phase 1 checkpoint (i.e. before Phase 2 existed). Not a Phase 2 regression; not fixed, per the brief's explicit scope boundary.
- **Real-PDF extraction artifact**: the real `burglary-policy.pdf`'s "The policy is not valid, if any of the information provided is incorrect" sentence is split across a page boundary by Phase 0/1's paragraph chunking, leaving only `"valid"` as the `action` text for that rule. Phase 2 correctly leaves this unstructured (`"valid"` is not a recognized imperative verb) rather than guessing — but the underlying truncation is a Phase 0/1 chunking limitation, not something Phase 2 should paper over.
- **`ai-extractor.ts`** (the optional, disabled-by-default AI-assisted extraction path) was not wired to compute structured semantics — it's off by default (`hybrid-extractor.ts` only uses it when an `aiExtractor` is explicitly supplied) and untested in the current environment. Wiring it would be a small, mechanical follow-up using the same `buildStructuredSemantics` function.
- **`reasoning_step`/`escalation_rule`/`risk_policy`** XOIR kinds were deliberately left without a structured-condition slot — nothing downstream (`contract-builder.ts`) consumes them into a `SemanticCapabilityRule` today, so adding structure there would be speculative rather than the "smallest correct extension" the brief asks for.
- **`StructuredComparisonBindingResolver`'s temporal handling**: a `structuredCondition` containing a `temporal` leaf (bare, or nested inside `and`/`or`) fails compilation and falls back to the legacy single-comparison grammar on raw text. This is intentional (no temporal logic engine, per the brief), but means a rule whose *only* condition is temporal can never resolve to an executable binding today — it's structured, but inert. A future Phase 3+ execution model would need a wall-clock/reference-date input contract before that could change.
- **Multi-document precedence, layout-aware document intelligence, OCR, production observability/persistence, enterprise security, XO ecosystem/Studio/roadmap** — untouched, as instructed.

## 9. Final verdict

PHASE 2 COMPLETE
