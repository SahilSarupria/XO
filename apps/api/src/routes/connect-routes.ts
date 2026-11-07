import type { ConnectError, ConnectResult, ConnectService } from '@xo/connect';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { requirePrincipal } from '../workspace/workspace-context.js';

/**
 * C7 Connect routes. Additive and thin: every handler establishes the caller from `req.principal` (set by the auth middleware, never
 * from the body), delegates to `@xo/connect`, and maps its result. No business logic, authorization or scope checks live here; they
 * are in `@xo/connect` and in the platform gate behind it. See packages/connect/docs/HTTP_CONTRACT.md.
 */
const STATUS: Readonly<Record<ConnectError['code'], number>> = {
  unauthenticated: 401,
  denied: 403,
  not_found: 404,
  conflict: 409,
  invalid_request: 400,
  limit_exceeded: 422,
  unavailable: 503,
  internal: 500,
};

function respond<T>(result: ConnectResult<T>, status = 200): ApiResponse {
  if (result.ok) return json(status, result.value);
  return json(STATUS[result.error.code], { error: result.error });
}

async function body(
  req: ApiRequest,
): Promise<{ readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly response: ApiResponse }> {
  const parsed = await req.json<unknown>();
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value))
    return {
      ok: false,
      response: json(400, { error: { code: 'invalid_request', message: 'the request body must be a JSON object', retryable: false } }),
    };
  return { ok: true, value: parsed.value as Record<string, unknown> };
}

/** Untrusted body value passed through as-is; `@xo/connect` validates type and bounds. Absent stays absent. */
const names = (v: Record<string, unknown>): { excludedNames?: string[] } =>
  v['excludedNames'] === undefined ? {} : { excludedNames: v['excludedNames'] as string[] };

export function registerConnectRoutes(router: Router, connect: ConnectService): void {
  router.get('/connect/catalog', async () => json(200, { sources: connect.catalog() }));

  router.get('/connect/capabilities', async (req) => respond(await connect.capabilities(requirePrincipal(req))));

  /**
   * C7.3. Read-only, delegated to the C6 SDK unchanged. `q` is keyword text (C6 does not interpret questions); `select` is a structured
   * selector instead (entities | relationships | claims | conflicts | documents). Exactly one of them.
   */
  router.get('/connect/knowledge', async (req) => {
    const principal = requirePrincipal(req);
    const q = req.query.get('q');
    const select = req.query.get('select');
    if ((q === null) === (select === null))
      return json(400, { error: { code: 'invalid_request', message: 'give exactly one of q or select', retryable: false } });
    const limitRaw = req.query.get('limit');
    const limit = limitRaw === null ? undefined : Number(limitRaw);
    if (limit !== undefined && !Number.isSafeInteger(limit))
      return json(400, { error: { code: 'invalid_request', message: 'limit must be an integer', retryable: false } });
    const asOf = req.query.get('asOf');
    return respond(
      await connect.searchKnowledge(principal, {
        query: q !== null ? q : ({ select } as never),
        ...(limit !== undefined ? { limit } : {}),
        ...(asOf !== null ? { asOf } : {}),
      }),
    );
  });

  router.get('/connect/knowledge/review', async (req) => {
    const asOf = req.query.get('asOf');
    return respond(await connect.knowledgeReviewQueue(requirePrincipal(req), asOf ?? undefined));
  });

  router.get('/connect/dashboard', async (req) => respond(await connect.dashboard(requirePrincipal(req))));

  router.get('/connect/sources', async (req) => {
    const r = await connect.listSources(requirePrincipal(req));
    return r.ok ? json(200, { sources: r.value }) : respond(r);
  });

  router.get('/connect/sources/:id', async (req) => respond(await connect.getSource(requirePrincipal(req), req.params['id'] ?? '')));

  router.post('/connect/local-folders/preview', async (req) => {
    const principal = requirePrincipal(req);
    const b = await body(req);
    if (!b.ok) return b.response;
    return respond(await connect.previewFolder(principal, { root: b.value['root'] as string, ...names(b.value) }));
  });

  router.post('/connect/local-folders', async (req) => {
    const principal = requirePrincipal(req);
    const b = await body(req);
    if (!b.ok) return b.response;
    return respond(
      await connect.connectFolder(principal, {
        root: b.value['root'] as string,
        includeKeys: b.value['includeKeys'] as string[],
        ...names(b.value),
      }),
      201,
    );
  });

  router.get('/connect/sources/:id/folder', async (req) =>
    respond(await connect.previewSource(requirePrincipal(req), req.params['id'] ?? '')),
  );

  router.post('/connect/sources/:id/selection', async (req) => {
    const principal = requirePrincipal(req);
    const b = await body(req);
    if (!b.ok) return b.response;
    return respond(
      await connect.updateSelection(principal, req.params['id'] ?? '', {
        includeKeys: b.value['includeKeys'] as string[],
        ...names(b.value),
      }),
    );
  });

  router.get('/connect/sources/:id/removal', async (req) =>
    respond(await connect.previewRemoval(requirePrincipal(req), req.params['id'] ?? '')),
  );
  router.post('/connect/sources/:id/items/remove', async (req) => {
    const principal = requirePrincipal(req);
    const b = await body(req);
    if (!b.ok) return b.response;
    return respond(await connect.removeLearned(principal, req.params['id'] ?? '', { keys: b.value['keys'] as string[] }));
  });
  router.post('/connect/sources/:id/remove', async (req) =>
    respond(await connect.removeSource(requirePrincipal(req), req.params['id'] ?? '')),
  );
  router.post('/connect/sources/:id/check', async (req) =>
    respond(await connect.checkSource(requirePrincipal(req), req.params['id'] ?? '')),
  );
  router.post('/connect/sources/:id/read', async (req) => respond(await connect.readNow(requirePrincipal(req), req.params['id'] ?? '')));
  router.post('/connect/sources/:id/disconnect', async (req) =>
    respond(await connect.disconnect(requirePrincipal(req), req.params['id'] ?? '')),
  );
  router.post('/connect/sources/:id/reconnect', async (req) =>
    respond(await connect.reconnect(requirePrincipal(req), req.params['id'] ?? '')),
  );
}
