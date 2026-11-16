# 0018: Email is provider-independent: one `message.send` contract, three connector tiers (D-I)

## Status

Accepted under owner delegation, 2026-11-13 (UW-0). Signed off 2026-11-13 by Claude under the owner's explicit delegation of sign-off authority (owner instruction of 2026-11-13); this is a delegated sign-off, not an independent review. Implemented by UW-9 and UW-10. Provider facts are
unverified until UW-9 checks them against provider documentation.

## Context

The only email code is `@xo/connectors` `smtp.ts`: `AUTH PLAIN` only, at most five recipients by default, a mandatory non-empty
recipient-domain allowlist, no attachments, tested only against a fake server (`docs/baseline/UW0_BASELINE.md` §7 row 31). The first
pilot client's mail platform is unknown, and the owner wants email to work with every provider (Revision 4, §0 and §6).

## Decision

1. **Workflows know one capability**: `message.send` (recipients, subject, body, attachments by content hash, effect class). Providers
   sit behind it as adapters (ADR 0015).
2. **Three tiers**, chosen per sender and shown in the batch preview. **Tier 1 through the user's own mailbox with OAuth is the
   default and the product's primary path** (owner's master context §10.3: a multi-tenant OAuth app registered by XO, one-click Gmail
   or Outlook connection, server-side code exchange and token refresh, native Gmail API or Microsoft Graph preferred, no app-password-
   first setup and no central sending service for the first vertical). Tiers 2 and 3 exist so that every other mailbox still works,
   and are offered only when the provider has no supported OAuth path:
   - Tier 1, native API (Gmail API, Microsoft Graph): OAuth; reconcile by looking up the Message-ID before any resend decision.
   - Tier 2, standard protocols (any SMTP + IMAP mailbox): SMTP submission with XOAUTH2 where supported, otherwise an app password;
     XO sets its own Message-ID; reconcile by searching the Sent folder over IMAP; if IMAP is unavailable the item stays
     `outcome_unknown` for a person.
   - Tier 3, send-only SMTP: no lookup; any unknown outcome blocks that item until a person confirms; conservative pacing.
   - Optional: transactional APIs (SES, SendGrid, Mailgun and similar) from a verified domain.
3. **Rules in every tier:** the attachment hash is bound at approval and re-verified at send; one dispatch per key; no blind resend;
   accepted is not delivered; tokens never appear in prompts or logs. A recipient policy replaces the domain allowlist.
4. **Onboarding:** guess the provider from the domain (known-provider table, then DNS and published auto-configuration, then a manual
   form), pick the best available tier, say in plain words what is supported.
5. **A second tier is built early** to prove the contract is genuinely generic (UAC-32).

## Reopen if

A target provider supports none of the three tiers.
