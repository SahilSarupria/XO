# XO Customer Chat — Intelligence Specification

**Status:** Implemented (AI layer, API, in-memory ports). **Not yet implemented:** the customer-facing UI, the C6 Knowledge SDK adapter, chat-initiated execution. See §10.

## 1. The model: ASK → DECIDE → DO → LEARN

XO's customer-facing intelligence is one loop, and **the customer never chooses a mode**. They say what they want; XO works out which part of the loop the message belongs to and handles it.

| Step       | What it is                                                         | What XO does                                                                                                         | What XO will not do                                                      |
| ---------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **ASK**    | "What is the status of Project Alpha?" "Why was delivery delayed?" | Retrieve authorized evidence, answer with verified citations, state contradictions and gaps, give a confidence level | Answer about the organization from model memory; hide a source conflict  |
| **DECIDE** | "Should we expedite the shipment?" "What are our options?"         | Options, consequences, dependencies, risks, assumptions, and an _advisory_ recommendation                            | Recommend without cited evidence; present advice as a decision           |
| **DO**     | "Create a task for Priya to chase the broker."                     | Pick one capability the caller is authorized to use, validate its inputs, and **propose** it for approval            | Run anything; invent a capability; guess a missing input                 |
| **LEARN**  | "That's wrong, it was customs." "The expedite worked." 👍/👎       | File the correction / outcome / feedback in a review queue, tied to the answer it concerns                           | Edit organizational knowledge; let an unreviewed claim change any answer |

A fifth path, `converse` (greetings, "what can you do?"), exists for usability. It is **not** part of the loop and touches no organizational data.

The loop is the product. The layers below exist so each step can be trusted: the knowledge system decides what may be seen, the orchestrator decides how it is handled, the model only reads and writes within those limits.

## 2. Customer Chat is not the Developer Assistant

|           | Customer Chat (this spec)                           | Developer Assistant / Studio chat      |
| --------- | --------------------------------------------------- | -------------------------------------- |
| Audience  | Customers and their employees                       | The XO development team / Studio users |
| Context   | The organization's knowledge                        | Code, repository, installed XOs        |
| Knowledge | C6 (via `KnowledgePort`)                            | Documentation and code                 |
| Execution | XO capabilities, approval-gated                     | Development tools                      |
| Code      | `@xo/intelligence`, `routes/intelligence-routes.ts` | `routes/chat-routes.ts`                |
| Storage   | `state/conversations/`                              | `state/chats/`                         |

They share provider-neutral AI infrastructure (`@xo/ai-core`) and the model-choice rules (`chat/usable-models.ts`). They do **not** share agent configuration, prompts, tool registries, stores or threads.

## 3. Layering

```
 Experience      Customer Chat (UI — not built)         POST /workspaces/:id/intelligence/conversations/:id/turns
 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Orchestrator    @xo/intelligence  IntelligenceOrchestrator
                 understand intent · assemble context · ASK / DECIDE / DO / LEARN · guard rails
                       │ KnowledgePort (C6)     │ CapabilityPort (XO Runtime)     │ LearningPort (review queue)
 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
 AI Capability   @xo/ai-core  ConversationLayer
 Layer           provider selection · retry · circuit breaker · rate limit · fallback · cost · schema-checked output
 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Provider        Gemini (first) · Claude · OpenAI · Ollama … — behind one `ModelProvider` interface
```

Three concepts, kept separate:

- **AI Provider** — a vendor behind `ModelProvider`. Gemini is the _first_ provider, not the identity of the chat.
- **AI Orchestrator** — `@xo/intelligence`. Understands the request, assembles authorized context, runs the loop.
- **AI Experience** — Customer Chat today; Connect Assistant or others later. Each owns its own permissions and persistence.

The model **interprets and writes**. It never decides what it may access: every fact it sees came through a port that enforced authorization.

## 4. Contracts (the ports)

Everything organization-specific enters through one of three interfaces in `packages/intelligence/src/ports.ts`.

**`KnowledgePort.retrieve({ principal, query, limit })` — the C6 boundary.** MUST return only evidence the principal may see. Evidence carries a stable `id`, `sourceName`, `excerpt`, and (where known) `asOf`, `uri`, `score`. Returns `{status:'unavailable'}` or throws when it cannot answer; the orchestrator treats both as "knowledge unavailable". _The C6 SDK is not in this repository; this contract is the orchestrator's requirement of it, and the C6 adapter must be written to it._

**`CapabilityPort.listAuthorized(principal)` — the DO boundary.** MUST return only capabilities the principal may invoke. There is deliberately **no `execute`**.

**`LearningPort.record(event)` — the LEARN boundary.** Events are claims awaiting review. The shipped implementation (`FsLearningPort`) writes `state/learning/<id>.json` with `status: "pending_review"`.

`Principal = { identityId, workspaceId, role }` is built by the API from the authenticated caller, never from the request body, and passed to every port.

## 5. How each step is handled

**Routing.** One structured call (`conversation.route`) returns `{route, confidence, standaloneQuery, needsClarification, clarifyingQuestion}`. `standaloneQuery` resolves follow-ups ("why?") so retrieval is not run on a fragment. A DO or LEARN reading below 0.6 confidence is handled as a read-only ASK. A message that cannot be understood at all gets one clarifying question and nothing else happens.

**ASK.** Retrieve → prepare evidence (dedupe, rank, size limits, escape) → one structured call (`conversation.answer`) → verify.

**DECIDE.** Same retrieval; one structured call (`conversation.decide`) returning problems, 2–4 options (pros, cons, consequences, dependencies), risks with severity, assumptions, and a recommendation.

**DO.** List authorized capabilities → one structured call (`conversation.propose`) → validate. Output is an `ActionProposal` with `status: "proposed"` and `requiresApproval: true`, always.

**LEARN.** One structured call (`conversation.learn`) classifies `correction | outcome | feedback`; the event is filed with the id of the previous assistant answer and the evidence ids it cited. The reply text is fixed, not model-written, so it cannot over-promise.

## 6. Guard rails that do not depend on the model behaving

| Rule                                                                                                   | Enforced by                        |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| No evidence → no organizational answer; the model is not asked                                         | `ask()` / `decide()` short-circuit |
| Knowledge down or not configured → say so, never guess                                                 | `ungroundable()`                   |
| Citations are verified against what was retrieved; invented ones are removed                           | `CitationRegistry`                 |
| Answerable-but-uncited → confidence `low` + `ungrounded_answer` notice                                 | `ask()`                            |
| Conflicting sources → shown, confidence capped at `medium`                                             | `applyConflictCap()`               |
| Recommendation citing nothing, or naming no real option → dropped                                      | `decide()`                         |
| Evidence is escaped, so it cannot close its tag or forge another                                       | `escapeForPrompt()`                |
| DO: only listed capabilities; only declared inputs; strict type coercion; missing inputs are asked for | `act()`                            |
| DO cannot execute (no port method exists)                                                              | `CapabilityPort` shape             |
| LEARN never edits knowledge                                                                            | `LearningPort` contract            |
| Retrieval has a timeout (15 s default)                                                                 | `withTimeout()`                    |
| Provider/knowledge error text is logged, never returned to the user                                    | orchestrator, `ConversationLayer`  |

Every `TurnResult` carries machine-readable `notices` (`knowledge_unavailable`, `no_sources_found`, `ungrounded_answer`, `contradiction_detected`, `citations_removed`, `recommendation_dropped`, `action_unavailable`, `action_needs_input`, `learning_unavailable`, `routing_low_confidence`) so a UI can show _why_ an answer is weaker than it looks.

## 7. API

Under `/workspaces/{workspaceId}/intelligence/conversations`. Permission `read` (any member); conversations are private to their creator (another member's looks like 404).

| Method & path                                                          | Purpose                                                                                                        |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `GET`, `POST` `/`                                                      | List / start a conversation                                                                                    |
| `GET`, `DELETE` `/{conversationId}`                                    | Read (with structured results) / delete                                                                        |
| `POST` `/{conversationId}/turns` `{message}`                           | **The one endpoint.** Returns `{userMessage, assistantMessage}`; `assistantMessage.result` is the `TurnResult` |
| `POST` `/{conversationId}/messages/{id}/feedback` `{rating, comment?}` | 👍/👎 → LEARN queue                                                                                            |

Model choice comes from workspace Settings (primary, then fallback) through `usableModelChoices`, so air-gapped mode and server-side-credentials-only apply identically to every AI experience. Nothing is saved if every model fails. The audit entry (`intelligence.turn`) records route, confidence, counts, providers and cost — **never** question or answer text.

## 8. Provider layer (`@xo/ai-core`)

`ConversationLayer` is the conversational counterpart of `AiCapabilityLayer`. It reuses `RetryPolicy`, `CircuitBreaker`, `TokenBucketRateLimiter`, `CostAccountant`, `selectCandidates` and `validateJsonSchema` unchanged, and adds the tasks `conversation.route | answer | decide | propose | learn` to `ModelSelectionPolicy`, so a deployment can route cheap intent routing to a small model and grounded answering to a larger one without any caller naming a vendor. Structured replies are parsed and schema-validated before the orchestrator sees them; a bad reply is a failed attempt and falls through to the next candidate.

Gemini adapter fixes made on the way: safety-blocked and empty candidates no longer throw `TypeError` (reported as `content_filter`); the API key moved from the URL query string to the `x-goog-api-key` header.

## 9. Tests

`@xo/ai-core` (conversation layer, Gemini adapter), `@xo/intelligence` (29 tests: every path above, authorization, injection, timeouts, failures), and `apps/api` (end to end through HTTP, including that a Viewer's adversarial prompts write only to conversation, learning-queue and audit stores). The repo's route-authorization audit and OpenAPI sync tests cover the new routes.

## 10. Not done, and decisions needed

1. **UI.** No customer chat screen exists; this delivers the AI layer and API.
2. **C6.** Without an adapter, the chat answers "no organizational knowledge source is connected". Wire it with `createHttpServer({ intelligenceKnowledge: (workspace) => c6Adapter })`. If C6's real shape differs from `KnowledgePort`, adapt at the boundary — do not bend the orchestrator.
3. **Executing DO.** Proposals are not executable from chat. The runtime's AI-assisted execution route is currently disabled because capability-level authorization is not enforced on that path; DO should execute only through the approval flow once it is. Wiring `CapabilityPort` to the runtime's capability registry (with per-principal authorization) is the prerequisite.
4. **LEARN review.** Events queue as `pending_review`; no reviewer workflow or write-back exists. Until it does, LEARN changes nothing about future answers by design.
5. **Streaming.** Responses are returned whole. `ConversationLayer` is the place to add `converseStream`; Gemini's adapter does not implement streaming yet.
6. **DECIDE simulation** ("simulate impact when supported by available models") is not built.
7. **Tool-calling branch.** `feat/gemini-tool-calling` is on a separate lineage from `studio/*` and was not merged. This design deliberately avoids provider tool calling (structured output instead) so it does not depend on it.
8. **Live provider verification.** All model behaviour is tested against scripted providers. No real Gemini call was made; prompt quality and the router's accuracy need evaluation against real traffic and a multi-provider comparison.
9. **Gemini model list** in `ai-core` still names `gemini-1.5-*`; models are chosen per workspace in Settings, but the descriptor list is stale.
