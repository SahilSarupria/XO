# Runbook: provider outage

**Use when** a provider is down, failing, slow or throttling (Gmail, Microsoft Graph, an SMTP server, a payment API).

## What XO already does on its own

| Provider says                                             | XO does                                                                                                                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Slow down" (Gmail 429 / `rateLimitExceeded`, Graph 429)  | Pauses that connector for the `Retry-After` it sent; every later call queues behind the pause; the refused call is tried again within its step deadline (at most 5 times), else fails `RATE_LIMITED`, provably not sent. |
| Daily quota reached (`dailyLimitExceeded`, message limit) | Refuses every later send to that connection for the rest of the UTC day, untried.                                                                                                                                        |
| 5xx, timeout, dropped connection after sending            | The outcome is **unknown**: the item stops for a person. Never re-sent blindly.                                                                                                                                          |
| Five failures in a row                                    | The connector's circuit opens: the remaining items stop **without being sent** (`CIRCUIT_OPEN`) and go to a person.                                                                                                      |

## 1. Confirm it is the provider

- The provider's status page, and its answer in the run view's `effects` (`detail`).
- `GET $B/workspaces/$WS/control/inbox`: many `attention` entries on one connector, or batches escalated with `CIRCUIT_OPEN`.

## 2. Stop new work against it

```bash
curl -s -H "$H" -X POST $B/workspaces/$WS/emergency-stops -d '{"scope":"connector","target":"mail","reason":"Gmail outage"}'
```

Runs in progress hold before their next call to it; other connectors keep working.

## 3. Settle what is unknown

Every `attention` entry is a call that may or may not have happened. Follow [Unknown side effect](unknown-side-effect.md) for each; for email with a read scope, check the Sent folder.

## 4. Pace it when it comes back

If the provider recovered but is fragile, set a pace before releasing the stop (restart needed):

```bash
XO_CONNECTOR_RATE_LIMITS=mail=1/1   # one call per second to the connector named mail, per workspace and process
```

## 5. Resume

1. Release the stop. Held runs carry on.
2. Items that ended `CIRCUIT_OPEN` were not sent: send them as a new batch (prepare a preview with just those items; a reviewer approves it).

## Never

- Never raise the rate limit or turn off the stop to "push through" while the provider still answers 5xx.
- Never re-run a whole batch to cover failed items: items already sent would be prepared again. Prepare a preview of only the items that were not sent.
