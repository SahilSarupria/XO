# Baseline-refresh proposal (for maintainer decision; NOT applied)

Per `packages/benchmark/BASELINE_PROTOCOL.md` section 6, a baseline refresh needs a `BaselineRefreshRecord` with a disposition and
reason for every difference, the predecessor retained, and a CHANGELOG acceptance point. This document supplies the inputs; it does
not create the record, regenerate any baseline, or edit `BASELINES.json`.

## State on the base commit vs now
- `packages/benchmark` tests: 2 failures exist on the UNTOUCHED base commit (#35 historical audit, #147 accepted baselines
  reproduced exactly). They are not caused by this change set. With it, #35's count of unexplained differences is larger (2 on the base commit -> 7 now),
  and #147's diff is larger: both are count shifts from the capability changes below.

## Intentional behaviour changes that moved pinned values (each justified in its test comment)
| Change | Effect on the real fixtures |
|---|---|
| Categorical atoms no longer drop trailing "and/or/unless/temporal/list" clauses | a rule whose AND lost an operand (flood endorsement present AND loss caused by flood) is no longer executable on half its condition |
| Comma-listed conditions parsed with the correct boundary; list conditions structure only when every operand parses | a 4-condition rule was executable on 2 conditions; it is now unresolved with its full text kept |
| Permission / advisory outcomes are not minted as mandatory rules | "the claim may be rejected" no longer resolves as a deterministic rule |
| Unconditional statements (short subject / decision verb) become non-executable nodes | previously lost sentences now exist; adds same-unit and exact-label edges; executable capability counts unchanged by this |
Pinned values changed: compiler fixture resolved 20 -> 17 (deterministic 19 -> 16), `same_unit_term_overlap` 25 -> 36, `exact_label`
108 -> 132; CLI discovered/resolved 33/20 -> 30/17; benchmark contract-hash matches 42 -> 39 and compiled capabilities 71 -> 68.
All executable counts moved DOWN by exactly the rules that were executable on an incomplete condition or were permissions.

## Tried and reverted
- Treating "Where ..." as a condition cue: the labelled benchmark flagged a precision regression (it extracted the vague condition of
  "Where a loss appears suspicious ..."). Reverted; such sentences stay visible via the coverage guard.

## Deferred because it touches governed ground truth
**Move `flood` and `theft` out of the neutral grammar core into the `insurance-claims` profile.** The words are pinned as legacy
(`LEGACY_DOMAIN_STATE_WORDS`, guarded by a test so the list cannot grow). Moving them requires: (1) an optional `profile` field in
`packages/benchmark/src/definition.ts` and its strict ground-truth schema, (2) setting it on the insurance cases in
`ground-truth/vertical-fixtures.ground-truth.json` (changes that file's bytes, therefore its `reportSha256`/suite identity),
(3) `observe.ts` passing the profile's lexicon to `compileSources`, (4) re-pinning counts for the real PDF in CLI/compiler tests,
and (5) a refresh record covering the resulting differences. `compileSources({ autoProfile: true })` / `xo compile --profile auto`
already provide an explicit, opt-in way to apply the identified domain's profile in the meantime.

## Not done, and why
- No baseline was regenerated and no `BASELINES.json` entry edited (protocol: a refresh is an explicit, reviewed act).
- Duplicate lowering of the same-named generic and rule-derived capability ("Escalate to the manager") was left as is: removing it
  would shift every pinned capability count again and belongs in the same reviewed refresh.
