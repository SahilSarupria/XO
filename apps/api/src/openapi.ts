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
import { passwordAuthPaths, studioPaths } from './openapi-studio.js';

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'XO Platform API',
    version: '0.1.0',
    description:
      'HTTP service over @xo/registry, @xo/package-sdk, and @xo/runtime, plus an isolated adapter over the compiler pipeline. See apps/api/README.md for the framework choice, the compiler-isolation boundary, and known limitations. AUTH (P1.0 M1): every route except /health and /openapi.json requires Authorization: Bearer <API key> or, only when the server is configured for OIDC, Bearer <OIDC access token> from the one configured issuer (the verified issuer+subject must have an operator-written binding; unbound subjects get 401). A key authenticates only if its server-side record is bound to a valid principal (kind human|service, stable id, optional orgId); keys issued before M1 have no binding and receive 401 until the operator re-issues them with an explicit --kind (scripts/manage-keys.ts). A principal identifies the initiator for attribution only — it grants NO permission, and capability-level authorization is NOT yet enforced on every execution path (planned P1.0 M2). WORKSPACE ROLES: a workspace has an owner (always admin) and members with a role — admin, publisher, reviewer or viewer. Each workspace route documents the permission it needs in x-xo-permission (read, author, publish, review, audit, manage). A caller who is not a member gets 404; a member lacking the permission gets 403 and the attempt is written to the audit log. Workspace roles are separate from, and checked before, capability-level runtime authorization. This document does not describe a production-ready security posture.',
  },
  security: [{ bearerAuth: [] }],
  servers: [{ url: 'http://localhost:4000' }],
  paths: {
    ...studioPaths,
    ...passwordAuthPaths,
    '/health': {
      get: {
        summary: 'Liveness check',
        security: [],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } } },
          },
        },
      },
    },
    '/ready': {
      get: {
        summary: 'Readiness with reasons: instance checks plus inference-provider CONFIGURATION status (never calls the provider)',
        responses: {
          '200': {
            description:
              'Every check passed (status "ok"). checks lists storage, schema, instance-lock and scheduler with a reason each. inference.state is unconfigured|configured|invalid; "configured" does NOT mean the provider is reachable (providerReachable is always "not_checked") or that inference works (inferenceVerified is always false). Never includes credentials.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { status: { type: 'string' }, checks: { type: 'array' }, inference: { type: 'object' } },
                },
              },
            },
          },
          '503': { description: 'A check failed (status "not-ready"); the failing check says why.' },
        },
      },
    },
    '/readyz': {
      get: {
        summary: 'Readiness for load balancers and orchestrators (UW-17): check names and results only, no credential needed',
        security: [],
        responses: {
          '200': { description: 'Ready: { status: "ready", checks: [{ name, ok }] }' },
          '503': { description: 'Not ready: { status: "not-ready", checks: [{ name, ok }] }; the reasons are on the authenticated /ready' },
        },
      },
    },
    '/metrics': {
      get: {
        summary: 'Prometheus metrics (UW-17), for a scraper sending Authorization: Bearer <XO_METRICS_TOKEN>',
        security: [],
        responses: {
          '200': {
            description:
              'text/plain; version=0.0.4. Requests by method, route template and status class; durations; build and process gauges.',
          },
          '401': { description: 'Missing or wrong metrics token (an API key is not one)' },
          '404': { description: 'XO_METRICS_TOKEN is not configured, so metrics are off' },
        },
      },
    },
    '/openapi.json': {
      get: { summary: 'This document', security: [], responses: { '200': { description: 'OK' } } },
    },

    // Present only when the server is configured for Google sign-in (XO_API_GOOGLE_CLIENT_ID); see docs/studio/AUTH_API_CONTRACT.md.
    '/auth/login-challenge': {
      post: {
        summary: 'Start a Google sign-in: issue a single-use, 5-minute challenge (server nonce)',
        security: [],
        responses: {
          '201': { description: 'challengeId, nonce, expiresAt' },
          '429': { description: 'Rate limited, or too many outstanding challenges' },
        },
      },
    },
    '/auth/session': {
      post: {
        summary: 'Exchange a Google ID token, or an authorization code, (for that challenge) for an XO session',
        description:
          'Send exactly one of idToken, or code + codeVerifier + redirectUri. With a code, the API redeems it at Google with the OAuth client secret (server configuration only; 501 when not configured) and then continues with the ID token it obtains. The ID token is verified independently (signature, issuer, audience, expiry, the nonce of THIS challenge) and used once; it is never an API credential. The verified identity must have an operator-written binding (401 XO_AUTH_IDENTITY_UNBOUND otherwise). The challenge is consumed whether or not the exchange succeeds.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['challengeId'],
                properties: {
                  challengeId: { type: 'string' },
                  idToken: { type: 'string' },
                  code: { type: 'string' },
                  codeVerifier: { type: 'string', description: 'RFC 7636 PKCE verifier (43-128 unreserved characters)' },
                  redirectUri: {
                    type: 'string',
                    description: 'Exactly http://127.0.0.1:<port>/callback, the loopback address Studio listened on',
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'accessCredential (xoas_, 15 min), refreshCredential (xoar_), expiry times' },
          '401': { description: 'Challenge invalid, ID token invalid or expired, or identity unbound' },
          '400': { description: 'Malformed request (both or neither of idToken/code, or an invalid code, verifier or redirect address)' },
          '429': { description: 'Rate limited' },
          '501': { description: 'A code was sent but server-side code exchange is not configured' },
          '503': { description: 'Signing keys or the identity provider unavailable (fail closed)' },
        },
      },
    },
    '/auth/refresh': {
      post: {
        summary: 'Rotate a session refresh credential',
        description: 'Single use. Presenting a used credential revokes the whole session.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['refreshCredential'], properties: { refreshCredential: { type: 'string' } } },
            },
          },
        },
        responses: {
          '200': { description: 'New credential pair' },
          '401': { description: 'Invalid, expired, reused or identity unbound' },
          '429': { description: 'Rate limited' },
        },
      },
    },
    '/auth/logout': {
      post: {
        summary: 'Revoke the calling XO session (authenticated with its access credential)',
        responses: {
          '204': { description: 'Session revoked' },
          '400': { description: 'Not an XO session credential' },
          '401': { description: 'Not authenticated' },
        },
      },
    },

    '/workspaces': {
      post: {
        summary: 'Create a workspace owned by the authenticated identity',
        description:
          'Ownership is always derived from the caller\'s API key identity, never from the request body — any "identityId" in the body is ignored.',
        requestBody: {
          required: false,
          content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } },
        },
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
        responses: {
          '200': { description: 'OK' },
          '404': {
            description:
              "Not found, or not owned by the authenticated identity (deliberately indistinguishable from the caller's point of view)",
          },
        },
      },
    },

    // P0.2: every registry route is workspace-bound — no more `?registry=`.
    // The legacy paths (`/registry/...`, no `:workspaceId`) still exist
    // and return a structured 400 pointing here; see `routes/moved-stub.ts`.
    '/workspaces/{workspaceId}/registry/packages': {
      post: {
        summary: "Publish a package into this workspace's registry (mirrors RegistryClient.publish / `xo publish`)",
        description:
          'Body is the raw bytes of a .xo archive (application/octet-stream). Validated, then unpacked, then published. Publishing is gated by the effective package trust policy (an enforcing policy, or the explicit development mode); the 201 body carries a `trust` verdict (`mode`, `status`) — in development mode the status is `unverified`, never `trusted`.',
        requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '201': { description: 'Published' },
          '422': { description: 'Package failed validation' },
          '404': { description: 'Workspace not found or not owned by the caller' },
        },
      },
      get: {
        summary: 'List packages by creator within this workspace (mirrors RegistryClient.listByCreator)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'creator', in: 'query', required: true, schema: { type: 'string' }, description: 'CreatorDid' },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/workspaces/{workspaceId}/registry/packages/{id}': {
      get: {
        summary: 'Get a published package within this workspace (mirrors RegistryClient.get)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
      },
    },
    '/workspaces/{workspaceId}/registry/packages/{id}/inspect': {
      get: {
        summary: 'Package record plus its recorded benchmark runs (mirrors `xo registry inspect`)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
      },
    },
    '/workspaces/{workspaceId}/registry/search': {
      get: {
        summary: 'Semantic-ish package search within this workspace (mirrors RegistryClient.search / `xo search`)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/workspaces/{workspaceId}/registry/packages/{id}/benchmarks': {
      post: {
        summary: 'Record a benchmark run (mirrors RegistryClient.recordBenchmark)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['category', 'score'],
                properties: { category: { type: 'string' }, score: { type: 'number' }, challengeable: { type: 'boolean' } },
              },
            },
          },
        },
        responses: { '201': { description: 'Recorded' }, '409': { description: 'Already recorded' } },
      },
      get: {
        summary: 'List benchmark runs for a package (mirrors RegistryClient.listBenchmarksForPackage)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/workspaces/{workspaceId}/registry/benchmarks/{benchmarkId}': {
      get: {
        summary: 'Get one benchmark run (mirrors RegistryClient.getBenchmark)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'benchmarkId', in: 'path', required: true, schema: { type: 'string' } },
        ],
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
                  royaltySplit: {
                    type: 'array',
                    items: { type: 'object', properties: { role: { type: 'string' }, basisPoints: { type: 'number' } } },
                  },
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
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
      },
    },
    '/workspaces/{workspaceId}/registry/ledger/{entryHash}/verify': {
      get: {
        summary: 'Verify a ledger entry (mirrors RegistryClient.verifyLedgerEntry)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'entryHash', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },

    '/packages/validate': {
      post: {
        summary: 'Validate an uploaded .xo archive (read-only; mirrors `xo verify`)',
        description:
          "Verifies against the server's effective package trust policy only: an enforcing operator policy (XO_PACKAGE_TRUST_POLICY) or, for local development only, the explicit XO_TRUST_MODE=development. The server refuses to start with neither (fail closed). Caller-supplied public keys are rejected with 400: a key supplied with the request cannot establish trust. The response includes a `trust` verdict whose `mode` is `enforce` or `development`; in development mode the status is `unverified` and a package is never reported `trusted`.",
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['archiveBase64'],
                properties: {
                  archiveBase64: { type: 'string', description: 'base64-encoded .xo archive bytes' },
                },
              },
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
        description:
          'A "human task" is any execution whose status became waiting_for_human — this view reuses ExecutionRecord.humanTask directly (no separate store). Includes both pending and resolved tasks; filter client-side on humanTask.status if only pending is wanted.',
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
        responses: {
          '200': { description: 'ExecutionRecord (with humanTask populated)' },
          '404': { description: 'Unknown execution, execution was never a human task, or workspace not owned by the caller' },
        },
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
          "resume_unsupported (errorCode XO_HITL_RESUME_UNSUPPORTED) is now the narrow residual case only — reachable if the owning compilation's persisted graph is missing/corrupt; not reachable through normal use of this API. " +
          'Idempotency: a task can be resolved exactly once; a second POST (even with a different/conflicting decision) returns 409 with the ORIGINAL (unmodified) record — concurrent requests for the same execution are additionally serialized in-process (not distributed) via an internal lock, so duplicate/racing requests can never both resume. ' +
          'Authorization: the same workspace-ownership boundary as every other route (no separate reviewer/approver role exists yet — documented limitation, not full RBAC), re-checked at resolve time via requireOwnedWorkspace exactly as at every other route.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'executionId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['decision'],
                properties: { decision: { type: 'string', enum: ['approve', 'reject'] }, data: { type: 'object' } },
              },
            },
          },
        },
        responses: {
          '200': {
            description:
              'ExecutionRecord — status now "succeeded" (approve, resumed) or "rejected" (reject), or "failed" if resume genuinely errored (bad decision data, binding no longer resolves, permission denied, or resume_unsupported); humanTask.status is "resolved" in every case. The record\'s `initiator` is unchanged; the authenticated resolving principal (taken from the API key, never from the body) is recorded as humanTask.resolver',
          },
          '400': { description: 'Invalid decision/data, or this execution was never waiting_for_human' },
          '404': { description: 'Unknown execution, or workspace not owned by the caller' },
          '409': { description: 'Already resolved — body is the ORIGINAL (unmodified) record' },
        },
      },
    },

    // P0.8: persistent, step-aware workflow execution.
    '/workspaces/{workspaceId}/procedures:validate': {
      post: {
        summary:
          "Validate a procedure definition against the strict schema and this workspace's compilation registry (pure: persists nothing)",
        description:
          'Requires permission `procedure.author` (default deny). Body = the ProcedureDefinition JSON, at most 262,144 UTF-8 bytes. Always 200 for a well-formed request: `{ valid, findings[], procedureHash?, registryStateDigest? }`. Findings are stable codes + JSON pointers only; no submitted value is echoed. A missing, failed, other-workspace or drifted compilation fails closed (PROC_COMPILATION_UNAVAILABLE / PROC_COMPILATION_DRIFT). Execution is not part of this API.',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ProcedureDefinition' } } } },
        responses: {
          '200': {
            description: 'Validation report',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ProcedureValidationReport' } } },
          },
          '401': { description: 'Missing/invalid API key' },
          '403': { description: 'Principal lacks procedure.author' },
          '404': { description: 'Workspace not owned by the caller' },
        },
      },
    },
    '/workspaces/{workspaceId}/procedures': {
      get: {
        summary: 'List procedures and their versions with computed lifecycle',
        description:
          'Requires `procedure.read`. `lifecycle` is computed from persisted facts and the CURRENT registry state: draft | approved | approval_stale | approval_invalid | approval_unverifiable. `executable` is always false in this milestone. P1.1 M5: the detail of an APPROVED version also carries `inputSchema` (closed object schema of the `input` that start accepts, derived server-side from the registry; absent for any other lifecycle). It is read-only metadata for the stdio MCP adapter and grants nothing.',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: '{ procedures: [{ procedureId, versions: [...] }] }' },
          '401': { description: 'Missing/invalid API key' },
          '403': { description: 'Principal lacks procedure.read' },
          '404': { description: 'Workspace not owned by the caller' },
        },
      },
    },
    '/workspaces/{workspaceId}/procedures/{procedureId}': {
      get: {
        summary: 'Read one procedure version (latest unless ?version=n)',
        description:
          'Requires `procedure.read`. An unknown procedure, an unknown version, and a procedure in another workspace are indistinguishable (404).',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'procedureId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'version', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
        ],
        responses: {
          '200': {
            description: 'ProcedureView',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ProcedureView' } } },
          },
          '401': { description: 'Missing/invalid API key' },
          '403': { description: 'Principal lacks procedure.read' },
          '404': { description: 'Unknown procedure/version, or workspace not owned by the caller' },
        },
      },
    },
    '/workspaces/{workspaceId}/procedures/{procedureId}/versions/{version}': {
      put: {
        summary: 'Create a draft procedure version (immutable once created)',
        description:
          'Requires `procedure.author`, checked BEFORE the body is read: an unauthorized caller leaves no file. Body = ProcedureDefinition (<= 262,144 UTF-8 bytes); its procedureId and version must equal the path. Created with an atomic put-if-absent: an existing version is never overwritten (409).',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'procedureId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'version', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ProcedureDefinition' } } } },
        responses: {
          '201': {
            description: 'Draft created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ProcedureView' } } },
          },
          '400': { description: 'Rejected: findings[] (stable codes + JSON pointers, never values)' },
          '401': { description: 'Missing/invalid API key' },
          '403': { description: 'Principal lacks procedure.author' },
          '404': { description: 'Workspace not owned by the caller' },
          '409': { description: 'Version already exists (published versions are immutable)' },
        },
      },
    },
    '/workspaces/{workspaceId}/procedures/{procedureId}/versions/{version}/approve': {
      post: {
        summary: 'Approve a procedure version for its CURRENT validated registry state',
        description:
          'Requires `procedure.approve`. The approver is the authenticated principal; there is no body field, header or query parameter that can name one. The server re-validates against the registry at approval time and refuses with findings if anything blocks. A service principal cannot approve a procedure presumed to have side effects (advisory write intent or external tool). Body is optional and closed: only `acknowledgment` (string) is accepted, and is required when the procedure has author-asserted steps or unknowns. The approval binds procedureHash, the validation report hash, the registry state digest and per-step contract hash / permission fingerprint / binding id. Documented limits (not enforced here): there is no approval revocation in this milestone; the interval between a check and any later effect is not closed by approval; XO makes no claim that an approver is independent of the author (one principal may author and approve).',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'procedureId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'version', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
        ],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: { type: 'object', additionalProperties: false, properties: { acknowledgment: { type: 'string' } } },
            },
          },
        },
        responses: {
          '200': {
            description: 'ProcedureView with approval',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ProcedureView' } } },
          },
          '400': { description: 'Body rejected, validation failed against the registry, or acknowledgment missing' },
          '401': { description: 'Missing/invalid API key' },
          '403': { description: 'Principal lacks procedure.approve, or a service principal approving a possibly effectful procedure' },
          '404': { description: 'Unknown procedure/version, or workspace not owned by the caller' },
        },
      },
    },
    '/workspaces/{workspaceId}/procedures/{procedureId}/versions/{version}/executions': {
      post: {
        summary: 'Start an APPROVED procedure version (effect-free); runs until it completes, fails, or pauses at a human gate',
        description:
          'Requires `procedure.execute` (default deny), checked before the body is read. Body (closed): `{ input?: object }`. At start the server recomputes the procedure lifecycle and registry state (anything but `approved` is 403), authorizes EVERY step, and validates `input` against the consumer contracts of the `{input: ...}` bindings; any failure leaves zero execution records. Optional `Idempotency-Key`: the same key and payload replays the same execution (header `idempotent-replayed: true`); a different payload with that key is 422. Effects, MCP, cancel-in-flight and step retries do not exist in this milestone.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'procedureId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'version', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
        ],
        requestBody: {
          required: false,
          content: {
            'application/json': { schema: { type: 'object', additionalProperties: false, properties: { input: { type: 'object' } } } },
          },
        },
        responses: {
          '201': {
            description: 'ProcedureExecution (running to completion, or waiting_for_human)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ProcedureExecution' } } },
          },
          '200': { description: 'The execution ran and failed (see `failure.class`)' },
          '400': { description: 'Body or input rejected: findings[] (codes + JSON pointers only)' },
          '403': {
            description: 'Missing procedure.execute, procedure not approved for its current registry state, or a step is not authorized',
          },
          '404': { description: 'Unknown procedure/version or workspace not owned by the caller' },
          '422': { description: 'Idempotency-Key reused with a different request' },
        },
      },
    },
    '/workspaces/{workspaceId}/procedure-executions/{executionId}': {
      get: {
        summary: 'Read a procedure execution',
        description: 'Requires `procedure.read`. Unknown and other-workspace executions are indistinguishable (404).',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'executionId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'ProcedureExecution',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ProcedureExecution' } } },
          },
          '403': { description: 'Principal lacks procedure.read' },
          '404': { description: 'Unknown execution, or workspace not owned by the caller' },
        },
      },
    },
    '/workspaces/{workspaceId}/procedure-executions/{executionId}/resume': {
      post: {
        summary: 'Resolve the pending human task of a paused procedure execution and continue it',
        description:
          'Requires `procedure.execute`. Body (closed): `{ decision: "approve" | "reject", data?: object, expectedRevision?: integer, expectedStepExecutionId?: string }`. Authorization is re-checked before every later step. 409: already resolved / terminal / not waiting / stale revision / stale step execution (the decision is NOT applied).',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'executionId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['decision'],
                properties: {
                  decision: { type: 'string', enum: ['approve', 'reject'] },
                  data: { type: 'object' },
                  expectedRevision: { type: 'integer' },
                  expectedStepExecutionId: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'ProcedureExecution after the decision',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ProcedureExecution' } } },
          },
          '400': { description: 'Body rejected' },
          '403': { description: 'Missing procedure.execute or the resolver is not authorized' },
          '404': { description: 'Unknown execution, or workspace not owned by the caller' },
          '409': { description: 'Conflict (see description)' },
        },
      },
    },
    '/workspaces/{workspaceId}/procedure-executions/{executionId}/steps/{stepId}/external-effect': {
      get: {
        summary: 'Read the durable external-effect dispatch evidence of a procedure step',
        description:
          'Requires `procedure.read`. Reports whether the step dispatched a consequential external effect, its recorded state and any reconciliation need. Never returns a credential.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'executionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'stepId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'OK' },
          '400': { description: 'Body rejected' },
          '403': { description: 'Missing procedure.read' },
          '404': { description: 'Unknown execution or step, or workspace not owned by the caller' },
          '409': { description: 'Conflict with the recorded state' },
        },
      },
    },
    '/workspaces/{workspaceId}/procedure-executions/{executionId}/steps/{stepId}/external-effect/reconcile': {
      post: {
        summary: 'Record the operator-confirmed outcome of an external effect whose dispatch result is unknown',
        description:
          'Requires `effect.reconcile`. The only way an unknown-outcome effect is closed: the dispatcher never guesses and never retries a consequential effect on its own.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'executionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'stepId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'OK' },
          '400': { description: 'Body rejected' },
          '403': { description: 'Missing effect.reconcile' },
          '404': { description: 'Unknown execution or step, or workspace not owned by the caller' },
          '409': { description: 'Conflict with the recorded state' },
        },
      },
    },
    '/workspaces/{workspaceId}/procedure-executions/{executionId}/steps/{stepId}/payload-approval': {
      get: {
        summary: 'Read the payload-level approval requirement and state for a procedure step',
        description:
          'Requires `procedure.read`. Describes the exact payload a payload-approval would bind to, and whether it has been granted.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'executionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'stepId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'OK' },
          '400': { description: 'Body rejected' },
          '403': { description: 'Missing procedure.read' },
          '404': { description: 'Unknown execution or step, or workspace not owned by the caller' },
          '409': { description: 'Conflict with the recorded state' },
        },
      },
      post: {
        summary: 'Grant payload-level approval for the exact payload of an external-effect step',
        description:
          'Requires `effect.payloadApprove`. The approval is bound to the exact payload digest; a changed payload needs a new approval.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'executionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'stepId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'OK' },
          '400': { description: 'Body rejected' },
          '403': { description: 'Missing effect.payloadApprove' },
          '404': { description: 'Unknown execution or step, or workspace not owned by the caller' },
          '409': { description: 'Conflict with the recorded state' },
        },
      },
    },
    '/workspaces/{workspaceId}/procedure-executions/{executionId}/steps/{stepId}/payload-approval/continue': {
      post: {
        summary: 'Continue a procedure execution after payload-level approval was granted',
        description: 'Requires `procedure.execute`. Authorization and the payload approval are re-checked before the effect is dispatched.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'executionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'stepId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'OK' },
          '400': { description: 'Body rejected' },
          '403': { description: 'Missing procedure.execute' },
          '404': { description: 'Unknown execution or step, or workspace not owned by the caller' },
          '409': { description: 'Conflict with the recorded state' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflows': {
      get: {
        summary: "Discover the workflows composed from this workspace's stored compilations",
        description:
          "Derived server-side, on every call, from each SUCCEEDED compilation's persisted compiled graph via the existing @xo/workflow-composer (composeWorkflows -> auditWorkflowExecutability / auditWorkflowDataFlow) and @xo/runtime (prepareCandidateWorkflowForExecution) — never from client input. " +
          '`status` is the audit\'s verdict VERBATIM: "executable_candidate" | "not_executable_yet" | "semantically_invalid"; it is never upgraded. `executable` is true only when status is executable_candidate AND every step binds to an executable capability (deterministic_rule or human_in_the_loop); `notExecutableReasons`/`blockers` explain a false. Only executable workflows can be started (POST .../workflows/{workflowId}/executions). ' +
          'Workflow ids are content-derived, so the same source compiled twice yields the same workflowId in two compilations — always address a workflow as (compilationId, workflowId). ' +
          "`steps[].approved` reflects P0.5 capability approval in THIS workspace (every step must be approved to start). `dataFlow.provenBindings[]` lists authoritative producer->consumer bindings; `wired: true` means the runtime bridge will actually transfer the producer's value at execution time. Suggestive/unbound data flow is only counted, never executed. " +
          'Optional query `compilationId` restricts to one compilation (404 if unknown). A compilation whose stored graph cannot be loaded is reported under `unavailableCompilations` rather than silently dropped.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'compilationId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: '{ workflows: WorkflowView[], unavailableCompilations?: [...] }',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { workflows: { type: 'array', items: { $ref: '#/components/schemas/WorkflowView' } } },
                },
              },
            },
          },
          '401': { description: 'Missing/invalid API key' },
          '404': { description: 'Workspace not owned by the caller, or unknown compilationId filter' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflows/{workflowId}/executions': {
      post: {
        summary: 'Start a persistent workflow execution (composed runner; deprecated, ADR 0035)',
        deprecated: true,
        description:
          'ADR 0035: the composed-workflow runner is retired wherever readiness certificates are required (the production default): there every start is refused — without a certificate 409 XO_READINESS_CERTIFICATE_REQUIRED, with one 409 XO_WORKFLOW_REQUIRES_IR_RUNTIME naming POST …/generated-workflows/{definitionId}/runs. A certified start is ALWAYS sent to the workflow runtime, whatever its constructs. Uncertified starts remain for development workspaces only, and existing executions can still be read, decided and resumed until they finish. ' +
          'Body: { compilationId (required), workflowId? (must equal the path if present), input?, certificateId? }. PX-7: a presented `certificateId` must name a readiness certificate for this exact workflow that is intact, READY (or READY_WITH_CONDITIONS) and current — every digest it binds (source set, artifact, graph, knowledge state, inventory, step contracts, workflow definition, goal, applied waivers and rulings) is recomputed now; otherwise 409 XO_READINESS_CERTIFICATE_REFUSED with `context.reasons`. ADR 0035 (was ADR 0031, for IR-only constructs): a verified certificate is always 409 XO_WORKFLOW_REQUIRES_IR_RUNTIME with `context.definitionId` and `context.constructs` (what only the Workflow IR runtime executes; may be empty): start it with POST …/generated-workflows/{definitionId}/runs. When the instance policy XO_READINESS_CERTIFICATE is `required` (the production default) or the workspace setting trust.requireReadinessCertificate is on, a start without one is 409 XO_READINESS_CERTIFICATE_REQUIRED. Permission is still rechecked live for every step. ANY other field is rejected with 400 (XO_INVALID_ARGUMENT, `context.unknownFields`): workflow steps, capability ids, execution classes, bindings, runtime declarations, identity ids, filesystem paths and storage keys can never be supplied by a client — the plan is always re-derived from the stored compilation. ' +
          'Server steps: authenticate -> workspace ownership -> load the stored compilation/graph -> resolve the workflow -> require audit status executable_candidate with every step bound (else 422 XO_WORKFLOW_NOT_EXECUTABLE, `context` carries executabilityStatus/reasons/blockers) -> authorization preflight for EVERY step (capability approved in this workspace, and every non-optional contract permission granted under the fail-closed empty policy; else 403 XO_RUNTIME_PERMISSION_DENIED) -> validate `input` -> persist the record -> execute. Nothing is persisted for a request refused before that point. ' +
          '`input` is a bounded (64 KiB) plain JSON object: each field is delivered to every step whose declared input schema names it (steps with no declared schema, today every human_in_the_loop step, receive the whole object); no mapping is inferred from names or prose. It is validated with the same validateCapabilityInput P0.5 uses, at start (for what the client must supply) and again immediately before each step (client-supplied fields only — values injected by a proven upstream binding are authoritative producer output). A field no step can receive is a 400. Proven upstream values cannot be supplied or overridden by the client. ' +
          'Execution is synchronous and strictly sequential through the existing WorkflowExecutor/RuntimeCapabilityExecutor: it runs until the workflow succeeds, fails, or reaches a human_in_the_loop step, where it STOPS (status waiting_for_human) and returns; later steps do not run. Each step is recorded as a normal P0.5 ExecutionRecord (visible under /executions and, for HITL, /human-tasks). ' +
          'Status codes follow P0.5: 201 for succeeded/waiting_for_human, 200 when the workflow FAILED (still a real, persisted record). Without an Idempotency-Key header, starting creates a distinct execution each time; with one, see the header parameter.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            description:
              'Optional (P1.0 M6). 8-128 chars of [A-Za-z0-9._:-], starting with a letter or digit. Scoped to workspace + authenticated principal + operation. Same key + equivalent request returns the original outcome (header `Idempotent-Replayed: true`) without running again; same key + different request is 422 XO_IDEMPOTENCY_KEY_REUSED; same key while the original is running is 409 XO_IDEMPOTENCY_IN_PROGRESS (Retry-After); an interrupted original whose end cannot be proven is 409 XO_IDEMPOTENCY_OUTCOME_UNKNOWN and is never re-run or reported as success; an unreadable key record is 500 XO_IDEMPOTENCY_RECORD_INVALID. Authentication, authorization (M2) and approval (M3) are re-checked on every request, replays included. Not an exactly-once guarantee.',
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['compilationId'],
                additionalProperties: false,
                properties: {
                  compilationId: { type: 'string' },
                  workflowId: { type: 'string' },
                  input: { type: 'object' },
                  certificateId: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'WorkflowExecution — status succeeded or waiting_for_human',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkflowExecution' } } },
          },
          '200': {
            description:
              'WorkflowExecution — status failed (a step failed at run time, e.g. authorization revoked or input invalid); still a structured, persisted record',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkflowExecution' } } },
          },
          '400': {
            description:
              "Unknown/forbidden body field, missing compilationId, workflowId mismatch, invalid/oversized input, or input failing a step's declared schema",
          },
          '401': { description: 'Missing/invalid API key' },
          '403': {
            description:
              "XO_RUNTIME_PERMISSION_DENIED — a step's capability is not approved, or a required contract permission is not granted",
          },
          '404': { description: 'Workspace not owned by the caller, or unknown compilation / workflow in this workspace' },
          '422': {
            description:
              'XO_WORKFLOW_NOT_EXECUTABLE — the workflow exists but its audit status is not_executable_yet or semantically_invalid, or a step cannot be bound',
          },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-executions': {
      get: {
        summary: 'List workflow executions in this workspace',
        description:
          'Oldest first. A record persisted as created/running that this process is not driving (its process disappeared) is reconciled to `interrupted` (or its completed step outcome adopted) on read — see the resume endpoint for the recovery semantics.',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: '{ workflowExecutions: WorkflowExecution[] }' },
          '404': { description: 'Workspace not owned by the caller' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-executions/{workflowExecutionId}': {
      get: {
        summary: 'Retrieve one workflow execution (workflow status, per-step state, pending human task, final result)',
        description:
          "Persisted at <WORKSPACE_DATA_DIR>/<workspaceId>/workflow-executions/<workflowExecutionId>/metadata.json (the existing BlobStore abstraction). `steps[].executionId` references the underlying P0.5 ExecutionRecord, which remains the source of truth for a step's input/output/human task. `revision` starts at 0 and increases with every persisted transition; updates are compare-and-swap on it. " +
          '`pendingHumanTask.humanTaskStatus` is read through from the step\'s execution record, so a task resolved directly via POST /executions/{id}/resolve is visible here as "resolved" while the workflow still waits for a `resume`. ' +
          'Workflow statuses: created, running, waiting_for_human, succeeded, failed, rejected (terminal: succeeded/failed/rejected), interrupted. Step statuses: pending, running, waiting_for_human, succeeded, failed, rejected, skipped, interrupted. "succeeded" is reported only when EVERY step succeeded. A failed or rejected workflow marks its never-executed later steps "skipped". ' +
          'Cross-workspace ids are 404.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowExecutionId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'WorkflowExecution',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkflowExecution' } } },
          },
          '404': {
            description:
              'Unknown workflow execution in this workspace (including ids belonging to another workspace), or workspace not owned by the caller',
          },
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
          "interrupted: a workflow persisted as created/running whose process is gone. On read/resume it is reconciled: if the running step's ExecutionRecord had been COMPLETED its outcome is adopted (no re-execution); otherwise the step is marked interrupted and is never assumed done. An explicit resume (no decision/data) re-executes ONLY that step under a NEW execution id (old id kept in steps[].supersededExecutionIds) and continues. There are no automatic retries. " +
          'RESTART/RECOVERY LIMITATIONS: filesystem-backed and in-process only. Completed steps are at-most-once under normal continuation; an interrupted in-flight step is at-least-once when explicitly resumed; exactly-once is NOT provided. BlobStore writes are plain writeFile (not write-then-rename), so a crash during a write can leave a truncated record that reads as 404. Compare-and-swap on revision is not a distributed transaction.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowExecutionId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  decision: { type: 'string', enum: ['approve', 'reject'] },
                  data: { type: 'object' },
                  expectedStepExecutionId: { type: 'string' },
                  expectedRevision: { type: 'integer', minimum: 0 },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description:
              'WorkflowExecution after the continuation (succeeded, failed, rejected, or waiting_for_human again at a later HITL step)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkflowExecution' } } },
          },
          '400': {
            description:
              'Unknown field; decision missing for an unresolved task; decision supplied to an interrupted workflow; or expectedStepExecutionId missing for a multi-step workflow with a pending HITL step',
          },
          '404': { description: 'Unknown workflow execution in this workspace, or workspace not owned by the caller' },
          '409': {
            description:
              'Deterministic conflict (XO_RUNTIME_SESSION_INVALID_STATE, context.reason): workflow already terminal, stale expectedStepExecutionId, stale expectedRevision, resume already in flight, or the task was already resolved',
          },
        },
      },
    },

    // P0.5: capability approval + synchronous single-capability execution.
    '/workspaces/{workspaceId}/compilations/{compilationId}/capabilities/{capabilityId}/approve': {
      post: {
        summary: 'Approve a discovered capability for execution',
        description:
          'Records that the authenticated principal (never a request field) approved this capability, from this compilation, in this workspace, IN ITS CURRENT MATERIAL STATE: the server derives and stores a binding over the capability contract content (including its rules), its permission declaration, its resolved binding and the compilation source digest (P1.0 M3). The request body is ignored. The approval is honoured only while that state is unchanged; a materially changed capability is refused (403 at execution, workflow start and human-task resume) until it is approved again. Approvals recorded before M3 carry no binding and are refused until re-approved. 400 if the capability has no derivable state. No review comments, multi-reviewer quorum, or un-approve endpoint.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'compilationId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'capabilityId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'ApprovalRecord' },
          '400': { description: 'The compilation did not succeed, or the capability has no derivable approvable state' },
          '422': {
            description:
              'XO_BINDING_UNRESOLVED or XO_BINDING_AMBIGUOUS — the capability is not resolved, so it cannot be carried out and no approval is recorded',
          },
          '403': { description: 'XO_BINDING_DENIED — the capability binding was denied; no approval is recorded' },
          '404': { description: 'Unknown compilation/capability, or workspace not owned by the caller' },
          '503': { description: 'Durable audit evidence for the approval could not be recorded; no approval was created' },
        },
      },
    },
    '/workspaces/{workspaceId}/executions': {
      post: {
        summary: 'Execute an approved capability synchronously through the real runtime capability-authority path',
        description:
          'Body: { compilationId, capabilityId, input }. No client-supplied runtime declaration, execution class, or identity is ever accepted — the declaration is always re-derived server-side from the stored, compiled graph. Execution is synchronous: the response always reports a finished outcome. status "succeeded": the real deterministic (or other resolved) result. status "waiting_for_human": an honest human-in-the-loop escalation — this milestone does not implement HITL resume; the execution record is terminal. status "failed": rejected before running (not approved, unresolved/ambiguous/denied binding, invalid input) or a genuine runtime failure — always a structured errorCode/errorMessage, never a fabricated success. Permission gate: RuleBasedPolicy([]) (deny-by-default for any capability that declares required permissions; today\'s compiled capabilities typically declare none) — never an unrestricted allow-all gate.',
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            description:
              'Optional (P1.0 M6). 8-128 chars of [A-Za-z0-9._:-], starting with a letter or digit. Scoped to workspace + authenticated principal + operation. Same key + equivalent request returns the original outcome (header `Idempotent-Replayed: true`) without running again; same key + different request is 422 XO_IDEMPOTENCY_KEY_REUSED; same key while the original is running is 409 XO_IDEMPOTENCY_IN_PROGRESS (Retry-After); an interrupted original whose end cannot be proven is 409 XO_IDEMPOTENCY_OUTCOME_UNKNOWN and is never re-run or reported as success; an unreadable key record is 500 XO_IDEMPOTENCY_RECORD_INVALID. Authentication, authorization (M2) and approval (M3) are re-checked on every request, replays included. Not an exactly-once guarantee.',
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['compilationId', 'capabilityId'],
                properties: { compilationId: { type: 'string' }, capabilityId: { type: 'string' }, input: { type: 'object' } },
              },
            },
          },
        },
        responses: {
          '201': {
            description:
              'ExecutionRecord (includes `initiator`: the authenticated principal, never client-supplied), status succeeded or waiting_for_human',
          },
          '401': { description: 'Missing, invalid, revoked, or principal-unbound API key' },
          '200': {
            description:
              'ExecutionRecord, status failed (unapproved, unresolved, invalid input, or runtime failure — still a structured, persisted record)',
          },
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
        summary: "Get an execution's result/status",
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'executionId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'ExecutionRecord' },
          '404': { description: 'Unknown execution, or workspace not owned by the caller' },
        },
      },
    },

    // P0.4: source compilation (synchronous) and capability retrieval.
    '/workspaces/{workspaceId}/sources/{sourceId}/compile': {
      post: {
        summary: 'Compile a stored source synchronously and persist the result',
        description:
          "Runs @xo/compiler's compileSources + packageXoirGraph preview against the source's stored bytes. Every call creates a new compilation record (no dedup by digest — see the P0.4 completion report). The response always reflects a finished status (succeeded/failed), never running.",
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'sourceId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '201': { description: 'CompilationRecord, status succeeded' },
          '200': { description: 'CompilationRecord, status failed' },
          '404': { description: 'Unknown/cross-workspace source, or workspace not owned by the caller' },
        },
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
        summary: "Get a compilation's status/metadata",
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'compilationId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'CompilationRecord' },
          '404': { description: 'Unknown compilation, or workspace not owned by the caller' },
        },
      },
    },
    '/workspaces/{workspaceId}/compilations/{compilationId}/artifact': {
      get: {
        summary: 'Get the complete compilation artifact (PX-1)',
        description:
          'Everything the compiler returned — validation, diagnostics, review queue, unclassified sentences, cross-document conflicts, execution readiness, per-page coverage, pass history — bound to the source set (`sourceSet`, id `ss_…`) and the compile configuration (`configurationDigest`), content-addressed by `digest`. Verified against its digest and the compilation record before it is served; a stored artifact that fails the check is reported, never served. Compilations made before PX-1 have none.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'compilationId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'CompilationArtifact (@xo/pre-execution)' },
          '404': { description: 'Unknown compilation, no artifact, failed integrity check, or workspace not owned by the caller' },
        },
      },
    },
    '/workspaces/{workspaceId}/compilations/{compilationId}/source-quality': {
      get: {
        summary: 'Source quality gate for a compilation (PX-2)',
        description:
          'Per source: quality state (trusted | degraded | partial | blocked), findings (unread pages, pages read only by a hosted model, degraded or blocked text), which waivers cover them, and the gate status for `purpose` (approval | readiness): pass, pass-with-waivers, or blocked with the reasons. Degraded and partial sources need a waiver covering every finding; blocked sources cannot be waived.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'compilationId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'purpose', in: 'query', required: false, schema: { type: 'string', enum: ['approval', 'readiness'] } },
        ],
        responses: { '200': { description: '{ purpose, status, blockers, assessment? }' }, '404': { description: 'Unknown compilation' } },
      },
    },
    '/workspaces/{workspaceId}/compilations/{compilationId}/waivers': {
      post: {
        summary: 'Record a source-quality waiver (PX-2)',
        description:
          "Body `{ digestSha256, reason, findings?, scope? }`. Needs the review role and a recent sign-in. The findings are the server's reading of the compilation (a subset may be named, never new ones); the waiver binds to that source version and quality state, is attributed to the authenticated principal, audited (waiver.granted / waiver.denied), append-only, and content-addressed.",
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'compilationId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '201': { description: 'SourceWaiver' },
          '400': { description: 'Nothing to waive, blocked source, unknown finding, or no reason' },
        },
      },
    },
    '/workspaces/{workspaceId}/compilations/{compilationId}/completeness': {
      get: {
        summary: 'Completeness of a compilation, apart from validity (PX-3)',
        description:
          'Dimensions: structure (graph validity), source-coverage (unread pages net of readiness waivers), unparsed-sentences, conflicts, review-items (priority 1-2). Each lists its open items; rulings and waivers close them. Stale rulings (another set, changed text, failed digest) are reported, never applied.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'compilationId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'CompletenessAssessment' }, '404': { description: 'Unknown compilation or no artifact' } },
      },
    },
    '/workspaces/{workspaceId}/compilations/{compilationId}/rulings': {
      post: {
        summary: 'Record a human ruling on a review item (PX-3)',
        description:
          'Body `{ reviewItemId, decision }`, decision one of `{kind:"not-operational", note?}`, `{kind:"confirm-rule", condition, outcome}`, `{kind:"resolve-conflict", prevails:"a"|"b", rationale}`, `{kind:"acknowledge", note}`. Needs the review role and a recent sign-in. Bound to the compilation\'s source set; attributed, audited (ruling.recorded / ruling.denied), append-only. A confirm-rule ruling is a confirmed rule in the next compilation of the same source set.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'compilationId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '201': { description: 'HumanRuling' }, '400': { description: 'Unknown item, or a decision that does not fit it' } },
      },
    },
    '/workspaces/{workspaceId}/rulings': {
      get: {
        summary: "List the workspace's human rulings (PX-3)",
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '{ rulings: HumanRuling[] }' } },
      },
    },
    '/workspaces/{workspaceId}/compilations/{compilationId}/knowledge-change-sets': {
      post: {
        summary: 'Propose the knowledge in a compilation as a Business Knowledge Base change set (PX-4)',
        description:
          'Maps the compiled graph through the XOIR→BKB adapter (mapping xoir-bkb.v1) against the current head state. Nothing is applied: the change set waits for a reviewer. The report lists accepted, unchanged, updated (proposed as supersessions), conflicting, unresolved (ambiguous entities, never merged), rejected (no evidence) and unsupported items. Recompiling the same sources proposes nothing (200, changeSet null). Needs the author role; audited as knowledge.change-set.proposed.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'compilationId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '201': { description: '{ changeSet: ChangeSet, report }' },
          '200': { description: '{ changeSet: null, report }: nothing new' },
          '404': { description: 'Unknown compilation or no artifact' },
        },
      },
    },
    '/workspaces/{workspaceId}/knowledge/change-sets': {
      get: {
        summary: 'List knowledge change sets with their decisions (PX-4)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'status', in: 'query', required: false, schema: { type: 'string' }, description: 'proposed | approved | rejected' },
        ],
        responses: { '200': { description: '{ changeSets: ChangeSet[] }' } },
      },
    },
    '/workspaces/{workspaceId}/knowledge/change-sets/{changeSetId}': {
      get: {
        summary: 'One knowledge change set: operations, validation findings, reconciliation report, decision (PX-4)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'changeSetId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ChangeSet' }, '404': { description: 'Unknown change set' } },
      },
    },
    '/workspaces/{workspaceId}/knowledge/change-sets/{changeSetId}/preview': {
      get: {
        summary:
          'Preview a proposed knowledge change set: the state approval would create, and the certified workflows it affects (UW-11a)',
        description:
          'Computed and not stored; the head does not move. `stale` says the head moved since the proposal (propose again). `affected` counts certificates whose dependency root would change (at most 200 listed).',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'changeSetId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: '{ preview: ChangeSetPreview, affected: { count, certificates[] } }' },
          '404': { description: 'Unknown change set' },
          '409': { description: 'Already decided' },
        },
      },
    },
    '/workspaces/{workspaceId}/knowledge/rollbacks': {
      post: {
        summary: 'Propose a rollback to an ancestor knowledge state (UW-11a)',
        description:
          'Body `{ toStateId, reason }`. Needs the author role. Proposes a change set (origin rollback); nothing changes until a reviewer approves it, and when the instance requires separation of duties the proposer cannot approve it.',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '201': { description: '{ changeSet }' },
          '409': { description: 'The target is not an ancestor, or nothing differs' },
          '403': { description: 'Needs the author role' },
        },
      },
    },
    '/workspaces/{workspaceId}/knowledge/states': {
      get: {
        summary: 'List knowledge states, newest first (UW-11a)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'page', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'size', in: 'query', required: false, schema: { type: 'integer' }, description: 'At most 200' },
        ],
        responses: { '200': { description: '{ states: { stateId, parentStateId, changeSetId, createdAt }[], total }' } },
      },
    },
    '/workspaces/{workspaceId}/knowledge/change-sets/{changeSetId}/approve': {
      post: {
        summary: 'Approve a knowledge change set, creating the next immutable knowledge state (PX-4)',
        description:
          'Body `{ reason, precedencePolicy? }`. Needs the review role and a recent sign-in. Refused (409 XO_KNOWLEDGE_CHANGE_SET_REFUSED, context.knowledgeError) when already decided, proposed against an older head (stale_base: propose again), or carrying error findings. Competing claims are both kept; the state records the conflict, resolved by the precedence policy when given or left for a ruling.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'changeSetId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: '{ changeSet, state }' },
          '409': { description: 'Refused' },
          '404': { description: 'Unknown change set' },
        },
      },
    },
    '/workspaces/{workspaceId}/knowledge/change-sets/{changeSetId}/reject': {
      post: {
        summary: 'Reject a knowledge change set (PX-4)',
        description:
          'Body `{ reason }`. Needs the review role and a recent sign-in. Its records stay stored for audit but never enter a state through it.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'changeSetId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: '{ changeSet }' }, '409': { description: 'Already decided' } },
      },
    },
    '/workspaces/{workspaceId}/knowledge/state': {
      get: {
        summary: 'The head knowledge state: the one created by the last approval (PX-4)',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'KnowledgeState (entries with record digests and lifecycle, conflicts, pack bindings, precedence policy, digest)',
          },
        },
      },
    },
    '/workspaces/{workspaceId}/knowledge/states/{stateId}': {
      get: {
        summary: 'A pinned knowledge state (PX-4)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'stateId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'KnowledgeState' }, '404': { description: 'Unknown state' } },
      },
    },
    '/workspaces/{workspaceId}/knowledge/states/{stateId}/verify': {
      get: {
        summary: 'Verify a knowledge state: its digest, every record digest, dangling references, authority and evidence (PX-4)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'stateId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description:
              '{ stateId, verified, findings, contentRoot }. For the head state, the findings include the head-pointer checks (UW-4b): the pointer names the state of the last state.created event and matches its content root.',
          },
        },
      },
    },
    '/workspaces/{workspaceId}/source-connections': {
      get: {
        summary: 'The workspace source connections (UW-12a; read role)',
        'x-xo-permission': 'read',
        description:
          "Each connection: connectionId, kind (local_folder | agent_folder | microsoft_drive | google_drive), displayName (the folder's last segment: the path is never returned), sync (manual or every N minutes), paused, freshness (never_synced | current | stale | needs_attention | paused | retired), files, lastSync (counts only) and how many role proposals it has. `?retired=true` includes retired connections. See docs/SOURCE_CONNECTIONS.md.",
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '{ connections }' } },
      },
      post: {
        summary: 'Connect a folder as a source (UW-12a; manage role, recent sign-in)',
        'x-xo-permission': 'manage',
        description:
          'Body `{ kind: "local_folder", root, sync? }`, `{ kind: "microsoft_drive" | "google_drive", credentialId, folder, sync? }` (a workspace credential with the files.read capability; folder from …/drive-folders) or `{ kind: "agent_folder", sync? }` (a folder on a person\'s own computer, sent by the XO agent: answers 201 with a one-time pairing code and the command to run there; nothing is synced until it pairs). sync is `{ mode: "manual" }` (default) or `{ mode: "interval", everyMinutes: 15…10080 }`. The folder\'s real path must be inside one of the instance\'s XO_SOURCE_FOLDER_ROOTS (412 otherwise, and always when none is set); links are judged by where they really go. Synced at once: every supported file is stored as a workspace source (origin `connection`) through the same checks as an upload; links, hidden files, secret-looking names and hard-linked files are counted, never read. One active connection per folder (409). Audited.',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '201': { description: '{ connection } (detail)' },
          '409': { description: 'the folder is already connected' },
          '412': { description: 'the folder is not allowed' },
        },
      },
    },
    '/workspaces/{workspaceId}/source-connections/options': {
      get: {
        summary: 'What this instance can connect (UW-12a part 2; read role)',
        'x-xo-permission': 'read',
        description:
          "Answers `{ localFolder: { available }, drives: [{ provider, kind, displayName, available, reason? }], agent: { available, serverAddress? } }`. A local folder needs XO_SOURCE_FOLDER_ROOTS; a drive needs XO_CREDENTIALS_KEY and that provider's OAuth client (reason `connections_not_configured` or `provider_not_configured`). `serverAddress` is XO_PUBLIC_BASE_URL, the address an agent on another computer uses. No path or secret is returned.",
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '{ localFolder, drives, agent }' } },
      },
    },
    '/workspaces/{workspaceId}/source-connections/drive-folders': {
      get: {
        summary: 'Browse the folders of a connected drive, to choose one (UW-12a part 2; manage role)',
        'x-xo-permission': 'manage',
        description:
          'Query `provider` (microsoft | google), `credentialId` (a workspace credential with files.read) and `parent` (a ref from a previous answer; absent = the drives). Answers `{ folders: [{ ref, name, kind: drive | folder }] }`, folders only. Every call goes through the credential broker to the provider. 412 when the credential cannot be used.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'provider', in: 'query', required: true, schema: { type: 'string', enum: ['microsoft', 'google'] } },
          { name: 'credentialId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'parent', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { '200': { description: '{ folders }' }, '412': { description: 'the credential cannot be used' } },
      },
    },
    '/workspaces/{workspaceId}/source-connections/{id}/agent/pair': {
      post: {
        summary: 'Make a new pairing code for an agent folder (UW-12a part 2; manage role, recent sign-in)',
        'x-xo-permission': 'manage',
        description:
          'Revokes the agent currently paired (its token stops working at once) and answers `{ connection, pairing: { code, expiresAt, command } }`. The code is single-use and expires after 15 minutes. The agent itself talks to the public /agent/v1/* endpoints with its own token (protocol xo.agent/1, docs/SOURCE_CONNECTIONS.md).',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: '{ connection, pairing }' }, '400': { description: 'not an agent folder' } },
      },
    },
    '/workspaces/{workspaceId}/source-connections/{id}': {
      get: {
        summary: 'A source connection: its files, freshness, last sync, retired versions and proposed roles (UW-12a; read role)',
        'x-xo-permission': 'read',
        description:
          'Proposals (contact_list, record_table, document_collection, per_person_documents) carry a label, what they rest on (basis), a strength, and their status: proposed until a person confirms or rejects it; `changedSinceDecision` when the files changed since.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: '{ connection }' } },
      },
    },
    '/workspaces/{workspaceId}/source-connections/{id}/sync': {
      post: {
        summary: 'Sync a source connection now (UW-12a; author role)',
        'x-xo-permission': 'author',
        description:
          'New and changed files become new source versions; the version a changed file replaces, and the version of a file that left the folder, are retired (kept, with `retired`; knowledge citing them resolves as source_retired and no longer feeds execution). A listing stopped at a limit retires nothing. A file the door refuses is counted (refused_at_door) and the version already held stays current. 412 when paused or retired. For an agent folder this asks the agent to sync at its next check (about a minute) and answers 202.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: '{ connection }' } },
      },
    },
    '/workspaces/{workspaceId}/source-connections/{id}/schedule': {
      put: {
        summary: 'Sync manually or every N minutes (UW-12a; manage role)',
        'x-xo-permission': 'manage',
        description:
          'Body `{ sync, expectedRevision? }`. The scheduler syncs interval connections when due; one is stale after two missed slots.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: '{ connection }' } },
      },
    },
    '/workspaces/{workspaceId}/source-connections/{id}/pause': {
      post: {
        summary: 'Stop syncing a source connection (UW-12a; manage role)',
        'x-xo-permission': 'manage',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: '{ connection }' } },
      },
    },
    '/workspaces/{workspaceId}/source-connections/{id}/resume': {
      post: {
        summary: 'Restart syncing a paused source connection (UW-12a; manage role)',
        'x-xo-permission': 'manage',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: '{ connection }' } },
      },
    },
    '/workspaces/{workspaceId}/source-connections/{id}/retire': {
      post: {
        summary: 'Retire a source connection (UW-12a; manage role, recent sign-in)',
        'x-xo-permission': 'manage',
        description:
          'No more syncs; every version it holds is retired (kept for evidence). Nothing in the folder is touched. The folder can be connected again.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: '{ connection }' } },
      },
    },
    '/workspaces/{workspaceId}/source-connections/{id}/proposals/{proposalId}/decision': {
      post: {
        summary: 'Confirm or reject what XO thinks a file or folder is (UW-12a; author role)',
        'x-xo-permission': 'author',
        description:
          'Body `{ decision: "confirmed" | "rejected", expectedRevision? }`. A confirmed role is an operational binding (this table is the client list), not business knowledge. The decision records the file versions it was made on. Audited as source_connection.role_decided.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'proposalId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: '{ connection }' }, '404': { description: 'not a current proposal of this connection' } },
      },
    },
    '/workspaces/{workspaceId}/discovery': {
      get: {
        summary:
          'What the active source connections hold, as proposals, and the message XO would open a conversation with (UW-12a; read role)',
        'x-xo-permission': 'read',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '{ connections, proposals, message }' } },
      },
    },
    '/workspaces/{workspaceId}/discovery/conversation': {
      post: {
        summary: "Start a conversation with what XO found (UW-12a; read role; the conversation is the caller's own)",
        'x-xo-permission': 'read',
        description:
          'Body `{ connectionIds? }`. Creates an intelligence conversation whose first message (no model is asked) says what was found, what each thing looks like, and asks "What would you like to do?". The message carries `discovery` (the proposals as they stood); confirming one goes through the source-connection API, never through the conversation. 412 when there is no active connection.',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '201': { description: 'the conversation' } },
      },
    },
    '/workspaces/{workspaceId}/data-protection': {
      get: {
        summary: 'What this workspace protects from hosted models (UW-14c; manage role)',
        'x-xo-permission': 'manage',
        description:
          "The data-protection settings (values an administrator added, columns always protected, columns never protected) and the known-value dictionary built from the workspace's own spreadsheets: which columns feed it (source, record set, header, kind, how many values) — never the values themselves. Every model request made while serving a /workspaces/{id}/… request is checked against this dictionary and the locale pattern packs before it can leave for a hosted provider; any hit refuses it (403 XO_AI_INFERENCE_DENIED, reason leak_guard_blocked) and audits model.egress.blocked with hashes only. See docs/RESIDENCY.md.",
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '{ settings, dictionary: { knownValues, truncated, columns, unreadableSources } }' } },
      },
      put: {
        summary: "Change this workspace's data-protection settings (UW-14c; manage role, recent sign-in)",
        'x-xo-permission': 'manage',
        description:
          'Body `{ values?: { value, kind }[], protectColumns?: string[], ignoreColumns?: string[], expectedRevision? }`; kind is name | organization | email | phone | identifier | address | other. At most 5000 values (200 characters each) and 200 columns per list; unknown fields are a 400. A stale expectedRevision is a 412 XO_PRECONDITION_FAILED. Audited as data-protection.updated with counts only.',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '{ settings }' } },
      },
    },
    '/workspaces/{workspaceId}/data-protection/scan': {
      post: {
        summary: 'What the leak guard would find in a text (UW-14e; read role)',
        'x-xo-permission': 'read',
        description:
          'Body `{ text }` (at most 100,000 characters). Returns `{ blocked, hits: { entity, detector, start, end, hash, encoded? }[], masked }`: where in the given text each protected value is and of what kind, and the text with each one replaced by its kind ([PERSON], [PAN]). Never says which dictionary entry matched. Nothing is sent anywhere.',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '{ blocked, hits, masked }' } },
      },
    },
    '/workspaces/{workspaceId}/credentials': {
      get: {
        summary: 'List the connection credentials of a workspace (UW-9; author role)',
        'x-xo-permission': 'author',
        description:
          'Never returns a secret. Each entry: credentialId, kind (oauth2 | basic), provider, capabilities, the scopes the provider granted, the account label, state (active | revoked | expired), dates and why it ended. Tokens and passwords are sealed per workspace (AES-256-GCM under a key derived for the workspace) and only ever released, per call, to a connector the workspace bound to the credential.',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: '{ credentials }' },
          '503': { description: 'XO_CREDENTIALS_NOT_CONFIGURED: the instance has no credentials key' },
        },
      },
    },
    '/workspaces/{workspaceId}/credentials/providers': {
      get: {
        summary: 'What can be connected here, and exactly which scopes each capability asks for (UW-9)',
        'x-xo-permission': 'read',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description:
              '{ redirectUri, oauth: { provider, configured, capabilities: { capability, scopes }[], providerRevocation }[], basic }',
          },
        },
      },
    },
    '/workspaces/{workspaceId}/credentials/oauth': {
      post: {
        summary: 'Start connecting an account with OAuth (authorization code + PKCE S256) (UW-9; manage role, recent sign-in)',
        'x-xo-permission': 'manage',
        description:
          'Body { provider: google | microsoft, capabilities: ["message.send"], loginHint? }. XO asks for capabilities, never scope names: each maps to the narrowest scope (gmail.send; Mail.Send) plus identity. Returns the provider URL to open; the consent expires in 10 minutes and is completed by the provider redirecting the browser to GET /oauth/callback. A grant that lacks a needed scope or exceeds what was asked is refused and nothing is stored. Audited as credential.oauth.started, then credential.created or credential.oauth.failed.',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '201': { description: '{ authorizationUrl, provider, scopes, expiresAt }' },
          '400': { description: 'Unknown provider or capability' },
          '503': { description: 'No credentials key, or no OAuth client for that provider' },
        },
      },
    },
    '/workspaces/{workspaceId}/credentials/basic': {
      post: {
        summary: 'Add a user name and app password for a server without OAuth (SMTP/IMAP) (UW-9; manage role, recent sign-in)',
        'x-xo-permission': 'manage',
        description:
          'Body { provider: smtp | imap, capabilities, username, host, password, label? }. The password is sealed and never returned. Audited as credential.created.',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '201': { description: '{ credential }' }, '400': { description: 'Invalid field' } },
      },
    },
    '/workspaces/{workspaceId}/credentials/{credentialId}/rotate': {
      post: {
        summary: 'Replace the password of a basic credential (UW-9; manage role, recent sign-in)',
        'x-xo-permission': 'manage',
        description: 'Body { password }. The old password is deleted from disk once the new one is written. Audited as credential.rotated.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'credentialId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: '{ credential }' },
          '404': { description: 'Not a credential of this workspace' },
          '409': { description: 'Not active, or an OAuth credential (reconnect it instead)' },
        },
      },
    },
    '/workspaces/{workspaceId}/credentials/{credentialId}/revoke': {
      post: {
        summary: 'Revoke a connection: at the provider when it can be, and always here (UW-9; manage role, recent sign-in)',
        'x-xo-permission': 'manage',
        description:
          'Google grants are revoked at Google; Microsoft has no revocation endpoint for an app, so providerRevocation is not_available and consent must also be withdrawn in the account. Every stored version that held a secret is deleted either way, and nothing can use the credential again. Audited as credential.revoked.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'credentialId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: '{ credential, providerRevocation: performed | not_available | failed | not_applicable }' },
          '404': { description: 'Not a credential of this workspace' },
        },
      },
    },
    '/workspaces/{workspaceId}/knowledge/states/{stateId}/executable': {
      get: {
        summary: 'Which records of a knowledge state may feed execution, and why the others may not (UW-4a, UAC-12)',
        description:
          'The executable-use gate. A record may feed execution only when it is approved (active) in the state, interpreted by an installed pack, has authority (claims), is in no unresolved conflict and lost no resolved one, and every evidence entry resolves against the stored source: the source version still exists, its bytes re-hash to the cited digest, the cited pages, sheet and row are inside it, and a cited quote is found on the cited pages.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'stateId', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'records',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'Comma-separated record ids; every record of the state when absent',
          },
        ],
        responses: {
          '200': {
            description:
              '{ stateId, verdicts: { recordId, executable, reasons, lifecycle?, resolution? }[], executable: string[], refused }',
          },
          '404': { description: 'Unknown state' },
        },
      },
    },
    '/workspaces/{workspaceId}/sources/{sourceId}/knowledge-derivations': {
      post: {
        summary: "A model reads a stored source's text and proposes claims as a knowledge change set (UW-4c, K4)",
        description:
          "Uses the workspace's selected model through the residency guard. The page text reaches the model only as JSON data under a fixed system message (trust rule T2). Each claim must quote, verbatim, the page it names, and the quote must contain the claim's value; anything else is refused and reported by position and reason, never echoed. The surviving claims are proposed as a change set (origin model-derivation) for a reviewer: nothing is applied (T1). Needs the author role; audited as knowledge.change-set.proposed.",
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'sourceId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '201': { description: '{ changeSet, proposed, refused: { index, reason }[], model }' },
          '200': { description: '{ changeSet: null, proposed: 0, refused, model }: no claim survived' },
          '412': { description: 'No model is usable, the source has no text, its bytes changed, or the answer was refused as a whole' },
        },
      },
    },
    '/workspaces/{workspaceId}/email/recipient-rules': {
      get: {
        summary: 'The explicit email recipient rules (UW-10c)',
        description:
          '`{ revision, addresses, domains }`: who XO may email besides the people in confirmed contact lists. Default deny: empty allows nothing by itself.',
        'x-xo-permission': 'read',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'RecipientRules' },
          '401': { description: 'Not signed in' },
          '404': { description: 'Unknown workspace' },
        },
      },
      put: {
        summary: 'Replace the explicit email recipient rules (UW-10c)',
        description:
          'Body `{ addresses?, domains?, expectedRevision? }`. Manage role, recent sign-in, revision-guarded; audited as email.recipient-rules.updated with counts only.',
        'x-xo-permission': 'manage',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'RecipientRules' },
          '400': { description: 'Invalid rules' },
          '401': { description: 'Not signed in or needs a recent sign-in' },
          '403': { description: 'Needs the manage role' },
          '412': { description: 'The rules changed; reload' },
        },
      },
    },
    '/workspaces/{workspaceId}/email/provider-guess': {
      get: {
        summary: 'Which email tier an address would get, in plain words (UW-10c)',
        description:
          'Query `address`. Known-provider table, then MX lookup, else manual. `{ provider, tier: native_api|smtp_imap|send_only, how, explanation }`.',
        'x-xo-permission': 'read',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'address', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'ProviderGuess' },
          '400': { description: 'Not an email address' },
          '401': { description: 'Not signed in' },
        },
      },
    },
    '/workspaces/{workspaceId}/compilations/{compilationId}/intent-proposals': {
      post: {
        summary: 'Propose a workflow from free text, through a model when the instance has one (UW-6)',
        description:
          "Body `{ text }`. Refused (501) unless the instance configures a proposer; the default `strict_local` has none: give a structured goal to the generated-workflows route instead. The proposer returns the text of a structured proposal; it is untrusted, parsed strictly and composed like a person's goal (a need the catalogue does not have is a gap). The definition records the proposal-to-validation trace. Needs the author role; audited as intent.proposed with counts only.",
        'x-xo-permission': 'author',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'compilationId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'A gap or a clarification: no definition' },
          '201': { description: 'The generated definition, proposal and findings' },
          '422': { description: 'The model did not return a usable proposal' },
          '501': { description: 'No model is configured' },
        },
      },
    },
    '/workspaces/{workspaceId}/compilations/{compilationId}/data-drift': {
      get: {
        summary: 'Has the data this compilation read changed shape? (UW-15, UAC-34)',
        description:
          'Compares each table (.csv, .xlsx) the compilation was built from, as compiled, with the newest source of the same name: header names (trimmed, case-folded), the type of each column and the shape of its values. A renamed, removed or retyped column, or a changed format pattern, is blocking (a run start is refused 409 XO_DATA_SCHEMA_DRIFT before any effect, with this report in the error context); a new unused column is a warning. Reports headers and shapes, never cell values.',
        'x-xo-permission': 'read',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'compilationId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: '{ drift: { status: none|warning|blocking, sources, checkedSources } }' },
          '401': { description: 'Not signed in' },
          '404': { description: 'Unknown workspace or compilation' },
        },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/exceptions': {
      get: {
        summary: 'How often a workflow needed a person, and what is still waiting (UW-15, UAC-36)',
        description:
          'Over the last 30 days: runs, runs that asked for an approval or escalated, the share, and (for fan-out runs) items and the share that needed a person. `queue` lists only open items: approvals not yet decided and escalations, oldest first. Counts, ids and step names only.',
        'x-xo-permission': 'read',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: '{ stats, queue }' },
          '401': { description: 'Not signed in' },
          '404': { description: 'Unknown workspace or workflow' },
        },
      },
    },
    '/workspaces/{workspaceId}/entity-resolutions': {
      post: {
        summary: 'Resolve entities across two sources: resolved, ambiguous or unmatched, with evidence (UW-5)',
        description:
          'Body { schema: { relationship, cardinality: one_to_one|one_to_many|many_to_one, strongSchemes: { scheme: email|alnum|exact }, minNameWords? }, subjects: [{ ref, name?, identifiers? }], candidates: [...] }. Deterministic, no model. Resolved needs a strong identifier match or a unique full-name match of at least two words; similarity (initials, nicknames, spelling variants) is at most ambiguous; conflicting identifiers exclude a match. The report lists unmatched subjects and candidates and cardinality violations. Needs the author role; audited as resolution.computed with counts and hashes only.',
        'x-xo-permission': 'author',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: '{ report }' },
          '400': { description: 'Invalid body' },
          '401': { description: 'Unauthenticated' },
          '403': { description: 'Needs the author role' },
          '404': { description: 'Unknown workspace' },
        },
      },
    },
    '/workspaces/{workspaceId}/entity-resolutions/proposals': {
      post: {
        summary: 'Propose RESOLVED matches as claims in a knowledge change set (UW-5)',
        description:
          'Same body as entity-resolutions plus evidence: { <ref>: { sourceDigestSha256, sourceName, locator } }. Only resolved results with evidence on both sides become claims (status proposed); nothing is applied. A reviewer with a recent sign-in approves or rejects through the knowledge change-set routes. Needs the author role; audited as knowledge.change-set.proposed.',
        'x-xo-permission': 'author',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '201': { description: '{ changeSet, report, proposed }' },
          '200': { description: '{ changeSet: null }: nothing resolved' },
          '400': { description: 'Invalid body' },
          '401': { description: 'Unauthenticated' },
          '403': { description: 'Needs the author role' },
          '404': { description: 'Unknown workspace' },
        },
      },
    },
    '/workspaces/{workspaceId}/knowledge/records': {
      get: {
        summary: 'Records of a knowledge state with their entries (PX-4)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'state', in: 'query', required: false, schema: { type: 'string' }, description: 'Pinned state id; the head when absent' },
          { name: 'kind', in: 'query', required: false, schema: { type: 'string' }, description: 'entity | claim | relationship' },
          { name: 'type', in: 'query', required: false, schema: { type: 'string' }, description: 'Namespaced type or predicate' },
          {
            name: 'lifecycle',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'active (default) | superseded | retired | needs_review | any',
          },
        ],
        responses: { '200': { description: '{ stateId, records: { entry, record }[] }' } },
      },
    },
    '/workspaces/{workspaceId}/knowledge/search': {
      get: {
        summary: 'BM25 search over a pinned knowledge state, returning evidence and authority (PX-4)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'state', in: 'query', required: false, schema: { type: 'string' }, description: 'Pinned state id; the head when absent' },
          { name: 'limit', in: 'query', required: false, schema: { type: 'string' }, description: '1-100, default 10' },
          {
            name: 'lifecycle',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description:
              'Comma-separated lifecycles to search, or any. Default: approved (active) records only (UW-4c). Statistics are computed over the filtered records.',
          },
        ],
        responses: {
          '200': { description: '{ stateId, hits: SearchHit[] }, through the state-keyed persisted index (UW-4c)' },
          '400': { description: 'q missing or an unknown lifecycle' },
        },
      },
    },
    '/workspaces/{workspaceId}/knowledge/resolve-entity': {
      get: {
        summary: 'Resolve a name to an entity: linked on a strong identifier or one exact name; otherwise candidates for review (PX-4)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'name', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'type', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'state', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { '200': { description: '{ stateId, status: linked | unresolved, entityId?, method?, candidates }' } },
      },
    },
    '/workspaces/{workspaceId}/knowledge/conflicts': {
      get: {
        summary: 'Conflicts recorded in a knowledge state (PX-4)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'state', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { '200': { description: '{ stateId, conflicts: Conflict[] }' } },
      },
    },
    '/workspaces/{workspaceId}/knowledge/packs': {
      get: {
        summary: "The workspace's installed Domain Knowledge Packs (PX-4)",
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '{ packs: PackBinding[] }' } },
      },
      post: {
        summary: 'Install a Domain Knowledge Pack (PX-4)',
        description:
          'Body: a pack artifact `{ manifest, digest }` (schema xo.domain-pack.v1). The digest must match the manifest; one pack per namespace (a second is refused, never settled by install order). Needs the manage role and a recent sign-in. A pack adds semantics (types and their schemas), never authority.',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '201': { description: '{ packs }' },
          '400': { description: 'Invalid or tampered pack' },
          '409': { description: 'Namespace already defined by another pack' },
        },
      },
    },
    '/workspaces/{workspaceId}/waivers': {
      get: {
        summary: "List the workspace's source-quality waivers (PX-2)",
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '{ waivers: SourceWaiver[] }' } },
      },
    },
    '/workspaces/{workspaceId}/compilations/{compilationId}/capability-inventory': {
      get: {
        summary: 'Capability inventory of a compilation (PX-5)',
        description:
          'One report per discovered capability: status (explicit | inferred | accepted | rejected | duplicate | unresolved | unsupported), four independent readiness answers (eligible, bound, runtimeSupported, authorized — runnable only when all four are yes), the human task contract (one rule for procedure steps and prose actions), parameter derivation (structured | declared | inferred; inferred required inputs need review), duplicate groups (fully equivalent only) and gaps for each `need` query parameter. UW-7 (ADR 0033): each report also has `effect` ({ class: none | human | read | write | irreversible | unknown, derivation, reason }; from the workspace binding for an external capability, and `unknown` is treated as a write) and `outputSchema` (the typed outputs; `typed: false` names the untyped ones). Authorized is the approval verdict the execution boundary reaches; permission is rechecked at start.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'compilationId', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'need',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'A capability a goal needs (repeatable); unmet needs are reported as gaps',
          },
        ],
        responses: {
          '200': { description: '{ compilationId, inventory: CapabilityInventory }' },
          '404': { description: 'Unknown compilation or no compiled graph' },
        },
      },
    },
    '/workspaces/{workspaceId}/compilations/{compilationId}/generated-workflows': {
      post: {
        summary: 'Generate Workflow IR from a goal (PX-6)',
        description:
          'Body `{ goal: { text, needs?, section?, intake?: "structured"|"text", forEach? }, workflowId?, reads? }` (any other goal field is a 400). `reads` (UW-15, at most 20 `{ sourceId, recordSetId }`) names the tables the workflow reads besides its compilation\'s own sources; their schema is recorded on the definition and a renamed, removed, retyped or reformatted column there stops a start with 409 XO_DATA_SCHEMA_DRIFT. The goal selects the candidate workflow (scored on needed steps, section and words, with the reasons) unless `workflowId` names one; when two fit equally the response is `{ definition: null, selection: { status: "needs_clarification", question, options } }` and nothing is generated, and `no_match` likewise. The candidate is lowered by the one lowering function (ADR 0030: human-task steps → approve, with a timeout when the source states a deadline; rule-bound steps → decide with rules rendered from the stated conditions, plus a branch on its outcome when a later step names one; a stated delay → wait; a declared operation with a workspace connector binding → act with a server-derived idempotency key, and compensate when the binding names an undo; `intake: "text"` → a leading extract step; `forEach` → for_each over a bounded list input; anything without its evidence reported, never invented), validated with the package validator, and persisted with its digest. Distinct from the Studio\'s authored `workflow-definitions`.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'compilationId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '201': { description: '{ definition: GeneratedWorkflow, selection }' },
          '200': { description: '{ definition: null, selection }: the goal did not select one workflow' },
          '400': { description: 'Invalid goal' },
        },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows': {
      get: {
        summary: 'List generated workflows (PX-6)',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '{ definitions: GeneratedWorkflow[] }' } },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}': {
      get: {
        summary: 'One generated workflow: goal, selection, Workflow IR, rationale, issues, digest (PX-6)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'GeneratedWorkflow' }, '404': { description: 'Unknown id' } },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/readiness': {
      post: {
        summary: 'Issue a Workflow Readiness Certificate for a generated workflow (PX-7)',
        description:
          'Body `{ acceptUnstatedStepOrder? }`. The server recomputes source quality, completeness, the knowledge state, the capability inventory, the goal scope and the lowering, and issues READY | READY_WITH_CONDITIONS | NEEDS_REVIEW | BLOCKED with one gate per concern and the digest of every input it depends on. Mandatory gates never degrade to conditions; the declared conditions are exactly two (ADR 0030): an unstated step order the owner accepts (`acceptUnstatedStepOrder: true` needs the review role and a recent sign-in), and a source-quality finding a reviewer waived. The connector bindings the steps use are bound by digest. Audited as readiness.certificate.issued. 409 XO_READINESS_CERTIFICATE_REFUSED when the generated workflow no longer matches what its compilation lowers to.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '201': { description: 'WorkflowReadinessCertificate' }, '404': { description: 'Unknown generated workflow' } },
      },
    },
    '/workspaces/{workspaceId}/emergency-stops': {
      get: {
        summary: 'The emergency stops that apply to this workspace (RX-1a)',
        description:
          'Read role. `{ instance, workspacePaused, stops }`: the instance-wide stop (set by an operator with `xo instance emergency-stop`; `null` when not engaged), the workspace pause, and the scoped stops `{ scope, target, by, at, reason?, definitionIds? }`.',
        'x-xo-permission': 'read',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'EmergencyStops' }, '403': { description: 'Not a member' } },
      },
      post: {
        summary: 'Engage a scoped emergency stop (RX-1a, ADR 0048)',
        description:
          'Manage role and a recent sign-in. Body `{ scope, target, reason? }` with scope `workflow` (a `wfl_` workflow, every version, or a `gwf_` generated workflow), `connector` (a connector bound in the workspace) or `capability` (`<connector>.<operation>`, bound). While engaged: a start or preview it covers is refused (412, reason `emergency_stop`, audited as emergency-stop.refused); a run in progress is held before its next step, a batch before its next item, and a covered call is not started (the effect gate refuses any that race it); a call already in flight finishes. The run view shows `held`. Released, held runs carry on at the next tick or read. An unknown target is 404. Audited as emergency-stop.engaged.',
        'x-xo-permission': 'manage',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '201': { description: '{ stop, stops }' },
          '400': { description: 'Invalid scope or target' },
          '403': { description: 'Not a manager, or no recent sign-in' },
          '404': { description: 'The target does not exist in this workspace' },
          '412': { description: 'The stop record cannot be read; everything stays stopped until it is repaired' },
        },
      },
    },
    '/workspaces/{workspaceId}/emergency-stops/release': {
      post: {
        summary: 'Release a scoped emergency stop (RX-1a)',
        description:
          'Manage role and a recent sign-in. Body `{ scope, target }`. `{ released, stops }`; releasing restarts nothing by itself. Audited as emergency-stop.released.',
        'x-xo-permission': 'manage',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '{ released, stops }' }, '403': { description: 'Not a manager, or no recent sign-in' } },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/runs/{runId}/manifest': {
      get: {
        summary: 'What a run was bound to at admission (RX-1b)',
        description:
          'Read role. `{ manifest, digest, digestOk }`: definition and component digest, workflow and version, certificate and its digest, binding and sending-account digests per connector, input digest, batch approval, pinned packs, initiator and admission time. Digests and ids only, never the input. 404 for a run admitted before manifests existed, or an item of a batch (see its batch).',
        'x-xo-permission': 'read',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'StoredManifest' }, '404': { description: 'No manifest' } },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/runs/{runId}/audit-bundle': {
      get: {
        summary: 'The signed audit bundle of a run (RX-1b)',
        description:
          "Audit role. The engine's AuditBundle (format 1) of the run and, for a batch, every item: each journal with its hash chain, a Merkle root over the heads, the component digest, the connector grants and the run manifest, signed (Ed25519) with the instance's approval key (`signer` is its key id). It holds the journals in full, arguments included. Audited as generated-workflow.audit-bundle.exported.",
        'x-xo-permission': 'audit',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'AuditBundle' },
          '403': { description: 'No audit role' },
          '404': { description: 'Unknown run' },
        },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/runs/{runId}/replay': {
      get: {
        summary: 'Replay a run from its journal under what it was pinned to (RX-1e)',
        description:
          'Read role. Rebuilds the run (or an item of a batch) from its verified journal under the stored definition; nothing is executed or sent. `{ runId, reproducible, reasons, journalEntries, manifestDigest?, replayed: { state, steps, escalation? } }`. Not reproducible, with the reasons, when: the run has no manifest; the manifest does not match its digest; the stored definition is not the one admitted; the journal names another workflow version; or a Domain Knowledge Pack the run pinned was removed or changed.',
        'x-xo-permission': 'read',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'RunReplay' }, '404': { description: 'Unknown run' } },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/runs/{runId}/explain': {
      get: {
        summary: 'Why a run did what it did (RX-1e)',
        description:
          "Read role. The engine's explanation, from the verified journal and the definition: each step in the order it started with its state, attempts, outputs, rules fired, provenance and call digests; approvals; model calls; escalation and result; plus `text`, the same in plain lines.",
        'x-xo-permission': 'read',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'RunExplanation' }, '404': { description: 'Unknown run' } },
      },
    },
    '/workspaces/{workspaceId}/audit-bundles/verify': {
      post: {
        summary: 'Verify an audit bundle against this instance (RX-1b)',
        description:
          "Read role. Body: the bundle. `{ ok, problems, signer, signerKnown, runs, manifest? }`: the signature under the instance's keyring (every key ever active here), the Merkle root, every run's hash chain, and the manifest's digest.",
        'x-xo-permission': 'read',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Verification' } },
      },
    },
    '/workspaces/{workspaceId}/control/inbox': {
      get: {
        summary: 'Everything on the workflow runtime that waits for a person (UW-12b)',
        description:
          'Read role. `{ batches, steps, attention, truncated }`: `batches` are batch previews waiting for an approval (unexpired, every item shown exactly, not yet approved; `state` `awaiting_approval`) and approved batches not yet used (`ready_to_start`, with `approval`); `steps` are approval steps of runs waiting for a reviewer (an item of a batch carries `parentRunId` and `item`); `attention` lists external calls whose outcome is unknown, for a person to reconcile. Each list is newest first and holds at most 200 entries (`truncated` when there were more). `preparedByYou` marks a preview the caller prepared. Nothing here decides: the routes that act check role, recent sign-in and separation again.',
        'x-xo-permission': 'read',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'ControlInbox { batches, steps, attention, truncated }' },
          '403': { description: 'Not a member' },
          '404': { description: 'Unknown workspace' },
        },
      },
    },
    '/workspaces/{workspaceId}/connector-bindings': {
      get: {
        summary: 'The workspace connector bindings (ADR 0030)',
        description:
          'How each declared operation is carried out: `{ revision, bindings: [{ capability, connector, kind, operation, sideEffect, compensation?, adapter, adapterInstalled }] }`, where `adapterInstalled` says whether this server has the host adapter the binding names. An `email` binding with a connection also has `emailTier: { tier: native_api|smtp_imap|send_only, lookup, explanation }` (UW-10): the tier it sends in, whether it can look up a sent message, and what that means in plain words. Act and compensate steps are generated only from these.',
        'x-xo-permission': 'read',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'ConnectorBindings' },
          '401': { description: 'Not signed in' },
          '404': { description: 'Unknown workspace' },
        },
      },
      put: {
        summary: 'Replace the workspace connector bindings (ADR 0030)',
        description:
          'Body `{ bindings, expectedRevision? }`. Needs the manage role and a recent sign-in. V1-1 (ADR 0049): a binding may carry `arguments` (`{ <name>: { field: <lower_snake_case> } | { const: <text, number or boolean> } }`, at most 32): the call’s arguments, each from a field of the item (or input) or a constant. A binding with arguments makes the step it names an act step whatever the source says, a person’s task included; which steps XO carries out is the operator’s decision. UW-9: a binding may name `credentialId`, an active connection credential of this workspace; the adapter is lent it per call through the credential broker (never the secret itself). Every entry is validated field by field (at most 500; connector id `^[a-z][a-z0-9_]{0,63}$`; kind http | webhook_out | file | smtp | slack_webhook | database | mcp; sideEffect read | write | irreversible; database connectors read-only; a read has no compensation); unknown fields are a 400. A stale `expectedRevision` is a 412 XO_PRECONDITION_FAILED. Audited as connector-bindings.updated. Changing a binding makes every certificate that bound it stale.',
        'x-xo-permission': 'manage',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'ConnectorBindings' },
          '400': { description: 'Invalid binding' },
          '401': { description: 'Not signed in' },
          '403': { description: 'Not a manager, or no recent sign-in' },
          '404': { description: 'Unknown workspace' },
          '412': { description: 'Stale expectedRevision' },
        },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/previews': {
      post: {
        summary: 'Prepare a batch preview: exactly what a run over this input would do, sending nothing (UW-8, ADR 0046)',
        description:
          'Body `{ input?, items?, certificateId }`. `items` `{ connectionId, proposalId }` (V1-1, ADR 0049) builds the items of a once-per-item workflow from a confirmed list or "each person’s document" pairing of a source connection: one item per row, its columns as fields (lower snake case), and for a pairing the row’s one document (`document_sha256`, `document_name`, `document_type`); rows without exactly one document are left out and listed in `itemsSource` with why (412 when the source is not confirmed or lacks a field the workflow reads; 400 with both `items` and that input). A start with the approval builds them again from the files and is refused (`source_changed`) if they differ. The same gates as a start (certificate, pause, drift). The definition runs in the engine\'s preview mode over the exact input: approval steps count as approved, timers as elapsed, and every would-be call is recorded with its exact arguments; nothing is sent. `senders` names who would send (connector, provider, the account its owner recognises) and, for email, the tier it sends in with its plain-words explanation (UAC-32). Each item (or the run, as a batch of one) gets a state (`sends`, `no_effect`, `stops` for a person, `not_exact` when what it sends depends on a model, an outside event or another call\'s result) and a leaf digest; one `root` covers them with the definition, certificate and input. Returns the first page, exceptions first. Kept 24 hours. Audited with ids and counts only.',
        'x-xo-permission': 'author',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '201': {
            description: 'BatchPreview { previewId, root, counts, senders, itemsSource?, approvable, items[page], page, pages, total }',
          },
          '400': { description: 'Invalid input' },
          '403': { description: 'Not an author' },
          '404': { description: 'Unknown generated workflow' },
          '409': { description: 'No certificate, the certificate does not allow it, or the data changed shape' },
          '412': { description: 'The workspace is paused' },
        },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/item-sources': {
      get: {
        summary: 'Where the items of a once-per-item workflow can come from (V1-1, ADR 0049)',
        description:
          'The confirmed lists and pairings of the workspace’s active source connections, each with the fields its items would have, how many items it gives now and how many rows it leaves out, the fields this workflow reads for an item that it lacks (`missingFields`), and whether it can be used (`usable`). `{ forEach: false }` for a workflow that does not run once per item.',
        'x-xo-permission': 'read',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: '{ forEach, over?, fieldsUsed?, sources[] }' },
          '404': { description: 'Unknown generated workflow' },
        },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/previews/{previewId}': {
      get: {
        summary: 'Read a batch preview page by page, exceptions first (UW-8)',
        description:
          'Query `page`, `size` (1–200, default 50), `show=exceptions` (only items that stop or cannot be shown exactly). Includes the approval and the run that used it, if any.',
        'x-xo-permission': 'read',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'previewId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'BatchPreview' }, '404': { description: 'Unknown preview' } },
      },
    },
    '/workspaces/{workspaceId}/standing-approvals': {
      post: {
        summary: 'Propose a standing approval (UW-16)',
        description:
          "Body `{ definitionId, certificateId, items? | input?, limits: { maxItemsPerRun, maxItemsPerPeriod, maxRunsPerPeriod, period: day|week|month, maxExcludedRows? }, mayVary?: [{ step, argument }], presignSteps?, triggers: [manual|schedule], expiresInDays? (1 to 90, default 30), startsAs?, note? }`. A person (not a key or a service) with the author role. Prepares a sample preview of today's items; every argument a write or irreversible step takes from an item is pinned to the values in it unless named in `mayVary` (an irreversible step keeps at least one pinned). Answers the policy with counts of pinned values, never the values, and its `policyDigest`. Someone else approves it.",
        'x-xo-permission': 'author',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '201': { description: 'StandingView' },
          '401': { description: 'Not signed in, or a recent sign-in is needed' },
          '403': { description: 'Your role does not allow this' },
          '404': { description: 'Unknown workspace or standing approval' },
          '409': { description: 'XO_STANDING_APPROVAL_REFUSED (context.reason says why)' },
        },
      },
      get: {
        summary: 'List standing approvals (UW-16)',
        description: 'Each with its status, bounds, expiry, who approved it (and `selfApproved`) and use in the current period.',
        'x-xo-permission': 'read',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: '{ standingApprovals }' },
          '401': { description: 'Not signed in, or a recent sign-in is needed' },
          '403': { description: 'Your role does not allow this' },
          '404': { description: 'Unknown workspace or standing approval' },
          '409': { description: 'XO_STANDING_APPROVAL_REFUSED (context.reason says why)' },
        },
      },
    },
    '/workspaces/{workspaceId}/standing-approvals/{id}': {
      get: {
        summary: 'A standing approval, its uses and fall-backs (UW-16)',
        description: 'Never carries pinned values or argument values. Up to 50 uses and 50 fall-backs.',
        'x-xo-permission': 'read',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'StandingView with uses and fallbacks' },
          '401': { description: 'Not signed in, or a recent sign-in is needed' },
          '403': { description: 'Your role does not allow this' },
          '404': { description: 'Unknown workspace or standing approval' },
          '409': { description: 'XO_STANDING_APPROVAL_REFUSED (context.reason says why)' },
        },
      },
    },
    '/workspaces/{workspaceId}/standing-approvals/{id}/approve': {
      post: {
        summary: 'Approve a standing approval by the policy digest you were shown (UW-16)',
        description:
          'Body `{ policyDigest }`. Review role, a recent interactive sign-in, and a person: an API key or service principal is refused (`standing_requires_person`). Not the proposer and not the person runs start as (`separation_of_duties`), unless separation is off and nobody else may review; then `selfApproved` is true everywhere it is shown. Refused when the digest differs (`policy_mismatch`) or the sample expired (`sample_expired`). Signed with the platform approval key.',
        'x-xo-permission': 'review',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'StandingView' },
          '401': { description: 'Not signed in, or a recent sign-in is needed' },
          '403': { description: 'Your role does not allow this' },
          '404': { description: 'Unknown workspace or standing approval' },
          '409': { description: 'XO_STANDING_APPROVAL_REFUSED (context.reason says why)' },
        },
      },
    },
    '/workspaces/{workspaceId}/standing-approvals/{id}/request-changes': {
      post: {
        summary: 'Return a standing approval for changes (UW-16)',
        description:
          'Body `{ comment }` (1 to 1000 characters). Review role. The proposal can no longer be approved; the proposer proposes again.',
        'x-xo-permission': 'review',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'StandingView' },
          '401': { description: 'Not signed in, or a recent sign-in is needed' },
          '403': { description: 'Your role does not allow this' },
          '404': { description: 'Unknown workspace or standing approval' },
          '409': { description: 'XO_STANDING_APPROVAL_REFUSED (context.reason says why)' },
        },
      },
    },
    '/workspaces/{workspaceId}/standing-approvals/{id}/revoke': {
      post: {
        summary: 'Revoke a standing approval (UW-16)',
        description:
          'Body `{ reason }` (1 to 500 characters). A reviewer, the proposer or the approver; no recent sign-in is needed, because revoking only removes authority. From then no run starts under it and every further call of a run started under it is refused before it is sent. A second revoke returns the first.',
        'x-xo-permission': 'author',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'StandingView' },
          '401': { description: 'Not signed in, or a recent sign-in is needed' },
          '403': { description: 'Your role does not allow this' },
          '404': { description: 'Unknown workspace or standing approval' },
          '409': { description: 'XO_STANDING_APPROVAL_REFUSED (context.reason says why)' },
        },
      },
    },
    '/workspaces/{workspaceId}/standing-approvals/{id}/runs': {
      post: {
        summary: 'Start a run under a standing approval (UW-16)',
        description:
          'Body `{ input? }`; an `Idempotency-Key` header makes a retry the same run. Author role, and the caller must be the person it names to start. Inside the bounds: 201/200 with the run (a batch approval is minted for its own preview and every UW-8 check applies). Outside them: 202 `{ fallback: true, reasons, previewId? }` and an ordinary batch preview waits in the Inbox; nothing is sent. Refusals that prepare nothing: `signature`, `starter_mismatch`, `trigger_not_allowed`, `starter_not_author`, `definition_changed`, `certificate_changed`, `source_unavailable`.',
        'x-xo-permission': 'author',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '201': { description: 'The run (200 for a repeat), or 202 for a fall-back' },
          '401': { description: 'Not signed in, or a recent sign-in is needed' },
          '403': { description: 'Your role does not allow this' },
          '404': { description: 'Unknown workspace or standing approval' },
          '409': { description: 'XO_STANDING_APPROVAL_REFUSED (context.reason says why)' },
        },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/previews/{previewId}/approval/revoke': {
      post: {
        summary: 'Revoke a batch approval that has not been used (UW-16)',
        description:
          'Body `{ reason }`. Review role. A used approval cannot be revoked (cancel its run instead). The start with it is then refused (`revoked`).',
        'x-xo-permission': 'review',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'previewId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: '{ previewId, approvalId, revokedAt }' },
          '401': { description: 'Not signed in, or a recent sign-in is needed' },
          '403': { description: 'Your role does not allow this' },
          '404': { description: 'Unknown workspace or standing approval' },
          '409': { description: 'XO_STANDING_APPROVAL_REFUSED (context.reason says why)' },
        },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/previews/{previewId}/approve': {
      post: {
        summary: 'Approve a batch preview by the root you were shown (UW-8)',
        description:
          "Body `{ root, presignSteps? }`. `presignSteps` (UW-16a, ADR 0051; default none) names the approval steps a person does that this approval also decides for every item; each must be a step some item reaches (listed as `stepsToApprove` on the preview), else 409 XO_BATCH_APPROVAL_REFUSED `presign_unknown_step`. Every other such step waits for a person in each item. Review role and a recent sign-in. Signed with the platform approval key as the reviewer's decision (the named steps are inside the signature); one approval per preview, used once. Refused (409 XO_BATCH_APPROVAL_REFUSED) when the root differs, the preview expired, any item cannot be shown exactly, or, with `XO_APPROVAL_SEPARATION` `required` (production default), the approver prepared the preview.",
        'x-xo-permission': 'review',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'previewId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '201': { description: 'BatchPreview with its approval { approvalId, reviewerId, approvedAt, expiresAt }' },
          '403': { description: 'Not a reviewer, or no recent sign-in' },
          '404': { description: 'Unknown preview' },
          '409': { description: 'Refused (see description)' },
        },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/runs': {
      post: {
        summary: 'Run a generated workflow through the Workflow IR runtime (ADR 0030)',
        description:
          "Body `{ input?, certificateId, batchApprovalId? }`. UW-8 (ADR 0046): with `batchApprovalId` the run starts from a person's batch approval: it must verify under the approval keyring, be for this definition and certificate, be unexpired and unused, the input must be the approved one (omit it to use it), and the preview computed now must give the approved root (409 XO_BATCH_APPROVAL_REFUSED otherwise, with the changed items). The run id follows from the approval, so a repeat is the same run; each approval step the approver named (`presignSteps`; every step the preview showed for an approval signed before UW-16a) is decided by it as the approver, and each call must equal what was approved. When `XO_RUN_APPROVAL` is `required` (production default), a run that can write or do something irreversible without one is refused 409 XO_BATCH_APPROVAL_REQUIRED. The certificate is always required on this path and verified against the current state (409 XO_READINESS_CERTIFICATE_REQUIRED / XO_READINESS_CERTIFICATE_REFUSED otherwise). The stored Workflow IR runs in @xo/workflow-runtime: act and compensate steps go through the host adapter the binding names, approvals wait for a reviewer, waits and timeouts are advanced by the server. An `Idempotency-Key` header returns the original run for a retry. ADR 0031: a paused workspace refuses the start (412); every connector call is authorized again immediately before it is made (the person who started the run still holds `author`, the workspace is not paused, the binding is unchanged, the capability is still approved; an undo is checked for the binding only), and a refusal sends nothing and is audited as generated-workflow.effect.denied; a call whose outcome is unknown escalates to a person, never retried or compensated blindly; every write to a run holds its lease, so several API instances never drive one run. The run view carries `decisions` (each re-verified against the approval keyring: `signatureVerified`, `keyId`) and `startedBy`. Audited as generated-workflow.run.started.",
        'x-xo-permission': 'author',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '201': { description: 'GeneratedWorkflowRun { runId, state, outputs?, pendingApprovals, certificateId }' },
          '400': { description: 'Invalid input' },
          '401': { description: 'Not signed in' },
          '403': { description: 'Not an author' },
          '404': { description: 'Unknown generated workflow' },
          '409': { description: 'No certificate, or the certificate does not allow this start' },
          '412': { description: 'The workspace is paused' },
        },
      },
      get: {
        summary: 'List the runs of a generated workflow (ADR 0030)',
        'x-xo-permission': 'read',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: '{ runs: GeneratedWorkflowRun[] }' },
          '401': { description: 'Not signed in' },
          '404': { description: 'Unknown generated workflow' },
        },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/runs/{runId}': {
      get: {
        summary: 'One run of a generated workflow (ADR 0030)',
        description:
          'UW-7 (ADR 0033, UAC-9): `effects` lists every external call of the run in one vocabulary (intent_recorded, dispatch_attempted, confirmed_success, confirmed_failure_no_effect, outcome_unknown, reconciliation_required; docs/EFFECTS.md), one row per step with its key and detail. `cancellation` is present once a cancel was requested (`applied` when the run has acted on it). An item of a batch (`fe_…`, listed in the batch result) is read here too.',
        'x-xo-permission': 'read',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'GeneratedWorkflowRun' },
          '401': { description: 'Not signed in' },
          '404': { description: 'Unknown run' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-entities': {
      post: {
        summary: 'Create a Workflow (UW-2, ADR 0032)',
        description:
          "Body `{ compilationId, goal?, workflowId?, name?, note?, conversationId?, messageId? }` or `{ definitionId, name?, note?, conversationId?, messageId? }`. Creates one durable Workflow entity (`wfl_…`), version 1, from the Workflow IR generated for the goal by the same function as POST …/compilations/{compilationId}/generated-workflows (or from an existing generated definition). `conversationId` links it to the caller's own `cnv_` conversation (ADR 0013; a `cht_` thread is a 400) and `messageId` to the message it was asked in; without `goal`, that message is the goal. A goal that fits no workflow or two equally is `200 { workflow: null, selection }` and creates nothing. Nothing is installed: the XO environment is unchanged. Unknown fields are a 400. Audited as workflow-entity.created.",
        'x-xo-permission': 'author',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '401': { description: 'Not signed in' },
          '404': { description: 'Unknown workspace or workflow (an outsider sees the same)' },
          '201': { description: '{ workflow: WorkflowDetail }' },
          '200': { description: '{ workflow: null, selection }: the goal asks a question instead' },
          '400': { description: 'Invalid body' },
          '403': { description: 'Not an author' },
        },
      },
      get: {
        summary: 'List Workflows: compact summaries, newest first, paginated (UW-2)',
        description:
          "Query `limit` (1-200, default 50), `cursor` (the `nextCursor` of the previous page), `lifecycle` (draft | ready | awaiting_approval | running | paused | needs_attention | completed | partially_completed | failed | cancelled | archived), `archived=true` (archived workflows are hidden otherwise), `conversationId` (the caller's own conversation only; 404 otherwise). Each summary: `{ workflowId, name, lifecycle, revision, currentVersion, pendingApprovals, latestRun?, conversationId? (only to the conversation's owner), paused, archived, updatedAt }`. `changesCursor` is where to start following GET …/workflow-entities/changes.",
        'x-xo-permission': 'read',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '401': { description: 'Not signed in' },
          '404': { description: 'Unknown workspace or workflow (an outsider sees the same)' },
          '200': { description: '{ workflows: WorkflowSummary[], nextCursor?, changesCursor }' },
          '400': { description: 'Invalid query' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-entities/changes': {
      get: {
        summary: "Follow changes to the workspace's Workflows (UW-2)",
        description:
          'Query `cursor` (from a list or an earlier page; absent = now) and `wait` (0-25 seconds: return as soon as something changes). `{ changes: [{ at, workflowId, kind: "entity" | "run", revision?, event?, runId?, state? }], cursor }`, in order, across restarts and API instances. A change is a hint to re-read the workflow; it carries no content.',
        'x-xo-permission': 'read',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '401': { description: 'Not signed in' },
          '404': { description: 'Unknown workspace or workflow (an outsider sees the same)' },
          '200': { description: '{ changes, cursor }' },
          '400': { description: 'Invalid cursor or wait' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-entities/{workflowId}': {
      get: {
        summary: 'One Workflow: lifecycle, versions, runs, pending approvals and history (UW-2)',
        description:
          'The lifecycle is derived, never stored twice: an archived workflow is archived; a run in progress (of any version) makes it awaiting_approval or running; then paused (the workflow or the workspace); then the latest run of the current version (completed, failed, needs_attention for an escalation, cancelled); otherwise ready when the current version has a READY or READY_WITH_CONDITIONS certificate, else draft. `origin.conversation` names the conversation and message only to the conversation\'s owner (with `available: false` once it is deleted); others see `{ store: "cnv", linked: true }`. Runs are read from the engine\'s journal (most recent 50; `runsTotal`); `history` is every revision.',
        'x-xo-permission': 'read',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string', pattern: '^wfl_[0-9a-f]{32}$' } },
        ],
        responses: {
          '401': { description: 'Not signed in' },
          '404': { description: 'Unknown workspace or workflow (an outsider sees the same)' },
          '200': { description: 'WorkflowDetail' },
        },
      },
      patch: {
        summary: 'Rename a Workflow (UW-2)',
        description:
          'Body `{ name, expectedRevision? }`. A stale `expectedRevision` is a 412 (stale_revision). Audited as workflow-entity.updated.',
        'x-xo-permission': 'author',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string', pattern: '^wfl_[0-9a-f]{32}$' } },
        ],
        responses: {
          '401': { description: 'Not signed in' },
          '404': { description: 'Unknown workspace or workflow (an outsider sees the same)' },
          '200': { description: '{ workflow: WorkflowDetail }' },
          '400': { description: 'Invalid name' },
          '403': { description: 'Not an author' },
          '412': { description: 'Stale expectedRevision' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-entities/{workflowId}/versions': {
      post: {
        summary: 'Add a version to a Workflow (UW-2)',
        description:
          'Body `{ compilationId?, goal?, workflowId?, note?, expectedRevision? }` or `{ definitionId, note?, expectedRevision? }`. Unstated parts carry over from the current version (the same compilation and the same goal), so a version differs only in what is asked; one identical to the current version is a 412. Earlier versions and their runs are kept. Audited as workflow-entity.version.added.',
        'x-xo-permission': 'author',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string', pattern: '^wfl_[0-9a-f]{32}$' } },
        ],
        responses: {
          '401': { description: 'Not signed in' },
          '404': { description: 'Unknown workspace or workflow (an outsider sees the same)' },
          '201': { description: '{ workflow: WorkflowDetail }' },
          '200': { description: '{ workflow: null, selection }' },
          '400': { description: 'Invalid body' },
          '403': { description: 'Not an author' },
          '412': { description: 'Nothing changed, archived, too many versions, or a stale expectedRevision' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-entities/{workflowId}/pause': {
      post: {
        summary: 'Pause a Workflow: new starts are refused (412 workflow_paused); runs already started continue (UW-2)',
        description: 'Body `{ expectedRevision? }`. Already in that state is a 412. Audited as workflow-entity.updated.',
        'x-xo-permission': 'author',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string', pattern: '^wfl_[0-9a-f]{32}$' } },
        ],
        responses: {
          '401': { description: 'Not signed in' },
          '404': { description: 'Unknown workspace or workflow (an outsider sees the same)' },
          '200': { description: '{ workflow: WorkflowDetail }' },
          '403': { description: 'Not an author' },
          '412': { description: 'Already so, or a stale expectedRevision' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-entities/{workflowId}/resume': {
      post: {
        summary: 'Resume a paused Workflow (UW-2)',
        description: 'Body `{ expectedRevision? }`. Already in that state is a 412. Audited as workflow-entity.updated.',
        'x-xo-permission': 'author',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string', pattern: '^wfl_[0-9a-f]{32}$' } },
        ],
        responses: {
          '401': { description: 'Not signed in' },
          '404': { description: 'Unknown workspace or workflow (an outsider sees the same)' },
          '200': { description: '{ workflow: WorkflowDetail }' },
          '403': { description: 'Not an author' },
          '412': { description: 'Already so, or a stale expectedRevision' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-entities/{workflowId}/archive': {
      post: {
        summary: 'Archive a Workflow: hidden from lists, cannot start; history and runs are kept (UW-2)',
        description: 'Body `{ expectedRevision? }`. Already in that state is a 412. Audited as workflow-entity.updated.',
        'x-xo-permission': 'author',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string', pattern: '^wfl_[0-9a-f]{32}$' } },
        ],
        responses: {
          '401': { description: 'Not signed in' },
          '404': { description: 'Unknown workspace or workflow (an outsider sees the same)' },
          '200': { description: '{ workflow: WorkflowDetail }' },
          '403': { description: 'Not an author' },
          '412': { description: 'Already so, or a stale expectedRevision' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-entities/{workflowId}/restore': {
      post: {
        summary: 'Restore an archived Workflow (UW-2)',
        description: 'Body `{ expectedRevision? }`. Already in that state is a 412. Audited as workflow-entity.updated.',
        'x-xo-permission': 'author',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string', pattern: '^wfl_[0-9a-f]{32}$' } },
        ],
        responses: {
          '401': { description: 'Not signed in' },
          '404': { description: 'Unknown workspace or workflow (an outsider sees the same)' },
          '200': { description: '{ workflow: WorkflowDetail }' },
          '403': { description: 'Not an author' },
          '412': { description: 'Already so, or a stale expectedRevision' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-entities/{workflowId}/readiness': {
      post: {
        summary: 'Issue a readiness certificate for the current version (UW-2)',
        description:
          "Body `{ acceptUnstatedStepOrder? }`. Exactly POST …/generated-workflows/{definitionId}/readiness for the current version's definition (accepting an unstated step order needs the review role and a recent sign-in). Audited as readiness.certificate.issued.",
        'x-xo-permission': 'author',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string', pattern: '^wfl_[0-9a-f]{32}$' } },
        ],
        responses: {
          '401': { description: 'Not signed in' },
          '404': { description: 'Unknown workspace or workflow (an outsider sees the same)' },
          '201': { description: '{ certificate, version }' },
          '400': { description: 'Invalid body' },
          '403': { description: 'Not an author (or not a reviewer when accepting)' },
          '409': { description: 'The definition no longer matches its compilation' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-entities/{workflowId}/runs': {
      post: {
        summary: 'Start the current version (UW-2)',
        description:
          'Body `{ input?, certificateId? }`; an `Idempotency-Key` header returns the original run for a retry. Without `certificateId`, the latest certificate issued for the current version is presented. Then exactly the start of POST …/generated-workflows/{definitionId}/runs (ADR 0030, ADR 0031): the certificate is verified from scratch, a paused workspace refuses, every connector call is authorized again when it is made. A paused or archived workflow is a 412. The run records, before its first journal entry, which workflow and version it belongs to. Audited as generated-workflow.run.started with workflowEntityId.',
        'x-xo-permission': 'author',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string', pattern: '^wfl_[0-9a-f]{32}$' } },
          { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '401': { description: 'Not signed in' },
          '404': { description: 'Unknown workspace or workflow (an outsider sees the same)' },
          '201': { description: 'GeneratedWorkflowRun & { workflowId, version }' },
          '400': { description: 'Invalid input' },
          '403': { description: 'Not an author' },
          '409': { description: 'No certificate, or it does not allow this start' },
          '412': { description: 'Paused or archived (workflow or workspace)' },
        },
      },
      get: {
        summary: 'The runs of a Workflow, all versions, newest first (UW-2)',
        description:
          'Each run: `{ runId, version, definitionId, state, pendingApprovals, approvals, startedAt, startedBy, certificateId, outputs?, escalation? }`.',
        'x-xo-permission': 'read',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string', pattern: '^wfl_[0-9a-f]{32}$' } },
        ],
        responses: {
          '401': { description: 'Not signed in' },
          '404': { description: 'Unknown workspace or workflow (an outsider sees the same)' },
          '200': { description: '{ runs }' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-entities/{workflowId}/runs/{runId}': {
      get: {
        summary: 'One run of a Workflow, with its verified decisions (UW-2)',
        description:
          'The generated-workflow run view (`decisions` re-verified against the approval keyring) plus `definitionId` and `version`. 404 for a run of another workflow.',
        'x-xo-permission': 'read',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string', pattern: '^wfl_[0-9a-f]{32}$' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '401': { description: 'Not signed in' },
          '404': { description: 'Unknown workspace or workflow (an outsider sees the same)' },
          '200': { description: 'GeneratedWorkflowRun' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-entities/{workflowId}/runs/{runId}/cancel': {
      post: {
        summary: 'Cancel a run of a Workflow (UW-7)',
        description:
          "Exactly POST …/generated-workflows/{definitionId}/runs/{runId}/cancel, for a run (or an item of a batch) of this workflow only (404 otherwise). The workflow's lifecycle becomes cancelled, or needs_attention when a call was in flight.",
        'x-xo-permission': 'author',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string', pattern: '^wfl_[0-9a-f]{32}$' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'GeneratedWorkflowRun & { cancelRecorded, workflowId }' },
          '400': { description: 'Invalid body' },
          '401': { description: 'Not signed in' },
          '403': { description: 'Not an author' },
          '404': { description: 'Unknown workflow, or not its run' },
        },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/runs/{runId}/observations': {
      get: {
        summary: 'What a run taught (UW-11b)',
        description:
          'Observations derived from the run record: reconciled calls, rejected steps, tasks not done, escalations, rows left out or matched loosely, and corrections. Plain words, no values.',
        'x-xo-permission': 'read',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: '{ runId, observations }' },
          '400': { description: 'Invalid body' },
          '401': { description: 'Not signed in' },
          '403': { description: 'Not allowed for this role' },
          '404': { description: 'Unknown run' },
          '412': { description: 'Already proposed, or the run has no readable manifest' },
        },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/runs/{runId}/corrections': {
      post: {
        summary: 'Record a correction to a run (UW-11b)',
        description:
          'Body `{ item?, field, value, reason }`. The field must be a field of the item (or run) input. Stored with the run; audited by ids only (run-learning.correction-recorded).',
        'x-xo-permission': 'author',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '201': { description: '{ observation }' },
          '400': { description: 'Invalid body' },
          '401': { description: 'Not signed in' },
          '403': { description: 'Not allowed for this role' },
          '404': { description: 'Unknown run' },
          '412': { description: 'Already proposed, or the run has no readable manifest' },
        },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/runs/{runId}/learning-proposals': {
      post: {
        summary: 'Propose observations as knowledge for review (UW-11b)',
        description:
          'Body `{ observationIds, note? }`. Proposes `xo-run` claims as a change set of origin run-outcome; the knowledge head moves only when a reviewer other than the proposer approves it.',
        'x-xo-permission': 'author',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '201': { description: '{ changeSet, proposed }' },
          '400': { description: 'Invalid body' },
          '401': { description: 'Not signed in' },
          '403': { description: 'Not allowed for this role' },
          '404': { description: 'Unknown run' },
          '412': { description: 'Already proposed, or the run has no readable manifest' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-entities/{workflowId}/runs/{runId}/observations': {
      get: {
        summary: 'What a run taught (UW-11b)',
        description:
          'Observations derived from the run record: reconciled calls, rejected steps, tasks not done, escalations, rows left out or matched loosely, and corrections. Plain words, no values. Exactly the same, for a run of this workflow only.',
        'x-xo-permission': 'read',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string', pattern: '^wfl_[0-9a-f]{32}$' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: '{ runId, observations }' },
          '400': { description: 'Invalid body' },
          '401': { description: 'Not signed in' },
          '403': { description: 'Not allowed for this role' },
          '404': { description: 'Unknown run' },
          '412': { description: 'Already proposed, or the run has no readable manifest' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-entities/{workflowId}/runs/{runId}/corrections': {
      post: {
        summary: 'Record a correction to a run (UW-11b)',
        description:
          'Body `{ item?, field, value, reason }`. The field must be a field of the item (or run) input. Stored with the run; audited by ids only (run-learning.correction-recorded). Exactly the same, for a run of this workflow only.',
        'x-xo-permission': 'author',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string', pattern: '^wfl_[0-9a-f]{32}$' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '201': { description: '{ observation }' },
          '400': { description: 'Invalid body' },
          '401': { description: 'Not signed in' },
          '403': { description: 'Not allowed for this role' },
          '404': { description: 'Unknown run' },
          '412': { description: 'Already proposed, or the run has no readable manifest' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-entities/{workflowId}/runs/{runId}/learning-proposals': {
      post: {
        summary: 'Propose observations as knowledge for review (UW-11b)',
        description:
          'Body `{ observationIds, note? }`. Proposes `xo-run` claims as a change set of origin run-outcome; the knowledge head moves only when a reviewer other than the proposer approves it. Exactly the same, for a run of this workflow only.',
        'x-xo-permission': 'author',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string', pattern: '^wfl_[0-9a-f]{32}$' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '201': { description: '{ changeSet, proposed }' },
          '400': { description: 'Invalid body' },
          '401': { description: 'Not signed in' },
          '403': { description: 'Not allowed for this role' },
          '404': { description: 'Unknown run' },
          '412': { description: 'Already proposed, or the run has no readable manifest' },
        },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/runs/{runId}/evidence': {
      get: {
        summary: 'The evidence of one item of a run (UW-12b)',
        description:
          'Query `item` (a batch needs one). Where the item came from (row, match, document), what was approved and by whom, each call and its outcome, whether the run record is intact, and how many observations the item has. Workspace members.',
        'x-xo-permission': 'read',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'RunEvidenceView' },
          '400': { description: 'Invalid request' },
          '401': { description: 'Not signed in' },
          '403': { description: 'Not allowed for this role, or the step is delegated to someone else' },
          '404': { description: 'Unknown run' },
        },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/runs/{runId}/outputs': {
      get: {
        summary: 'The typed outputs of a run (UW-12b)',
        description:
          'Deliveries, documents and results, each with its type, who may see it (workspace members) and how long it is kept (until the workspace is deleted). Nothing new is stored.',
        'x-xo-permission': 'read',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: '{ runId, artefacts }' },
          '400': { description: 'Invalid request' },
          '401': { description: 'Not signed in' },
          '403': { description: 'Not allowed for this role, or the step is delegated to someone else' },
          '404': { description: 'Unknown run' },
        },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/runs/{runId}/approvals/{approvalId}/delegate': {
      post: {
        summary: 'Delegate a waiting step to another reviewer (UW-12b)',
        description:
          'Body `{ to, reason, revision? }`. `to` must be able to review. Only the delegate may then decide the step; an admin takes it back by delegating it to themselves. A stale `revision` answers 409. Needs the review role and a recent sign-in. Audited by ids only.',
        'x-xo-permission': 'review',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'approvalId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: '{ runId, approvalId, assignedTo, revision }' },
          '400': { description: 'Invalid request' },
          '401': { description: 'Not signed in' },
          '403': { description: 'Not allowed for this role, or the step is delegated to someone else' },
          '404': { description: 'Unknown run' },
          '409': { description: 'The step was delegated again since the caller looked' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-entities/{workflowId}/runs/{runId}/evidence': {
      get: {
        summary: 'The evidence of one item of a run (UW-12b)',
        description:
          'Query `item` (a batch needs one). Where the item came from (row, match, document), what was approved and by whom, each call and its outcome, whether the run record is intact, and how many observations the item has. Workspace members. Exactly the same, for a run of this workflow only.',
        'x-xo-permission': 'read',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string', pattern: '^wfl_[0-9a-f]{32}$' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'RunEvidenceView' },
          '400': { description: 'Invalid request' },
          '401': { description: 'Not signed in' },
          '403': { description: 'Not allowed for this role, or the step is delegated to someone else' },
          '404': { description: 'Unknown run' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-entities/{workflowId}/runs/{runId}/outputs': {
      get: {
        summary: 'The typed outputs of a run (UW-12b)',
        description:
          'Deliveries, documents and results, each with its type, who may see it (workspace members) and how long it is kept (until the workspace is deleted). Nothing new is stored. Exactly the same, for a run of this workflow only.',
        'x-xo-permission': 'read',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string', pattern: '^wfl_[0-9a-f]{32}$' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: '{ runId, artefacts }' },
          '400': { description: 'Invalid request' },
          '401': { description: 'Not signed in' },
          '403': { description: 'Not allowed for this role, or the step is delegated to someone else' },
          '404': { description: 'Unknown run' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-entities/{workflowId}/runs/{runId}/approvals/{approvalId}/delegate': {
      post: {
        summary: 'Delegate a waiting step to another reviewer (UW-12b)',
        description:
          'Body `{ to, reason, revision? }`. `to` must be able to review. Only the delegate may then decide the step; an admin takes it back by delegating it to themselves. A stale `revision` answers 409. Needs the review role and a recent sign-in. Audited by ids only. Exactly the same, for a run of this workflow only.',
        'x-xo-permission': 'review',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string', pattern: '^wfl_[0-9a-f]{32}$' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'approvalId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: '{ runId, approvalId, assignedTo, revision }' },
          '400': { description: 'Invalid request' },
          '401': { description: 'Not signed in' },
          '403': { description: 'Not allowed for this role, or the step is delegated to someone else' },
          '404': { description: 'Unknown run' },
          '409': { description: 'The step was delegated again since the caller looked' },
        },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/previews/{previewId}/request-changes': {
      post: {
        summary: 'Ask for changes to a batch preview (UW-12b)',
        description:
          'Body `{ comment }`. The preview can no longer be approved (approve answers `changes_requested`); the preparer sees the comment in the preview and the Inbox.',
        'x-xo-permission': 'review',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'previewId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '201': { description: '{ previewId, changesRequested }' },
          '400': { description: 'Invalid request' },
          '401': { description: 'Not signed in' },
          '403': { description: 'Not allowed for this role, or the step is delegated to someone else' },
          '404': { description: 'Unknown run' },
          '409': { description: 'Already approved, or expired' },
        },
      },
    },
    '/workspaces/{workspaceId}/control/inbox/changes': {
      get: {
        summary: 'Wait for the inbox to change (UW-12b)',
        description:
          'Query `etag` (the tag of the inbox the caller holds) and `wait` (0 to 25 seconds, default 0). Returns `{ etag, changed }` when the inbox differs from `etag`, or when the wait ends. Without `etag` it answers at once.',
        'x-xo-permission': 'read',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'etag', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'wait', in: 'query', required: false, schema: { type: 'number', minimum: 0, maximum: 25 } },
        ],
        responses: {
          '200': { description: '{ etag, changed }' },
          '400': { description: 'wait is out of range' },
          '401': { description: 'Not signed in' },
          '403': { description: 'Not allowed for this role' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-entities/{workflowId}/runs/{runId}/effects/{step}/reconciliation': {
      post: {
        summary: 'Record what happened to an unknown call of a Workflow run (UW-7)',
        description:
          'Exactly POST …/generated-workflows/{definitionId}/runs/{runId}/effects/{step}/reconciliation, for a run of this workflow only.',
        'x-xo-permission': 'review',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string', pattern: '^wfl_[0-9a-f]{32}$' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'step', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: '{ runId, effect, workflowId }' },
          '400': { description: 'Invalid decision or missing reason' },
          '401': { description: 'Not signed in' },
          '403': { description: 'Not a reviewer, or no recent sign-in' },
          '404': { description: 'Unknown workflow, not its run, or no call' },
          '412': { description: 'The call is not in an unknown state' },
        },
      },
    },
    '/workspaces/{workspaceId}/workflow-entities/{workflowId}/runs/{runId}/approvals/{approvalId}': {
      post: {
        summary: 'Decide a pending approval of a Workflow run (UW-2)',
        description:
          'Body `{ action: "approve" | "reject", comment? }`. Needs the review role and a recent sign-in; exactly POST …/generated-workflows/{definitionId}/runs/{runId}/approvals/{approvalId}, and only for a run of this workflow. Audited as generated-workflow.approval.decided.',
        'x-xo-permission': 'review',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'workflowId', in: 'path', required: true, schema: { type: 'string', pattern: '^wfl_[0-9a-f]{32}$' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'approvalId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '401': { description: 'Not signed in' },
          '404': { description: 'Unknown workspace or workflow (an outsider sees the same)' },
          '200': { description: 'GeneratedWorkflowRun & { workflowId }' },
          '400': { description: 'Invalid decision' },
          '403': { description: 'Not a reviewer, or no recent sign-in' },
        },
      },
    },
    '/workspaces/{workspaceId}/intelligence/conversations/{conversationId}/workflows': {
      get: {
        summary: "The Workflows created from one of the caller's conversations (UW-2)",
        description:
          "Same page shape and query as GET …/workflow-entities. Conversations are private: anyone else's, and a deleted one, is a 404. Deleting a conversation never deletes its workflows.",
        'x-xo-permission': 'read',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'conversationId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '401': { description: 'Not signed in' },
          '404': { description: 'Unknown workspace or workflow (an outsider sees the same)' },
          '200': { description: '{ workflows: WorkflowSummary[], nextCursor?, changesCursor }' },
        },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/runs/{runId}/cancel': {
      post: {
        summary: 'Cancel a run, a whole batch, or one item of a batch (UW-7, ADR 0024)',
        description:
          "Body `{ reason? }` (at most 500 characters; any other field is a 400). The request is recorded durably BEFORE anything else (first request wins; a repeat changes nothing and returns `cancelRecorded: false`). From then on no dispatch starts: the run checks before every step and immediately before every call. Settled work stands (a run whose steps had all finished completes; batch items already completed stay completed). A call that was in flight becomes `outcome_unknown` and the run escalates for a person (CANCELLED_OUTCOME_UNKNOWN); it is never reported as cancelled, re-sent or undone. Otherwise the workflow's `cancellation.onCancel` decides: `abandon` ends `cancelled`; `compensate` undoes completed reversible writes and ends `compensated` with `outputs.cancelled: true`. When another instance is driving the run, the request is applied there before its next step or call (`cancellation.applied: false` here). A batch result lists completed, cancelledItems, notStarted, escalated and outcomeUnknown. Audited as generated-workflow.run.cancelled every time. The P1.1 procedure routes keep no cancel route (ADR 0024: procedures gain one when they move to this engine).",
        'x-xo-permission': 'author',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'GeneratedWorkflowRun & { cancelRecorded }' },
          '400': { description: 'Invalid body' },
          '401': { description: 'Not signed in' },
          '403': { description: 'Not an author' },
          '404': { description: 'Unknown run' },
        },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/runs/{runId}/effects/{step}/reconciliation': {
      post: {
        summary: 'Record what happened to a call whose outcome is unknown (UW-7, UAC-8)',
        description:
          'Body `{ decision: "confirmed_success" | "confirmed_failure_no_effect" | "unresolved", reason, evidenceExamined? }`. Needs the review role and a recent sign-in. Only a call in `outcome_unknown` or `reconciliation_required` can be reconciled (412 otherwise). NOTHING is sent, re-sent or undone, whatever the decision; `unresolved` records that someone looked and could not tell, and the call stays blocking. The decision is journalled with the reviewer and reason and audited as generated-workflow.effect.reconciled.',
        'x-xo-permission': 'review',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'step', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: '{ runId, effect }' },
          '400': { description: 'Invalid decision or missing reason' },
          '401': { description: 'Not signed in' },
          '403': { description: 'Not a reviewer, or no recent sign-in' },
          '404': { description: 'Unknown run, or the step made no external call' },
          '412': { description: 'The call is not in an unknown state' },
        },
      },
    },
    '/workspaces/{workspaceId}/generated-workflows/{definitionId}/runs/{runId}/approvals/{approvalId}': {
      post: {
        summary: 'Decide a pending approval of a generated-workflow run (ADR 0030)',
        description:
          'Body `{ action: "approve" | "reject", comment? }`. Needs the review role and a recent sign-in. The decision is signed for the authenticated reviewer with the instance approval key (ADR 0031: `XO_APPROVAL_SIGNING_KEY`, durable across restarts and shared by every instance; earlier keys stay in the keyring, so earlier decisions keep verifying) and the run continues. Audited as generated-workflow.approval.decided.',
        'x-xo-permission': 'review',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'definitionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'approvalId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'GeneratedWorkflowRun' },
          '400': { description: 'Invalid decision' },
          '401': { description: 'Not signed in' },
          '403': { description: 'Not a reviewer, or no recent sign-in' },
          '404': { description: 'Unknown run, or no pending approval with that id (for example, already decided)' },
        },
      },
    },
    '/workspaces/{workspaceId}/readiness-certificates': {
      get: {
        summary: 'List readiness certificates (PX-7)',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '{ certificates: WorkflowReadinessCertificate[] }' } },
      },
    },
    '/workspaces/{workspaceId}/readiness-certificates/{certificateId}': {
      get: {
        summary: 'One readiness certificate (PX-7)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'certificateId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'WorkflowReadinessCertificate' }, '404': { description: 'Unknown certificate' } },
      },
    },
    '/workspaces/{workspaceId}/readiness-certificates/{certificateId}/verify': {
      get: {
        summary: 'Verify a readiness certificate against the current state (PX-7)',
        description: 'The same check the start gate makes: intact, a status that allows a start, and every bound digest current.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'certificateId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: '{ certificateId, status, startAllowed, reasons? }' } },
      },
    },
    '/workspaces/{workspaceId}/compilations/{compilationId}/capabilities': {
      get: {
        summary: 'Get the capabilities discovered/resolved by a succeeded compilation',
        description:
          'Each capability carries its binding `status`, evidence, confidence, and `approved`. `inputContract` (optional, additive) is the capability\'s authoritative input schema — the same flat `CapabilityInputSchema` execution validates against: { type: \"object\", properties: { name: { type: \"string\" | \"number\" | \"boolean\" } }, required: string[] }. Properties not declared are rejected at execution. ABSENCE MEANS NO PUBLISHED CONTRACT, NOT \"NO INPUTS NEEDED\" (no structural validation happens without a schema); compilations stored before this field existed also omit it — recompile to obtain it. It is advisory for building forms: the server remains the sole validation authority.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'compilationId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description:
              '{ compilationId, capabilities: CapabilityProjection[] }. A capability may carry `understanding`: `manual_step` (a step of a procedure the document lays out, done by a person) or `possible_extraction_error` (the name may mix text from different places on the page). It is informational: it never changes `status`, approval or execution.',
          },
          '404': { description: 'Unknown compilation, compilation did not succeed, or workspace not owned by the caller' },
        },
      },
    },

    // P0.3: workspace-bound source upload/registration (storage only — no compilation).
    '/workspaces/{workspaceId}/source-versions': {
      get: {
        summary: 'List source versions (PX-1)',
        description:
          'A version is the exact bytes (their SHA-256). Every upload or import that delivered those bytes is listed as its own record, with origin and time; nothing is merged away.',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description:
              '{ versions: { digestSha256, byteSize, firstSeenAt, records: { sourceId, originalFilename, createdAt, origin }[] }[] }',
          },
        },
      },
    },
    '/workspaces/{workspaceId}/sources': {
      post: {
        summary: 'Upload a source document into this workspace',
        description:
          'Body is the raw file bytes (Content-Type header describes them); original filename is passed as ?filename=. Only formats @xo/compiler supports are accepted (pdf/docx/xlsx/eml/html/htm/json/csv/txt/md/png/jpg/jpeg/gif/webp) — see sources/source.ts SUPPORTED_EXTENSIONS. .docx, .xlsx, .csv and .eml are read at the door: a broken or hostile file is a 400 with the reason. For large files on unreliable networks use the resumable /uploads routes.',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'filename', in: 'query', required: true, schema: { type: 'string' } },
        ],
        requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        responses: {
          '201': { description: 'SourceRecord' },
          '400': { description: 'Missing/empty body, missing filename, or unsupported extension' },
          '404': { description: 'Workspace not found or not owned by the caller' },
        },
      },
      get: {
        summary: 'List sources uploaded to this workspace',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '{ sources: SourceRecord[] }' } },
      },
    },
    // UW-3: resumable uploads. Same door as POST .../sources once complete.
    '/workspaces/{workspaceId}/uploads': {
      post: {
        summary: 'Open a resumable upload',
        description:
          'Body { filename, size, sha256?, mediaType? }. Returns { uploadId, offset: 0, size, expiresAt, maxChunkBytes }. Sessions belong to the caller and expire after 24 hours; at most 10 open per identity (429 XO_UPLOAD_SESSION_LIMIT).',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '201': { description: 'Upload session' }, '400': { description: 'Bad filename, type, size or sha256' } },
      },
    },
    '/workspaces/{workspaceId}/uploads/{uploadId}': {
      get: {
        summary: 'Where a resumable upload got to (the offset to continue from)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'uploadId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Upload session' }, '404': { description: 'Unknown, expired, or someone else’s upload' } },
      },
      put: {
        summary: 'Send the next chunk at ?offset= (must equal the session offset; at most maxChunkBytes)',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'uploadId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'offset', in: 'query', required: true, schema: { type: 'integer' } },
        ],
        requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        responses: {
          '200': { description: 'Upload session with the new offset' },
          '412': { description: 'The offset is not where the upload continues; GET the session for the right one' },
        },
      },
      delete: {
        summary: 'Cancel a resumable upload',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'uploadId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: '{ cancelled: true }' } },
      },
    },
    '/workspaces/{workspaceId}/uploads/{uploadId}/complete': {
      post: {
        summary: 'Finish a resumable upload: verify size and declared SHA-256, then store it as a source',
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'uploadId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '201': { description: 'SourceRecord' },
          '412': { description: 'Bytes are still missing' },
          '422': { description: 'XO_UPLOAD_INTEGRITY_FAILED: the received file is not the declared one (the upload is discarded)' },
        },
      },
    },
    '/workspaces/{workspaceId}/sources/{sourceId}': {
      get: {
        summary: "Get a source's metadata (not its content — see .../content)",
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'sourceId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'SourceRecord' },
          '404': { description: 'Unknown source, or workspace not owned by the caller' },
        },
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
        responses: {
          '200': { description: 'Raw file bytes, Content-Type set to the recorded mediaType' },
          '404': { description: 'Unknown source, or workspace not owned by the caller' },
        },
      },
    },

    // P0.2: resolve/lock/manifest are workspace-bound — no more `?store=`.
    '/workspaces/{workspaceId}/packages/resolve': {
      post: {
        summary: "Dry-run dependency resolution against this workspace's installed packages (nothing written)",
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['nameAtVersion'],
                properties: { nameAtVersion: { type: 'string', example: 'corp-lawyer@1.4.0' } },
              },
            },
          },
        },
        responses: { '200': { description: 'DependencyResolution' }, '404': { description: 'Workspace or package not found' } },
      },
    },
    '/workspaces/{workspaceId}/packages/lock': {
      post: {
        summary: 'Resolve and write xo.lock into this workspace (mirrors `xo lock` exactly)',
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['nameAtVersion'], properties: { nameAtVersion: { type: 'string' } } },
            },
          },
        },
        responses: { '200': { description: 'XoLockfile' } },
      },
    },
    '/workspaces/{workspaceId}/packages/{name}/{version}/manifest': {
      get: {
        summary: "Read an installed package's manifest within this workspace",
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
        summary: "Bootstrap the runtime against this workspace's installed packages and return its mounted state",
        parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Mounted packages + capability index + any bootstrap warnings' },
          '404': { description: 'Workspace not found or not owned by the caller' },
        },
      },
    },
    '/workspaces/{workspaceId}/runtime/execute': {
      post: {
        summary: 'DISABLED (P1.0 M1): AI-assisted execution — always responds 501 after the workspace-ownership check',
        description:
          "AI-assisted execution is disabled. This route would construct the execution engine with no permission gate and accept provider credentials/endpoint from request headers (the provider factory now rejects any x-xo-* provider header and uses server-configured inference only, but the missing authorization gate remains), so it stays unavailable until capability authorization is enforced on this path (planned P1.0 M2). The workspace-ownership check still runs first (foreign or unknown workspace => the same 404), then the route responds 501 before any provider is resolved or any x-xo-* header is read. The request body and the non-501 responses documented below describe the route's retained, currently UNREACHABLE behaviour; they have no effect today. If the route is re-enabled, the provider is chosen by server configuration only and any x-xo-provider/x-xo-api-key/x-xo-base-url/x-xo-endpoint/x-xo-api-version header is rejected with 400. Deterministic execution (POST /workspaces/{workspaceId}/executions) is unaffected. Re-enabling is a code change, not configuration.",
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
        responses: {
          '501': { description: 'AI-assisted execution is disabled (always returned today, for every body/header combination)' },
          '401': { description: 'Missing, invalid, revoked, or principal-unbound API key' },
          '200': { description: 'Execution completed (UNREACHABLE while disabled)' },
          '403': { description: 'Safety-blocked' },
          '404': { description: 'Workspace not found or not owned by the caller' },
          '429': { description: 'Budget exceeded' },
          '502': { description: 'Provider/execution failure' },
        },
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
              schema: {
                type: 'object',
                required: ['kind', 'graph'],
                properties: {
                  kind: { type: 'string', enum: ['xoir', 'knowledge', 'capability', 'combined'] },
                  graph: { type: 'object', description: 'XoirGraphJson' },
                  graphId: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Valid, normalized graph' },
          '422': { description: 'Graph failed validation' },
          '501': { description: '"knowledge"/"capability"/"combined" input not yet supported over HTTP' },
        },
      },
    },
  },

  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          'API key issued by an operator with scripts/manage-keys.ts issue <identityId> --kind human|service [--org <orgId>]. 401 when the key is missing, unrecognized, revoked, or its record has no valid principal binding (keys issued before P1.0 M1). The caller never supplies its own identity: headers, query parameters and body fields claiming an identity are ignored.',
      },
    },
    schemas: {
      ProcedureDefinition: {
        type: 'object',
        description:
          'Closed, strict schema (xo.procedure/1). Client input never defines permissions, effects, limits, human-gate status, approvers or binding state; unknown or authority-bearing fields are rejected. inputs/outputs blocks are not accepted in this milestone.',
        additionalProperties: false,
        required: ['schema', 'procedureId', 'version', 'steps'],
        properties: {
          schema: { type: 'string', enum: ['xo.procedure/1'] },
          procedureId: { type: 'string' },
          version: { type: 'integer', minimum: 1 },
          title: { type: 'string' },
          compilationRef: { type: 'object', properties: { compilationId: { type: 'string' }, graphHash: { type: 'string' } } },
          steps: { type: 'array', maxItems: 25, items: { type: 'object' } },
          unknowns: { type: 'array', items: { type: 'string' } },
        },
      },
      ProcedureExecution: {
        type: 'object',
        properties: {
          procedureExecutionId: { type: 'string' },
          procedureId: { type: 'string' },
          version: { type: 'integer' },
          procedureHash: { type: 'string' },
          status: { type: 'string', enum: ['running', 'waiting_for_human', 'completed', 'failed'] },
          revision: { type: 'integer' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                stepId: { type: 'string' },
                capabilityId: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'running', 'succeeded', 'waiting_for_human', 'failed', 'skipped'] },
                executionId: { type: 'string' },
                failureClass: { type: 'string' },
              },
            },
          },
          outputs: { type: 'object' },
          waitingFor: { type: 'object' },
          failure: {
            type: 'object',
            properties: {
              class: {
                type: 'string',
                enum: [
                  'authorization',
                  'stale_binding',
                  'input_invalid',
                  'capability_error',
                  'timeout',
                  'failed_postcondition',
                  'human_rejected',
                  'internal',
                ],
              },
              code: { type: 'string' },
            },
          },
        },
      },
      ProcedureValidationReport: {
        type: 'object',
        properties: {
          valid: { type: 'boolean' },
          findings: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, path: { type: 'string' } } } },
          procedureHash: { type: 'string' },
          registryStateDigest: { type: 'string' },
        },
      },
      ProcedureView: {
        type: 'object',
        properties: {
          procedureId: { type: 'string' },
          version: { type: 'integer' },
          procedureHash: { type: 'string' },
          lifecycle: { type: 'string', enum: ['draft', 'approved', 'approval_stale', 'approval_invalid', 'approval_unverifiable'] },
          executable: {
            type: 'boolean',
            description: 'Always false in this milestone: nothing executes, and executability is computed at start, never stored.',
          },
          unknowns: { type: 'array', items: { type: 'string' } },
          authorAssertedSteps: { type: 'array', items: { type: 'string' } },
          approval: { type: 'object' },
          definition: { $ref: '#/components/schemas/ProcedureDefinition' },
        },
      },
      Principal: {
        type: 'object',
        description:
          'P1.0 M1 attribution snapshot of the authenticated initiator, as persisted on execution and workflow-execution records (initiator) and on resolved human tasks (humanTask.resolver). Attribution only: it grants no permission, orgId is a label and not proof of membership, and records are mutable files with no integrity protection yet. Absent on records written before M1.',
        required: ['kind', 'id'],
        properties: {
          kind: { type: 'string', enum: ['human', 'service'] },
          id: {
            type: 'string',
            description:
              "Stable identity; equals the API key record's identityId. 1-128 chars of letters, digits and . _ : @ - ; starts alphanumeric.",
          },
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
          status: {
            type: 'string',
            enum: ['pending', 'running', 'waiting_for_human', 'succeeded', 'failed', 'rejected', 'skipped', 'interrupted'],
          },
          executionId: { type: 'string', description: "The underlying P0.5 ExecutionRecord id of this step's current attempt." },
          supersededExecutionIds: { type: 'array', items: { type: 'string' } },
          contractId: { type: 'string' },
          bindingId: { type: 'string' },
          executionClass: { type: 'string', enum: ['deterministic_rule', 'human_in_the_loop'] },
          startedAt: { type: 'string' },
          completedAt: { type: 'string' },
          result: { description: "The step's output when succeeded (copy of ExecutionRecord.output)." },
          error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } },
        },
      },
      WorkflowExecution: {
        type: 'object',
        required: [
          'workflowExecutionId',
          'workspaceId',
          'identityId',
          'compilationId',
          'workflowId',
          'status',
          'input',
          'steps',
          'revision',
        ],
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
          pendingHumanTask: {
            type: 'object',
            properties: {
              stepIndex: { type: 'integer' },
              executionId: { type: 'string' },
              humanTaskStatus: { type: 'string', enum: ['pending', 'resolved'] },
            },
          },
          completedStepExecutionIds: { type: 'array', items: { type: 'string' } },
          createdAt: { type: 'string' },
          startedAt: { type: 'string' },
          updatedAt: { type: 'string' },
          completedAt: { type: 'string' },
          finalResult: { type: 'object', description: 'Present only when status is succeeded.' },
          rejection: { type: 'object', description: 'Present only when status is rejected.' },
          errorCode: { type: 'string' },
          errorMessage: { type: 'string' },
          provenance: {
            type: 'object',
            description:
              'compilationId/sourceId/sourceDigestSha256/workflowId plus per-step capability -> contract -> binding -> execution references.',
          },
        },
      },
    },
  },
} as const;
