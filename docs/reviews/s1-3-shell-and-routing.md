# Design review: S1-3 shell, places and addresses

Status: **awaiting design review** (owner). Branch `s1-3/shell-and-routing`, stacked on `s1-2/journeys`.

## Dark first (decision D-18)

Studio now opens in its dark theme ("ink at night": blue-slate ground, not neutral black). Light ("paper and ink") and Match
this device are choices in Settings → General → Appearance, and in the command palette. The default is never stored; a stored
light or device choice is applied before the first paint (`public/theme-boot.js`), so it does not flash dark. Both themes pass
the same contrast tests (AA text, 3:1 control edges and focus).

## Seven places

The sidebar is Home, Inbox, Work, Sources, Knowledge, Activity, Settings, in both modes. Builder mode adds tabs inside a place
(Processes in Work, Contracts in Sources, Platform in Settings), never a place. Screens that were sidebar items are tabs:

| Place     | Tabs                                                    |
| --------- | ------------------------------------------------------- |
| Work      | Workflows · Library · Processes (Builder)               |
| Sources   | Documents and rules · Connections · Contracts (Builder) |
| Knowledge | What XO knows · Records                                 |
| Activity  | Runs · Audit log                                        |
| Settings  | Settings · All workspaces · Platform (Builder)          |

Each page's h1 is its place (kept visually hidden while each screen still shows its own heading; the screen rebuilds in S1-4
to S1-8 make it the visible title and drop the duplicate). The workspace's name is on the sidebar card.

## Addresses

`/w/<workspace>/<place>[/<view>]`: refresh, Back and Forward, a copied link and a deep link through sign-in all keep the
place. Old `#/section` links, at arrival or followed inside Studio, are replaced by their path.

## Phone

Under 600 px a bottom bar holds Home, Inbox, Work, Activity and More; More opens the drawer with every other place and the
workspace menu. Counts show on Inbox. The page's Ask XO bar floats above the bottom bar.

## Home

In order: the ask box; Start work (the one next step); What needs you now (waiting decisions, stopped runs, runs that did not
complete, workflows that need approval first, each with where to deal with it); Running now (each run opens); Recent results
(the last five, on both runners). Getting started sits beside it until the workspace has run something. No metric tiles. A
workflow with a run under way on either runner is never "ready to start" (it was on the workflow runtime).

## Under the hood

- **Version check.** `GET /version` at sign-in (no credential). An API outside `0.1.x` shows "XO is being updated" with what
  an administrator needs to know; an instance without Connect is not asked for it (Sources → Connections and Knowledge →
  Records say so). An API that cannot say is used as before.
- **Errors.** A top-level boundary and one per screen (the sidebar stays; going elsewhere recovers) show "Something went
  wrong on this screen" with Reload. Uncaught errors, unhandled rejections and failed renders go to `POST /client-errors` as a
  template with no content, once each, at most ten per page load.
- **Read cache** (`src/platform/query.ts`). One cache per sign-in: keyed reads shared by every screen, stale while
  revalidate, one request in flight per key, invalidation by workspace prefix after any change, shared pollers paused while
  the tab is hidden. One long request per workspace keeps the Inbox live everywhere (it was only on the Inbox screen).
- **Budgets** (`npm run budget -w @xo/studio`, in CI). First-screen JS 113 KB of 250, CSS 17 KB of 60, largest chunk 69 KB
  of 120. Every screen but Home is its own chunk, preloaded when the browser is idle.

## Screenshots

All 22 references are refreshed (dark), and J7-02 (version) is a real step with its own two references. CI:
`.github/workflows/studio-visual.yml`.
