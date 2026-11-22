# 0049: Steps XO carries out by the operator's binding, and batch items from confirmed sources (V1-1)

## Status

Accepted under the owner's delegation, 2026-11-23. Closes V1-G1 and V1-G2 of the V1 acceptance check (`docs/runtime/V1_ACCEPTANCE.md`). Part 1 (V1-G1) and part 2 (V1-G2) land as two stacked PRs.

## Part 1: a binding with arguments (V1-G1)

### Context

- A customer's procedure says "for each client, email the client their certificate". That compiles to a person's task, because the source declares no operation and the human-task rule (PX-5) applies.
- A connector binding applies only to a declared operation (an OpenAPI source), so binding the step to the email connector changed nothing. XO could not send the email.
- ADR 0030 says side effects come from the operator's bindings, never from sources. That stays the principle: the gap was only that a binding could not say _what_ to send.

### Decision

1. **A connector binding gains `arguments`.** It is a map of the call's argument names to either a field of the item (`{ "field": "email" }`; the run's input without a `forEach`) or a constant the operator wrote (`{ "const": "Your certificate" }`).
   - Validation:
     - names are identifiers;
     - fields are `lower_snake_case`;
     - constants are text (at most 4,000 characters), a number or true/false;
     - at most 32 arguments;
     - `previous_decision` and `route` are reserved.
2. **A binding with arguments makes the step it names an `act` step, whatever the source says**, a person's task or a prose action included. Which steps XO carries out is the operator's decision. Changing a binding already needs the manage role and a recent sign-in, is audited, and is bound into every readiness certificate (a changed binding makes it stale).
   - **The inventory** reports such a step as bound to the connector operation, with the binding's effect class. The human-task condition (assign a role) no longer applies.
   - **Lowering** writes the act step's inputs from the map verbatim: `item.<field>` or `input.<field>` for a field, and a `{ const }` binding for a constant. It adds no "was it done?" escalation, because no person does it. The step's idempotency key, effect authorization, batch approval and the per-call digest check are those of any act step.
   - A binding without arguments behaves as before, so existing bindings and certificates are unchanged.
3. **Nothing is guessed.** XO never infers that a step should be automated, nor which argument comes from which column. A missing field fails the item's call, and the preview shows it before anything is sent.

### Consequences

- The certificate procedure compiles, from its own words plus one binding, into a per-client email send with exactly the arguments the operator mapped. The same mechanism automates any person's task the operator chooses, with any connector.
- **Known follow-up:** other steps in the same procedure that stay a person's task are, in a batch, decided by the batch approval (ADR 0046). That fits approval gates, but not work a person must still do for each item. A per-item human task inside an approved batch is revisited with UW-16 (standing approvals); until then, keep such work out of a batched procedure or bind it too.
