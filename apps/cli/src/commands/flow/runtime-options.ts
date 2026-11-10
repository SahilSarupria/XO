import { join } from 'node:path';
import { err, ok, type Result } from '@xo/types';
import { FileDeadLetterStore, FileEventInbox, RateLimiters, type RateLimit } from '@xo/workflow-runtime';

type Flags = Readonly<Record<string, string | boolean | undefined>>;

/** `--rate-limit bank=2:5,slack=1`: calls per second, optional burst. Strict: anything unparseable is an error, never a silently ignored limit. */
export function rateLimitsFromFlags(flags: Flags, knownConnectors: readonly string[]): Result<RateLimiters | undefined, string> {
  const raw = flags['rate-limit'];
  if (raw === undefined) return ok(undefined);
  if (typeof raw !== 'string' || raw.length === 0) return err('--rate-limit needs a value like bank=2:5,slack=1');
  const limits: Record<string, RateLimit> = {};
  for (const part of raw.split(',')) {
    const m = /^([A-Za-z0-9_.-]{1,64})=([0-9]+(?:\.[0-9]+)?)(?::([0-9]+))?$/.exec(part.trim());
    if (m === null) return err(`--rate-limit entry "${part}" is not <connector>=<perSecond>[:<burst>]`);
    const [, id, rate, burst] = m as unknown as [string, string, string, string | undefined];
    if (!knownConnectors.includes(id))
      return err(`--rate-limit names unknown connector "${id}" (known: ${knownConnectors.join(', ') || 'none'})`);
    if (id in limits) return err(`--rate-limit names connector "${id}" twice`);
    if (!(Number(rate) > 0)) return err(`--rate-limit for "${id}": the rate must be greater than 0`);
    if (burst !== undefined && Number(burst) < 1) return err(`--rate-limit for "${id}": the burst must be at least 1`);
    limits[id] = { perSecond: Number(rate), ...(burst !== undefined ? { burst: Number(burst) } : {}) };
  }
  try {
    return ok(new RateLimiters(limits));
  } catch (e) {
    return err((e as Error).message);
  }
}

/** Dead letters and the event inbox live next to the run journal, so one `--runs` directory is the whole durable state. */
export function stateStores(runsDir: string): { deadLetters: FileDeadLetterStore; events: FileEventInbox } {
  return { deadLetters: new FileDeadLetterStore(join(runsDir, 'dead-letters')), events: new FileEventInbox(join(runsDir, 'events')) };
}
