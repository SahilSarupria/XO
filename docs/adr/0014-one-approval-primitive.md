# 0014: One approval primitive: digest-bound, fail-closed when stale, single-use (D-E)

## Status

Accepted under owner delegation, 2026-11-13 (UW-0). Signed off 2026-11-13 by Claude under the owner's explicit delegation of sign-off authority (owner instruction of 2026-11-13); this is a delegated sign-off, not an independent review. Implemented by UW-1 (step-up), UW-8 (batch) and UW-16
(standing approvals).

**Point 5 supersedes part of an earlier owner instruction, by owner delegation.** P1.1 owner decision O-1 (2026-10-17) said: "The
starter and approver may be the same principal. Do not introduce a configurable or default-on approver != starter rule", and P1.1
delegated decision D6 kept that. On 2026-11-13 the owner, shown this conflict, delegated the choice ("u decide the best solution").
Point 5 is that decision: self-approval stays possible where it is the only option, independence is the default where it is possible.

## Context

`main` has four approval mechanisms (`docs/baseline/UW0_BASELINE.md` §7 row 27):

- P1.0 capability approval (`verifyApproval`, bound to the derived capability state, re-verified at use);
- P1.1 payload approval (`@xo/adapters`: `actionDigest` over capability, adapter configuration and exact input; atomic single-use
  `consume`);
- `@xo/workflow-runtime` signed decisions (Ed25519; bound to run, step and approval id, **not to the action's content**, per the UW-0
  spike);
- Studio sign-off in `workflow-controls` (not cryptographic; one admin can author and review).

The certificate vertical needs one approval over a 300-item batch that any change invalidates. Standing approvals (UW-16) need a
signed, independent sign-off to extend.

## Decision

1. **One primitive.** An approval is a record bound to a digest of exactly what the approver saw: a capability state, one action, or
   a batch manifest root. Verification at use recomputes the digest; any difference, a missing record or an unreadable store fails
   closed. Consumption is atomic and single-use per dispatch key. The existing P1.0 and P1.1 contracts already have these properties
   and become the two original scopes of this primitive.
2. **Batch scope (UW-8).** A batch approval signs a manifest root over the ordered items `(recipient, attachment content hash, message
digest, sender identity, adapter configuration digest)`. The runner consumes it per item; the attachment hash is re-verified at
   dispatch.
3. **Signed records.** Each approval record is signed with the instance's approval key and written to the hash-chained audit store, so
   standing approvals (UW-16) and Studio sign-off rest on a verifiable record rather than a flag.
4. **Step-up.** Every approval requires fresh re-authentication of the approver (UW-1).
5. **Separation of duties for effects (instance policy `approverIndependence`).** Default `when_possible`: an approval that authorizes
   an external effect (single action, batch, standing) must come from a principal other than the author of what is approved whenever
   the instance has another principal eligible to approve it. With only one eligible approver, self-approval is allowed with step-up
   and is recorded, previewed and reported as **self-approved**. An admin may set `not_required` for single-action and batch approvals
   (the change itself needs step-up and is audited); **standing approvals always require an independent approver when one exists**,
   because their blast radius is larger. Capability-state approvals (no effect) are unchanged. Rationale: four-eyes by default is
   what enterprise buyers and auditors expect (SPECIFICATION §10, "version approval gates"; master context §22, "record the approving
   principal"), while a one-person firm can still operate; the relaxation is explicit and visible, never silent.
6. **Service principals never approve an effect.**
7. **Standing approvals extend this primitive** with hard limits (UW-16) and never bypass it.
8. `@xo/workflow-runtime`'s local decisions grant no authority inside an instance (ADR 0011).

## Consequences

- Studio's practice sign-off and the runtime line's reviewer roles fold into one auditable record.
- Changing a recipient, an attachment or a message body after approval always forces a new approval.

## Reopen if

Separation of duties proves unworkable for a customer type, or the owner restates O-1 for effectful approvals.
