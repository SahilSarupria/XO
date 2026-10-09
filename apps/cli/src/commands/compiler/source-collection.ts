import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, dirname, sep, posix as posixPath } from 'node:path';
import { KNOWN_EXTENSIONS, loadSourceInput } from './source-input.js';

/**
 * `adm-zip` is a real, ordinary npm dependency of this package — never
 * hidden, still declared in `package.json` — but it is only ever needed
 * for the one `.zip`-archive code path below. Loading it lazily (only
 * when a `.zip` argument is actually resolved) means an environment
 * that genuinely can't install it (offline, restricted registry, etc.)
 * can still run every other `xo compile`/`xo capabilities`/`xo workflow`
 * invocation — PDF, JSON, OpenAPI, directories — none of which need it
 * at all. A `.zip` argument still fails, explicitly and with a clear
 * actionable message, exactly as it should; nothing about ZIP support
 * is silently faked or replaced.
 */
interface AdmZipEntry {
  readonly isDirectory: boolean;
  readonly entryName: string;
  getData(): Buffer;
}
interface AdmZipLike {
  getEntries(): readonly AdmZipEntry[];
}
async function loadAdmZip(buffer: Buffer): Promise<AdmZipLike> {
  let AdmZipCtor: new (buf: Buffer) => AdmZipLike;
  try {
    const mod = (await import('adm-zip')) as { default: new (buf: Buffer) => AdmZipLike };
    AdmZipCtor = mod.default;
  } catch (cause) {
    throw new Error(
      `.zip input requires the optional "adm-zip" dependency, which is not installed in this environment. ` +
        `PDF/JSON/OpenAPI/directory inputs do not need it and are unaffected. ` +
        `Install it (npm install adm-zip) to use .zip inputs. (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }
  return new AdmZipCtor(buffer);
}

/**
 * One file this module has decided is worth handing to `@xo/compiler` —
 * `absolutePath` is where its bytes currently live on disk (may be
 * inside a throwaway temp dir, for a ZIP arg); `declaredPath` is what
 * gets baked into the tagged `SourceInput` as `sourcePath`, which
 * `@xo/compiler`'s `computeSourceId` then hashes into every downstream
 * id (`source-input.ts`'s doc comment). For a directory or ZIP arg,
 * `declaredPath` is the entry's path relative to that arg's own root
 * (e.g. `"policy.pdf"`, `"sub/claims.pdf"`) — never the collection
 * arg's own name, and never a temp-extraction path — so provenance and
 * ids are identical regardless of whether the same ZIP is compiled from
 * `/tmp/a` or `/tmp/b`, and regardless of what the user named the
 * directory itself.
 */
export interface DiscoveredSource {
  readonly declaredPath: string;
  readonly absolutePath: string;
}

export interface UnsupportedEntry {
  readonly relativePath: string;
  readonly reason: string;
}

export interface ResolvedSourceArg {
  readonly argKind: 'file' | 'directory' | 'zip';
  readonly sources: readonly DiscoveredSource[];
  readonly unsupported: readonly UnsupportedEntry[];
  /** No-ops for `file`/`directory`; removes the temp extraction dir for `zip`. Always safe to call, always safe to call more than once. */
  readonly cleanup: () => Promise<void>;
}

const NOOP_CLEANUP = async (): Promise<void> => {};

/** Deterministic, locale-independent string ordering — `Array.prototype.sort`'s default comparator already does exactly this for plain strings (UTF-16 code unit order), so this exists only to make that intentional rather than incidental at each call site. */
function byPath<T extends { readonly declaredPath: string }>(a: T, b: T): number {
  return a.declaredPath < b.declaredPath ? -1 : a.declaredPath > b.declaredPath ? 1 : 0;
}

/**
 * Recursively walks `root`, classifying every regular file by extension
 * against `KNOWN_EXTENSIONS` (`source-input.ts` — the same list
 * `loadSourceInput` itself switches on, so a file this walker accepts
 * is guaranteed to be one `loadSourceInput` knows how to tag). Skips
 * dotfiles/dot-directories (`.git`, `.DS_Store`, editor swap dirs,
 * ...) — not a compiler concern, just noise no real "document set" a
 * user hands `xo create` is likely to want ingested; anything else
 * unrecognized is reported in `unsupported` rather than silently
 * dropped (task brief §4's "report unsupported files when useful").
 * Ordering is sorted by path before returning — `readdir`'s own
 * enumeration order is filesystem-dependent and never trusted here
 * (task brief §8).
 */
async function walkDirectory(root: string): Promise<{ sources: DiscoveredSource[]; unsupported: UnsupportedEntry[] }> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const sources: DiscoveredSource[] = [];
  const unsupported: UnsupportedEntry[] = [];

  // `path.join` normalizes away a trailing separator on `root` (e.g.
  // `join('/a/b/', 'file.txt')` -> `/a/b/file.txt`, not `/a/b//file.txt`),
  // so slicing by the *original* `root`'s length over-counts by one
  // whenever the caller passed a root with a trailing separator,
  // stripping the first character of every discovered relative path.
  // Stripping any trailing separator(s) from `root` first keeps the
  // length calculation in sync with what `join` actually produced,
  // for roots with or without a trailing separator alike.
  const normalizedRoot = root.replace(/[/\\]+$/, '');

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const entryDir = entry.parentPath;
    const relativeToRoot = join(entryDir, entry.name).slice(normalizedRoot.length + 1).split(sep).join('/');

    if (relativeToRoot.split('/').some((segment) => segment.startsWith('.'))) continue;

    const ext = extname(entry.name).toLowerCase();
    if (!KNOWN_EXTENSIONS.has(ext)) {
      unsupported.push({ relativePath: relativeToRoot, reason: `unsupported extension "${ext || '(none)'}"` });
      continue;
    }

    sources.push({ declaredPath: relativeToRoot, absolutePath: join(entryDir, entry.name) });
  }

  sources.sort(byPath);
  unsupported.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));

  // Duplicate ingestion (a symlink loop, or a symlink pointing back into
  // the same tree) is caught by realpath equality, not by declaredPath
  // equality — two distinct declaredPaths can legitimately point at the
  // same underlying file, and that's exactly the case worth collapsing.
  const seenRealPaths = new Set<string>();
  const deduped: DiscoveredSource[] = [];
  for (const source of sources) {
    const real = await realpath(source.absolutePath);
    if (seenRealPaths.has(real)) continue;
    seenRealPaths.add(real);
    deduped.push(source);
  }

  return { sources: deduped, unsupported };
}

/**
 * Extracts `zipBytes` into a fresh temp directory with explicit
 * zip-slip protection (task brief §5): every entry's path is
 * posix-normalized and rejected outright — before any write happens —
 * if it's absolute or contains a `..` segment that would resolve
 * outside the temp root. No entry is ever executed; only regular file
 * entries are written, directory entries are skipped (directories are
 * created implicitly via `mkdir(..., {recursive:true})` as needed), and
 * the original archive is only ever read (`AdmZip(zipBytes)` operates
 * on an in-memory buffer this function itself read once) — never
 * written back to.
 */
async function extractZipToTempDir(zipBytes: Uint8Array): Promise<string> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'xo-cli-zip-'));
  const zip = await loadAdmZip(Buffer.from(zipBytes));

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;

    const normalized = posixPath.normalize(entry.entryName);
    if (posixPath.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`refusing to extract unsafe zip entry path "${entry.entryName}" (path traversal)`);
    }

    const destination = join(tempRoot, ...normalized.split('/'));
    if (!destination.startsWith(tempRoot + sep) && destination !== tempRoot) {
      throw new Error(`refusing to extract zip entry "${entry.entryName}" outside the extraction root`);
    }

    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, entry.getData());
  }

  return tempRoot;
}

/**
 * Resolves one CLI positional argument — a single file, a directory, or
 * a `.zip` archive — into `ResolvedSourceArg`. This is the only place
 * that branches on "what kind of thing did the user point me at";
 * everything downstream (`compile.ts`/`create.ts`/`capabilities.ts`)
 * just sees a flat list of `DiscoveredSource`.
 */
export async function resolveSourceArg(argPath: string): Promise<ResolvedSourceArg> {
  const stats = await stat(argPath);

  if (stats.isDirectory()) {
    const { sources, unsupported } = await walkDirectory(argPath);
    return { argKind: 'directory', sources, unsupported, cleanup: NOOP_CLEANUP };
  }

  if (stats.isFile() && extname(argPath).toLowerCase() === '.zip') {
    const zipBytes = new Uint8Array(await readFile(argPath));
    const tempRoot = await extractZipToTempDir(zipBytes);
    const { sources, unsupported } = await walkDirectory(tempRoot);
    return {
      argKind: 'zip',
      sources,
      unsupported,
      cleanup: () => rm(tempRoot, { recursive: true, force: true }),
    };
  }

  if (stats.isFile()) {
    // Single explicit file: declaredPath is the literal argument the
    // caller typed, unchanged — this preserves `xo create policy.pdf`'s
    // existing, already-tested behavior exactly (declaredPath used to
    // just be called `sourcePath` before collection support existed).
    return { argKind: 'file', sources: [{ declaredPath: argPath, absolutePath: argPath }], unsupported: [], cleanup: NOOP_CLEANUP };
  }

  throw new Error(`"${argPath}" is neither a file, a directory, nor a .zip archive`);
}

export interface CollectedSources {
  readonly inputs: readonly unknown[];
  readonly discovered: readonly DiscoveredSource[];
  readonly unsupported: readonly UnsupportedEntry[];
  readonly cleanup: () => Promise<void>;
}

/**
 * The entry point every compiler-facing command
 * (`compile.ts`/`create.ts`/`capabilities.ts`) calls instead of mapping
 * `loadSourceInput` over `options.sources` directly. Resolves every
 * positional arg (in the order given), concatenates their discovered
 * sources (each arg's own sources already sorted — see `walkDirectory`
 * — so overall ordering is deterministic: arg order, then path order
 * within each arg), deduplicates by realpath *across* args too (task
 * brief §4/§6: "prevent duplicate ingestion" isn't scoped to one
 * argument), and tags each surviving file via `loadSourceInput`.
 *
 * Fails fast on the first arg that doesn't resolve at all (bad path,
 * unsafe zip entry) — matching `compileSources`' own "a malformed input
 * is a real error the caller should see immediately" posture — and
 * fails with a clear, listed error if zero sources survive across the
 * whole batch, rather than handing `compileSources` an empty array and
 * letting its own generic "requires at least one input" message stand
 * in for what actually happened.
 */
export async function collectSources(argPaths: readonly string[]): Promise<CollectedSources> {
  const allDiscovered: DiscoveredSource[] = [];
  const allUnsupported: UnsupportedEntry[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  try {
    for (const argPath of argPaths) {
      const resolved = await resolveSourceArg(argPath);
      cleanups.push(resolved.cleanup);
      allDiscovered.push(...resolved.sources);
      allUnsupported.push(...resolved.unsupported);
    }
  } catch (cause) {
    await Promise.all(cleanups.map((c) => c()));
    throw cause;
  }

  const seenRealPaths = new Set<string>();
  const deduped: DiscoveredSource[] = [];
  for (const source of allDiscovered) {
    const real = await realpath(source.absolutePath);
    if (seenRealPaths.has(real)) continue;
    seenRealPaths.add(real);
    deduped.push(source);
  }

  if (deduped.length === 0) {
    await Promise.all(cleanups.map((c) => c()));
    const sample = allUnsupported
      .slice(0, 10)
      .map((u) => `  ${u.relativePath} (${u.reason})`)
      .join('\n');
    throw new Error(
      `no supported source files were found in: ${argPaths.join(', ')}` +
        (allUnsupported.length > 0 ? `\nEncountered ${allUnsupported.length} unsupported file(s), e.g.:\n${sample}` : ''),
    );
  }

  const inputs = await Promise.all(deduped.map((source) => loadSourceInput(source.absolutePath, source.declaredPath)));

  return {
    inputs,
    discovered: deduped,
    unsupported: allUnsupported,
    cleanup: async () => {
      await Promise.all(cleanups.map((c) => c()));
    },
  };
}
