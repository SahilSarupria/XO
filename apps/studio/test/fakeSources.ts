/**
 * A fake of the workspace source-connection API (docs/SOURCE_CONNECTIONS.md) and the slice of the credentials API Studio uses, for
 * Studio tests. It answers in the platform's JSON; anything else goes to the wrapped fetch.
 */
type Json = Record<string, unknown>;

export class FakeSources {
  connections: Json[] = [];
  accounts: Json[] = [];
  calls: Array<{ method: string; path: string; body?: Json }> = [];
  options: Json = {
    localFolder: { available: false },
    drives: [
      {
        provider: 'microsoft',
        kind: 'microsoft_drive',
        displayName: 'OneDrive or SharePoint',
        available: false,
        reason: 'provider_not_configured',
      },
      { provider: 'google', kind: 'google_drive', displayName: 'Google Drive', available: true },
    ],
    agent: { available: true, serverAddress: 'https://xo.acme.example' },
  };
  /** Set to make every source-connection route answer 404 (a server without source connections). */
  absent = false;
  private n = 0;
  private codes = 0;

  constructor(private readonly inner: (input: string, init?: RequestInit) => Promise<Response>) {}

  /** What the agent does on the computer once it pairs and sends the folder. */
  agentPairs(connectionId: string, label = 'office-pc'): void {
    const c = this.find(connectionId)!;
    c['displayName'] = 'Renewals';
    c['agent'] = { paired: true, label, platform: 'darwin', pairedAt: '2026-11-17T09:00:00Z', lastSeenAt: '2026-11-17T09:00:05Z' };
    c['items'] = [{ key: 'clients.csv', name: 'clients.csv', extension: '.csv', sizeBytes: 120, modifiedAt: '2026-11-16T10:00:00Z' }];
    c['lastSync'] = this.report({ added: 1, skipped: { hidden: 1 } });
    c['freshness'] = { state: 'current', asOf: '2026-11-17T09:00:05Z' };
    this.bump(c);
  }

  /** The person allowed access at the provider. */
  consentCompletes(provider: 'google' | 'microsoft'): void {
    this.accounts.push({
      credentialId: `crd_${'a'.repeat(23)}${this.accounts.length}`,
      kind: 'oauth',
      provider,
      capabilities: ['files.read'],
      scopes: ['openid', 'email'],
      accountLabel: 'ops@acme.example',
      state: 'active',
      createdAt: '2026-11-17T09:00:00Z',
    });
  }

  private find(id: string): Json | undefined {
    return this.connections.find((c) => c['connectionId'] === id);
  }
  private bump(c: Json): void {
    c['revision'] = (c['revision'] as number) + 1;
  }
  private report(o: Partial<{ added: number; changed: number; removed: number; skipped: Json }> = {}): Json {
    return {
      at: '2026-11-17T09:00:05Z',
      outcome: 'complete',
      added: 0,
      changed: 0,
      unchanged: 0,
      removed: 0,
      failed: {},
      skipped: {},
      ...o,
    };
  }
  private detail(c: Json): Json {
    return { ...c, files: (c['items'] as unknown[]).length };
  }
  private create(kind: string, displayName: string, extra: Json = {}): Json {
    const c: Json = {
      connectionId: `scn_${(++this.n).toString(16).padStart(24, '0')}`,
      kind,
      displayName,
      sync: { mode: 'manual' },
      paused: false,
      freshness: { state: 'never_synced' },
      createdAt: '2026-11-17T09:00:00Z',
      createdBy: 'sally',
      revision: 1,
      updatedAt: '2026-11-17T09:00:00Z',
      items: [],
      retired: [],
      proposals: [],
      ...extra,
    };
    this.connections.push(c);
    return c;
  }
  private pairing(c: Json): Json {
    const code = `ABCD-EFGH-JKMN-PQ${(++this.codes).toString().padStart(2, '2')}`;
    const expiresAt = '2026-11-17T09:15:00Z';
    c['agent'] = { paired: false, pairingExpiresAt: expiresAt };
    return {
      code,
      expiresAt,
      command: `xo agent pair --server https://xo.acme.example --code ${code} --folder <the folder on your computer>`,
    };
  }

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const full = input.replace(/^\/api/, '');
    const path = full.split('?')[0]!;
    const query = new URLSearchParams(full.includes('?') ? full.slice(full.indexOf('?') + 1) : '');
    const body = typeof init?.body === 'string' && init.body.length > 0 ? (JSON.parse(init.body) as Json) : {};
    const reply = (status: number, data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status }));
    const err = (status: number, code: string, message: string) => reply(status, { error: { code, message } });
    let m: RegExpMatchArray | null;

    if ((m = path.match(/^\/workspaces\/[^/]+\/credentials(\/.*)?$/))) {
      this.calls.push({ method, path, ...(method !== 'GET' ? { body } : {}) });
      if (method === 'GET' && m[1] === undefined) return reply(200, { credentials: this.accounts });
      if (method === 'POST' && m[1] === '/oauth') {
        const host =
          body['provider'] === 'microsoft'
            ? 'login.microsoftonline.com/common/oauth2/v2.0/authorize'
            : 'accounts.google.com/o/oauth2/v2/auth';
        return reply(201, {
          authorizationUrl: `https://${host}?state=s1&scope=openid`,
          provider: body['provider'],
          scopes: ['openid', 'email'],
          expiresAt: '2026-11-17T09:10:00Z',
        });
      }
    }
    if (!(m = path.match(/^\/workspaces\/[^/]+\/source-connections(\/.*)?$/))) return this.inner(input, init);
    this.calls.push({ method, path, ...(method !== 'GET' ? { body } : {}) });
    if (this.absent) return err(404, 'XO_NOT_FOUND', `no route ${method} ${path}`);
    const rest = m[1] ?? '';

    if (method === 'GET' && rest === '/options') return reply(200, this.options);
    if (method === 'GET' && rest === '')
      return reply(200, { connections: this.connections.filter((c) => c['retiredAt'] === undefined).map((c) => this.detail(c)) });
    if (method === 'GET' && rest === '/drive-folders') {
      const parent = query.get('parent');
      if (parent === null) return reply(200, { folders: [{ ref: 'root', name: 'My Drive', kind: 'drive' }] });
      if (parent === 'root') return reply(200, { folders: [{ ref: 'fld1', name: 'Renewals', kind: 'folder' }] });
      return reply(200, { folders: [] });
    }
    if (method === 'POST' && rest === '') {
      const kind = body['kind'];
      if (kind === 'agent_folder') {
        const c = this.create('agent_folder', 'Folder on a computer (not paired yet)', {
          freshness: { state: 'needs_attention', problem: 'waiting for the agent on the computer to be paired' },
        });
        return reply(201, { connection: this.detail(c), pairing: this.pairing(c) });
      }
      if (kind === 'google_drive' || kind === 'microsoft_drive') {
        const c = this.create(kind, 'Renewals', {
          remote: { provider: kind === 'google_drive' ? 'google' : 'microsoft', credentialId: body['credentialId'] },
          items: [
            { key: 'clients.csv', name: 'clients.csv', extension: '.csv', sizeBytes: 120, modifiedAt: '2026-11-16T10:00:00Z' },
            {
              key: 'Certificates/Asha Rao.pdf',
              name: 'Asha Rao.pdf',
              extension: '.pdf',
              sizeBytes: 30,
              modifiedAt: '2026-11-16T10:00:00Z',
            },
          ],
          lastSync: this.report({ added: 2, skipped: { shortcut_not_followed: 1 } }),
          freshness: { state: 'current', asOf: '2026-11-17T09:00:05Z' },
          proposals: [
            {
              proposalId: 'rol_a',
              role: 'contact_list',
              label: 'a client list',
              basis: ['2 rows, each a client'],
              strength: 'strong',
              status: 'proposed',
            },
          ],
        });
        return reply(201, { connection: this.detail(c) });
      }
      if (kind === 'local_folder') {
        if (typeof body['root'] !== 'string' || !body['root'].startsWith('/srv/'))
          return err(412, 'XO_PRECONDITION_FAILED', 'the folder is not inside a folder this instance allows');
        const c = this.create('local_folder', String(body['root']).split('/').at(-1)!, {
          lastSync: this.report(),
          freshness: { state: 'current', asOf: '2026-11-17T09:00:05Z' },
        });
        return reply(201, { connection: this.detail(c) });
      }
      return err(400, 'XO_INVALID_ARGUMENT', 'bad kind');
    }
    const one = rest.match(/^\/(scn_[0-9a-f]{24})(\/.*)?$/);
    if (one === null) return err(404, 'XO_NOT_FOUND', 'no such route');
    const c = this.find(one[1]!);
    if (c === undefined) return err(404, 'XO_NOT_FOUND', 'no such connection');
    const action = one[2] ?? '';
    if (method === 'GET' && action === '') return reply(200, { connection: this.detail(c) });
    if (method === 'POST' && action === '/sync') {
      if (c['kind'] === 'agent_folder') {
        if ((c['agent'] as Json | undefined)?.['paired'] !== true)
          return err(412, 'XO_PRECONDITION_FAILED', 'the agent on the computer is not paired yet');
        c['agent'] = { ...(c['agent'] as Json), syncRequestedAt: '2026-11-17T09:30:00Z' };
        this.bump(c);
        return reply(202, { connection: this.detail(c) });
      }
      c['lastSync'] = this.report();
      this.bump(c);
      return reply(200, { connection: this.detail(c) });
    }
    if (method === 'POST' && (action === '/pause' || action === '/resume')) {
      c['paused'] = action === '/pause';
      c['freshness'] = action === '/pause' ? { state: 'paused' } : { state: 'current', asOf: '2026-11-17T09:00:05Z' };
      this.bump(c);
      return reply(200, { connection: this.detail(c) });
    }
    if (method === 'PUT' && action === '/schedule') {
      c['sync'] = body['sync'];
      this.bump(c);
      return reply(200, { connection: this.detail(c) });
    }
    if (method === 'POST' && action === '/retire') {
      c['retiredAt'] = '2026-11-17T10:00:00Z';
      c['freshness'] = { state: 'retired', at: '2026-11-17T10:00:00Z' };
      this.bump(c);
      return reply(200, { connection: this.detail(c) });
    }
    if (method === 'POST' && action === '/agent/pair') {
      const p = this.pairing(c);
      this.bump(c);
      return reply(200, { connection: this.detail(c), pairing: p });
    }
    if (method === 'POST' && (m = action.match(/^\/proposals\/([^/]+)\/decision$/))) {
      c['proposals'] = (c['proposals'] as Json[]).map((p) => (p['proposalId'] === m![1] ? { ...p, status: body['decision'] } : p));
      this.bump(c);
      return reply(200, { connection: this.detail(c) });
    }
    return err(404, 'XO_NOT_FOUND', 'no such route');
  };
}
