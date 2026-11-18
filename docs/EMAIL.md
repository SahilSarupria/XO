# Sending email (UW-10)

One `message.send` contract, three tiers. See ADR 0041.

| Tier          | Hosts                          | Sends by                                | Checks what was sent                                                         |
| ------------- | ------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------- |
| 1 native      | Gmail, Microsoft 365 / Outlook | provider API with your sign-in          | only with a read capability (not granted today); otherwise a person confirms |
| 2 SMTP + IMAP | Yahoo, Zoho, many custom hosts | SMTP, then Sent-folder search over IMAP | yes: by Message-ID, three tries over two minutes                             |
| 3 send only   | SMTP-only hosts                | SMTP, paced at one send per 5 seconds   | never: a person confirms every uncertain send                                |

Every tier: XO sets the Message-ID from the idempotency key; the attachment's hash is bound at approval and re-checked at send;
recipients must come from a confirmed record or a workspace rule (default deny); nothing is ever re-sent automatically; a provider
"daily limit" stops the rest of the batch; "accepted" is not "delivered".

Limits (per connection): attachments 20 MB total, 400 sends a day, one send per second (tier 2) or per 5 seconds (tier 3). Graph refuses messages over 3 MB.

Code: `packages/connectors/src/mail/`. Tests use local fake servers: `packages/connectors/test/mail.test.ts`.
