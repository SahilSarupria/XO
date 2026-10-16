import { platform, release, arch } from 'node:os';
import { DEVELOPMENT_TRUST_WARNING, loadOperatorTrustPolicy } from '@xo/package-sdk';

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Reports the effective package-trust configuration using the very resolver install/verify/publish/run use, so `xo doctor` can never say "fine" about a configuration those commands would refuse. A missing/invalid configuration FAILS the check; explicit development mode passes (it was asked for by name) but says so loudly.
 */
function trustCheck(env: Readonly<Record<string, string | undefined>>): DoctorCheck {
  const loaded = loadOperatorTrustPolicy(env);
  if (!loaded.ok) return { name: 'package_trust', ok: false, detail: `[${loaded.error.code}] ${loaded.error.message}` };
  const policy = loaded.value;
  if (policy.mode === 'development') return { name: 'package_trust', ok: true, detail: `mode=development — ${DEVELOPMENT_TRUST_WARNING}` };
  return { name: 'package_trust', ok: true, detail: `mode=enforce, ${policy.keys.length} trusted key(s), policy ${policy.policyId}` };
}

/** Real environment checks — no placeholders. Each check reports a fact about the running process, not a stub. */
export function doctorCommand(env: Readonly<Record<string, string | undefined>> = process.env): readonly DoctorCheck[] {
  const [major] = process.versions.node.split('.').map(Number);
  return [
    { name: 'node_version', ok: (major ?? 0) >= 20, detail: `Node ${process.versions.node} (need >= 20)` },
    { name: 'platform', ok: true, detail: `${platform()} ${release()} (${arch()})` },
    { name: 'env_xo_config_dir', ok: true, detail: env['XO_CONFIG_DIR'] ?? '(not set — using defaults)' },
    trustCheck(env),
  ];
}
