# Design review: S1-1 design system

Status: **awaiting design review** (owner). Branch `s1-1/design-system`, stacked on `s1-0/truth-fixes`.

## The direction ("paper and ink")

XO's work is a team's procedures carried out by XO, with a person signing off on anything that matters. The look comes from
that, not from a generic SaaS palette.

- **Light first, and the device decides.** The theme follows the device by default (Settings → Appearance: Match this device,
  Light, Dark). Offices work in daylight, and reviewers approve on phones; the earlier dark-only default suited neither.
- **Paper and blue-black ink.** Cool paper ground (`#eef1f4`), white sheets, blue-black text (`#141b26`).
- **One accent: signature-ink cobalt** (`#2d4bc8`), for the one most important action on a screen and for what XO itself
  carries out.
- **The reviewer's amber stamp** (`#9a4c0a`), only for what a person decides. With the cobalt disc, it is the product's pair of
  marks (`WhoMark`): a filled disc for "XO carries this out", a stamped square with a tick for "A person decides".
- **Dark ("night shift")**: blue-slate ground rather than neutral black, so it keeps the ink character.
- **Status is words plus a shape.** Thirteen states, one vocabulary (`StatusPill`); colour only repeats what the words and
  shape say. Pills are small stamped rectangles, not capsules.
- **Type**: Instrument Sans for everything (already bundled); JetBrains Mono only for ids. Scale 12/13/14/16/20/24/32.

## What is in this PR

- `src/styles/tokens.css`: primitives, semantic tokens (surfaces, text 1–3, accent, xo/person, positive/attention/danger
  and their washes, focus, control edge, scrim, shadows), type, space, shape, motion and layers; both themes. Old token names
  point at the new ones, so screens not yet rebuilt keep working, now in both themes.
- `src/ui/kit/`: Button, IconButton, ConfirmButton; Field, TextField, TextArea, Select, Checkbox, RadioGroup, Switch,
  FileDrop, FormErrors; PageHeader, Tabs, Card, Disclosure, Banner, Breadcrumb; Sheet, Dialog, Toast; StatusPill, WhoMark,
  DescriptionList, EvidenceQuote, Timeline, CountSummary, DataTable; Skeleton, EmptyState, ErrorState, Progress, DataView.
- `/__kit`: every part in every state, development builds only (not in the production bundle).
- Screens: only token changes. The Inbox's and the workspace chooser's private dark palettes are removed, so both follow the
  theme. The screens are rebuilt on the kit in S1-3 to S1-11.

## Screens

| Kit, light                                                                                                   | Kit, dark                                                                                                   |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| ![](https://raw.githubusercontent.com/SahilSarupria/XO/s1-1/design-system/docs/reviews/s1-1/kit-light-1.jpg) | ![](https://raw.githubusercontent.com/SahilSarupria/XO/s1-1/design-system/docs/reviews/s1-1/kit-dark-1.jpg) |
| ![](https://raw.githubusercontent.com/SahilSarupria/XO/s1-1/design-system/docs/reviews/s1-1/kit-light-2.jpg) | ![](https://raw.githubusercontent.com/SahilSarupria/XO/s1-1/design-system/docs/reviews/s1-1/kit-dark-2.jpg) |

| Phone: a table becomes cards                                                                                     | Home on a phone                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| ![](https://raw.githubusercontent.com/SahilSarupria/XO/s1-1/design-system/docs/reviews/s1-1/kit-phone-table.jpg) | ![](https://raw.githubusercontent.com/SahilSarupria/XO/s1-1/design-system/docs/reviews/s1-1/app-phone-light-home.jpg) |

| Existing screens, light                                                                                          | Existing screens, dark                                                                                            |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| ![](https://raw.githubusercontent.com/SahilSarupria/XO/s1-1/design-system/docs/reviews/s1-1/app-light-home.jpg)  | ![](https://raw.githubusercontent.com/SahilSarupria/XO/s1-1/design-system/docs/reviews/s1-1/app-dark-home.jpg)    |
| ![](https://raw.githubusercontent.com/SahilSarupria/XO/s1-1/design-system/docs/reviews/s1-1/app-light-work.jpg)  | ![](https://raw.githubusercontent.com/SahilSarupria/XO/s1-1/design-system/docs/reviews/s1-1/app-dark-work.jpg)    |
| ![](https://raw.githubusercontent.com/SahilSarupria/XO/s1-1/design-system/docs/reviews/s1-1/app-light-inbox.jpg) | ![](https://raw.githubusercontent.com/SahilSarupria/XO/s1-1/design-system/docs/reviews/s1-1/app-light-signin.jpg) |

## Checklist (plan 5.9)

| Item                                    | Result                                                                                                                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Screens at both sizes and both themes   | Above: the kit at desktop (both themes) and phone; the existing screens in both themes.                                                                                                                                                                      |
| Five states of each view                | `DataView` has five distinct, tested states (`test/kit/kit.test.tsx`); the kit page shows each.                                                                                                                                                              |
| Glossary                                | The kit's own words follow it. The existing screens' wording is unchanged here (S1-3 onwards).                                                                                                                                                               |
| axe clean                               | The whole kit page has no axe violations (test). Contrast is checked from the tokens: every text, status and wash pair is at least 4.5:1, and every control edge and the focus ring at least 3:1, in both themes (`test/design/tokens.test.ts`, 119 checks). |
| Keyboard path                           | Tabs follow the WAI-ARIA pattern. Sheets and dialogs take focus, keep it, close on Escape and give it back (tests). Unavailable buttons stay focusable and say why.                                                                                          |
| Focus order and focus ring              | 2 px focus outline in the accent on every kit control, visible in both themes.                                                                                                                                                                               |
| Copy read aloud                         | The kit's sample copy is plain and industry-neutral.                                                                                                                                                                                                         |
| Nothing promised that the API cannot do | The kit is presentation only.                                                                                                                                                                                                                                |
| No industry word                        | None in the kit.                                                                                                                                                                                                                                             |

## What to look at in review

1. **Light first with "Match this device".** This reverses plan section 5.1 ("keep the dark-first direction"). It is recorded as
   decision D-17 in `claude/XO_STUDIO_DECISIONS_LOG.md`.
2. **Cobalt and amber as the product's two marks.** This replaces the mint accent.
3. **The live workflow card keeps its dark brushed-metal face** in both themes. It will be revisited when the Work page is
   rebuilt (S1-5).
