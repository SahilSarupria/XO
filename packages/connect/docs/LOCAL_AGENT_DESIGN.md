# "Folder on this computer": deployment findings and decision (C7 item 4)

## What was verified

- The Studio desktop shell has **no bundled API**. It talks to a configured `XO_API_URL` (`src-tauri/src/lib.rs`, `desktop/main.tsx`). A hosted API therefore **cannot see a user's computer**.
- Before this change, the Connect routes would let an authorized user list paths on the **server's** disk and present that as "Folder on this computer". Platform grants still gated it, but the product claim was false for any hosted deployment.
- The local agent (`src/agent`) exposes `discover`, `acquire` and `cancel` over a local socket. It has no `sync`, and nothing in the API can reach a user's machine.

## What changed (built)

- Local-folder reading is an explicit host capability, **off by default** (`ConnectServiceOptions.localFolders`, `createConnectRuntime({localFolders})`, `ServerDeps.connectLocalFolders`).
- When off: the catalog marks the folder source `coming_soon` with "needs the XO desktop connection, which is not available in this deployment yet", and every folder operation is refused as `unavailable` before anything is listed or read. Capabilities, dashboard and knowledge keep working.

## Supported topologies today

| Topology                                                                                                                         | Works?                                 |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| API runs on the same machine as the folders (self-hosted single machine, development, an API sidecar started by the desktop app) | Yes, with `connectLocalFolders: true`  |
| Hosted API + desktop app on the user's computer                                                                                  | **No.** Needs one of the designs below |

## Designs for the hosted case (decision needed; none is built)

- **A. Local API sidecar.** The desktop app starts the API (with `connectLocalFolders`) on loopback next to the user's folders and Studio points at it. No new protocol. The hosted API is not involved in local data. Cheapest and the recommended first step for desktop.
- **B. Agent pushes evidence to the hosted API.** The agent runs on the user's machine, outbound-only, and uploads evidence batches. Needs: an agent identity and signed batches, a server ingestion endpoint that accepts evidence from an agent instead of from an in-process connector (the platform currently trusts connector output because it runs the connector), replay protection, per-batch authorization, and a `sync` operation in the agent protocol. This is a new trust boundary and should get its own security design and review.
- **C. API pulls through an agent-initiated tunnel.** Same trust problem as B plus long-lived connections. Not recommended.

Recommendation: A now, B when hosted deployments need local folders.
