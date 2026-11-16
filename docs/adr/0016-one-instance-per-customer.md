# 0016: One isolated instance per customer (D-G)

## Status

Accepted under owner delegation, 2026-11-13 (UW-0). Signed off 2026-11-13 by Claude under the owner's explicit delegation of sign-off authority (owner instruction of 2026-11-13); this is a delegated sign-off, not an independent review. Implemented by UW-1, UW-9 and UW-17.

## Context

Today one API process serves any number of workspaces with directory isolation and no organization model
(`docs/baseline/UW0_BASELINE.md` §7 row 36). XO_PROTOCOL §15.5 requires tenant isolation that does not depend on network
segmentation alone, and §15.6 requires machine-declarable data residency. The owner wants one isolated instance per customer and data
residency (Revision 4, §0).

## Decision

1. **An instance is one customer organization.** It has its own runner and API process(es), its own data directory (ADR 0023), its
   own keys (approval signing, token encryption, audit anchoring) and its own credential store. No process, key or store is shared
   between customers.
2. **Users and roles live inside the instance** (ADR 0010). Workspaces remain inside an instance as teams or projects.
3. **Residency is a declared instance property** (UW-14): where the instance runs and which model egress it permits.
4. Multi-XO knowledge sharing between instances stays deferred.

## Consequences

- Erasure of a customer is erasure of an instance: data, keys and token maps together (UAC-30, UW-17).
- Per-instance cost is the trade-off; packaging must keep an idle instance small.

## Reopen if

Per-instance cost is unaffordable for the target customers.
