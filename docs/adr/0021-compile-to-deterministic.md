# 0021: Compile to deterministic by default (D-L)

## Status

Accepted under owner delegation, 2026-11-13 (UW-0). Signed off 2026-11-13 by Claude under the owner's explicit delegation of sign-off authority (owner instruction of 2026-11-13); this is a delegated sign-off, not an independent review. Implemented by UW-6 and UW-15.

## Context

The positioning in Revision 4 (§1, §4): XO should not out-reason agentic AI; it should be what an agent's work becomes after the first
successful run. Agents re-reason every run, which is slow, costly, hard to reproduce and prone to guessing. The building blocks exist:
`workflow-runtime`'s structured-first routing makes zero model calls on complete structured input, its extraction memo never repeats a
model call for an identical case, and `xo flow promote` turns repeated human decisions into signed rule patches.

## Decision

1. A model (or a person) may plan a workflow once, at authoring time. The plan has no authority until it is validated and compiled into
   a typed Workflow IR definition (ADR 0011) of deterministic steps, explicit human steps and, only where unavoidable, flagged model
   steps.
2. **A validated workflow runs with no model calls** unless it contains a flagged model step.
3. Compiled workflows are content-hashed and **reused for repeated goals over the same schema** (goal-and-schema key, UW-15). Drift
   detection stops a run before any effect when the incoming data's shape differs from the compiled schema.
4. Corrections become reviewed, signed patches that create a new workflow version; nothing learns silently.

## Reopen if

None (the plan states no reopen condition).
