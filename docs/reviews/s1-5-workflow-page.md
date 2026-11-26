# Design review: S1-5 The workflow's own page

Status: **awaiting design review**. Branch `s1-5/workflow-page`, stacked on `s1-4/sources`.

## What changed for a person

- **A workflow has a page** at `/w/<workspace>/work/<workflow>`, with five tabs: Overview (status, what happens next, one live line that is read out when it changes), Runs, Schedule and approvals, Setup, History. The tab is in the address, so a link opens where you were.
- **Work lists your workflows by name** ("Send each client their document"), with a status and how many decisions wait. The name is proposed from the goal and can be renamed on the page; a stale rename is refused rather than overwriting someone else's.
- **Start** goes through the workflow's own route. If a person must decide first, the page says so and offers the Inbox instead of a button that cannot work.
- **Setup shows the steps** with who does each (XO or a person) and a **Sending email** panel: pick the step that sends, pick the account (connect Gmail, Outlook, or use an app password), and say where each part comes from: who it goes to (a column of a confirmed list), subject, message, and whether each person's document goes with it.
- **The live workflow card** lost its dark metal face and moving border. A running workflow now has a steady accent edge on the normal surface, in both themes. The `--metal-*` tokens are deleted.

## Screens

`docs/reviews/s1-5/workflow-page/`: before and after, desktop and phone, dark and light.

## The five states

| View          | Loading                  | Empty                                        | Partial                                | Error                                | Ready                        |
| ------------- | ------------------------ | -------------------------------------------- | -------------------------------------- | ------------------------------------ | ---------------------------- |
| Workflow page | skeleton                 | runs: "No runs yet", history always has one  | stale data banner while a reload fails | error state with retry               | tabs                         |
| Sending email | skeleton                 | "No email account is connected yet."         | account chosen, columns unknown: type the column name | the platform's words, choices kept | "Send set-up saved"          |

## Checks

- **Glossary:** Workflow, Run, Setup, History, Schedule and approvals. "Check before starting" is the existing readiness check. Known gap: the older check panel still says "certificate" in its lede; it is reworded in S1-12 with the copy test.
- **axe:** none at any journey checkpoint, both sizes; `a11y-known.json` empty.
- **Keyboard:** tabs are a real tablist with arrow keys; every mapper row is a native select or input; Save is a button with a stated reason when it cannot be used.
- **Copy read aloud:** plain sentences; the one jargon leftover is named above.
- **Nothing promised that the API cannot do:** saving the send set-up asks for the manage role and a recent sign-in; Studio shows the platform's answer and keeps the choices. Recurring runs are not set up here ("not set up from this page yet"), they come in S1-8. There is no Go live button: the workflow API has no mode, a workflow starts when the platform says it is ready.
- **No industry word** in the shell or these screens; step and column names are the customer's own.
- **Not done by a person:** screen-reader listening, 200% zoom, reduced motion.
