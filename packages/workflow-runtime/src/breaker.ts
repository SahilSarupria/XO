/** Per-key circuit breaker: opens after `threshold` consecutive failures, half-opens after `cooldownMs`. Time is injected. */
export class CircuitBreakers {
  private readonly s = new Map<string, { fails: number; openedAt: number | undefined }>();
  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}
  allow(key: string): boolean {
    const st = this.s.get(key);
    if (st?.openedAt === undefined) return true;
    return this.now() - st.openedAt >= this.cooldownMs; // half-open: a probe may pass
  }
  success(key: string): void {
    this.s.set(key, { fails: 0, openedAt: undefined });
  }
  failure(key: string): void {
    const st = this.s.get(key) ?? { fails: 0, openedAt: undefined };
    st.fails++;
    if (st.fails >= this.threshold || st.openedAt !== undefined) st.openedAt = this.now();
    this.s.set(key, st);
  }
}

/** Counting semaphore for per-connector concurrency limits. */
export class Semaphore {
  private waiters: (() => void)[] = [];
  private used = 0;
  constructor(private readonly limit: number) {}
  async acquire(): Promise<() => void> {
    while (this.used >= this.limit) await new Promise<void>((r) => this.waiters.push(r));
    this.used++;
    return () => {
      this.used--;
      this.waiters.shift()?.();
    };
  }
}
