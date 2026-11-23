import { stringify } from 'yaml';
import { instanceEnvironment, type InstanceDeployConfig } from './config.js';

const ROOT = '/srv/xo';
/** The container runs as uid 10001 (Dockerfile). */
const XO_UID = 10001;

/** Compose reads `$` as a variable: a literal dollar is `$$`. */
const dollar = (v: string): string => v.replace(/\$/g, '$$$$');

export function renderCompose(config: InstanceDeployConfig): string {
  const environment = Object.fromEntries(Object.entries(instanceEnvironment(config)).map(([k, v]) => [k, dollar(v)]));
  const doc = {
    name: config.name,
    services: {
      // XO publishes no port: Caddy reaches it by name on the compose network. It keeps outbound access (mail, sign-in, models).
      xo: {
        image: config.image,
        restart: 'unless-stopped',
        environment,
        volumes: [
          `${ROOT}/data:/data`,
          `${ROOT}/anchors:/anchors`,
          `${ROOT}/keys:/keys`,
          `${ROOT}/trust:/trust:ro`,
          `${ROOT}/backups:/backups`,
        ],
        networks: ['xo'],
      },
      caddy: {
        image: 'caddy:2-alpine',
        restart: 'unless-stopped',
        ports: ['80:80', '443:443', '443:443/udp'],
        volumes: [`${ROOT}/Caddyfile:/etc/caddy/Caddyfile:ro`, `${ROOT}/caddy-data:/data`, `${ROOT}/caddy-config:/config`],
        depends_on: ['xo'],
        networks: ['xo'],
      },
    },
    networks: { xo: {} },
  };
  return stringify(doc, { lineWidth: 0 });
}

/** Caddy terminates TLS and obtains and renews the certificate for the domain automatically from a public ACME CA. */
export function renderCaddyfile(config: InstanceDeployConfig): string {
  return `{\n\temail ${config.acmeEmail}\n}\n\n${config.domain} {\n\treverse_proxy xo:4000\n}\n`;
}

const unit = (sections: Record<string, Record<string, string | string[]>>): string =>
  Object.entries(sections)
    .map(
      ([name, kv]) =>
        `[${name}]\n${Object.entries(kv)
          .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k}=${x}`))
          .join('\n')}\n`,
    )
    .join('\n');

export function renderUnits(config: InstanceDeployConfig): Record<string, string> {
  const keepDays = config.backup?.keepDays ?? 14;
  return {
    'xo.service': unit({
      Unit: {
        Description: `XO instance ${config.name}`,
        After: 'docker.service network-online.target',
        Requires: 'docker.service',
        Wants: 'network-online.target',
      },
      Service: {
        Type: 'oneshot',
        RemainAfterExit: 'yes',
        WorkingDirectory: '/opt/xo',
        // The signing key and the secrets key are generated here, on the machine, once; they never appear in a file of this bundle.
        ExecStartPre: '/usr/bin/docker compose run --rm --no-deps --entrypoint xo xo instance init-keys --data /data',
        ExecStart: '/usr/bin/docker compose up -d --remove-orphans',
        ExecStop: '/usr/bin/docker compose down',
        TimeoutStartSec: '600',
      },
      Install: { WantedBy: 'multi-user.target' },
    }),
    'xo-backup.service': unit({
      Unit: { Description: `Daily live backup of XO instance ${config.name}`, After: 'xo.service', Requires: 'xo.service' },
      Service: {
        Type: 'oneshot',
        WorkingDirectory: '/opt/xo',
        // `$$` is a literal dollar and `%%` a literal percent in a systemd unit.
        ExecStart: `/bin/sh -c '/usr/bin/docker compose exec -T xo xo instance backup --data /data --live --out /backups/xo-$$(date +%%F).tar.gz'`,
        ExecStartPost: `/usr/bin/find ${ROOT}/backups -name 'xo-*.tar.gz' -mtime +${keepDays} -delete`,
      },
    }),
    'xo-backup.timer': unit({
      Unit: { Description: 'Daily XO backup' },
      Timer: { OnCalendar: 'daily', Persistent: 'true', RandomizedDelaySec: '1h' },
      Install: { WantedBy: 'timers.target' },
    }),
  };
}

export function renderCloudInit(config: InstanceDeployConfig, files: Record<string, string>): string {
  const writes = Object.entries(files).map(([path, content]) => ({ path, permissions: '0644', owner: 'root:root', content }));
  const doc = {
    package_update: true,
    packages: ['docker.io', 'docker-compose-v2', 'ufw'],
    write_files: writes,
    runcmd: [
      `mkdir -p ${ROOT}/data ${ROOT}/anchors ${ROOT}/keys ${ROOT}/trust ${ROOT}/backups ${ROOT}/caddy-data ${ROOT}/caddy-config`,
      `chown ${XO_UID} ${ROOT}/data ${ROOT}/anchors ${ROOT}/keys ${ROOT}/backups`,
      `chmod 700 ${ROOT}/data ${ROOT}/anchors ${ROOT}/keys ${ROOT}/backups`,
      'ufw default deny incoming',
      'ufw allow 22/tcp',
      'ufw allow 80/tcp',
      'ufw allow 443/tcp',
      'ufw allow 443/udp',
      'ufw --force enable',
      'systemctl daemon-reload',
      'systemctl enable --now xo.service xo-backup.timer',
    ],
  };
  return `#cloud-config\n${stringify(doc, { lineWidth: 0 })}`;
}

export function renderVmReadme(config: InstanceDeployConfig): string {
  return `# XO instance ${config.name}: virtual machine bundle

Written for Ubuntu 24.04 LTS images on any cloud that runs cloud-init. One instance, one machine, one data disk. There is no high
availability: recovery is a restore from backup.

## Steps

1. Create a machine (at least the size you chose: ${config.size}) with an Ubuntu 24.04 LTS image and a data disk of ${config.dataVolumeGi} GiB or more.
   Paste \`cloud-init.yaml\` as its user data. It contains no secret.
2. Point the DNS name \`${config.domain}\` at the machine's public address. Caddy obtains the certificate when the name resolves.
3. Put the package trust policy at \`/srv/xo/trust/policy.json\` (the file XO_PACKAGE_TRUST_POLICY names).
4. Register these return addresses with your identity providers: \`https://${config.domain}/auth/callback\` and \`https://${config.domain}/oauth/callback\`.
5. Set provider secrets after the first boot, one at a time (the value is read from standard input):
   \`cd /opt/xo && docker compose exec -T xo xo secrets set <NAME> < value.txt\`, then \`systemctl restart xo\`.
6. Create the first sign-in key: \`docker compose exec xo xo instance access-key --data /data\`.

Secrets: the approval signing key and the secrets key are generated on the machine on first boot and never leave it. Nothing in this bundle
holds a secret value; user data is readable through many clouds' metadata services.

## Backups

\`xo-backup.timer\` takes a live backup every day into \`/srv/xo/backups\` and deletes backups older than ${config.backup?.keepDays ?? 14} days.
Backups stay on this machine until you copy them elsewhere. The secrets key is not in a backup: copy \`/srv/xo/keys\` separately and keep it safe.
`;
}

export function renderVm(config: InstanceDeployConfig): Map<string, string> {
  const compose = renderCompose(config);
  const caddy = renderCaddyfile(config);
  const units = renderUnits(config);
  const cloudFiles: Record<string, string> = {
    '/opt/xo/compose.yaml': compose,
    '/srv/xo/Caddyfile': caddy,
    ...Object.fromEntries(Object.entries(units).map(([n, c]) => [`/etc/systemd/system/${n}`, c])),
  };
  const out = new Map<string, string>();
  out.set('cloud-init.yaml', renderCloudInit(config, cloudFiles));
  out.set('compose.yaml', compose);
  out.set('Caddyfile', caddy);
  for (const [n, c] of Object.entries(units)) out.set(n, c);
  out.set('README.md', renderVmReadme(config));
  return out;
}
