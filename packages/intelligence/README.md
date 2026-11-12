# @xo/intelligence

The XO Intelligence Orchestrator: the layer between a customer-facing experience and the AI provider.

It turns one message into one of the four steps of XO's loop — **ASK → DECIDE → DO → LEARN** — with no mode switch:

- **ASK** answers from authorized organizational evidence, with verified citations, contradictions, gaps and confidence.
- **DECIDE** lays out options, consequences and risks and gives advisory, cited recommendations.
- **DO** proposes one authorized capability with validated inputs. It never runs anything.
- **LEARN** files corrections, outcomes and feedback for review. It never edits knowledge.

```ts
const orchestrator = new IntelligenceOrchestrator({
  model: conversationLayer, // @xo/ai-core ConversationLayer — provider-neutral
  knowledge, // KnowledgePort  (C6 boundary)
  capabilities, // CapabilityPort (optional; DO is "unavailable" without it)
  learning, // LearningPort   (optional; LEARN is "unavailable" without it)
});
const result = await orchestrator.handle({ principal, message, history });
```

Authorization lives in the ports, never in the model. `StaticKnowledgePort` and friends in `testing.ts` are test doubles, not a retrieval system.

Full specification: [`docs/intelligence/CUSTOMER_CHAT.md`](../../docs/intelligence/CUSTOMER_CHAT.md).
