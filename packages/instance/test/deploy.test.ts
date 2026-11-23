// UW-17 (ADR 0054): the cloud template's config, validation and the two renderings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { instanceEnvironment, parseDeployConfig, renderKubernetes, renderVm, resolveSettings } from '../src/index.js';

const EXAMPLE = readFileSync(new URL('../../../deploy/cloud/instance.example.yaml', import.meta.url), 'utf8');
const config = () => {
  const r = parseDeployConfig(EXAMPLE);
  if (!r.ok) throw new Error(r.problems.join('; '));
  return r.config;
};

test('UW-17: rendering refuses an http address, a missing domain, an unpinned image and unknown settings, listing every problem', () => {
  const bad = EXAMPLE.replace('xo.acme.example # the public', '"" # the public')
    .replace(/image: \S+/, 'image: ghcr.io/your-org/xo-instance:latest')
    .replace(
      'XO_RESIDENCY: strict_local',
      'XO_RESIDENCY: strict_local\n  XO_NOT_A_SETTING: x\n  XO_PUBLIC_BASE_URL: http://xo.acme.example',
    );
  const r = parseDeployConfig(bad);
  assert.equal(r.ok, false);
  const problems = (r as { problems: string[] }).problems.join('\n');
  assert.match(problems, /domain: .*required/);
  assert.match(problems, /image: must be pinned by digest/);
  assert.match(problems, /XO_NOT_A_SETTING: is not an XO setting/);
  assert.match(problems, /XO_PUBLIC_BASE_URL/);
  // Missing trust policy and audit retention in production are refused by the instance's own rules.
  const none = parseDeployConfig(EXAMPLE.replace(/settings:[\s\S]*?secrets:/, 'settings: {}\nsecrets:'));
  assert.equal(none.ok, false);
  const text = (none as { problems: string[] }).problems.join('\n');
  assert.match(text, /XO_PACKAGE_TRUST_POLICY/);
  assert.match(text, /XO_AUDIT_RETENTION_DAYS/);
  // A secret's value can never be in the file: a secret setting under `settings`, or a value next to a secret's name.
  const leak = parseDeployConfig(
    EXAMPLE.replace('XO_RESIDENCY: strict_local', 'XO_RESIDENCY: strict_local\n  XO_CREDENTIALS_KEY: abc').replace(
      '- name: XO_CREDENTIALS_KEY',
      '- name: XO_CREDENTIALS_KEY\n    value: abc',
    ),
  );
  assert.equal(leak.ok, false);
  const t = (leak as { problems: string[] }).problems.join('\n');
  assert.match(t, /settings\.XO_CREDENTIALS_KEY: is a secret/);
  assert.match(t, /value: a secret is a name only/);
});

test('UW-17: the vm bundle runs XO on an internal network behind Caddy with automatic TLS for the domain', () => {
  const files = renderVm(config());
  const compose = parse(files.get('compose.yaml')!) as {
    services: Record<string, { ports?: string[]; image: string; networks?: string[] }>;
  };
  assert.equal(compose.services['xo']!.ports, undefined, 'XO publishes no port');
  assert.deepEqual(compose.services['caddy']!.ports, ['80:80', '443:443', '443:443/udp']);
  assert.match(compose.services['xo']!.image, /@sha256:[0-9a-f]{64}$/);
  const caddy = files.get('Caddyfile')!;
  assert.match(caddy, /^xo\.acme\.example \{\n\treverse_proxy xo:4000\n\}/m);
  assert.ok(!caddy.includes('tls internal'), 'a public domain gets a public certificate automatically');
  const init = parse(files.get('cloud-init.yaml')!.replace(/^#cloud-config\n/, '')) as {
    packages: string[];
    runcmd: string[];
    write_files: { path: string }[];
  };
  assert.ok(files.get('cloud-init.yaml')!.startsWith('#cloud-config\n'));
  assert.deepEqual(init.packages, ['docker.io', 'docker-compose-v2', 'ufw']);
  assert.ok(init.runcmd.includes('ufw allow 443/tcp') && init.runcmd.includes('systemctl enable --now xo.service xo-backup.timer'));
  assert.ok(files.get('xo.service')!.includes('instance init-keys --data /data'), 'keys are generated on the machine before XO starts');
  assert.match(files.get('xo-backup.service')!, /instance backup --data \/data --live/);
  assert.match(files.get('xo-backup.service')!, /-mtime \+14 -delete/);
});

test('UW-17: the Kubernetes bundle has one replica and single-pod volumes, and references secrets by name only', () => {
  const files = renderKubernetes(config());
  const sts = parse(files.get('statefulset.yaml')!) as {
    spec: {
      replicas: number;
      volumeClaimTemplates: { spec: { accessModes: string[] } }[];
      template: {
        spec: {
          initContainers: { command: string[] }[];
          containers: {
            env: { name: string; value?: string; valueFrom?: { secretKeyRef: { name: string } } }[];
            securityContext: { runAsNonRoot: boolean };
          }[];
        };
      };
    };
  };
  assert.equal(sts.spec.replicas, 1);
  assert.equal(sts.spec.volumeClaimTemplates.length, 3);
  for (const c of sts.spec.volumeClaimTemplates) assert.deepEqual(c.spec.accessModes, ['ReadWriteOncePod']);
  assert.deepEqual(sts.spec.template.spec.initContainers[0]!.command, ['xo', 'instance', 'init-keys', '--data', '/data']);
  const secret = sts.spec.template.spec.containers[0]!.env.find((e) => e.name === 'XO_CREDENTIALS_KEY')!;
  assert.equal(secret.value, undefined, 'no value, only a reference');
  assert.equal(secret.valueFrom!.secretKeyRef.name, 'acme-xo-secrets');
  assert.equal(sts.spec.template.spec.containers[0]!.securityContext.runAsNonRoot, true);
  assert.ok(!files.has('ingress.yaml'), 'an ingress only when an ingress class is named');
  const withIngress = renderKubernetes({
    ...config(),
    kubernetes: { namespace: 'acme-xo', ingressClass: 'nginx', certManagerIssuer: 'letsencrypt' },
  });
  assert.match(withIngress.get('ingress.yaml')!, /cert-manager\.io\/cluster-issuer: letsencrypt/);
});

test('UW-17: rendered settings pass the instance’s own start-up validation in production', () => {
  const c = config();
  const env = { ...instanceEnvironment(c), XO_APPROVAL_SIGNING_KEY: 'generated-on-first-boot' };
  const r = resolveSettings(env, { joinPath: (...p) => p.join('/') });
  assert.deepEqual(r.errors, []);
  assert.equal(env['XO_PUBLIC_BASE_URL'], 'https://xo.acme.example');
  assert.equal(env['NODE_ENV'], 'production');
});
