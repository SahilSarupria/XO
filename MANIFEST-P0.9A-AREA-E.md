# P0.9A Area E — Specification Recovery — Delivery Manifest

Status: **E1 — implemented, scoped narrowly**. Additive only. No hash/ID impact.
Not yet verified locally (no `node_modules`/network in the authoring sandbox) —
run the verification steps at the bottom before merging.

## What changed, in one sentence
Added `listKind: 'ordered' | 'unordered'` end-to-end (`ListItemBlock` →
`ExperienceUnit`), and used it in exactly one place: the compiler no longer
asserts a `custom:sequence` edge between two adjacent sibling units that are
both bulleted — because a bullet marker never claimed an order in the source
document in the first place.

## Files — overwrite exactly these 14, nothing else

Source (10):
```
packages/compiler/src/document/list-marker.ts
packages/compiler/src/document/block-classifier.ts
packages/compiler/src/document/types.ts
packages/compiler/src/document/block-builder.ts
packages/compiler/src/sources/document-frontend.ts
packages/compiler/src/sources/html-frontend.ts
packages/compiler/src/semantic/types.ts
packages/compiler/src/semantic/unit-builder.ts
packages/compiler/src/semantic/relationship-builder.ts
packages/compiler/src/capabilities/relationship-builder.ts
```

Tests (4):
```
packages/compiler/test/document/list-marker.test.ts
packages/compiler/test/semantic/semantic-type-classifier.test.ts
packages/compiler/test/semantic/semantic-chunker.test.ts
packages/compiler/test/capabilities/relationship-builder.test.ts
```

Nothing else in the repo was touched. Areas A/B/C/D, `apps/`, `apps-api`/`apps-cli`,
Studio, workflow-composer, runtime, xoir, capability-contract: untouched.

## Per-file summary

| File | Change |
|---|---|
| `document/list-marker.ts` | `DetectedListMarker` gains `listKind`; bullet-glyph branch returns `'unordered'`, digit/letter branch returns `'ordered'` |
| `document/block-classifier.ts` | `ClassifiedLine` gains optional `listKind`; carried from `detectListMarker` |
| `document/types.ts` | `ListItemBlock` gains required `listKind` |
| `document/block-builder.ts` | passes `line.listKind!` into the `ListItemBlock` literal |
| `sources/document-frontend.ts` | markdown-style `LIST_ITEM_RE` frontend: derives `listKind` from whether the marker starts with a digit |
| `sources/html-frontend.ts` | `<li>` frontend: hardcoded to `'unordered'` (this frontend never tracked `<ol>` vs `<ul>`; documented as an honest default, not a regression — distinguishing them is out of this task's scope) |
| `semantic/types.ts` | `ExperienceUnit` gains optional `listKind`, doc-commented, **excluded from hashing** |
| `semantic/unit-builder.ts` | `DraftExperienceUnit` gains `listKind`, set only when a group's sole block is a `ListItemBlock`. **Declared as `'ordered' \| 'unordered' \| undefined` (required, not `?:`)** — matches the existing `structuredFields`/`headingTitle` convention in this file, needed because the repo builds with `exactOptionalPropertyTypes: true` (an initial `?:` version failed `tsc -b`; fixed and repackaged) |
| `semantic/relationship-builder.ts` | passthrough of `draft.listKind` into the final `ExperienceUnit`, same pattern as `isTableQuarantined` |
| `capabilities/relationship-builder.ts` | cross-unit `custom:sequence` pass: `continue`s (skips the edge) when both adjacent sibling units have `listKind === 'unordered'`; doc comment updated with the Aastha.pdf rationale |

## Why this is safe to merge as-is (no schema/hash migration needed)
- `computeExperienceUnitId` (`unit-id.ts`) hashes only `documentPath` /
  `sectionPath` / `blockIndexRange` / `content` — `listKind` never enters it.
- The field is optional everywhere; every existing call site that doesn't set
  it (e.g. anything not a sole list-item group) is unaffected — same
  additive-optional-field pattern Area C already used for `isTableQuarantined`.
- The only *behavioral* change is the new `continue` in
  `capabilities/relationship-builder.ts`'s cross-unit loop — it can only
  ever remove a `custom:sequence` edge, never add one, and only when both
  sides are proven `'unordered'`. A pair where either side is `'ordered'`,
  or either side isn't a list item at all (`listKind === undefined`), is
  untouched.

## Local verification steps (run these — not run in this sandbox)

```bash
npm install
npm run build --workspace=@xo/compiler
npm run test --workspace=@xo/compiler
```

Expect all 4 new/updated test files to pass, specifically:
- `test/document/list-marker.test.ts` — 7 updated assertions now include `listKind`
- `test/semantic/semantic-type-classifier.test.ts` — updated `listItem()` helper
- `test/semantic/semantic-chunker.test.ts` — 3 new tests (`ordered` end-to-end, `unordered` end-to-end, non-list has no `listKind`)
- `test/capabilities/relationship-builder.test.ts` — 3 new tests (unordered/unordered skipped, ordered/mixed still fires, non-list/non-list still fires)

Then:
```bash
npm run test:coverage   # or whatever runs the full monorepo suite
npm run build           # full monorepo build
```
Expected baseline: still the known **3 pre-existing monorepo failures**, no new ones.
If a benchmark suite is run before/after, no metric currently measures
specification recovery — a zero delta there is expected, not a null result.

## Not included in this delivery (explicitly out of scope, per Area E's decision gate)
- List nesting/level (Option C) — audited, real gap found (Aastha's nested
  `○` sub-bullets under numbered steps), but not implemented; classified E2,
  needs its own justified pass.
- `<ol>`/`<ul>` tracking in the HTML frontend — would be new source-adapter
  parsing, excluded by Area E's "no generalized source adapters" scope line.
- Within-unit (same-unit) sequence facts — untouched; only the cross-unit
  sibling pass was changed.
