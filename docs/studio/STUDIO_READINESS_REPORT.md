# Studio readiness report (wave S1)

Written at the end of wave S1 (PRs #64 to the S1-12 PR). It says what a customer can do in Studio today, what was checked and how, and what is not done. It claims nothing that was not checked.

## What a customer can do

Sign in; add documents and confirm what XO found; set up a named workflow with its own page (rename, check before starting, start, history); set up sending email with a saved account; preview a batch and approve it in the Inbox (decisions with notes; tasks marked done or not done); see every run and open it on its own page, narrowed by workflow and by time; run a workflow every so often (5 minutes to 7 days) or stop work in an emergency; invite colleagues by a link; see what XO knows and the records; ask XO from any screen, including from a workflow's own page; sign in again in place when a recent sign-in is wanted.

## What was checked, and how

- Every PR in the wave: build, typecheck, lint, format, size budget, the full `npm test` (exit 0), and a by-name comparison with the baseline test list (0 problems; the 2 known W5 renames only).
- Journeys J1, J2, J4, J5, J6, J7, J8 run in a real browser at desktop and phone size, dark theme, against a real API; screenshots are compared with approved references in CI; axe finds nothing at WCAG 2.2 AA (`a11y-known.json` is empty).
- Contract: `test/contract/studio-contract.test.ts` runs Studio's client against the real API; `test/contract/client-vs-openapi.test.ts` checks every route the client calls is in the API's OpenAPI document with that method.
- Copy: `test/ui/copy.test.tsx` reads every place and every Settings section in User mode for technical and industry words.
- Light theme: screenshots were taken locally for each PR's new screens; CI references are dark.

## Not done, and why

- **Hand checks by a person**: screen reader, 200% zoom, reduced motion. Never done. Needed before anyone relies on the accessibility claims.
- **Real usability sessions**: the script is `docs/studio/USABILITY_SCRIPT.md`; no session has been run.
- **J3 (unknown send outcome)**: still recorded as not done in journeys; it needs a mail server that drops a connection. The screen and its wording are covered by unit tests only.
- **The old candidate list and side panel on Work** are still there. Workflows are created from a goal, so existing documents with candidates but no named workflow would have no way to start. Hiding them needs a way to promote a candidate to a named workflow; that is the owner's call.
- **Desktop shell**: the web host answers deep paths correctly (checked on `deploy/serve.mjs`). The Tauri desktop build was not built or run here, so deep paths there are unchecked.
- **`/connect/...` routes** are served by the API but are not in its OpenAPI document (the contract test names them and will fail when they are documented).
- **Not tested against a real OIDC provider**: the in-place "Sign in again", the Google sign-in.
- **Invitation single use** is enforced inside one API process, not across several.

## Owner items

1. An OIDC or Google client for browser sign-in.
2. A notification sender (email). None exists; invites are links the inviter hands over.
3. The hosting choice (see `docs/studio/FREE_TIER_DEPLOY.md`).
4. Desktop signing certificates.
5. Real usability sessions with the script.
6. The labelled V1 sample (documents with known answers) for measuring XO's accuracy; Studio says accuracy has not been measured.
7. Mark "Studio screenshots" as a required check on the repository.
8. Review of S1-3b, S1-9 (invitations) and S1-12, which touch security and wording.
