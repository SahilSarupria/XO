# Studio words (glossary)

Studio speaks to people who run a team's work, not to engineers. These are the words it uses in User mode. Builder mode may
keep the technical term where it says what it means to a builder. S1-3 writes this list; S1-12 enforces it with a copy test
over every User-mode screen.

| Use                                                       | Instead of                                          |
| --------------------------------------------------------- | --------------------------------------------------- |
| Workflow                                                  | XO (as a thing the person made), process            |
| Run                                                       | execution                                           |
| Item                                                      | row, forEach                                        |
| Source                                                    | context, document set                               |
| Approve a batch; Mark done / Not done (a person's task)   | Approve / Reject on a task                          |
| Check before starting                                     | readiness certificate (Builder mode keeps the term) |
| Inbox                                                     | Tasks                                               |
| Home, Inbox, Work, Sources, Knowledge, Activity, Settings | any other name for the seven places                 |

"XO" is only the product's name.

## How Studio writes

- Plain words, short sentences, second person, active voice.
- Say what happened, then what to do.
- "3 emails", not "3 item(s)".
- Relative dates ("in 2 hours"), with the exact time on hover or tap.
- Errors never blame the person, and say what XO will and will not do next.
- A button says what happens ("Approve 3 emails"), and the same words appear in what follows ("3 emails approved").
- Empty screens say what to do next. Loading never claims "nothing here".
- No industry vocabulary in the shell: the words above work for any team.

## Known gaps (fixed by the PR named)

- "XO" still names a thing the person made on the Create screen and on the "XOs" tab inside Sources, which lists the same things (S1-5 rebuilds both). The Documents and Connections tabs no longer do (S1-4).
- "Process" appears in Start work and in Builder views (S1-5 rebuilds Work).
