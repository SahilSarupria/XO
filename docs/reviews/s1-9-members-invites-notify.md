# S1-9 design review: inviting people (Opus-level care, needs owner review)

Status: awaiting design review and owner review.

## Screens

- Settings, Members: "Invite someone" (what they can do, "Make an invitation link"), the link shown once with "Copy the link", a list of links with their state and "Take back". Adding by identity ID is folded away for administrators.
- /join: "Join a workspace". The person signs in first, then opens the link and chooses "Join this workspace".

Images (dark and light; desktop and phone) are in docs/reviews/s1-9/. Example: ![](https://raw.githubusercontent.com/SahilSarupria/XO/s1-9/members-invites-notify/docs/reviews/s1-9/j6-02-join-mobile-light.jpg)

## Five states

Loading and error use the kit's; empty (no links) shows nothing extra; success is the recorded line; in progress is the loading button. A link that fails reads one way.

## Glossary

Workspace, Members, Inbox. No ids outside Builder mode except a joined person's name when the platform has no display name for them.

## axe

No new findings; a11y-known.json stays empty.

## Keyboard path

Settings, Members tab, the role select, "Make an invitation link", "Copy the link". Join page: one button.

## Copy read aloud

"Make a link and send it to them yourself: nothing is emailed from here. It works once and for 7 days." Says what is not done.

## Nothing promised that the API cannot do

No email is sent. The link is shown once because only a fingerprint of it is kept. Roles above publisher are never given by a link.

## No industry word

None.

## Security properties (each has a test in apps/api/test/invitation-routes.test.ts)

- An invitation cannot raise a role: admin is refused; accepting never changes the role of someone who already has access (409, link not used up).
- Single use: a second person with the same link gets the same 404 as a link that never existed.
- Another workspace cannot read, list or take back an invitation; the secret under another workspace's id opens nothing.
- Audit carries the invitation id and the role only; a test checks the token and its secret are absent.
- Notification canary: text planted in an event's detail never reaches a notification.

## Hand checks not done

Screen reader, 200% zoom, reduced motion. Copy-to-clipboard was not tried on a real device.
