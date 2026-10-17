# Studio visual regression

Every push or pull request that can change what XO Studio looks like runs the real Studio and API in headless Chromium,
takes the established screenshots, and compares them with **approved reference images** stored in the repository. A
difference beyond the threshold fails the check and produces an image you can look at. Nothing is ever updated
automatically.

Workflow: `.github/workflows/studio-visual.yml` · Suite: `apps/studio/visual/`

> **Status.** The comparison, reporting, exit-code and path-filter logic are covered by tests that pass
> (`npm test` in `apps/studio/visual`, and `selftest.mjs`). The full pipeline (build, real API, seed, real Studio screens)
> and the GitHub Actions run itself had **not been exercised** when this was written: the authoring environment could not
> reach the npm registry. Until a first run succeeds on GitHub and the references are bootstrapped (below), do not treat
> Studio as automatically covered.

## What triggers it

The `paths:` lists (identical for `push` and `pull_request`) are **derived from the repository**, not hand-maintained:

| Starts the workflow                                                                                                                                        | Does not                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/**` (source, styles, `index.html`, Vite config, `package.json`)                                                                               | Markdown anywhere, tests anywhere (`**/test/**`, `*.test.ts[x]`)                                                    |
| `apps/api/**` and every workspace package `@xo/api` is built from (found by following its `dependencies` and `tsconfig` references), currently 20 packages | Studio's desktop-only code: `src-tauri/`, `desktop/`, `vite.desktop.config.ts`; Studio `scripts/` and `deploy/`     |
| `package.json`, `package-lock.json`, `.nvmrc`, `.npmrc`, `tsconfig*.json` (they decide what gets installed and built)                                      | Packages the API does not use (for example `atlas`), `apps/cli`, `docs/`, `.changeset/`, other workflows (`ci.yml`) |
| `examples/vertical-test/Aastha.pdf` (the document the synthetic data is made from)                                                                         |                                                                                                                     |
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

## What it captures

Deterministic, synthetic data only. The suite builds a throw-away workspace through Studio's own client against a real
API: it uploads `examples/vertical-test/Aastha.pdf`, lets XO analyse it, approves the rules of the shortest runnable
process and starts it, so a decision is waiting. Nothing is mocked.

| Viewport  | Screens                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| 1440×1000 | `first-run`, `home-empty`, `home`, `work`, `work-detail`, `tasks`, `activity`, `setup-documents`, `setup-rules` |
| 390×844   | `home`, `drawer-open`, `work`, `work-detail`, `tasks`                                                           |

It also checks, without screenshots, that Back and Forward keep the person's place and that Escape closes the mobile
drawer. A failure of those counts as a regression.

To keep images identical between runs without masking regions: Chromium runs from one pinned container image (fonts and
libraries included), animations and the caret are disabled, the time zone and locale are fixed, and server-generated dates
are pinned to one fixed string by a test-side shim (`lib/browser.mjs`). The product is not changed for the suite.

## Results and how to tell them apart

| Result         | Exit code | Meaning                                                                                                                                       |
| -------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **pass**       | 0         | Every screen matches its approved reference.                                                                                                  |
| **regression** | 10        | The suite ran and the UI is not what was approved: pixels changed, size changed, a screen has no reference, or a behaviour check failed.      |
| **infra**      | 20        | The suite could not do its job (build, API or Studio did not start, seeding or sign-in failed, browser version wrong). The UI was not judged. |

The job summary and an error annotation state which one it was. Infrastructure failures always win over anything found.

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

## First-time setup (bootstrapping the references)

There are no approved references until someone approves them. Until then every screen reports “no approved reference”.
References must come from the CI image, not a laptop, because fonts and rendering differ between machines.

1. Actions → **Studio visual regression** → **Run workflow** → mode `update-candidates` (on the branch you want).
2. Download the artifact and open `candidates/`. **Look at every image.** Confirm they show the intended screens with
   synthetic content only.
3. Copy `candidates/desktop/` and `candidates/mobile/` into `apps/studio/visual/baselines/` and commit them in a normal
   pull request. A reviewer approves them like any other change.

## Updating approved references

References change only through a reviewed commit, never automatically.

1. A run fails with differences. Download the artifact and review each `side-by-side.png`.
2. If the change is **unintended**, fix the code. If it is **intended**, run the workflow manually in `update-candidates`
   mode on your branch (so the images come from the pinned CI image), or run the local Docker command below.
3. Copy the changed `candidates/<viewport>/<screen>.png` over the matching file in `apps/studio/visual/baselines/` and
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

# The real thing: builds, starts API + Studio on free ports and throw-away data, captures, compares, cleans up
npm ci && npx playwright install chromium
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

- Not yet exercised end to end on GitHub Actions (see Status). The container image tag has not been pulled from this
  environment.
- The Studio web build only. The Tauri desktop shell and Google sign-in are not captured.
- References are bootstrapped from CI, so the first run after bootstrap is the first real comparison.
- Loading, error and blocked states beyond the first-run screen are not captured yet, because they need a controllable
  fault in the real API and the suite deliberately does not fake backend responses.
