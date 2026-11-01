import { link, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { ConnectorError, type Connector, type Json } from './types.js';

export interface FileConfig {
  /** Logical root id -> absolute directory, bound by the operator. Workflows only ever name the logical id. */
  readonly roots: Readonly<Record<string, string>>;
  readonly maxBytes: number;
}

/** Validates a root-relative path lexically (no traversal, no absolute paths, no NUL/backslash). */
export function relativePathProblem(p: unknown): string | undefined {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024) return 'path must be a non-empty string';
  if (isAbsolute(p) || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'absolute paths are refused';
  if (/[\u0000\\]/.test(p)) return 'forbidden characters';
  if (p.split('/').some((s) => s === '..' || s === '' || s === '.')) return 'traversal or empty segment';
  return undefined;
}

async function confined(
  cfg: FileConfig,
  args: Readonly<Record<string, Json>>,
  forWrite: boolean,
): Promise<{ full: string; rootReal: string }> {
  const rootId = args['root'];
  if (typeof rootId !== 'string' || cfg.roots[rootId] === undefined) throw new ConnectorError('DENIED', 'unknown root');
  const prob = relativePathProblem(args['path']);
  if (prob !== undefined) throw new ConnectorError('DENIED', `path refused: ${prob}`);
  const rootReal = await realpath(resolve(cfg.roots[rootId] as string));
  const full = resolve(rootReal, join(...(args['path'] as string).split('/')));
  if (!full.startsWith(rootReal + sep)) throw new ConnectorError('DENIED', 'path escapes the root');
  if (forWrite) await mkdir(dirname(full), { recursive: true });
  // symlink escape: the deepest existing ancestor must still resolve inside the root
  const probe = forWrite ? dirname(full) : full;
  let real: string;
  try {
    real = await realpath(probe);
  } catch {
    throw new ConnectorError('DENIED', 'path does not exist');
  }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) throw new ConnectorError('DENIED', 'path escapes the root through a symlink');
  return { full, rootReal };
}

/** Operations: `read_file` (read), `write_record` (write; create-only, replay of identical content is a no-op, different content is refused). */
export function fileConnector(cfg: FileConfig): Connector {
  return {
    kind: 'file',
    operations: {
      read_file: {
        sideEffect: 'read',
        execute: async (args) => {
          const { full } = await confined(cfg, args, false);
          const st = await stat(full);
          if (!st.isFile()) throw new ConnectorError('DENIED', 'not a regular file');
          if (st.size > cfg.maxBytes) throw new ConnectorError('DENIED', 'file exceeds maxBytes');
          return { content: (await readFile(full)).toString('utf8') };
        },
      },
      write_record: {
        sideEffect: 'write',
        execute: async (args) => {
          const content = typeof args['content'] === 'string' ? args['content'] : JSON.stringify(args['content'] ?? null);
          if (Buffer.byteLength(content) > cfg.maxBytes) throw new ConnectorError('DENIED', 'content exceeds maxBytes');
          const { full } = await confined(cfg, args, true);
          const tmp = `${full}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
          await writeFile(tmp, content, { flag: 'wx' });
          try {
            // link() is an atomic create-if-absent: no window where a half-written target exists, so a crash never leaves a poisoned file.
            await link(tmp, full);
            return { written: true, replay: false };
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
            if ((await readFile(full, 'utf8')) === content) return { written: false, replay: true };
            throw new ConnectorError('DENIED', 'target exists with different content; records are create-only');
          } finally {
            await rm(tmp, { force: true });
          }
        },
      },
    },
  };
}
