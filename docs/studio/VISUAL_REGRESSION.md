# Studio journeys and screenshots (visual regression)

Every push or pull request that can change what XO Studio looks like or does runs the real Studio and API in headless
Chromium. Since S1-2 it **walks the journeys of the Studio plan** (`claude/XO_STUDIO_PRODUCTION_READINESS_PLAN.md`, section 4)
on a seeded workspace, at desktop (1440×1000) and phone (390×844) sizes. At every checkpoint it runs **axe** and compares a
screenshot with an **approved reference** stored in the repository. Nothing is ever updated automatically.

> **A gate.** The job fails when a step does not work, a checkpoint differs from its reference or has none, axe finds a
> serious or critical problem that is not on the known list, the tooling tests fail, or the path filters drift. The job
> summary says which, and names an infrastructure failure (the app never started) as such. To make it block merging, an
> owner marks the "Studio screenshots" check as required in branch protection.

Workflow: `.github/workflows/studio-visual.yml` · Suite: `apps/studio/visual/` (`seed.mjs`, `journeys.mjs`, `run.mjs`)

## What triggers it

The `paths:` lists (identical for `push` and `pull_request`) are **derived from the repository**, not hand-maintained:

| Starts the workflow                                                                                                                                        | Does not                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/**` (source, styles, `index.html`, Vite config, `package.json`)                                                                               | Markdown anywhere, tests anywhere (`**/test/**`, `*.test.ts[x]`)                                                    |
| `apps/api/**` and every workspace package `@xo/api` is built from (found by following its `dependencies` and `tsconfig` references), currently 20 packages | Studio's desktop-only code: `src-tauri/`, `desktop/`, `vite.desktop.config.ts`; Studio `scripts/` and `deploy/`     |
| `package.json`, `package-lock.json`, `.nvmrc`, `.npmrc`, `tsconfig*.json` (they decide what gets installed and built)                                      | Packages the API does not use (for example `atlas`), `apps/cli`, `docs/`, `.changeset/`, other workflows (`ci.yml`) |
| The workflow file, and everything under `apps/studio/visual/` including the reference images                                                               |                                                                                                                     |

Studio itself imports no workspace package, but screenshots are taken against a real API, so what the API is built from
affects what Studio shows. **When you add or remove a dependency of `@xo/api`**, regenerate the lists:

```sh
node apps/studio/visual/check-trigger-paths.mjs --print     # paste under both `paths:` keys
node apps/studio/visual/check-trigger-paths.mjs             # exits 1 if the workflow has drifted (also runs in CI)
node apps/studio/visual/check-trigger-paths.mjs --would-trigger apps/api/src/server.ts docs/DEVELOPING.md
```

The workflow works for new branches with no configuration (`branches: '**'`). A pull request from the same repository is
not run a second time, because the push run for the same commit already covers it; forks have no push run here, so the
`pull_request` run covers them.

## What it does

**The seed** (`seed.mjs`) builds a throw-away workspace through the real API, as a person would. Nothing is mocked:

- a connected folder with a list of four people (one has no document yet) and one document per person, with what XO found
  confirmed;
- two procedures in plain words, each a named workflow, every rule approved;
- a run of the short checklist workflow, so a person has a step to decide.

The data is synthetic and industry-neutral (`visual.config.mjs`, `SYNTHETIC`).

**The journeys** (`journeys.mjs`), each at both sizes:

| Journey                 | Steps that run today                                                                                                                                                                     | Not possible yet (and the PR that enables it)                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| J1 first day            | sign in (development key, labelled), first workspace, Home's next step, the connected folder, the workflow, check before starting, the run in the workflow's panel, evidence in Activity | send set-up (S1-5); preview, ask for approval, reviewer approval (S1-6) |
| J2 a normal day         | the Inbox with the step waiting                                                                                                                                                          | approve a batch (S1-6); mark done with a note (S1-7)                    |
| J3 unclear outcome      | none                                                                                                                                                                                     | all (S1-7)                                                              |
| J4 recurring work       | none                                                                                                                                                                                     | all (S1-8)                                                              |
| J5 stop everything      | the emergency-stop screen                                                                                                                                                                | stop from a list, the banner on every screen, release (S1-8)            |
| J6 invite               | none                                                                                                                                                                                     | all (S1-9)                                                              |
| J7 something went wrong | XO cannot be reached: Activity says so, and does not claim nothing ran                                                                                                                   | version (S1-3); session expired, refused action (S1-11)                 |

A step that is not possible yet is reported as such, never as a pass. Each PR that enables one turns it into a real step.

**Accessibility.** axe (WCAG 2.2 A and AA rules) runs at every checkpoint. A serious or critical finding fails the step,
unless its rule is listed for that checkpoint in `apps/studio/visual/a11y-known.json`. That list is for screens not yet
rebuilt on the kit, and may only shrink; the report lists the known findings it saw.

To keep images identical between runs without masking regions: Chromium runs from one pinned container image (fonts and
libraries included), animations and the caret are disabled, the time zone and locale are fixed, and server-generated dates
are pinned to one fixed string by a test-side shim (`lib/browser.mjs`). The product is not changed for the suite.

## Results and how to tell them apart

| Result         | Exit code | Meaning                                                                                                                                       |
| -------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **pass**       | 0         | Every step that runs works, and every checkpoint matches its approved reference.                                                              |
| **regression** | 10        | The suite ran and the UI is not what was approved: pixels changed, size changed, a screen has no reference, or a behaviour check failed.      |
| **infra**      | 20        | The suite could not do its job (build, API or Studio did not start, seeding or sign-in failed, browser version wrong). The UI was not judged. |

The job summary and an annotation state which one it was, and the job fails for either. Infrastructure failures always win
over anything found.

**Threshold** (`apps/studio/visual/visual.config.mjs`): a pixel differs when any channel is more than 8 away; a screen fails
when more than 50 pixels differ, or its dimensions changed. That absorbs anti-aliasing noise and fails on a single changed
word. Changing these numbers changes what "regression" means; update this page when you do.

## Inspecting a branch without changing the repository

Open the workflow run, then download the artifact `studio-visual-<run id>-<attempt>` (kept **14 days**, uploaded even when
the run fails). It contains:

- `report.md`, `result.json`: which screens changed and by how many pixels
- `actual/`: every screenshot from this commit
- `diff/<viewport>/<screen>.side-by-side.png`: **reference | new | difference**, the image to review
- `logs/`: build, API, Studio and run logs, with credentials redacted

## Getting the new images when the artifact cannot be downloaded

Actions → **Studio visual regression** → **Run workflow** on the branch, with **print-candidates** ticked. The log then holds
the same `actual/` folder as one base64 `tar.gz` between `BEGIN SCREENSHOTS` and `END SCREENSHOTS`. Decode it with
`base64 -d | tar -xz`. Review every image before committing it, exactly as from the artifact.

## Updating approved references

References change only through a reviewed commit, never automatically.

1. A run reports differences. Download the artifact and review each `side-by-side.png`.
2. If the change is **unintended**, fix the code. If it is **intended**, take the new images from the failed run's
   artifact (`actual/<viewport>/<screen>.png`, rendered on the pinned CI image), or run the workflow manually in
   `update-candidates` mode once it is on `main`, or run the local Docker command below.
3. Copy the changed images over the matching file in `apps/studio/visual/baselines/` and
   commit with the code change. The pull request now shows old and new reference images side by side.
4. If a screen was removed or renamed, delete its reference deliberately (the report lists unmatched ones as “orphaned”).

The reference images are plain files under `apps/studio/visual/baselines/<viewport>/<screen>.png`, so they follow the
branch like any other file: a branch that changes the UI carries its own approved images, and `main` is unaffected until
that branch merges.

## Running it locally

```sh
# Tooling tests and workflow checks (no browser, no services)
cd apps/studio/visual && npm install --no-package-lock --ignore-scripts && npm test
node apps/studio/visual/check-trigger-paths.mjs

# Machinery self-test: real Chromium, tiny local page, proves pass / regression / infra handling
node apps/studio/visual/selftest.mjs

# The real thing: builds, starts API + Studio on free ports and throw-away data, seeds, walks the journeys, compares, cleans up
npm ci && npx playwright install chromium
# Without Playwright's browser, any local Chrome works for trying the journeys (its images are not comparable with CI):
XO_VISUAL_CHROMIUM=/usr/bin/google-chrome node apps/studio/visual/run.mjs
node apps/studio/visual/run.mjs                       # compare with the approved references
node apps/studio/visual/run.mjs --mode update-candidates
```

Output goes to `.xo-dev/visual/<run>/` (git-ignored). For images comparable with CI, use the same container:

```sh
docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.56.1-noble \
  bash -c "npm ci && (cd apps/studio/visual && npm install --no-package-lock --ignore-scripts) && node apps/studio/visual/run.mjs"
```

## Security and isolation

- Workflow permissions are exactly `contents: read`; it uses no secrets and never commits or pushes. A unit test fails if
  the workflow gains `secrets.*`, `pull_request_target`, a `git push`/`commit`, or broader permissions.
- Fork pull requests run with a read-only token and no secrets (GitHub's default for `pull_request`).
- Access keys are synthetic, issued into a fresh temporary directory, never printed, and only typed into the page. Tracing,
  video and HAR recording are never enabled, so no key is recorded. Child processes receive a minimal environment, and
  every log line passes a redaction filter.
- Each run uses a unique temporary data directory, free ports and a unique output folder, so concurrent runs cannot
  interfere. Services are stopped and the data directory deleted at the end, including after failure.

## Pinned versions

Playwright is pinned exactly (`1.56.1`) in `apps/studio/visual/package.json`, in `visual.config.mjs`, and as the container
tag in the workflow. The runner refuses to run on any other version. Bump all three together, then re-bootstrap the
references, because a new browser build changes text rendering.

## Known limitations

- The Studio web build only. The Tauri desktop shell and Google or OIDC sign-in are not walked.
- Sending is not exercised yet: the email steps arrive with the send set-up (S1-5) and preview and approval (S1-6), with a
  local email fake.
- `smoke-editor.mjs` was removed in S1-2: it drove the draft launcher that ADR 0052 removed.
