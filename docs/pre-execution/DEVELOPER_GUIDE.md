# Extending the pre-execution pipeline

This guide covers how to add to the pre-execution pipeline without breaking its guarantees. Each section names the
place to change, the rule to keep, and the test that proves you kept it. Read `PRE_EXECUTION_ARCHITECTURE.md` and ADR 0029
first.

The guarantees every change must keep:

- **One path.** The API, CLI and Studio call the same `@xo/pre-execution` functions. Never add a surface-specific
  compile, inventory, lowering or certificate.
- **Nothing invented.** When the source does not state something, it is reported, never guessed. An unknown is `unknown`,
  and `unknown` is never `yes`.
- **Digests are reproducible.** The same inputs give the same digest. Timestamps and record ids stay out of identities.
- **The certificate binds what the status depends on.** If you add an input that can change readiness, bind its digest.

## Adding a source format (a parser)

1. **Reader.** Add it to `@xo/compiler` (a frontend under `packages/compiler/src/…`), and register its version in
   `PARSER_VERSIONS`. The reader version becomes part of the artifact, so a reader change shows up as a changed artifact.
2. **Content check.** Add the format to `MEDIA_TYPE_BY_FORMAT` and `EXPECTED_CONTENT`
   (`packages/pre-execution/src/source-content.ts`), so a file that claims the format is checked against its bytes. If
   the format is an archive, its entries go through `checkArchiveEntries`. Declared sizes must match inflated sizes.
3. **Quality.** Report the quality state per page or per part (`SourceQualityState`). Never report `trusted` for text you
   could not read.
4. **Ingestion matrix.** Add a row to `docs/INGESTION.md`.
5. **Tests.**
   - a real fixture
   - a mislabeled file that is refused
   - a partial file that needs a waiver
   - the API and the CLI giving the same artifact digest (add the fixture to `cli/test/pre-execution-conformance.test.ts`)

## Adding an extractor

1. Add it to the compiler pass that owns its kind (knowledge, reasoning, capabilities). Record `producedBy`, and attach
   source refs with pages, section and character range to every node. A node without evidence is rejected by the XOIR
   adapter, and a capability without evidence can never be approved.
2. If the extractor produces capabilities, decide which execution path it permits:
   - **Rules:** link `decision_node`/`heuristic`/`constraint` nodes with `REQUIRES` edges and fill `structuredCondition`
     when the text parses.
   - **A human task:** for a procedure step, write the step metadata (`understanding: manual-step`, `step.actions`,
     `step.doneWhen`, `step.owner`). `humanTaskContractOf` is the only rule that decides. Never add a second one.
   - **Neither:** the capability stays unresolved. That is correct.
3. **Benchmarks.** If outcomes move, refresh under control:
   - update the expectations and their fingerprints
   - add a `CHANGELOG.md` entry that gives every difference a disposition
   - make sure no accepted baseline moves silently (`npm run eval -- --check`)

## Adding a binding resolver

1. Implement `BindingResolver` (`@xo/capability-contract`). `resolve()` must be pure and deterministic. It returns
   `undefined` when it has no opinion, and an `unresolved`, `ambiguous` or `denied` outcome when it looked and could not
   bind. Partition contracts disjointly from the existing resolvers, so `ambiguous` stays unreachable between them.
2. Map its `implementationClass` to a strategy in `strategyOf` (`capability-inventory.ts`). If the runtime has no
   executor for it, leave it out of `DEFAULT_RUNTIME_SUPPORT`. The inventory then reports it as `unsupported`, and the
   certificate blocks.
3. If generation should emit it, see the next section. Otherwise it is reported as blocking, never invented.
4. **Tests.** Cover the four-answer matrix in `pre-execution/test/capability-inventory.test.ts`: bound and supported but
   not authorized; bound but unsupported.

## Adding a Workflow IR construct to generation

1. Check that the construct exists in `@xo/workflow-ir` and is validated by `validateWorkflowComponent`. Generation never
   weakens a construct to make it valid.
2. Add the lowering to `lowerCandidateWorkflow` (`packages/pre-execution/src/lower-workflow.ts`). Emit it only when the
   capability report states everything it needs. For example, an `act` step needs a declared operation and a workspace
   connector binding (`ConnectorBinding`) that states its connector, side effect and adapter. Add a rationale entry, and
   update the evidence rule in `GENERATION_CONSTRUCTS`.
3. If the construct needs a runtime feature, add it to `requiresFeatures`.
4. **Tests.**
   - a conformance vector in `pre-execution/test/lowering-constructs.test.ts`
   - a run of the generated IR through `@xo/workflow-runtime` (`api/test/generated-workflow-runs.test.ts`)
   - a stable `definitionDigest`
   - the API/CLI conformance suite still identical

## Adding a readiness gate or a bound input

1. Add the gate to `assessReadiness` (`readiness.ts`). Decide its outcomes using ADR 0029 decision 14:
   - Mandatory checks block or need review.
   - Only a declared, owner-ratified case may be a `condition`.
2. If the gate depends on a new input, add its digest to `CertificateBindings` and compare it in
   `verifyReadinessCertificate`. Name the input in the stale reason. Bump `READINESS_POLICY_VERSION` when a change makes
   older certificates mean something different.
3. **Surfaces.**
   - Assemble the input in `apps/api/src/pre-execution/context.ts`, so every route and the start gate see the same value.
   - The CLI's `--certify` must compute the same input locally, or state why it cannot.
4. **Tests.**
   - add the new failure to the false-ready corpus
   - add a staleness case
   - add an API test proving that the start gate refuses it

## Adding a Domain Knowledge Pack

1. Write an `xo.domain-pack.v1` manifest. It needs:
   - one namespace
   - semantic-version `version` and `compatibility.core: "1"`
   - `entityTypes`, `predicates` and `relationshipTypes`, each with an optional JSON Schema in the supported subset
     (`schema.ts`). A construct outside the subset is reported, never weakened.
2. Build the artifact with `makePackArtifact`. Its digest is its identity. Dependencies resolve by exact digest only.
3. Install it per workspace (`POST /workspaces/{ws}/knowledge/packs` or `xo knowledge install-pack`). A second pack for an
   active namespace is refused. A pack adds semantics, never authority.
4. A package that relies on the pack pins it in `XoManifest.domainPacks` (`ManifestBuilder.setDomainPacks`).
5. **Tests.** Records valid and invalid against the pack, an unknown namespace kept as unsupported, and a pack holding no
   tenant data (see `knowledge-base/test/knowledge-base.test.ts`).

## Adding a knowledge store

Implement `KnowledgeStore` (`packages/knowledge-base/src/store.ts`), or a `SqlDriver` for `SqlKnowledgeStore` when the
backend speaks SQL (`?` placeholders, a transaction-scoped lock keyed by a string). `exclusive()` must exclude writers
in other processes, not only in this one. Run the shared suite in `knowledge-base/test/knowledge-base.test.ts` against
it (add it to `STORES`), plus a two-writer `stale_base` test and a tamper test.
