# Workflow Readiness Certificate and the start gate (PX-7)

A workflow is ready to start only when everything it depends on has been checked. Those checks cover the sources, the
completeness of what was read, the knowledge it was built against, the goal, every step's binding and approval, and the
workflow definition itself. The certificate records that check, and the start gate repeats it from scratch.

This page covers ADR 0029 decisions 14 and 15, and gaps PX-G24 and PX-G25.

## Statuses and gates

`assessReadiness` (`@xo/pre-execution`) issues `xo.workflow-readiness-certificate.v1` with one gate per concern.

| Gate                  | Blocks (BLOCKED)                                                                          | Needs a person (NEEDS_REVIEW)                                   | Condition (READY_WITH_CONDITIONS)                                |
| --------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `source-quality`      | a source that cannot be relied on, with no waiver                                         |                                                                 | a finding a reviewer waived (one condition per waiver)           |
| `completeness`        | a structurally invalid graph                                                              | open conflicts, unparsed sentences, review items, stale rulings |                                                                  |
| `knowledge`           |                                                                                           | an unresolved conflict in the pinned knowledge state            |                                                                  |
| `goal`                | no workflow matches the goal; the goal selects another one; a need nobody provides        | the goal asks a clarification question                          |                                                                  |
| `capabilities`        | a step that is rejected, a duplicate, not eligible, unbound or unsupported by the runtime | an unassigned role; an inferred required input                  |                                                                  |
| `authorization`       |                                                                                           | a step not approved for its current contract                    |                                                                  |
| `workflow-definition` | a lowering issue; a circular order; conflicting steps                                     | low confidence; an unresolved declared dependency               | a step order the source does not state, which the owner accepted |

The overall status follows this order:

1. Any block makes the certificate `BLOCKED`.
2. Otherwise, any review item makes it `NEEDS_REVIEW`.
3. Otherwise, any condition makes it `READY_WITH_CONDITIONS`.
4. Otherwise it is `READY`.

Mandatory gates never degrade to conditions. There are exactly two declared conditions (ADR 0030): an unstated step
order that the owner accepts, and a waived source-quality finding. A numbered procedure states its own order, so that order is a pass, not a condition.

## When a certificate is required

`XO_READINESS_CERTIFICATE=required` (the production default) makes every start present a current certificate;
`workspace` leaves it to the workspace's `trust.requireReadinessCertificate` and is refused in production unless
`XO_ALLOW_UNCERTIFIED_STARTS=1`. Running a generated workflow's Workflow IR always requires one. Studio obtains the
certificate itself when a start is refused for lack of one, and starts only when it is READY or READY_WITH_CONDITIONS.

## Bindings and staleness

A certificate (policy `xo.readiness-policy.v3`; v2 certificates keep verifying under the whole-state rule until reissued; ADR 0050) binds the digest of every input its status depends on, including the
connector bindings its steps use:

- the source set
- the compilation artifact
- the XOIR graph
- the knowledge state (or `null`)
- the capability inventory, which includes each step's approval status
- each step's contract hash
- the workflow definition
- the goal
- the waivers and rulings applied
- the readiness policy version

The certificate's own digest covers all of the above. Its id is `wrc_` plus 24 hex characters of that digest.

`verifyReadinessCertificate(certificate, currentBindings)` refuses a certificate in any of these cases:

- it does not match its own digest
- its status does not allow a start
- it was issued under another policy version
- any binding differs from the current one

Each refusal names what changed. For example: "stale: the knowledge state changed since the certificate was issued".

## API

- `POST /workspaces/{ws}/generated-workflows/{id}/readiness` with `{ acceptUnstatedStepOrder? }` issues a certificate.
  - The server recomputes everything itself. Nothing the client sends becomes part of the assessment.
  - Accepting an unstated order needs the review role and a recent sign-in.
  - The action is audited as `readiness.certificate.issued`.
- `GET /workspaces/{ws}/readiness-certificates[/{id}]` lists certificates, or returns one.
- `GET /workspaces/{ws}/readiness-certificates/{id}/verify` makes the same check as the start gate.
- **Start gate:** `POST /workspaces/{ws}/workflows/{wf}/executions` accepts `certificateId`.
  - The certificate must be for that exact compilation and workflow, intact, and current.
  - If it fails any of these checks, the response is `409 XO_READINESS_CERTIFICATE_REFUSED`, with the reasons and an
    audit event `readiness.start.refused`.
  - When the workspace setting `trust.requireReadinessCertificate` is on, a start without a certificate gets
    `409 XO_READINESS_CERTIFICATE_REQUIRED`. The setting is off by default, so existing starts are unchanged until an
    owner turns it on.
  - Permission is still rechecked live for every step.

## Sign-off binds to what the steps are

The workflow-controls sign-off identity (`contentHash`) now includes each step's contract hash, not just the step ids and
their order. If a step's contract changes under the same id (its rules, its inputs, its human task), the sign-off becomes
stale and has to be given again (gap PX-G25).

## CLI

`xo generate-workflow <sources> --goal "<text>" --certify [--certificate cert.json]` assesses readiness locally and prints
every gate. The CLI has no workspace approvals, so authorization is `unknown` and a local certificate is never `READY`. It
says what a workspace would still need.
