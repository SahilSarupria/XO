import type { ServerResponse } from 'node:http';
import type { ApiResponse } from './types.js';

/**
 * The one place an `ApiResponse` becomes real bytes on the wire. Route
 * handlers and the error-mapping layer never write to `ServerResponse`
 * themselves — this mirrors `apps/cli`'s `printResult` being the only
 * place a `CommandResult` becomes real stdout writes.
 */
export function writeResponse(res: ServerResponse, response: ApiResponse): void {
  const headers: Record<string, string> = { ...response.headers };

  if (response.body === undefined) {
    res.writeHead(response.status, headers);
    res.end();
    return;
  }

  if (Buffer.isBuffer(response.body) || response.body instanceof Uint8Array) {
    if (headers['content-type'] === undefined) headers['content-type'] = 'application/octet-stream';
    res.writeHead(response.status, headers);
    res.end(response.body);
    return;
  }

  if (headers['content-type'] === undefined) headers['content-type'] = 'application/json; charset=utf-8';
  res.writeHead(response.status, headers);
  res.end(JSON.stringify(response.body));
}
