# Microsoft 365 content access: design and verification plan (C7.5)

Status: **design only. Nothing here is implemented or live-verified.** Cloud sources stay "Coming soon" until every item in "Exit criteria" is met against a real tenant. The provider's scope allow-list (`openid offline_access User.Read`) is **unchanged**: widening it is a deliberate change to a least-privilege design and is made only when the live work below starts.

## Facts from Microsoft documentation (checked in this pass)

Sources: Microsoft Learn "Selected permissions overview" (Graph), the SharePoint dev blog on delegated `Sites.Selected`, and the MS Graph permissions reference. Re-check before building: Microsoft changes this area.

1. `Sites.Selected` grants **nothing by itself**. An app consented to it can reach only the site collections that carry an explicit permission entry for that app.
2. It supports **both delegated and application** access. In the delegated case the effective access is the **intersection** of what the app was granted and what the signed-in user can access. The app never exceeds the user, and the user never exceeds the app.
3. Granting is a separate act per site: `POST /sites/{site-id}/permissions` naming the app and a role (`read`, `write`, ...). Making that call needs a high permission (`Sites.FullControl.All`, delegated or application) held by an administrator, or an app already holding `Sites.Selected` with an owner/full-control role on that site.
4. A grant on a parent site is **inherited by its sub-sites**.
5. Finer scopes exist (`Lists.SelectedOperations.Selected`, `ListItems.SelectedOperations.Selected`, `Files.SelectedOperations.Selected`); they can only narrow, never widen.
6. Consent for these scopes needs **tenant administrator consent** in Entra ID.

## What this means for XO

- XO's connection today is delegated, device-code, public client. Variant A keeps that shape and adds the delegated `Sites.Selected` scope.
- **There is no tenant-wide site discovery under `Sites.Selected`**, and site search does not work for it. XO cannot list "the sites you could pick". The administrator names the sites (URLs); XO resolves each by path and confirms the grant exists before offering it. _Not yet verified live:_ whether any Graph call lists only the sites an app was granted. Do not assume one exists.
- Revoking in XO does not remove the grant at Microsoft (`remoteRevocation` is false). The UI must say: "This stops XO. The permission you gave Microsoft stays until removed in Microsoft 365", with a link to how to remove it.
- Do not use "exactly what Microsoft will ask you to confirm" anywhere until the consent screen has been seen live and matches.

## Proposed phases (each independently reviewable; none started)

1. **Admin setup, documented and tested against a real tenant.** Entra app registration (tenant GUID, client GUID as today), delegated `Sites.Selected` added, admin consent, per-site grants. Deliver an administrator runbook and a read-only "grant check" that, for a site URL the admin supplies, reports granted / not granted without reading content.
2. **Connector operations** (`discover` for the named sites, `acquire`, `incremental_sync` using drive delta queries with a persisted delta token) behind the existing C1 contract, with the C4 ingestion path unchanged. Delete and access-loss detection come from delta results.
3. **Studio flow**: admin setup guidance, device-code sign-in screen (show the code and the microsoft.com address, a cancel, expiry), site selection restricted to admin-named sites, honest states.
4. **Hardening**: throttling (429 with Retry-After), partial failures, permission changes mid-sync, token expiry (already distinct: `access_expired`).

## Exit criteria (all required before "Coming soon" is removed)

- A live tenant run of: connect, consent, grant check, discover, acquire, incremental sync with a deletion, expiry, and revoke. Evidence recorded (requests, results, audit).
- Tests with recorded real responses, not invented ones.
- The scope allow-list change reviewed and approved as a least-privilege change.
- Wording verified against what was actually seen on screen.

## What was deliberately not built, and why

Writing Graph client code now would produce code that passes tests written from documentation, not from a tenant. The failure modes (consent prompts, grant propagation delay, throttling, sub-site inheritance surprises) only show up live. Shipping it would be a false green.
