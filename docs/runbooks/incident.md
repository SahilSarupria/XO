# Runbook: incident

**Use when** something went wrong and people may be affected: wrong recipients, wrong attachments, duplicates, a run doing something nobody approved. Start here; it points to the others.

## 1. Contain (minutes)

1. **Stop the harm.** Engage the narrowest stop that is enough ([Emergency stop](emergency-stop.md)). When unsure, stop the connector that sends.
2. **Record the time and who decided.** The stop's `reason` is the first entry of the incident record.

## 2. Preserve evidence (before changing anything else)

For each affected run:

```bash
curl -s -H "$H" $B/workspaces/$WS/generated-workflows/$DEF/runs/$RUN/audit-bundle > bundle-$RUN.json   # audit role
curl -s -H "$H" -X POST $B/workspaces/$WS/audit-bundles/verify --data-binary @bundle-$RUN.json         # ok: true
curl -s -H "$H" $B/workspaces/$WS/generated-workflows/$DEF/runs/$RUN/manifest                          # what it was bound to
curl -s -H "$H" "$B/workspaces/$WS/audit/export" > audit-$WS.json                                        # the workspace audit log
```

The bundle is signed with the instance's approval key and holds each journal with its hash chain; anyone with the public key can check it offline. It contains message contents and recipients: store it as you store the data itself.

## 3. Establish what happened

- **What was approved:** a batch run's manifest names its `batch.approvalId` and `previewId`; `GET …/previews/{previewId}` shows exactly what the reviewer approved, item by item. Before each send XO compared the call to it; a mismatch was refused and audited as `generated-workflow.effect.denied`.
- **What was sent:** the run view's `effects` (one row per external call, in the vocabulary of `docs/EFFECTS.md`); `GET …/runs/{runId}/explain` says why each step did what it did.
- **What is uncertain:** `GET $B/workspaces/$WS/control/inbox` → `attention` lists every call whose outcome is unknown. Settle each with [Unknown side effect](unknown-side-effect.md).
- **Whether the record is faithful:** `GET …/runs/{runId}/replay` rebuilds the run from its journal under the pinned definition and packs; `reproducible: false` says what changed since.

## 4. Correct

- Corrections to recipients or content go through the normal path: a new preview, approved by a reviewer who did not prepare it. Never edit a journal, a manifest or a preview file.
- If an account may be compromised, follow [Credential revocation](credential-revocation.md).

## 5. Resume and close

1. Release the stop ([Emergency stop](emergency-stop.md), step 5).
2. Write the incident note: timeline (stop reason and times from the audit log), affected runs and items, evidence files with their bundle verification results, decisions recorded during reconciliation, the fix.

## Never

- Never re-send to check whether a send happened.
- Never delete audit history or run journals during an incident (retention purges wait until the incident is closed).
