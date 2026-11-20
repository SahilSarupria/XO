# Known limitations (read before relying on this baseline)

This is the single list of what is **not** true or **not** verified. Detail lives in `docs/ROADMAP.md`, `docs/ACCEPTANCE_CRITERIA.md`, `docs/SERVER_HARDENING.md`, `docs/CONNECTORS.md` and `docs/WORKFLOW_RUNTIME.md`.

## Measurement

- Nothing about accuracy, latency, cost, CPU or RAM is measured on real traffic or a live model. The only measured results are freight claims on one model and one offline second-domain run (ROADMAP section A).
- Efficiency controls (request coalescing, prompt budget, layer reuse, `--low-resource`, agent wall-clock cap) are tested as mechanisms only. Savings are **not yet measured**. Token counts default to an estimate (characters / 4).
- Every row in `ACCEPTANCE_CRITERIA.md` is a proposal, unmeasured.
- Deferred by instruction: live evals, a second domain or provider, cost and hardware benchmarks.

## Reliability and duplicates

- XO is **not** an exactly-once system. A duplicate external effect is still possible when a destination lies about idempotency, a lookup lags, two runners share one run directory (guarded on one host, advisory only), or an effect happens outside a connector.
- The single-writer guard is advisory, single-host, and not a distributed lease. A reused pid can make a stale lock look live.
- The journal detects tampering, not whole-directory deletion. Anchors cover only entries up to the last anchor, and the sink must be outside an attacker's reach.
- Rate limits are per process. forEach conformance vectors are not written.

## Security

- `xo serve` has had no independent security review and is **not** claimed ready for the public internet: per-address (not per-client) limits, no certificate hot-reload, no log rotation or signing, bearer-token replay if TLS is defeated.
- MCP stdio servers are confined by default on Linux. The bubblewrap path has not run on a real host here (its adversarial tests are skipped without bubblewrap). macOS and Windows have no confinement.
- The older `http` connector resolves DNS and then connects by name (DNS-rebinding race not closed; the webhook connectors close it for themselves). The SQLite driver is synchronous. SMTP is tested only against a fake server.
- Quoted source sentences are scrubbed only in the workflows component and report.

## Automation reach

- Reading approval documents works only for the few sentence shapes the extractor recognises; most policies still need a person to review what was compiled.
- `LayerCache` reuses a loaded package by object identity; mutating a bundle after load is not detected.
- An abandoned model call at the wall-clock cap is not cancelled and may still be billed. A running tool is not interrupted.

## Reading documents (UW-3b; ADR 0027)

- **A manual step is understood, not bound.** A procedure step with no declared operation (TaskTest.pdf's 8 steps) is reported as "Understood, manual step" and stays unresolved. It is not bound to the human-in-the-loop executor. Prose tasks in Aastha.pdf do resolve to human-in-the-loop, because they carry action knowledge references that steps do not. The two paths should agree on how a person-performed step runs; that decision is W2 (workflow execution).
- **Table columns are matched by estimated glyph widths.** UW-3c matches a column on its left edge, its right edge or its centre. Right edges come from standard font metrics, so a table set in an unusual font, or with columns closer than about 4 pt, can still be rejected whole; its lines then stay as prose.
- **Routing is a heuristic, and the language is English.** A section is routed when one kind holds at least 60% of the evidence. The threshold and the cue lists (instruction verbs, prohibition and modal phrases, heading cues) are English and uncalibrated. The document kind is reported as a proposal.
- **Confidence is not calibrated.** Quality penalties (cross-column, label-glued, leaked marker, fragment, unbounded) lower a prior; they are not fitted to measured error rates.
- **The model fallback for unrouted sections is a library function only.** `assistStructure` is off by default, enforces UW-14 residency and validates every proposal, but no product surface calls it yet.
- **Rule-outcome capabilities keep title-cased outcome text** ("The Claim Must Be Routed To An Authorized Manager"). They are decision-tree outcome identifiers pinned by golden expectations; renaming them is a separate golden change.
- **Real documents (UW-3c; ADR 0028).** On fourteen public-domain federal documents in six formats, the blind split reads 114/143 items right (79.7%), and 7 items are still lost without any report. Output precision is 114/168: XO still emits readings nobody labelled. Per format on the blind split: scanned PDF 16/21, PDF 22/29, Word 29/34, web page 20/27, Markdown 18/21. These are English documents about software delivery and administration; they are not a customer's documents. Do not claim that any source ingests correctly.
- **OCR merges words.** A degraded scan can read "Fill in" as "Fillin"; the step is then not recognised and not reported (2 dev items).
- **Bullets assert no order.** Unordered list items never become an ordered workflow; the order is a tie-break, reported as ambiguous precedence. A document that means an order but uses bullets needs a numbered list or an explicit precedence statement.
- **Measured on a small corpus.** The `document-structure` benchmark suite has 7 documents: 6 written for this work (4 PDFs, 2 Markdown) and TaskTest.pdf. Real procedure documents from a pilot are not yet measured.

## Found in UW-0 (main `26f0052`; see `docs/baseline/UW0_BASELINE.md`)

Each item names the workstream that owns the fix. None is fixed by UW-0 except where stated.

- ~~**XOIR node hashes include `createdAt`**~~ Resolved in UW-1: content hashes exclude `createdAt` and are computed over the stored JSON form; every API load of a stored or client-supplied graph verifies hashes; graphs stored under the two earlier schemes still verify. A scheme-0 hash (oldest graphs) does not cover `producedBy`.
- **Orphaned workflow runs** (`@xo/workflow-runtime`): a crash after a run's directory is created and before its first journal entry is durable leaves the run id unusable; `resume` and a second `start` both fail with `unknown run`. No effect has happened in that window. UW-7.
- **Batch status**: a `forEach` run with one failed item reports the parent as `failed` even when the other items completed. UW-7 (partial completion).
- **No cancel operation**: Workflow IR declares `cancellation.onCancel`, but the runner cannot cancel a run. UW-7 (ADR 0024).
- **`workflow-runtime` approvals are not bound to the action's content**: a signed decision covers run, step and approval id only. Inside an instance only the digest-bound primitive grants authority (ADR 0014). UW-8.
- **Authorization (UW-1, ADR 0010):** one authorization point now decides every workspace route; operator grants persist in `_instance/policy.json`; API keys expire and rotate. Remaining: package-scoped `PermissionStore` grants stay in-memory in the API (no API path creates them); the policy file is re-read every 10 s, so a revocation written there takes up to 10 s to apply (API-key revocation is immediate).
- **Audit (UW-1):** per-workspace logs are hash-chained, externally anchored when `XO_AUDIT_ANCHOR_DIR` is set, and purgeable only by a recorded operator purge. The instance-level platform log (`FileAuditStore`, API/CLI/runtime events) is still unchained: it was accepted as a P1.0 limitation by the owner and UW-1 did not change it. Moving it onto the chained store needs segment-based retention there first (the chained store has no purge); until then its tamper evidence is filesystem permissions only.
- **Step-up (UW-1):** an OIDC access token without `auth_time` can never satisfy step-up, so API clients that approve must request tokens that carry it. API keys are exempt from step-up by design (not interactive).
- **Trust boundary (UW-1):** the injection corpus checks are structural (where a payload sits, that it cannot escape its frame, that an obeying answer is refused or needs a human); they do not measure how often a live model is misled (UW-13). A document can state a harmful rule in plain words and the rule validator will accept the proposal; a named reviewer is the control (`specs/security/TRUST_BOUNDARY.md`).
- **Evaluation (UW-13, wave W1 skeleton):**
  - **Every labelled set in the harness is synthetic.** The document-kind set was written with the cue pack in view. The numbers show
    that the mechanisms work, not how XO does on real customer documents.
  - **No threshold is ratified.** Every threshold is a proposal until the owner ratifies it, so nothing gates on accuracy yet.
  - **Live-model evaluation is not in the harness report.** It exists separately for customer intelligence.
  - **Not yet suites:** the benchmark package's cross-domain corpus, the vertical runs and the agent baseline (wave W5).
  - **Four register titles are unconfirmed.** R8, R9, R15 and R16 are not titled in the plan text available.
- **Source connections (UW-12a, ADR 0038):**
  - **Cloud drives and the agent (ADR 0039).** Google Drive in production needs Google's restricted-scope verification and security
    assessment for `drive.readonly`. Google Slides, Forms and other native formats are not read; Docs and Sheets over 10 MB fail to
    export. The agent needs the computer on, and on macOS and Windows someone signed in (Linux starts it at boot).
  - **Discovery is rule-based.** It recognises a list by its name and email columns, and a document collection by its folder and
    file-name words. Name matching knows a fixed list of common short forms; an unknown nickname matches only as the start of the
    first name, and the surname is always needed.
  - **Two instances on one data directory can sync the same connection at once.** The connection's record stays consistent; at worst
    a changed file is stored twice with the same bytes.
  - **Large folders sync in part.** Past 2,000 files, depth 8 or 2 GiB, a sync is partial and retires nothing for being absent.
  - **EI's device-code cloud manager is still in memory.** It is used by no product path; cloud connections will use the UW-9
    broker instead (ADR 0038 decision 6).
- **Residency and egress (UW-14):**
  - **Chat behaviour changed.** Chat with a hosted model (Anthropic, OpenAI, Gemini, Azure) is refused by default, because
    `strict_local` is the default residency. Use a local model (Ollama), or `XO_RESIDENCY=open` for development with test data.
  - **The leak guard knows only the values it was given (UW-14c to 14e, ADR 0037).** It knows the workspace's spreadsheet columns
    that identify someone, the values in its data-protection settings, and Indian identifier patterns. A name XO was never given (in
    free text, a PDF, a chat) is not detected; that needs the deferred NER sidecar (14c-3). A nickname or a spelt-out address
    ("dot", "at") is not detected either.
  - **Hosted chat in `open` mode refuses messages that name the workspace's own clients.** This is deliberate: use test data or a
    local model.
  - **Model work outside an HTTP request has no workspace context.** In `masked_hosted` it is refused; in `open` it is checked
    against the pattern packs only. No scheduled path calls a model today.
  - **Token vaults have no consumer yet.** There is no model step on a data path (R-DET). The vault, its sealed store, its erasure on
    archive and its retention sweep wait for an owner-enabled `needs_model` step (UW-6).
  - **Detection thresholds are proposals.** The `pii-detection` set was written alongside the detectors, so it is not blind.
  - **The dictionary is bounded at 250,000 values per workspace.** The bound is reported, and workbooks are re-read when they change.
  - **Column names are disclosed in schema descriptors.** Exceptions: a header that looks like a value, and any column the caller
    withholds. A schema can be sensitive in itself, and combinations of fields can re-identify people.
  - **Locality is decided by address.** Local means Ollama at a private address or an internal name. An internal name that resolves
    to a public address is not detected.
  - **The command-line tools are outside the instance boundary.** `xo -p`, `xo run --provider` and `xo compile` with AI escalation
    run on the developer's machine, and residency does not govern them.
  - **Compliance artefacts (14f) are owner and counsel items.** These are the data-handling statement, processing agreement, provider
    terms review and legal position on masked data. They are not done.
- **Instance packaging (UW-17):**
  - The provider-neutral deployment template is scheduled for W5 (ADR 0023). This is the infrastructure as code that brings up a
    customer instance from a small config file. Until then a cloud host runs the same image with `compose.yaml` and
    `deploy/instance.env.example`.
  - Storage is local only (files in one data directory). Postgres and object-storage adapters are not written yet.
  - The instance lock is a file on one host. Two hosts sharing one network volume would not see each other's lock.
  - Backups are full archives, not incremental. A `--live` backup is taken while files may be changing; the consistent one needs the
    instance stopped.
  - Erasure removes files and verifies they are gone. It cannot erase what the storage medium, snapshots or backups keep; use an
    encrypted volume for that.
  - Metrics cover HTTP requests, build and process memory only; there are no per-feature metrics (compiles, OCR, workflows) yet.
  - The served Studio accepts a web sign-in return address (`XO_PUBLIC_BASE_URL/auth/callback`). Studio's own web Google sign-in page
    is not built yet; the desktop app and the access-key sign-in work.
  - The production image was not built in the development environment (its network blocks the Docker registry). The CI `image` job
    builds it, smoke-tests it and takes a backup. The same build steps were run outside Docker and the result smoke-tested.
- **Ingestion (UW-3):**
  - Photos are read by local OCR. Quality depends on the photo: a skewed, shadowed or low-resolution shot may read with low
    confidence or not at all, and then stays unread rather than guessed. Local OCR does not correct perspective; vision handles that
    better, but it sends the image off the machine and is off by default. Vision sends JPEG and PNG up to 5 MB only. HEIC (the
    iPhone camera's own format) is not accepted: phone browsers usually convert it to JPEG on upload, but a `.heic` file sent as-is
    is refused (or, as an email attachment, listed as not opened).
  - Email attachments are opened at upload. An email uploaded before UW-3 shipped keeps its old listing until it is uploaded again.
    `.msg` (Outlook's own format) and TNEF (`winmail.dat`) are not read.
  - A headerless table of plain text is taken as having a header.
  - Measured accuracy is on a synthetic labelled set (`docs/INGESTION.md`); accuracy on real customer documents needs a real labelled
    set (UW-13).
  - The API still has its own `.docx` reader beside the compiler's.
- **Entity resolution (UW-5, ADR 0040):**
  - Accuracy is measured only on a synthetic labelled set of 72 cases written with the matcher in view (precision, recall and
    wrong-identity count all at their best value). Real name lists are not measured.
  - Names in non-Latin scripts and unusual transliterations are not covered; the nickname table is fixed.
  - A reordered name ("Rao Asha") resolves as a full-name match.
  - Resolution claims are not executable knowledge until a Domain Knowledge Pack defines the `xo-resolution` namespace.
  - There are no Studio screens; the API takes the item sets from the caller (batch preview wiring is UW-8).
- **Email (UW-10 part a, ADR 0041):**
  - Verified only against local fake SMTP, IMAP, Gmail and Graph servers. Real-provider behaviour (TLS/STARTTLS, OAuth, Message-ID
    handling, throttling, limits) was not verified.
  - Tier 1 (Gmail, Graph) cannot look up a sent message: `gmail.send` and `Mail.Send` cannot search, and the broker has no read-mail
    capability. Until the owner adds one, tier 1 behaves like tier 3 on an unknown outcome. Whether Gmail or Exchange keep our Message-ID is unverified.
  - Graph refuses messages over 3 MB; Gmail large messages use the upload endpoint, untested against Google.
  - Pacing and the daily cap are in memory per connector instance: a restart resets them.
  - Bounces and delivery status are not tracked (DSN parsing is deferred); the transactional-email tier is not built.
  - (UW-10c, ADR 0042) Runs reach the mail connectors through the `email` adapter, verified end to end only against a local fake Gmail with an injected
    credential. STARTTLS/TLS SMTP and IMAP, Graph and real OAuth connections have not been run through a workflow.
  - An app-password connection gets tier 2 only if its host reads `smtp-host[:port]|imap-host[:port]`; otherwise tier 3. There is no dedicated IMAP field.
  - Recipients: confirmed contact lists (re-confirm after the table changes) and explicit rules. UW-5 claims are not read as a recipient source.
  - Typed run inputs are scalars, so a send takes one recipient and one attachment (flat form); a multi-recipient send needs the list form from a step, not the run input.
  - The Studio tier text is not shown yet (the provider-guess route returns it).
  - Email limits are instance-wide settings, not per connection. A connection revoked after a readiness certificate was issued is caught at use time, not by the certificate.
- **Intent composition (UW-6, ADR 0043):**
  - A bare instruction line planted in a source document compiles into a task for a person (or, if it sounds automated, an unbound capability that stops
    composition). It cannot act; each compiled capability must still be approved. Text alone cannot tell it from a genuine step.
  - Needs are matched by name (the inventory's normalisation), not by meaning; a loosely named need is reported as a gap.
  - Free text needs an instance `intentProposer`; none is wired to the UW-14 guard, so the default (`strict_local`) answers 501. Model behaviour was tested only with a scripted proposer.
  - The `needs_model` step and its use of the reversible-token vault are not built (no such IR step); the vault still has no consumer.
  - Composition builds on compiled sources only; it does not compose a workflow from nothing.
- **`.xlsx` is not accepted by the API upload list**, and the merged XLSX reader flattens rows to text (no header detection, column types, dates or cell provenance). CSV has no quoted-field support (documented choice). UW-3.
- **`cht_` chat routes have no client** and are deprecated (ADR 0013); workflows have no conversation link yet. UW-2.
- **Five workflow execution paths and two trigger designs** exist side by side until UW-7 and UW-15 (ADRs 0011, 0025).
- **`@xo/intelligence-c6` is merged but not wired**; the API chat uses its own knowledge port. UW-4c.
- **Capability contracts have no typed outputs or effect class**: extractors emit `outputs: []`. UW-7.

## Known test failures

- None on `26f0052` locally (7,145 tests, 0 failures, 4 opt-in skips; by-name list in `docs/baseline/tests-26f0052.tsv`). The earlier `packages/benchmark` `p09c-closure` (#147) and `baseline.test` (#35) failures and the `apps/api` 40 s cap no longer reproduce.
- GitHub CI on `26f0052` failed on formatting, one flaky `@xo/xoir` test and the Studio visual path filters; all three are fixed on the UW-0 branch.
