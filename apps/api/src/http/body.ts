import type { IncomingMessage } from 'node:http';
import { err, ok, type Result } from '@xo/types';
import { ErrorCode, XoError } from '@xo/errors';

const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024; // 64MB — generous enough for a .xo archive upload, bounded so a client can't OOM the process.

/**
 * Reads and buffers the full request body once. `req.rawBody()`
 * (`types.ts`) wraps this with per-request memoization so calling it
 * more than once (e.g. a route reads raw bytes, an error-mapping layer
 * later logs body size) doesn't re-consume the stream.
 *
 * Deliberately does NOT call `incoming.destroy()` when the byte limit
 * is exceeded (P0.3 fix — the previous behavior did, and a real
 * over-the-wire test of a >64MB upload showed exactly why that's wrong:
 * destroying the request socket tears down the *response* socket too
 * (`node:http` shares one connection for both directions), so the
 * client sees a bare `ECONNRESET` instead of the clean, structured 400
 * this function's `XoError` is supposed to produce. Instead: stop
 * accumulating further chunks (so a malicious/oversized client can't
 * grow server memory past the limit) but let the stream finish
 * draining normally and let the promise's rejection flow through the
 * ordinary handler/response path (`server.ts`'s `runHandler` ->
 * `errorToResponse`), which writes the 400 and closes the connection
 * itself once the response is actually sent.
 */
export function readRawBody(incoming: IncomingMessage, maxBytes: number = DEFAULT_MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    incoming.on('data', (chunk: Buffer) => {
      if (failed) return; // already rejected — keep draining the socket without accumulating further bytes.
      total += chunk.length;
      if (total > maxBytes) {
        failed = true;
        chunks.length = 0; // release what was buffered so far; nothing further is retained.
        reject(new XoError(ErrorCode.INVALID_ARGUMENT, `request body exceeds ${maxBytes} byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    incoming.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    incoming.on('error', (cause) => {
      if (!failed) {
        failed = true;
        reject(cause);
      }
    });
  });
}

/**
 * Parses a buffered body as JSON. A malformed body or an empty body
 * where a JSON body was required both come back as `Result` failures
 * with `ErrorCode.INVALID_ARGUMENT` — never a thrown `SyntaxError`
 * reaching a route handler, so every handler's own logic can assume
 * `json()` already did this checking.
 */
export function parseJsonBody<T = unknown>(buffer: Buffer): Result<T, XoError> {
  if (buffer.length === 0) {
    return err(new XoError(ErrorCode.INVALID_ARGUMENT, 'request body is empty; a JSON body is required'));
  }
  try {
    return ok(JSON.parse(buffer.toString('utf8')) as T);
  } catch (cause) {
    return err(new XoError(ErrorCode.INVALID_ARGUMENT, 'request body is not valid JSON', { cause }));
  }
}
