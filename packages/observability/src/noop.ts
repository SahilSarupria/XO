import type { Counter, Histogram, Meter } from './meter.interface.js';
import type { Span, Tracer } from './tracer.interface.js';

const noopSpan: Span = {
  setAttribute: () => {},
  recordException: () => {},
  setStatus: () => {},
  end: () => {},
};

export const noopTracer: Tracer = {
  startSpan: () => noopSpan,
  withSpan: async (_name, fn) => fn(noopSpan),
};

const noopCounter: Counter = { add: () => {} };
const noopHistogram: Histogram = { record: () => {} };

export const noopMeter: Meter = {
  createCounter: () => noopCounter,
  createHistogram: () => noopHistogram,
};
