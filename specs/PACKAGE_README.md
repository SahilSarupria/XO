# Corporate Contract & Commercial Lawyer XO — Package README

This is the flagship, spec-conformant XO referenced in `../SPECIFICATION.md`. It exists to demonstrate that the XO architecture can capture, package, evaluate, and transfer real professional capability — not just to populate a marketplace listing.

## 1. What's actually in this package

| Component | File | Status |
|---|---|---|
| Manifest | `manifest.json` | Complete |
| Metadata | `metadata.json` | Complete |
| Knowledge Graph | `knowledge/graph.json` | Complete — 8 doc types, 22 clause types, typed relationships |
| Decision Trees | `reasoning/decision_trees.json` | Complete — 5 trees |
| Reasoning Traces | `reasoning/reasoning_traces.jsonl` | **Representative sample (15 of a planned 300+)** — see §3 |
| Case Library | `reasoning/case_library.json` | Complete — 7 sector scenarios |
| Prompt Strategies | `prompting/strategies.json` | Complete — persona, 5 workflows, 3 tool schemas |
| Safety Rules | `safety/rules.json` | Complete — 6 rules |
| Evaluation Suite | `evaluation/benchmark_suite.json` | Complete — 7 categories, 550-task methodology defined |
| Licensing | `licensing/license.json` | Complete — tiered pricing + 4-party royalty split |
| Provenance | `provenance/contributors.json`, `provenance/version_history.json` | Complete |
| Cryptographic signatures | `signatures/` | **Not included** — placeholder hashes only, see §4 |
| LoRA / fine-tuned weights | `weights/` | **Not included** — Llama compatibility entry in manifest is aspirational for this build |

## 2. Why the package is honest about being incomplete in two places

The spec's promise is that trust is *measured*, not asserted (see SPECIFICATION.md §3). It would undercut that promise to ship a "flagship" package with fabricated cryptographic hashes or a fabricated 300-trace corpus padded with low-quality filler. Instead:

- **Signatures/hashes** are marked as placeholders computed by the packaging CLI at actual publish time (`xo pack`, §4 below) — this is a real operational step involving real key material, which doesn't exist in a demo context.
- **Reasoning traces** ship as 15 fully-worked, high-quality examples that establish the exact schema, reasoning depth, and confidence-calibration style every additional trace must match. Scaling to 300+ is a production data-pipeline exercise (synthetic generation against the decision trees + knowledge graph, then expert review against the same rubric used in `evaluation/benchmark_suite.json`), not a change in kind — the 15 here are the actual template.

## 3. How the full 300+ reasoning-trace corpus gets built

1. **Seed generation**: for each (document_type × clause_type) pair in the knowledge graph (176 combinations), generate 1-3 candidate reasoning traces using the existing 15 as few-shot exemplars, targeting realistic clause variations pulled from public contract-drafting corpora.
2. **Decision-tree cross-check**: any generated trace whose clause type maps to an existing decision tree (§ `decision_trees.json`) is validated for logical consistency against that tree's leaf outcomes — a trace that recommends "reject" for a fact pattern the tree would resolve to "accept" is flagged for review, not silently kept.
3. **Expert review pass**: sampled at minimum 20% by a licensed-attorney reviewer panel (see `provenance/contributors.json`, role `expert_reviewer`), scored against the same rubric as `evaluation/benchmark_suite.json`'s `reasoning_quality` category.
4. **Promotion to package**: only traces passing review are added to `reasoning_traces.jsonl`; each addition is a version bump with a changelog entry per SPECIFICATION.md §11 versioning requirements.

## 4. Packaging into a distributable `.xo` archive

Not run in this environment (no signing key material available), but the real production step is:

```
xo pack ./xo-corporate-contract-lawyer \
  --sign-with <creator-private-key> \
  --co-sign <reviewer-private-key> \
  --out xo-corp-contract-lawyer-1.0.0.xo
```

This computes the SHA-256 hash of every component file, builds the Merkle root, writes it into `manifest.json`, signs it, and produces the zstd-compressed archive matching the layout in SPECIFICATION.md §1.1.

## 5. How this maps back to the spec

- Compatibility levels (§2.2): this XO reaches **L3** on Claude, GPT, Gemini, and DeepSeek (tool-use hosts, via `decision_trees` exposed as callable tools); **L1** on Mistral/Qwen/generic hosts (knowledge graph + prompt strategies only); **L4 aspirational** on Llama pending a real LoRA artifact.
- Benchmark & challenge system (§3): `evaluation/benchmark_suite.json` defines the methodology a verifier would run; `provenance/version_history.json` shows where `benchmark_history.json` would be populated after a real verifier run.
- Royalties (§4): `licensing/license.json`'s `royalty_split` sums to exactly 10000 bps across 4 roles, matching the settlement contract's enforcement assumption in SPECIFICATION.md §5.3.
- Safety (§8 of the spec, general security model; domain-specific safety in `safety/rules.json`): the unauthorized-practice-of-law and citation-fabrication rules are the two most consequential for this specific domain and are written as hard triggers, not soft suggestions.
