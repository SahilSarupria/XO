# Sending email (UW-10)

One `message.send` contract, three tiers. See ADR 0041.

| Tier          | Hosts                          | Sends by                                | Checks what was sent                                                         |
| ------------- | ------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------- |
| 1 native      | Gmail, Microsoft 365 / Outlook | provider API with your sign-in          | only with the optional `mail.lookup` capability; otherwise a person confirms |
| 2 SMTP + IMAP | Yahoo, Zoho, many custom hosts | SMTP, then Sent-folder search over IMAP | yes: by Message-ID, three tries over two minutes                             |
| 3 send only   | SMTP-only hosts                | SMTP, paced at one send per 5 seconds   | never: a person confirms every uncertain send                                |

Every tier: XO sets the Message-ID from the idempotency key; the attachment's hash is bound at approval and re-checked at send;
recipients must come from a confirmed record or a workspace rule (default deny); nothing is ever re-sent automatically; a provider
"daily limit" stops the rest of the batch; "accepted" is not "delivered".

Limits (per connection): attachments 20 MB total, 400 sends a day, one send per second (tier 2) or per 5 seconds (tier 3). Graph refuses messages over 3 MB.

Code: `packages/connectors/src/mail/`. Tests use local fake servers: `packages/connectors/test/mail.test.ts`.

## Settings

`XO_EMAIL_MAX_ATTACHMENT_MB`, `XO_EMAIL_DAILY_CAP`, `XO_EMAIL_PACING_SMTP_IMAP_MS`, `XO_EMAIL_PACING_SEND_ONLY_MS` (see `docs/CONFIGURATION.md`).

## Connections

OAuth for Gmail and Microsoft (capability `message.send`); for other hosts an app password through `POST /workspaces/{ws}/credentials/basic`.
Readiness blocks a workflow whose bound connection is revoked, missing or not connected for `message.send`.

## In a workflow

Bind the declared send operation to adapter `email` (`PUT /workspaces/{ws}/connector-bindings`, with the connection's `credentialId`).
Inputs: `to`, `subject`, `body`, and optionally `attachmentSha256` (+ `attachmentFilename`, `attachmentContentType`), or the list form `to: [...]`, `attachments: [...]`.
Who may be emailed: people in confirmed contact lists, plus `PUT /workspaces/{ws}/email/recipient-rules` (manage role, recent sign-in).
Attachments are workspace sources, named by the SHA-256 of their bytes. App passwords: host `smtp.example.com:587|imap.example.com` for tier 2, `smtp.example.com:587` for tier 3.
Before a start, Studio's pre-start check says how each email connection sends (`emailTier` on `GET …/connector-bindings`: tier, whether it can look up a sent message, plain words).
