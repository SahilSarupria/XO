# Specifications

The four frozen design documents cited throughout this repository live here, imported verbatim on 2026-11-13 from the owner's
project document store (originals uploaded 2026-08-16) by owner instruction (ADR 0026). They are byte-preserved: `.prettierignore`
excludes them and they must never be reformatted or edited in place. A change to any of them is a new owner decision recorded as an
ADR.

| File                     | What it is                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `XO_PROTOCOL.md`         | XO-PROTOCOL-1.0, the normative interoperability protocol (a Proposed Standard, not an adopted one) |
| `SPECIFICATION.md`       | XO Package Format Specification v1.0 (informative reference design)                                |
| `EXPERIENCE_COMPILER.md` | Experience Compiler architecture v1.0 (informative reference design; defines EIR)                  |
| `PACKAGE_README.md`      | Notes for the flagship Corporate Contract & Commercial Lawyer demonstration package                |

`docs/RUNTIME_ARCHITECTURE.md` is the fourth reference design those documents cite.

**Governing reference.** The owner's _XO — Master Project Context, Architecture, Vision & Roadmap_ (11 November 2026, held in the
project document store) is the owner's designated source of truth for product decisions. It removes blockchain from the product
vision, so the on-chain elements of `SPECIFICATION.md` (ledger anchoring in §0 and §3, settlement in §4 and §5.3, tokens in §5) are
historical design text, not product direction. Tamper evidence is provided by signatures, Merkle roots and hash-chained audit, which
need no chain.

Specifications of record (ADR 0026):

- Authority order: the owner's master context and `docs/adr/` → `XO_PROTOCOL.md` → the reference designs (`SPECIFICATION.md`,
  `EXPERIENCE_COMPILER.md`, `docs/RUNTIME_ARCHITECTURE.md`, `PACKAGE_README.md`) → package READMEs.
- XOIR: `packages/xoir/README.md`, as amended by ADR 0012.
- Workflow IR: `docs/WORKFLOW_IR.md` and the JSON Schema published by `@xo/workflow-ir` (ADR 0011).
- Trust boundary: `security/TRUST_BOUNDARY.md` (rules T1–T6, every path on which content reaches a model) and its injection corpus
  `security/injection-corpus.json` (UW-1). Unlike the four frozen documents above, these are maintained: a new model path updates them.
