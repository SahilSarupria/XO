/**
 * Hand-written, not generated — there's no schema-generation tooling
 * already in this repo to build on (no zod-to-openapi, no decorators),
 * and introducing one would be its own framework-choice decision on top
 * of the one this package already had to make (see README.md). Kept as
 * a plain object literal (not a separate YAML/JSON file) so it can't
 * drift silently out of sync with `routes/index.ts`'s registration
 * calls without a compile error the moment a field's TypeScript shape
 * changes; keeping it hand-in-hand with the route registration also
 * means updating a route and forgetting the doc is a one-file diff to
 * review, not two.
 */
export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'XO Platform API',
    version: '0.1.0',
    description:
      'HTTP service over @xo/registry, @xo/package-sdk, and @xo/runtime, plus an isolated adapter over the compiler pipeline. See apps/api/README.md for the framework choice, the compiler-isolation boundary, and known limitations. AUTH (P1.0 M1): every route except /health and /openapi.json requires Authorization: Bearer <API key>. A key authenticates only if its server-side record is bound to a valid principal (kind human|service, stable id, optional orgId); keys issued before M1 have no binding and receive 401 until the operator re-issues them with an explicit --kind (scripts/manage-keys.ts). A principal identifies the initiator for attribution only — it grants NO permission, and capability-level authorization is NOT yet enforced on every execution path (planned P1.0 M2). This document does not describe a production-ready security posture.',
  },
  security: [{ bearerAuth: [] }],
  servers: [{ url: 'http://localhost:4000' }],
  paths: {
    '/health': {
      get: {
        summary: 'Liveness check',
        security: [],
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } } } } },
      },
    },
    '/openapi.json': {
      get: { summary: 'This document', security: [], responses: { '200': { description: 'OK' } } },
    },

    '/workspaces': {
      post: {
        summary: 'Create a workspace owned by the authenticated identity',
        description: 'Ownership is always derived from the caller\'s API key identity, never from the request body — any "identityId" in the body is ignored.',
        requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } },
        responses: { '201': { description: 'Created' } },
      },
      get: {
        summary: 'List workspaces owned by the authenticated identity',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/workspaces/{workspaceId}': {
      get: {
        summary: 'Get a workspace — only if it belongs to the authenticated identity',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' }, '404': { description: 'Not found, or not owned by the authenticated identity (deliberately indistinguishable from the caller\'s point of view)' } },
      },
    },

    // P0.2: every registry route is workspace-bound — no more `?registry=`.
    // The legacy paths (`/registry/...`, no `:workspaceId`) still exist
    // and return a structured 400 pointing here; see `routes/moved-stub.ts`.
    '/workspaces/{workspaceId}/registry/packages': {
      post: {
        summary: 'Publish a package into this workspace\'s registry (mirrors RegistryClient.publish / `xo publish`)',
        description: 'Body is the raw bytes of a .xo archive (application/octet-stream). Validated, then unpacked, then published.',
        requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '201': { description: 'Published' }, '422': { description: 'Package failed validation' }, '404': { description: 'Workspace not found or not owned by the caller' } },
      },
      get: {
        summary: 'List packages by creator within this workspace (mirrors RegistryClient.listByCreator)',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'creator', in: 'query', required: true, schema: { type: 'string' }, description: 'CreatorDid' }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/workspaces/{workspaceId}/registry/packages/{id}': {
      get: {
        summary: 'Get a published package within this workspace (mirrors RegistryClient.get)',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
      },
    },
    '/workspaces/{workspaceId}/registry/packages/{id}/inspect': {
      get: {
        summary: 'Package record plus its recorded benchmark runs (mirrors `xo registry inspect`)',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
      },
    },
    '/workspaces/{workspaceId}/registry/search': {
      get: {
        summary: 'Semantic-ish package search within this workspace (mirrors RegistryClient.search / `xo search`)',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/workspaces/{workspaceId}/registry/packages/{id}/benchmarks': {
      post: {
        summary: 'Record a benchmark run (mirrors RegistryClient.recordBenchmark)',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['category', 'score'], properties: { category: { type: 'string' }, score: { type: 'number' }, challengeable: { type: 'boolean' } } } } },
        },
        responses: { '201': { description: 'Recorded' }, '409': { description: 'Already recorded' } },
      },
      get: {
        summary: 'List benchmark runs for a package (mirrors RegistryClient.listBenchmarksForPackage)',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/workspaces/{workspaceId}/registry/benchmarks/{benchmarkId}': {
      get: {
        summary: 'Get one benchmark run (mirrors RegistryClient.getBenchmark)',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'benchmarkId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
      },
    },
    '/workspaces/{workspaceId}/registry/licenses': {
      post: {
        summary: 'Create a license record (mirrors RegistryClient.createLicense)',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['packageId', 'tier', 'royaltySplit'],
                properties: {
                  packageId: { type: 'string' },
                  tier: { type: 'string' },
                  royaltySplit: { type: 'array', items: { type: 'object', properties: { role: { type: 'string' }, basisPoints: { type: 'number' } } } },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Created' }, '409': { description: 'Already exists' } },
      },
    },
    '/workspaces/{workspaceId}/registry/licenses/{id}': {
      get: {
        summary: 'Get a license record (mirrors RegistryClient.getLicense)',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
      },
    },
    '/workspaces/{workspaceId}/registry/ledger/{entryHash}/verify': {
      get: {
        summary: 'Verify a ledger entry (mirrors RegistryClient.verifyLedgerEntry)',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'entryHash', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
    },

    '/packages/validate': {
      post: {
        summary: 'Validate an uploaded .xo archive (read-only; mirrors `xo verify`)',
        description:
          'Unlike the CLI\'s --pubkey did=path (a local file path), publicKeys here are PEM text supplied inline in the JSON body — a server has no local filesystem of the remote caller\'s to read a path from. See package-routes.ts.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['archiveBase64'], properties: { archiveBase64: { type: 'string', description: 'base64-encoded .xo archive bytes' }, publicKeys: { type: 'object', additionalProperties: { type: 'string' }, description: '{ [creatorDid]: pemPublicKey }' } } },
            },
          },
        },
        responses: { '200': { description: 'Valid' }, '422': { description: 'Invalid — see ValidationReport.issues' } },
      },
    },
    // P0.6/P0.7: human-in-the-loop task listing and REAL resolution/resume.
    '/workspaces/{workspaceId}/human-tasks': {
      get: {
        summary: 'List every execution that has ever been (or still is) a human task in this workspace',
        description: 'A "human task" is any execution whose status became waiting_for_human — this view reuses ExecutionRecord.humanTask directly (no separate store). Includes both pending and resolved tasks; filter client-side on humanTask.status if only pending is wanted.',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '{ humanTasks: ExecutionRecord[] }' } },
      },
    },
    '/workspaces/{workspaceId}/human-tasks/{executionId}': {
      get: {
        summary: 'Get a specific human task',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'executionId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ExecutionRecord (with humanTask populated)' }, '404': { description: 'Unknown execution, execution was never a human task, or workspace not owned by the caller' } },
      },
    },
    '/workspaces/{workspaceId}/executions/{executionId}/resolve': {
      post: {
        summary: 'Record a human decision for a pending human task and REALLY resume execution (P0.7)',
        description:
          'Body: { "decision": "approve" | "reject", "data"?: {} } — decision required, limited to exactly these two values; data, if present, is validated against the resolved capability\'s own decision-data schema when one exists (rare today), otherwise bounded to a plain JSON object under 8KB. ' +
          'Resume mechanism: re-derives the exact SemanticCapabilityContract/CapabilityBinding from the PERSISTED compiled graph (never a fresh recompile, never a client-supplied declaration), re-registers into a FRESH RuntimeCapabilityRegistry/PermissionManager (RuleBasedPolicy([]) — fail-closed, never allowAllPermissionGate, so required permissions are genuinely re-checked at resume time, not only at original execution time), and genuinely re-invokes RuntimeCapabilityExecutor.execute with the human decision merged into the original input as an additive humanDecision field. ' +
          'reject: the runtime is never invoked; ExecutionRecord.status becomes "rejected" with a structured business-level rejection output — this is not an error. ' +
          'approve: ExecutionRecord.status becomes "succeeded" once the resumed runtime call completes. For every human_in_the_loop capability this codebase currently compiles (via ActionEscalationBindingResolver, deliberately pure/stateless — see execute-capability.ts), the re-invocation deterministically reproduces the identical original escalation; combined with the human\'s own recorded approval, that is treated as genuine completion of the human-in-the-loop task itself (output.status "human_confirmed", with the original escalation preserved verbatim as output.originalEscalation) — never claimed as an automated business action. A binding whose evaluate() branches on the merged humanDecision field (none exist in production today; proven via a test-only fixture) would instead return its own real, different computed result here. ' +
          'resume_unsupported (errorCode XO_HITL_RESUME_UNSUPPORTED) is now the narrow residual case only — reachable if the owning compilation\'s persisted graph is missing/corrupt; not reachable through normal use of this API. ' +
          'Idempotency: a task can be resolved exactly once; a second POST (even with a different/conflicting decision) returns 409 with the ORIGINAL (unmodified) record — concurrent requests for the same execution are additionally serialized in-process (not distributed) via an internal lock, so duplicate/racing requests can never both resume. ' +
          'Authorization: the same workspace-ownership boundary as every other route (no separate reviewer/approver role exists yet — documented limitation, not full RBAC), re-checked at resolve time via requireOwnedWorkspace exactly as at every other route.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'executionId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['decision'], properties: { decision: { type: 'string', enum: ['approve', 'reject'] }, data: { type: 'object' } } } } } },
        responses: {
          '200': { description: 'ExecutionRecord — status now "succeeded" (approve, resumed) or "rejected" (reject), or "failed" if resume genuinely errored (bad decision data, binding no longer resolves, permission denied, or resume_unsupported); humanTask.status is "resolved" in every case. The record\'s `initiator` is unchanged; the authenticated resolving principal (taken from the API key, never from the body) is recorded as humanTask.resolver' },
          '400': { description: 'Invalid decision/data, or this execution was never waiting_for_human' },
          '404': { description: 'Unknown execution, or workspace not owned by the caller' },
          '409': { description: 'Already resolved — body is the ORIGINAL (unmodified) record' },
        },
      },
    },

    // P0.8: persistent, step-aware workflow execution.
    '/workspaces/{workspaceId}/workflows': {
      get: {
        summary: 'Discover the workflows composed from this workspace\'s stored compilations',
        description:
          'Derived server-side, on every call, from each SUCCEEDED compilation\'s persisted compiled graph via the existing @xo/workflow-composer (composeWorkflows -> auditWorkflowExecutability / auditWorkflowDataFlow) and @xo/runtime (prepareCandidateWorkflowForExecution) — never from client input. ' +
          '`status` is the audit\'s verdict VERBATIM: "executable_candidate" | "not_executable_yet" | "semantically_invalid"; it is never upgraded. `executable` is true only when status is executable_candidate AND every step binds to an executable capability (deterministic_rule or human_in_the_loop); `notExecutableReasons`/`blockers` explain a false. Only executable workflows can be started (POST .../workflows/{workflowId}/executions). ' +
          'Workflow ids are content-derived, so the same source compiled twice yields the same workflowId in two compilations — always address a workflow as (compilationId, workflowId). ' +
          '`steps[].approved` reflects P0.5 capability approval in THIS workspace (every step must be approved to start). `dataFlow.provenBindings[]` lists authoritative producer->consumer bindings; `wired: true` means the runtime bridge will actually transfer the producer\'s value at execution time. Suggestive/unbound data flow is only counted, never executed. ' +
          'Optional query `compilationId` restricts to one compilation (404 if unknown). A compilation whose stored graph cannot be loaded is reported under `unavailableCompilations` rather than silently dropped.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'compilationId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: '{ workflows: WorkflowView[], unavailableCompilations?: [...] }', content: { 'application/json': { schema: { type: 'object', properties: { workflows: { type: 'array', items: { $ref: '#/components/schemas/WorkflowView' } } } } } } },
          '401': { description: 'Missing/invalid API key' },
          '404': { description: 'Workspace not owned by the caller, or unknown compilationId filter' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflows/{workflowId}/executions': {
      post: {
        summary: 'Start a persistent workflow execution',
        description:
          'Body: { compilationId (required), workflowId? (must equal the path if present), input? }. ANY other field is rejected with 400 (XO_INVALID_ARGUMENT, `context.unknownFields`): workflow steps, capability ids, execution classes, bindings, runtime declarations, identity ids, filesystem paths and storage keys can never be supplied by a client — the plan is always re-derived from the stored compilation. ' +
          'Server steps: authenticate -> workspace ownership -> load the stored compilation/graph -> resolve the workflow -> require audit status executable_candidate with every step bound (else 422 XO_WORKFLOW_NOT_EXECUTABLE, `context` carries executabilityStatus/reasons/blockers) -> authorization preflight for EVERY step (capability approved in this workspace, and every non-optional contract permission granted under the fail-closed empty policy; else 403 XO_RUNTIME_PERMISSION_DENIED) -> validate `input` -> persist the record -> execute. Nothing is persisted for a request refused before that point. ' +
          '`input` is a bounded (64 KiB) plain JSON object: each field is delivered to every step whose declared input schema names it (steps with no declared schema, today every human_in_the_loop step, receive the whole object); no mapping is inferred from names or prose. It is validated with the same validateCapabilityInput P0.5 uses, at start (for what the client must supply) and again immediately before each step (client-supplied fields only — values injected by a proven upstream binding are authoritative producer output). A field no step can receive is a 400. Proven upstream values cannot be supplied or overridden by the client. ' +
          'Execution is synchronous and strictly sequential through the existing WorkflowExecutor/RuntimeCapabilityExecutor: it runs until the workflow succeeds, fails, or reaches a human_in_the_loop step, where it STOPS (status waiting_for_human) and returns; later steps do not run. Each step is recorded as a normal P0.5 ExecutionRecord (visible under /executions and, for HITL, /human-tasks). ' +
          'Status codes follow P0.5: 201 for succeeded/waiting_for_human, 200 when the workflow FAILED (still a real, persisted record). Starting creates a distinct execution each time (no idempotency key).',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['compilationId'], additionalProperties: false, properties: { compilationId: { type: 'string' }, workflowId: { type: 'string' }, input: { type: 'object' } } } } } },
        responses: {
          '201': { description: 'WorkflowExecution — status succeeded or waiting_for_human', content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkflowExecution' } } } },
          '200': { description: 'WorkflowExecution — status failed (a step failed at run time, e.g. authorization revoked or input invalid); still a structured, persisted record', content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkflowExecution' } } } },
          '400': { description: 'Unknown/forbidden body field, missing compilationId, workflowId mismatch, invalid/oversized input, or input failing a step\'s declared schema' },
          '401': { description: 'Missing/invalid API key' },
          '403': { description: 'XO_RUNTIME_PERMISSION_DENIED — a step\'s capability is not approved, or a required contract permission is not granted' },
          '404': { description: 'Workspace not owned by the caller, or unknown compilation / workflow in this workspace' },
          '422': { description: 'XO_WORKFLOW_NOT_EXECUTABLE — the workflow exists but its audit status is not_executable_yet or semantically_invalid, or a step cannot be bound' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-executions': {
      get: {
        summary: 'List workflow executions in this workspace',
        description: 'Oldest first. A record persisted as created/running that this process is not driving (its process disappeared) is reconciled to `interrupted` (or its completed step outcome adopted) on read — see the resume endpoint for the recovery semantics.',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '{ workflowExecutions: WorkflowExecution[] }' }, '404': { description: 'Workspace not owned by the caller' } },
      },
    },
    '/workspaces/{workspaceId}/workflow-executions/{workflowExecutionId}': {
      get: {
        summary: 'Retrieve one workflow execution (workflow status, per-step state, pending human task, final result)',
        description:
          'Persisted at <WORKSPACE_DATA_DIR>/<workspaceId>/workflow-executions/<workflowExecutionId>/metadata.json (the existing BlobStore abstraction). `steps[].executionId` references the underlying P0.5 ExecutionRecord, which remains the source of truth for a step\'s input/output/human task. `revision` starts at 0 and increases with every persisted transition; updates are compare-and-swap on it. ' +
          '`pendingHumanTask.humanTaskStatus` is read through from the step\'s execution record, so a task resolved directly via POST /executions/{id}/resolve is visible here as "resolved" while the workflow still waits for a `resume`. ' +
          'Workflow statuses: created, running, waiting_for_human, succeeded, failed, rejected (terminal: succeeded/failed/rejected), interrupted. Step statuses: pending, running, waiting_for_human, succeeded, failed, rejected, skipped, interrupted. "succeeded" is reported only when EVERY step succeeded. A failed or rejected workflow marks its never-executed later steps "skipped". ' +
          'Cross-workspace ids are 404.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowExecutionId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'WorkflowExecution', content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkflowExecution' } } } },
          '404': { description: 'Unknown workflow execution in this workspace (including ids belonging to another workspace), or workspace not owned by the caller' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-executions/{workflowExecutionId}/resume': {
      post: {
        summary: 'Continue a workflow that is waiting_for_human (or interrupted)',
        description:
          'Body (all optional; unknown fields are 400): { decision: "approve"|"reject", data?: object (<= 8 KiB, only with decision), expectedStepExecutionId?: string, expectedRevision?: integer }. An empty body is allowed. ' +
          'waiting_for_human: if the pending human task is unresolved, `decision` is required and is applied through the SAME implementation as P0.7 POST /executions/{id}/resolve (shared function: lock, attemptResume, ExecutionStore.resolveHumanTask — re-derives contract/binding from the persisted graph, fail-closed permissions re-checked, resolver identity recorded). If the task was already resolved via /resolve, resume WITHOUT a decision to continue; supplying a decision then is a 409 (a decision is never applied twice or silently ignored). ' +
          'approve -> the step succeeds and the workflow continues from the NEXT step (completed steps are never re-run; execution ids and provenance are preserved) until it succeeds, fails, or reaches another HITL step (then it waits again). reject -> the step becomes rejected, later steps skipped, the workflow rejected (terminal; no compensation). A resumed capability that itself fails -> the workflow fails. ' +
          '`expectedStepExecutionId` (the pending step\'s execution id, `pendingHumanTask.executionId`) is OPTIONAL for a single-step workflow (P0.7-compatible) but REQUIRED for a multi-step workflow with a pending HITL step (400, context.reason "expected_step_execution_id_required"); a value that does not match the pending step is a 409 (reason "stale_step_execution") and nothing is applied, so a stale/duplicated decision can never approve a different step. `expectedRevision` (optional) makes the call compare-and-swap on the record\'s revision (409 "stale_revision"). ' +
          'Concurrency: requests for one workflow execution are serialized in-process (not distributed). Of two concurrent resumes exactly one continues; the other is a deterministic 409 (reasons: terminal, stale_step_execution, in_flight, not_resumable, stale_revision — error code XO_RUNTIME_SESSION_INVALID_STATE, `context` carries workflowExecutionId/status/revision). ' +
          'interrupted: a workflow persisted as created/running whose process is gone. On read/resume it is reconciled: if the running step\'s ExecutionRecord had been COMPLETED its outcome is adopted (no re-execution); otherwise the step is marked interrupted and is never assumed done. An explicit resume (no decision/data) re-executes ONLY that step under a NEW execution id (old id kept in steps[].supersededExecutionIds) and continues. There are no automatic retries. ' +
          'RESTART/RECOVERY LIMITATIONS: filesystem-backed and in-process only. Completed steps are at-most-once under normal continuation; an interrupted in-flight step is at-least-once when explicitly resumed; exactly-once is NOT provided. BlobStore writes are plain writeFile (not write-then-rename), so a crash during a write can leave a truncated record that reads as 404. Compare-and-swap on revision is not a distributed transaction.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowExecutionId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: { decision: { type: 'string', enum: ['approve', 'reject'] }, data: { type: 'object' }, expectedStepExecutionId: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 0 } } } } } },
        responses: {
          '200': { description: 'WorkflowExecution after the continuation (succeeded, failed, rejected, or waiting_for_human again at a later HITL step)', content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkflowExecution' } } } },
          '400': { description: 'Unknown field; decision missing for an unresolved task; decision supplied to an interrupted workflow; or expectedStepExecutionId missing for a multi-step workflow with a pending HITL step' },
          '404': { description: 'Unknown workflow execution in this workspace, or workspace not owned by the caller' },
          '409': { description: 'Deterministic conflict (XO_RUNTIME_SESSION_INVALID_STATE, context.reason): workflow already terminal, stale expectedStepExecutionId, stale expectedRevision, resume already in flight, or the task was already resolved' },
        },
      },
    },

    // P0.5: capability approval + synchronous single-capability execution.
    '/workspaces/{workspaceId}/compilations/{compilationId}/capabilities/{capabilityId}/approve': {
      post: {
        summary: 'Approve a discovered capability for execution',
        description: 'Records that the authenticated identity approved this exact capability from this exact compilation, in this workspace. Only approved capabilities may be executed via POST .../executions. No review comments, multi-reviewer quorum, or un-approve endpoint in this milestone.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'compilationId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'capabilityId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ApprovalRecord' }, '404': { description: 'Unknown compilation/capability, or workspace not owned by the caller' } },
      },
    },
    '/workspaces/{workspaceId}/executions': {
      post: {
        summary: 'Execute an approved capability synchronously through the real runtime capability-authority path',
        description:
          'Body: { compilationId, capabilityId, input }. No client-supplied runtime declaration, execution class, or identity is ever accepted — the declaration is always re-derived server-side from the stored, compiled graph. Execution is synchronous: the response always reports a finished outcome. status "succeeded": the real deterministic (or other resolved) result. status "waiting_for_human": an honest human-in-the-loop escalation — this milestone does not implement HITL resume; the execution record is terminal. status "failed": rejected before running (not approved, unresolved/ambiguous/denied binding, invalid input) or a genuine runtime failure — always a structured errorCode/errorMessage, never a fabricated success. Permission gate: RuleBasedPolicy([]) (deny-by-default for any capability that declares required permissions; today\'s compiled capabilities typically declare none) — never an unrestricted allow-all gate.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['compilationId', 'capabilityId'], properties: { compilationId: { type: 'string' }, capabilityId: { type: 'string' }, input: { type: 'object' } } } } } },
        responses: {
          '201': { description: 'ExecutionRecord (includes `initiator`: the authenticated principal, never client-supplied), status succeeded or waiting_for_human' },
          '401': { description: 'Missing, invalid, revoked, or principal-unbound API key' },
          '200': { description: 'ExecutionRecord, status failed (unapproved, unresolved, invalid input, or runtime failure — still a structured, persisted record)' },
          '404': { description: 'Unknown workspace/compilation/capability, or not owned by the caller' },
        },
      },
      get: {
        summary: 'List executions run in this workspace',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '{ executions: ExecutionRecord[] }' } },
      },
    },
    '/workspaces/{workspaceId}/executions/{executionId}': {
      get: {
        summary: 'Get an execution\'s result/status',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'executionId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ExecutionRecord' }, '404': { description: 'Unknown execution, or workspace not owned by the caller' } },
      },
    },

    // P0.4: source compilation (synchronous) and capability retrieval.
    '/workspaces/{workspaceId}/sources/{sourceId}/compile': {
      post: {
        summary: 'Compile a stored source synchronously and persist the result',
        description: 'Runs @xo/compiler\'s compileSources + packageXoirGraph preview against the source\'s stored bytes. Every call creates a new compilation record (no dedup by digest — see the P0.4 completion report). The response always reflects a finished status (succeeded/failed), never running.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'sourceId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '201': { description: 'CompilationRecord, status succeeded' }, '200': { description: 'CompilationRecord, status failed' }, '404': { description: 'Unknown/cross-workspace source, or workspace not owned by the caller' } },
      },
    },
    '/workspaces/{workspaceId}/compilations': {
      get: {
        summary: 'List compilations run in this workspace',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '{ compilations: CompilationRecord[] }' } },
      },
    },
    '/workspaces/{workspaceId}/compilations/{compilationId}': {
      get: {
        summary: 'Get a compilation\'s status/metadata',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'compilationId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'CompilationRecord' }, '404': { description: 'Unknown compilation, or workspace not owned by the caller' } },
      },
    },
    '/workspaces/{workspaceId}/compilations/{compilationId}/capabilities': {
      get: {
        summary: 'Get the capabilities discovered/resolved by a succeeded compilation',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'compilationId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: '{ compilationId, capabilities: CapabilityProjection[] }' }, '404': { description: 'Unknown compilation, compilation did not succeed, or workspace not owned by the caller' } },
      },
    },

    // P0.3: workspace-bound source upload/registration (storage only — no compilation).
    '/workspaces/{workspaceId}/sources': {
      post: {
        summary: 'Upload a source document into this workspace',
        description: 'Body is the raw file bytes (Content-Type header describes them); original filename is passed as ?filename=. Only formats @xo/compiler already supports are accepted (pdf/html/htm/json/csv/txt/md/png/jpg/jpeg/gif/webp) — see sources/source.ts SUPPORTED_EXTENSIONS.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'filename', in: 'query', required: true, schema: { type: 'string' } },
        ],
        requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        responses: { '201': { description: 'SourceRecord' }, '400': { description: 'Missing/empty body, missing filename, or unsupported extension' }, '404': { description: 'Workspace not found or not owned by the caller' } },
      },
      get: {
        summary: 'List sources uploaded to this workspace',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '{ sources: SourceRecord[] }' } },
      },
    },
    '/workspaces/{workspaceId}/sources/{sourceId}': {
      get: {
        summary: 'Get a source\'s metadata (not its content — see .../content)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'sourceId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'SourceRecord' }, '404': { description: 'Unknown source, or workspace not owned by the caller' } },
      },
      delete: {
        summary: 'Delete a source (content and metadata)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'sourceId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '204': { description: 'Deleted' }, '404': { description: 'Unknown source, or workspace not owned by the caller' } },
      },
    },
    '/workspaces/{workspaceId}/sources/{sourceId}/content': {
      get: {
        summary: 'Download the exact uploaded bytes',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'sourceId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Raw file bytes, Content-Type set to the recorded mediaType' }, '404': { description: 'Unknown source, or workspace not owned by the caller' } },
      },
    },

    // P0.2: resolve/lock/manifest are workspace-bound — no more `?store=`.
    '/workspaces/{workspaceId}/packages/resolve': {
      post: {
        summary: 'Dry-run dependency resolution against this workspace\'s installed packages (nothing written)',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['nameAtVersion'], properties: { nameAtVersion: { type: 'string', example: 'corp-lawyer@1.4.0' } } } } } },
        responses: { '200': { description: 'DependencyResolution' }, '404': { description: 'Workspace or package not found' } },
      },
    },
    '/workspaces/{workspaceId}/packages/lock': {
      post: {
        summary: 'Resolve and write xo.lock into this workspace (mirrors `xo lock` exactly)',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['nameAtVersion'], properties: { nameAtVersion: { type: 'string' } } } } } },
        responses: { '200': { description: 'XoLockfile' } },
      },
    },
    '/workspaces/{workspaceId}/packages/{name}/{version}/manifest': {
      get: {
        summary: 'Read an installed package\'s manifest within this workspace',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'version', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'XoManifest' }, '404': { description: 'Not installed' } },
      },
    },

    // P0.2: runtime context/execute are workspace-bound — no more `?store=`.
    '/workspaces/{workspaceId}/runtime/context': {
      get: {
        summary: 'Bootstrap the runtime against this workspace\'s installed packages and return its mounted state',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Mounted packages + capability index + any bootstrap warnings' }, '404': { description: 'Workspace not found or not owned by the caller' } },
      },
    },
    '/workspaces/{workspaceId}/runtime/execute': {
      post: {
        summary: 'DISABLED (P1.0 M1): AI-assisted execution — always responds 501 after the workspace-ownership check',
        description: 'AI-assisted execution is disabled. This route would construct the execution engine with no permission gate and read provider credentials/endpoint from request headers, so it stays unavailable until capability authorization is enforced on this path (planned P1.0 M2). The workspace-ownership check still runs first (foreign or unknown workspace => the same 404), then the route responds 501 before any provider is resolved or any x-xo-* header is read. The body and headers documented below describe the route\'s retained, currently UNREACHABLE behaviour; they have no effect today. Deterministic execution (POST /workspaces/{workspaceId}/executions) is unaffected. Re-enabling is a code change, not configuration.',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['input'],
                properties: {
                  capabilityId: { type: 'string' },
                  query: { type: 'string' },
                  input: { type: 'string' },
                  model: { type: 'string' },
                  hostFamily: { type: 'string' },
                  hostCapabilities: { type: 'array', items: { type: 'string' } },
                  tokenBudget: { type: 'number' },
                  maxTokens: { type: 'number' },
                },
              },
            },
          },
        },
        responses: { '501': { description: 'AI-assisted execution is disabled (always returned today, for every body/header combination)' }, '401': { description: 'Missing, invalid, revoked, or principal-unbound API key' }, '200': { description: 'Execution completed (UNREACHABLE while disabled)' }, '403': { description: 'Safety-blocked' }, '404': { description: 'Workspace not found or not owned by the caller' }, '429': { description: 'Budget exceeded' }, '502': { description: 'Provider/execution failure' } },
      },
    },

    '/compiler/compile': {
      post: {
        summary: 'Compile a XoirGraph through the (currently xoir-only) compiler pipeline',
        description:
          'Only kind:"xoir" is supported today — "knowledge"/"capability"/"combined" return 501 until a safe JSON parser exists for those graph types. See routes/compiler/compile-adapter.ts, the single isolation boundary against the volatile compile.ts pipeline.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['kind', 'graph'], properties: { kind: { type: 'string', enum: ['xoir', 'knowledge', 'capability', 'combined'] }, graph: { type: 'object', description: 'XoirGraphJson' }, graphId: { type: 'string' } } },
            },
          },
        },
        responses: { '200': { description: 'Valid, normalized graph' }, '422': { description: 'Graph failed validation' }, '501': { description: '"knowledge"/"capability"/"combined" input not yet supported over HTTP' } },
      },
    },
  },

  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'API key issued by an operator with scripts/manage-keys.ts issue <identityId> --kind human|service [--org <orgId>]. 401 when the key is missing, unrecognized, revoked, or its record has no valid principal binding (keys issued before P1.0 M1). The caller never supplies its own identity: headers, query parameters and body fields claiming an identity are ignored.',
      },
    },
    schemas: {
      Principal: {
        type: 'object',
        description: 'P1.0 M1 attribution snapshot of the authenticated initiator, as persisted on execution and workflow-execution records (initiator) and on resolved human tasks (humanTask.resolver). Attribution only: it grants no permission, orgId is a label and not proof of membership, and records are mutable files with no integrity protection yet. Absent on records written before M1.',
        required: ['kind', 'id'],
        properties: {
          kind: { type: 'string', enum: ['human', 'service'] },
          id: { type: 'string', description: 'Stable identity; equals the API key record\'s identityId. 1-128 chars of letters, digits and . _ : @ - ; starts alphanumeric.' },
          orgId: { type: 'string', description: 'Optional organizational scope label (same character rules as id).' },
        },
      },
      WorkflowView: {
        type: 'object',
        description: 'API-safe view of one CandidateWorkflow with its executability audit, ordered steps, and proven data-flow evidence.',
        required: ['workflowId', 'compilationId', 'name', 'status', 'executable', 'steps'],
        properties: {
          workflowId: { type: 'string' },
          compilationId: { type: 'string' },
          sourceId: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string', enum: ['executable_candidate', 'not_executable_yet', 'semantically_invalid'] },
          executable: { type: 'boolean' },
          notExecutableReasons: { type: 'array', items: { type: 'string' } },
          blockers: { type: 'array', items: { type: 'object' } },
          requiresHumanDecision: { type: 'boolean' },
          confidence: { type: 'number' },
          gaps: { type: 'array', items: { type: 'object' } },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                order: { type: 'integer' },
                stepId: { type: 'string' },
                capabilityId: { type: 'string' },
                name: { type: 'string' },
                contractId: { type: 'string' },
                bindingId: { type: 'string' },
                executionClass: { type: 'string', enum: ['deterministic_rule', 'human_in_the_loop'] },
                bound: { type: 'boolean' },
                approved: { type: 'boolean' },
                inputs: { type: 'array', items: { type: 'object' } },
                outputs: { type: 'array', items: { type: 'object' } },
                evidence: { type: 'array', items: { type: 'object' } },
              },
            },
          },
          dataFlow: { type: 'object' },
        },
      },
      WorkflowStepState: {
        type: 'object',
        required: ['stepId', 'order', 'capabilityId', 'status'],
        properties: {
          stepId: { type: 'string' },
          order: { type: 'integer' },
          capabilityId: { type: 'string' },
          capabilityName: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'running', 'waiting_for_human', 'succeeded', 'failed', 'rejected', 'skipped', 'interrupted'] },
          executionId: { type: 'string', description: 'The underlying P0.5 ExecutionRecord id of this step\'s current attempt.' },
          supersededExecutionIds: { type: 'array', items: { type: 'string' } },
          contractId: { type: 'string' },
          bindingId: { type: 'string' },
          executionClass: { type: 'string', enum: ['deterministic_rule', 'human_in_the_loop'] },
          startedAt: { type: 'string' },
          completedAt: { type: 'string' },
          result: { description: 'The step\'s output when succeeded (copy of ExecutionRecord.output).' },
          error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } },
        },
      },
      WorkflowExecution: {
        type: 'object',
        required: ['workflowExecutionId', 'workspaceId', 'identityId', 'compilationId', 'workflowId', 'status', 'input', 'steps', 'revision'],
        properties: {
          workflowExecutionId: { type: 'string', description: 'wfx_<32 hex>' },
          workspaceId: { type: 'string' },
          identityId: { type: 'string' },
          compilationId: { type: 'string' },
          workflowId: { type: 'string' },
          workflowName: { type: 'string' },
          revision: { type: 'integer', minimum: 0 },
          status: { type: 'string', enum: ['created', 'running', 'waiting_for_human', 'succeeded', 'failed', 'rejected', 'interrupted'] },
          input: { type: 'object' },
          steps: { type: 'array', items: { $ref: '#/components/schemas/WorkflowStepState' } },
          currentStepIndex: { type: 'integer', nullable: true },
          currentStepExecutionId: { type: 'string' },
          pendingHumanTask: { type: 'object', properties: { stepIndex: { type: 'integer' }, executionId: { type: 'string' }, humanTaskStatus: { type: 'string', enum: ['pending', 'resolved'] } } },
          completedStepExecutionIds: { type: 'array', items: { type: 'string' } },
          createdAt: { type: 'string' },
          startedAt: { type: 'string' },
          updatedAt: { type: 'string' },
          completedAt: { type: 'string' },
          finalResult: { type: 'object', description: 'Present only when status is succeeded.' },
          rejection: { type: 'object', description: 'Present only when status is rejected.' },
          errorCode: { type: 'string' },
          errorMessage: { type: 'string' },
          provenance: { type: 'object', description: 'compilationId/sourceId/sourceDigestSha256/workflowId plus per-step capability -> contract -> binding -> execution references.' },
        },
      },
    },
  },
} as const;
