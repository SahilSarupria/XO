import { err, ok, type Result } from '@xo/types';
import type { XoMetadata } from '@xo/types';
import type { XoError } from '@xo/errors';
import { compilePdfToXoir, type CompilePdfOptions, type CompiledPdfResult } from './from-pdf.js';
import { packageXoirGraph, type PackageXoirIdentity, type PackagerResult } from './packager.js';

export interface CompilePdfToPackageOptions extends CompilePdfOptions {
  readonly identity: PackageXoirIdentity;
  /**
   * `metadata.json` content. Optional — when omitted, a conservative
   * default is derived *only* from things this pipeline actually knows
   * (the document title Stage 1/2 already extracted, and true statements
   * about the pipeline's own extraction method), never a guessed domain
   * classification. Supply this explicitly for anything beyond a smoke
   * test: this pipeline has no way to know "this is a health-insurance
   * claim form" is more useful metadata than "this is some kind of PDF" —
   * only the caller knows the real domain.
   */
  readonly metadata?: XoMetadata;
}

export interface CompiledPdfPackageResult extends PackagerResult {
  readonly compiled: CompiledPdfResult;
}

function defaultMetadata(compiled: CompiledPdfResult, sourcePath: string): XoMetadata {
  const title = compiled.experienceDocument.documentTitle;
  return {
    domain: 'unclassified',
    description: `Compiled from "${title}" (${sourcePath}).`,
    scope: [`${compiled.loadedDocument.pageCount} page(s)`, `${compiled.experienceDocument.units.length} extracted unit(s)`],
    limitations: [
      'Domain not classified — caller did not supply metadata.domain; do not rely on this field for search/discovery.',
      'Rule-based extraction only unless an aiCore was supplied to compilePdfToXoir.',
      'Not reviewed by a subject-matter expert.',
    ],
    tags: ['auto-generated-metadata'],
  };
}

/**
 * The literal `real PDF -> compiler -> XOIR -> Packager -> legitimate
 * .xo` path: `compilePdfToXoir` (Stages 1–6) followed immediately by
 * `packageXoirGraph` (Stage 9), so an end-to-end harness never has to
 * hand-construct package components itself. Everything this function
 * does is compose two already-independently-testable functions — it
 * adds no new lowering logic of its own (see `packager.ts` for that).
 *
 * Deliberately stops at an unsigned `PackagerResult.bundle`: signing
 * (`@xo/package-sdk`'s `PackageSigner`) and archiving to actual `.xo`
 * bytes (`packBundle`) are the caller's decision — a caller running this
 * inside a CI smoke test, for instance, has no signing key and shouldn't
 * need one just to check the packaging step works.
 */
export async function compilePdfToPackage(bytes: Uint8Array, sourcePath: string, options: CompilePdfToPackageOptions): Promise<Result<CompiledPdfPackageResult, XoError>> {
  const compiled = await compilePdfToXoir(bytes, sourcePath, options);
  if (!compiled.ok) return err(compiled.error);

  const metadata = options.metadata ?? defaultMetadata(compiled.value, sourcePath);
  const packaged = packageXoirGraph(compiled.value.graph, {
    identity: options.identity,
    metadata,
    upstreamDiagnostics: compiled.value.diagnostics,
  });
  if (!packaged.ok) return err(packaged.error);

  return ok({ ...packaged.value, compiled: compiled.value });
}
