# S1-11 review: Settings and the sign-in page

Status: awaiting design review.

## Screens

- Settings on the kit: the sections are the kit tab list (arrow keys, one tab stop) above the panel, instead of a hand-made side list; detail level and theme are kit radio groups; checkboxes, selects and text fields are kit fields; notices are kit banners; Save says why it is unavailable ("Nothing has changed yet." or the role reason) instead of going silent.
- Sign-in on the kit: Access key is a kit field with its help text, "Continue" shows a working state or the reason it cannot be used yet, notices are kit banners. "Continue with Google" stays visible but unavailable in the browser build, with the reason beside it.
- A sign-in that ends part-way: where Studio can sign in again in place it says "Your sign-in has ended" with "Sign in again" and the screen stays; with an access key (no in-place sign-in) it says the key was not accepted and what to do.
- A refused action names who can do it: "Your role does not allow this … Ask a workspace admin if you need access."

Images (dark and light, desktop and phone) are in docs/reviews/s1-11/.

## Five states

Loading: skeleton. Error: problem notice. Empty: not applicable to settings. Success: the saved note. In progress: "Saving…" and "Checking…".

## Glossary

Workspace, Members, Inbox. No new terms. "XO" only as the product name.

## axe

No new findings; a11y-known.json stays empty.

## Keyboard path

Settings tab list with arrows, then the panel's fields in order, then Save. Sign-in: Access key, Continue.

## Copy read aloud

"Your sign-in has ended. XO could not confirm who you are, so nothing was done."

## Nothing promised that the API cannot do

"Sign in again" appears only where the app has an in-place sign-in. Studio never says who the admins are; the platform does not tell it.

## No industry word

None.

## Hand checks not done

Screen reader, 200% zoom, reduced motion: not done by a person. Not tested against a real OIDC provider.
