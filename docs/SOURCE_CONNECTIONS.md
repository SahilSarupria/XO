# Source connections (UW-12a)

A source connection keeps a workspace in step with a folder of files: the client workbook, the folder of certificates. XO reads the
folder, stores each file as a workspace source, keeps it current, retires what changes or disappears, and says what it thinks
each thing is. Then it asks what you would like to do. Decided in [ADR 0038](adr/0038-source-connections.md).

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

**In Studio:**

- **Starting it.** "What did XO find?" in Chat opens this conversation.
- **Deciding.** Each proposal has "Yes, that's right" and "No".
- **Where the choice goes.** It goes to the source-connection API, not through the conversation.

`GET /workspaces/{ws}/discovery` returns the same proposals and message without starting a conversation.

## Retire a connection (manage role, recent sign-in)

`POST …/source-connections/{id}/retire` stops syncing and retires every version the connection holds. The folder is untouched and
can be connected again.

## Not yet

- **Cloud drives.** OneDrive, SharePoint and Google Drive will come through the same reader port, using the UW-9 credential broker
  with read scopes.
- **A folder on your own computer when XO runs elsewhere.** This needs the local agent, which is not built.
- **Discovery is rule-based.** Lists without an email column are "tables". Per-person matching needs every word of the name in the
  file's path, so nicknames and initials do not match.
