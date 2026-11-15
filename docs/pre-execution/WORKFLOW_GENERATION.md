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

`lowerCandidateWorkflow(graph, candidate, inventory)` lowers each step from what its capability report says it is bound
to:

| Bound strategy       | Workflow IR                                                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `human_in_the_loop`  | `approve`. The summary is the human task contract's instruction, done-when and role. Required inputs are attached as evidence. `decision` is `approved` or `rejected`. A timeout escalates; there is never an auto-approve.                               |
| `deterministic_rule` | `decide` with `rules`. Each linked rule's structured condition is rendered in the closed expression language (`refund_amount > 500`). No match escalates. A temporal condition or an exception clause has no faithful rendering, so the step is reported. |
| `external_tool`      | Not generated. The host binds connector operations and their side effects; generation never guesses them.                                                                                                                                                 |
| unbound              | Not generated. Reported as blocking.                                                                                                                                                                                                                      |

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

`GENERATION_CONSTRUCTS` records which Workflow IR constructs generation emits and why the others are authored rather
than generated: branch, act, wait, compensate, for_each and extract.

## Surfaces

- API: `POST /workspaces/{ws}/compilations/{id}/generated-workflows` with `{ goal, workflowId? }`, then
  `GET /workspaces/{ws}/generated-workflows[/{id}]`. A generated workflow is persisted with its digest, under an id that
  covers the compilation, the candidate, the goal and the definition. These are separate from the Studio's authored
  `workflow-definitions`.
- CLI: `xo generate-workflow <sources> --goal "<text>" [--need <step>]... [--section <heading>] [--out workflows.json]`,
  and `xo workflow <source> --goal "<text>"`.
