# UW-14 test record (residency and typed egress, wave W1: 14a and 14b)

Branch `uw-14/residency-egress`, stacked on `uw-17/local-first-packaging`. Compared by name against `docs/baseline/tests-26f0052.tsv`.

## Behaviour changes callers can see

- **The default residency is `strict_local`.** Chat, customer intelligence chat and runtime inference with a hosted provider are
  refused (412, or 403 `XO_AI_INFERENCE_DENIED`), and nothing is sent. A local Ollama works as before. `XO_RESIDENCY=open` restores the
  old behaviour, for development only.
- **A hosted `XO_OCR_VISION_PROVIDER` stops start-up** unless `XO_RESIDENCY=open`.
- **Workspace settings report `allowedByResidency`** for each provider, and `/ready` reports the residency mode.
- **New settings:** `XO_RESIDENCY` and `XO_HOSTED_MODEL_PROVIDERS`. `open` in production, or `masked_hosted` without a provider list,
  stops start-up.
- **Templates are sealed at start-up.** The instance seals the egress template registry when it starts.

## Same name, body changed

| Test                                                                                                                                         | Change                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Studio contract tests that chat through a real API (`apps/studio/test/contract/studio-contract.test.ts`, `studio-chat-intelligence.test.ts`) | Their API is created with explicit `open` residency: they use stand-in hosted providers (Anthropic, Gemini).       |
| `UW-3 API: OCR configuration …` (`apps/api/test/photo-ocr.test.ts`, added in UW-3)                                                           | Its hosted vision provider is configured under explicit `open` residency; the refusals are in `residency.test.ts`. |

| `first request with a key executes once; …` (`apps/api/test/idempotency.test.ts`) | Fixes a flake that predates this work: "no request payload is stored" matched `20000` inside random hashes. It now matches the value as a token. |

API tests that use stand-in providers run in explicit `open` residency, set once in `TestServer`, the same way package trust is.

No baseline test was renamed or removed.

## Added

- `packages/ai-core/test/egress.test.ts` covers:
  - residency resolution and locality;
  - UAC-25 network capture: a real Anthropic provider in `strict_local` attempts no connection, for both complete and stream calls;
  - `masked_hosted`: typed requests only; raw requests, copies, images and uncontracted providers refused;
  - no cell value in a descriptor or its synthetic records, including a property test over random values;
  - withheld names and shapes;
  - minted parts only;
  - the intent filter;
  - residency as the fourth inference authority;
  - template call sites checked to be literal and module-level.
- `packages/ai-core/test/egress-seal.test.ts` checks that nothing can become a template after sealing.
- `packages/compiler/test/tabular/egress.test.ts` checks that a client list described as a schema puts no value in the request.
- `apps/api/test/residency.test.ts` covers:
  - chat refused before sending in `strict_local` and in `masked_hosted`, and a local model answering;
  - Studio's per-provider residency flags and `/ready`;
  - hosted vision refused;
  - `open` refused in production by the server and by start-up;
  - every provider built by the guarded factory.

## Result

7,474 pass, 4 skip and 1 fail across all workspaces. The failure was the idempotency flake fixed above; the file passes 3/3 on
re-run. By name against the UW-0 baseline, nothing regresses beyond UW-1's documented benchmark rename.
