# Goals and workflow generation (PX-6)

A compilation can produce many candidate workflows. PX-6 adds three things:

- a typed **goal** that says which candidate a person means,
- **scope selection** that explains its choice, or asks one question when the goal does not decide,
- one **lowering** function that turns the chosen candidate into Workflow IR, the canonical definition (ADR 0029
  decisions 12 and 13; gaps PX-G21 to PX-G23).

## Goal

`GoalSpecification` (`xo.goal.v1`) has these fields:

- `text`: what the workflow should achieve, in the person's words.
- `needs` (optional): steps the goal requires, by name.
- `section` (optional): the heading the workflow should come from.

`goalDigest` covers the text, needs and section, not who stated the goal.

## Scope selection

`selectWorkflowScope(candidates, goal)` scores each candidate:

- 3 points for each needed step it contains,
- 2 points when its section matches the section hint,
- 1 point for each goal word found in its name, section or step names.

The result is one of three:

- `selected`: one candidate clearly leads. The rationale lists the reasons and the runner-up's score.
- `needs_clarification`: the runner-up is within 15% of the best. One question names the tied candidates. Nothing is
  generated until the person picks one.
- `no_match`: no candidate matches the goal at all.

The old rule, "the workflow with the most steps", is used only by `xo workflow` when no goal is given, and the rationale
says so.

## Lowering

`lowerCandidateWorkflow(graph, candidate, inventory, options)` lowers each step from what its capability report says it
is bound to (ADR 0030):

| Bound strategy       | Workflow IR                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `human_in_the_loop`  | `approve`. The summary is the human task contract's instruction, done-when and role. Required inputs are attached as evidence. `decision` is `approved` or `rejected`. A deadline the step states (`within 2 days`) is the timeout; a timeout escalates, never approves.                                                            |
| `deterministic_rule` | `decide` with `rules`. Each linked rule's structured condition is rendered in the closed expression language (`refund_amount > 500`). No match escalates. A temporal condition or an exception clause has no faithful rendering, so the step is reported.                                                                           |
| `external_tool`      | `act`, only for a declared operation with a workspace connector binding (connector, operation, side effect, adapter). Effectful acts get the idempotency key `{{workflow.id}}:{{run.id}}:{{step.id}}`; the contract's field names are kept. A binding with an undo adds a `compensate` step. Without a binding: reported, blocking. |
| unbound              | Not generated. Reported as blocking.                                                                                                                                                                                                                                                                                                |

A step that states a delay (`wait 24 hours`) is preceded by a `wait`. When a later step is named as the outcome of a
`decide` rule, a `branch` on that decision routes to it. A goal with `intake: "text"` gets a leading `extract` step
that fills the inputs from the run's text; a goal with `forEach: "<item>"` wraps the steps in a `for_each` over the
bounded JSON list input `<item>_items`.

Steps run in the composed order. A step after a human task runs only when the person confirmed that task (`runIf`
on the previous step's decision). If the previous step was skipped, the skip cascades instead of running on an
assumption.

The component is checked with `validateWorkflowComponent`, the validator packages use. Generation never weakens a
construct to make it valid.

The result carries:

- the component,
- a rationale for each step,
- the issues,
- the validation result,
- `definitionDigest`, the SHA-256 of the canonical component. It is stable when the same sources are regenerated.
- `complete`, which is true when every step was generated, the definition is valid and nothing blocks.

`GENERATION_CONSTRUCTS` records, for every Workflow IR construct, the evidence generation needs before it emits it. A
construct without its evidence is reported, never invented.

## Surfaces

- API: `PUT /workspaces/{ws}/connector-bindings` (manage role) states how declared operations are carried out.
  `POST /workspaces/{ws}/compilations/{id}/generated-workflows` with `{ goal: { text, needs?, section?, intake?, forEach? }, workflowId? }`, then
  `GET /workspaces/{ws}/generated-workflows[/{id}]`. A generated workflow is persisted with its digest, under an id that
  covers the compilation, the candidate, the goal and the definition. These are separate from the Studio's authored
  `workflow-definitions`. A certified definition runs through `@xo/workflow-runtime` with
  `POST /workspaces/{ws}/generated-workflows/{id}/runs` (`{ input, certificateId }`; the certificate is always
  required), and its approvals are decided with `POST …/runs/{runId}/approvals/{approvalId}`.
- CLI: `xo generate-workflow <sources> --goal "<text>" [--need <step>]... [--section <heading>] [--intake text] [--for-each <item>] [--connectors bindings.json] [--out workflows.json]`,
  and `xo workflow <source> --goal "<text>"`.
