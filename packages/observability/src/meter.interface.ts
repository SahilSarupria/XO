export interface Counter {
  add(value: number, attributes?: Readonly<Record<string, string | number | boolean>>): void;
}

export interface Histogram {
  record(value: number, attributes?: Readonly<Record<string, string | number | boolean>>): void;
}

export interface Meter {
  createCounter(name: string, unit?: string): Counter;
  createHistogram(name: string, unit?: string): Histogram;
}
