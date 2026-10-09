/** The typed shape of an XO package's `metadata.json` (SPECIFICATION.md §1). */
export interface XoMetadata {
    readonly domain: string;
    readonly description: string;
    readonly scope: readonly string[];
    readonly limitations: readonly string[];
    readonly tags?: readonly string[];
}
//# sourceMappingURL=xo-metadata.d.ts.map