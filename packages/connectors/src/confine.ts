import { spawnSync } from 'node:child_process';
import { isAbsolute, normalize } from 'node:path';

/**
 * Confinement for child processes the host launches on someone else's behalf (MCP stdio servers). The default is CONFINED: when this host
 * cannot confine a child, planning throws instead of quietly launching it unconfined. Running unconfined needs `allowUnconfined: true`,
 * which is an operator decision and is recorded (the returned plan says so, and the CLI writes it into every run's journal).
 *
 * What each level actually gives (and what it does not) is returned with the plan, so a caller can show it and a ledger can store it:
 *   - `bwrap` (bubblewrap on Linux): new user/pid/ipc/uts/cgroup/net namespaces, a root that is EMPTY except the read-only and writable paths the
 *     operator lists plus a minimal system set, private /proc, /dev and /tmp, dies with the parent, own session (no terminal injection).
 *   - `namespaces` (Linux `unshare` only): new user/pid/ipc/uts (and net) namespaces. The child cannot reach the network (unless asked), cannot see or signal
 *     other processes, and gets no terminal. It CAN still read every file the host user can read and write every file that user can write.
 *   - `operator-wrapper`: the operator supplied their own wrapper argv. XO cannot verify it, so it claims nothing.
 *   - `none`: no confinement (operator opt-in, or a platform where none is available).
 * Not covered at any level: CPU, memory and disk-quota limits (use cgroups/containers), kernel or sandbox escapes, and what the server does with data
 * it is legitimately given. Only Linux is supported; on other platforms the plan is `none` and needs the operator opt-in.
 */
export type ConfinementKind = 'bwrap' | 'namespaces' | 'operator-wrapper' | 'none';

export interface ConfinePolicy {
  /** The weakest acceptable level. `filesystem` (default) needs bubblewrap; `namespaces` also accepts `unshare`-only hosts. */
  readonly require?: 'filesystem' | 'namespaces';
  /** Operator decision: if confinement is unavailable on this host, launch unconfined instead of refusing. Recorded. Default false. */
  readonly allowUnconfined?: boolean;
  /** Operator decision: never confine, even where it is available. Recorded. Default false. */
  readonly disable?: boolean;
  /** `none` (default) gives the child no network; `host` shares the host network. */
  readonly network?: 'none' | 'host';
  /** Absolute paths the server may read (its own code and libraries). Only meaningful with bubblewrap. */
  readonly readOnlyPaths?: readonly string[];
  /** Absolute paths the server may write. Only meaningful with bubblewrap. */
  readonly writablePaths?: readonly string[];
  /** An operator-supplied wrapper argv; the child command is appended. Trusted as given and recorded as unverified. */
  readonly operatorWrapper?: readonly string[];
}

export interface Confinement {
  readonly kind: ConfinementKind;
  /** argv placed in front of the server command. */
  readonly prefix: readonly string[];
  readonly platform: string;
  readonly network: 'none' | 'host' | 'unknown';
  readonly protects: readonly string[];
  readonly notProtected: readonly string[];
  /** True when the operator chose to run without confinement that policy would otherwise require. */
  readonly operatorOptOut: boolean;
  /** Why the preferred level was not used, when it was not. */
  readonly reason?: string;
}

export class ConfinementUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfinementUnavailableError';
  }
}

export type Probe = (cmd: string, args: readonly string[]) => boolean;
const realProbe: Probe = (cmd, args) => {
  try {
    return spawnSync(cmd, [...args], { stdio: 'ignore', timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
};

export interface PlanDeps {
  readonly platform?: string;
  /** Runs a command and says whether it exited 0. Injected so tests need not depend on the host. */
  readonly probe?: Probe;
}

const SYSTEM_RO = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/resolv.conf',
  '/etc/passwd',
  '/etc/group',
];
const BWRAP_PROBE = [
  '--unshare-all',
  '--die-with-parent',
  '--ro-bind',
  '/usr',
  '/usr',
  '--proc',
  '/proc',
  '--dev',
  '/dev',
  '/usr/bin/true',
];

function checkPaths(kind: string, paths: readonly string[] | undefined): readonly string[] {
  for (const p of paths ?? []) {
    if (isAbsolute(p) && normalize(p) === '/') throw new ConfinementUnavailableError(`${kind} path "/" would expose the whole filesystem`);
    if (!isAbsolute(p) || normalize(p) !== p.replace(/\/+$/, '') || /[\0\n]/.test(p))
      throw new ConfinementUnavailableError(`${kind} path "${p}" must be an absolute, normalised path`);
  }
  return paths ?? [];
}

const NOT_ANY = [
  'CPU, memory and disk-quota limits (use cgroups or a container for those)',
  'kernel or sandbox-runtime vulnerabilities',
  'what the server does with data it is legitimately given, and the correctness of its answers',
];

/** Decides how a child will be launched. Throws `ConfinementUnavailableError` rather than return a weaker plan than the policy allows. */
export function planConfinement(policy: ConfinePolicy = {}, deps: PlanDeps = {}): Confinement {
  const platform = deps.platform ?? process.platform;
  const probe = deps.probe ?? realProbe;
  const network = policy.network ?? 'none';
  const ro = checkPaths('readOnly', policy.readOnlyPaths);
  const rw = checkPaths('writable', policy.writablePaths);

  if (policy.operatorWrapper !== undefined) {
    if (policy.operatorWrapper.length === 0) throw new ConfinementUnavailableError('operatorWrapper must not be empty');
    return {
      kind: 'operator-wrapper',
      prefix: [...policy.operatorWrapper],
      platform,
      network: 'unknown',
      protects: [],
      notProtected: ['everything: XO cannot verify an operator-supplied wrapper, so nothing is claimed', ...NOT_ANY],
      operatorOptOut: false,
    };
  }

  let reason: string | undefined;
  if (policy.disable === true) reason = 'confinement disabled by the operator';
  else if (platform === 'linux') {
    if (probe('bwrap', BWRAP_PROBE)) {
      const prefix = [
        'bwrap',
        '--die-with-parent',
        '--new-session',
        '--unshare-all',
        ...(network === 'host' ? ['--share-net'] : []),
        ...SYSTEM_RO.flatMap((p) => ['--ro-bind-try', p, p]),
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--tmpfs',
        '/tmp',
        ...ro.flatMap((p) => ['--ro-bind', p, p]),
        ...rw.flatMap((p) => ['--bind', p, p]),
        '--chdir',
        '/tmp',
        '--',
      ];
      return {
        kind: 'bwrap',
        prefix,
        platform,
        network,
        protects: [
          'filesystem: only the system directories, the listed read-only paths and the listed writable paths exist; home directories, the run directory and secrets files do not',
          network === 'none' ? 'network: none' : 'network: SHARED with the host (operator choice)',
          'processes: the child sees and can signal only itself',
          'terminal and session: detached; dies when the host dies',
        ],
        notProtected: NOT_ANY,
        operatorOptOut: false,
      };
    }
    if (probe('unshare', ['-r', '-p', '-f', '-i', '-u', '-n', 'true'])) {
      if ((policy.require ?? 'filesystem') === 'namespaces') {
        return {
          kind: 'namespaces',
          prefix: ['unshare', '-r', '-p', '-f', '-i', '-u', ...(network === 'none' ? ['-n'] : []), '--kill-child', '--'],
          platform,
          network,
          protects: [
            network === 'none' ? 'network: none' : 'network: SHARED with the host (operator choice)',
            'processes: the child cannot see or signal other processes',
            'IPC and hostname: separate',
          ],
          notProtected: [
            'filesystem: the child can read every file this user can read and write every file this user can write (install bubblewrap for filesystem confinement)',
            ...NOT_ANY,
          ],
          operatorOptOut: false,
        };
      }
      reason =
        'bubblewrap (bwrap) is not usable here; only namespace isolation is available, which does not confine files (set require: "namespaces" to accept that)';
    } else reason = 'neither bubblewrap nor unprivileged user namespaces (unshare) work on this host';
  } else reason = `no confinement is implemented for platform "${platform}" (Linux only)`;

  if (policy.allowUnconfined !== true && policy.disable !== true)
    throw new ConfinementUnavailableError(
      `cannot confine the MCP server: ${reason}. Run on a Linux host with bubblewrap, or set allowUnconfined to accept the risk (it is recorded in the ledger).`,
    );
  return {
    kind: 'none',
    prefix: [],
    platform,
    network: 'unknown',
    protects: [],
    notProtected: [
      'filesystem: the server runs as the host user and can read and write whatever that user can',
      'network: unrestricted',
      "processes: can see and signal this user's other processes",
      ...NOT_ANY,
    ],
    operatorOptOut: true,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/** A compact, secret-free record of a plan, for journals and logs. */
export function confinementRecord(c: Confinement): Record<string, unknown> {
  return {
    kind: c.kind,
    platform: c.platform,
    network: c.network,
    operatorOptOut: c.operatorOptOut,
    ...(c.reason !== undefined ? { reason: c.reason } : {}),
    protects: c.protects,
    notProtected: c.notProtected,
  };
}
