# Runbook: credential revocation

**Use when** an account must stop being used (a person left, a token may have leaked, a client asked) or a provider revoked or expired a grant.

## Revoke a connection

```bash
curl -s -H "$H" $B/workspaces/$WS/credentials                       # find the credential id
curl -s -H "$H" -X POST $B/workspaces/$WS/credentials/$CRED/revoke   # manage role
```

Revoking always destroys the stored secrets and stops every use immediately; the next call through it is refused before anything is sent.

- **Google:** the grant is revoked at the provider too.
- **Microsoft:** offers no revocation endpoint to an app (the response says `not_available`). Also remove the app at `myaccount.microsoft.com`, or for an organization in Entra admin.

## What happens to work using it

- **New starts:** the readiness certificate blocks an inactive credential, so the start is refused until a binding names an active one.
- **Runs in progress:** each call is authorized again when it is made; a call through the revoked connection is refused (`generated-workflow.effect.denied`) and nothing is sent.
- **A batch approval:** it binds the sending account. Changing the binding to another account makes the approved preview no longer match: the start is refused and a new preview must be approved.

If a leak is suspected, engage a connector stop first ([Emergency stop](emergency-stop.md)) so nothing is attempted while you work.

## A provider revoked or expired the grant

If the provider refuses a refresh (`invalid_grant`), the credential becomes `expired` with the reason recorded and is not used again. Reconnect:

```bash
curl -s -H "$H" -X POST $B/workspaces/$WS/credentials/oauth -d '{"provider":"google","capabilities":["message.send"]}'
# the person finishes consent at the provider, then:
curl -s -H "$H" -X PUT $B/workspaces/$WS/connector-bindings -d '…the binding with the new credentialId…'
```

Then certify the workflow again (`POST …/readiness`). A new binding is a new sending account: a batch approved before must be prepared and approved again.

## Done when

The credential is `revoked` (or replaced), no binding names it, the provider side is cleaned up, and any call refused while it was revoked is either re-planned or confirmed unnecessary.
