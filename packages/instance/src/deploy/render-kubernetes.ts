import { stringify } from 'yaml';
import { instanceEnvironment, type DeploySize, type InstanceDeployConfig } from './config.js';

const UID = 10001;
const RESOURCES: Record<DeploySize, { requests: { cpu: string; memory: string }; limits: { cpu: string; memory: string } }> = {
  small: { requests: { cpu: '500m', memory: '1Gi' }, limits: { cpu: '2', memory: '2Gi' } },
  medium: { requests: { cpu: '1', memory: '2Gi' }, limits: { cpu: '2', memory: '4Gi' } },
  large: { requests: { cpu: '2', memory: '4Gi' }, limits: { cpu: '4', memory: '8Gi' } },
};

export function renderKubernetes(config: InstanceDeployConfig): Map<string, string> {
  const ns = config.kubernetes?.namespace ?? config.name;
  const labels = { 'app.kubernetes.io/name': 'xo', 'app.kubernetes.io/instance': config.name };
  const meta = (name: string, extra: Record<string, unknown> = {}) => ({ name, namespace: ns, labels, ...extra });
  const out = new Map<string, string>();
  const y = (o: unknown): string => stringify(o, { lineWidth: 0 });

  out.set('namespace.yaml', y({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } }));
  out.set(
    'configmap.yaml',
    y({ apiVersion: 'v1', kind: 'ConfigMap', metadata: meta(`${config.name}-settings`), data: instanceEnvironment(config) }),
  );

  const secretEnv = config.secrets.map((s) => ({
    name: s.name,
    valueFrom: { secretKeyRef: { name: s.kubernetesSecret ?? `${config.name}-secrets`, key: s.name, optional: true } },
  }));
  const volumeMounts = [
    { name: 'data', mountPath: '/data' },
    { name: 'anchors', mountPath: '/anchors' },
    { name: 'keys', mountPath: '/keys' },
    { name: 'trust', mountPath: '/trust', readOnly: true },
    { name: 'tmp', mountPath: '/tmp' },
  ];
  const envFrom = [{ configMapRef: { name: `${config.name}-settings` } }];
  const security = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    runAsNonRoot: true,
    runAsUser: UID,
    capabilities: { drop: ['ALL'] },
  };
  const claim = (name: string, gi: number) => ({
    metadata: { name, labels },
    spec: {
      // Only one pod in the cluster may use each volume (single-writer data directory, ADR 0045).
      accessModes: ['ReadWriteOncePod'],
      resources: { requests: { storage: `${gi}Gi` } },
      ...(config.kubernetes?.storageClass !== undefined ? { storageClassName: config.kubernetes.storageClass } : {}),
    },
  });
  const probe = (path: string, extra: Record<string, number>) => ({ httpGet: { path, port: 4000 }, ...extra });

  out.set(
    'statefulset.yaml',
    y({
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: meta(config.name),
      spec: {
        serviceName: config.name,
        replicas: 1,
        podManagementPolicy: 'OrderedReady',
        updateStrategy: { type: 'RollingUpdate' },
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            terminationGracePeriodSeconds: 60,
            securityContext: { fsGroup: UID, runAsNonRoot: true, runAsUser: UID, seccompProfile: { type: 'RuntimeDefault' } },
            // The signing key and the secrets key are generated here, inside the pod, once. They are never in a manifest.
            initContainers: [
              {
                name: 'init-keys',
                image: config.image,
                command: ['xo', 'instance', 'init-keys', '--data', '/data'],
                envFrom,
                env: [{ name: 'HOME', value: '/tmp' }],
                volumeMounts,
                securityContext: security,
              },
            ],
            containers: [
              {
                name: 'xo',
                image: config.image,
                ports: [{ name: 'http', containerPort: 4000 }],
                envFrom,
                env: [{ name: 'HOME', value: '/tmp' }, ...secretEnv],
                volumeMounts,
                resources: RESOURCES[config.size],
                securityContext: security,
                startupProbe: probe('/readyz', { periodSeconds: 5, failureThreshold: 60 }),
                readinessProbe: probe('/readyz', { periodSeconds: 10, failureThreshold: 3 }),
                livenessProbe: probe('/readyz', { periodSeconds: 20, failureThreshold: 6 }),
              },
            ],
            volumes: [
              { name: 'tmp', emptyDir: {} },
              { name: 'trust', configMap: { name: `${config.name}-trust` } },
            ],
          },
        },
        volumeClaimTemplates: [claim('data', config.dataVolumeGi), claim('anchors', 1), claim('keys', 1)],
      },
    }),
  );
  out.set(
    'service.yaml',
    y({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: meta(config.name),
      spec: { selector: labels, ports: [{ name: 'http', port: 80, targetPort: 'http' }] },
    }),
  );
  const k = config.kubernetes;
  if (k?.ingressClass !== undefined)
    out.set(
      'ingress.yaml',
      y({
        apiVersion: 'networking.k8s.io/v1',
        kind: 'Ingress',
        metadata: meta(
          config.name,
          k.certManagerIssuer !== undefined ? { annotations: { 'cert-manager.io/cluster-issuer': k.certManagerIssuer } } : {},
        ),
        spec: {
          ingressClassName: k.ingressClass,
          tls: [{ hosts: [config.domain], secretName: k.tlsSecret ?? `${config.name}-tls` }],
          rules: [
            {
              host: config.domain,
              http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: config.name, port: { name: 'http' } } } }] },
            },
          ],
        },
      }),
    );
  out.set('README.md', readme(config, ns));
  return out;
}

function readme(config: InstanceDeployConfig, ns: string): string {
  return `# XO instance ${config.name}: Kubernetes bundle

One instance: a StatefulSet with one replica and three volumes only one pod may mount (\`ReadWriteOncePod\`, Kubernetes 1.29 or later and a CSI
storage class). There is no high availability and no second replica: the data directory has one writer.

## Steps

1. \`kubectl apply -f namespace.yaml\`
2. Create the trust policy ConfigMap: \`kubectl -n ${ns} create configmap ${config.name}-trust --from-file=policy.json=<your policy file>\`
3. Create the Secret(s) for the provider secrets you listed, by name: \`kubectl -n ${ns} create secret generic ${config.secrets[0]?.kubernetesSecret ?? `${config.name}-secrets`} --from-literal=<NAME>=<value>\`.
   This template only references them. The approval signing key and the secrets key are generated inside the pod on first start.
4. \`kubectl apply -f configmap.yaml -f statefulset.yaml -f service.yaml${config.kubernetes?.ingressClass !== undefined ? ' -f ingress.yaml' : ''}\`
5. Point \`${config.domain}\` at your ingress and register \`https://${config.domain}/auth/callback\` and \`https://${config.domain}/oauth/callback\`.
6. First sign-in key: \`kubectl -n ${ns} exec ${config.name}-0 -- xo instance access-key --data /data\`.

## Backups

Take volume snapshots of the three volumes with your storage class, or run \`kubectl -n ${ns} exec ${config.name}-0 -- xo instance backup --data /data --live --out /tmp/xo.tar.gz\`
and copy the file out. Backups stay where you put them. The secrets key (the \`keys\` volume) is not in a backup.
`;
}
