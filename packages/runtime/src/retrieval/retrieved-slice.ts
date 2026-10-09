import type { ComponentKind } from '@xo/types';

/**
 * One retrieved piece of a mounted package's content, ready to feed into
 * context assembly. Structurally a superset of `@xo/runtime-core`'s
 * `RetrievedSlice` (`componentKind`, `content`, `estimatedTokens`) — this
 * adds `packageName`/`packageVersion` attribution, which Stage 2 needs
 * for merging slices from multiple mounted packages
 * (`mergeKnowledgeGraphs`) and for receipts/hooks to report which
 * package a slice came from. `@xo/runtime-core`'s `Retriever` interface
 * keys a request by a single `packageId: string`; this package instead
 * threads `name`/`version` through directly (the same divergence, and
 * for the same reason, as Stage 1's README explains for `Mounter`) —
 * composite-string package ids are a real correctness risk (a package
 * name could itself contain the id's separator character) that plain
 * `name`/`version` fields don't have.
 */
export interface RetrievedSlice {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly componentKind: ComponentKind;
  readonly content: string;
  readonly estimatedTokens: number;
}

/**
 * A rough, deterministic token estimate — Stage 2 has no tokenizer
 * dependency, so this is intentionally a simple, documented
 * approximation (4 characters per token, the same rule of thumb `@xo/package-sdk`'s
 * own docs and most providers' public guidance use), not a precise
 * count. Real per-provider tokenization belongs to a real `@xo/ai-core`
 * implementation, which returns an authoritative `AiUsage` after a real
 * call; this estimate is only ever used pre-call, for budgeting.
 */
export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}
