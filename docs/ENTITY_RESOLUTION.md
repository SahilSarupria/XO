# Entity resolution (UW-5)

Match items across two sources (a recipient row to a document, an invoice to a ledger line) without guessing. See ADR 0040.

## Request

`POST /workspaces/{ws}/entity-resolutions` (author role)

```json
{
  "schema": { "relationship": "recipient-document", "cardinality": "one_to_one", "strongSchemes": { "email": "email" } },
  "subjects":   [{ "ref": "r1", "name": "Asha Rao", "identifiers": [{ "scheme": "email", "value": "a@example.org" }] }],
  "candidates": [{ "ref": "d1", "name": "Asha Rao.pdf" }]
}
```

`ref` is an opaque id (row id, file id). Results and audit use refs, not names.

## Rules

| Evidence | Outcome |
| --- | --- |
| Declared strong identifier equal (after normalisation) | `resolved` if no other candidate/subject ties |
| Unique full-name match of at least two words | `resolved` if no other candidate/subject ties |
| Same name, no distinguishing evidence | `ambiguous` |
| Initials, nickname, spelling variant, one-word name | `ambiguous` (never confirmed) |
| Same scheme, different identifier value | not a match |
| Nothing | `unmatched` |

The report also lists unmatched subjects and candidates and cardinality violations (`one_to_one`, `one_to_many`, `many_to_one`).

## Proposing claims

`POST /workspaces/{ws}/entity-resolutions/proposals` takes the same body plus `evidence: { <ref>: { sourceDigestSha256, sourceName, locator } }`.
Only `resolved` pairs with evidence on both sides become claims, in a `proposed` change set. Approve or reject with the
knowledge change-set routes (review role, recent sign-in).

## Measuring

`npm run eval -- --suite entity-resolution`. Labelled set: `packages/evaluation/sets/entity-resolution.json` (synthetic).
