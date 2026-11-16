# UW-0 baseline and re-verification (main `26f0052`)

Date: 2026-11-13. Workstream: UW-0 of _XO Generic Intelligence and Execution: Workstream Plan (Revision 4)_. This file replaces the
plan's section B.3 (repository baseline) and re-verifies its section B.6 (architecture assessment) on the integrated tree. The
decisions that follow from it are ADRs 0010 to 0025 (`docs/adr/`).

Evidence tags: **[RUN]** observed by running a command in this session · **[V]** verified by reading the code in this session ·
**[P]** taken from a project record in the repo, not re-verified · **[NV]** not verified.

## 1. Tree and environment

| Item         | Value                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Commit       | `26f005234b91b61696ef710b24e2fe739a44a2b1` (`main`), tag `baseline-pre-merge` = `cca4e74` [RUN]                                   |
| Remote heads | `main` only. The plan was written against `30a78e5` with 12 heads; the parallel lines have since been merged (G0 steps 1–2) [RUN] |
| Runtime      | Node v22.23.4, npm 10 (the repo declares `>=22.15.0`) [RUN]                                                                       |
| Install      | `npm ci`: 583 packages, exit 0 [RUN]                                                                                              |
| Clone        | Shallow (`--depth 1`); ahead/behind counts against older heads were not recomputed                                                |

## 2. Gate results

| Gate                             | Local result on `26f0052`            | GitHub at `26f0052`                                        | After this branch                            |
| -------------------------------- | ------------------------------------ | ---------------------------------------------------------- | -------------------------------------------- |
| Build (`npm run build`)          | exit 0 [RUN]                         | passed in the Release job                                  | unchanged                                    |
| Typecheck (`tsc -b`)             | exit 0 [RUN]                         | passed                                                     | unchanged                                    |
| Lint (`eslint --max-warnings=0`) | exit 0 [RUN]                         | passed                                                     | unchanged                                    |
| Format (`prettier --check .`)    | **17 files fail** [RUN]              | **CI run 43305793674 failed here**                         | clean [RUN]                                  |
| Tests (`npm test`)               | 7,145 tests, 0 fail, 4 skipped [RUN] | **Release run 43305793816 failed**: 1 `@xo/xoir` test      | stabilised; see §5                           |
| Studio visual workflow           | n/a                                  | **run 43305796435 failed** at its path-filter safety check | path filters regenerated; check passes [RUN] |

All three GitHub workflows on `main` were red at `26f0052` [RUN, `gh run view`]. None of the causes is a product defect except the one
the flaky test exposes (§5). Fixes on branch `uw-0/baseline-and-decisions`:

1. **Format:** `prettier --write` on the 16 offending tracked files (whitespace and line breaks only), and removal of
   `packages/compiler/rn.tmp.mts`, a stray debug script committed in `26f0052` that imported from `apps/cli/dist`.
2. **Studio visual:** the workflow's `paths:` filters were regenerated with the repo's own
   `node apps/studio/visual/check-trigger-paths.mjs --print` (nine packages Studio now depends on were missing).
3. **xoir test:** see §5.

The Studio visual job's later steps (screenshots) never ran on GitHub because the path check failed first; they were not run here
either [NV].

## 3. Tests by workspace (`26f0052`, before any change on this branch)

Counts are TAP `# tests` summaries for `node:test` workspaces and the Vitest summary for `@xo/studio` [RUN].

| Workspace                      |    Tests |     Pass |  Fail | Skipped |
| ------------------------------ | -------: | -------: | ----: | ------: |
| `@xo/ab-eval`                  |       84 |       84 |     0 |       0 |
| `@xo/adapters`                 |       60 |       60 |     0 |       0 |
| `@xo/ai-core`                  |      431 |      430 |     0 |       1 |
| `@xo/atlas`                    |       71 |       71 |     0 |       0 |
| `@xo/audit`                    |       66 |       66 |     0 |       0 |
| `@xo/automation`               |       31 |       31 |     0 |       0 |
| `@xo/benchmark`                |      228 |      228 |     0 |       0 |
| `@xo/capability-contract`      |      210 |      210 |     0 |       0 |
| `@xo/capability-layer`         |       88 |       88 |     0 |       0 |
| `@xo/compiler`                 |     1382 |     1380 |     0 |       2 |
| `@xo/compiler-core`            |        1 |        1 |     0 |       0 |
| `@xo/config`                   |        6 |        6 |     0 |       0 |
| `@xo/connect`                  |       47 |       47 |     0 |       0 |
| `@xo/connectors`               |      167 |      166 |     0 |       1 |
| `@xo/crypto`                   |        8 |        8 |     0 |       0 |
| `@xo/di`                       |        6 |        6 |     0 |       0 |
| `@xo/environment-intelligence` |      520 |      520 |     0 |       0 |
| `@xo/errors`                   |        6 |        6 |     0 |       0 |
| `@xo/graph-engine`             |        6 |        6 |     0 |       0 |
| `@xo/graph-ui`                 |      269 |      269 |     0 |       0 |
| `@xo/intelligence`             |       36 |       36 |     0 |       0 |
| `@xo/intelligence-c6`          |        7 |        7 |     0 |       0 |
| `@xo/intelligence-eval`        |        9 |        9 |     0 |       0 |
| `@xo/logger`                   |        4 |        4 |     0 |       0 |
| `@xo/marketplace-world`        |       40 |       40 |     0 |       0 |
| `@xo/observability`            |        4 |        4 |     0 |       0 |
| `@xo/package-sdk`              |      249 |      249 |     0 |       0 |
| `@xo/permissions`              |      148 |      148 |     0 |       0 |
| `@xo/procedure`                |       34 |       34 |     0 |       0 |
| `@xo/registry`                 |       42 |       42 |     0 |       0 |
| `@xo/registry-core`            |        2 |        2 |     0 |       0 |
| `@xo/runtime`                  |      502 |      502 |     0 |       0 |
| `@xo/runtime-core`             |        3 |        3 |     0 |       0 |
| `@xo/sdk`                      |       13 |       13 |     0 |       0 |
| `@xo/serialization`            |        5 |        5 |     0 |       0 |
| `@xo/server`                   |       71 |       71 |     0 |       0 |
| `@xo/storage`                  |        9 |        9 |     0 |       0 |
| `@xo/testing`                  |        3 |        3 |     0 |       0 |
| `@xo/types`                    |        9 |        9 |     0 |       0 |
| `@xo/workflow-composer`        |       52 |       52 |     0 |       0 |
| `@xo/workflow-ir`              |       48 |       48 |     0 |       0 |
| `@xo/workflow-runtime`         |      157 |      157 |     0 |       0 |
| `@xo/xoir`                     |      124 |      124 |     0 |       0 |
| `@xo/api`                      |      742 |      742 |     0 |       0 |
| `@xo/cli`                      |      364 |      364 |     0 |       0 |
| `@xo/mcp`                      |       49 |       49 |     0 |       0 |
| `@xo/studio`                   |      732 |      732 |     0 |       0 |
| **Total**                      | **7145** | **7141** | **0** |   **4** |

### Skipped tests (all opt-in by design, none hides a failure) [RUN]

| Workspace        | Test                                                      | Why it skips                                        |
| ---------------- | --------------------------------------------------------- | --------------------------------------------------- |
| `@xo/ai-core`    | live: one tiny Gemini call succeeds and reports usage     | needs `XO_LIVE_GEMINI_TEST=1` and `GEMINI_API_KEY`  |
| `@xo/compiler`   | REAL CACHE (opt-in): replay the live run from its cache … | needs `XO_EVAL_CACHE_DIR` and `XO_ADJUDICATION_OUT` |
| `@xo/compiler`   | LIVE real-model protocol (opt-in …)                       | needs credentials and an explicit hard budget       |
| `@xo/connectors` | confinement … bubblewrap: no network, no host processes … | needs bubblewrap on the host                        |

## 4. By-name baseline

`docs/baseline/tests-26f0052.tsv` lists every test result line by name (workspace, status, full suite path): 7,315 entries, 7,311
pass, 4 skip, 0 fail. `node:test` workspaces contribute suite-level lines as well as tests, so the entry count is higher than the
TAP totals above. Earlier milestones repeatedly lost their by-name baselines (P1.1 M0 and M6 records: "original TSV UNAVAILABLE");
committing it closes that gap. Method:

```sh
npm test > test.log 2>&1
(cd apps/studio && npx vitest run --reporter=json --outputFile=/tmp/studio.json)
node scripts/test-names.mjs extract test.log /tmp/studio.json > current.tsv
node scripts/test-names.mjs compare docs/baseline/tests-26f0052.tsv current.tsv   # exit 1 on any regression
```

Comparison rule for later workstreams (common Definition of Done: "existing tests preserved by name"): every `pass` line in this
file must still exist and pass, or be listed as a retired assertion in that workstream's record with the reason.

## 5. Known failures: resolved or accepted

| Item                                                                      | Status at `26f0052`                         | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@xo/benchmark` `p09c-closure` (#147), `baseline.test` (#35) (plan B.3.1) | Pass [RUN]                                  | No longer failing; nothing to accept                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/api` tests over the 40 s cap (plan B.3.1)                           | 742/742 pass [RUN]                          | Not reproduced here                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `@xo/xoir` "manifest.sourceQuality carries the 'partial' state …"         | **Flaky**: passed locally, failed on GitHub | **Resolved (test).** Two graphs created nodes without a fixed clock; `createdAt` is part of the node content hash (`packages/xoir/src/hashing.ts:61`), so the hashes differed whenever the millisecond ticked between creations. Both nodes now get the same `now`. The assertion is unchanged and still tests that `sourceQuality` does not affect node hashes. **Root cause carried to UW-1** (deterministic hashing): whether `createdAt` belongs in the content hash. |

## 6. Frozen roadmaps (UAC-23)

UAC-23 requires the frozen master and runtime roadmaps to be byte-identical before and after each workstream. **Neither frozen
roadmap is stored as its own file in this repository**; their authoritative text is the owner's manager/checklist, summarised in the
owner's master context document (11 Nov 2026, §12.2 and §15, held in the project document store). The repository files that record
roadmap facts are hashed as a guard:

| Document                            | What it holds                                    | SHA-256 at `26f0052`                                               | After UW-0 |
| ----------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------ | ---------- |
| `P10_ENTERPRISE_TRUST_DECISIONS.md` | the master sequence as recorded at P1.0 (line 3) | `5e7c7fbbce46adc9691492c9a9e61a8a1e5ec4bf4ed557fa84e772eeabf06a08` | identical  |
| `docs/ROADMAP.md`                   | the detachable-layer status roadmap (not R1–R6)  | `e391318017c47b52be867f54940dd6b22f409f44a75a46ceac7affdc3ab929b9` | identical  |

- **Master roadmap** (owner's master context §15): P0.9A/B/C → **P0.9 Beta** → P1.0 → P1.1 → P1.2 → Multi-XO Foundation → P1.5 →
  P1.7 → P2 → P3. **Discrepancy recorded, not resolved:** the repository's copy (`P10_ENTERPRISE_TRUST_DECISIONS.md` line 3) omits
  P0.9 Beta (the Aastha execution-accuracy audit milestone, five of whose ten items are still to be recovered from the authoritative
  audit). The master context governs; no workstream here changes either text.
- **Runtime roadmap** (owner's master context §12.2): R1 authoritative execution metadata / strategy decision point; R2 input contracts
  and schema validation; R3 confidence and authorization gating; R4 generalized execution-strategy router; R5 hybrid execution; R6
  production execution semantics (structured errors, execution ids and tracing, timeouts and cancellation, retry and idempotency,
  replay, simulation, capability-collision handling). Note that `P10_CLOSURE_BASELINE.md` uses "R1–R6" for a different series (P1.0
  M4 requirements); the two must not be confused.
- P1.1 is implemented but **not formally accepted** (`claude/P11_REVIEW_AND_DECISIONS.md` §0) [P].

No UW-0 change touches either recorded text. The owner-approved replacements are recorded as ADRs: 0011 (engine) and 0024
(cancellation, which R6 already names).

## 7. Re-verification of plan B.6 on `26f0052`

"Changed" means the plan's row no longer describes `main`. Rows the plan marked as not traced, and that this session did not trace
either, say so.

| #   | Capability                                | Status on `26f0052`                                                                                                                                                                                                                                                 | Changed |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | Local-folder source connection            | Partially implemented, **now wired**: `apps/api/src/server.ts` builds `createConnectRuntime` (`@xo/connect`, which uses EI). Still no chat coupling or file-role proposals [V]                                                                                      | Yes     |
| 2   | Cloud sources                             | EI `cloud/microsoft.ts` only; no Google provider [V]                                                                                                                                                                                                                | No      |
| 3   | Source sync / retirement / freshness      | Missing: no source-connection entity anywhere [V]                                                                                                                                                                                                                   | No      |
| 4   | PDF text extraction                       | Implemented and integrated; not run on certificates [P]                                                                                                                                                                                                             | No      |
| 5   | Scanned PDF / OCR / vision                | `extraction/adapters/{pdfium,tesseract,vision,png}.ts` present [V]; accuracy unmeasured [NV]                                                                                                                                                                        | No      |
| 6   | XLSX / tabular                            | **Prototype now on main**: `sources/xlsx-frontend.ts`, `xlsx-text.ts` (rows flattened to text). CSV still naive by documented choice (`structured-frontend.ts:182`). **`.xlsx` is not in the API upload list** (`apps/api/src/sources/source.ts`) [V]               | Yes     |
| 7   | DOCX / EML                                | **DOCX on main** (compiler frontend; API `sources/docx-text.ts`; `.docx` uploadable). EML missing [V]                                                                                                                                                               | Yes     |
| 8   | Document classification                   | Not traced [NV]                                                                                                                                                                                                                                                     | —       |
| 9   | Corpus-level entity extraction            | Missing (no extractor found) [V]                                                                                                                                                                                                                                    | No      |
| 10  | Entity resolution                         | Missing: no resolver producing resolved / ambiguous / unmatched found [V]                                                                                                                                                                                           | No      |
| 11  | XOIR canonical graph                      | Implemented. Gaps confirmed: `createdAt` in the node hash (`hashing.ts:61`, which caused the CI flake); `fromJson` does not verify node hashes (`serialization.ts` doc comment, deliberate; `validateGraph` does); no claim layer (ADR 0012) [V]                    | No      |
| 12  | Knowledge state / branches                | Missing [P]; not re-traced                                                                                                                                                                                                                                          | —       |
| 13  | EI environment model + ledger             | **No longer disconnected**: imported by `@xo/connect` (wired into the API) and `@xo/intelligence-c6` [V]                                                                                                                                                            | Yes     |
| 14  | C6 chat knowledge adapter                 | **Merged** as `packages/intelligence-c6`, but **no importer outside the package**. The API chat uses its own composite `KnowledgePort` (workspace sources + installed XOs) [V]                                                                                      | Yes     |
| 15  | Retrieval                                 | `capability-layer` BM25, unchanged [V]                                                                                                                                                                                                                              | No      |
| 16  | Contradiction / supersession              | **Deterministic, rules-level version on main**: `compiler/src/pipeline/cross-document.ts` surfaces conflicts, resolves only by explicit precedence, detects amendment wording [V]. Coverage beyond rule outcomes not traced                                         | Yes     |
| 17  | Intent understanding                      | `@xo/intelligence` merged and **wired** (`intelligence-routes.ts`). DO still returns one proposal and never executes (ADR 0008) [V]                                                                                                                                 | Yes     |
| 18  | Capability discovery                      | Not re-traced [NV]                                                                                                                                                                                                                                                  | —       |
| 19  | Capability contract completeness          | `outputs` exists on the contract type but extractors emit `outputs: []` (`capabilities/types.ts:61`, `ai-extractor.ts:79`); no effect-class field [V]                                                                                                               | No      |
| 20  | Workflow composition                      | `workflow-composer` on main, used by API, CLI, benchmark, runtime; no natural-language input [V]                                                                                                                                                                    | No      |
| 21  | Workflow IR and validation                | **On main.** Producer: compiler `policy/workflow-emit.ts`. Consumers: CLI `xo flow`, `@xo/server`, `@xo/sdk`, `@xo/connectors`. Not the API (ADR 0009) [V]                                                                                                          | Yes     |
| 22  | Workflow runtimes                         | **Five execution paths on main** [V]: `@xo/runtime` `WorkflowExecutor`; the API P0.8 segmented runner on it; P1.1 procedures (lowered to `@xo/runtime` graphs); `@xo/workflow-runtime` (CLI, `xo serve`, SDK); `@xo/automation` engine (CLI; runs its own handlers) | Yes     |
| 23  | Batch (`forEach`)                         | Implemented in `workflow-runtime`; **spike confirms per-item isolation** (§8); conformance vectors unwritten; one approval per item; not reachable from the API [RUN]                                                                                               | No      |
| 24  | Execution journal / recovery              | **Spike: 108 crash points, zero duplicate effects** on a shared fixture. **New defect found: a crash before the run's first durable entry orphans the run id** (§8) [RUN]                                                                                           | Yes     |
| 25  | External-effect protocol                  | `@xo/adapters` unchanged; no real adapter; the shipped API entrypoint passes no `externalTools` [V]                                                                                                                                                                 | No      |
| 26  | Procedures (P1.1)                         | Implemented; **formal acceptance still open** (`claude/P11_REVIEW_AND_DECISIONS.md`) [P]                                                                                                                                                                            | No      |
| 27  | Approvals                                 | P1.0 capability approval, P1.1 payload approval, `workflow-runtime` signed decisions, Studio sign-off. **The `workflow-runtime` decision is bound to run/step identity, not to the action's content** (§8). No batch approval [V]                                   | Yes     |
| 28  | Authorization                             | **Two systems in `apps/api` confirmed**: workspace role table (`workspace/permissions.ts`) and `PermissionManager` with `RuleBasedPolicy([])` (procedure routes). `InMemoryPermissionStore` only. API keys now revocable (`revokedAt`) but never expire [V]         | Partly  |
| 29  | Audit                                     | Chained store on main; no external anchoring in `apps/api` [V]                                                                                                                                                                                                      | No      |
| 30  | Credentials / OAuth                       | Connector vault (runtime line); no OAuth broker or per-instance token store in the API [V]                                                                                                                                                                          | No      |
| 31  | Email send                                | `connectors/src/smtp.ts`: `AUTH PLAIN` only, default 5 recipients, non-empty domain allowlist required, no attachments [V]                                                                                                                                          | No      |
| 32  | MCP                                       | `connectors/src/mcp.ts` (client), `apps/mcp` (server) [V]                                                                                                                                                                                                           | No      |
| 33  | Chat and evaluation                       | `@xo/intelligence-eval` merged; no live-model run [V]                                                                                                                                                                                                               | Partly  |
| 34  | Conversation → workflow link              | Missing: no conversation id on any workflow record. Studio's chat uses `cnv_` (`apps/studio/src/platform/client.ts:514`); the `cht_` routes have **no client** in the repo [V]                                                                                      | Partly  |
| 35  | Studio workflow controls                  | **Merged** into `apps/api/src/workflow-controls` (modes, interval schedule, webhook, daily cap, pause). Stated limits: one process, no catch-up (`scheduler.ts` header) [V]                                                                                         | Yes     |
| 36  | Tenancy                                   | Single-tenant workspaces with directory isolation; no org model [V]                                                                                                                                                                                                 | No      |
| 37  | Persistence                               | File-only. SQLite only as the read-only connector driver [V]                                                                                                                                                                                                        | No      |
| 38  | Prompt-injection controls                 | `AI_EXECUTION_ENABLED = false` constant (`routes/runtime/runtime-routes.ts:50`) re-verified [V]                                                                                                                                                                     | No      |
| 39  | Deployment / operations                   | `Dockerfile`, `Dockerfile.server`, `docker-compose.yml`; backup is mentioned only in `FAILOVER.md` and `audit-operations.md`; no deployment, upgrade or restore guide [V]                                                                                           | No      |
| 40  | Triggers and automation                   | **Both designs on main**: `@xo/automation` (cron, file, webhook, idempotency ledger, single-host lock; used by CLI and ab-eval) and the API interval scheduler. Not unified (ADR 0025) [V]                                                                          | Yes     |
| 41  | Drift, standing approvals, exception rate | Missing [V]                                                                                                                                                                                                                                                         | No      |

## 8. Spike results (throw-away code, deleted after the run)

### D-B engine conformance (`@xo/workflow-runtime`) [RUN]

Shared fixture: a certificate-style batch. `forEach` over four recipients, one `act` step per item (`mail.send`, write) with key
`send:{{item.email}}:{{item.att}}`; the third recipient is rejected by the destination. Run against the real runner and `RunStore`.

| Property                      | Result                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-item isolation            | **Pass.** Items: completed, completed, failed, completed. Exactly three effects. The parent run's state is `failed` (any failed item fails the parent), which UW-7 must turn into a partial-completion state for batches.                                                                                                         |
| Durable intent before effect  | **Pass.** At the moment the destination was called, a `call_intent` for that item was already on disk, for every call.                                                                                                                                                                                                            |
| Crash at every journal append | **Pass.** 54 crash points × 2 destination kinds (key-deduplicating, and no idempotency support), crash before and after each append, then resume with a fresh runner: **no recipient received two effects**. For the destination with no idempotency support, 8 resumed runs escalated the unknown outcome instead of re-sending. |
| **Defect**                    | **A crash after the run directory is created and before its first entry is durable leaves the run id unusable**: `resume` and a second `start` both fail with `unknown run` (no effect happened, so it is safe, but the caller can never complete that run id). Owner: UW-7.                                                      |
| Approval binding              | **Gap.** `DecisionPayload` signs `{approvalId, runId, step, action, edits, reviewerId, at}`; the approval id derives from workflow, version, step and run. Nothing binds the decision to the content of the action. `@xo/adapters` payload approval does (`actionDigest`, single-use `consume`).                                  |
| Cancellation                  | The IR declares `cancellation.onCancel` and the runner has a `cancelled` terminal state, but there is no cancel operation [V].                                                                                                                                                                                                    |

### D-D conversation stores [V]

`cht_` (`apps/api/src/chat/chat-store.ts`): the older Studio assistant, no knowledge access, no actions, routes registered, **no
client in the repo**. `cnv_` (`apps/api/src/intelligence/conversation-store.ts`): the ASK/DECIDE/DO/LEARN chat with proposals,
citations and feedback, **used by Studio's chat screen**. Same mechanics (one JSON document per conversation, per-identity privacy).

### D-A role mapping [V]

Workspace roles: `admin`, `publisher`, `reviewer`, `viewer` over six permissions (`read`, `author`, `publish`, `review`, `audit`,
`manage`); the owner is always `admin`. `PermissionManager` rules match on permission, domain, scope, package, capability,
environment, principal id and principal kind, **not on a workspace role**, and `PERMISSION_DOMAINS` has no `source`, `workflow`,
`chat`, `knowledge` or `workspace` domain. The mapping is possible without losing a control only after the additive extensions in
ADR 0010.

### D-C knowledge mapping [V]

EI claims carry kind, subject, predicate, value, origin (`observed` | `stated` | `inferred`), validity (`validFrom`/`validTo`),
evidence support (`sourceId`, `resourceDigest`, `contentHash`, `observedAt`), derivation and epistemic status. XOIR nodes carry
`sourceRefs` (path, locator, pages, offsets), confidence, `producedBy` and `reviewStatus` (`unreviewed` | `human_confirmed`, outside
the hash), with no origin, validity, evidence digest or lifecycle. Two EI relationship types (`manages`, `associated_with`) have no
XOIR edge (EI's own `XOIR_EDGE_FOR` table records this). Not expressible without loss today; ADR 0012.

### D-P trigger parity [V]

| Concern                      | `@xo/automation`                              | API scheduler (`workflow-controls`)                          |
| ---------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| Sources                      | cron, file drop, webhook, manual              | "every N minutes", webhook                                   |
| Duplicate start              | idempotency key, at most once across restarts | none across processes (stated)                               |
| Multi-process                | single-writer lock, single host               | one process only (stated)                                    |
| Missed slots                 | not replayed (stated)                         | not replayed (stated)                                        |
| Modes, caps, pause, sign-off | per-workflow rate limit only                  | draft/shadow/live/paused, daily cap, workspace pause         |
| Authorization and audit      | none; runs its own handler                    | service principal `trigger-schedule`, per-step checks, audit |

## 9. Not verified in UW-0

Real-host bubblewrap; Studio screenshot tests; any live model or provider call; OCR or extraction accuracy; rows 8, 12 and 18 above;
`npm audit`; provider policies (UW-9); P1.1 acceptance criteria text (still unavailable, per the P1.1 records).
