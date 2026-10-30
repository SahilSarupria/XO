# Detachable Intelligence Layer — what exists, what it proves, what it doesn't

Implements the AIE workstream (AIE-1 … AIE-6) as running code with a measurable claim:
**any LLM + XO beats the same LLM alone, a strong prompt, and a pasted-in manual — at lower cost, with
fail-closed safety — and the same layer runs unattended.**

## Pieces

| Package                  | Role                                                                                                                                                                                                                                                                                                              | AIE  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `@xo/ai-core` (extended) | Provider-neutral **tool calling** (Anthropic wired; other providers _reject_ tool requests rather than silently dropping tools)                                                                                                                                                                                   | 3    |
| `@xo/capability-layer`   | SPEC §2.3 `CapabilityLayer`: safe expression language, executable **decision trees**, BM25 + multi-query RRF + graph-expansion retrieval, exemplars, prompt fragments, **safety gate (fails closed)**, signed load receipt, tool loop, and `XoExecutor` (**cache → local tree → model**, hard call/token budgets) | 1, 2 |
| `@xo/ab-eval`            | Halvorsen freight-claims scenario (independent oracle, 50 seeded tasks, hand-authored gold XO), 6 arms, deterministic scoring, paired-bootstrap stats, compiler-gap metric                                                                                                                                        | 5    |
| `@xo/automation`         | Unattended operation: schedule / file-drop / **HMAC-signed webhook** triggers, **sandboxed evaluator**, hash-chained ledger, engine with idempotency, retries, dead-letter, crash recovery, human-escalation outbox                                                                                               | 4, 6 |
| `xo` CLI                 | `ask`, `ab-eval`, `compiler-gap`, `desk`, `ledger-verify`; AI path enabled via **operator env config only** (no key flags, endpoint allowlist)                                                                                                                                                                    | 3    |

## Run it

```bash
npm ci && npm run build
xo ab-eval --self-test                       # plumbing check with simulated models — NOT a measurement
XO_MODEL=<model-id> ANTHROPIC_API_KEY=… xo ab-eval --trials 3 --include-compiled --out out/ab
xo compiler-gap                              # no model needed
xo ask --text c --facts '{"claim_type":"loss",…}'      # solved locally, 0 model calls
XO_WEBHOOK_SECRET=… xo desk --state ./desk --inbox ./inbox --webhook-port 8099
xo ledger-verify ./desk/ledger.jsonl
```

## Sandbox guarantees (verified at start-up by `selfTest`, not assumed)

Worker process: filesystem write/read-outside-allowlist denied, process spawn denied, worker threads denied,
`new Function`/`eval` denied, no parent environment (no API keys), V8 heap cap, SIGKILL on timeout and respawn.
**Node's permission model does not block network access** — network isolation uses a Linux network namespace
(`unshare -rn`); if that is required and unavailable the sandbox refuses to start. Models are called from the
parent only, so keys never enter the sandbox. Defense in depth: the expression language itself has no property
access, no `eval`, and a fixed function table.

## Honest limits

- **No real-model numbers are in this repo yet.** No API key was available when this was built. `--self-test`
  numbers come from scripted stand-ins and are labelled as such in every report.
- The scenario is _fictional_ (so models cannot know the rules). It therefore measures how well expertise is
  **transported and applied**, not how well it was **captured from a real expert**. The manual is small
  (about 25 rules + 120 filler entries); a pasted-in manual is a strong baseline at this size and XO's win
  there is expected to be cost/determinism/safety rather than accuracy.
- Gold retrieval depends on author-declared structure (pinned gate rules, `applies_with` edges, node kinds).
  The compiler does not emit that structure yet — see the gap table.
- Ledger is tamper-_evident_, not tamper-proof (anchor `ledgerHead` externally). Webhook replay protection is a
  timestamp window plus idempotency keys. Linux-only network isolation. `xo run` (legacy ExecutionEngine path)
  remains gated; the new commands are the enabled AI path.

## Compiler gap (measured, no model involved) — the target for step 5

| check                                                       | target   | now                |
| ----------------------------------------------------------- | -------- | ------------------ |
| knowledge coverage vs gold                                  | ≥ 90 %   | 71 % (12/17 facts) |
| retrieval recall@9 vs gold                                  | ≥ 80 %   | 35 % (gold: 100 %) |
| executable decision tree                                    | yes      | none               |
| worked examples / prompt strategy / executable safety rules | ≥ 1 each | 0 / no / 0         |
| real-model uplift ratio (compiled − plain) / (gold − plain) | ≥ 0.8    | _needs an API key_ |

Concrete compiler defects found: normative sentences are filed under `safety_rules` instead of the knowledge
graph (the runtime now indexes them as constraints, +18 pts); bold run-in headings leave truncated `definition`
fields; no way to mark always-applicable "gate" rules; no co-application edges; no tree synthesis.
