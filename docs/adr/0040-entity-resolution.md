# 0040: Entity resolution and relationship validation (UW-5)

## Status

Accepted under owner delegation, 2026-11-17 (UW-5, wave W3). Signed off by Claude under the owner's delegation of decision
authority. This is a delegated sign-off, not an independent review.

## Context

A wrong-identity match is the highest-impact failure for the first vertical: a certificate sent to the wrong person.
What existed before this change:

- The compiler's `merge.ts` / `node-id.ts` merge on exact or normalised text only. There was no candidate scoring, no homonym
  handling, no cardinality constraint and no report of unmatched items.
- UW-12a's name matcher (`names.ts`, tiers `full`, `joined`, `spelling`, `nickname`, `initials`) decided which person a
  file names, but only inside `@xo/connect` and only in one direction (path to people).
- The knowledge base (`@xo/knowledge-base`, UW-4) stores claims with evidence and a `proposed` / approved lifecycle through
  change sets. It has no dependencies, so `@xo/connect` can depend on it without a cycle.

## Decisions

1. **Location.** `packages/knowledge-base/src/resolution/` (no new package). The matcher moved there from `@xo/connect`;
   `packages/connect/src/source-connections/names.ts` now re-exports it, so every existing import and the UW-12a tests are unchanged.
2. **Deterministic only. No model.** Thresholds and cue lists are data: per-schema `strongSchemes` (scheme to normalisation rule
   `email` | `alnum` | `exact`) and `minNameWords`; the nickname table and tiers are the matcher's data.
3. **Result per subject:** `resolved | ambiguous | unmatched`, each with candidate evidence (basis, tier, scheme name, whether the
   evidence alone can confirm). Raw identifier values are never in the evidence.
4. **When `resolved`.** Only with (a) a strong identifier match, or (b) a `full` name-tier match of at least `minNameWords` (default 2) words. In both cases no other candidate may match the same subject at the same level (unless the declared cardinality allows
   it) and no other subject may match the same candidate at an equal or stronger level. Anything weaker (`joined`, `spelling`,
   `nickname`, `initials`, a one-word name) is at most `ambiguous` (`similarity_only` / `weak_name`). Similarity never confirms.
5. **Conflicting strong identifiers exclude a match.** Same scheme, different values, is evidence of two different things, even
   when the names are equal.
6. **Same-name subjects need no special case.** Two subjects with the same name and no distinguishing identifier match a candidate
   at the same level, so both become `ambiguous` (`several_subjects`). A distinguishing identifier on the candidate resolves it.
7. **Cardinality** is declared per relationship: `one_to_one`, `one_to_many` (a subject may own many candidates),
   `many_to_one` (many subjects may share a candidate). The resolver holds ambiguity accordingly, and `validateCardinality` checks
   any set of links (also after a person confirms) and reports the items involved. A report is `clean` only with every subject
   resolved, no violation and no unmatched candidate.
8. **Results are claims.** `resolutionChangeOperations` turns only `resolved` results with evidence on both sides into `add`
   operations for claims (`xo-resolution:identity-match`, origin `inferred`, derivation `system`, record ids content-derived,
   text with refs only, no names). They enter the knowledge base as a change set (status `proposed`). A person with the review
   role and a recent sign-in approves or rejects through the existing change-set routes. The change-set records are not yet interpreted by an installed pack
   (namespace `xo-resolution`): the executable-use gate will therefore not treat them as executable until a pack defines the
   namespace. That pack is follow-up work (see "Reopen if").
9. **API (author role, strict body, audited):** `POST /workspaces/{ws}/entity-resolutions` (compute) and
   `POST /workspaces/{ws}/entity-resolutions/proposals` (propose claims). Audit holds counts and hashes (`resolution.computed`,
   `knowledge.change-set.proposed`), never names or values. Audit metadata keys avoid the forbidden fragments (`itemsHash`, not
   `inputHash`). No Studio screens.
10. **Measured (UAC-19).** Suite `entity-resolution` in `@xo/evaluation` over the labelled set `entity-resolution` (72 cases,
    synthetic, content-hashed; same-name, initials, nicknames, reordered names, transliteration variants, conflicting identifiers,
    cardinality, unmatched). Thresholds, **ratified 2026-11-17 by owner delegation; labelled set is synthetic**: precision >= 0.99,
    recall >= 0.90, wrong-identity confirmations = 0.

## Consequences

- The numbers on the synthetic set are 100% / 100% / 0. I wrote the set with the matcher in view, so this shows the rules hold, not
  real-world accuracy. A real, blind set is needed (register R12).
- Reordered names ("Rao Asha") match at the `full` tier and resolve: every word of the name is present. That is deliberate and
  could be wrong for a name that is also another person's name in reverse.
- A subject listed twice with identical fields is treated as a homonym pair (ambiguous), not deduplicated.
- The duplicated "same person listed twice is one person" rule of `matchPath` is unchanged for file matching (UW-12a), but is not
  used by the resolver.
- The audit target kind for a compute-only run is the existing `knowledge-change-set` kind (no new kind was added).

## Reopen if

- Real labelled data shows a wrong-identity confirmation on `full` name matches (then require an identifier for resolution).
- A vertical needs fuzzy matching on non-person entities (invoice numbers, supplier names): add per-schema normalisation rules.
- UW-6/UW-8 need the claims to feed execution: add a Domain Knowledge Pack defining `xo-resolution`.
