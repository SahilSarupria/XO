# Runbooks (RX-1g)

Step-by-step operator guides for the situations the runtime specification names (section 21.11). Each one says what to check first, what to do, what never to do, and how to know you are done. They use the API and the `xo` CLI as they are today; Studio screens are named where they exist.

| Runbook                                           | Use it when                                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [Emergency stop](emergency-stop.md)               | Something must stop sending now: a workflow, a connector, one operation, or the whole instance. |
| [Incident](incident.md)                           | Something went wrong and people may be affected. Start here.                                    |
| [Provider outage](provider-outage.md)             | A provider (Gmail, Microsoft, a payment API) is down, failing or throttling.                    |
| [Credential revocation](credential-revocation.md) | An account must stop being used, or a provider revoked or expired a grant.                      |
| [Unknown side effect](unknown-side-effect.md)     | XO made a call and does not know whether it happened.                                           |
| [Recovery](recovery.md)                           | A process crashed, the machine restarted, or data must be restored from a backup.               |
| [Deletion](deletion.md)                           | Data must be removed: a connection, audit history past retention, or a whole instance.          |

Conventions used in every runbook:

```bash
B=https://xo.example.com          # the instance's public address
H="Authorization: Bearer $XO_KEY"  # an access key; approvals and stops need a recent sign-in (a session, not only a key)
WS=ws_…                            # the workspace
```

Two rules hold everywhere:

- **Never re-send to find out whether something happened.** An unknown outcome is settled by looking at the destination and recording what you found ([Unknown side effect](unknown-side-effect.md)).
- **Keep the evidence.** Export the run's audit bundle before changing anything you may need to explain later.
