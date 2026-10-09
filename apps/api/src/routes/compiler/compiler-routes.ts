import type { Router } from '../../http/router.js';
import type { ApiRequest, ApiResponse } from '../../http/types.js';
import { json } from '../../http/types.js';
import { errorToResponse } from '../../http/error-mapping.js';
import { compileViaHttp, type HttpCompileRequest } from './compile-adapter.js';

/**
 * Deliberately the only thing this file does: parse the JSON body and
 * hand it to `compileAdapter.ts`. No knowledge of `PipelineInput`,
 * `CompiledXoirResult`, `XoirGraph`, or anything else `@xo/compiler`/
 * `@xo/xoir`-shaped lives here — see `compile-adapter.ts`'s doc comment
 * for the isolation this is preserving.
 */
async function compile(req: ApiRequest): Promise<ApiResponse> {
  const bodyResult = await req.json<HttpCompileRequest>();
  if (!bodyResult.ok) throw bodyResult.error;

  const result = await compileViaHttp(bodyResult.value);
  if (!result.ok) throw result.error;

  return json(result.value.valid ? 200 : 422, result.value);
}

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      return errorToResponse(cause);
    }
  };
}

export function registerCompilerRoutes(router: Router): void {
  router.post('/compiler/compile', guarded(compile));
}
