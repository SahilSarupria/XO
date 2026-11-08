# XO Customer Chat — Intelligence Specification

**Status:** Implemented: AI layer, API, Studio chat wired to it, interim knowledge sources (installed XOs and uploaded files), and a tested C6 adapter. **Not yet implemented:** a C6 environment per workspace (so Studio does not use C6 yet), chat-initiated execution, the LEARN review workflow. See §10 and §11 and [C6_INTEGRATION.md](./C6_INTEGRATION.md).

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

## 1a. Where it runs today: Studio chat

Studio's chat (the full-screen Chat and the Ask XO dock) now runs on this layer: `XoClient` calls `/intelligence/conversations` and the screen renders what the platform returns — how XO understood the message (Ask / Decide / Do / Learn), confidence, the sources cited, notices that weaken the answer, a proposed action marked "not run", and Helpful / Not helpful. There is no mode picker (the control reads "Auto"). `@name` focuses an answer on an installed XO (`attach`).

Until C6 is connected, answers come from two interim sources, searched together (`CompositeKnowledgePort`, `apps/api/src/intelligence/`): **the knowledge graphs and capabilities of the XOs installed in the workspace** (`InstalledXoKnowledgePort`) and **the files uploaded to the workspace and what Studio compiled from them** — the capabilities discovered, their page provenance, and the extracted knowledge (`WorkspaceSourcesKnowledgePort`). A file that was uploaded but never compiled is reported as exactly that. Both are deliberately naive (word overlap, no embeddings, no connected enterprise sources) and say so on every answer; `intelligenceKnowledge` in the server deps replaces them with C6. Questions about XO itself ("what do you have access to?") are answered from a catalog of these sources (`KnowledgePort.describe`), not by searching. The old `/chats` routes still exist in the API but Studio no longer calls them.

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

## 10. Using it now (Studio)

Select a model in Settings → Models (server-side credentials required, e.g. `GEMINI_API_KEY`), install an XO that has a knowledge graph, open Chat or the Ask XO bar, and:

- **Ask** about what is in an installed XO or an uploaded-and-compiled file ("Does burglary cover need forced entry?", "what can I automate with Aastha.pdf?") → cited answer, confidence, sources, follow-ups.
- **Decide** ("Should we expedite this?") → options, risks, an advisory recommendation — only when grounded in a source.
- **Correct** ("That's wrong, …") or press **Not helpful** → filed as `pending_review`; answers do not change.
- **Request an action** → only if a capability port is wired (none is by default), so today you are told no actions are available.
- `@name` focuses on one installed XO. Chats are private to you.

## 11. Not done, and what stands between this and production

1. **Real knowledge (C6).** The adapter exists and is tested against the real C6 stack ([C6_INTEGRATION.md](./C6_INTEGRATION.md)), but no C6 environment is created for a workspace, so Studio still answers from the interim sources (keyword matching; the chat says so on every answer). Still needed: per-workspace C6 bootstrap (state, durable audit, grants, connectors, ingestion), and reconciling `c0.3`'s API-level audit/authorization with Studio's.
2. **DO is not usable.** No capability port is wired, and chat-initiated execution is disabled upstream until capability-level authorization is enforced on the execution path. Needs: a runtime-backed `CapabilityPort` with per-principal authorization, plus an approve-and-run flow from the chat card.
3. **LEARN is a queue, not a loop.** Claims land as `pending_review`; there is no reviewer UI, no write-back into knowledge, no outcome tracking, nothing that improves answers.
4. **Never run against a real model.** An evaluation suite now exists (91 items, [EVALUATION.md](./EVALUATION.md)) and passes in oracle mode, which validates the plumbing only. No live run has been made, so routing accuracy, answer quality, citation faithfulness and calibration of any real model are still unmeasured. Needs a live run, real expert-labelled questions, and a multi-provider comparison.
5. **No streaming**, so every reply waits for two or more model calls. Needs `converseStream` in `ConversationLayer`, a Gemini streaming adapter, and an SSE route.
6. **Latency/cost controls.** Two model calls per turn; no response caching, no per-workspace spend limits or rate limits at the API, no routing on a smaller model by default.
7. **Context handling.** History is trimmed by turn count, not tokens; no summarization; evidence limits are fixed constants; no re-ranking.
8. **Observability.** Per-turn usage and audit metadata exist, but no tracing spans, dashboards, or answer-quality sampling.
9. **Conversation storage** is one JSON file per conversation with a 400-message cap and a full scan to list; fine for a pilot, not for scale. Stored results include source excerpts, so retention and deletion policy matter.
10. **UI gaps.** Follow-up suggestions are carried in the result but not shown as clickable; no citation drill-down to the source; no streaming or stop button; no live browser testing was done (see §12).
11. **Security review.** Prompt-injection handling is escaping plus instructions, with tests; it has not been red-teamed. Tenant isolation relies on workspace stores and ownership checks.
12. **Smaller items:** DECIDE simulation not built; `feat/gemini-tool-calling` not merged; the Gemini model list in `ai-core` is stale (`gemini-1.5-*`); `ConversationLayer` duplicates ~40 lines of orchestration from `AiCapabilityLayer` that should be factored into a shared pool.

## 12. How this was verified

Unit and integration tests in `@xo/ai-core`, `@xo/intelligence` and `apps/api`; Studio component tests; a Studio-client → real API → real `GeminiProvider` → local Gemini-protocol server test (`apps/studio/test/contract/studio-chat-intelligence.test.ts`); full repo build and Studio production build. **Not done:** driving the Studio UI in a real browser, or calling a real model.
