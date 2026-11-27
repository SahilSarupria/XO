# S1-10 review: Knowledge, Activity and the run page

Status: awaiting design review.

## Screens

- Knowledge: one place with two tabs, "What XO knows" and "Records". Each has its own search, so they are tabs rather than two searches on one page.
- Activity: the state chips plus two new choices, "Workflow" and "When" (any time, last day, last 7 days, last 30 days). When either is set, a line says how many runs match among the runs loaded, and whether more can be loaded.
- Run page at `/w/<workspace>/activity/runs/<run>`: name, state, who started it and when, "Open in the Inbox" when a decision waits, results shown at once, "Back to Activity". A run that is not among the loaded ones says so and offers "Look at earlier runs".

Images (dark and light; desktop and phone) are in docs/reviews/s1-10/.

## Five states

Loading: skeleton. Error: the problem notice with Retry (a stale list is kept and says it may be out of date). Empty: the existing "Nothing has been run yet", "No runs in this group", and the run page's "not among the recent ones". Success: the list and page. In progress: the loading button on "Look at earlier runs".

## Glossary

Workflow, Run, Inbox, Knowledge, Records. Ids appear only in Builder mode.

## axe

No new findings; a11y-known.json stays empty.

## Keyboard path

Activity, the Workflow and When selects, the chips, a run name (a button), "Back to Activity". Knowledge: the tab list with arrow keys.

## Copy read aloud

"3 runs among the 50 loaded; use Show earlier runs to load more." States the limit of what was searched.

## Nothing promised that the API cannot do

Filters run on the runs already loaded; the API has no filter query, and the page says so. There is no single-run read, so the run page looks the run up in the list.

## No industry word

None in the new copy.

## Hand checks not done

Screen reader, 200% zoom, reduced motion: not done by a person.
