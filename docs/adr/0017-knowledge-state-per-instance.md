# 0017: Knowledge state per instance: SQLite over content-addressed blobs, lifecycle outside the hash (D-H)

## Status

Accepted under owner delegation, 2026-11-13 (UW-0), **conditional on the UW-4 spike** below. Signed off 2026-11-13 by Claude under the owner's explicit delegation of sign-off authority (owner instruction of 2026-11-13); this is a delegated sign-off, not an independent review.

**Supersedes in part ADR 0006**: for per-instance state, the relational store is SQLite with a Postgres adapter for high
availability, instead of a shared Postgres. Blob storage behind `BlobStore` is unchanged. Redis and Neo4j stay unprovisioned by
default; a graph database stays deferred (ADR 0012).

## Context

Persistence is file-only; there is no compare-and-swap, change set or multi-file atomicity for knowledge
(`docs/baseline/UW0_BASELINE.md` §7 rows 12 and 37). ADR 0006 provisioned Postgres, Redis and Neo4j for a shared marketplace platform;
nothing consumes them. ADR 0016 makes each customer an isolated instance, which changes the scale assumption: one organization's
knowledge per store.

## Decision

1. **Lifecycle status is outside a node's content hash** (as `reviewStatus` already is), so approving a claim does not change its
   identity.
2. **Knowledge state id** = a Merkle root over the content hashes of approved claims plus their statuses. Receipts record it (UW-11).
3. **Store:** SQLite per instance, in the instance data directory, holding indexes, statuses and the state log over content-addressed
   blobs, behind the existing storage interfaces, with compare-and-swap on the active state and atomic multi-record writes.
4. **Postgres adapter** only when a customer needs high availability.

## UW-4 spike before building (the plan's own condition)

Confirm on a real fixture: the SQLite binding (`node:sqlite` built into Node 22 versus a native module; prefer no native build if it
meets durability and concurrency needs); crash-injection atomicity of a multi-record activation; and that the state id is
deterministic across rebuilds. If any of these fails, this ADR reopens before UW-4b starts.

## Reopen if

The UW-4 spike fails, or a customer needs multi-writer access that SQLite cannot give.
