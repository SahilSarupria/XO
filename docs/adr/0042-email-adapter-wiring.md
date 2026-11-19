# 0042: Wiring email into workflow runs (UW-10c)

## Status

Accepted under owner delegation, 2026-11-18 (UW-10c, wave W3). Signed off by Claude under the owner's delegation of decision
authority. This is a delegated sign-off, not an independent review. Completes the part ADR 0041 left open.

## Context

ADR 0041 built the connectors but no workflow run reached them. The instance's `connectorAdapters` map holds adapters that receive
a credential per call and know nothing about a workspace; a send needs that workspace's recipient rules, confirmed contact lists and
attachments. The run-input route also accepts only scalar values (string, number, boolean), found when the first end-to-end test sent an array.

## Decisions

1. **Per-workspace adapter factories.** `preExecution.adapterFactories` (additive) maps an adapter id to a function of the workspace.
   `adapterFor` consults `connectorAdapters` first, then the factories; `installedAdapterIds` makes every "is this adapter installed"
   check (inventory, approval, bindings listing, run) see both. The default server registers the `email` factory.
2. **The `email` adapter** (`apps/api/src/email/mail-adapter.ts`) carries out `send` and `find_sent`, builds the connector from the bound
   connection on each call (Google OAuth: Gmail; Microsoft OAuth: Graph; `basic`: SMTP), and maps results to the effect states: a connector
   error with effect `none` is `confirmed_failure_no_effect`; every other failure is `outcome_unknown`. **A failed `find_sent` is always
   `outcome_unknown`**, and so is any unexpected error after the operation started. Approval mode is `payload` (a person approves the exact
   recipient, subject and attachment hashes); how a 300-recipient batch is approved at once is UW-8's design.
3. **Tier from the connection.** An OAuth sign-in is tier 1; its lookup (`find_sent`) exists only if the connection's granted scopes include a
   read scope (`gmail.readonly`/`gmail.modify`/`Mail.Read...`), which the broker does not request today (ADR 0041 item 6). An app password
   (`basic`) is tier 2 when its host is `smtp-host[:port]|imap-host[:port]` and tier 3 with no IMAP part (SMTP port 465 is implicit TLS, otherwise
   STARTTLS; IMAP defaults to 993 TLS). The host-string convention avoids changing the UW-9 credential record; a dedicated IMAP field is a UW-9 change.
4. **Recipient policy = confirmed contacts + explicit rules.** Allowed: an address in a **confirmed** `contact_list` table whose source is
   unchanged since it was confirmed (a changed table must be confirmed again), or an address or domain in the workspace's recipient rules
   (`GET/PUT /workspaces/{ws}/email/recipient-rules`; manage role, recent sign-in, revision-guarded; audited as
   `email.recipient-rules.updated` with counts only). Default deny. A UW-5 `Resolved` result counts through the list its recipient row
   belongs to; UW-5 claims hold refs, not addresses, so they are not read here. Never from model output.
5. **Attachments** are workspace sources found by the SHA-256 of their stored bytes (`workspaceAttachmentStore`); retired sources are not found.
   The connector re-hashes at send (ADR 0041).
6. **Contract: a flat scalar form** (`to` as a string, `attachmentSha256`, `attachmentFilename`, `attachmentContentType`) is accepted beside the list
   form, because typed workflow run inputs are scalars. One recipient and one attachment per send is the per-recipient case.
7. **Provider guess route:** `GET /workspaces/{ws}/email/provider-guess?address=` (read) returns tier and plain-words text, for the pre-start
   preview and connection screens to show. No Studio screen was built (owner: preview text only, still open).

## Consequences

- Verified end to end only against a local fake Gmail: a certificate-gated generated workflow sends an email with an attachment, with the
  derived Message-ID, and a stranger is refused with nothing sent (`apps/api/test/email-send-run.test.ts`). The e2e test injects the
  credential handle (no OAuth); SMTP/IMAP and Graph are covered at connector level, and the adapter's basic-connection path only for its refusal.
- An SMTP host that needs STARTTLS or TLS cannot be exercised against the plain-text fake; those paths are untested against a real server.
- Recipient resolution reads and parses the contact list's stored bytes on every send (bounded by the source size). Adequate for one run at a time; cache before scaling.

## Reopen if

- A real mailbox shows STARTTLS, auth or Sent-folder differences (the adapter's host convention may need an explicit field).
- Batch approval (UW-8) needs `definition` mode for recipients drawn from a confirmed list.
- The owner grants a read-mail capability: `find_sent` then works for tier 1 with no code change here.
