/**
 * A stateful in-memory stand-in for @xo/api, used ONLY by tests (never bundled into the app).
 * It reproduces the real wire shapes captured from a live API run (see scripts/live-smoke.mjs,
 * which checks the same shapes against the real service). It can be told to fail in the ways the
 * real platform does: 401, 501, 403, a failed compilation, invalid execution input.
 */
export interface FakeCap {
  capabilityId: string;
  name: string;
  description: string;
  status: 'resolved' | 'unresolved';
  executionClass?: string;
  reason?: string;
  confidence: number;
}

interface Body {
  name?: string;
  decision?: 'approve' | 'reject';
  compilationId: string;
  capabilityId: string;
  input: unknown;
}
interface FakeExecution {
  executionId: string;
  status: string;
  humanTask?: { status: string; decision?: string };
  [k: string]: unknown;
}

export class FakeXo {
  validKey = 'xoak_good';
  workspaces: Array<{ workspaceId: string; name: string; createdAt: string }> = [];
  sources: Array<{ sourceId: string; originalFilename: string; byteSize: number }> = [];
  compilations: Array<{
    compilationId: string;
    sourceId: string;
    status: 'succeeded' | 'failed';
    createdAt: string;
    errorMessage?: string;
    errorCode?: string;
  }> = [];
  approvals = new Set<string>();
  executions: FakeExecution[] = [];
  caps: FakeCap[] = [
    {
      capabilityId: 'cap_det',
      name: 'Record before payment',
      description: '9.5 The settlement amount must be recorded before payment authorization.',
      status: 'resolved',
      executionClass: 'deterministic_rule',
      confidence: 0.5,
    },
    {
      capabilityId: 'cap_hitl',
      name: 'Review not covered',
      description: 'Claims outside the standard rule go to a human.',
      status: 'resolved',
      executionClass: 'human_in_the_loop',
      confidence: 0.45,
    },
    {
      capabilityId: 'cap_open',
      name: 'Notify the Insurer',
      description: '4.1 The Insured must notify within 7 days.',
      status: 'unresolved',
      reason: 'structured-comparison-resolver: no executable outcome',
      confidence: 0.55,
    },
  ];
  /** Simulates a stale view: the server refuses an approval Studio's view thought was allowed. */
  approveRefusal = false;
  failNextCompile: { errorMessage: string; errorCode: string } | undefined;
  executeBehavior: 'invalid_input' | 'binding_unresolved' | 'succeed' | 'waiting_for_human' | 'unavailable' | 'forbidden' = 'invalid_input';
  calls: Array<{ method: string; path: string; body?: unknown }> = [];
  private n = 0;
  private id(p: string) {
    return `${p}_${(++this.n).toString(16).padStart(32, '0')}`;
  }

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const path = input.replace(/^\/api/, '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const raw = init?.body;
    let body = {} as Body;
    if (typeof raw === 'string') {
      try {
        body = JSON.parse(raw) as Body;
      } catch {
        /* raw */
      }
    }
    this.calls.push({ method, path: path.split('?')[0]!, ...(typeof raw === 'string' ? { body } : {}) });

    const reply = (status: number, data?: unknown) => new Response(data === undefined ? '' : JSON.stringify(data), { status });
    const err = (status: number, code: string, message: string) => reply(status, { error: { code, message } });

    if (headers['Authorization'] !== `Bearer ${this.validKey}`) return err(401, 'XO_AUTH_KEY_INVALID', 'invalid API key');

    let m: RegExpMatchArray | null;
    if (method === 'GET' && path === '/workspaces') return reply(200, { workspaces: this.workspaces });
    if (method === 'POST' && path === '/workspaces') {
      const w = { workspaceId: this.id('ws'), name: body.name ?? '', createdAt: new Date().toISOString() };
      this.workspaces.push(w);
      return reply(201, w);
    }
    if (method === 'GET' && (m = path.match(/^\/workspaces\/[^/]+\/sources$/)))
      return reply(200, {
        sources: this.sources.map((s) => ({
          ...s,
          mediaType: 'application/pdf',
          digestSha256: 'ab'.repeat(32),
          createdAt: '2026-10-10T10:00:00Z',
        })),
      });
    if (method === 'POST' && (m = path.match(/^\/workspaces\/[^/]+\/sources\?filename=(.+)$/))) {
      const s = { sourceId: this.id('src'), originalFilename: decodeURIComponent(m[1]!), byteSize: 1234 };
      this.sources.push(s);
      return reply(201, { ...s, mediaType: 'application/pdf', digestSha256: 'ab'.repeat(32), createdAt: '2026-10-10T10:00:00Z' });
    }
    if (method === 'POST' && (m = path.match(/^\/workspaces\/[^/]+\/sources\/([^/]+)\/compile$/))) {
      const failing = this.failNextCompile;
      this.failNextCompile = undefined;
      const c = {
        compilationId: this.id('cmp'),
        sourceId: m[1]!,
        status: failing ? ('failed' as const) : ('succeeded' as const),
        createdAt: new Date().toISOString(),
        ...(failing ?? {}),
      };
      this.compilations.push(c);
      return reply(failing ? 200 : 201, { ...c, sourceDigestSha256: 'ab'.repeat(32), completedAt: c.createdAt });
    }
    if (method === 'GET' && path.endsWith('/compilations'))
      return reply(200, {
        compilations: this.compilations.map((c) => ({ ...c, sourceDigestSha256: 'ab'.repeat(32), completedAt: c.createdAt })),
      });
    if (method === 'GET' && (m = path.match(/^\/workspaces\/[^/]+\/compilations\/([^/]+)\/capabilities$/))) {
      const cid = m[1]!;
      return reply(200, {
        compilationId: cid,
        capabilities: this.caps.map((c) => ({
          ...c,
          contractId: c.capabilityId,
          provenance: [{ documentPath: 'src', pages: [2] }],
          approved: this.approvals.has(`${cid}:${c.capabilityId}`),
        })),
      });
    }
    if (method === 'POST' && (m = path.match(/^\/workspaces\/[^/]+\/compilations\/([^/]+)\/capabilities\/([^/]+)\/approve$/))) {
      const target = this.caps.find((c) => c.capabilityId === m![2]);
      if (this.approveRefusal || target?.status === 'unresolved')
        return err(
          422,
          'XO_BINDING_UNRESOLVED',
          `capability "${m[2]}" cannot be approved: its binding status is "unresolved", so it cannot be carried out.`,
        );
      this.approvals.add(`${m[1]}:${m[2]}`);
      return reply(200, { compilationId: m[1], capabilityId: m[2], status: 'approved', approvedAt: new Date().toISOString() });
    }
    if (method === 'GET' && path.endsWith('/executions')) return reply(200, { executions: this.executions });
    if (method === 'POST' && path.endsWith('/executions')) {
      if (this.executeBehavior === 'unavailable') return err(501, 'XO_UNIMPLEMENTED', 'AI execution is disabled');
      if (this.executeBehavior === 'forbidden') return err(403, 'XO_RUNTIME_PERMISSION_DENIED', 'not allowed');
      if (!this.approvals.has(`${body.compilationId}:${body.capabilityId}`))
        return err(403, 'XO_RUNTIME_PERMISSION_DENIED', 'capability is not approved');
      const base = {
        executionId: this.id('exe'),
        compilationId: body.compilationId,
        capabilityId: body.capabilityId,
        requestedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        input: body.input,
        initiator: { kind: 'human', id: 'sally' },
      };
      const rec =
        this.executeBehavior === 'binding_unresolved'
          ? { ...base, status: 'failed', errorCode: 'XO_BINDING_UNRESOLVED', errorMessage: 'capability could not be bound' }
          : this.executeBehavior === 'invalid_input'
            ? {
                ...base,
                status: 'failed',
                errorCode: 'XO_RUNTIME_CAPABILITY_INPUT_INVALID',
                errorMessage:
                  'input validation failed: claim: missing required property; lossadjuster_assessment: missing required property',
              }
            : this.executeBehavior === 'waiting_for_human'
              ? { ...base, status: 'waiting_for_human', output: { escalated: true }, humanTask: { status: 'pending' } }
              : { ...base, status: 'succeeded', output: { result: 'ok' } };
      this.executions.push(rec);
      return reply(rec.status === 'failed' ? 200 : 201, rec);
    }
    if (method === 'POST' && (m = path.match(/^\/workspaces\/[^/]+\/executions\/([^/]+)\/resolve$/))) {
      const e = this.executions.find((x) => x.executionId === m![1]);
      if (!e) return err(404, 'XO_NOT_FOUND', 'no such execution');
      e.humanTask = { status: 'resolved', decision: body.decision };
      e.status = body.decision === 'approve' ? 'succeeded' : 'rejected';
      return reply(200, e);
    }
    if (method === 'GET' && path.endsWith('/workflows'))
      return reply(200, {
        workflows: [
          {
            workflowId: 'wf_1',
            compilationId: 'c',
            name: 'Review not covered',
            description: 'd',
            status: 'executable_candidate',
            executable: true,
            notExecutableReasons: [],
            blockers: [],
            requiresHumanDecision: false,
            confidence: 0.45,
            gaps: [],
            steps: [{}],
          },
        ],
      });
    return err(404, 'XO_NOT_FOUND', `no route ${method} ${path}`);
  };
}
