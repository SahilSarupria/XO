# Self-onboarding: organisations, invites and company domains

Status: **step 1 is built** (first sign-in creates a private organisation). Steps 2 and 3 are designed here and **not built**.
Decisions were taken with the product owner: a new customer gets their own organisation automatically; company domains
are an owner opt-in and must be verified; personal Gmail accounts are allowed and get a personal workspace.

## Goals and non-goals

- A regular customer signs in with Google and can use XO with no operator step.
- Two customers never share an organisation, an identity or a workspace by accident.
- Joining someone else's organisation is always an explicit act by that organisation (an invite, or a domain it proved it owns).
- Non-goal here: roles and permissions. `@xo/permissions` still decides what a principal may do; an organisation is a label until step 2.

## What exists today (the facts this design builds on)

- A sign-in is verified (Google signature, issuer, audience, one-time nonce) and mapped through an **identity binding**
  `(issuer, sub) -> { identityId, principalKind, orgId? }`. No binding means no access.
- `orgId` is only a label. Workspaces are owned by `identityId` (a person), so isolation between people already holds.
- The ID-token verifier deliberately returns only `(issuer, sub)`. It ignores `email`, `email_verified` and `hd`.

## Step 1 (built): individual-first sign-in

Revised after audit: the first version created an organisation for every new user. That was wrong for the product: `orgId` is only a
label (nothing authorises on it, and there are no membership records), so it implied a company the person never made. Now:

Enabled by `XO_API_SELF_SIGNUP=1` (off by default; with it off, an operator must bind each account). Never enable it in a public
environment merely to make a demo work.

On the first verified sign-in of an identity with no binding, the API creates a **personal identity and no organisation**:

- `identityId = usr_<first 24 hex of sha256([issuer, sub])>`, kind `human`, no `orgId`.
- Everything the person creates (workspaces, sources, runs, approvals) is already scoped to that identity server-side, so personal work is
  private by construction. Tested: a second self-signed-up person cannot list or reach it; no credential gets a 401.
- A **revoked** binding is never re-created. Revocation is an operator decision and wins.
- Concurrent first sign-ins of one account leave exactly one binding (tested). A storage failure while provisioning is a retryable 503 with
  no session and no binding (tested), so no half-made or privileged state.
- Only `(issuer, sub)` is stored. No email, no name.
- Bindings made earlier by an operator (with or without `orgId`) are untouched. No migration is needed.

Organisations are created or joined later by an explicit action (step 2). Joining one will not move or expose personal work: membership
grants nothing by itself, and personal workspaces stay owned by the person.

Known limits (found in review, not yet fixed):

- ~~Check-then-write creation~~ **Fixed.** Self sign-up uses `createIfAbsent`: the record is written and fsynced to a private temp file, then
  published with a hard link, which fails if any entry (active, revoked, corrupt, oversized, symlink) already has that name. So concurrent
  first sign-ins have exactly one winner, and a revoked or corrupt record is never replaced (a corrupt record is a retryable 503 and needs
  an operator; it is never read as "absent"). Guarantee depends on the filesystem supporting hard links; if it does not, creation fails
  closed with a storage error rather than falling back to an overwriting write. The operator `bind` path still uses `create`.
- Account creation is limited only by the per-address exchange limit (10 a minute) and the outstanding-challenge cap. Behind a reverse
  proxy the "address" is the proxy unless it is forwarded, so all users would share one bucket. Add an account-creation cap and alert
  before public rollout.

Also: no cap on account creation (bounded only by sign-in rate limits and needing a real Google login); the only automated
tests use a fake identity provider, not real Google.

## Step 2 (designed): organisations and invites

New operator-independent store, `OrgStore`, separate from bindings:

- `Org { orgId, name, createdAt }`, `Membership { orgId, identityId, role: owner | admin | member, addedAt }`.
- Creating an organisation is an explicit action by a signed-in person: they become its `owner`; their personal work is not moved.
- **Invite**: an owner/admin creates `{ orgId, role, expiresAt, maxUses: 1, createdBy }`. The API returns a link token **once**; only its
  SHA-256 is stored. Tokens are 256-bit random, expire (default 7 days), are single use, and are revocable.
- **Accepting** requires a verified sign-in. The invitee's identity is added as a member of the inviting org. It does not move their
  workspaces; they gain access to that organisation's shared resources only once org-shared workspaces exist (below).
- A person can belong to several organisations; the active one is chosen in Studio.

Open requirement before this is useful: **organisation-shared workspaces**. Today workspaces are per identity. Sharing needs the
workspace access check (`workspace-context`) to accept "member of the workspace's org with a role that allows it". That touches
authorization, so it must ship with its own tests and review rather than ride along with this step.

## Step 3 (designed): verified company domains

An owner opts in. Auto-join is never inferred from an email address alone.

1. Owner submits `acme.com`. The API issues a random value and asks them to publish it as a DNS TXT record at `_xo-verify.acme.com`.
2. The API checks DNS (with a timeout and a fixed resolver policy) and marks the domain verified. Re-checked periodically; a lapse suspends auto-join.
3. At sign-in the API needs two new claims from the ID token: `email_verified === true` and the email's domain, and for Google Workspace
   the `hd` claim must equal the verified domain. The verifier must be extended to return them (a deliberate, tested change to a
   component that today ignores them).
4. A matching, verified user is added as `member` (never owner). The owner can set it to "require approval" instead.
5. **Never offered for consumer domains.** `gmail.com`, `googlemail.com` and similar are refused as claimable domains, so a personal Gmail
   user can never be swept into a company or claim "everyone at Gmail".
6. A domain can be claimed by one organisation at a time; a second claim is refused unless the first is released.

## Threats considered

| Threat                                                          | Control                                                                                                        |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Someone signs up as a victim's colleague via a look-alike email | Domain join needs DNS-verified ownership plus `email_verified` and, for Workspace, `hd`                        |
| Invite link leaked                                              | Single use, expiry, revocable, stored hashed, role capped at what the inviter holds                            |
| Mass fake sign-ups                                              | Requires real Google login; sign-in rate limits; add an account-creation cap and alerting before public launch |
| Revoked user returns                                            | Revoked bindings are never re-provisioned (built and tested)                                                   |
| Operator secrets exposed to customers                           | Unchanged: the Google client secret lives only on the API                                                      |
| Two customers see each other's data                             | Distinct `identityId`/`orgId` per customer; workspaces remain per-identity until shared-workspace authz ships  |

## Build order

1. Step 1 (done). 2. `OrgStore` + membership, `GET /orgs/me`, Studio org badge. 3. Invites (create, accept, revoke) + Studio UI.
2. Shared-workspace authorization. 5. Verifier claim extension, then domain verification and auto-join.
