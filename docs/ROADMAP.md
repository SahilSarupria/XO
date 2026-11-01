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
