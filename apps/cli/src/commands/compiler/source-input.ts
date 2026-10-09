import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

/**
 * `@xo/compiler`'s `SourceFrontendRegistry` resolves `unknown` input to a
 * frontend by an explicit `kind` discriminant (see
 * `packages/compiler/src/sources/*-frontend.ts`'s `is*SourceInput`
 * guards) — every frontend except `pdf` *requires* that tag; `pdf` and
 * `image` only have magic-byte fallbacks for untagged bytes. Tagging
 * explicitly here, by file extension, is the one piece of adaptation a
 * CLI legitimately owns: turning "a path the user typed" into "the
 * shape the compiler's own source-resolution contract expects." Nothing
 * about *how* a source type is ingested, chunked, or extracted lives
 * here — that is entirely `@xo/compiler`'s.
 *
 * The extensions below mirror `createDefaultSourceFrontendRegistry`
 * (`packages/compiler/src/sources/default-registry.ts`) exactly: one
 * entry per registered frontend (pdf, html, structured/json,
 * structured/csv, image), plus `.txt`/`.md` mapped explicitly to
 * `document`. `.json` is further content-sniffed for the `openapi`
 * frontend (see `looksLikeOpenApiDocument` below) rather than getting
 * its own extension, since OpenAPI-as-JSON and this CLI's existing
 * structured-JSON operation fixtures share the same `.json` extension —
 * the two are told apart by content, exactly as `OpenApiSourceFrontend`
 * itself does. This is the single place that mapping is declared —
 * `source-collection.ts`'s directory/ZIP walker imports
 * `KNOWN_EXTENSIONS` from here rather than re-listing it, so the two
 * can never drift apart.
 */
export const KNOWN_EXTENSIONS: ReadonlySet<string> = new Set(['.pdf', '.html', '.htm', '.json', '.csv', '.txt', '.md', '.png', '.jpg', '.jpeg', '.gif', '.webp']);

/**
 * Tags the bytes at `readPath` (where the file actually lives on disk)
 * with the `sourcePath` the compiler should record (`declaredPath`,
 * defaulting to `readPath`). Kept as two separate parameters — not
 * because single-file callers need it (they always pass the same value
 * for both, preserving prior behavior exactly) — but because
 * `source-collection.ts` must be able to read from a temp-extracted
 * ZIP's absolute path while declaring the archive-relative path as
 * `sourcePath`. `sourcePath` is hashed into `computeSourceId`
 * (`packages/compiler/src/sources/source-id.ts`) and therefore into
 * every downstream `ExperienceUnit` id — a temp-extraction path leaking
 * into that hash would make compiling the same ZIP twice non-
 * deterministic across runs (different temp dirs), and provenance would
 * point at a directory that no longer exists after cleanup. See
 * `../../../../../XO_PROTOCOL.md`-style provenance requirements this
 * task's brief §7-§8 restates directly.
 */
/**
 * A `.json` file is `openapi`-tagged only when its top level has a
 * string `"openapi"` field starting with `"3."` and an object
 * `"paths"` field — the exact same two-field check
 * `OpenApiSourceFrontend.ingest` itself performs (see
 * `packages/compiler/src/sources/openapi-frontend.ts`); this is a
 * content sniff, never a filename convention, and never a guess — any
 * other `.json` document (including one that merely has fields named
 * `inputs`/`outputs`, per that frontend's own explicit-only recognition
 * rule) still tags as `structured`, unchanged.
 */
function looksLikeOpenApiDocument(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const candidate = parsed as Record<string, unknown>;
  return typeof candidate.openapi === 'string' && candidate.openapi.startsWith('3.') && typeof candidate.paths === 'object' && candidate.paths !== null;
}

export async function loadSourceInput(readPath: string, declaredPath: string = readPath): Promise<unknown> {
  const ext = extname(readPath).toLowerCase();

  if (ext === '.xo') {
    // A `.xo` file is an already-compiled, signed PACKAGE (a zip-like
    // binary archive of a manifest + component files) — not raw source
    // material. Falling through to the generic "unknown extension ->
    // read as UTF-8 text" branch below would silently decode that
    // binary archive as garbled text and feed it to the plain-text
    // frontend, producing nonsense "capabilities"/"workflows" made of
    // corrupted byte fragments that still *look* like real output (this
    // was reported against a real `.xo` file — capability names like
    // single mangled tokens are exactly this failure mode, not a real
    // discovery). Refusing clearly here is the honest behavior: this
    // command compiles sources into a package; it does not (yet) read
    // an existing package back out to re-derive a workflow from its
    // manifest. Use `xo run`/`xo install` to execute an existing `.xo`
    // package, or point `xo workflow`/`xo compile`/`xo capabilities` at
    // the original source document(s) instead.
    throw new Error(`"${declaredPath}" is a packaged .xo archive (an already-compiled, signed package), not a compilable source document. Use "xo run"/"xo install" to execute it, or pass the original source document(s) (PDF/JSON/HTML/CSV/text) to compile a fresh workflow.`);
  }

  if (ext === '.pdf') {
    const bytes = new Uint8Array(await readFile(readPath));
    return { kind: 'pdf', bytes, sourcePath: declaredPath };
  }

  if (ext === '.html' || ext === '.htm') {
    const html = await readFile(readPath, 'utf8');
    return { kind: 'html', html, sourcePath: declaredPath };
  }

  if (ext === '.json') {
    const text = await readFile(readPath, 'utf8');
    if (looksLikeOpenApiDocument(text)) return { kind: 'openapi', text, sourcePath: declaredPath };
    return { kind: 'structured', format: 'json', text, sourcePath: declaredPath };
  }

  if (ext === '.csv') {
    const text = await readFile(readPath, 'utf8');
    return { kind: 'structured', format: 'csv', text, sourcePath: declaredPath };
  }

  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif' || ext === '.webp') {
    const bytes = new Uint8Array(await readFile(readPath));
    return { kind: 'image', bytes, sourcePath: declaredPath };
  }

  // Fallback: `.txt`/`.md`/anything else this module doesn't recognize
  // is treated as plain text — the same "best-effort generic text"
  // outcome `DocumentSourceFrontend` itself is built for, never an
  // error, since an unrecognized extension is not the same claim as
  // unreadable content. Single-file callers rely on this fallback
  // (`xo create notes.rtf` still compiles as best-effort text); the
  // collection walker (`source-collection.ts`) does NOT rely on it — it
  // filters to `KNOWN_EXTENSIONS` before ever calling this function, so
  // a directory full of unrelated files doesn't get silently
  // "document"-ingested one by one.
  const text = await readFile(readPath, 'utf8');
  return { kind: 'document', text, sourcePath: declaredPath };
}
