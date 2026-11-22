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

### Certified workflows (ADR 0035)

Where readiness certificates are required (the production default, or the workspace's `trust.requireReadinessCertificate`), the
composed-workflow runner is retired: no start reaches it, by any route or trigger. Triggers name a certificate instead:

- **Webhook** with `"certificateId": "wrc_…"`: the certified definition runs on the workflow runtime. The certificate is verified
  again at that moment, and the response is the run view (`runId`). The same `Idempotency-Key` returns the same run.
- **Schedule** with `{ "everyMinutes": …, "certificateId": "wrc_…" }`: the certificate must allow a start when you set the schedule.
  It is verified again at every slot. A slot whose certificate has gone stale is skipped, and the reason is recorded. Each run starts
  as **the person who set the schedule**, and that person's role is checked again at every connector call. Each slot is its own
  idempotency key, so one slot starts one run, even with two instances on the same data directory.
- Practice mode is refused for certified triggers. A certified workflow is triggered only in live mode.
- An uncertified webhook or schedule in such a workspace is refused with `409 XO_WORKFLOW_REQUIRES_IR_RUNTIME`
  (`context.reason: composed_runner_retired`). A schedule is refused when you set it.

The daily limit counts composed runs only. Workflow-runtime runs are not counted yet.

### What the schedule does and does not promise

- It runs **inside one API process while that process is up**; a lease in the data directory keeps a second process on the same
  directory from ticking (UW-15). Set `XO_SCHEDULER=off` on instances that should never fire schedules. A certified schedule is also keyed by
  its slot, so a takeover cannot start a slot twice.
- Every due slot is an event in the `@xo/automation` engine (UW-15, ADR 0044), with the controls (modes, daily limit, pause, sign-off,
  certificates) as its policy layer: each slot fires **at most once**, also after a restart (the engine rebuilds its keys from its
  hash-chained ledger in `<data directory>/automation/schedules/ledger.jsonl`, which holds ids and counts, never inputs), and a slot
  accepted just before a crash is fired again on the next start. The engine's directory lock and the lease together keep a second
  process from firing.
- It does **not replay a run per missed slot**. After downtime, `XO_SCHEDULE_MISSED_SLOTS` decides (UW-15, ADR 0044): `run_latest` (default) runs only the most recent missed slot, if it ended within 24 hours, and the others are recorded as `skipped: missed`; `skip` runs none of them and the schedule resumes from now.
- Only one process fires schedules at a time: a lease in the data directory (`scheduler-lease.sqlite`). A second process on the same data directory waits and takes over if the first stops renewing. This covers processes on one machine sharing that directory; a network-shared directory or several machines need a distributed lease (the lease interface is in `@xo/automation`).
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
