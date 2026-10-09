import { platform, release, arch } from 'node:os';

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Real environment checks — no placeholders. Each check reports a fact about the running process, not a stub. */
export function doctorCommand(): readonly DoctorCheck[] {
  const [major] = process.versions.node.split('.').map(Number);
  return [
    { name: 'node_version', ok: (major ?? 0) >= 20, detail: `Node ${process.versions.node} (need >= 20)` },
    { name: 'platform', ok: true, detail: `${platform()} ${release()} (${arch()})` },
    { name: 'env_xo_config_dir', ok: true, detail: process.env.XO_CONFIG_DIR ?? '(not set — using defaults)' },
  ];
}
