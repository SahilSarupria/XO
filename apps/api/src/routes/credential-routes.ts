/**
 * UW-9 (ADR 0036, UAC-14) — connection credentials over HTTP.
 *
 *   GET  /workspaces/:ws/credentials                    list (author role): no secret, ever
 *   GET  /workspaces/:ws/credentials/providers          what can be connected here, and exactly which scopes each capability asks for
 *   POST /workspaces/:ws/credentials/oauth              start a consent (manage role, recent sign-in): returns the provider URL
 *   GET  /oauth/callback                                the provider sends the person back here (no API key: the state is the binding)
 *   POST /workspaces/:ws/credentials/basic              a user name and app password for a server without OAuth (manage, recent sign-in)
 *   POST /workspaces/:ws/credentials/:id/rotate         a new password for a basic credential (manage, recent sign-in)
 *   POST /workspaces/:ws/credentials/:id/revoke         revoke at the provider when possible, destroy here always (manage, recent sign-in)
 *
 * The callback trusts nothing in its query but the state, which is unguessable (32 random bytes), single-use (claimed by an
 * atomic rename), expires in 10 minutes and names, server-side, the workspace, the person who started it and what they asked for.
 * The person must still hold the manage role when the consent completes.
 */
import { actorFromPrincipal } from '@xo/audit';
import {
  CredentialError,
  OAUTH_CAPABILITIES,
  OAUTH_PROVIDERS,
  OAuthError,
  accountOf,
  allowlistProblem,
  authorizationUrl,
  checkGrantedScopes,
  exchangeCode,
  newPkce,
  newState,
  requestedScopes,
  type CredentialPublic,
  type OAuthCapability,
} from '@xo/connectors';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { establishAuthenticatedPrincipal } from '@xo/permissions';
import type { AuditService } from '../audit/audit-service.js';
import { auditedOwnedWorkspace, newCorrelationId } from '../audit/audit-service.js';
import { requireRecentAuthentication } from '../auth/step-up.js';
import {
  claimPending,
  OAUTH_CALLBACK_PATH,
  PENDING_TTL_MS,
  requireCredentials,
  savePending,
  workspaceBroker,
  type CredentialsConfig,
} from '../credentials/credentials.js';
import { errorToResponse } from '../http/error-mapping.js';
import type { Router } from '../http/router.js';
import { json, type ApiRequest, type ApiResponse } from '../http/types.js';
import { roleAllows } from '../workspace/permissions.js';
import { requireOwnedWorkspace, requirePermission, requirePrincipal, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import { roleOf, type WorkspaceStore } from '../workspace/workspace.js';

const BASIC_PROVIDERS = ['smtp', 'imap'] as const;
const BASIC_CAPABILITIES = ['message.send', 'message.read'] as const;

/** Credentials as the API shows them: never a secret; the account label only to the workspace's own members. */
export function credentialView(c: CredentialPublic): Record<string, unknown> {
  return {
    credentialId: c.credentialId,
    kind: c.kind,
    provider: c.provider,
    capabilities: c.capabilities,
    scopes: c.scopes,
    ...(c.accountLabel !== undefined ? { accountLabel: c.accountLabel } : {}),
    ...(c.username !== undefined ? { username: c.username } : {}),
    ...(c.host !== undefined ? { host: c.host } : {}),
    state: c.state,
    createdAt: c.createdAt,
    createdBy: c.createdBy,
    updatedAt: c.updatedAt,
    ...(c.accessExpiresAt !== undefined ? { accessExpiresAt: c.accessExpiresAt } : {}),
    ...(c.endedAt !== undefined ? { endedAt: c.endedAt, endedReason: c.endedReason } : {}),
  };
}

const page = (status: number, title: string, text: string): ApiResponse => {
  const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return {
    status,
    body: Buffer.from(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><h1>${esc(title)}</h1><p>${esc(text)}</p></body></html>`,
    ),
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'",
      'referrer-policy': 'no-referrer',
    },
  };
};

export function registerCredentialRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  audit: AuditService,
  credentials: () => Promise<CredentialsConfig | undefined>,
): void {
  const auditCtx = { audit, workspaceStore };
  const config = async (): Promise<CredentialsConfig> => requireCredentials(await credentials());
  const guarded =
    (h: (req: ApiRequest) => Promise<ApiResponse>) =>
    async (req: ApiRequest): Promise<ApiResponse> => {
      try {
        return await h(req);
      } catch (e) {
        if (e instanceof CredentialError) {
          if (e.code === 'not_found') return errorToResponse(new NotFoundError(e.message));
          if (e.code === 'not_active' || e.code === 'kind_mismatch')
            return errorToResponse(new XoError(ErrorCode.CREDENTIAL_NOT_ACTIVE, e.message));
          return errorToResponse(new XoError(ErrorCode.PRECONDITION_FAILED, e.message));
        }
        throw e;
      }
    };
  const bodyOf = async (req: ApiRequest, allowed: readonly string[]): Promise<Record<string, unknown>> => {
    const b = await req.json<Record<string, unknown>>();
    if (!b.ok) throw b.error;
    if (typeof b.value !== 'object' || b.value === null || Array.isArray(b.value))
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'the body must be an object');
    const extra = Object.keys(b.value).filter((k) => !allowed.includes(k));
    if (extra.length > 0) throw new XoError(ErrorCode.INVALID_ARGUMENT, `unknown field(s): ${extra.join(', ')}`);
    return b.value;
  };
  const capabilitiesOf = <T extends string>(v: unknown, allowed: readonly T[]): T[] => {
    if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string' || !(allowed as readonly string[]).includes(x)))
      throw new XoError(ErrorCode.INVALID_ARGUMENT, `"capabilities" must be a non-empty list of ${allowed.join(', ')}`);
    return [...new Set(v as T[])];
  };
  const manage = async (req: ApiRequest, action: string) => {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action, correlationId });
    await requirePermission(req, workspace, 'manage', dataConfig, { action });
    await requireRecentAuthentication(req, workspace, dataConfig, action);
    return { workspace, correlationId, principal: requirePrincipal(req) };
  };

  router.get(
    '/workspaces/:workspaceId/credentials',
    guarded(async (req) => {
      const workspace = await requireOwnedWorkspace(req, workspaceStore);
      await requirePermission(req, workspace, 'author', dataConfig, { action: 'list connections' });
      const list = await workspaceBroker(workspace, dataConfig.dataRootDir, await config()).list();
      return json(200, { credentials: list.map(credentialView) });
    }),
  );

  router.get(
    '/workspaces/:workspaceId/credentials/providers',
    guarded(async (req) => {
      await requireOwnedWorkspace(req, workspaceStore);
      const c = await config();
      return json(200, {
        redirectUri: c.redirectUri,
        oauth: Object.values(OAUTH_PROVIDERS).map((p) => ({
          provider: p.id,
          displayName: p.displayName,
          configured: c.clients[p.id] !== undefined,
          capabilities: OAUTH_CAPABILITIES.map((cap) => ({ capability: cap, scopes: requestedScopes(p, [cap]) })),
          providerRevocation: p.revokeUrl !== undefined,
        })),
        basic: BASIC_PROVIDERS.map((p) => ({ provider: p, capabilities: [...BASIC_CAPABILITIES] })),
      });
    }),
  );

  router.post(
    '/workspaces/:workspaceId/credentials/oauth',
    guarded(async (req) => {
      const { workspace, correlationId, principal } = await manage(req, 'credential.connect');
      const c = await config();
      const b = await bodyOf(req, ['provider', 'capabilities', 'loginHint']);
      const provider = typeof b['provider'] === 'string' ? OAUTH_PROVIDERS[b['provider'] as 'google' | 'microsoft'] : undefined;
      if (provider === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, '"provider" must be google or microsoft');
      const client = c.clients[provider.id];
      if (client === undefined)
        throw new XoError(
          ErrorCode.CREDENTIALS_NOT_CONFIGURED,
          `no ${provider.displayName} OAuth client is configured on this instance (XO_OAUTH_${provider.id.toUpperCase()}_CLIENT_ID)`,
        );
      const capabilities = capabilitiesOf<OAuthCapability>(b['capabilities'], OAUTH_CAPABILITIES);
      const loginHint = typeof b['loginHint'] === 'string' && b['loginHint'].length <= 320 ? b['loginHint'] : undefined;
      const scopes = requestedScopes(provider, capabilities);
      const pkce = newPkce();
      const state = newState();
      const expiresAt = new Date(Date.now() + PENDING_TTL_MS).toISOString();
      await savePending(dataConfig.dataRootDir, c, state, {
        workspaceId: workspace.workspaceId,
        startedBy: { kind: principal.kind, id: principal.id },
        provider: provider.id,
        capabilities,
        scopes,
        redirectUri: c.redirectUri,
        expiresAt,
        codeVerifier: pkce.verifier,
      });
      await audit.tryRecord({
        action: 'credential.connect',
        actor: actorFromPrincipal(principal),
        correlationId,
        target: { kind: 'workspace', id: workspace.workspaceId },
        type: 'credential.oauth.started',
        outcome: 'completed',
        metadata: { provider: provider.id, capabilities: capabilities.join(',') },
      });
      return json(201, {
        authorizationUrl: authorizationUrl(provider, client, {
          redirectUri: c.redirectUri,
          state,
          codeChallenge: pkce.challenge,
          scopes,
          ...(loginHint !== undefined ? { loginHint } : {}),
        }),
        provider: provider.id,
        scopes,
        expiresAt,
      });
    }),
  );

  router.get(OAUTH_CALLBACK_PATH, async (req) => {
    let c: CredentialsConfig;
    try {
      c = await config();
    } catch {
      return page(
        503,
        'Connections are not configured',
        'This XO instance cannot store connections yet. Ask its operator to set XO_CREDENTIALS_KEY.',
      );
    }
    const state = req.query.get('state') ?? '';
    const pending = await claimPending(dataConfig.dataRootDir, c, state);
    if (pending === undefined || Date.parse(pending.expiresAt) < Date.now())
      return page(
        400,
        'This link has expired',
        'The connection request is unknown, already used or more than ten minutes old. Start again from XO.',
      );
    const provider = OAUTH_PROVIDERS[pending.provider];
    const client = c.clients[pending.provider];
    const who = establishAuthenticatedPrincipal(pending.startedBy);
    const workspace = await workspaceStore.get(pending.workspaceId).then((r) => (r.ok ? r.value : undefined));
    const fail = async (reason: string, status: number, text: string): Promise<ApiResponse> => {
      if (workspace !== undefined && who.ok)
        await audit.tryRecord({
          action: 'credential.connect',
          actor: actorFromPrincipal(who.value),
          correlationId: newCorrelationId(),
          target: { kind: 'workspace', id: workspace.workspaceId },
          type: 'credential.oauth.failed',
          outcome: 'denied',
          reasonCode: reason,
          metadata: { provider: pending.provider },
        });
      return page(status, 'The account was not connected', text);
    };
    if (workspace === undefined || !who.ok || client === undefined)
      return fail('workspace_or_client_gone', 409, 'The workspace or the provider configuration is gone.');
    // The person must still be allowed to connect accounts now, not only when they started.
    const role = roleOf(workspace, pending.startedBy.id);
    if (role === undefined || !roleAllows(role, 'manage')) return fail('not_allowed', 403, 'You no longer manage this workspace.');
    const iss = req.query.get('iss');
    if (
      iss !== null &&
      !(pending.provider === 'google' ? iss === 'https://accounts.google.com' : iss.startsWith('https://login.microsoftonline.com/'))
    )
      return fail('issuer_mismatch', 400, 'The answer did not come from the provider this request went to.');
    const error = req.query.get('error');
    if (error !== null)
      return fail(
        `provider_${/^[a-z_]{1,40}$/.test(error) ? error : 'error'}`,
        400,
        `${provider.displayName} did not grant access (${/^[a-z_]{1,40}$/.test(error) ? error : 'error'}). Nothing was stored.`,
      );
    const code = req.query.get('code');
    if (code === null || code === '' || code.length > 4096) return fail('no_code', 400, 'The provider sent no authorization code.');
    let tokens;
    let account;
    try {
      tokens = await exchangeCode(
        provider,
        client,
        { code, codeVerifier: pending.codeVerifier, redirectUri: pending.redirectUri },
        c.oauth ?? {},
      );
      account = accountOf(provider, client, tokens);
    } catch (e) {
      return fail(
        e instanceof OAuthError ? e.code : 'exchange_failed',
        502,
        `${provider.displayName} did not complete the connection${e instanceof OAuthError ? ` (${e.code})` : ''}. Nothing was stored.`,
      );
    }
    // UAC-14: what was granted covers what was asked for, and no more. A provider that does not report scopes is held to the request.
    const verdict = checkGrantedScopes(provider, pending.scopes, tokens.scopes ?? pending.scopes);
    if (!verdict.ok)
      return fail(
        verdict.missing.length > 0 ? 'scope_missing' : 'scope_exceeds_request',
        422,
        verdict.missing.length > 0
          ? `Access was granted without ${verdict.missing.join(', ')}, which XO needs. Nothing was stored; connect again and allow it.`
          : `${provider.displayName} granted more than XO asked for (${verdict.extra.join(', ')}). Nothing was stored; remove the extra permission from the app or the account's consent and connect again.`,
      );
    const broker = workspaceBroker(workspace, dataConfig.dataRootDir, c, audit);
    let stored: CredentialPublic;
    try {
      stored = await broker.storeOAuth({
        provider: provider.id,
        capabilities: pending.capabilities,
        scopes: verdict.granted,
        account,
        tokens,
        by: { kind: pending.startedBy.kind, id: pending.startedBy.id },
      });
    } catch (e) {
      return fail(
        'not_stored',
        422,
        e instanceof CredentialError ? `${e.message}. Nothing was stored.` : 'The connection could not be stored.',
      );
    }
    await audit.tryRecord({
      action: 'credential.connect',
      actor: actorFromPrincipal(who.value),
      correlationId: newCorrelationId(),
      target: { kind: 'credential', id: stored.credentialId, workspaceId: workspace.workspaceId },
      type: 'credential.created',
      outcome: 'completed',
      metadata: {
        provider: provider.id,
        capabilities: pending.capabilities.join(','),
        scopes: verdict.granted.join(' '),
        // The audit validator refuses long opaque strings (a full digest reads as a secret): 16 hex characters identify the account.
        ...(stored.accountRef !== undefined ? { accountRef: stored.accountRef.slice(0, 'sha256:'.length + 16) } : {}),
      },
    });
    return page(
      200,
      'Account connected',
      `${account.label ?? 'The account'} is connected to XO for ${pending.capabilities.join(', ')}. You can close this window.`,
    );
  });

  router.post(
    '/workspaces/:workspaceId/credentials/basic',
    guarded(async (req) => {
      const { workspace, correlationId, principal } = await manage(req, 'credential.add_password');
      const b = await bodyOf(req, ['provider', 'capabilities', 'username', 'host', 'password', 'label']);
      if (!(BASIC_PROVIDERS as readonly unknown[]).includes(b['provider']))
        throw new XoError(ErrorCode.INVALID_ARGUMENT, `"provider" must be ${BASIC_PROVIDERS.join(' or ')}`);
      const capabilities = capabilitiesOf(b['capabilities'], BASIC_CAPABILITIES);
      const str = (k: string, max: number): string => {
        const v = b[k];
        if (typeof v !== 'string' || v.trim() === '' || v.length > max)
          throw new XoError(ErrorCode.INVALID_ARGUMENT, `"${k}" must be a non-empty string of at most ${max} characters`);
        return v;
      };
      const host = str('host', 253).toLowerCase();
      const hostProblem = allowlistProblem(host);
      if (hostProblem !== undefined || host.startsWith('*.'))
        throw new XoError(ErrorCode.INVALID_ARGUMENT, `"host" is not a server name: ${hostProblem ?? 'a wildcard'}`);
      const broker = workspaceBroker(workspace, dataConfig.dataRootDir, await config(), audit);
      const stored = await broker.storeBasic({
        provider: b['provider'] as string,
        capabilities,
        username: str('username', 320),
        host,
        password: str('password', 1024),
        ...(typeof b['label'] === 'string' && b['label'].length <= 200 ? { label: b['label'] } : {}),
        by: { kind: principal.kind, id: principal.id },
      });
      await audit.tryRecord({
        action: 'credential.add_password',
        actor: actorFromPrincipal(principal),
        correlationId,
        target: { kind: 'credential', id: stored.credentialId, workspaceId: workspace.workspaceId },
        type: 'credential.created',
        outcome: 'completed',
        metadata: { provider: stored.provider, capabilities: capabilities.join(','), kind: 'basic' },
      });
      return json(201, { credential: credentialView(stored) });
    }),
  );

  router.post(
    '/workspaces/:workspaceId/credentials/:credentialId/rotate',
    guarded(async (req) => {
      const { workspace, correlationId, principal } = await manage(req, 'credential.rotate');
      const b = await bodyOf(req, ['password']);
      if (typeof b['password'] !== 'string' || b['password'] === '' || b['password'].length > 1024)
        throw new XoError(ErrorCode.INVALID_ARGUMENT, '"password" must be a non-empty string');
      const id = req.params['credentialId'] ?? '';
      const next = await workspaceBroker(workspace, dataConfig.dataRootDir, await config(), audit).rotateBasic(id, b['password'], {
        kind: principal.kind,
        id: principal.id,
      });
      await audit.tryRecord({
        action: 'credential.rotate',
        actor: actorFromPrincipal(principal),
        correlationId,
        target: { kind: 'credential', id, workspaceId: workspace.workspaceId },
        type: 'credential.rotated',
        outcome: 'completed',
        metadata: { provider: next.provider },
      });
      return json(200, { credential: credentialView(next) });
    }),
  );

  router.post(
    '/workspaces/:workspaceId/credentials/:credentialId/revoke',
    guarded(async (req) => {
      const { workspace, correlationId, principal } = await manage(req, 'credential.revoke');
      const id = req.params['credentialId'] ?? '';
      const r = await workspaceBroker(workspace, dataConfig.dataRootDir, await config(), audit).revoke(id, {
        kind: principal.kind,
        id: principal.id,
      });
      await audit.tryRecord({
        action: 'credential.revoke',
        actor: actorFromPrincipal(principal),
        correlationId,
        target: { kind: 'credential', id, workspaceId: workspace.workspaceId },
        type: 'credential.revoked',
        outcome: 'completed',
        metadata: { provider: r.credential.provider, providerRevocation: r.providerRevocation },
      });
      return json(200, { credential: credentialView(r.credential), providerRevocation: r.providerRevocation });
    }),
  );
}
