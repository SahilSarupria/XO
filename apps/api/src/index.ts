import { startInstance } from './instance/start.js';

export { createHttpServer, buildRouter } from './server.js';
export type { ServerDeps } from './server.js';
export { startInstance, XO_VERSION, type RunningInstance, type StartInstanceOptions } from './instance/start.js';
export { issueAccessKey } from './instance/access-key.js';
export { createConfiguredExternalToolWiring } from './external-tools-host.js';
export type { OidcAuthDeps } from './http/auth.js';
export * from './http/types.js';

/** Only runs when this module is the actual process entrypoint (`npm start` / `node dist/index.js`) — importing this module from a test never binds a socket. */
function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href;
}

if (isMainModule()) {
  // UW-17: the same start-up as `xo up` and the container (instance/start.ts). Any invalid setting stops it with every problem listed.
  void (async () => {
    const instance = await startInstance();
    const shutdown = () => void instance.stop().then(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  })().catch((cause: unknown) => {
    process.stderr.write(
      `${JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', logger: 'xo', message: `startup aborted: ${cause instanceof Error ? cause.message : 'unknown error'}` })}\n`,
    );
    process.exit(1);
  });
}
