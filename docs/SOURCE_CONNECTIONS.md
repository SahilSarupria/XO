# Source connections (UW-12a)

A source connection keeps a workspace in step with a folder of files: the client workbook, the folder of certificates. XO reads the
folder, stores each file as a workspace source, keeps it current, retires what changes or disappears, and says what it thinks
each thing is. Then it asks what you would like to do. Decided in [ADR 0038](adr/0038-source-connections.md); cloud drives, the
agent and name matching in [ADR 0039](adr/0039-cloud-drives-agent-and-name-matching.md).

**Where the folder can be:**

| Kind              | The folder is                                            | XO reads it through                                         |
| ----------------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| `local_folder`    | On the instance's own machine                            | The file system, inside `XO_SOURCE_FOLDER_ROOTS`            |
| `microsoft_drive` | In OneDrive or SharePoint                                | Microsoft Graph, with a workspace credential (`files.read`) |
| `google_drive`    | In Google Drive (My Drive or a shared drive)             | The Drive API, with a workspace credential (`files.read`)   |
| `agent_folder`    | On a person's own computer, while XO runs somewhere else | The XO agent on that computer, which sends it to XO         |

Every kind is synced, retired, discovered and decided the same way. Only how the files are listed and read differs.

## Set up (operator)

Choose the folders on the instance's machine that workspaces may connect, and list them:

```bash
XO_SOURCE_FOLDER_ROOTS=/srv/xo/shared,/home/office/Documents/XO
```

- **Inside a listed folder.** A connected folder must be inside one of these, judged by its real path, so a link inside them that
  points elsewhere is refused.
- **Checked every time.** The check is repeated at every sync: narrowing the setting stops connections outside it.
- **Unset.** No folder can be connected.
- **Read-only.** Connections only read. Nothing in a folder is ever written, moved or deleted.

## Connect a folder (manage role, recent sign-in)

```http
POST /workspaces/{ws}/source-connections
{ "kind": "local_folder", "root": "/srv/xo/shared/Renewals", "sync": { "mode": "interval", "everyMinutes": 60 } }
```

**The folder is synced at once.** Every file in a format the workspace reads (PDF, Word, workbook, CSV, email, text, images) is
stored as a workspace source:

- through the same checks as an upload;
- with origin `connection`.

**Never read, only counted:**

- links, which are never followed;
- hidden files and Office lock files;
- files whose names look like credentials (`.env`, keys, `credentials.*`);
- hard-linked files;
- files over 50 MiB.

**Shown, never returned:** the connection shows the folder's last segment ("Renewals"), never its path.

## Connect OneDrive, SharePoint or Google Drive (manage role, recent sign-in)

1. **Connect the account** with the `files.read` capability (docs/CREDENTIALS.md):
   `POST /workspaces/{ws}/credentials/oauth { "provider": "google", "capabilities": ["files.read"] }`. The person consents to
   read-only access.
2. **Choose the folder.** `GET …/source-connections/drive-folders?provider=google&credentialId=crd_…` lists the drives, then
   `&parent=<ref>` the folders inside one. Folders only.
3. **Connect it:** `POST …/source-connections { "kind": "google_drive", "credentialId": "crd_…", "folder": "<ref>" }`, or
   `microsoft_drive`.

**How XO reads a drive:**

- **Through the broker.** Every request is a credential-broker `use`: the token goes into that request's header and nowhere else,
  through the pinned egress to the provider's own hosts (`graph.microsoft.com`, `www.googleapis.com`). It never appears in a
  listing, a record, an audit line or a URL.
- **Microsoft downloads.** Graph gives each file a short-lived, pre-authenticated download address. XO fetches it **without** the
  token, and only if it is on Microsoft storage (`*.sharepoint.com`, `*.1drv.com`, `*.files.1drv.com`).
- **Google Docs and Sheets** are exported as Word and Excel files (the export is limited to 10 MB). Slides, Forms and other Google
  formats are counted as `native_not_exportable`.
- **Shortcuts are not followed.** Google shortcuts and OneDrive "shared with me" items point at files outside the chosen folder, so
  they are counted (`shortcut_not_followed`) and never read.
- **Trash is left out.** Google lists trashed files unless asked not to; XO asks not to.
- **The same exclusions as a local folder:** hidden files, credential-looking names, files over 50 MiB.
- **A credential that stops working** (revoked, expired, or refused by the provider) makes the next sync fail with
  `credential_unusable`, and the connection shows `needs_attention` until someone reconnects the account.

## Connect a folder on someone's own computer (manage role, recent sign-in)

When XO runs on a server or in the cloud, it cannot open a folder on a person's laptop. The XO agent runs on that computer and sends
the folder to XO. It only ever calls out to XO, so nothing needs to be opened on the computer or its network.

1. **Create the connection:** `POST …/source-connections { "kind": "agent_folder" }`. The answer has a one-time pairing code and
   the command to run on the computer:

   ```bash
   xo agent pair --server https://xo.example.com --code ABCD-EFGH-JKMN-PQRS --folder ~/Documents/Renewals
   xo agent install
   ```

   The address is `XO_PUBLIC_BASE_URL`; set it on the instance so Studio and the API fill it in.

2. **The code works once and for 15 minutes.** Pairing exchanges it for a token that belongs to this one connection. The agent saves
   it in `~/.xo/agent.json`, readable by its owner only, and refuses to start if anyone else can read it.
3. **It starts by itself.** `xo agent install` starts the agent now and at every sign-in, without administrator rights:

   | Computer | How                                                                                                        | Its log                         |
   | -------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------- |
   | macOS    | A LaunchAgent (`~/Library/LaunchAgents/com.xo.agent.plist`), loaded with `launchctl bootstrap gui/<uid>`   | `~/.xo/agent.log`               |
   | Linux    | A systemd user unit (`~/.config/systemd/user/xo-agent.service`), `systemctl --user enable --now`           | `journalctl --user -u xo-agent` |
   | Windows  | A hidden script in the person's Startup folder (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`) | `~/.xo/agent.log`               |

   All three restart it after a crash. On Linux it also starts at boot, before anyone signs in (`loginctl enable-linger`, where
   the system allows it); on macOS and Windows it needs the person signed in. `xo agent uninstall` removes it, and
   `xo agent run` runs it in a terminal instead.

4. **It sends changes as they happen.** The agent watches the folder and syncs a few seconds after something changes (once the
   folder has been quiet for 5 seconds, at most every 15 seconds). It also syncs every 15 minutes, which covers anything a watch can
   miss (a network drive, changes made while the computer slept), and within a minute when someone presses "Sync now" in XO (which
   answers 202: the agent does the sync). Changes to hidden files and Office lock files do not wake it.
5. **It rides out a lost connection.** When XO cannot be reached, the agent waits and tries again, longer each time, up to 15
   minutes. It stops only when the connection is retired, the agent is paired again elsewhere, or the folder is gone; run as a
   service, that is a clean stop, so it is not restarted. `xo agent status` shows what it last did, and one agent runs per
   configuration.

**What the agent sends:** it lists the folder on the computer with the same rules as a local folder, so hidden files, links and
credential-looking names are counted there and never leave the computer. It works out each file's SHA-256, uploads only the files XO
does not already hold, then sends the listing. XO checks every uploaded file against its digest, checks every name in the listing
(no `..`, no absolute paths, no hidden segments, supported formats only), and syncs exactly as for any other folder.

**Revoking an agent:**

- **Pair again:** `POST …/source-connections/{id}/agent/pair` makes a new code; the old agent's token stops working at once.
- **Retire** the connection: the agent is told (410) and stops.

**The agent protocol (`xo.agent/1`)** uses four public endpoints, each authenticated by the agent's own token, not an API key:
`POST /agent/v1/pair`, `GET /agent/v1/manifest`, `PUT /agent/v1/blob` (header `x-xo-digest`) and `POST /agent/v1/snapshot`. The
agent accepts only an `https` address for XO (plain `http` only to the same computer).

## Keeping it current

- **Sync now:** `POST …/source-connections/{id}/sync` (author role).
- **On a schedule:** `PUT …/schedule` with `{ "mode": "interval", "everyMinutes": 15…10080 }`. The scheduler runs it.
- **Pause and resume:** `POST …/pause` and `POST …/resume`.

**What a sync does:**

| In the folder                                                   | In the workspace                                                           |
| --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| A new file                                                      | A new source                                                               |
| A file whose bytes changed                                      | A new source version; the old version is retired (`changed`, `replacedBy`) |
| A file that is gone                                             | Its version is retired (`removed`)                                         |
| A file the door refuses (for example, a `.pdf` that holds HTML) | Counted (`refused_at_door`); the version already held stays current        |
| More files than the limits                                      | The sync is partial and says so; nothing is retired for being absent       |

**Retired versions keep their bytes and records.** Knowledge that cites a retired version no longer feeds execution: its evidence
resolves as `source_retired`, so readiness holds the workflow for review until the knowledge is re-approved against the current
file.

**Freshness:**

| State             | Meaning                                               |
| ----------------- | ----------------------------------------------------- |
| `never_synced`    | Not synced yet                                        |
| `current`         | Up to date                                            |
| `stale`           | Two scheduled syncs overdue                           |
| `needs_attention` | The last sync failed, or some files could not be read |
| `paused`          | Syncing is paused                                     |
| `retired`         | The connection is retired                             |

## What XO thinks your files are

After each sync XO proposes roles. Nothing is decided for you, and no model is asked.

| Role                   | When                                                           | Example                                     |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| `contact_list`         | A table with a name column and an email column                 | "a client list"                             |
| `record_table`         | Any other table                                                | "a table of 42 records"                     |
| `document_collection`  | A folder of several documents                                  | "a folder of certificates"                  |
| `per_person_documents` | A contact list whose names appear in a collection's file names | "each client's certificate: 38 of 40 match" |

**How a file is matched to a person.** XO tries these in order and stops at the first that finds anyone:

| Match      | "Venkatesh Iyengar" matches                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------- |
| Full name  | `Venkatesh Iyengar.pdf`, `iyengar_venkatesh.pdf`, `VenkateshIyengar.pdf`                        |
| Joined     | `venkateshiyengar.pdf`                                                                          |
| Spelling   | `Venkatesh Iyenger.pdf` (one letter off, or sounds the same)                                    |
| Short form | `Venky Iyengar.pdf`, `Venkat Iyengar.pdf` (a known nickname, or the first four letters or more) |
| Initials   | `V Iyengar.pdf`, `V.Iyengar.pdf`, `VIyengar.pdf` (initials next to the surname)                 |

- **The surname is always needed.** A first name or initials alone never match.
- **Never guessed.** A file that fits two people equally ("A Rao" with Asha Rao and Arun Rao) is counted as ambiguous and matched to
  no one.
- **Titles are ignored:** Mr, Mrs, Dr, Shri, Smt and the like.
- **Loose matches are said.** The proposal says how many matched only by spelling, short form or initials ("worth a look"), and
  such a proposal is not "strong" until someone confirms it.

**What a proposal shows:**

- what it rests on: the columns, counts and matches;
- a strength.

**To decide:** confirm or reject a proposal with `POST …/proposals/{proposalId}/decision` and `{ "decision": "confirmed" | "rejected" }`
(author role).

**After a decision:**

- **It stands across syncs**, while the role still points at the same file.
- **It is flagged** `changedSinceDecision` when that file changes.

A confirmed role tells XO what to use ("this table is the client list"). It is not business knowledge, so it does not go into the
knowledge base.

## The conversation

`POST /workspaces/{ws}/discovery/conversation` opens a conversation of yours that starts with what XO found:

> I found a spreadsheet (clients.csv) and a folder of certificates (40). clients.csv looks like a client list (42 rows, each a
> client). Is that right? 38 of 40 certificates are named after one client in the client list (column "Client name"), so these
> look like each client's certificate. Is that right? What would you like to do?

The message names files and folders you connected, never a cell value.

**In Studio**, Connect lists the workspace's folders and drives with their freshness, and connects new ones:

- **A folder on a computer.** "Connect a computer's folder" shows the pairing code and the two commands to run on that computer,
  with the address filled in, and carries on by itself once the agent pairs.
- **A drive.** "Connect Google Drive" (or OneDrive or SharePoint) connects an account with read-only access, in the person's browser,
  then lets them browse the drive and connect one folder.
- **A folder on the XO server**, where the instance allows one.
- **For each connection:** sync now, pause or resume, how often it syncs, a new pairing code, retire (asked first), the last sync in
  counts, the files, and what XO thinks they are, with "Yes, that's right" and "No".

Only what the instance can do is offered: `GET …/source-connections/options` says whether local folders, each drive, and the agent
are available, and the address an agent uses.

**In Chat:**

- **Starting it.** "What did XO find?" in Chat opens this conversation.
- **Deciding.** Each proposal has "Yes, that's right" and "No".
- **Where the choice goes.** It goes to the source-connection API, not through the conversation.

`GET /workspaces/{ws}/discovery` returns the same proposals and message without starting a conversation.

## Retire a connection (manage role, recent sign-in)

`POST …/source-connections/{id}/retire` stops syncing and retires every version the connection holds. The folder is untouched and
can be connected again.

## Not yet

- **Discovery is rule-based.** Lists without an email column are "tables". Name matching knows a fixed list of common short forms
  (mostly English and Indian names); a nickname it does not know matches only if it is the start of the name.
- **The agent needs the computer on** (and, on macOS and Windows, someone signed in). Changes made meanwhile are sent when it next
  runs.
- **Native Google formats other than Docs and Sheets** are not read, and Docs or Sheets over the 10 MB export limit fail.

## Provider facts and where they come from

Checked on 2026-11-17:

- **Microsoft Graph, listing:** `GET /drives/{drive-id}/items/{item-id}/children`, paged with `@odata.nextLink`. `Files.Read.All`
  (delegated) reads every file the signed-in person can open, including files shared with them; `Files.Read` covers only their own.
  Source: Microsoft Learn, "List the contents of a folder" and "Microsoft Graph permissions reference".
- **Microsoft Graph, download:** `@microsoft.graph.downloadUrl` is pre-authenticated, needs no Authorization header and is
  short-lived (about an hour). Source: Microsoft Learn, "driveItem resource type" and "Download the contents of a driveItem".
- **Google Drive, listing:** `files.list` returns trashed files unless the query says `trashed = false`; shared drives need
  `supportsAllDrives` and `includeItemsFromAllDrives`. Source: Google, "Search for files and folders".
- **Google Drive, download:** `alt=media` works only for files stored in Drive; Docs, Sheets and Slides need `files.export`, limited
  to 10 MB. Source: Google, "Download and export files".
- **Google Drive, scope:** `drive.readonly` is a _restricted_ scope. An app using it in production needs Google's verification and a
  yearly security assessment. Source: Google, "Choose Google Drive API scopes".
