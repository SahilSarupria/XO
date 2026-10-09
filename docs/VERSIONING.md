# Versioning

## Published packages (this repo)

Semantic versioning per package, managed by
[Changesets](https://github.com/changesets/changesets):

1. Make your change.
2. `npm run changeset` — pick affected package(s), bump type, one-line
   summary.
3. On merge to `main`, `release.yml` opens/updates a "Version Packages"
   PR that bumps `package.json` versions and writes `CHANGELOG.md`
   entries from your summaries.
4. Merging that PR triggers publish.

Internal cross-package dependencies (`@xo/errors` depending on nothing,
`@xo/config` depending on `@xo/errors`, etc.) bump together via
Changesets' `updateInternalDependencies: patch` setting in
`.changeset/config.json`.

## XO packages (the domain artifact this platform produces)

Distinct from the above: an XO's own `manifest.json` `version` field is
governed by `SPECIFICATION.md` §11, not by this repo's release process.
That versioning is append-only at the component level — see
`PACKAGE_README.md` §3's description of how new reasoning traces are
added as "a version bump with a changelog entry" — and is out of scope
for this module (no compiler/packager implementation exists yet to
enforce it in code).
