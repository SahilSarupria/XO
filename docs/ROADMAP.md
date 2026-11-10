# Detachable layer — roadmap and status

Legend: [x] done and tested · [~] done with a stated caveat · [ ] not done

## A. Prove the value on a real model

- [x] Gemini adapter, pilot and held-out run (gemini-3.1-flash-lite, 50 tasks): plain 22%, dump 46%, xo_tools 92%, xo_router 100%; unsafe auto-approvals 16% / 8% / 0%
- [~] No token or latency saving at this manual size (xo_tools ~18% fewer input tokens, 2 calls, slower)
- [ ] Diagnose xo_tools misses T03 and T34; run `prompt` arm
- [ ] Real-model uplift ratio: `xo ab-eval --arms compiled_context,xo_context --seed 31337 --style variant`

## B. Compiler

- [x] 7/7 compiler-gap checks on standard seeds
- [~] Held-out recall 77–79% (target 80%); tree agreement 100% (offline, heuristic fact binder)
- [x] Tree synthesis is domain-neutral (policy program IR); wired into `xo create`; negation, tables, PDF filters, workflow section split fixed
- [~] Model-assisted clause extraction + review ledger built, scripted-model tests only; not run live
- [~] Second domain (insurance triage) built and measured offline: untuned 7 %, 100 % after review (see DETACHABLE_INTELLIGENCE_LAYER.md)
- [x] Clarification engine (`policy/clarify.ts`, `xo compile-review`), input contract + operator field mapping, manual diff + stale-ruling detection, compile telemetry, corpus regression suite (4 manuals, stored baselines)
- [ ] Valid uplift run with `--include-compiled` on freight and insurance (needs API key); arm runner for insurance tasks (the hand-written gold XO now exists)

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
- [x] A (compiler emission): `xo create` lowers a policy document into a signed `workflows` component (structured + from-text workflows), validated against the tree it ships with, with a determinism/provenance report (declared, not measured), review items, and approvals held while review items are open (`docs/WORKFLOW_IR.md`, "Compiling policy documents into workflows"). Limits: only policy documents (not other source types); the extractor recognizes few sentence shapes, so real manuals mostly keep review items and therefore held approvals until a reviewer rules on them (`--review-ledger`); the only actions are a file record or none (`--decision-sink`); not measured on any real traffic
- [~] B. Connectors: framework, grants, dry-run, vault/redaction, HTTP, file done (`docs/CONNECTORS.md`); **Slack-compatible webhook, signed webhook-out and read-only database connectors done** on a shared `egress` (https, allowlist, pinned public address, no redirects, bounded) with adversarial suites, plus a strict operator `bindings` policy for file/http/webhook_out/slack_webhook/database/smtp; MCP client done (stdio + HTTP, allowlist, schema-validated args, untrusted results; **stdio servers are still NOT sandboxed** beyond an operator wrapper, and MCP cannot be bound from the CLI yet); SMTP connector done (fake-server tested only). The older `http` connector still resolves then connects by name (rebinding race open there). Not done: real sandboxing of stdio servers (item 4), external-vault adapters, a networked database driver (only an engine-read-only SQLite driver ships)
- [~] C. Durable runner done (`docs/WORKFLOW_RUNTIME.md`): on-disk hash-chained journal, at-most-once accept, crash-safe resume with same idempotency key, retries/backoff/jitter, breakers, per-connector concurrency, compensation, ceilings, kill switch, run cap, dry-run, `xo flow`. **Duplicate-call window narrowed, not closed** (per-operation `idempotency` attestation `supports_key|supports_lookup|none`, default `none`; ambiguous prior attempts are settled by key re-send, destination lookup, or an `AMBIGUOUS_EFFECT` escalation; `xo flow reconcile`; crash before/after every journal append tested; see "Duplicate-call window" in `docs/WORKFLOW_RUNTIME.md`). **Free-text extraction in workflows done offline** (generic `ModelExtractor` over any provider: JSON-encoded untrusted text, grounding with token-boundary quotes, one counted call, step timeout, refusals escalate; CLI uses the existing operator provider contract with `XO_EXTRACTOR_*` overrides, `--memo-dir`, `--daily-model-calls`, `--daily-effects`; never run against a live model). Rate limiting, dead letters, segments, forEach and event waits are done (item 5). (SMTP escalation and approval delivery done via `connectorEscalationSink`/`connectorApprovalSink`)
- [~] D. Approvals: requests, signed decisions (approve/reject/edit), roles, replay and cross-run protection, timeouts escalate, journaled (`docs/WORKFLOW_RUNTIME.md`). Done since: HTTP routes (`xo serve`), SMTP delivery. Not done: webhook delivery, trust-policy file, CLI commands
- [~] E. Done (runtime library, unmeasured): structured-first routing + extraction memoization, shadow mode + `xo flow compare`, ceilings/kill switch/daily caps, promotion loop (propose, shadow-validate, signed accept, new version). Compiler-side determinism analysis with source provenance and review items is done for policy documents (see A). Not done: `xo promote` CLI, spend (currency) caps
- [~] F. Done: lease + fencing, ledger replica with fork quarantine, `xo serve` API with token auth, Dockerfile.server, `@xo/sdk` client + `replicateRun` (`docs/FAILOVER.md`). Ollama and the other extractor adapters are done offline (see C). Not done: bundle loading in `xo serve` (so `/v1/loader/resolve` needs library use), anchoring of the new journal, multi-process authority, embed-in-app example
- [~] G. Done: `xo flow explain`, signed `audit-export` / `audit-verify` (`docs/WORKFLOW_RUNTIME.md`). `xo install|verify|uninstall` already existed before this branch (not changed or re-audited here). Multi-XO workflow linking with precedence and conflict reporting done for the workflow component only (`xo flow link`). Not done: linking of knowledge/trees/safety across XOs, `update`/`list` and trust-policy-file changes
- [~] H. Done: `docs/ACCEPTANCE_CRITERIA.md` (all rows proposed, unmeasured). Provider parity: offline parity test across OpenAI, Azure, Ollama and Gemini fakes (`packages/ai-core/test/provider-parity.test.ts`); it found and fixed three real gaps (OpenAI/Azure echoed the API key in error bodies; Gemini accepted non-object tool arguments and tool calls on truncated replies). **Capability detection done**: one shared host/family selector and per-component needs table for the layer and the loader API; a host without tool calling is served context-only (no tools offered, trees skipped with a reason), safety rules are always consumed, nothing vendor-specific in the layer (`docs/LAYER_CONTRACT.md`). Live parity not verified; an Anthropic error-redaction gap was found and fixed. Not done: efficiency items (request coalescing, prompt budgeting, low-resource flag, reuse of the loaded bundle and retrieval index on the hot path), compiler quality items (see compiler commits by others)

### Handoff checklist (what is and is not finished on this branch)

Ticks mean built, tested offline, documented, and merged to the feature branch. Nothing here has been measured against real traffic or a live model.

- [x] 1. Compile policy documents into signed workflows (+ determinism/provenance report, review items, approvals that cannot go fail-open)
- [x] 2. Free-text reading with a model inside a workflow (offline; grounding, budgets, operator config)
- [x] 3. Slack, webhook-out and read-only database connectors (+ operator bindings)
- [x] 4. MCP stdio servers are confined by default (bubblewrap, or namespaces-only on request), refused where unavailable unless the operator opts out, and the choice is journaled; `mcp` is bindable in the CLI — bubblewrap path not exercised on a real host yet; macOS/Windows have no confinement
- [x] 5. `xo flow promote` (signed publisher acceptance required), `forEach`, event waits (`POST /v1/events`, SDK, CLI), per-connector rate limiting, dead-letter store, segmented journal with bounded appends/`window` — built and tested offline; rate limits are per process, forEach conformance vectors are not written, nothing is measured on real traffic
- [x] 6. `xo serve --bundle`, `xo flow run --bundle`, `xo flow resolve` done and tested (verified package, fail-closed trust, same resolve logic as the HTTP endpoint, a real `xo serve --bundle` process tested); plus journal anchoring (`--anchor-file`/webhook, `xo flow verify-anchors`), `xo flow validate|report --bundle` and `examples/host-app-demo/embed-workflow.mjs`; anchors cover only entries up to the last anchor, and the sink must be outside the attacker's reach
- [~] 7. Server beyond localhost: built-in TLS, optional mutual TLS, per-client hashed/scoped/expiring/revocable/rotatable tokens (`xo token`), deny-by-default route scopes, audited refusals, lockout, deadlines and headers, refusal to start into an unsafe configuration; 64 real-socket/real-TLS adversarial tests plus real-process CLI tests (`docs/SERVER_HARDENING.md`). **Not claimed public-internet-ready**: no independent review, per-address (not per-client) limits, no cert hot-reload, no log rotation/signing, bearer-token replay possible if TLS is defeated. The container image now requires `--tokens` and a TLS arrangement
- [~] 8. Duplicate-call window: strongest honest mitigations built and fault-injected; **residual risk remains** and is documented (destinations that lie, lagging lookups, two runners on one run directory, effects outside connectors)
- [ ] 9. Approval webhook delivery, trust-policy file loader, approval CLI, `xo install|list|verify|update|remove` audit, cross-XO linking of knowledge/trees/safety, multi-process lease authority — **not started**
- [ ] 10. Efficiency (H2): coalescing, prompt budgeting, hot-path reuse, low-resource mode, whole-run wall-clock cap — **not started** (a step timeout now bounds extraction)
- [x] 11. Capability detection and graceful degradation
- [~] 12. This checklist and `ROADMAP.md` are updated; `ACCEPTANCE_CRITERIA.md` only for the duplicate-call row; **the PR description and the plain-language "what you can automate today" paragraph are not written yet**

**Deferred by instruction (unchanged):** live model evals, new benchmark domains, a second provider's live run, cost and hardware benchmarks.

**Known honest limits, current:** the journal detects tampering, not whole-directory deletion; a single process per run directory and a single lease authority; `xo serve` has not had an independent security review (see item 7); the `http` connector's DNS-rebinding race is not closed (the new webhook connectors close it for themselves); SMTP is tested only against a fake server; MCP stdio servers are not confined; nothing about accuracy, latency, cost or CPU/RAM is measured outside freight claims and the recorded second-domain offline run; two benchmark tests (`p09c-closure` #147 and `baseline.test` #35) fail at the branch's starting commit and are not caused by this work.
