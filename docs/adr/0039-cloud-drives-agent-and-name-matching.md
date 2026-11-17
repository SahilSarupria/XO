# 0039: Source connections from cloud drives and from a person's own computer, and matching files to people by name (UW-12a part 2)

## Status

Accepted under owner delegation, 2026-11-17 (UW-12a part 2, before wave W3). Signed off by Claude under the owner's delegation of
decision authority. This is a delegated sign-off, not an independent review.

## Context

ADR 0038 left three things out:

- **Cloud drives.** A firm's client workbook and certificate folder usually live in OneDrive, SharePoint or Google Drive, not on
  the instance's disk.
- **A folder on someone's own computer.** When XO runs on a server or in the cloud, it cannot open a folder on a person's laptop.
  ADR 0038 required the folder to be on the instance's machine.
- **Name matching.** `per_person_documents` needed every word of a person's name in a file's path. Real certificate folders use
  "Venky Iyengar.pdf", "V Iyengar.pdf", or a misspelt surname, so most of them did not match.

These had to fit the source-connection entity of ADR 0038 without a second sync path, and use UW-9 credentials without giving the
connect package a token.

## Decisions

1. **One reader port for every kind.**
   - **The port.** `SourceReader { list(): FolderListing; read(item): bytes }` in `@xo/connect`. `local_folder`,
     `microsoft_drive`, `google_drive` and `agent_folder` each provide one.
   - **One sync.** `syncConnection` takes the reader and does everything else (versions, retirement, discovery) exactly as before.
     A kind changes only how files are listed and read.
   - **Local folders are re-approved** against `XO_SOURCE_FOLDER_ROOTS` at every listing, as before.
2. **Cloud drives read through the UW-9 credential broker.**
   - **A capability, not a scope.** `files.read` maps to `drive.readonly` (Google) and `Files.Read.All` (Microsoft, delegated).
     `Files.Read.All` rather than `Files.Read`, because the folders people need are often shared with them, not owned by them.
   - **The token stays in the API.** `@xo/connect` gets a small injected `DriveHttp`; the API builds it on `broker.use`, so the token
     is revealed only into one request's header, sent through the pinned egress to `graph.microsoft.com` or `www.googleapis.com`.
   - **Microsoft's download addresses** are pre-authenticated and short-lived. XO fetches them without the token and only on Microsoft
     storage hosts, so a forged address can neither receive the token nor reach another host.
   - **What is not followed:** Google shortcuts and Graph `remoteItem`s (they point outside the chosen folder), trash, and native
     Google formats other than Docs and Sheets (which are exported to `.docx` and `.xlsx`).
   - **Provider ids are checked** before they are put into a URL or a Drive query, so an id cannot change the query.
3. **The agent: a push-only client on the person's computer (`xo.agent/1`).**
   - **Why push.** The agent only calls out, over https. Nothing on the computer or its network has to accept a connection, which is
     what makes it workable behind home routers and office firewalls.
   - **Pairing.** Creating an `agent_folder` connection answers a one-time code (16 characters from an alphabet without I, L and O;
     about 78 bits; 15 minutes; usable once, claimed by an atomic rename). `xo agent pair` exchanges it for a token
     `xoa.<workspace>.<connection>.<secret>` that belongs to that connection only. XO keeps only its SHA-256 and compares in constant
     time.
   - **The protocol.** Four public endpoints, authenticated by that token: `pair`, `manifest` (what to send, the limits, and the
     digests XO already holds), `blob` (one file, checked against its stated digest) and `snapshot` (the listing, then the ordinary
     sync over the staged bytes; staging is cleared afterwards).
   - **The computer decides what leaves it.** The agent lists with the same rules as a local folder, so hidden files, links and
     credential-looking names are counted there and never sent. XO still checks every name and digest it receives.
   - **Control stays with the workspace.** "Sync now" is a request the agent sees within a minute (202). Pairing again revokes the old
     token at once; retiring answers 410 and the agent stops. The scheduler never syncs an agent folder itself, and the agent's
     check-ins are recorded outside the connection's revisions, so polling does not make new revisions.
   - **The agent's own file** (`~/.xo/agent.json`) is written owner-only, and the agent refuses to start if anyone else can read it.
4. **Matching files to people in tiers.**
   - **The tiers, in order:** full name; name joined into one word; spelling (one letter off, or the same sound key); a short form (a
     table of common nicknames, or the first four letters or more); initials next to the surname.
   - **First tier wins.** A file is decided at the first tier that finds anyone, so a loose match never overrides an exact one.
   - **The surname is always required**, and a file that fits more than one person at its tier is ambiguous and matched to no one.
   - **Said, not hidden.** Counts by tier go into the proposal, and a proposal with loose matches says so and is not "strong" until
     confirmed.

## Alternatives considered

- **Sync cloud drives with provider SDKs.** Rejected: they would put the token inside `@xo/connect` and add a second HTTP path that
  bypasses the pinned egress.
- **Change notifications (Graph subscriptions, Drive changes API) instead of listing.** Deferred: they need a public webhook
  address and per-provider renewal. Listing on the existing schedule is simple and correct for folders of this size.
- **An agent the instance connects to, or a tunnel.** Rejected: it needs an inbound port or a relay on the person's network.
- **A long-lived agent API key.** Rejected: an API key acts as a person across the workspace. The agent's token can do four things
  for one connection, and pairing again replaces it.
- **Fuzzy matching by a model.** Rejected for now: discovery must be explainable and deterministic, and must never guess between two
  people.

## Consequences

- **Google production use needs the restricted-scope process** (verification and a yearly security assessment) for
  `drive.readonly`. Microsoft needs the `Files.Read.All` delegated permission on the app registration.
- **The agent syncs on a timer**, every 15 minutes or on request, and only while it runs. It does not watch the folder.
- **Staged bytes are bounded:** 50 MiB a file and 2 GiB waiting per connection, cleared after each snapshot.
- **Name matching is better but still rule-based.** A nickname not in the table matches only as the start of the first name.
- **Studio.** The discovery conversation and its proposal card work for every kind, because they show proposals, not folders.
  Studio has no screen yet to create a cloud or agent connection; that is left to the Studio work in later waves. The API and
  `xo agent` are complete.
