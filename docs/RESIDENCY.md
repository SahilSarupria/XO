# Data residency and model egress (UW-14: 14a and 14b in wave W1, 14c to 14e in wave W2)

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
  runs of five or more digits. `protectedIntentFilter(scanner)` adds the workspace's known values and the pattern packs (a client's
  name typed into a goal becomes `[PERSON]`); a planner (UW-6) uses that one.
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

## Protection of the workspace's own values (UW-14c to 14e, [ADR 0037](adr/0037-data-protection-and-leak-guard.md))

### The leak guard (14e)

Every request to a _hosted_ provider is scanned, whole, inside the same guard, after the residency check and immediately before the
provider sees it. The scan covers every string and key: messages, the system prompt, tools and the response schema.

- **What blocks a request.** Any hit refuses the call with `XO_AI_INFERENCE_DENIED` (reason `leak_guard_blocked`). The refusal names
  entity kinds and hashes only, and nothing is sent.
- **Which modes.** The guard applies in every mode, including `open`. Local providers are not scanned.
- **Which workspace's values.** Every `/workspaces/{id}/…` request runs in that workspace's protection context, so the scan uses that
  workspace's dictionary.
- **No context.** A hosted request with no workspace context is refused in `masked_hosted` (`leak_guard_unavailable`). In `open` it
  is scanned with the pattern packs only.
- **Audit.** Each block is audited as `model.egress.blocked`, with the provider, hit count, kinds, detectors and up to five hashes.
  A hash is `sha256:` plus 16 hex characters of the normalised value; no value is ever recorded.
- **Chat.** Studio chat says the message was not sent and why, and does not save it.

### The known-value dictionary (14c-1)

**Where values come from.**

- **The workspace's spreadsheets.** Each `.csv` and `.xlsx` source feeds the columns that identify someone. A column qualifies when
  its header names a person, organisation, email, phone, identifier or address, or when most of its values are emails or Indian
  mobile numbers.
- **The workspace's data-protection settings.** `GET/PUT /workspaces/{id}/data-protection` (manage role; recent sign-in to change)
  holds:
  - values to protect that are in no spreadsheet;
  - columns always protected;
  - columns never protected.

`POST /workspaces/{id}/data-protection/scan` shows what the guard would find in a text, and the text as masked.

**How values match.** Matching runs on normalised text: NFKC, accents removed, invisible characters dropped, and Cyrillic and Greek
look-alike letters read as Latin.

- **Names and organisations** match as whole words, in their written forms:
  - initial and surname (`R. Kumar`), surname first (`Kumar, Ravi`), joined in a file name (`ravi_kumar.pdf`, `RaviKumar/`);
  - with one typing error in a word of five or more letters;
  - with a spelling key for Indian romanisations (Lakshmi and Laxmi, Chaudhary and Choudhari, Bhavana and Bhawana).
- **Emails, phones and identifiers** match with separators ignored. A phone also matches without `+91`. A number inside a longer
  number is not a match.
- **Encoded text.** Base64, base64url and percent-encoded runs are decoded and scanned too.

### Locale pattern pack (14c-2)

| Entity       | Rule                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| Aadhaar      | 12 digits, first digit 2 to 9, last a Verhoeff check digit; spaces or dashes allowed between groups of four           |
| PAN          | 5 letters, 4 digits, 1 letter; the 4th letter is a holder type (P, C, H, F, A, T, B, L, J, G)                         |
| GSTIN        | State code 01 to 38, an embedded PAN, an entity character (1 to 9 or A to Z), `Z`, then a Luhn mod-36 check character |
| IFSC         | 4 letters, `0`, 6 letters or digits                                                                                   |
| Mobile       | 10 digits starting 6 to 9, optional `+91`, `91` or `0`; not one digit repeated                                        |
| Passport     | Letter and 7 digits, only next to the word "passport"                                                                 |
| Voter ID     | 3 letters and 7 digits, only next to "voter", "EPIC" or "election"                                                    |
| UPI          | `handle@bank`                                                                                                         |
| Email        | Any address, except at reserved domains (`example.com`, `.example`, `.invalid`, `.test`, `.localhost`)                |
| Payment card | 13 to 19 digits passing the Luhn check                                                                                |

A schema's shape notation (`AAAAA9999A`) is never a hit. Synthetic records never look real: a synthetic value that a pack would
recognise is drawn again, and synthetic emails use `example.invalid`.

**Facts used, re-checked 2026-11-16.**

- **Aadhaar.** 12 digits, does not begin with 0 or 1, and the last digit is a Verhoeff check digit. Published vectors: 234123412346
  is valid and 234123412347 is not. Sources: python-stdnum `stdnum.in_.aadhaar`
  (https://arthurdejong.org/python-stdnum/doc/stdnum.in_.aadhaar), Microsoft Purview's Aadhaar entity definition (optional spaces or
  dashes).
- **PAN.** The fourth character is the holder status: A, B, C, F, G, H, J, L, P or T. Source: Income Tax Department, "How PAN is
  formed" (https://www.incometaxindia.gov.in/w/how-pan-is-formed-and-how-it-gets-its-unique-identity-).
- **GSTIN.** The 14th character is `Z` and the 15th is a Luhn mod-36 check character. Worked example: 27AAPFU0939F1ZV. Source:
  python-stdnum `stdnum.in_.gstin` (https://arthurdejong.org/python-stdnum/doc/stdnum.in_.gstin).
- **IFSC.** 11 characters: four letters for the bank, `0`, then six for the branch, which may include letters. Source: Wikipedia,
  "Indian Financial System Code".

### Reversible tokens (14d)

A workflow's `TokenVault` gives each real value a stable placeholder (`CLIENT_0001`).

**Putting values back.** Model output is checked before any value is restored:

- A placeholder the vault did not issue rejects the whole output, and so does a mangled one (`CLIENT_1`, `client_0001`).
- Values go back only into fields declared entity-typed.
- Fields declared forbidden (recipients, attachments, amounts) may not come from the model at all.

**Storage.**

- Each vault is sealed (AES-256-GCM) under a key derived per workspace from `XO_CREDENTIALS_KEY`.
- It is kept for `XO_TOKEN_VAULT_RETENTION_DAYS` (default 30), then erased by the scheduler's sweep.
- It is erased when its workflow is archived.

There is no model step on a data path yet (design rule R-DET). The first consumer is an owner-enabled `needs_model` step (UW-6).

### Measured (UAC-27)

The `pii-detection` evaluation suite reports four measures on a labelled synthetic Indian set: known-value block rate, recall,
precision and false-block rate. The thresholds in `evaluation/thresholds.json` are proposals for the owner to ratify. The set is not
blind; see [ADR 0037](adr/0037-data-protection-and-leak-guard.md).

### Still open

Recorded in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

- **Names XO has never been given are not detected.** These are names in no spreadsheet and no setting. Catching them needs the NER
  sidecar (14c-3), which is deferred until a vertical must send free text to a hosted model.
- **Owner and counsel items (14f).** The data-handling statement, the processing agreement template, the provider terms review and
  the recorded legal position on masked data are not code, and are not done here.
