# C6 Knowledge SDK — integration status and requirements

Context: [CUSTOMER_CHAT.md](./CUSTOMER_CHAT.md) (the **ASK → DECIDE → DO → LEARN** loop) and [EVALUATION.md](./EVALUATION.md).

## Status: not integrated — there is nothing to integrate against

C6 does not exist in anything reachable from this work: not in the repository, not in any of its 15 branches, not in the other repositories on the account, and no document defines it (no spec, API, package, or even a mention of Microsoft 365, SharePoint or connectors). Writing a "C6 client" now would mean inventing its interface and calling that integration. It was not done.

What exists instead is the **boundary C6 must satisfy**: `KnowledgePort` in `@xo/intelligence`, an acceptance suite (`@xo/intelligence-eval`), and an interim development source.

```
Today:     Studio → API → Intelligence → InstalledXoKnowledgePort   (keyword match over installed XOs; labelled as such)
Intended:  Studio → API → Intelligence → KnowledgePort ← C6 adapter → C6 Knowledge SDK → authorized organizational evidence
```

No retrieval logic lives in Studio or the Intelligence layer; the installed-XO adapter is in `apps/api`, is clearly a development source, and now declares `method: 'lexical'` so every answer tells the user it matched keywords, not meaning.

## What the port already requires, mapped to what you asked for

| Requirement                                  | Port support today                                                                                                                                                                                                      | Needs from C6                                                                                                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated user and organization identity | `Principal { identityId, workspaceId, role }`, built by the API from the authenticated caller (never the request body), passed to every `retrieve`                                                                      | How C6 identifies users and organizations; whether `workspaceId` ≡ organization; a token/delegation mechanism if C6 must act as the user. `Principal` will need extending |
| Authorization-aware retrieval                | MUST return only what the principal may see; the orchestrator performs no filtering and the model never sees anything else. Verified by the security category (restricted canaries absent from answers **and prompts**) | Per-user enforcement inside C6 (not post-filtering in the adapter)                                                                                                        |
| Evidence and provenance                      | `Evidence { id, sourceId, sourceName, sourceType?, uri?, excerpt, asOf?, score? }`; citations are verified against what was retrieved                                                                                   | Stable ids, source URLs, last-modified times, author/owner if provenance should show it                                                                                   |
| Entities and relationships                   | **Not in the port.** Evidence is text excerpts only                                                                                                                                                                     | Whether and how C6 exposes entity/relationship queries. Add to the port when its shape is known; do not guess                                                             |
| Conflict and uncertainty                     | The orchestrator surfaces conflicts it finds between returned excerpts and caps confidence; `asOf` lets answers prefer the latest                                                                                       | Whether C6 detects/reconciles conflicts itself and can return that explicitly                                                                                             |
| Cross-source search                          | One `retrieve` call; `unsearchedSources` lets C6 say which sources it could not search, and the answer then names them and caps confidence at "medium"                                                                  | Cross-source ranking; per-source health                                                                                                                                   |
| Visibility and permission enforcement        | As above; `method` (`lexical` / `semantic` / `hybrid`) is disclosed to the user when keyword-only                                                                                                                       | Policy on whether a user may be told that restricted material exists (the port currently says only "nothing found")                                                       |
| Unavailable or denied knowledge              | `unavailable` (`not_configured` / `error`) → honest message, no model call; empty → "couldn't find anything", no model call; timeout 15 s                                                                               | A distinct _denied_ signal if C6 policy allows revealing it. **Not implemented**: disclosing the existence of restricted data is a policy decision for you and C6         |

## Acceptance procedure for a C6 adapter

1. Implement `KnowledgePort` over the C6 SDK (`retrieve({ principal, query, limit, scope? }) → { status, evidence, method?, unsearchedSources? }`). Return `status: 'unavailable'` or throw on failure; never swallow errors into an empty list.
2. Export the eval corpus and load it into a **C6 test organization** with the four personas' access rules: `node packages/intelligence-eval/dist/cli.js --export-corpus ./corpus`.
3. Write an ES module exporting `createKnowledge()` (and `docIdOf(evidence)` if C6 ids differ from corpus ids) and run `--knowledge-module ./adapter.mjs`.
4. Required result: **zero security failures**, and retrieval/citation recall comparable to or better than the keyword fixture (the `knownLimit` paraphrase items should start passing; remove their mark then).
5. Plug it in: `createHttpServer({ intelligenceKnowledge: (workspace) => c6Adapter(workspace) })`. The installed-XO adapter remains available as a development/test source (it is the default when nothing is supplied).

## What I need to proceed

The C6 SDK or its repository, or its API specification: its identity model, how it authorizes per user, its evidence/provenance shape, and whether it exposes entities/relationships and conflicts. With that, the adapter and any `Principal`/port extensions are straightforward and testable with the suite above.
