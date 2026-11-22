import { RateLimiters, type RateLimit } from '@xo/workflow-runtime';

/**
 * RX-1c (ADR 0048) — per-connector call rates from `XO_CONNECTOR_RATE_LIMITS` (`mail=2/5,*=20`). One limiter set per workspace for
 * the life of the process, shared by every runner of that workspace, so the pace holds across requests, runs and batches. A provider's
 * "slow down" is recorded in the same limiter (the engine calls `backoff`), so later calls to it queue behind the pause.
 */

export interface ParsedRateLimits {
  readonly limits: Readonly<Record<string, RateLimit>>;
  readonly fallback?: RateLimit;
}

const ENTRY = /^([A-Za-z0-9][A-Za-z0-9_.:-]{0,127}|\*)=([0-9]+(?:\.[0-9]+)?)(?:\/([0-9]+))?$/;

/** Throws a message that names the setting and the bad entry. Unset or blank: no limits. */
export function parseConnectorRateLimits(text: string | undefined): ParsedRateLimits {
  const limits: Record<string, RateLimit> = {};
  let fallback: RateLimit | undefined;
  for (const raw of (text ?? '').split(',')) {
    const entry = raw.trim();
    if (entry === '') continue;
    const m = ENTRY.exec(entry);
    const perSecond = m === null ? NaN : Number(m[2]);
    const burst = m?.[3] !== undefined ? Number(m[3]) : undefined;
    if (m === null || !(perSecond > 0) || perSecond > 10_000 || (burst !== undefined && (burst < 1 || burst > 10_000)))
      throw new Error(
        `XO_CONNECTOR_RATE_LIMITS: "${entry}" is not <connector>=<perSecond>[/<burst>] with a rate above 0 and at most 10000 (for example mail=2/5)`,
      );
    const limit: RateLimit = { perSecond, ...(burst !== undefined ? { burst } : {}) };
    if (m[1] === '*') fallback = limit;
    else limits[m[1]!] = limit;
  }
  return { limits, ...(fallback !== undefined ? { fallback } : {}) };
}

const perWorkspace = new Map<string, { readonly text: string; readonly limiters: RateLimiters }>();

/** The workspace's limiters; rebuilt only if the setting changed (a restart), so buckets carry over between runners. */
export function workspaceRateLimiters(workspaceId: string, env: Readonly<Record<string, string | undefined>>): RateLimiters {
  const text = env['XO_CONNECTOR_RATE_LIMITS'] ?? '';
  const known = perWorkspace.get(workspaceId);
  if (known !== undefined && known.text === text) return known.limiters;
  const p = parseConnectorRateLimits(text);
  const limiters = new RateLimiters(p.limits, Date.now, p.fallback);
  perWorkspace.set(workspaceId, { text, limiters });
  return limiters;
}
