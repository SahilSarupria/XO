import { timingSafeEqual, createHash } from 'node:crypto';

/**
 * UW-17 (ADR 0023, rule 5) — the instance's metrics, in the Prometheus text format, at `GET /metrics` for a scraper holding
 * `XO_METRICS_TOKEN`. Requests are counted per method, route TEMPLATE (never a raw path, so ids do not explode the series) and
 * status class. No request content, identity or workspace ever becomes a label.
 */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60] as const;

interface Histogram {
  readonly counts: number[];
  sum: number;
  count: number;
}

const escapeLabel = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const labels = (l: Readonly<Record<string, string>>): string =>
  `{${Object.entries(l)
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    .join(',')}}`;

export class InstanceMetrics {
  private readonly startedAt = Date.now();
  private readonly requests = new Map<string, { labels: Record<string, string>; value: number }>();
  private readonly durations = new Map<string, { labels: Record<string, string>; h: Histogram }>();
  private readonly gauges: { name: string; help: string; read: () => number | undefined }[] = [];

  constructor(private readonly info: { readonly version: string; readonly instanceId?: string }) {}

  observeRequest(method: string, route: string, status: number, seconds: number): void {
    const l = { method, route, status: `${Math.floor(status / 100)}xx` };
    const key = `${l.method} ${l.route} ${l.status}`;
    const c = this.requests.get(key) ?? { labels: l, value: 0 };
    c.value++;
    this.requests.set(key, c);
    const dl = { method, route };
    const dkey = `${method} ${route}`;
    const d = this.durations.get(dkey) ?? { labels: dl, h: { counts: BUCKETS.map(() => 0), sum: 0, count: 0 } };
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) d.h.counts[i]!++;
    });
    d.h.sum += seconds;
    d.h.count++;
    this.durations.set(dkey, d);
  }

  /** A value read when scraped (queue depths, scheduler state, ...). Undefined readings are left out. */
  gauge(name: string, help: string, read: () => number | undefined): void {
    this.gauges.push({ name, help, read });
  }

  render(): string {
    const out: string[] = [];
    const m = process.memoryUsage();
    out.push(
      '# HELP xo_build_info The running XO version (value is always 1).',
      '# TYPE xo_build_info gauge',
      `xo_build_info${labels({ version: this.info.version, ...(this.info.instanceId !== undefined ? { instance: this.info.instanceId } : {}) })} 1`,
      '# HELP xo_uptime_seconds Seconds since the instance started.',
      '# TYPE xo_uptime_seconds gauge',
      `xo_uptime_seconds ${((Date.now() - this.startedAt) / 1000).toFixed(3)}`,
      '# HELP process_resident_memory_bytes Resident memory.',
      '# TYPE process_resident_memory_bytes gauge',
      `process_resident_memory_bytes ${m.rss}`,
      '# HELP nodejs_heap_used_bytes V8 heap in use.',
      '# TYPE nodejs_heap_used_bytes gauge',
      `nodejs_heap_used_bytes ${m.heapUsed}`,
      '# HELP xo_http_requests_total HTTP requests by method, route template and status class.',
      '# TYPE xo_http_requests_total counter',
    );
    for (const c of [...this.requests.values()].sort((a, b) => JSON.stringify(a.labels).localeCompare(JSON.stringify(b.labels))))
      out.push(`xo_http_requests_total${labels(c.labels)} ${c.value}`);
    out.push(
      '# HELP xo_http_request_duration_seconds Time to answer, by method and route template.',
      '# TYPE xo_http_request_duration_seconds histogram',
    );
    for (const d of [...this.durations.values()].sort((a, b) => JSON.stringify(a.labels).localeCompare(JSON.stringify(b.labels)))) {
      BUCKETS.forEach((b, i) =>
        out.push(`xo_http_request_duration_seconds_bucket${labels({ ...d.labels, le: String(b) })} ${d.h.counts[i]}`),
      );
      out.push(`xo_http_request_duration_seconds_bucket${labels({ ...d.labels, le: '+Inf' })} ${d.h.count}`);
      out.push(`xo_http_request_duration_seconds_sum${labels(d.labels)} ${d.h.sum.toFixed(6)}`);
      out.push(`xo_http_request_duration_seconds_count${labels(d.labels)} ${d.h.count}`);
    }
    for (const g of this.gauges) {
      const v = g.read();
      if (v === undefined || !Number.isFinite(v)) continue;
      out.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`, `${g.name} ${v}`);
    }
    return `${out.join('\n')}\n`;
  }
}

/** Constant-time check of `Authorization: Bearer <token>` against the configured scrape token. */
export function metricsTokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  if (m === null) return false;
  const a = createHash('sha256').update(m[1]!).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}
