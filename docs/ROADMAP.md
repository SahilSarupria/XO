# Detachable layer — roadmap and status

Legend: [x] done and tested · [~] done with a stated caveat · [ ] not done

## A. Prove the value on a real model

- [x] Gemini adapter, pilot and held-out run (gemini-3.1-flash-lite, 50 tasks): plain 22%, dump 46%, xo_tools 92%, xo_router 100%; unsafe auto-approvals 16% / 8% / 0%
- [~] No token or latency saving at this manual size (xo_tools ~18% fewer input tokens, 2 calls, slower)
- [ ] Diagnose xo_tools misses T03 and T34; run `prompt` arm
- [ ] Real-model uplift ratio: `xo ab-eval --arms compiled_context,xo_context --seed 31337 --style variant`

## B. Compiler

- [x] 7/7 compiler-gap checks on standard seeds
- [~] Held-out recall 77–79% (target 80%); tree agreement 100%

## C. Integration

- [x] Contract/versioning docs, host demo, CPU benchmark, OpenAI/Azure/Ollama tool calling, signature + Merkle verification, `xo run` on operator config
- [~] The TUI keeps its own provider flags

## D. Unattended operation

- [x] Sandbox fallback, single-writer lock, anchoring, TLS posture, delivery adapters, metrics, cron, soak
- [~] No multi-host dedupe, no email delivery, soak is seconds-scale

## E. Evaluation rigor

- [x] Abstention (missing-fact) task set with an explicit shared instruction: `--task-set abstain`
- [x] Cost per task and per correct task (`--price-in/--price-out`), tested
- [x] `xo ab-compare` side-by-side of runs
- [x] Retrieval recall@9 at scale: 92–93% from 141 to 2,021 nodes (`scripts/bench-scale-accuracy.mjs`)
- [x] Abstain set run on gemini-3.1-flash-lite (n=10): plain 10%, dump 0%, xo_tools 0% pass; xo_tools invented damage_pct in 10/10 calls. Fix built: `xo_tools_grounded` arm (fact grounding), live result pending
- [ ] Not yet: no second scenario; no refuse/ambiguous strata beyond missing-fact

## F. Release

- [x] Roadmap, runtime architecture doc
- [ ] PR merged, CI green on GitHub

## E6. Deterministic classification (offline only)

- [x] Glossary lookup + reconciliation before the model's value is trusted; high-risk override, conflict escalation, model-assisted flag; compiler extracts class definitions from a document and reports what it does and does not define
- [~] Freight: the manual defines no goods for any class, so coverage rests on an operator glossary (upper bound on generated claims). Tested offline on seeds 1234, 2468, 8080, 13579, 777777.
- [ ] Live effect on the seed-9001 failure cluster: unmeasured. Run `--arms xo_tools,xo_tools_classified` later.

## G. Workflow automation (branch feat/detachable-layer-b-f)

All items below are **unmeasured**; the only measured results remain section A (freight claims only).

- [x] A. Workflow IR 1.0: types, published JSON Schema, fail-closed validator, graph/state semantics, negotiation, pure decide evaluator, conformance vectors, `workflows` package component (manifest, Merkle, layer, L3), freight reference workflow (`docs/WORKFLOW_IR.md`)
- [ ] A (remaining): `xo workflow validate` CLI entry; compiler emission of workflows
- [ ] B. Connectors (HTTP, MCP, file, SMTP), grants, sandboxes, vault
- [ ] C. Durable runs, retries, circuit breakers, compensation runner, on-disk ledger segments
- [ ] D. Approvals (API, roles, signatures)
- [ ] E. Determinization (compile-time analysis exists only as the declaration-based `determinismReport`), structured-first routing, promotion loop, shadow mode, authority limits
- [ ] F. Local/server runners, lease protocol, ledger sync, `@xo/sdk`
- [ ] G. Package lifecycle commands, audit export, `xo explain`
- [ ] H. Compiler quality, efficiency, provider parity tests, `docs/ACCEPTANCE_CRITERIA.md`
