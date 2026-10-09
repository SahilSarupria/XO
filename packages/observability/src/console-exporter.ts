import type { Logger } from '@xo/logger';
import type { Span, SpanStatus, Tracer } from './tracer.interface.js';
import type { Counter, Histogram, Meter } from './meter.interface.js';

class ConsoleSpan implements Span {
  private readonly attributes: Record<string, string | number | boolean> = {};
  private status: SpanStatus = 'unset';
  private statusMessage: string | undefined;
  private ended = false;
  private readonly startedAt = performance.now();

  constructor(
    private readonly name: string,
    private readonly logger: Logger,
    initialAttributes?: Readonly<Record<string, string | number | boolean>>,
  ) {
    Object.assign(this.attributes, initialAttributes);
  }

  setAttribute(key: string, value: string | number | boolean): void {
    this.attributes[key] = value;
  }

  recordException(error: unknown): void {
    this.setStatus('error', error instanceof Error ? error.message : String(error));
    this.logger.error(`span exception: ${this.name}`, { error: error instanceof Error ? error.stack : String(error) });
  }

  setStatus(status: SpanStatus, message?: string): void {
    this.status = status;
    this.statusMessage = message;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    const durationMs = performance.now() - this.startedAt;
    this.logger.debug(`span ended: ${this.name}`, {
      durationMs,
      status: this.status,
      statusMessage: this.statusMessage,
      ...this.attributes,
    });
  }
}

/** Emits spans as structured debug logs. Sufficient for local dev; a real deployment swaps in an OpenTelemetry SDK exporter behind the same {@link Tracer} interface. */
export class ConsoleTracer implements Tracer {
  constructor(private readonly logger: Logger) {}

  startSpan(name: string, attributes?: Readonly<Record<string, string | number | boolean>>): Span {
    return new ConsoleSpan(name, this.logger, attributes);
  }

  async withSpan<T>(name: string, fn: (span: Span) => Promise<T> | T): Promise<T> {
    const span = this.startSpan(name);
    try {
      const result = await fn(span);
      span.setStatus('ok');
      return result;
    } catch (error) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }
}

export class ConsoleMeter implements Meter {
  constructor(private readonly logger: Logger) {}

  createCounter(name: string, unit?: string): Counter {
    return {
      add: (value, attributes) => this.logger.info(`counter ${name}`, { value, unit, ...attributes }),
    };
  }

  createHistogram(name: string, unit?: string): Histogram {
    return {
      record: (value, attributes) => this.logger.info(`histogram ${name}`, { value, unit, ...attributes }),
    };
  }
}
