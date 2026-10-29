/**
 * OpenAPI paths for the Studio backend routes (members/roles, audit, settings, runtime status, notifications, inbox,
 * library, chat, workflow definitions, URL import). Hand-written like the rest of `openapi.ts` and spread into it;
 * `test/openapi-sync.test.ts` fails if a registered `/workspaces/...` route is missing here or a documented
 * permission is not a real workspace permission, so the document cannot silently drift from what is served.
 *
 * `x-xo-permission` is the workspace permission the route requires (see `workspace/permissions.ts`):
 *   read (any member) · author · publish · review · audit · manage. A member without it gets 403 and the attempt is
 *   written to the audit log; a caller who is not a member at all gets 404 (existence is not revealed).
 */

const str = { type: 'string' } as const;
const int = { type: 'integer' } as const;
const bool = { type: 'boolean' } as const;
const ts = { type: 'string', format: 'date-time' } as const;
const obj = (properties: Record<string, unknown>, required: readonly string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
});
const arr = (items: unknown) => ({ type: 'array', items });
const pathParam = (name: string) => ({ name, in: 'path', required: true, schema: str });
const query = (name: string, description: string, schema: unknown = str) => ({ name, in: 'query', required: false, description, schema });
const WS = pathParam('workspaceId');
const body = (schema: unknown) => ({ required: true, content: { 'application/json': { schema } } });
const ok = (description: string, schema?: unknown) => ({
  description,
  ...(schema !== undefined ? { content: { 'application/json': { schema } } } : {}),
});

const R_401 = ok('Missing or invalid credentials');
const R_403 = ok(
  'The caller is a member but their role lacks the required permission. The attempt is recorded in the audit log as access.denied.',
);
const R_404_WS = ok('Workspace not found, or the caller is neither its owner nor a member (the two are deliberately indistinguishable)');
const R_400 = ok('Malformed or invalid request (the error message names the field)');
const R_412 = ok('A precondition failed (stated in the error message)');

const standard = (...extra: Array<[string, unknown]>) => ({ '401': R_401, '404': R_404_WS, ...Object.fromEntries(extra) });

const role = obj({ role: { type: 'string', enum: ['admin', 'publisher', 'reviewer', 'viewer'] } });
const member = obj({ identityId: str, role: role.properties.role, isOwner: bool, displayName: str, email: str, addedAt: ts }, [
  'identityId',
  'role',
  'isOwner',
]);
const modelChoice = obj({ provider: { type: 'string', enum: ['anthropic', 'openai', 'azure-openai', 'gemini', 'ollama'] }, model: str }, [
  'provider',
  'model',
]);
const auditEntry = obj(
  {
    seq: int,
    eventId: str,
    at: ts,
    workspaceId: str,
    event: str,
    result: { type: 'string', enum: ['succeeded', 'failed', 'denied', 'escalated', 'approved', 'rejected'] },
    actor: obj({ identityId: str, kind: { type: 'string', enum: ['user', 'service', 'system'] }, role: str, displayName: str }, [
      'identityId',
      'kind',
    ]),
    target: obj({ kind: str, id: str, label: str }, ['kind', 'id']),
    detail: { type: 'object', additionalProperties: true },
    prevHash: str,
    hash: str,
  },
  ['seq', 'eventId', 'at', 'event', 'result', 'actor', 'prevHash', 'hash'],
);
const chatMessage = obj(
  {
    messageId: str,
    role: { type: 'string', enum: ['user', 'assistant'] },
    content: str,
    at: ts,
    model: obj({ provider: str, model: str }),
    attachedXos: arr(str),
  },
  ['messageId', 'role', 'content', 'at'],
);
const nodeSchema = obj(
  {
    id: str,
    kind: { type: 'string', enum: ['trigger', 'compile', 'validate', 'capability', 'branch', 'human_review', 'action'] },
    label: str,
    config: {
      type: 'object',
      additionalProperties: true,
      description:
        'Validated per kind: trigger{type}, capability{packageName,capabilityId,memoryScope,compilationId?}, branch{metric:"confidence",threshold:0..1}, action{type}; compile/validate/human_review take none.',
    },
  },
  ['id', 'kind'],
);
const definitionInput = obj(
  {
    name: str,
    expectedRevision: { ...int, description: 'PUT only. A stale revision is refused with 412 and the newer draft is kept.' },
    nodes: arr(nodeSchema),
    edges: arr(
      obj(
        { from: str, to: str, when: { type: 'string', enum: ['gte', 'lt'], description: 'Required on both edges leaving a branch node.' } },
        ['from', 'to'],
      ),
    ),
  },
  ['name', 'nodes', 'edges'],
);
const draftPlan = obj({
  compilationId: str,
  path: arr(str),
  steps: arr(
    obj({
      nodeId: str,
      capabilityId: str,
      name: str,
      executionClass: { type: 'string', enum: ['deterministic_rule', 'human_in_the_loop'] },
      approved: bool,
    }),
  ),
  branches: arr(
    obj({
      nodeId: str,
      metric: { type: 'string', enum: ['confidence'] },
      basis: {
        type: 'string',
        enum: ['declared_contract_confidence'],
        description: "The upstream capability's compile-time contract confidence. Static; not measured per run.",
      },
      capabilityId: str,
      value: { type: 'number' },
      threshold: { type: 'number' },
      taken: { type: 'string', enum: ['gte', 'lt'] },
    }),
  ),
});
const analysis = obj({
  wellFormed: bool,
  runnable: {
    type: 'boolean',
    description:
      'True only when the draft is well formed, has no blockers, and its plan resolved against stored compilations: one manual trigger, capability steps from one succeeded compilation that each bind to an executable binding, an optional confidence branch, and human review only directly after a human-in-the-loop capability. Approval is checked when a run starts, not here (plan.steps[].approved shows it).',
  },
  plan: draftPlan,
  errors: arr(obj({ severity: str, nodeId: str, message: str })),
  blockers: arr(obj({ severity: str, nodeId: str, message: str })),
});

export const studioPaths = {
  '/regions': {
    get: {
      summary: 'Data-residency regions a workspace may declare',
      description:
        'A declaration vocabulary. Choosing a region records a requirement; the server does not prove or control where bytes are physically stored.',
      responses: { '200': ok('{ regions: { id, label }[] }'), '401': R_401 },
    },
  },

  '/workspaces/{workspaceId}/members': {
    get: {
      summary: 'List members, role counts and the role/permission table',
      'x-xo-permission': 'read',
      parameters: [WS],
      responses: {
        '200': ok(
          'Owner (always admin) plus members, roleCounts, and the caller role and permissions',
          obj({
            members: arr(member),
            total: int,
            roleCounts: { type: 'object', additionalProperties: int },
            callerRole: str,
            callerPermissions: arr(str),
          }),
        ),
        ...standard(),
      },
    },
    post: {
      summary: 'Grant an identity access to the workspace',
      description:
        'Adds by identity id (there is no email invitation). Not allowed on personal workspaces. The owner is implicit and cannot be added or changed.',
      'x-xo-permission': 'manage',
      parameters: [WS],
      requestBody: body(obj({ identityId: str, role: role.properties.role, displayName: str, email: str }, ['identityId', 'role'])),
      responses: {
        '201': ok('{ member }'),
        '400': R_400,
        '403': R_403,
        '409': ok('That identity already has access'),
        '412': R_412,
        ...standard(),
      },
    },
  },
  '/workspaces/{workspaceId}/members/{identityId}': {
    patch: {
      summary: "Change a member's role",
      'x-xo-permission': 'manage',
      parameters: [WS, pathParam('identityId')],
      requestBody: body(obj({ role: role.properties.role }, ['role'])),
      responses: { '200': ok('{ member }'), '400': R_400, '403': R_403, '412': ok('The owner cannot be changed'), ...standard() },
    },
    delete: {
      summary: 'Remove a member (access ends immediately)',
      'x-xo-permission': 'manage',
      parameters: [WS, pathParam('identityId')],
      responses: { '200': ok('{ removed }'), '403': R_403, '412': ok('The owner cannot be removed'), ...standard() },
    },
  },

  '/workspaces/{workspaceId}/audit/events': {
    get: {
      summary: 'Read the audit log, newest first',
      description:
        'Append-only and hash-chained. Entries never contain document text or chat text, and import URLs are recorded without query strings.',
      'x-xo-permission': 'audit',
      parameters: [
        WS,
        query('event', 'Filter by event type, e.g. source.uploaded, access.denied'),
        query('result', 'Filter by result', {
          type: 'string',
          enum: ['succeeded', 'failed', 'denied', 'escalated', 'approved', 'rejected'],
        }),
        query('actor', 'Filter by actor identity id'),
        query('since', 'ISO-8601 lower bound', ts),
        query('until', 'ISO-8601 upper bound', ts),
        query('limit', '1-500, default 50', int),
        query('before', 'Page: only entries with seq below this (use nextBefore from the previous page)', int),
      ],
      responses: {
        '200': ok('{ events, nextBefore? }', obj({ events: arr(auditEntry), nextBefore: int })),
        '400': R_400,
        '403': R_403,
        ...standard(),
      },
    },
  },
  '/workspaces/{workspaceId}/audit/verify': {
    get: {
      summary: 'Re-verify the audit hash chain',
      description:
        'Recomputes every hash and link, and also checks for an entry beyond the head pointer. Detects edited, removed, reordered or forged entries. It cannot detect a complete, internally consistent rewrite of the whole chain unless the head hash was recorded elsewhere.',
      'x-xo-permission': 'audit',
      parameters: [WS],
      responses: {
        '200': ok(
          'ok, entries, headHash, brokenAt? and the retention declaration',
          obj({
            ok: bool,
            entries: int,
            headHash: str,
            brokenAt: obj({
              seq: int,
              reason: { type: 'string', enum: ['missing_entry', 'bad_hash', 'bad_link', 'bad_sequence', 'unreadable'] },
            }),
            retention: obj({ minimumDays: { type: 'integer', nullable: true }, deletionSupported: bool }),
          }),
        ),
        '403': R_403,
        ...standard(),
      },
    },
  },
  '/workspaces/{workspaceId}/audit/export': {
    get: {
      summary: 'Export an audit evidence pack (JSON) or the entries as CSV',
      description:
        'Evidence, not a certification: the pack includes the full log, a fresh integrity check, the access-control snapshot, declared residency and retention (null unless the operator set XO_API_AUDIT_RETENTION_DAYS), and notices stating the limits. CSV cells that start with = + - @ are neutralized against spreadsheet formula injection. The export itself is audited.',
      'x-xo-permission': 'manage',
      parameters: [WS, query('format', 'json (default) or csv', { type: 'string', enum: ['json', 'csv'] })],
      responses: { '200': ok('Attachment: JSON evidence pack or CSV'), '400': R_400, '403': R_403, ...standard() },
    },
  },

  '/workspaces/{workspaceId}/settings': {
    get: {
      summary: 'Workspace settings, plus what the server enforces vs merely records',
      description:
        'The `effect` block states, per section, whether the setting is enforced by this server. No credential is ever returned.',
      'x-xo-permission': 'read',
      parameters: [WS],
      responses: { '200': ok('{ settings, effect }'), ...standard() },
    },
    put: {
      summary: 'Update settings (partial patch)',
      description:
        'Unknown fields are rejected. Settings the deployment cannot honor are refused, not stored: a runtime location the deployment does not offer is 412; air-gapped mode with an off-box model is 412 (checked on the merged result, so field order does not matter). Air-gapped mode blocks URL import and off-box chat providers. requireSignedPackages makes registry publish and install refuse a package whose manifest has no signature entries — a presence check only; signature validity is not verified by this server. Region updates the workspace record.',
      'x-xo-permission': 'manage',
      parameters: [WS],
      requestBody: body(
        obj({
          expectedRevision: int,
          runtime: obj({ location: { type: 'string', enum: ['this_computer', 'private_server', 'cloud'] } }),
          model: obj({ primary: { ...modelChoice, nullable: true }, fallback: { ...modelChoice, nullable: true } }),
          airGapped: bool,
          region: str,
          trust: obj({ requireSignedPackages: bool }),
          notifications: obj({ onEscalation: bool, onRunFailure: bool, onWorkflowComplete: bool }),
        }),
      ),
      responses: {
        '200': ok('{ settings, effect }'),
        '400': R_400,
        '403': R_403,
        '412': ok('Stale expectedRevision, an unavailable location, or an air-gapped conflict'),
        ...standard(),
      },
    },
  },
  '/workspaces/{workspaceId}/runtime/status': {
    get: {
      summary: 'Runtime health, from a real runtime bootstrap',
      description:
        '"online" means this process answered and the workspace runtime bootstrapped; "degraded" means it bootstrapped with warnings; "offline" means bootstrap threw. Nothing more is claimed.',
      'x-xo-permission': 'read',
      parameters: [WS],
      responses: {
        '200': ok('status, location, mountedPackages, capabilityCount, warnings, model usability, airGapped, auditHead'),
        ...standard(),
      },
    },
  },
  '/workspaces/{workspaceId}/notifications': {
    get: {
      summary: 'In-app notifications derived from the audit log',
      description: 'Filtered by the notification settings. In-app only: there is no email, push or webhook delivery.',
      'x-xo-permission': 'read',
      parameters: [WS, query('limit', '1-200, default 50', int)],
      responses: { '200': ok('{ notifications, unread, readThroughSeq, delivery }'), '400': R_400, ...standard() },
    },
  },
  '/workspaces/{workspaceId}/notifications/read': {
    post: {
      summary: 'Mark notifications read through a sequence number (per caller; only moves forward)',
      'x-xo-permission': 'read',
      parameters: [WS],
      requestBody: body(obj({ throughSeq: int }, ['throughSeq'])),
      responses: { '200': ok('{ readThroughSeq }'), '400': R_400, ...standard() },
    },
  },

  '/workspaces/{workspaceId}/inbox': {
    get: {
      summary: 'Human tasks awaiting review, or completed',
      description:
        'A view over existing execution records joined with capability name, confidence, source file name and workflow run. Fields without a source are omitted.',
      'x-xo-permission': 'read',
      parameters: [WS, query('state', 'needs_review or done', { type: 'string', enum: ['needs_review', 'done'] })],
      responses: { '200': ok('{ items, counts: { needsReview, done } }'), '400': R_400, ...standard() },
    },
  },
  '/workspaces/{workspaceId}/inbox/{executionId}': {
    get: {
      summary: 'Review detail: input, the runtime escalation record, capability evidence, trace and information requests',
      'x-xo-permission': 'read',
      parameters: [WS, pathParam('executionId')],
      responses: { '200': ok('Inbox item detail'), ...standard(['404', ok('Unknown task, or workspace not accessible')]) },
    },
  },
  '/workspaces/{workspaceId}/inbox/{executionId}/info-requests': {
    post: {
      summary: 'Ask for more information on a pending task',
      description: 'Records a question. It never resolves, rejects or otherwise changes the task. At most 10 unanswered requests per task.',
      'x-xo-permission': 'review',
      parameters: [WS, pathParam('executionId')],
      requestBody: body(obj({ question: { type: 'string', maxLength: 2000 } }, ['question'])),
      responses: {
        '201': ok('InfoRequest'),
        '400': R_400,
        '403': R_403,
        '412': ok('The task is already resolved, or too many requests are open'),
        ...standard(),
      },
    },
  },
  '/workspaces/{workspaceId}/inbox/{executionId}/info-requests/{requestId}/answer': {
    post: {
      summary: 'Answer an information request (once; answers are never overwritten)',
      'x-xo-permission': 'author',
      parameters: [WS, pathParam('executionId'), pathParam('requestId')],
      requestBody: body(obj({ answer: { type: 'string', maxLength: 2000 } }, ['answer'])),
      responses: { '200': ok('InfoRequest'), '400': R_400, '403': R_403, '409': ok('Already answered'), ...standard() },
    },
  },

  '/workspaces/{workspaceId}/library': {
    get: {
      summary: 'Packages in this workspace registry, with installed state and recorded trust facts',
      description:
        'The catalog is this workspace only: there is no cross-organization marketplace, price or rating data. `trust` reports only what records say — whether signature entries are present (`signed`), never whether they are valid (`signaturesVerified` is always false: this server resolves no signer keys), whether benchmark runs exist, and the mean of the latest score per category. `independentlyVerified` is always false because benchmark runs do not record who ran them.',
      'x-xo-permission': 'read',
      parameters: [
        WS,
        query('q', 'Search text'),
        query('scope', 'all (default), installed, or mine', { type: 'string', enum: ['all', 'installed', 'mine'] }),
      ],
      responses: { '200': ok('{ items, counts: { all, installed, mine }, catalog: "workspace" }'), '400': R_400, ...standard() },
    },
  },
  '/workspaces/{workspaceId}/library/packages/{packageId}': {
    get: {
      summary: 'Package inspector: manifest summary, components, signers, benchmark runs and per-category scores',
      'x-xo-permission': 'read',
      parameters: [WS, pathParam('packageId')],
      responses: {
        '200': ok('Library item plus components, signatures, benchmarks, runs, installable'),
        ...standard(['404', ok('Unknown package, or workspace not accessible')]),
      },
    },
  },
  '/workspaces/{workspaceId}/library/installs': {
    get: {
      summary: 'Installed packages',
      'x-xo-permission': 'read',
      parameters: [WS],
      responses: { '200': ok('{ installs }'), ...standard() },
    },
    post: {
      summary: 'Install a package from this workspace registry',
      description:
        'Uses the archive retained at publish time and re-checks its merkle root against the registry record. Refused (412) when requireSignedPackages is on and the manifest has no signature entries (presence only, not validity), or when the archive was not retained (published before archives were kept — re-publish).',
      'x-xo-permission': 'author',
      parameters: [WS],
      requestBody: body(obj({ packageId: str, force: bool }, ['packageId'])),
      responses: {
        '201': ok('Installed package record'),
        '400': R_400,
        '403': R_403,
        '409': ok('Already installed'),
        '412': R_412,
        ...standard(['404', ok('Unknown package, or workspace not accessible')]),
      },
    },
  },
  '/workspaces/{workspaceId}/library/installs/{name}/{version}': {
    delete: {
      summary: 'Uninstall a package',
      'x-xo-permission': 'author',
      parameters: [WS, pathParam('name'), pathParam('version')],
      responses: { '200': ok('{ uninstalled }'), '403': R_403, ...standard(['404', ok('Not installed, or workspace not accessible')]) },
    },
  },

  '/workspaces/{workspaceId}/sources/import': {
    post: {
      summary: 'Import a source document from a link',
      description:
        'https only, default port, no credentials in the URL. The host is resolved by the server and every address must be public (loopback, private, link-local, metadata and IPv6-embedded private ranges are refused); the connection goes to the vetted address; redirects (max 3) are re-validated per hop; size is capped at 32 MB and time at 15 s idle / 30 s total. Disabled (412) in air-gapped mode. The stored origin and the audit entry keep host and path only — never the query string.',
      'x-xo-permission': 'author',
      parameters: [WS],
      requestBody: body(obj({ url: str, filename: str }, ['url'])),
      responses: {
        '201': ok('SourceRecord (origin.kind = "url")'),
        '400': R_400,
        '403': R_403,
        '412': ok('Air-gapped mode is on'),
        '502': ok('The link could not be downloaded'),
        ...standard(),
      },
    },
  },

  '/workspaces/{workspaceId}/chats': {
    get: {
      summary: "List the caller's chats (chats are private to their creator)",
      'x-xo-permission': 'read',
      parameters: [WS],
      responses: { '200': ok('{ threads }'), ...standard() },
    },
    post: {
      summary: 'Create a chat',
      'x-xo-permission': 'read',
      parameters: [WS],
      requestBody: { required: false, content: { 'application/json': { schema: obj({ title: { type: 'string', maxLength: 120 } }) } } },
      responses: { '201': ok('Thread summary'), '400': R_400, '412': ok('Chat limit reached'), ...standard() },
    },
  },
  '/workspaces/{workspaceId}/chats/{threadId}': {
    get: {
      summary: 'Get a chat with its messages',
      'x-xo-permission': 'read',
      parameters: [WS, pathParam('threadId')],
      responses: {
        '200': ok('Thread', obj({ threadId: str, title: str, messages: arr(chatMessage) })),
        ...standard(['404', ok("No such chat for this caller (another member's chat looks the same)")]),
      },
    },
    delete: {
      summary: 'Delete a chat',
      'x-xo-permission': 'read',
      parameters: [WS, pathParam('threadId')],
      responses: { '200': ok('{ deleted }'), ...standard(['404', ok('No such chat for this caller')]) },
    },
  },
  '/workspaces/{workspaceId}/chats/{threadId}/messages': {
    post: {
      summary: 'Send a message and receive the model reply',
      description:
        'The reply comes from the workspace model (Settings), falling back to the fallback model; credentials are server-side only and never accepted from the client. Chat is a conversation, not an agent: it cannot compile, run or approve anything. Attached installed XOs are given to the model as reference data. Nothing is saved if the model call fails. The audit entry records sizes and provider, never text.',
      'x-xo-permission': 'read',
      parameters: [WS, pathParam('threadId')],
      requestBody: body(
        obj({ content: { type: 'string', maxLength: 8000 }, attach: { ...arr(str), maxItems: 5, description: 'Names of installed XOs' } }, [
          'content',
        ]),
      ),
      responses: {
        '201': ok('{ threadId, title, userMessage, assistantMessage }'),
        '400': R_400,
        '412': ok('No model selected, no server-side credentials for it, or air-gapped mode forbids it'),
        '502': ok('Every configured model failed; nothing was saved'),
        ...standard(['404', ok('No such chat for this caller')]),
      },
    },
  },

  '/workspaces/{workspaceId}/compilations/{compilationId}/capabilities/{capabilityId}/preview': {
    post: {
      summary: 'Validate / Preview a capability (no execution)',
      description:
        'The no-effect half of the Create XO test policy. Rebuilds the contract and resolves the binding from the stored compiled graph, validates the supplied input against the declared schema, and describes what a real run would do. Never executes the capability, writes an execution record or opens a human task, and is allowed on an unapproved capability. `testRunAllowed` and `blockers` say whether a real Test Run would currently be permitted. A Test Run is the ordinary POST /workspaces/{workspaceId}/executions: same approval gate, same authorization, same audit entry — there is no second execution path. A passing preview does not prove the real run will succeed.',
      'x-xo-permission': 'author',
      parameters: [WS, pathParam('compilationId'), pathParam('capabilityId')],
      requestBody: {
        required: false,
        content: { 'application/json': { schema: obj({ input: { description: 'The input to check; defaults to {}' } }) } },
      },
      responses: {
        '200': ok(
          '{ previewOnly: true, approved, testRunAllowed, blockers, preview }',
          obj({ previewOnly: { type: 'boolean', enum: [true] }, approved: bool, testRunAllowed: bool, blockers: arr(str) }),
        ),
        '403': R_403,
        ...standard(['404', ok('Unknown compilation or capability, or workspace not accessible')]),
      },
    },
  },

  '/workspaces/{workspaceId}/workflow-definitions': {
    get: {
      summary: 'List saved workflow drafts',
      'x-xo-permission': 'read',
      parameters: [WS],
      responses: { '200': ok('{ definitions }'), ...standard() },
    },
    post: {
      summary: 'Save a new workflow draft',
      description:
        'Stores what the editor drew. A draft with structural errors can be saved; it is reported in `analysis`. Saving does NOT imply the workflow can run — see the run route.',
      'x-xo-permission': 'author',
      parameters: [WS],
      requestBody: body(definitionInput),
      responses: {
        '201': ok('Definition with analysis', obj({ definitionId: str, revision: int, analysis })),
        '400': R_400,
        '403': R_403,
        ...standard(),
      },
    },
  },
  '/workspaces/{workspaceId}/workflow-definitions/validate': {
    post: {
      summary: 'Validate a graph without saving it',
      'x-xo-permission': 'read',
      parameters: [WS],
      requestBody: body(definitionInput),
      responses: { '200': ok('Analysis', analysis), '400': R_400, ...standard() },
    },
  },
  '/workspaces/{workspaceId}/workflow-definitions/{definitionId}': {
    get: {
      summary: 'Load a workflow draft with its analysis',
      'x-xo-permission': 'read',
      parameters: [WS, pathParam('definitionId')],
      responses: { '200': ok('Definition with analysis'), ...standard(['404', ok('Unknown definition, or workspace not accessible')]) },
    },
    put: {
      summary: 'Replace a workflow draft (Save)',
      description: 'Guarded by expectedRevision: a stale editor receives 412 and the newer draft is preserved.',
      'x-xo-permission': 'author',
      parameters: [WS, pathParam('definitionId')],
      requestBody: body(definitionInput),
      responses: {
        '200': ok('Definition with analysis'),
        '400': R_400,
        '403': R_403,
        '412': ok('Stale expectedRevision'),
        ...standard(['404', ok('Unknown definition, or workspace not accessible')]),
      },
    },
    delete: {
      summary: 'Delete a workflow draft',
      'x-xo-permission': 'author',
      parameters: [WS, pathParam('definitionId')],
      responses: { '200': ok('{ deleted }'), '403': R_403, ...standard(['404', ok('Unknown definition, or workspace not accessible')]) },
    },
  },
  '/workspaces/{workspaceId}/workflow-definitions/{definitionId}/run': {
    post: {
      summary: 'Run a saved workflow draft',
      description:
        "Runs the draft's single resolved path through the same engine as a derived workflow: each capability must be approved in this workspace and permitted (403 otherwise), input is validated against the steps' contracts (400), a human-in-the-loop capability opens a human task (status waiting_for_human; continue via POST /workflow-executions/{id}/resume), and every step is a recorded execution. Body (all optional): { input, expectedRevision } — a stale expectedRevision is 409 and nothing runs. 202 returns the workflow execution record (same shape as GET /workflow-executions/{id}, plus draft: { definitionId, revision, path, branches }). A draft that is not runnable gets 501 with analysis (blockers, errors) and nothing is started. Idempotency-Key is honored as on derived workflows (replay is 200). Never accepts steps, capability ids or bindings from the request.",
      'x-xo-permission': 'author',
      parameters: [WS, pathParam('definitionId')],
      responses: {
        '202': ok('Workflow execution record, with draft provenance'),
        '200': ok('Idempotent replay of an earlier run'),
        '501': ok('Draft is not runnable: { error, analysis }'),
        '400': R_400,
        '403': R_403,
        '409': ok('Stale expectedRevision, or an idempotency conflict'),
        ...standard(['404', ok('Unknown definition, or workspace not accessible')]),
      },
    },
  },
} as const;

/**
 * Password sign-in routes. They exist ONLY when the operator sets `XO_API_PASSWORD_AUTH=1`; with it unset they are 404
 * like any unknown path. There is deliberately no registration route and no "forgot password" route: accounts and
 * recovery codes are issued by an operator with `scripts/manage-password-accounts.ts`. See docs/studio/PASSWORD_AUTH_DESIGN.md.
 */
const sessionResponse = obj({ accessCredential: str, accessExpiresAt: ts, refreshCredential: str, refreshExpiresAt: ts }, [
  'accessCredential',
  'refreshCredential',
]);
const R_429_AUTH = ok('Too many attempts. The response is identical whether or not the login name exists.');

export const passwordAuthPaths = {
  '/auth/password/login': {
    post: {
      summary: 'Sign in with a login name and password',
      description:
        'Present only when password sign-in is enabled. Every failure is the same 401 with the same body: unknown login name, wrong password, disabled account, account with no password yet, no active binding, over-long password. An unknown name costs the same work as a wrong password. Repeated failures are throttled per login name and source, per login name overall (a delay, never a lockout), and globally against credential stuffing; the correct password is not even checked while a wait is in force. The principal comes only from the operator-written binding, never from this request. The password is never logged or stored; only an Argon2id hash is.',
      security: [],
      requestBody: body(
        obj({ loginName: str, password: { type: 'string', format: 'password', maxLength: 128 } }, ['loginName', 'password']),
      ),
      responses: {
        '201': ok('A session (same shape and lifetime as Google sign-in)', sessionResponse),
        '400': R_400,
        '401': ok('login name or password is not correct'),
        '429': R_429_AUTH,
        '503': ok('Sign-in is busy (hashing queue full) or its stores are unavailable; nothing was decided'),
      },
    },
  },
  '/auth/password/setup': {
    post: {
      summary: 'Set a password with a single-use setup or reset code',
      description:
        'Present only when password sign-in is enabled. The code comes from an operator out of band (there is no email delivery and no self-service recovery). It is single-use, expires (setup 24 h, reset 30 min), is superseded by a newer code for the same account, and is invalidated by any password change. Unknown, used, expired, superseded and mismatched codes are indistinguishable (401). A password that breaks the policy is refused (400) WITHOUT spending the code. Redeeming ends every existing session of the account. No session is issued: sign in afterwards.',
      security: [],
      requestBody: body(
        obj({ token: str, newPassword: { type: 'string', format: 'password', minLength: 12, maxLength: 128 } }, ['token', 'newPassword']),
      ),
      responses: {
        '200': ok('{ passwordSet: true }'),
        '400': ok('The password breaks the policy (the message names the rule, never the password)'),
        '401': ok('this code is not valid or has expired'),
        '429': R_429_AUTH,
      },
    },
  },
  '/auth/password/change': {
    post: {
      summary: 'Change your own password (from a password session)',
      description:
        "Present only when password sign-in is enabled. Requires the CURRENT password even though the caller holds a valid session. Every session of the account — including the caller's — ends, and a fresh session is returned so the caller stays signed in on this device. Not available to API keys, OIDC bearers or Google sessions (400).",
      requestBody: body(
        obj(
          {
            currentPassword: { type: 'string', format: 'password' },
            newPassword: { type: 'string', format: 'password', minLength: 12, maxLength: 128 },
          },
          ['currentPassword', 'newPassword'],
        ),
      ),
      responses: {
        '200': ok('A fresh session', sessionResponse),
        '400': ok('Policy violation, same as the current password, or not a password session'),
        '401': ok('Not signed in, or the current password is not correct'),
        '429': R_429_AUTH,
      },
    },
  },
} as const;
