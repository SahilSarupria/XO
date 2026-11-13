# Data residency and model egress (UW-14, wave W1: 14a and 14b)

Real customer values stay inside the XO instance by construction. A model on this instance's own server may see them. A hosted model
may see, at most, a description of the data: never the data itself ([ADR 0019](adr/0019-hosted-model-terms.md),
[ADR 0020](adr/0020-path-level-model-policy.md)).

## Residency modes (`XO_RESIDENCY`)

| Mode                     | Hosted models                                                                                        | Use                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `strict_local` (default) | None. No hosted model or hosted vision call is possible.                                             | Every instance unless the owner decides otherwise.    |
| `masked_hosted`          | Only providers in `XO_HOSTED_MODEL_PROVIDERS`, and only requests built by the typed egress boundary. | Planning with a contracted, no-training hosted model. |
| `open`                   | Any provider, any request.                                                                           | Development only; refused in production.              |

**Local and hosted.** A provider is _local_ only when it runs on the instance's own network. That means Ollama at a loopback or private
address, or at a name that cannot be a public host: a single label such as a compose service, `.local`, `.internal`,
`.svc.cluster.local` or `host.docker.internal`. Every other provider, and every provider XO does not recognise, is _hosted_.

**Before `masked_hosted` is allowed.** The instance refuses `masked_hosted` without a list of contracted providers in
`XO_HOSTED_MODEL_PROVIDERS`. Put a provider on that list only after reviewing its contract: a paid tier, no training on submitted
data, a processing agreement. Free tiers are never acceptable.

**Production.** `open` is refused both by the settings check and by the server itself.

## One enforcement point

Every model provider the instance builds is wrapped by the residency guard (`packages/ai-core/src/egress/guarded-provider.ts`).

**The check happens before the provider.** The guard checks every request before the provider sees it. A refusal is a structured
inference denial (`XO_AI_INFERENCE_DENIED`, a residency reason) whose message never contains request content, and nothing reaches the
network.

**There is only one way to build a provider.** In `apps/api/src` providers come only from `chat/model-provider.ts`, and providers
injected by tests or alternative deployments are guarded too. A test fails if a provider class is constructed anywhere else.

**What each path does today:**

| Path                                    | `strict_local`                                     | `masked_hosted`                                                                   |
| --------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------- |
| Studio chat, customer intelligence chat | Local models only; hosted refused (412 saying why) | Local models only: chat carries document and conversation text, which is untyped. |
| Runtime capability inference            | Local only                                         | Local only: it carries the run's input values.                                    |
| Reading scans and photos (vision tier)  | A hosted vision provider stops start-up            | The same: page images are real data, never masked.                                |
| Planning a workflow from a goal (UW-6)  | Local only                                         | Contracted hosted provider, typed requests only.                                  |

**Studio can show the options.** Workspace settings report `allowedByResidency` for each provider, and `/ready` reports the mode.

**Defined as the fourth authority.** Residency is also the fourth authority in the inference policy, beside the node declaration,
server policy and run restriction (`ServerInferencePolicy.residency`). It applies the same `checkResidency` rule.

## The typed egress boundary (`packages/ai-core/src/egress/boundary.ts`)

In `masked_hosted`, a hosted model receives only requests made by `buildEgressRequest`. Their parts come from four closed kinds,
each minted by a constructor in that module:

- **Schema descriptor** (`describeSchema`, or `describeRecordSet` for a UW-3 record set):
  - What it contains: column names, declared types, counts, length ranges, and the value _shape_ (`AAAAA9999A`) when at least two values
    and half the column share it. A shape keeps no letter or digit.
  - What it never contains: a value.
  - Column names: a header that looks like a value (an email, a run of digits, more than 64 characters) is withheld as `column_<n>`.
    Any header can also be withheld on request (`withhold: ['Diabetic']` or `'all'`).
- **Synthetic records** (`synthesizeRecords`): generated from a descriptor with a seeded generator. A descriptor holds no values, so a
  real value cannot appear except by coincidence of form.
- **Intent text** (`filterIntent`): the person's request after an intent filter. The W1 filter masks credentials, emails, links and
  runs of five or more digits.
- **Fixed templates** (`defineTemplate`, `defineResponseSchema`): text and response schemas written in XO's code as module-level
  constants with literal text (a test checks every call site). The instance seals the registry at start-up, after which nothing can
  become a template.

**What is refused.**

- Anything that is not a minted part: a string from a document, a look-alike object, a hand-built descriptor.
- A request that is not the very object `buildEgressRequest` returned. A copy is refused, even an exact one, and minted parts and
  requests are frozen.
- Images and tools: they are never part of a typed request.

The control is _not sending_ rather than _detecting_: there is no way to put a cell value into a descriptor.

## Configure

```bash
XO_RESIDENCY=strict_local                    # default
XO_RESIDENCY=masked_hosted XO_HOSTED_MODEL_PROVIDERS=anthropic
XO_RESIDENCY=open                            # development only
```

For local development with a hosted model (for example, trying chat against Anthropic on your laptop with test data only), set
`XO_RESIDENCY=open`. On a real instance use a local model, or `masked_hosted` for planning once UW-6 uses it.

## Not yet: wave W2 (UW-14c to 14e)

Recorded in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

- **Known-value dictionary (14c-1).** Exact-match masking against the values the customer already supplied: names, emails and ids
  in their workbooks.
- **Locale pattern pack (14c-2).** Aadhaar (with checksum), PAN, GSTIN, IFSC, phone and similar.
- **Reversible tokens (14d).** A per-workflow, encrypted token map, erased with the workflow.
- **Leak guard and egress proof (14e).** Every outbound request body is scanned with the dictionary and patterns before it leaves; a
  hit blocks the call and is audited, with hashes only. The CI canary test runs across every input channel (UAC-24).

Until then:

- `masked_hosted` relies on the typed boundary alone.
- Intent text is filtered by patterns, so a customer's name typed into a goal would pass. Prefer schema descriptors and templates over
  intent text.
- The instance logs a warning at start-up in `masked_hosted`.

**Owner and counsel items (14f).** The data-handling statement, the processing agreement template, the provider terms review and the
recorded legal position on masked data are not code, and are not done here.
