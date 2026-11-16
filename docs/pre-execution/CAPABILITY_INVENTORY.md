# Capability inventory and the human-task rule (PX-5)

`buildCapabilityInventory` (`@xo/pre-execution`) reports every capability a compilation discovered. It answers the
question a reviewer asks before a workflow can start: _what can this platform actually run, and what is missing?_
(ADR 0029 decisions 8–11; gaps PX-G17 to PX-G20.)

## One report per capability

| Field          | Meaning                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `origin`       | `declared-operation` (an API/OpenAPI operation), `procedure-step` (a step of a procedure the source lays out), or `prose`.                                           |
| `status`       | `rejected` (a reviewer said no) › `duplicate` › `unresolved` (nothing bound) › `unsupported` (bound, no executor) › `accepted` (approved) › `explicit` / `inferred`. |
| `readiness`    | Four independent answers, each `yes`, `no` or `unknown` with its reason. Runnable only when all four are `yes`.                                                      |
| `humanTask`    | The human task contract, when the one rule below gives one.                                                                                                          |
| `parameters`   | Each input and output with its `derivation` (`structured`, `declared`, `inferred`). An inferred required input needs review.                                         |
| `contractHash` | The contract's content hash, the same one approvals bind to.                                                                                                         |

The four answers are never collapsed into one:

- **eligible**: the declaration permits a strategy (rules → `deterministic_rule`, a human task contract →
  `human_in_the_loop`, a declared operation → `external_tool`).
- **bound**: a binding resolved, and to which strategy.
- **runtimeSupported**: the runtime has an executor for that strategy (by default `deterministic_rule` and
  `human_in_the_loop`).
- **authorized**: the capability is approved for its current contract. On the API this is the same approval verdict the
  execution boundary reaches. Without that context it is `unknown`, which is never runnable. Permission is checked again
  when a workflow starts (PX-7).

Things that do not block binding but must be settled before start are listed as `conditions`. Examples: a human task with
no stated role, or an inferred required input.

## The human-task rule (ADR 0029 decision 11)

`humanTaskContractOf` (`@xo/capability-contract`) is the only place that decides whether a step can run as
human-in-the-loop. A contract has a human task contract when:

- it is a **procedure step**. The compiler records the step's own instruction, done-when and owner, so the contract is
  what the source states, or
- it is a **prose capability with no rules and at least one linked action/process knowledge node**. Its source sentence is
  the instruction.

Both produce the same `HumanTaskContract`:

- the instruction, verbatim
- done-when, when stated
- the actor role: `stated`, or `unassigned` (a condition to settle)
- the required inputs
- an outcome schema: `completed`, plus one field per output

`ActionEscalationBindingResolver` binds a contract `human_in_the_loop` exactly when this rule gives one. A step with a
suspected extraction error, an empty instruction or linked rules gets no human task contract. Without one, a step stays
unresolved: nothing becomes an approvable human step just because it reads like an action.

Only procedure-step contracts carry `humanTask` in the contract itself, and so in its content hash. The prose case is
derived from fields every contract already has, so existing contracts and their approvals are unchanged.

## Duplicates and gaps

Two candidates are duplicates only when name, inputs, outputs, rules and source evidence are all equivalent after
normalisation. The first by id is kept. Anything that differs is a variant and stays distinct.

A gap is a capability a goal needs (`needs`, or `?need=` on the API) that no usable candidate provides. A candidate is
unusable when it is rejected, a duplicate or unsupported.

## Surfaces

- API: `GET /workspaces/{ws}/compilations/{id}/capability-inventory[?need=…]`
- CLI: `xo compile <sources> --inventory inventory.json`
