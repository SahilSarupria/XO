# Runbook: deletion

**Use when** data must be removed: a person's connection, audit history past its retention, a conversation, or a whole instance. Deletion is permanent; take the evidence you are obliged to keep first.

## Before deleting anything

- Check no incident is open that may need the data ([Incident](incident.md)).
- Export what must be kept: the workspace audit log (`GET …/audit/export`) and the audit bundles of runs you must be able to prove (`GET …/runs/{runId}/audit-bundle`).

## A connection (account access)

`POST $B/workspaces/$WS/credentials/$CRED/revoke` destroys the stored secrets ([Credential revocation](credential-revocation.md)). Remove any binding that names it.

## A conversation

`DELETE $B/workspaces/$WS/intelligence/conversations/$CONVERSATION` (its owner).

## Audit history past retention

Nothing is deleted on its own. With `XO_API_AUDIT_RETENTION_DAYS` set, a principal with the instance `audit.purge` grant can purge a workspace's history older than that:

```bash
curl -s -H "$H" -X POST $B/audit/workspaces/$WS/purge -d '{"dryRun":true}'   # what would go
curl -s -H "$H" -X POST $B/audit/workspaces/$WS/purge -d '{}'
```

The purge leaves an `audit.purged` entry stating exactly what went; surviving entries are never rewritten (`docs/audit-operations.md`).

## A whole instance

```bash
xo instance backup --data /var/lib/xo --out final.tar.gz     # only if you must keep a copy
xo instance delete --data /var/lib/xo --confirm xoi_… --receipt deletion-receipt.json
```

It removes the data directory (workspaces, sources, runs, audit, access keys, sessions, connector tokens, encrypted secrets), the secrets key, the owner access key and the audit anchors; it refuses while the instance runs, checks every path is gone, and writes a receipt.

## Limits

- **A single workspace cannot be deleted through the API yet.** Workspaces with data that must go are handled by deleting the instance (after moving other workspaces' work elsewhere) or by an operator removing `<data>/<workspaceId>/` with the instance stopped, and recording that in the incident or request log.
- Removing files does not erase bytes the storage medium may keep, nor copies in backups and snapshots. Where that matters, keep the data on an encrypted volume and destroy the volume or its key too; delete the backups under the same request.
- Run journals and batch previews hold message contents and recipients: they go with the workspace or instance, not separately.
