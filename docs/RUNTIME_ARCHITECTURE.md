# Runtime architecture (as implemented)

> The original `RUNTIME_ARCHITECTURE.md` referenced by README/CONTRIBUTING was never committed to this repository.
> This file describes what the code **does today**; it is not a recovered copy of that design document.
> Where the code and the older design differ, the code wins. Contract details: `LAYER_CONTRACT.md`.

## Flow

1. **Mount** – `createCapabilityLayer(bundle, { host, integrity?, trust?, signing? })` verifies the bundle (digests, optional signature and Merkle root; fails closed) and emits a load receipt.
2. **Retrieve** – `layer.retrieve(query, k)` returns the top-k knowledge and safety nodes, CPU-only (p50 under 8 ms up to 2,000 nodes; `CPU_BENCHMARK.md`).
3. **Decide locally** – `executeTool('evaluate_decision_tree', { facts })` runs the compiled tree in a closed expression language. Missing or unrecognised inputs fail closed (escalate), never guess.
4. **Gate** – `safetyGate(action)` returns `{ allowed, violations, override? }`; blocked actions are replaced by an escalation.
5. **Model (only if needed)** – cache, then tree, then model. Host adapters: Gemini, OpenAI, Azure OpenAI, Ollama (tool calling), plus the Anthropic path.
6. **Unattended** – `@xo/automation`: hash-chained ledger, idempotency keys, outbox lanes, sandboxed evaluator, cron and webhook triggers, escalation delivery, anchors, metrics (`AUTOMATION_OPERATIONS.md`).

## Known limits

- The ledger is held in memory (~1 KB/entry); single-writer lock, no multi-host dedupe.
- Compiler held-out retrieval recall is 77–79% of gold facts (target 80%); real-model uplift not yet measured.
