import { createHmac } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HashChainLedger } from './ledger.js';

/** Hands one outbox item (a `needs_human` / dead-letter record) to a person or another system. Throwing means "not delivered, try again later". */
export interface DeliveryAdapter {
  readonly id: string;
  deliver(item: OutboxItem): Promise<void>;
}

export interface OutboxItem {
  readonly lane: string;
  readonly runId: string;
  readonly record: unknown;
}

/** POSTs the record, HMAC-signed (`X-XO-Delivery-Signature: sha256=<hmac(secret, body)>`), to an HTTPS (or loopback) URL — Slack/Teams relays, ticketing webhooks, an on-call bridge. */
export class WebhookDelivery implements DeliveryAdapter {
  readonly id: string;
  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const u = new URL(url);
    const loop = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop))
      throw new Error('delivery endpoint must be https (http only for loopback)');
    if (u.username !== '' || u.password !== '') throw new Error('delivery endpoint must not embed credentials');
    if (secret.length < 16) throw new Error('delivery secret must be at least 16 characters');
    this.id = `webhook:${u.host}`;
  }
  async deliver(item: OutboxItem): Promise<void> {
    const body = JSON.stringify({ lane: item.lane, runId: item.runId, record: item.record });
    const r = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': item.runId, // receivers can dedupe redeliveries
        'x-xo-delivery-signature': `sha256=${createHmac('sha256', this.secret).update(body).digest('hex')}`,
      },
      body,
    });
    if (!r.ok) throw new Error(`delivery endpoint answered ${r.status}`);
  }
}

/** Copies the record into another directory (a shared inbox, a mounted queue folder) atomically. */
export class DirectoryDelivery implements DeliveryAdapter {
  readonly id: string;
  constructor(private readonly dir: string) {
    this.id = `dir:${dir}`;
  }
  async deliver(item: OutboxItem): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `.${item.runId}.tmp`);
    await writeFile(tmp, JSON.stringify({ lane: item.lane, runId: item.runId, record: item.record }, null, 2));
    await rename(tmp, join(this.dir, `${item.runId}.json`));
  }
}

export interface DelivererOptions {
  readonly outboxDir: string;
  /** Lanes to deliver (default: `needs-human` and `dead-letter`). */
  readonly lanes?: readonly string[];
  readonly adapters: readonly DeliveryAdapter[];
  readonly ledger?: HashChainLedger;
}

export interface DeliveryReport {
  readonly delivered: number;
  readonly failed: number;
  readonly skipped: number;
}

/**
 * At-least-once delivery of outbox items. An item is marked delivered (`<runId>.json.delivered`) only after EVERY adapter accepted
 * it; adapters that already accepted it are not re-sent on retry (`<runId>.json.sent.<adapter>`). Receivers get `Idempotency-Key = runId`.
 */
export async function deliverOutbox(o: DelivererOptions): Promise<DeliveryReport> {
  let delivered = 0;
  let failed = 0;
  let skipped = 0;
  for (const lane of o.lanes ?? ['needs-human', 'dead-letter']) {
    const dir = join(o.outboxDir, lane);
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.json')).sort();
    for (const n of names) {
      if ((await readdir(dir)).includes(`${n}.delivered`)) {
        skipped++;
        continue;
      }
      const record = JSON.parse(await readFile(join(dir, n), 'utf8')) as unknown;
      const runId = n.replace(/\.json$/, '');
      let allOk = true;
      for (const a of o.adapters) {
        const sentMarker = join(dir, `${n}.sent.${a.id.replace(/[^A-Za-z0-9._-]/g, '_')}`);
        if ((await readFile(sentMarker, 'utf8').catch(() => undefined)) !== undefined) continue;
        try {
          await a.deliver({ lane, runId, record });
          await writeFile(sentMarker, new Date().toISOString());
          await o.ledger?.append('delivery.sent', { runId, lane, adapter: a.id });
        } catch (e) {
          allOk = false;
          await o.ledger?.append('delivery.failed', { runId, lane, adapter: a.id, error: (e as Error).message });
        }
      }
      if (allOk) {
        await writeFile(join(dir, `${n}.delivered`), new Date().toISOString());
        delivered++;
      } else failed++;
    }
  }
  return { delivered, failed, skipped };
}
