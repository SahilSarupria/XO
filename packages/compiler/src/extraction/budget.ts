/**
 * A spend ceiling that can be shared by many documents and many concurrent pages. `reserve` is atomic (JavaScript is
 * single-threaded and nothing here awaits between the check and the update), so concurrent callers can never jointly
 * overrun the ceiling. Reservation is worst-case and is settled to actual spend afterwards.
 */
export class SpendCeiling {
  private reserved = 0;
  constructor(readonly maxUsd: number) {}

  /** Reserves `usd` if it fits under the ceiling. Returns false (and reserves nothing) otherwise. */
  tryReserve(usd: number): boolean {
    if (!Number.isFinite(usd) || usd < 0) return false;
    if (this.reserved + usd > this.maxUsd) return false;
    this.reserved += usd;
    return true;
  }

  /** Replaces a reservation by what was actually spent (never more than reserved, so a reservation can only shrink). */
  settle(reservedUsd: number, actualUsd: number): void {
    this.reserved += Math.min(actualUsd, reservedUsd) - reservedUsd;
  }

  get committedUsd(): number {
    return Number(this.reserved.toFixed(6));
  }
}

/** A ceiling for a whole run (many documents). Pass one instance to every `recoverUnreadPages` call of the run. */
export class RunBudget extends SpendCeiling {}
