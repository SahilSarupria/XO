# Connection credentials (UW-9)

XO acts on other systems on a workspace's behalf, for example sending an email from the company's mailbox. To do that it holds
credentials for those systems. This page covers four things:

- how credentials are connected;
- how they are stored;
- how connectors use them;
- how to revoke them.

The decision record is ADR 0036.

## What an operator configures

| Setting                                                            | What it is                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `XO_CREDENTIALS_KEY`                                               | The master key: 32 bytes, base64 (`openssl rand -base64 32`). Store it with `xo secrets set`. Without it in production, connections are unavailable (`503 XO_CREDENTIALS_NOT_CONFIGURED`), and XO never stores them unsealed. In development, a key is generated once into `<data>/credentials.key`. |
| `XO_OAUTH_REDIRECT_URI`                                            | The callback address you register with each provider, ending in `/oauth/callback`. It must be https in production.                                                                                                                                                                                   |
| `XO_OAUTH_GOOGLE_CLIENT_ID`, `XO_OAUTH_GOOGLE_CLIENT_SECRET`       | A Google OAuth client of type "Web application", with the callback address as an authorized redirect URI.                                                                                                                                                                                            |
| `XO_OAUTH_MICROSOFT_CLIENT_ID`, `XO_OAUTH_MICROSOFT_CLIENT_SECRET` | A Microsoft Entra app registration (Web platform, the callback address as a redirect URI), with the **delegated** Microsoft Graph permissions `Mail.Send` and, for drive source connections, `Files.Read.All`.                                                                                       |
| `XO_OAUTH_MICROSOFT_TENANT`                                        | `common` (default), `organizations`, `consumers` or one tenant id.                                                                                                                                                                                                                                   |

Losing the master key loses every stored connection; reconnect them. Rotating it means reconnecting, because XO does not re-seal
credentials under a new key.

## Connecting an account

1. A workspace manager, with a recent sign-in, asks to connect an account for a **capability**, for example
   `POST /workspaces/{ws}/credentials/oauth { "provider": "google", "capabilities": ["message.send"] }`.
2. XO answers with the provider's consent URL. The person opens it and agrees.
3. The provider sends the browser back to `/oauth/callback`. XO then exchanges the code (with the PKCE verifier), checks what was
   granted, and stores the tokens.

The callback carries no API key, because it is the provider's redirect. It is bound to the request only by the `state` parameter,
which is:

- 32 random bytes;
- usable once;
- valid for 10 minutes;
- tied to the workspace, the person and what they asked for.

The person must still be a manager when the callback arrives.

For a server without OAuth (SMTP or IMAP with an app password), use `POST /workspaces/{ws}/credentials/basic`.

## Least privilege (UAC-14)

XO asks for capabilities, never for scope names. Each capability maps to the narrowest scope that does the job, plus the identity
scopes needed to know which account was connected:

| Capability     | Google                                                        | Microsoft                                                |
| -------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| `message.send` | `openid email https://www.googleapis.com/auth/gmail.send`     | `openid email offline_access Mail.Send` (delegated)      |
| `files.read`   | `openid email https://www.googleapis.com/auth/drive.readonly` | `openid email offline_access Files.Read.All` (delegated) |

After consent, XO checks the grant before storing anything. Nothing is stored if either of these is true:

- **Missing.** The grant lacks a needed scope, for example because the person unticked it on Google's granular consent screen.
- **Too broad.** The grant includes a scope XO did not ask for (OpenID identity scopes aside).

A refresh that comes back with a wider grant ends the credential. Each use is checked again: a connector must name the scopes it
needs, and the credential must have been granted them.

## How credentials are stored

- **Location.** `<data>/<workspaceId>/credentials/<crd_…>/<version>.json`. Each write is a new, immutable version, published with
  an exclusive link, so two processes refreshing at once cannot both win.
- **What is sealed.** The tokens and passwords, with AES-256-GCM. The key is derived per workspace:
  HKDF-SHA256(master key, "xo-credentials/1", workspace id).
- **Binding to the record.** The ciphertext is bound to the record that carries it: credential id, workspace, kind, provider and
  version. A file copied into another workspace, or edited to name one, does not open.
- **Rotated and revoked secrets leave the disk.** When a refresh rotates a token, the version that held the old refresh token is
  deleted. Revocation deletes every version that held a secret.
- **Never shown.** No API response, audit record or log contains a token, a password, or the provider's account id. Audit records
  carry `accountRef`, a hash, instead.

## How connectors use them

A connector binding may name `credentialId`. At each call, the adapter is lent the credential through the broker, never the secret
itself. The broker:

- checks that the credential belongs to this workspace, is active, and has the scopes the call needs;
- refreshes it when it is due, one refresh at a time;
- hands over the token or password wrapped, so it cannot be logged by accident.

A refusal stops the call before anything is sent. The binding route accepts only an active credential of the same workspace.

## Revoking

`POST /workspaces/{ws}/credentials/{id}/revoke` always destroys the stored secrets and stops every use. At the provider:

- **Google:** the grant is revoked at `oauth2.googleapis.com/revoke`.
- **Microsoft:** offers no revocation endpoint to an app. The response says `not_available`; also remove the app at
  `myaccount.microsoft.com` (or, for an organization, in Entra admin).

If the provider refuses a refresh (`invalid_grant`, because the grant was revoked or expired there), the credential becomes
`expired` with the reason recorded, and it is not used again until someone reconnects.

## Provider facts and where they come from

Re-checked on 2026-11-16:

- **Gmail send-only scope.** `gmail.send` allows sending messages only, with no read or modify of the mailbox. Google classifies it
  as _sensitive_: an app using it needs Google's verification, but not a security assessment. Source: Google, "Choose Gmail API
  scopes" (developers.google.com/workspace/gmail/api/auth/scopes).
- **Drive read-only scope (`files.read`, UW-12a part 2).** `drive.readonly` reads file metadata and content, with no write. Google
  classifies it as _restricted_: an app using it in production needs Google's verification and a yearly third-party security
  assessment. On Microsoft, `Files.Read.All` (delegated) is used rather than `Files.Read` because source folders are often shared
  with the person, not owned by them. Checked 2026-11-17; sources in docs/SOURCE_CONNECTIONS.md.
- **Google authorization and PKCE.** The authorization endpoint is `accounts.google.com/o/oauth2/v2/auth`. PKCE S256 is supported
  and recommended. `access_type=offline` is needed for a refresh token. Source: Google, "OAuth 2.0 for Desktop/Web apps". The token
  endpoint (`oauth2.googleapis.com/token`) is the one XO's Google sign-in already uses. The revocation endpoint
  (`oauth2.googleapis.com/revoke`, form field `token`) is Google's documented one, but Google's page could not be re-read in this
  session. **Confirm it before production.**
- **Microsoft authorization code with PKCE.** Microsoft recommends authorization code with PKCE for all app types. `offline_access`
  is what makes the identity platform issue a refresh token. A scope with no resource means Microsoft Graph. Sources: Microsoft
  Learn, "Microsoft identity platform and OAuth 2.0 authorization code flow"; "Scopes and permissions in the Microsoft identity
  platform".
- **Trusting the id_token.** An id_token received directly from the token endpoint over TLS may be trusted without checking its
  signature (OpenID Connect Core 1.0, §3.1.3.7). XO still checks its audience and issuer.

Before production, confirm with each provider that the app is verified (Google) or consented (Microsoft) for these scopes. That
review is the provider's, not XO's.
