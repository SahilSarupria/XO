# 0013: `cnv_` is the canonical conversation store; `cht_` is deprecated (D-D)

## Status

Accepted under owner delegation, 2026-11-13 (UW-0). Signed off 2026-11-13 by Claude under the owner's explicit delegation of sign-off authority (owner instruction of 2026-11-13); this is a delegated sign-off, not an independent review. Implemented by UW-2.

**Supersedes ADR 0009** "Conversations: two stores, one primitive, no merge". **Amends ADR 0008** point 7 (keep Customer Chat and
Studio chat separate): the separation it protected no longer exists, because Studio's chat screen now uses Customer Chat.

## Context

ADR 0009 kept two stores on the grounds that `cht_` served operators in Studio and `cnv_` served end customers. The UW-0 spike read
both stores and their callers (`docs/baseline/UW0_BASELINE.md` §8):

- `cnv_` (`apps/api/src/intelligence/conversation-store.ts`) is the ASK/DECIDE/DO/LEARN chat (ADR 0008), with proposals, citations
  and feedback. **Studio's chat screen calls it** (`apps/studio/src/platform/client.ts:514`, "chat: the intelligence conversation").
- `cht_` (`apps/api/src/chat/chat-store.ts`) is the older assistant with no knowledge access and no actions. Its routes are
  registered, but **no client in the repository calls them**.

The audience split no longer matches the code. Both stores use the same mechanics and privacy rule (one JSON document per
conversation, readable only by the identity that started it). The plan's D-D condition ("`cnv_` is canonical unless Studio's chat
uses `cht_`") resolves to `cnv_`.

## Decision

1. **`cnv_` is the only conversation store a workflow may originate from or link to.**
2. A workflow stores a **`ConversationRef { store: 'cnv', conversationId }`**. The `store` discriminator stays so the reference
   survives a storage change. A channel (Studio web, a future messaging channel such as WhatsApp, the API) is a property of the
   conversation, not a separate store.
3. **`cht_` is deprecated**, not deleted: routes stay working and their tests are preserved by name; OpenAPI marks them deprecated
   (UW-2); no new features; no workflow may reference a `cht_` thread. Removal is a separate owner decision after a stated sunset,
   following the deprecation rule of XO_PROTOCOL §6.7.
4. Deleting a conversation never deletes a workflow. A workflow is readable only by principals authorized for it under ADR 0010.

## Consequences

- One conversation history per user to search, retain and erase, which simplifies UW-12, UW-14 (erasure) and audits.
- No migration is needed, since nothing in the repository writes `cht_` threads through a client.

## Reopen if

A deployment is found that depends on `cht_` threads, or a channel needs storage semantics `cnv_` cannot provide.
