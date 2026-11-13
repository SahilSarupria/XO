// Launcher used by `npm run dev` (and on Windows, where dist/index.js's main-module check does not detect the entrypoint).
// UW-17: it starts the instance exactly as `xo up` and the container do (instance/start.ts), so development runs the same start-up.
import { startInstance } from './dist/index.js';

try {
  const instance = await startInstance();
  const shutdown = () => void instance.stop().then(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (cause) {
  process.stderr.write(`startup aborted: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(1);
}
