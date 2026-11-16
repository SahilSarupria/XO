# 0012: XOIR gains a claim, evidence and lifecycle layer; no graph database (D-C)

## Status

Accepted under owner delegation, 2026-11-13 (UW-0). Signed off 2026-11-13 by Claude under the owner's explicit delegation of sign-off authority (owner instruction of 2026-11-13); this is a delegated sign-off, not an independent review. Implemented by UW-4a.

## Context

The UW-0 knowledge-mapping spike (`docs/baseline/UW0_BASELINE.md` §8) compared the environment-intelligence (EI) knowledge model with
XOIR. EI claims carry a knowledge kind, subject, predicate, typed value, origin (`observed` | `stated` | `inferred`), validity
(`validFrom`/`validTo`), evidence support (`sourceId`, `resourceDigest`, `contentHash`, `observedAt`), derivation, an epistemic status
(`directly_observed` | `corroborated_inference` | `candidate_hypothesis` | `unknown`) and a statement status (`known` | `conflicted` |
`hypothesis` | `unknown`). XOIR nodes carry document locators, confidence, `producedBy` and `reviewStatus` (`unreviewed` |
`human_confirmed`, already outside the content hash). XOIR has `CONTRADICTS`, `SUPERSEDES`, `OWNED_BY`, `BELONGS_TO`, `GOVERNS` and
`DEPENDS_ON` edges but nothing for EI's `manages` and `associated_with`, which EI's own `XOIR_EDGE_FOR` table records as gaps. The EI
model cannot be expressed in XOIR today without loss.

## Decision

An **additive** XOIR extension (a MINOR schema version, as XO_PROTOCOL §6.5 requires for EIR):

1. **Claim node.** A canonical node kind `claim` with properties `knowledgeKind`, `subject` (entity reference), `predicate`, typed
   `value`, `origin`, and optional `validity { from, to }`.
2. **Evidence.** A metadata field `evidence[]`, each entry `{ sourceId, contentHash, locator, quoteHash, observedAt }`. A quote is
   stored by hash and resolved against the stored source, so a claim never carries copied customer text into places it does not
   belong.
3. **Lifecycle.** A metadata field `lifecycle` (`proposed` | `approved` | `rejected` | `superseded` | `retracted`), outside the content
   hash like `reviewStatus` (ADR 0017). `reviewStatus` is kept and maps onto it (`unreviewed` → `proposed`, `human_confirmed` →
   `approved`).
4. **Authority.** A metadata field `assertedBy` (`source` | `person` | `deriver`, with its id), so who said a claim is never conflated
   with how it was derived.
5. **Edges.** New `MANAGES` and `ASSOCIATED_WITH` edge kinds. `CONTRADICTS` and `SUPERSEDES` already exist and carry EI's `conflicted`
   status and supersession.
6. **Executable rule.** A claim may feed execution only when its lifecycle is `approved` and every evidence entry resolves (the source
   exists and its content hash matches). The evidence resolver is part of UW-4a; the runtime refuses anything else.
7. **Mapping of EI statuses.** `directly_observed` → origin `observed`; `corroborated_inference` → origin `inferred` with at least two
   independent evidence entries; `candidate_hypothesis` → lifecycle `proposed`, origin `inferred`; `unknown` → no claim (absence is
   not stored as a fact).
8. **No graph database.** XOIR in the instance store (ADR 0017) is the knowledge base. Chat retrieval (C6) is a port over it.

## Consequences

- One knowledge model serves the compiler, EI, chat and execution.
- Old graphs remain valid; readers ignore fields they do not know (XO_PROTOCOL §6.6).

## Reopen if

An EI status or relationship cannot be expressed under this extension without loss.
