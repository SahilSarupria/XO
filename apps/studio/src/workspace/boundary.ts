/**
 * Workspace boundary for the future IDE. INTERFACE ONLY: there is deliberately no provider,
 * no persistence and no recovery here. Those belong to P1.1-D (Durable Workspaces & Agent
 * Recovery), which is not started. Today's "workspace" is the server-side XO workspace used by
 * the existing screens (see ../platform/client.ts); nothing below is implemented by it.
 *
 * Intended implementations (none exist yet):
 *  - desktop local-folder provider: native, behind validated Tauri commands scoped to ONE
 *    folder the user explicitly picked (never a general fs capability);
 *  - hosted provider: server-side storage behind the XO API, usable from the web experience.
 *
 * Authority: a provider only supplies files and metadata. It never grants an XO permission;
 * approvals and authorization stay on the server regardless of where files live.
 */

declare const relativePathBrand: unique symbol;
/** A normalised, workspace-relative path that cannot escape its root. Create only via parseWorkspaceRelativePath. */
export type WorkspaceRelativePath = string & { readonly [relativePathBrand]: true };

const MAX_PATH = 1024;
const MAX_SEGMENT = 255;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Strict, platform-independent validation so the same path means the same thing on every shell.
 * Rejects absolute paths, drive letters, backslashes, dot segments, empty segments, control
 * characters, trailing dots/spaces and Windows device names. A native implementation MUST
 * re-validate and resolve against its root itself; this check is an input contract, not the
 * enforcement point.
 */
export function parseWorkspaceRelativePath(raw: string): { ok: true; value: WorkspaceRelativePath } | { ok: false; reason: string } {
  if (raw.length === 0 || raw.length > MAX_PATH) return { ok: false, reason: 'path is empty or too long' };
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return { ok: false, reason: 'path must be relative' };
  if (raw.includes('\\')) return { ok: false, reason: 'backslashes are not allowed' };
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, reason: 'control characters are not allowed' };
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return { ok: false, reason: 'empty or dot segments are not allowed' };
    if (seg.length > MAX_SEGMENT) return { ok: false, reason: 'a path segment is too long' };
    if (/[. ]$/.test(seg)) return { ok: false, reason: 'segments must not end in a dot or space' };
    if (/[<>:"|?*]/.test(seg)) return { ok: false, reason: 'segment contains a character not portable across systems' };
    if (WINDOWS_RESERVED.test(seg)) return { ok: false, reason: 'segment is a reserved device name' };
  }
  return { ok: true, value: raw as WorkspaceRelativePath };
}

export type WorkspaceKind = 'local-folder' | 'hosted';

export interface WorkspaceMetadata {
  /** Stable identity. For hosted workspaces this is the server's workspace id. */
  readonly id: string;
  readonly kind: WorkspaceKind;
  readonly name: string;
}

export type WorkspaceError =
  | { readonly kind: 'not_supported'; readonly message: string }
  | { readonly kind: 'denied'; readonly message: string }
  | { readonly kind: 'not_found'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string };

export type WorkspaceResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: WorkspaceError };

/** Optional capability: only providers that can really do it expose it, and UI renders it only then. */
export interface WorkspaceFiles {
  list(dir: WorkspaceRelativePath | null): Promise<WorkspaceResult<readonly { name: string; isDirectory: boolean }[]>>;
  read(path: WorkspaceRelativePath): Promise<WorkspaceResult<Uint8Array>>;
  write(path: WorkspaceRelativePath, data: Uint8Array): Promise<WorkspaceResult<void>>;
}

export interface WorkspaceProvider {
  readonly kind: WorkspaceKind;
  /** Workspaces this provider can open. For local-folder: only ones the user explicitly selected. */
  list(): Promise<WorkspaceResult<readonly WorkspaceMetadata[]>>;
  open(id: string): Promise<WorkspaceResult<WorkspaceMetadata>>;
  /** Absent unless the provider genuinely supports file access. */
  readonly files?: WorkspaceFiles;
  // Deliberately absent until P1.1-D: durable storage, checkpoints, task/agent recovery.
}
