# 0008: Customer chat is one ASK → DECIDE → DO → LEARN loop, built as orchestrator + ports over a provider-neutral layer

## Status

Accepted

> **Amended (2026-11-13, UW-0)** by [ADR 0013](0013-canonical-conversation-store.md): point 7's separation is moot because Studio's
> chat now uses Customer Chat; `cnv_` is the canonical store and `cht_` is deprecated. Point 5 (DO proposes, never executes) stands:
> execution goes through the workflow service and the authorization point (ADRs 0010, 0011). The text below is unchanged.

## Context

XO's customer-facing chat must let employees interact with their organization's intelligence in plain language without knowing about connectors, graphs or capabilities. The product thesis is a single loop — **ASK → DECIDE → DO → LEARN** — and the existing Studio chat (`chat-routes.ts`) is a different thing: a conversation-only assistant for Studio users with no knowledge access, no actions and no feedback path.

`@xo/ai-core` exposed only six document-extraction capabilities; there was no way to hold a conversation through it with retry, fallback, circuit breaking and cost accounting.

## Decision

1. **One universal assistant, no modes.** The orchestrator infers ASK, DECIDE, DO or LEARN from each message. Uncertain DO/LEARN readings degrade to read-only ASK.
2. **Three separated concepts:** AI Provider (vendor), AI Orchestrator (`@xo/intelligence`), AI Experience (Customer Chat). Gemini is the first provider, not the chat's identity.
3. **Ports, not integrations.** Knowledge (C6), capabilities (XO Runtime) and learning enter through `KnowledgePort`, `CapabilityPort`, `LearningPort`. The model never decides what it may access. No second retrieval system is built in Studio.
4. **Grounding is enforced in code, not requested in prompts:** no evidence → no organizational answer; citations verified; uncited recommendations dropped; conflicts surfaced and cap confidence.
5. **DO proposes, never executes.** There is no execute method on `CapabilityPort`. LEARN files claims for review and never edits knowledge.
6. **Extend `@xo/ai-core` with `ConversationLayer`** reusing its resilience building blocks, rather than a parallel stack. Structured output (not provider tool calling) carries routing and results, so the design does not depend on the unmerged tool-calling branch.
7. **Keep Customer Chat and Studio chat separate** (routes, store, prompts, permissions), sharing only provider infrastructure and model-choice rules.

## Consequences

- Any provider with structured output can run the whole experience; swapping or comparing providers touches no orchestration code.
- Without a C6 adapter the chat is honest but not useful; C6 integration is the critical next step.
- Two model calls per turn (route, then handle). Routing can be pointed at a small model via `ModelSelectionPolicy`.
- Chat-initiated execution is deferred until capability authorization is enforced on the execution path.

See `docs/intelligence/CUSTOMER_CHAT.md`.
