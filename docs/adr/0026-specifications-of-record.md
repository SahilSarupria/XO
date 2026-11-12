# 0026: Specifications of record, and where the frozen design documents live

## Status

Accepted under owner delegation, 2026-11-13 (UW-0). Signed off 2026-11-13 by Claude under the owner's explicit delegation of sign-off authority (owner instruction of 2026-11-13); this is a delegated sign-off, not an independent review. One open owner decision (point 4).

## Context

The plan asks UW-0 for "a XOIR specification of record" and to re-verify that `specs/SPECIFICATION.md` is empty. It is empty (0 bytes
at `26f0052`), yet source comments and docs cite `SPECIFICATION.md` about 80 times, and `XO_PROTOCOL.md`, `EXPERIENCE_COMPILER.md`
and `PACKAGE_README.md` about 55 more. `docs/ARCHITECTURE.md` calls them the frozen design docs. They are not in the repository; they
are held in the owner's claude.ai Project "XO" (uploaded 2026-08-16). `docs/RUNTIME_ARCHITECTURE.md` is in the repository. The P1.1
records list "frozen references (5)" as unavailable; whether those five are these documents is not verified.

`packages/xoir/README.md` (about 29 KB) is a complete description of XOIR as built: node and edge taxonomy, legacy migration, metadata
and provenance, confidence, cycles, identity versus content hash, manifest, validation, serialization and hashing, and its relation to
packages, runtime and registry.

## Decision

1. **Authority order** for design questions, highest first: the owner's master context and ADRs (`docs/adr/`), then `XO_PROTOCOL.md` (normative), then
   the informative reference designs (`SPECIFICATION.md`, `EXPERIENCE_COMPILER.md`, `RUNTIME_ARCHITECTURE.md`, `PACKAGE_README.md`),
   then package READMEs. XO_PROTOCOL §0 already makes itself normative over the other three.
2. **XOIR specification of record:** `packages/xoir/README.md`, versioned with the package, as amended by ADR 0012 (claim layer). Its
   design authority is EIR in `XO_PROTOCOL.md` §6.5 and `EXPERIENCE_COMPILER.md` §3. A change to XOIR's schema changes that README in
   the same commit.
3. **Workflow IR specification of record:** `docs/WORKFLOW_IR.md` plus the published JSON Schema in `@xo/workflow-ir` (ADR 0011).
4. **The frozen documents are committed** (owner decision, 2026-11-13): `specs/SPECIFICATION.md`, `specs/XO_PROTOCOL.md`,
   `specs/EXPERIENCE_COMPILER.md` and `specs/PACKAGE_README.md`, verbatim from the owner's project document store and excluded from
   formatting so they stay byte-identical. The repository is public; publishing them was the owner's call.
5. **Governing reference above all of these:** the owner's _XO — Master Project Context, Architecture, Vision & Roadmap_ (11 November
   2026), designated by the owner as the source of truth for decisions. It removes blockchain from the product vision, so on-chain
   elements of `SPECIFICATION.md` are historical design text, not product direction.

## Reopen if

A second XOIR description appears that disagrees with the package README.
