/**
 * Mirrors `apps/cli/src/commands/compiler/source-input.ts#loadSourceInput`'s
 * extension -> `SourceInput` tagging exactly, adapted to work from bytes
 * already in memory (a `SourceRecord`'s stored content) instead of
 * reading a file from disk — this API never has a filesystem path to a
 * source document at all (P0.3 stores content only via `BlobStore`), so
 * there is nothing to read a path from in the first place. Duplicated
 * rather than imported for the same reason `source.ts#SUPPORTED_EXTENSIONS`
 * is: `apps/cli` declares no importable `exports`. This function's
 * extension set MUST stay a subset of `SUPPORTED_EXTENSIONS` — every
 * branch below exists in `loadSourceInput`; `.xo`, `.txt`/`.md`-fallback,
 * and "unrecognized extension" behavior are deliberately NOT reproduced
 * here, because `SUPPORTED_EXTENSIONS` already rejects anything outside
 * this exact set at upload time (`source-routes.ts`) — this function can
 * therefore afford to throw on a truly unreachable extension rather than
 * guessing, since reaching that branch would mean the upload-time gate
 * itself has a bug, not that the caller did something recoverable.
 */
export function buildCompilerSourceInput(extension: string, bytes: Uint8Array, sourcePath: string): unknown {
  switch (extension) {
    case '.pdf':
      return { kind: 'pdf', bytes, sourcePath };
    case '.html':
    case '.htm':
      return { kind: 'html', html: new TextDecoder().decode(bytes), sourcePath };
    case '.json': {
      const text = new TextDecoder().decode(bytes);
      if (looksLikeOpenApiDocument(text)) return { kind: 'openapi', text, sourcePath };
      return { kind: 'structured', format: 'json', text, sourcePath };
    }
    case '.csv':
      return { kind: 'structured', format: 'csv', text: new TextDecoder().decode(bytes), sourcePath };
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.webp':
      return { kind: 'image', bytes, sourcePath };
    case '.txt':
    case '.md':
      return { kind: 'document', text: new TextDecoder().decode(bytes), sourcePath };
    default:
      throw new Error(`internal error: extension "${extension}" passed SUPPORTED_EXTENSIONS but has no compiler source-input mapping — this is a bug in source.ts/source-input-adapter.ts staying in sync, not a client error`);
  }
}

/** Identical content-sniff to `source-input.ts`'s own — see that file's doc comment for why this must be a content check, never a filename convention. */
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
