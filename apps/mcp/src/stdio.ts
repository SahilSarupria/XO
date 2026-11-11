import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Readable, Writable } from 'node:stream';
import { HttpXoApi } from './api-client.js';
import { ConfigError, loadConfig } from './config.js';
import { stderrLogger, type DiagLogger } from './logger.js';
import { createMcpServer } from './server.js';

export interface RunOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly logger?: DiagLogger;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Runs the server until stdin ends or `signal` aborts. Resolves with the process exit code: 0 clean shutdown, 2 configuration error.
 * The configuration is validated BEFORE anything is read from stdin or written to stdout.
 */
export async function runStdio(options: RunOptions, signal?: AbortSignal): Promise<number> {
  const logger = options.logger ?? stderrLogger();
  let config;
  try {
    config = loadConfig(options.env);
  } catch (cause) {
    logger.warn('config_error', { message: cause instanceof ConfigError ? cause.message : 'invalid configuration' });
    return 2;
  }
  const server = createMcpServer({ api: new HttpXoApi(config, options.fetchImpl), logger });
  const transport = new StdioServerTransport(options.stdin, options.stdout);
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
  const onAbort = (): void => void server.close().catch(() => undefined);
  signal?.addEventListener('abort', onAbort, { once: true });
  // MCP stdio shutdown = the client closes our stdin. The SDK transport does not close the server on EOF by itself, so do it here.
  const stdin = options.stdin ?? process.stdin;
  stdin.once('end', onAbort);
  stdin.once('close', onAbort);
  await server.connect(transport);
  logger.info('started', { workspace: config.workspaceId });
  if (signal?.aborted === true) onAbort();
  await closed;
  signal?.removeEventListener('abort', onAbort);
  stdin.off('end', onAbort);
  stdin.off('close', onAbort);
  logger.info('stopped');
  return 0;
}
