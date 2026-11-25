# Design review: S1-4 Sources

Status: **awaiting design review**. Branch `s1-4/sources`, stacked on `s1-3b/ask-anywhere`.

## What changed for a person

- **Documents** (was "Context"): one drop zone built from the kit (keyboard and phone friendly: a real file chooser behind a visible button), problems as banners, an empty state that says what to add, and no more middle-dot meta strings.
- **What XO found** (folders and drives): a count of what waits for you ("2 things are waiting for you to say whether XO has it right. XO uses nothing until you do"), each finding as a card with its evidence, and **Yes, that is right / No, that is not right**. Those are the two decisions the API has; there is no "edit a finding" because the API cannot do one.
- No engine variable name remains in the copy (the folder form no longer says `XO_SOURCE_FOLDER_ROOTS`).

## Screens

`docs/reviews/s1-4/sources/`: before (connection page, dark), after (findings and Documents), desktop and phone, dark and light.

## The five states

| View          | Loading               | Empty                                       | Partial                               | Error                                | Ready                 |
| ------------- | --------------------- | ------------------------------------------- | ------------------------------------- | ------------------------------------ | --------------------- |
| Documents     | skeleton              | "No documents yet" with what to add         | a search that matches nothing says so | problem banner, the platform's words | list with status      |
| What XO found | skeleton (connection) | the section is absent when XO found nothing | some answered, count of those waiting | problem notice with retry            | all answered, says so |

## Checks

- **Glossary:** "Context" gone; the remaining "XOs" tab inside Sources is recorded as a known gap for S1-5 (it lists the same things as the Create screen).
- **axe:** no findings at any journey checkpoint, both sizes; `a11y-known.json` empty.
- **Keyboard:** every control is a real button, input or label; the file chooser works from the keyboard; the two answers are reachable in order.
- **Copy read aloud:** short sentences; says what XO found, then what to do.
- **Nothing promised that the API cannot do:** only confirm and reject exist, so only those are offered.
- **No industry word** in the shell or these screens; the folder and file names shown are the customer's own.
- **Not done by a person:** screen-reader listening, 200% zoom, reduced motion.
