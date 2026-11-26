# S1-7 design review: Inbox

Status: awaiting design review.

## Screens

- Inbox on a phone opens as a list. Opening an item shows only that item, with "Back to the Inbox". Wide screens show both, as before.
- A step that leads to no action afterwards is a task: buttons read "Mark done" and "Not done", with an optional note. A step that leads to an action keeps "Approve" and "Reject".
- An unknown outcome says what XO checked (it made the request, got no answer, has not tried again) and asks what happened: "It happened / It did not happen / I cannot tell yet", with a required reason.

Images (dark and light; desktop and phone) are in docs/reviews/s1-7/. Example: ![](https://raw.githubusercontent.com/SahilSarupria/XO/s1-7/inbox/docs/reviews/s1-7/j2-03-mark-done-mobile-light.jpg)

## Five states

Loading, empty ("Nothing is waiting for you"), error (decisions could not be loaded), success (the recorded line) and in progress (buttons show pending) use existing kit states.

## Glossary

Inbox, Workflow, Run, item. No ids outside Builder mode: names of colleagues the API gives only as ids read "a colleague" or "a reviewer".

## axe

No new findings; a11y-known.json stays empty.

## Keyboard path

Inbox list, Enter on a row, note, Mark done. "Back to the Inbox" is a normal button.

## Copy read aloud

"XO asked mail to do something and never heard back, so it does not know whether it happened." Plain and says what is not known.

## Nothing promised that the API cannot do

The note goes with the decision (the API accepts a comment). Nothing says it was or was not sent unless a person records it.

## No industry word

None in the list, cards or notices.

## Hand checks not done

Screen reader, 200% zoom, reduced motion. J3 (an unknown outcome) is not a journey because it cannot be made to happen without a mail server that drops a connection; it is covered by the control-surface test.
