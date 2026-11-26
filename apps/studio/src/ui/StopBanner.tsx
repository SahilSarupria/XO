import { loadedValue, Button } from './primitives';
import { Banner } from './kit';
import { useQuery, wsKey } from '../platform/query';
import { useSession } from './session';

/**
 * One line on every screen when something is stopped: the whole instance, the whole workspace, or named workflows,
 * connections or actions. What is stopped is what the platform reports; if it cannot be read, nothing is claimed.
 */
export function StopBanner(props: { workspaceId: string; names: ReadonlyMap<string, string>; onOpen: () => void }) {
  const { client } = useSession();
  const stops = useQuery(wsKey(props.workspaceId, 'emergency-stops'), () => client.listEmergencyStops(props.workspaceId), {
    pollMs: 60_000,
  });
  const v = loadedValue(stops.state);
  if (v === undefined) return null;
  const named = v.stops.map((s) =>
    s.scope === 'workflow' ? (props.names.get(s.target) ?? 'a workflow') : s.target.replace('.', ': ').replace(/_/g, ' '),
  );
  if (v.instance === undefined && !v.workspacePaused && named.length === 0) return null;
  const shown = named.slice(0, 3).join(', ') + (named.length > 3 ? ` and ${named.length - 3} more` : '');
  const title =
    v.instance !== undefined
      ? 'Everything on this XO is stopped'
      : v.workspacePaused
        ? 'Everything in this workspace is paused'
        : 'Some work is stopped';
  const body =
    v.instance !== undefined
      ? 'Whoever runs this XO stopped it. Nothing can start until they release it.'
      : v.workspacePaused
        ? 'Nothing can start, by hand or on a schedule, until someone resumes it. Runs already waiting for a person can still be decided.'
        : `Stopped: ${shown}. Anything that depends on it will not start or continue until someone releases it.`;
  return (
    <div className="stop-banner" role="status">
      <Banner tone="attention" title={title}>
        {body}{' '}
        {v.instance === undefined ? (
          <Button variant="quiet" onClick={props.onOpen}>
            See what is stopped
          </Button>
        ) : null}
      </Banner>
    </div>
  );
}
