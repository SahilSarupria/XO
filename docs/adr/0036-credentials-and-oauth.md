# 0036: One credential broker; OAuth authorization code with PKCE; sealed per workspace (UW-9)

## Status

Accepted under owner delegation, 2026-11-16 (UW-9, wave W2). Signed off by Claude under the owner's delegation of decision
authority. This is a delegated sign-off, not an independent review.

## Context

UW-10 (email actions) and UW-12 (Connect) need XO to hold credentials for systems outside it, starting with a company mailbox.
Before UW-9, three separate mechanisms existed:

- **The runtime connector vault (`@xo/connectors`).** It read secrets by name from the environment or a file, per instance, with
  no notion of a workspace.
- **Environment intelligence's cloud manager.** It used the OAuth device-code flow for Microsoft identity, kept tokens in memory
  only, and lost them all at restart.
- **Adapters.** Each one carried whatever credentials the operator built it with.

None of these stored a workspace's credential safely, refreshed it, or revoked it. The http connector also resolved a host and then
connected by name, which left a gap for DNS rebinding. UAC-14 requires all of the following: least-privilege send scope, tokens
encrypted at rest per tenant, refresh and revocation that work, and cross-tenant access denied.

## Decisions

1. **One broker, use-only.** `CredentialBroker` (in `@xo/connectors`) is the only way code gets a credential, and it has no `get`.
   `use(credentialId, need, fn)` does four things:
   - checks that the credential is this tenant's, is active, and was granted every scope `need` names;
   - refreshes the credential when it is due: one refresh at a time within a process, and by compare-and-swap across processes, so
     a rotating refresh token is redeemed once;
   - if the refresh fails only because the provider is unreachable, keeps using a token that has not expired yet;
   - hands `fn` the secrets wrapped in `Secret`, which cannot be printed, serialised or inspected.

   Adapters get it per call through `AdapterInvokeRequest.credential`, lent by the binding's `credentialId`. A refusal is
   `DENIED`, with nothing sent.

2. **Sealed per workspace.**
   - The cipher is AES-256-GCM, under HKDF-SHA256(instance master key, "xo-credentials/1", workspace id).
   - The additional authenticated data is the record's schema, id, workspace, kind, provider and version. A copied or edited record
     therefore does not open in another workspace.
   - The master key (`XO_CREDENTIALS_KEY`) is a governed secret and never sits beside the data in production. Without it, connections
     are refused (503) rather than stored unsealed.
   - Each write is an immutable version published with an exclusive `link`.
   - A rotated-out refresh token, and every secret of a revoked credential, is deleted from disk.
3. **OAuth is authorization code with PKCE (S256).**
   - Ask for capabilities, not scopes. `message.send` maps to Google `gmail.send` or Microsoft delegated `Mail.Send`, plus identity
     and offline access.
   - The grant must cover the request and must not exceed it (OpenID identity scopes aside), or nothing is stored. A refresh that
     widens the grant ends the credential.
   - Google's `include_granted_scopes` is never sent, so an earlier consent cannot widen a new one silently.
   - The id_token comes straight from the token endpoint over TLS and is accepted without a signature check (OIDC Core §3.1.3.7).
     Its audience and issuer are still checked.
   - The account is stored as a label for the workspace and as a hash (`accountRef`) for audit.
4. **The callback is bound by its state alone.** `/oauth/callback` is public, because it is the provider's redirect. The state:
   - is 32 random bytes;
   - is stored as a hash, with the PKCE verifier sealed;
   - is claimed once, by an atomic rename;
   - lasts 10 minutes;
   - names the workspace, the person and the request.

   The person must still hold the manage role when the callback arrives. An `iss` parameter (RFC 9207) that names another issuer is
   refused. A provider's error description is never kept, because it can echo the request; only its error code is.

5. **Revocation always reduces authority.**
   - The credential is revoked at the provider when the provider has an endpoint for it (Google). The result says when it does not
     (Microsoft has none for an app).
   - It is always destroyed locally.
   - `invalid_grant` on refresh moves the credential to `expired`, with the reason recorded.
6. **Every provider call goes through `egress`.** That means HTTPS only, to the provider's own hosts, to a vetted and **pinned**
   address, with no redirects. The http connector now uses the same pinned transport by default, which closes the DNS-rebinding gap
   recorded against it. An injected `fetch` keeps the earlier resolve-then-check guard.
7. **Basic credentials** (a user name and app password for SMTP or IMAP, email tiers 2 and 3) use the same store and broker. They are
   rotated with `rotate`.
8. **Not in UW-9:**
   - **EI's device-code cloud manager stays in memory.** Persisting it through this store is part of UW-12a (the source-connection
     entity).
   - **Readiness does not check the state of a bound credential.** The call is refused at use time; a readiness gate for it belongs
     to UW-10.

## Consequences

- A workspace can connect a mailbox for sending without XO ever holding read access to it.
- **Behaviour change.** An `httpConnector` without an injected `fetch` connects to the vetted address, sending the original Host
  header and TLS name. A host that relied on DNS changing between the check and the connection no longer works, which is intended.
- **Operators who want connections must set `XO_CREDENTIALS_KEY`,** plus a client per provider.

## Reopen if

- A provider needs a scope that XO cannot request through the capability catalogue.
- A deployment needs credentials shared across workspaces. Model that as an explicit grant, not a shared record.
