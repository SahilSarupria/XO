/**
 * `adm-zip` is a real npm dependency (see package.json) used only by
 * `source-collection.ts`'s lazily-loaded `.zip` extraction path. This
 * ambient declaration exists so this package can be TYPECHECKED without
 * `adm-zip`'s own (or `@types/adm-zip`'s) type declarations necessarily
 * being present — it does not change runtime behavior at all: the real
 * package, if installed, is what's actually loaded via the dynamic
 * `import('adm-zip')` in source-collection.ts, and a genuinely-missing
 * package still fails loudly and clearly at that import site, never
 * silently. Intentionally minimal — only the shape this CLI's own
 * `.zip` extraction path needs.
 */
declare module 'adm-zip' {
  interface AdmZipEntry {
    readonly isDirectory: boolean;
    readonly entryName: string;
    getData(): Buffer;
  }
  export default class AdmZip {
    constructor(buffer: Buffer);
    getEntries(): readonly AdmZipEntry[];
  }
}
