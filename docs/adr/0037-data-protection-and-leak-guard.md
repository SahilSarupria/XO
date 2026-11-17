# 0037: Known values and locale patterns, reversible tokens, and a leak guard at the one provider boundary (UW-14c to 14e)

## Status

Accepted under owner delegation, 2026-11-16 (UW-14c to 14e, wave W2). Signed off by Claude under the owner's delegation of decision
authority. This is a delegated sign-off, not an independent review. The detection thresholds (UAC-27) are proposals awaiting the
owner's ratification.

## Context

Wave W1 ([ADR 0019](0019-hosted-model-terms.md), [ADR 0020](0020-path-level-model-policy.md)) put every model provider behind one
residency guard and gave `masked_hosted` a typed egress boundary. It controls by _not sending_: a hosted model receives only schema
descriptors, synthetic records, filtered intent text and fixed templates.

Three gaps remained:

- **Intent text.** It was filtered by patterns only, so a customer's name typed into a goal passed.
- **No check of the request as sent.** Nothing looked at the whole request at the moment it left.
- **`open` sent anything.** That includes a real value pasted into a development instance.

The plan (UW-14c to 14e) asks for four things:

- a known-value dictionary built from the customer's own data;
- a locale pattern pack;
- reversible per-workflow tokens;
- a leak guard that blocks any request carrying a protected value and audits it with hashes only, proved by a canary test across
  every input channel (UAC-24, UAC-26, UAC-27).

## Decisions

1. **The leak guard sits inside the residency guard, so there is still one enforcement point.**
   - `guardProvider` checks residency first, synchronously, so a refused stream still fails at the call.
   - It then scans the whole request (every string and key, the system prompt, tools and the response schema included) when the
     provider is _hosted_.
   - Any hit refuses the call with an inference denial (`leak_guard_blocked`) that carries entity kinds and hashes, never a value.
   - Local providers are not scanned: a model on the instance's own network may see the instance's own data.
   - The guard applies in every mode, `open` included. Development with real values is exactly the leak this exists to stop.

2. **Each request carries its workspace's protection context.**
   - The API runs every `/workspaces/{id}/…` request inside an `AsyncLocalStorage` protection context naming the workspace. Model
     calls made while serving it therefore use that workspace's dictionary. This needs no change to any caller, and a new caller
     cannot forget it.
   - A hosted request with no context is handled by mode:
     - `masked_hosted` refuses it (`leak_guard_unavailable`, fail-closed);
     - `open` scans it with the pattern packs alone.
   - The dictionary is built lazily, only when a hosted request is about to leave. It is cached per workspace and keyed by the
     spreadsheets' digests and the settings revision.

3. **The known-value dictionary (14c-1) comes from the workspace's spreadsheets and its settings.**
   - **Which columns.** A column feeds the dictionary when its header names an identifying field (name, client, email, phone, PAN,
     policy, account, address, …) or when most of its values are emails or Indian mobile numbers.
   - **Settings.** An administrator can add values, force columns in, and exclude columns, through
     `GET/PUT /workspaces/{id}/data-protection` (manage role; recent sign-in to change).
   - **How matching works.** All matching is on normalised text: NFKC, marks removed, invisible characters dropped, and common
     Cyrillic and Greek look-alikes mapped to Latin.
   - **Names and organisations** match:
     - as whole-word sequences;
     - in their written variants (initial and surname, surname first, joined in a file name);
     - with one edit for words of five or more letters;
     - by a spelling key for Indian romanisations (Lakshmi and Laxmi, Chaudhary and Choudhari).
   - **Emails, phones and ids** match with separators ignored. A phone also matches without its country code. A number inside a longer
     run of digits is not a match.
   - **Encoded text.** Base64, base64url and percent-encoded runs are decoded and scanned too.

4. **Locale patterns (14c-2) are a reusable pack format with validators.** The pack format is genericity class C; its content is class
   D. The validators are:
   - Aadhaar: Verhoeff check digit, first digit 2 to 9;
   - PAN: the holder-type letter;
   - GSTIN: state code 01 to 38, an embedded PAN and the mod-36 check character;
   - IFSC;
   - Indian mobile: not one repeated digit;
   - passport and voter ID: only next to their context word;
   - UPI handles;
   - emails, except at reserved domains;
   - payment cards: Luhn.

   A schema's own shape notation (`AAAAA9999A`) is a format, not a value, and is never a hit. Facts and sources are in
   [RESIDENCY.md](../RESIDENCY.md).

5. **Synthetic records must not look real.**
   - A synthetic value the pattern packs recognise is drawn again: a random value in a PAN-shaped column is a valid PAN about half the
     time. The draws stay seeded and deterministic.
   - A synthetic email's domain is `example.invalid`.
   - Otherwise the guard would rightly block the typed boundary's own output, and an egress log could not tell synthetic from real.

6. **Reversible tokens (14d).**
   - **Placeholders.** `TokenVault` issues deterministic placeholders (`CLIENT_0001`). One per value within a workflow; all written forms
     of one name share one placeholder, keyed by the dictionary hash.
   - **Model output is untrusted.** `reidentify` checks every string in the output. An unknown placeholder of an entity in play
     rejects the whole output, and so does a mangled one (`CLIENT_1`, `client_0001`).
   - **Where values go back.** Values are put back only into fields the caller declares as entity-typed. Fields declared
     `forbidden` (recipients, attachments, amounts) may not come from model output at all.
   - **Storage.** Each vault is sealed with AES-256-GCM under `HKDF(XO_CREDENTIALS_KEY, 'xo-token-vault/1', workspace)`, with the
     scope in the authenticated data.
   - **Retention.** A vault is kept for `XO_TOKEN_VAULT_RETENTION_DAYS` (default 30) and swept by the scheduler after that. It is
     erased when its workflow is archived.
   - **No consumer yet.** Under R-DET a workflow has no model step on a data path today; the first consumer is a `needs_model` step
     the owner enables (UW-6). The vault, its store, its erasure and its sweep are in place and tested now, so that step cannot ship
     without them.

7. **Audit.**
   - **A blocked request.** It is recorded as `model.egress.blocked` (outcome denied). The record carries the provider, the hit count,
     entity kinds, detectors, whether a hit was encoded, and up to five hashes. Each hash is the first 16 hex characters of SHA-256
     over the normalised value. It never carries a value.
   - **Settings changes.** They are recorded as `data-protection.updated`, with counts only.
   - **Chat.** Chat tells the person their message was not sent and why: the kinds and hashes, never which dictionary entry. A refused
     message is not saved, so it cannot poison the conversation's later requests.

8. **The NER sidecar (14c-3) is deferred.** This follows the plan's Option D. Names that are in no spreadsheet and no setting are not
   detected. That is acceptable while hosted models receive only typed requests and chat stays local in `strict_local` and
   `masked_hosted`.

## Consequences

- **Blocked chat in `open` mode.** A development instance in `open` mode now refuses hosted chat about the workspace's own clients.
  Use test data or a local model.
- **Detection is measured.** The `pii-detection` evaluation suite reports known-value block rate, recall, precision and false-block
  rate on a labelled synthetic Indian set. The set includes two forms known to be missed (a nickname, a spelt-out address), so the
  recall figure is honest. The set was written alongside the detectors, so it is not blind: ratify against a held-out set.
- **Dictionary scale.** The dictionary is bounded at 250,000 values per workspace, and the bound is reported. Workbooks are re-read
  when they change. A very large workspace pays that cost on the first hosted request after a change.
- **Residual channels.**
  - A schema itself can be sensitive (a column named for a condition). `withhold` exists, but a per-column "do not disclose name"
    setting in the workspace settings is not yet wired to the descriptor builders.
  - Combinations of fields can re-identify people.
- **Outside an HTTP request.** Model work started outside an HTTP request has no workspace context. In `masked_hosted` it is refused;
  in `open` it gets the pattern packs only. Today no scheduled path calls a model.

## UW-9 correction recorded here

Building the audit assertions showed that person-caused credential events (UW-9) were never recorded:

- their prose action names fail the audit validator's action format;
- `credential.created` carried a full 64-hex account digest, which the validator reads as a secret.

Both were fixed on the UW-9 branch, and its test now reads the audit sink.
