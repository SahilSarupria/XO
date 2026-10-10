# XO Environment Intelligence — Architecture (Workstream 3, Milestone 1: Environment Discovery Foundation)

Status: **milestone proposal + bounded implementation**. Roadmap and runtime stages are frozen; this adds no numbered phase and changes no compiler, XOIR, runtime, permission, identity or benchmark semantics. Code: `packages/environment-intelligence/` (isolated, no edits to shared source).

Legend used throughout: **[implemented]** code + tests in this package · **[contract]** typed contract only, no behaviour · **[proposal]** documented, not built · **[fixture]** synthetic data, never customer data.

## 1. Repo audit — what already exists

| Capability                                                                                         | State                                                     | Notes                                                                                 |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| XOIR, compiler, runtime, evidence strength vocabulary (`EvidenceStrength`)                         | implemented, verified upstream (baseline 3188/3191 tests) | Reused as _vocabulary only_; this package never writes XOIR.                          |
| P1.0 `Principal`, `PermissionScope` (path scope), `domain.action` permissions                      | implemented upstream                                      | Reused as vocabulary; **not wired** (see §8).                                         |
| Knowledge graph / capability graph                                                                 | implemented upstream for compiled workflows               | Not a discovery store. Environment model stays separate; link-out is a proposal (§4). |
| Environment discovery of unknown organizations (connectors, inventory, provenance of observations) | **not present**                                           | This milestone.                                                                       |
| Real authorization gate for discovery                                                              | **not present** (P1.0 M2 dependency)                      | Fail-closed port + dev-only stub here.                                                |
| Audit log, retention/purge                                                                         | not present for discovery (P1.0 M4 / retention)           | Hooks only: `purgeRequired`, provenance records.                                      |

Reuse vs extend vs new: reuse conventions (Result, branded ids, injected clock/authorization, `@xo/testing`); extend nothing; **new isolated package** so Workstream 3 and P1.0/Studio can't conflict.

## 2. Layering (one-way dependencies)

1. Contracts: `ids`, `errors`, `epistemic`, `authorization`, `evidence`, `connector` **[implemented]**
2. State: `source-state` (axes + guarded transitions), `inventory` **[implemented]**
3. Orchestration: `registry` (planning), `orchestrator` (detect → validate → authorize → discover → acquire) **[implemented]**
4. Adapter: `filesystem/*` — the only real adapter **[implemented]**
5. Representation: `environment-model`, `explain` **[implemented]**
6. Process discovery: `process-discovery` — candidate hypotheses only **[implemented, heuristic]**
7. Opportunity: `opportunity` — type contract, `executable: false` **[contract]**

## 3. Discovery vs acquisition

- **Discovery** = what exists (metadata, names, sizes, mtimes) — permission `filesystem.list`.
- **Acquisition** = bounded content reading — separate permission `filesystem.read`, only after authorization granted AND connection validated (guarded transition; otherwise `EI_INVALID_TRANSITION`).
- Discovery never confers execution permission. Connectors declare `sideEffects: 'none'` (literal type).

Source lifecycle is separate axes (detection, support, connection, authorization, validation, acquisition) with a _derived_ summary: detected, supported, connection required, authorization required, connected+validated, acquisition successful (or partial), unsupported/inaccessible, failed/unavailable. The summary is a view, not truth. Revocation sets `purgeRequired`.

## 4. Relationship to XOIR / knowledge graph / capability graph

The environment model (`ei.environment-model/v0`) is a separate, unvalidated hypothesis layer. `xoirLinks` is typed `never[]` — nothing links into XOIR. **[proposal]** A later projection could map validated, human-approved entities into the knowledge graph, and resolved processes to capability-graph requirements. Process steps' `requiredCapabilities` are deliberately unresolved.

## 5. Connector / agent architecture

`Connector<TScope>` = `detectSource`, `validateConnection`, `discover`, `acquireContent`; descriptor lists supported operations (`incremental_sync`, `health` declared, unsupported here). Source types are an open set (`x-<org>-<name>`). **[proposal]** Hybrid deployment: connectors run beside the data (customer-side agent/SDK) and ship only evidence records; the contract is serializable and transport-neutral. No agent, daemon or network code exists in this milestone.

## 6. Evidence and provenance

Every observation is an `Evidence` with `ProvenanceRecord`: source id, connector id+version, **relative** locator, observedAt (injected clock), access {operation, permission, authority, decisionReason, principal?}, transformation chain. Raw content is **never stored** — only a SHA-256 over the whole file (when fully read), byte counts, truncation flags and bounded identifier tokens. Ids are sha256-derived and stable, so repeat syncs de-duplicate; the inventory records `scanCount` and `changedSinceLastScan` via a scan fingerprint.

Epistemic statuses (no numeric confidence): `directly_observed`, `corroborated_inference`, `candidate_hypothesis`, plus unknowns. `ValidationState` is only `not_validated`. Corroboration rule: ≥2 independent evidence kinds, each tying **both** endpoints (e.g. identifier in filename _and_ in content in both files). Relationships: `same_content` (equal whole-file digests) and `shares_identifier` (every pair judged independently). Every relationship lists alternative explanations and requires human review.

## 7. Process discovery

Heuristic: ≥3 resources sharing an identifier, ordered by mtime. Output is always `candidate_hypothesis`, `not_validated`, `humanReviewRequired`, step relationship `observed_sequence_only`; order is "established" only when timestamps are distinct. Missing evidence and alternative explanations are listed. Real process mining (event logs, app telemetry) is future work.

## 8. Security and P1.0 dependencies

Filesystem adapter limits **[implemented, tested]**: explicit root (rejects relative, NUL, `/`, home dir, non-directories); realpath containment; symlinks never followed (O_NOFOLLOW reads, final-symlink rejection); `..`/absolute/backslash locators rejected; name sanitization; sensitive names (`.env`, keys, credentials patterns) and VCS/dependency dirs excluded — counted, not listed; bounded depth/entries/bytes/files/time; AbortSignal cancellation; deterministic ordering; structured errors (`EI_*`) with `internalError` never leaking raw messages. File content is treated as untrusted data: it is hashed and tokenized, never interpreted or fed to a model in this milestone.

Authorization: `FailClosedAuthorization` is the default (denies, authority `none`). `DevelopmentOperatorAuthorization` is a **dev-only** path-subtree allow-list that stamps `authority: development_unverified` into provenance and into model notices. It is not a parallel authorization system; it exists so the port can be exercised until P1.0 lands.

P1.0 dependencies (not built here): **M2 authorization gate** implementing `AuthorizationPort`; **M4 audit** consuming provenance access records; retention/purge honouring `purgeRequired`; a connector-shaped requester `Principal`; mapping `filesystem.list` / `filesystem.read` into the permission vocabulary **[proposal]**.

## 9. Milestone vs future work

In: contracts, inventory/state machine, one local filesystem adapter, evidence model, environment model with relationships, candidate processes, explainer, tests, demo. Out: any remote/SaaS connector, credentials handling, incremental sync/health, LLM interpretation, XOIR projection, opportunity scoring, persistence, UI.

## 10. Owned files

`packages/environment-intelligence/**`, `docs/environment-intelligence/**`. Additive shared edits: one project reference in root `tsconfig.json`; `package-lock.json` (workspace entry — regenerate on merge conflict).

## 11. Fixtures

`fixtures/invoices/` is **synthetic** and labeled so; the demo's second run marks its model `test_fixture` and the explainer prints a TEST FIXTURE banner.
