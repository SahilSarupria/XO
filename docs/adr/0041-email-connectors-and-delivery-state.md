# 0041: Email provider connectors and delivery state (UW-10, part a)

## Status

Accepted under owner delegation, 2026-11-18 (UW-10 part a, wave W3). Signed off by Claude under the owner's delegation of
decision authority. This is a delegated sign-off, not an independent review.

Part a covers the connector contract, tier 2 (SMTP + IMAP), tier 1 Gmail and Microsoft Graph, tier 3 (send only), the recipient
policy, limits, and provider guessing. Part b covers the settings registry entries, the app-password credential, and the readiness
credential check (see "Part b decisions"). The adapter wiring and the Studio preview text are still open (see "Not built yet").

## Context

What existed: `smtp.ts` in `@xo/connectors` (AUTH PLAIN, no attachments, a default 5-recipient cap, a non-empty domain allowlist,
a Message-ID at `@xo.invalid`, tested only against a fake server) and a test-double adapter. The IR connector host already has the
effect machinery: per-operation idempotency attestations `supports_key`, `supports_lookup` (a declared read operation whose
result is checked with `foundWhen`) and `none`, and `ConnectorError.effect = 'none'` for "failed before anything reached the
destination". The UW-9 broker already maps the `message.send` capability to `gmail.send` and Microsoft `Mail.Send`.

## Decisions

1. **One contract, in `@xo/connectors` (`src/mail/`).** `send` (write): `{ to, subject, body, attachments: [{ filename,
contentType, sha256 }] }`. `find_sent` (read): `{ key }`. `packages/capability-contract` is **not changed**: the effect class
   of a capability is derived from the operator's binding (`write`), per ADR 0033. Tiers differ only in which operations exist.
2. **Message-ID.** Every tier sets it: `<xo.{sha256(key) first 32 hex}@{sender domain}>`. The same idempotency key always gives
   the same Message-ID, so a lookup can find an earlier attempt.
3. **Lookup answers only "found".** `find_sent` returns `{ found: true }` or **throws** after its retries (three tries; delays
   60 s and 60 s). The engine treats an error from a lookup as unknown. A miss caused by lag, or by a missing read capability,
   must never read as "not sent": that would resend. A genuine never-sent message therefore stays unknown for a person (UAC-33).
4. **Tier 2:** SMTP submission (AUTH XOAUTH2 when a token is given, else AUTH PLAIN with an app password) plus a minimal
   built-in IMAP client: find the Sent folder (`\Sent`, then common names), `EXAMINE` read-only, `UID SEARCH HEADER Message-ID`.
   No `nodemailer`/`imapflow` dependency was added: MIME building and the two protocols are small, and extending `smtp.ts` was the
   handoff's stated alternative; no new licence or supply-chain surface. Credentials travel only after TLS; IMAP allows plain text to loopback only.
5. **Tier 1 Gmail:** `users.messages.send` with base64url `raw` (our own MIME, so we control the Message-ID); messages over 4 MB use
   the media upload endpoint (`message/rfc822`). **Tier 1 Graph:** `POST /me/sendMail` with a base64 MIME body; a message over
   3 MB is **refused** (the draft + upload-session flow is not built, and it does not obviously keep our Message-ID).
6. **Tier 1 lookup needs a read capability** (amended 2026-11-22 under the owner's delegation). `gmail.send` and `Mail.Send` cannot
   search the mailbox, so the broker has a separate, optional capability **`mail.lookup`**: Google `gmail.readonly` (the `q` search
   used for `rfc822msgid:` is not allowed with `gmail.metadata`, so nothing narrower can search; Google classes it as restricted) and
   Microsoft delegated `Mail.ReadBasic` (least privileged for listing messages; no body, preview or attachments). Both were checked
   against the provider references on 2026-11-22. The connectors expose `find_sent` only when the connection was granted every
   `mail.lookup` scope; **a tier 1 connection without it behaves like tier 3** (an unknown outcome waits for a person), and the
   tier text already says so. A person adds it by connecting with `capabilities: ["message.send", "mail.lookup"]`.
7. **Tier 3** is tier 2 without `find_sent`; pacing is slower (see limits).
8. **Effects.** Failures before the message body is sent are `effect: 'none'` (connect, greeting, auth, RCPT, DATA refusal, refused
   recipient, failed attachment check, provider 4xx, provider limit). A lost connection after the body is sent, a provider 5xx
   and a timeout are unknown (no flag). A definite reply after the body (4xx/5xx) is `none`. There is no retry anywhere in a connector.
9. **Attachments.** Bound by sha256 at approval; re-read and re-hashed at send; a missing file, different bytes or an oversize total
   refuses the send with `effect: 'none'` before anything leaves. Total limit 20 MB by default (`maxAttachmentBytes`).
10. **Recipient policy (replaces the domain allowlist).** Default deny. Allowed: an address in `confirmed` (a confirmed
    `contact_list` role or a UW-5 `Resolved` result) or an explicit workspace rule (address or domain) set by the manage role.
    Never from model output (no code path adds to either set from a model).
11. **Limits.** `SendGovernor` per connection: pacing (tier 2: 1 s; tier 3: 5 s) and a daily cap (default 400, UTC day). A
    provider limit response (Gmail 429 / `rateLimitExceeded`, Graph 429) makes the connection refuse every later send that day
    **untried** (`effect: 'none'`) and is never retried. In memory per connector instance (see limits).
12. **Delivery projection.** Output carries `delivery: { status: 'accepted', basis, delivered: 'not_confirmed', bounces:
'not_tracked' }`. Accepted is not delivered. Bounce data is recorded only where a provider offers it; none is wired in part a.
13. **Provider guess.** `guessProvider`: known-provider table, then MX lookup, else manual host form; returns the tier and a
    plain-words explanation for the preview. ISPDB/autodiscover are deferred. The optional transactional-API tier is later work.

## Provider facts checked (2026-11-18, web search; official pages were not all retrievable)

- Gmail `users.messages.send` takes a base64url RFC 2822 `raw`; the maximum message is 35 MB; larger-than-5 MB messages should use
  the `/upload/...` endpoint with `message/rfc822` (seen in secondary sources quoting the Google reference; the reference page itself could not be fetched).
- Gmail search supports `rfc822msgid:` (Google Help, "Refine searches in Gmail", read). Searching needs a read scope.
- **Conflicting reports** on whether Gmail keeps a caller-supplied Message-ID: one practitioner write-up says it is preserved and
  searchable; another (EmailEngine docs) says that with send-only scope the Message-ID may be modified. **Unverified.** The tier 1
  lookup therefore may not find a message even when it was sent, which is safe (it stays unknown) but means tier 1 lookup is unproven.
- Microsoft Graph `sendMail` returns 202 Accepted with no body, accepted not delivered, supports a MIME body (base64) and JSON with
  inline attachments under about 3 MB (larger needs a draft + upload session). `Mail.Send` is the least-privileged permission.
  Whether Exchange keeps a caller-supplied Message-ID in MIME mode is **unverified**.
- One source (2026-11-07) says SMTP basic authentication in Exchange Online is planned to be disabled by default at the end of
  December 2026: relevant to tier 2/3 with Microsoft hosts. Not verified against Microsoft's own page.
- Not checked: Gmail/Graph daily send limits and error bodies exactly as returned today, OAuth app verification lead times, SMTP
  AUTH and app-password availability per host (Yahoo, Zoho, regional hosts).

## Consequences

- **Nothing here was run against a real provider.** All tests use local fake SMTP, IMAP, Gmail and Graph servers that model the
  protocol subset XO uses. TLS and STARTTLS against a real server, real OAuth tokens, real Message-ID behaviour, real throttling
  and real limits are unverified.
- No automatic resend exists in any connector; the engine's one-dispatch-per-key and reconciliation-by-a-person rules are unchanged.
- The old `smtpConnector` and its domain allowlist stay for existing users; new work should use `smtpMailConnector`.

## Part b decisions

14. **App passwords use the existing `basic` credential kind; no `app_password` kind was added.** The UW-9 broker already stores a
    user name, host and sealed password (`storeBasic`, `POST /workspaces/{ws}/credentials/basic`, with `capabilities` such as
    `message.send`), sealed the same way as OAuth secrets. A second kind would change the sealed record's authenticated data for
    no gain. This amends the handoff's "new credential kind (`app_password`)".
15. **Readiness checks the bound credential.** `assessReadiness` takes `credentialChecks` (credential id, state, capabilities, the
    capability the operation needs; ids and names of capabilities only). A credential that is not active, missing, or not connected for
    `message.send` (the capability the `send` operation needs, `neededCapability`) **blocks** the authorization gate, so a person
    learns it before approving. The API computes the checks from the workspace broker when it issues a certificate. The refusal at
    use time still exists as the last line of defence. The checks are not part of the certificate digest; a later revocation is caught at use time.
16. **Limits are instance settings** (`XO_EMAIL_MAX_ATTACHMENT_MB` 20, `XO_EMAIL_DAILY_CAP` 400, `XO_EMAIL_PACING_SMTP_IMAP_MS` 1000,
    `XO_EMAIL_PACING_SEND_ONLY_MS` 5000), in the registry and `docs/CONFIGURATION.md`; `emailLimitsFromEnv` reads them. The handoff
    said "per connection"; per-connection overrides are not built (the same values apply to every connection of the instance).

## Not built yet

- **Adapter wiring (UW-10c): done, see ADR 0042** (recipient-rule store and route, confirmed-contacts reader, attachment store, the `email` adapter).
- The one-line tier text in Studio's pre-start preview (`guessProvider` returns the text; nothing displays it yet).
- DSN/bounce parsing (deferred by the owner); the optional
  transactional-API tier.

## Owner prerequisites for real email

`XO_CREDENTIALS_KEY`, `XO_OAUTH_REDIRECT_URI`, Google and Microsoft OAuth clients (Google needs app verification for `gmail.send`; a
`mail.lookup` on Google is a restricted scope, so production use needs Google's restricted-scope verification and assessment), `XO_APPROVAL_SIGNING_KEY` in
production. No new environment variable was added in part a.

## Reopen if

- A real provider shows the Message-ID is rewritten (then tier 1 needs another way to find a prior send, or stays send-only).
- A real mailbox shows Sent-folder lag longer than the two minutes assumed (the retry delays are configurable).
