# Runbook: unknown side effect

**Use when** XO made a call and does not know whether it happened: an email accepted but the connection dropped, a payment request that timed out, a 5xx after the request was written. XO never guesses and never re-sends on its own; the item waits for a person.

## 1. Find them

- Studio: **Inbox**, items marked "Check what happened".
- API: `GET $B/workspaces/$WS/control/inbox` → `attention`: each entry names the workflow, the run (and for a batch, `parentRunId` and `item`), the step, the connector and operation, when the call started and what was observed.

## 2. Look at the destination

| Destination | Where to look                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Gmail       | The Sent folder of the sending account. XO's messages carry a deterministic Message-ID derived from the run's key. |
| Microsoft   | Sent Items of the sending mailbox (the same Message-ID).                                                           |
| SMTP only   | The recipient's confirmation or the mail server's logs; XO cannot look itself.                                     |
| Payment API | The provider's dashboard, by the idempotency key in the run's effect row (`key`).                                  |

Where the connection has a read scope, XO looks itself before asking (`find_sent`), so what reaches you is what it could not settle.

## 3. Record what you found

Studio: choose **It happened**, **It did not happen** or **I cannot tell yet**, say what you checked (required), and where. Or:

```bash
curl -s -H "$H" -X POST $B/workspaces/$WS/generated-workflows/$DEF/runs/$RUN/effects/$STEP/reconciliation \
  -d '{"decision":"confirmed_success","reason":"message is in Sent at 10:01","evidenceExamined":"Gmail Sent folder"}'
```

Review role and a recent sign-in. Recording never sends, re-sends or undoes anything. `unresolved` keeps the item blocking for someone who can check.

## 4. Afterwards

- **It happened:** nothing else to do for that item.
- **It did not happen:** the item is settled as not sent. To send it, prepare a new preview with that item and have it approved. XO does not re-send it by itself.

## Never

- Never re-send to find out.
- Never record `confirmed_failure_no_effect` because nothing obvious arrived: if you cannot tell, record `unresolved`.
