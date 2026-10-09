import type { CommandResult } from '../command-result.js';
import { runCommand } from '../commands/runtime/run.js';
import { resolveProvider } from '../commands/runtime/provider-factory.js';
import type { QueryRequest } from './repl.js';

/**
 * Plain text in the session (and `xo -p`) is a capability *query*: it goes
 * through the exact `runCommand` that `xo run` uses, with `query` set and
 * no capability id, so `@xo/runtime`'s `CapabilityNegotiator` picks the
 * capability. No planning, prompt assembly, or provider logic lives here —
 * this file only maps a {@link QueryRequest} onto `runCommand`'s options.
 *
 * `xo run` itself cannot reach this path from the command line (its
 * registrar requires a positional capability id), which is why the
 * session/`-p` entry points exist.
 */
export function runQuery(request: QueryRequest): Promise<CommandResult> {
  const provider = request.provider;
  return runCommand(
    {
      query: request.query,
      input: request.input,
      storeDir: request.storeDir,
      providerLabel: provider ?? 'anthropic',
      json: request.json === true,
      ...(request.model !== undefined ? { model: request.model } : {}),
    },
    () => resolveProvider({ ...(provider !== undefined ? { provider } : {}), ...(request.providerFlags ?? {}) }),
  );
}
