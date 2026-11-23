# V1 acceptance check (certificate distribution)

Checked 2026-11-23 on `main` at the merge of #50, plus this branch; checked again the same day after V1-1 (ADR 0049, #52 and its follow-up), which closed V1-G1 and V1-G2. The plan's V1 exit (Revision 4, B.13.4 and section 9) needs UAC-1 to 10, 14 to 17, 19 (for the V1 data), 24 to 26, 31 to 33 and 38 to hold on the integrated branch, with CI evidence.

**Verdict: V1 exits on the owner's items alone.** 21 of the 22 criteria are met, 4 of them with conditions. One is not met yet, and no code is needed for it:

- **UAC-19** (accuracy on the V1 data, against thresholds the owner ratified first) cannot be measured until there is a labelled V1 sample (V1-G4).

The flow runs end to end through the API with nothing supplied by the caller (`apps/api/test/v1-certificate-flow.test.ts`):

1. A connected folder holds the client list and the certificates, and a person confirms "each client's certificate".
2. The customer's procedure is in plain words. The send step is bound once, with its arguments.
3. XO builds the items from the confirmed pairing and leaves out the client who has no certificate, saying so.
4. A second person approves the preview.
5. XO sends exactly what was approved.
6. The manifest, the signed audit bundle and replay all follow.

What remains is the owner's: the labelled sample (V1-G4), one run against a provider sandbox (V1-G5), and one green CI run on the merge (V1-G6).

How to read the evidence: each line names a test file and the start of a test's title. `apps/api/test/scenario-index.test.ts` checks this file the same way it checks the scenario index, so a renamed or deleted test fails CI.

## The gaps

| Id    | Gap                                                                                                                                                                                                                                                                                                                                                                                                                              | Blocks         | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1-G1 | **A plain-language send compiles to a person's task.** "For each client, email the client their certificate" becomes a human task: XO sends nothing, and binding that capability to the email connector changes nothing. XO sends only through a declared operation (an OpenAPI source). A customer's procedure document never declares one.                                                                                     | UAC-38         | **Fixed by V1-1 (ADR 0049, part 1):** a connector binding can carry `arguments`, each from an item field or a constant the operator wrote. A binding with arguments makes the step it names an `act` step through that connector, whatever the source calls it. XO never guesses which step to automate or which column is which argument.                                                                                                                                                                                                                                                      |
| V1-G2 | **The batch's items are the caller's input.** XO reads the client list into a record set (UW-3), proposes "a client list" and "one certificate per person" with matched, unmatched and ambiguous pairs (UW-12a), and resolves people (UW-5). Nothing turns a confirmed list and its matched certificates into the items of a run. Studio starts a workflow with an empty input, so a batch cannot be started from Studio at all. | UAC-38         | **Fixed by V1-1 (ADR 0049, part 2):** a preview takes `items: { connectionId, proposalId }` and XO builds the items from a confirmed list or pairing: one per row, plus the row's one document for a pairing. Rows without exactly one document are left out and listed with why, so the approver sees them before anything is sent. A start rebuilds the items and refuses if the files changed. Studio's start uses the one confirmed source that gives what the workflow reads, and says so when there is none or more than one. Schedules that name an item source are a follow-up (UW-16). |
| V1-G3 | The batch preview did not say which email tier it sends in.                                                                                                                                                                                                                                                                                                                                                                      | UAC-32         | **Fixed in this branch:** each sender in a preview carries its tier and the plain-words explanation, and Studio's batch view shows it.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| V1-G4 | No labelled V1 sample. Entity-resolution thresholds are ratified on a synthetic set; the tabular-reading thresholds are still proposals.                                                                                                                                                                                                                                                                                         | UAC-19         | Owner: provide a labelled sample (a real client list and certificate folder, anonymised if needed) and ratify the thresholds before it is measured. The harness (`npm run eval`) already measures and gates.                                                                                                                                                                                                                                                                                                                                                                                    |
| V1-G5 | Email and OAuth are proven against local fakes of Gmail, Graph, SMTP and IMAP, not provider sandboxes.                                                                                                                                                                                                                                                                                                                           | UAC-14, UAC-15 | Owner: register the Google and Microsoft apps (see `XO_WORKSTREAM_PROGRESS.md`, "For the owner") and run the flow once against a sandbox mailbox. No code change is expected.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| V1-G6 | CI on `main` failed its format check (six files from W3). Earlier full CI runs were cancelled by newer pushes.                                                                                                                                                                                                                                                                                                                   | CI evidence    | **Fixed in this branch** (formatting only). The V1 exit needs one green CI run on the merge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

V1-G1 and V1-G2 were generic, and so are their fixes. They use no certificate-specific code and serve V2 (invoice reconciliation) and V3 the same way. They landed as **V1-1**, two stacked PRs, and this check was run again after them.

## UAC-1. Creating a workflow from a prompt leaves installs unchanged and adds one Workflow entity — Met

- `apps/api/test/workflow-entities.test.ts` › UAC-1: a workflow created from a conversation prompt is one new Workflow entity with originConversationId; nothing is installed

## UAC-2. Reopening a conversation shows its workflows; runs continue with chat closed; all survive restart — Met

- `apps/api/test/workflow-entities.test.ts` › UAC-2: reopening shows state, approvals and history; the run continues with the chat deleted, and everything survives a restart

## UAC-3. Multi-sheet workbooks: headers, column types, cell provenance; malformed workbooks fail safe — Met

- `packages/compiler/test/tabular/records.test.ts` › multi-sheet workbook: title rows are skipped, the header is found per sheet, columns are typed, every value cites its cell
- `packages/compiler/test/tabular/xlsx.test.ts` › hostile or broken workbooks are refused loudly with the reason
- `apps/api/test/source-ingest.test.ts` › UW-3 upload .xlsx: read into record sets at the door

## UAC-4. Unreadable pages are flagged, never guessed; each extracted field cites page or quote — Met

- `packages/pre-execution/test/source-quality.test.ts` › findings: unread pages, model-only pages, degraded and blocked text each get a stable key
- `packages/pre-execution/test/source-quality.test.ts` › a partial source blocks approval and readiness until a waiver covers every finding
- `packages/workflow-runtime/test/extract.test.ts` › REFUSES (escalates) a quote that is not in the text, however plausible the value
- `packages/compiler/test/extraction/image-recovery.test.ts` › a photographed certificate is read by an image-capable tier and compiles as a document marked as recovered text

## UAC-5. A same-name pair is Ambiguous; similarity never auto-confirms; cardinality and unmatched reported — Met

- `packages/knowledge-base/test/resolution.test.ts` › a same-name pair with no distinguishing evidence is Ambiguous
- `packages/knowledge-base/test/resolution.test.ts` › similarity never auto-confirms
- `packages/knowledge-base/test/resolution.test.ts` › unmatched sets are reported on both sides
- `packages/knowledge-base/test/resolution.test.ts` › cardinality validation names the items, and catches links a person confirmed

## UAC-6. The composer yields validated, typed workflows for V1 to V3 with no vertical code — Met with conditions

Composition is generic and validated. The condition: a step XO carries out through a connector needs the operator's binding with arguments when the source declares no operation (ADR 0049); XO does not infer it.

- `packages/pre-execution/test/lowering-constructs.test.ts` › V1-1: a binding with arguments makes a person's task an act step
- `packages/pre-execution/test/intent.test.ts` › three unrelated verticals compose into validated, typed workflows with the same generic code
- `packages/pre-execution/test/intent.test.ts` › the generic composition code names no vertical
- `packages/pre-execution/test/intent.test.ts` › a missing capability is a gap, never guessed around; nothing is composed
- `packages/pre-execution/test/intent.test.ts` › model output has no authority

## UAC-7. Any change after approval invalidates it; approvals are single-use — Met

- `apps/api/test/batch-approval.test.ts` › UAC-7: a change after approval (a recipient in the input, the sending binding) refuses the start; nothing is sent
- `apps/api/test/batch-approval.test.ts` › UAC-7: immediately before each call, the actual arguments must equal what was approved
- `apps/api/test/batch-approval.test.ts` › UAC-7: a 300-item batch is previewed exactly, approved once by someone else, and sends exactly what was approved

## UAC-8. A 300-item batch with a mid-batch connection loss: no blind resend; unknown outcomes block until reconciled — Met

- `apps/api/test/run-cancellation.test.ts` › UAC-8 / UAC-9: a 300-item batch that loses its connection mid-way never re-sends; unknown outcomes block until a person reconciles them
- `packages/connectors/test/mail.test.ts` › UAC-8: 300 sends with a connection loss mid-batch: one unknown, no blind resend, no duplicates

## UAC-9. Effect states and the delivery projection are distinguishable in the run report — Met

- `packages/workflow-runtime/test/effects.test.ts` › maps only onto the six owner-approved states, and every state is reachable
- `packages/workflow-runtime/test/effects.test.ts` › only an outcome, a lookup or a person confirms
- `packages/connectors/test/mail.test.ts` › Microsoft Graph: MIME send keeps the Message-ID, 202 is accepted not delivered

## UAC-10. Under an empty policy every execution path is denied; one decision point; every decision audited — Met

- `apps/api/test/single-authorization-point.test.ts` › every workspace path group (API, chat, AI conversations, procedures, workflows, audit) is decided by the one authorization point
- `apps/api/test/single-authorization-point.test.ts` › fail closed: a policy that throws denies
- `apps/api/test/authorization.test.ts` › execute: declared permission — denied without a rule, allowed with a principal-scoped rule, denied for another principal
- `packages/permissions/test/manager.test.ts` › manager.check: default-deny when no policy rule and no grant exist
- `apps/api/test/generated-run-boundary.test.ts` › effects are authorized when they happen: a pause, a lost role or a changed binding while a run waits stops the effect, and nothing is sent
- `apps/api/test/generated-run-boundary.test.ts` › cross-workspace: another workspace's member gets 404 for a generated workflow's runs, and cannot start it through their own workspace

## UAC-14. OAuth least privilege; tokens encrypted per tenant; refresh and revocation; cross-tenant denied — Met with conditions

Proven against a local fake of Google's endpoints. A provider-verified app is an owner item (V1-G5).

- `apps/api/test/credentials.test.ts` › connect with OAuth: PKCE, least-privilege scopes, tokens sealed, nothing secret ever returned
- `apps/api/test/credentials.test.ts` › cross-tenant matrix: another workspace, another person and a lower role cannot see, use, revoke or complete
- `packages/connectors/test/credentials.test.ts` › a refresh the provider refuses ends the credential; nothing uses it until it is reconnected

## UAC-15. Native email sends an attachment; the hash is re-verified at send; Message-ID lookup precedes any resend — Met with conditions

Proven against local fakes (V1-G5).

- `packages/connectors/test/mail.test.ts` › Gmail: native send (JSON and upload paths), lookup by Message-ID, and no lookup without a read capability
- `packages/connectors/test/mail.test.ts` › attachment substitution, a missing file and an oversize total are refused before anything is sent
- `packages/connectors/test/mail.test.ts` › tier 2 unknown outcome: a dropped connection is unknown, and the Sent lookup settles it either way without a resend
- `apps/api/test/email-send-run.test.ts` › a certificate-gated run sends an email with a hash-bound attachment through the bound email adapter

## UAC-16. Chat shows discovered sources and workflow state; approve and inspect only through the control API — Met

- `apps/api/test/source-connections.test.ts` › UW-12a discovery: the conversation opens with what was found and asks what to do
- `apps/api/test/workflow-entities.test.ts` › UAC-2: reopening shows state, approvals and history
- `apps/api/test/intelligence-routes.test.ts` › a Viewer asking XO to act, approve or delete changes nothing but conversation, learning-queue and audit stores; DO only proposes
- `apps/api/test/batch-approval.test.ts` › UAC-7: a 300-item batch is previewed exactly, approved once by someone else

## UAC-17. The injection corpus never changes composition, recipients or approvals — Met

- `packages/pre-execution/test/intent-injection-corpus.test.ts` › a payload in the goal text, a section hint or a model proposal never changes the composed definition
- `packages/pre-execution/test/intent-injection-corpus.test.ts` › a payload planted in the source document can add at most a person
- `packages/workflow-runtime/test/injection-corpus.test.ts` › a model that follows a payload and asserts an ungrounded value is refused, not believed

## UAC-19. Accuracy on the V1 data, measured against thresholds the owner ratified beforehand — Not met

The harness measures, and gates on ratified thresholds. There is no labelled V1 sample to measure (V1-G4).

## UAC-24. Canary values never appear in any outbound model request — Met

- `apps/api/test/data-protection.test.ts` › UAC-24: canaries from the workspace’s spreadsheet never reach a hosted model, whatever channel they arrive in

## UAC-25. strict_local makes no outbound model or vision connection; production refuses open mode — Met

- `apps/api/test/residency.test.ts` › UAC-25 strict_local: chat with a hosted model is refused before anything is sent
- `apps/api/test/residency.test.ts` › open residency is refused in production by the server and by start-up settings

## UAC-26. Model output cannot change recipients, attachments or amounts; bad placeholders rejected; token maps erased — Met

- `apps/api/test/data-protection.test.ts` › UAC-26: token vaults are sealed per workspace, kept for their retention, swept after it, and erased on archive
- `packages/pre-execution/test/intent.test.ts` › model output has no authority
- `apps/api/test/batch-approval.test.ts` › UAC-7: immediately before each call, the actual arguments must equal what was approved

## UAC-31. Cancelling a 300-item batch mid-run — Met

- `apps/api/test/run-cancellation.test.ts` › UAC-31: cancelling a 300-item batch while another request drives it
- `packages/workflow-runtime/test/cancel.test.ts` › no item starts after the cancel; settled items stand; in-flight items are confirmed; the rest are stopped; a repeat is harmless

## UAC-32. The same definition sends through all three tiers; the preview shows the tier — Met

The tier in the preview was added on this branch (V1-G3).

- `packages/connectors/test/mail.test.ts` › the same send goes through all three tiers with the same arguments and the same Message-ID (UAC-32)
- `apps/api/test/v1-certificate-flow.test.ts` › UAC-32: the batch preview says which tier an email binding sends in, in plain words
- `apps/studio/test/ui/control-surface.test.tsx` › shows the batch (counts, sending account, exceptions first)

## UAC-33. Tier 2 settles an unknown outcome by Sent-folder lookup; tier 3 waits for a person — Met

- `packages/connectors/test/mail.test.ts` › tier 2: SMTP sends an attachment with the deterministic Message-ID, and the Sent folder lookup finds it
- `packages/connectors/test/mail.test.ts` › tier 2 unknown outcome: a dropped connection is unknown, and the Sent lookup settles it either way without a resend
- `apps/api/test/email-send.test.ts` › the tier an email connection sends in, and whether it can look up a sent message, follow from its record

## UAC-38. The full certificate flow runs on a laptop from xo up, all data in one directory, no other network use — Met with conditions

The instance side holds: one data directory, `xo up`, and strict-local by default. The flow runs end to end through the API, from a connected folder and the customer's own procedure, with nothing supplied by the caller. The condition: the provider is a local fake of Gmail until the owner's sandbox run (V1-G5).

- `apps/api/test/v1-certificate-flow.test.ts` › V1: the certificate flow runs end to end through the API with production approval rules, sending exactly what was approved
- `apps/api/test/v1-certificate-flow.test.ts` › V1-G1: a plain-language
- `apps/api/test/v1-certificate-flow.test.ts` › V1-G2: a certificate replaced after the batch was approved stops the start
- `packages/connect/test/source-items.test.ts` › each person’s document: exactly one document per row
- `apps/cli/test/instance.test.ts` › xo up: a complete local instance on one port
