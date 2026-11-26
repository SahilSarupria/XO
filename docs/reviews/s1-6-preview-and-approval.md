# S1-6 design review: preview and approval

Status: awaiting design review.

## Screens
- Preview before sending (J1-08): "nothing was sent" is stated first.
- Ask for approval (J1-09) and the reviewer's approval (J1-10, J2-02): the batch card opens with one line, "N need(s) a look before you approve. They are listed first.", or "Nothing needs a look". The longer "How this stays safe" text sits behind a fold.
- Signing in again (step-up): the notice keeps the screen as it is and offers "Sign in again", then says nothing was done yet.

Images (dark, light; desktop, phone) are in docs/reviews/s1-6/. Example: ![](https://raw.githubusercontent.com/SahilSarupria/XO/s1-6/preview-and-approval/docs/reviews/s1-6/j1-09-ask-for-approval-desktop-light.jpg)

## Five states
Loading, empty, error, success and in-progress are unchanged kit states. New in-place states: sign-in busy, signed in again, sign-in failed.

## Glossary
Workflow, Run, Item, Inbox, "Check before starting" only. No engine words or ids on these screens.

## axe
No new findings. a11y-known.json stays empty.

## Keyboard path
Inbox > batch card > exceptions toggle > Approve this batch > confirm button. Sign in again is a normal button in the notice.

## Copy read aloud
"Sign in again here; this screen stays as it is. Then repeat the action." Reads plainly. The notice never says the action went through.

## Nothing promised that the API cannot do
Counts, exceptions and approval come from the API. Signing in again only appears where the app has external sign-in.

## No industry word
None in the shell, cards or notices.

## Hand checks not done
Screen reader, 200% zoom and reduced motion have not been checked by a person. Sign-in again was not tried against a real OIDC provider (stub only).
