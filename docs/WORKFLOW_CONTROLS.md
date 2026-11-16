# Workflow controls: mode, triggers, limits, sign-off, practice, pause

What this adds to a compiled workflow, how it is enforced, and, just as important, what it does **not** do.
Everything here is enforced by the API server. The Studio only asks and shows the answers.

## What you can do

| Control              | What it does                                                                      | Who may (role permission)                                               |
| -------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Mode**             | `draft`, `shadow` (practising), `live`, `paused`.                                 | Move to/from draft, shadow, paused: `author`. Take **live**: `publish`. |
| **Pause everything** | One switch for the whole workspace. Nothing can start by any route until resumed. | `manage` (admin)                                                        |
| **Daily limit**      | At most N runs started per UTC day, practice runs included.                       | `author`                                                                |
| **Triggers**         | A **webhook** and/or an **every-N-minutes schedule**, per workflow.               | `author`                                                                |
| **Sign-off**         | A named reviewer records that they reviewed this exact version.                   | `review`                                                                |
| **Practice review**  | A reviewer judges each practice run: could it be done without a person?           | `review`                                                                |

Every change is written to the audit log (`workflow.mode_changed`, `workflow.limits_changed`, `workflow.triggers_changed`,
`workflow.signed_off`, `workflow.shadow_reviewed`, `workflow.triggered`, `workflows.paused`, `workflows.resumed`).

## Modes

- **draft** (the default): only a person starts it, with Start. This is how workflows behaved before controls existed.
  Switched-on triggers wait.
- **shadow** (shown as "Shadow" / "practising"): every run is a **practice run**. It carries out the steps XO can and
  **stops before the first step that needs a person**, without creating a task or asking anyone. The run ends as
  `succeeded` and records `shadow.outcome`: `would_complete` (no person was needed) or `would_escalate` (it stopped at a
  step that needs one, named in `shadow.stepName`). Triggers fire.
- **live**: runs are real: they ask real people to decide. Triggers fire.
- **paused**: nothing starts it, by hand or by trigger. Pausing remembers the earlier mode on the server.

**Going to shadow** needs every rule approved and a workflow the platform can run. **Going live** also needs: the
current version signed off, a daily limit set, and at least one finished practice run. A refused change returns HTTP 412
with the missing items in plain words.

## The start gate

Every start (manual, webhook, schedule) goes through one check and is refused with **HTTP 412** and a `reason`:

1. `workspace_paused`: the workspace-wide pause is on. (A saved draft run is also blocked.)
2. `workflow_paused`: this workflow's mode is paused.
3. `trigger_inactive`: a webhook/schedule start while that trigger is off, or the workflow is not shadow/live.
4. `daily_cap_reached`: today's limit (UTC) is used up.

The gate **fails closed**: if the controls cannot be read (a damaged file), nothing starts. This is tested.

## Triggers

- **Webhook**: `POST /workspaces/{ws}/workflows/{workflowId}/webhook` with `{ "compilationId": "...", "input": { ... } }`
  (input up to 64 KB). It uses the ordinary API-key authentication of a workspace member who holds `author`; there is **no
  second secret scheme**. `Idempotency-Key` is honored (a replay returns the first run, `200`). The run is marked
  `trigger: "webhook"`.
- **Schedule**: `{ "schedule": { "everyMinutes": 5..10080, "input": { ... } } }` (input up to 8 KB, the same input for every
  run). Marked `trigger: "schedule"`.

### What the schedule does and does not promise

- It runs **inside one API process while that process is up**. Two API processes on the same data directory would start the
  same run twice. Run one, or set `XO_SCHEDULER=off` on the others.
- It does **not catch up**. If the server was off for a day, the next tick starts **one** run, not a day's worth.
- Timing is "at least N minutes since the last slot", checked every 30 seconds. It is not wall-clock cron.
- A workflow whose required fields are not in the stored input cannot start; that is recorded (`lastOutcome`:
  `could not start: ...`) and not retried in a loop.
- A slot refused by the gate (paused, daily limit) is **skipped and recorded** (`lastOutcome: skipped: <reason>`), not queued.

## Sign-off

A recorded sign-off by a named identity on one **version** of the workflow (a hash of its compilation and ordered steps).
If the workflow changes, the sign-off turns stale (`current: false`) and no longer counts toward going live.
It is **not a cryptographic signature**, and it is **not independent**: a workspace admin can hold both `author` and
`review`. The platform enforces the role, nothing more.

## Practice results

The summary reports how many practice runs finished, how many would have completed without a person, how many stopped at a
person step, and, for the cases a reviewer chose to judge, how often the reviewer agreed. That is **agreement on one
question** (was a person needed?) for **those cases**. It is not accuracy, and no accuracy number is claimed anywhere.

## What this does not do (read before relying on it)

- **No external connectors exist in the platform yet**, so a practice run cannot protect an outside system; it protects
  people from being asked and the workspace from extra tasks. There are no Slack/email/HTTP actions to permit or deny, so
  there is **no connector permission screen**: it would have nothing to enforce.
- **No amount ceilings** ("acts alone up to $X"). The platform has no notion of a monetary field in a run; only the daily run
  limit exists.
- The pause and daily limit are enforced by this server process. Concurrent starts racing the limit can exceed it by the
  number of in-flight requests; this is not a distributed limiter.
- A sign-off, a mode and a limit are controls on **who may start what**. They do not make the workflow's decisions more
  accurate, and accuracy on a customer's documents is **not yet measured**.

## Try it (no network, no API key to anyone else)

With the API running locally and an admin key in `$KEY`, a workspace `$WS` with an approved workflow `$WF` in compilation `$C`:

```bash
H="authorization: Bearer $KEY"; B=http://127.0.0.1:8080
curl -s -H "$H" -X PUT  $B/workspaces/$WS/workflow-controls/workflows/$WF/limits  -d "{\"compilationId\":\"$C\",\"dailyRunCap\":5}"
curl -s -H "$H" -X POST $B/workspaces/$WS/workflow-controls/workflows/$WF/mode    -d "{\"compilationId\":\"$C\",\"mode\":\"shadow\"}"
curl -s -H "$H" -X POST $B/workspaces/$WS/workflows/$WF/executions -d "{\"compilationId\":\"$C\",\"input\":{...}}"   # a practice run
curl -s -H "$H" -X POST $B/workspaces/$WS/workflow-controls/pause -d '{"reason":"checking a batch"}'                  # nothing can start now
curl -s -H "$H" $B/workspaces/$WS/workflow-controls | jq .
```

The tests (`apps/api/test/workflow-controls.test.ts`, `apps/studio/test/contract/studio-contract.test.ts`) run the same
flow against the real server.
