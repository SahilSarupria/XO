/**
 * Data-residency regions a workspace may declare (XO-PROTOCOL §15.6: residency constraints must be machine-declarable).
 *
 * This list is a *declaration vocabulary*, not a placement engine: choosing a region records the requirement on
 * the workspace and surfaces it in audit exports. Where bytes are physically stored is decided by the deployment
 * (`WORKSPACE_DATA_DIR` and friends). `apps/api` never claims a region it cannot enforce — see
 * `GET /workspaces/:id/settings`, which reports `residency.enforcedByServer: false` until a deployment says otherwise.
 */
export interface RegionDefinition {
  readonly id: string;
  readonly label: string;
}

export const REGIONS: readonly RegionDefinition[] = [
  { id: 'in-mumbai', label: 'India (Mumbai)' },
  { id: 'in-hyderabad', label: 'India (Hyderabad)' },
  { id: 'eu-frankfurt', label: 'EU (Frankfurt)' },
  { id: 'eu-ireland', label: 'EU (Ireland)' },
  { id: 'us-east', label: 'US (East)' },
  { id: 'us-west', label: 'US (West)' },
  { id: 'ap-singapore', label: 'Asia Pacific (Singapore)' },
  { id: 'uk-london', label: 'UK (London)' },
];

export function isKnownRegion(id: unknown): id is string {
  return typeof id === 'string' && REGIONS.some((r) => r.id === id);
}

export function regionLabel(id: string): string | undefined {
  return REGIONS.find((r) => r.id === id)?.label;
}
