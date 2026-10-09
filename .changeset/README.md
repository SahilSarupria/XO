# Changesets

Every PR that changes the public behavior of a published package should
include a changeset: run `npm run changeset`, pick the affected package(s)
and bump type (patch/minor/major), and write a one-line summary. See
docs/VERSIONING.md for how this feeds SPECIFICATION.md §11's versioning
requirements at the package level.
