# Runbook: emergency stop

**Use when** something must stop sending now. A stop **holds** work: nothing new starts, a run in progress waits before its next step (a batch before its next item), a call already in flight finishes and is recorded. Releasing a stop lets held runs carry on; it does not undo anything.

## 1. Pick the narrowest stop that is enough

| Scope           | Holds                                                                 | Who                         | How                                              |
| --------------- | --------------------------------------------------------------------- | --------------------------- | ------------------------------------------------ |
| `capability`    | One operation of one connector (`mail.send`)                          | manage role, recent sign-in | Studio (Settings → Operations) or API, below     |
| `connector`     | Every call through one bound connector (`mail`)                       | manage role, recent sign-in | API, below                                       |
| `workflow`      | One workflow (`wfl_…`, every version) or generated workflow (`gwf_…`) | manage role, recent sign-in | API, below                                       |
| workspace pause | Every start and every call in the workspace                           | manage role                 | `POST $B/workspaces/$WS/workflow-controls/pause` |
| instance        | Every start and every call on the instance, in every workspace        | an operator on the machine  | `xo instance emergency-stop --reason "…"`        |

In Studio, **Settings → Operations** lists every stop in place, engages one (it asks first and says what it holds) and releases one (it says that runs which were refused are not restarted). The instance stop is shown there read-only.

The instance stop works even when the API is not answering: it is a file in the data directory, read by every process before each step and each call.

## 1a. Revoke standing approvals

An emergency stop holds work; it does not remove the authority a **standing approval** gives. If a standing approval should no longer
apply (wrong list, wrong person, a policy that is too wide), revoke it: no run starts under it, and a run started under it makes no
further call.

```bash
# list, then revoke (works with the API stopped; give the workspace id)
xo instance standing-approvals list --data /var/lib/xo --workspace $WS
xo instance standing-approvals revoke sap_… --data /var/lib/xo --workspace $WS --reason "wrong list"

# or over the API (a reviewer, the proposer or the approver)
curl -s -H "$H" -X POST $B/workspaces/$WS/standing-approvals/$SAP/revoke -d '{"reason":"wrong list"}'
```

Runs that already started and finished are not undone. Slots that would have started under it fall back to a batch preview in the Inbox.

## 2. Engage it

```bash
# a connector, one operation, or a workflow
curl -s -H "$H" -X POST $B/workspaces/$WS/emergency-stops \
  -d '{"scope":"connector","target":"mail","reason":"duplicate sends reported by a client"}'

# the whole instance (on the machine, as the user that runs XO)
xo instance emergency-stop --data /var/lib/xo --reason "incident 2026-11-23-01"
```

A target that does not exist is refused (404): a stop on a misspelt name would hold nothing. A start that a stop covers is refused with 412 and reason `emergency_stop`.

## 3. Confirm it holds

```bash
curl -s -H "$H" $B/workspaces/$WS/emergency-stops            # instance, workspacePaused, stops
curl -s -H "$H" $B/workspaces/$WS/generated-workflows/$DEF/runs/$RUN   # "held": "the emergency stop on connector \"mail\" is engaged"
xo instance emergency-stop --data /var/lib/xo --status
```

The audit log has `emergency-stop.engaged` (and `emergency-stop.refused` for each start it held).

## 4. While it is engaged

- Work through the cause ([Incident](incident.md), [Provider outage](provider-outage.md)).
- Calls that were in flight when you engaged it may have an unknown outcome: check the Inbox in Studio ("Check what happened") or `GET $B/workspaces/$WS/control/inbox` (`attention`), and follow [Unknown side effect](unknown-side-effect.md).
- To end a held batch instead of letting it resume, cancel it: `POST …/runs/{runId}/cancel` (or "Cancel the batch" in the Inbox).
- A held run still ages toward its run timeout.

## 5. Release it

```bash
curl -s -H "$H" -X POST $B/workspaces/$WS/emergency-stops/release -d '{"scope":"connector","target":"mail"}'
xo instance emergency-stop --data /var/lib/xo --release
```

Held runs carry on at the next minute tick, or when someone reads them. Each item still acts once, under its own key.

## Never

- Never delete the stop file or `emergency-stops.json` by hand to release a stop: use the commands above, so it is audited.
- If `emergency-stops.json` cannot be read, everything in the workspace stays stopped and the API refuses to overwrite it. Repair the JSON (or restore it from the backup) deliberately; do not remove it to make the error go away.

## Done when

The cause is fixed, the stop is released, held runs completed or were cancelled, and every unknown outcome is reconciled.
