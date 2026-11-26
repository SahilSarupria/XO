# S1-8 design review: schedules and stopping work

Status: awaiting design review.

## Screens

- Workflow page, "Schedule and approvals": "When it starts by itself". Choices: only when someone starts it, every hour, every day, every week, or another interval in hours or days. It says plainly that times of day and calendar dates are not available.
- Settings, Operations: what to stop is picked from lists (workflows by name, connections, what a connection does), never typed.
- Every screen: a banner when the instance, the workspace or named things are stopped, with "See what is stopped".

Images (dark and light; desktop and phone) are in docs/reviews/s1-8/. Example: ![](https://raw.githubusercontent.com/SahilSarupria/XO/s1-8/recurring-and-control/docs/reviews/s1-8/j5-03-banner-everywhere-desktop-light.jpg)

## Five states

Loading, empty ("Nothing to pick yet", "Nothing is stopped."), error (problem notice with the platform's words), success (the recorded line) and in progress (button loading). The banner shows nothing while loading or if it cannot be read.

## Glossary

Workflow, Run, Inbox. "Connection" for what XO uses to reach another system. No ids outside Builder mode.

## axe

No new findings; a11y-known.json stays empty.

## Keyboard path

Schedule tab, arrow keys in the radio group, Save. Stop it, then the confirmation group. The banner button is a normal button.

## Copy read aloud

"It starts that long after the last time, while XO is running, and does not catch up after a break." States the limits.

## Nothing promised that the API cannot do

The platform keeps one interval from 5 minutes to 7 days; nothing monthly or at a time of day is offered. Saving needs the ready check; if it is not ready the schedule is not saved and the reasons are shown.

## No industry word

None.

## Hand checks not done

Screen reader, 200% zoom, reduced motion. A schedule was not left on in any journey (it is switched off again in the same journey).
