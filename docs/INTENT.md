# Intent and workflow composition (UW-6)

A stated outcome becomes a validated workflow definition, or a clear reason it cannot. See ADR 0043.

**Structured (no model):** `POST /workspaces/{ws}/compilations/{cid}/generated-workflows` with `{ goal: { text, needs?, section?, forEach?, intake? } }`
or create a workflow entity (`/workspaces/{ws}/workflow-entities`) with the same `goal`.

| Result                                               | Meaning                                                                                                         |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `definition`                                         | Composed, validated Workflow IR, with `intentTrace` and `intentTraceDigest`. A UW-2 version records the digest. |
| `gaps` (`missing_capability`)                        | A named need that no usable compiled capability provides. Nothing was generated.                                |
| `selection.status: needs_clarification` / `no_match` | One question: which of these workflows, or name a section or the steps needed.                                  |
| `lowered.complete: false`                            | A step with no connector bound is reported, not invented.                                                       |

**Free text:** `POST .../intent-proposals` `{ text }` works only when the instance configures a proposer (a model behind the UW-14 guard). Default: 501.
Its answer is untrusted: parsed strictly, composed like a person's goal; unknown fields and invented capabilities change nothing.

Tests: `packages/pre-execution/test/intent.test.ts`, `intent-injection-corpus.test.ts`, `apps/api/test/intent-proposals.test.ts`.
