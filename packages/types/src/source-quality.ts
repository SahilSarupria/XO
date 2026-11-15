/**
 * PX-2 (gap PX-G10): the one source-quality vocabulary (ADR 0029 decision 2). The compiler computes it
 * (`@xo/compiler` `document/document-quality.ts`), the XOIR manifest records it, and approval and readiness enforce it.
 *
 * - `trusted`: every page read; nothing suspicious.
 * - `degraded`: read, with findings (suspicious tokens, a page read by a hosted model).
 * - `partial`: at least one page was not read, and is listed in the page coverage.
 * - `blocked`: the text could not be trusted at all; no semantic extraction ran.
 *
 * Policy: `degraded` and `partial` sources compile and can be reviewed, but nothing built on them can be approved or made
 * ready without a waiver bound to that source version and those findings. A `blocked` source cannot be waived.
 */
export type SourceQualityState = 'trusted' | 'degraded' | 'partial' | 'blocked';

export const SOURCE_QUALITY_STATES: readonly SourceQualityState[] = ['trusted', 'degraded', 'partial', 'blocked'];
