# 0049: Steps XO carries out by the operator's binding, and batch items from confirmed sources (V1-1)

## Status

Accepted under the owner’s delegation, 2026-11-23. Closes V1-G1 and V1-G2 of the V1 acceptance check (`docs/runtime/V1_ACCEPTANCE.md`), as two stacked PRs: part 1 (V1-G1, #52) and part 2 (V1-G2).

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

## Part 2: items from confirmed sources (V1-G2)

### Context

- XO reads a connected folder, proposes "a client list" and "each client's certificate" with counts of what matches, and a person confirms or rejects each proposal (UW-12a, ADR 0038).
- Nothing turned a confirmed pairing into the items of a batch. The caller assembled them by hand, and Studio started once-per-item workflows with an empty input.

### Decision

1. **A batch preview can name its items by source.** It takes `items: { connectionId, proposalId }`: a confirmed client list (or any table) or a confirmed "each person's document" pairing. XO builds the items itself, from the stored versions of the connection's current files.
   - One item per row. Each column becomes a field: its header in lower snake case, kept unique.
   - For a pairing, each item also gets the row's document: `document_sha256`, `document_name` and `document_type`. The sha256 is the workspace source that `message.send` attaches.
   - The items fill the workflow's `forEach.over` input. Giving that input as well is refused.
2. **Nothing is guessed.** A row gets a document only when exactly one file in the folder names that row's person, using the same name matcher and tiers as discovery. A row is left out, and listed with its reason, when:
   - no document names the person;
   - more than one does;
   - the same name is on several rows;
   - it has no name;
   - it is empty.
     A document that names no one, or several people, is listed as well. These do not become items that stop mid-run: the approver sees them in the preview before anything is sent, and a run holds only what can be done. Rows matched only by another spelling, a short form of the first name or initials are counted, so the approver can check them in the preview.
3. **Only a confirmed source, and only one that fits.**
   - A proposal that is not confirmed, or is retired, is refused (412).
   - A source that lacks a field the workflow reads for each item (`item.<field>` in its inputs or keys) is refused, naming the missing fields.
   - A source whose files changed since it was confirmed may still be used. The preview says so: the batch approval, over every item's exact arguments, is the gate.
4. **The start checks the items again.** A start with the batch approval rebuilds the items from the same source and compares them with the approved input digest. A replaced certificate, a changed list, or a pairing no longer confirmed refuses the start (`source_changed`, `source_unavailable`) before anything is sent.
5. **Studio uses the confirmed source.** `GET …/item-sources` lists the confirmed lists and pairings, with the fields each gives, how many items and exclusions, and whether it fits. Studio's start prepares the preview from the one source that fits. When none fits, or more than one does, Studio says so in plain words and prepares nothing: XO does not choose between a person's lists. The Inbox shows the reviewer where the items came from and what was left out, and why.

### Consequences

- The certificate flow runs from a connected folder and the customer's procedure, with nothing supplied by the caller (UAC-38). The mechanism names no vertical: an invoice list paired with its PDFs, or any table, works the same way.
- **Follow-ups:**
  - A schedule that names an item source (so each scheduled run builds its items at its time) comes with UW-16 (standing approvals). **Closed by ADR 0051** (`schedule.items`).
  - Choosing between several fitting sources in Studio, rather than rejecting the others, is a UX follow-up.
  - Items from a record set uploaded directly as a source, not through a connection, are not offered: a connection is where a person confirms what a table is.

## Amendments

- **A person's task inside a batched procedure: closed by ADR 0051.** A batch approval no longer decides every approval step; the approver names the steps it decides, and every other step waits for a person in each item.
