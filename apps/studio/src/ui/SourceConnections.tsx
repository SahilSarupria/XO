import { useEffect, useRef, useState } from 'react';
import type { ApiProblem, Result } from '../platform/client';
import type {
  DriveAccount,
  DriveFolder,
  DriveProvider,
  Pairing,
  SourceConnectionDetail,
  SourceConnectionOptions,
  SourceConnectionSummary,
} from '../platform/wire-sources';
import type { WorkspaceRole } from '../platform/wire';
import {
  KIND_LABEL,
  PROVIDER_LABEL,
  agentCommands,
  agentLine,
  driveUnavailableLine,
  freshnessView,
  plural,
  scheduleLine,
  syncReportLines,
} from '../domain/sourceConnections';
import { Badge, Button, ProblemNotice, Skeleton, Spinner, formatBytes, formatWhen, loadedValue, useLoad } from './primitives';
import { useSession } from './session';

type Route =
  | { readonly kind: 'list' }
  | { readonly kind: 'add-server-folder' }
  | { readonly kind: 'add-drive'; readonly provider: DriveProvider }
  | { readonly kind: 'add-computer' }
  | { readonly kind: 'detail'; readonly id: string; readonly pairing?: Pairing };

/** What to OFFER by role; the server decides every action again. An unknown role (older server) offers everything. */
const may = (role: WorkspaceRole | undefined, need: 'manage' | 'author'): boolean =>
  role === undefined || role === 'admin' || (need === 'author' && role === 'publisher');

/**
 * UW-12a — the workspace's folders and drives (docs/SOURCE_CONNECTIONS.md): a folder on the XO server, OneDrive or SharePoint, Google
 * Drive, or a folder on someone's own computer through the XO agent. Hidden entirely on a server that does not offer source connections.
 */
export function WorkspaceSources(props: { readonly ws: string; readonly role?: WorkspaceRole }) {
  const { client } = useSession();
  const [route, setRoute] = useState<Route>({ kind: 'list' });
  const options = useLoad(() => client.sourceConnectionOptions(props.ws), [props.ws]);
  if (options.state.phase === 'error' && options.state.problem.kind === 'not_found') return null;
  if (options.state.phase === 'loading') return <Skeleton label="Loading folders and drives" rows={1} />;
  if (options.state.phase === 'error') return <ProblemNotice problem={options.state.problem} onRetry={options.reload} />;
  const opts = options.state.value;
  const back = () => setRoute({ kind: 'list' });
  return (
    <div className="sc-panel" aria-label="Folders and drives">
      {route.kind === 'list' ? <ConnectionList ws={props.ws} role={props.role} options={opts} go={setRoute} /> : null}
      {route.kind === 'add-server-folder' ? (
        <AddServerFolder ws={props.ws} onDone={(id) => setRoute({ kind: 'detail', id })} onCancel={back} />
      ) : null}
      {route.kind === 'add-drive' ? (
        <AddDrive ws={props.ws} provider={route.provider} onDone={(id) => setRoute({ kind: 'detail', id })} onCancel={back} />
      ) : null}
      {route.kind === 'add-computer' ? (
        <AddComputer ws={props.ws} onDone={(id, pairing) => setRoute({ kind: 'detail', id, pairing })} onCancel={back} />
      ) : null}
      {route.kind === 'detail' ? (
        <ConnectionDetail
          ws={props.ws}
          id={route.id}
          role={props.role}
          options={opts}
          {...(route.pairing !== undefined ? { pairing: route.pairing } : {})}
          onBack={back}
        />
      ) : null}
    </div>
  );
}

// -- list ----------------------------------------------------------------------------------------------------------------------

function ConnectionList(props: { ws: string; role: WorkspaceRole | undefined; options: SourceConnectionOptions; go: (r: Route) => void }) {
  const { client } = useSession();
  const list = useLoad(() => client.listSourceConnections(props.ws), [props.ws]);
  const canAdd = may(props.role, 'manage');
  return (
    <div className="stack">
      <h3>Folders and drives</h3>
      <p className="muted">
        XO keeps these in step with the workspace: new and changed files arrive as new versions, and nothing is ever changed where they
        live.
      </p>
      {list.state.phase === 'loading' ? <Skeleton label="Loading connected folders" rows={2} /> : null}
      {list.state.phase === 'error' ? <ProblemNotice problem={list.state.problem} onRetry={list.reload} /> : null}
      {list.state.phase === 'ready' && list.state.value.length === 0 ? (
        <p className="muted">Nothing is connected to this workspace yet.</p>
      ) : null}
      {list.state.phase === 'ready' && list.state.value.length > 0 ? (
        <ul className="connect-list" aria-label="Connected folders and drives">
          {list.state.value.map((c) => (
            <ConnectionRow key={c.connectionId} c={c} onOpen={() => props.go({ kind: 'detail', id: c.connectionId })} />
          ))}
        </ul>
      ) : null}
      {canAdd ? (
        <div className="sc-add" role="group" aria-label="Connect a folder or drive">
          <div className="card connect-add-card">
            <strong>A folder on a computer</strong>
            <p className="muted">Someone's own laptop or office PC. The XO agent on that computer sends the folder to XO.</p>
            <Button variant="primary" onClick={() => props.go({ kind: 'add-computer' })}>
              Connect a computer's folder
            </Button>
          </div>
          {props.options.drives.map((d) => (
            <div key={d.provider} className="card connect-add-card">
              <strong>{d.displayName}</strong>
              <p className="muted">Read-only access to one folder, through an account you connect.</p>
              {d.available ? (
                <Button onClick={() => props.go({ kind: 'add-drive', provider: d.provider })}>Connect {d.displayName}</Button>
              ) : (
                <p className="small">{driveUnavailableLine(d.reason, d.displayName)}</p>
              )}
            </div>
          ))}
          {props.options.localFolder.available ? (
            <div className="card connect-add-card">
              <strong>A folder on the XO server</strong>
              <p className="muted">A folder on the machine XO runs on, inside the folders its administrator allowed.</p>
              <Button onClick={() => props.go({ kind: 'add-server-folder' })}>Connect a server folder</Button>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="muted small">Your role lets you see connected folders, not add them.</p>
      )}
    </div>
  );
}

function ConnectionRow(props: { c: SourceConnectionSummary; onOpen: () => void }) {
  const f = freshnessView(props.c.freshness);
  return (
    <li className="card connect-row">
      <div>
        <strong>{props.c.displayName}</strong>
        <p className="muted">
          {KIND_LABEL[props.c.kind]} · {plural(props.c.files, 'file')}
        </p>
      </div>
      <div className="connect-row-end">
        <Badge tone={f.tone}>{f.label}</Badge>
        <Button onClick={props.onOpen} aria-label={`Open ${props.c.displayName}`}>
          Open
        </Button>
      </div>
    </li>
  );
}

// -- add: a folder on the XO server ------------------------------------------------------------------------------------------

function AddServerFolder(props: { ws: string; onDone: (id: string) => void; onCancel: () => void }) {
  const { client } = useSession();
  const [root, setRoot] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>(undefined);
  const connect = async () => {
    setBusy(true);
    setProblem(undefined);
    const r = await client.createSourceConnection(props.ws, { kind: 'local_folder', root: root.trim() });
    setBusy(false);
    if (!r.ok) return setProblem(r.problem);
    props.onDone(r.value.connection.connectionId);
  };
  return (
    <div className="stack">
      <h3>Connect a folder on the XO server</h3>
      <label htmlFor="sc-root">Folder path on the XO server</label>
      <input
        id="sc-root"
        className="input"
        value={root}
        onChange={(e) => setRoot(e.target.value)}
        placeholder="/srv/xo/shared/Renewals"
        autoComplete="off"
      />
      <p className="muted small">It must be inside a folder the administrator allowed (XO_SOURCE_FOLDER_ROOTS). XO reads it at once.</p>
      {busy ? <Spinner label="Reading the folder" /> : null}
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      <div className="row">
        <Button variant="primary" pending={busy} disabled={root.trim().length === 0} onClick={() => void connect()}>
          Connect folder
        </Button>
        <Button variant="quiet" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// -- add: a drive --------------------------------------------------------------------------------------------------------------

const CONSENT_POLL_MS = 4000;

function AddDrive(props: { ws: string; provider: DriveProvider; onDone: (id: string) => void; onCancel: () => void }) {
  const { client } = useSession();
  const name = props.provider === 'microsoft' ? 'OneDrive or SharePoint' : 'Google Drive';
  const accounts = useLoad(() => client.driveAccounts(props.ws), [props.ws]);
  const [consent, setConsent] = useState<{ authorizationUrl: string; expiresAt: string } | undefined>(undefined);
  const [problem, setProblem] = useState<ApiProblem | undefined>(undefined);
  const [account, setAccount] = useState<string | undefined>(undefined);
  const mine: DriveAccount[] =
    accounts.state.phase === 'ready' ? accounts.state.value.filter((a) => a.provider === props.provider && a.state === 'active') : [];
  const chosen = account ?? (mine.length === 1 ? mine[0]!.credentialId : undefined);

  // While the person is at the provider, look for the new account now and then.
  const reload = useRef(accounts.reload);
  reload.current = accounts.reload;
  useEffect(() => {
    if (consent === undefined || mine.length > 0) return;
    const t = setInterval(() => reload.current(), CONSENT_POLL_MS);
    return () => clearInterval(t);
  }, [consent, mine.length]);

  const start = async () => {
    setProblem(undefined);
    const r = await client.startDriveConsent(props.ws, props.provider);
    if (!r.ok) return setProblem(r.problem);
    setConsent(r.value);
  };

  return (
    <div className="stack">
      <h3>Connect {name}</h3>
      {accounts.state.phase === 'loading' ? <Skeleton label="Loading connected accounts" rows={1} /> : null}
      {accounts.state.phase === 'error' ? <ProblemNotice problem={accounts.state.problem} onRetry={accounts.reload} /> : null}
      {accounts.state.phase === 'ready' && mine.length === 0 ? (
        <div className="stack">
          <p>
            First connect a {PROVIDER_LABEL[props.provider]} account. XO asks only to read files; it cannot change, share or delete
            anything.
          </p>
          {consent === undefined ? (
            <Button variant="primary" onClick={() => void start()}>
              Connect a {PROVIDER_LABEL[props.provider]} account
            </Button>
          ) : (
            <div className="stack">
              <a className="btn btn-primary" href={consent.authorizationUrl} target="_blank" rel="noopener noreferrer">
                Open {PROVIDER_LABEL[props.provider]} to allow read-only access
              </a>
              <p className="muted small" role="status">
                Waiting for you to allow access. This page carries on by itself once you have; the link works until{' '}
                {formatWhen(consent.expiresAt)}.
              </p>
              <Button variant="quiet" onClick={accounts.reload}>
                I have allowed access
              </Button>
            </div>
          )}
        </div>
      ) : null}
      {mine.length > 1 ? (
        <fieldset className="stack">
          <legend>Which account?</legend>
          {mine.map((a) => (
            <label key={a.credentialId}>
              <input type="radio" name="sc-account" checked={chosen === a.credentialId} onChange={() => setAccount(a.credentialId)} />{' '}
              {a.accountLabel ?? a.credentialId}
            </label>
          ))}
        </fieldset>
      ) : null}
      {chosen !== undefined ? <FolderBrowser ws={props.ws} provider={props.provider} credentialId={chosen} onDone={props.onDone} /> : null}
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      <div className="row">
        <Button variant="quiet" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function FolderBrowser(props: { ws: string; provider: DriveProvider; credentialId: string; onDone: (id: string) => void }) {
  const { client } = useSession();
  const [trail, setTrail] = useState<readonly DriveFolder[]>([]);
  const parent = trail.at(-1)?.ref;
  const folders = useLoad(
    () => client.driveFolders(props.ws, props.provider, props.credentialId, parent),
    [props.ws, props.provider, props.credentialId, parent],
  );
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<ApiProblem | undefined>(undefined);
  const connect = async (f: DriveFolder) => {
    setBusy(f.ref);
    setProblem(undefined);
    const r = await client.createSourceConnection(props.ws, {
      kind: props.provider === 'microsoft' ? 'microsoft_drive' : 'google_drive',
      credentialId: props.credentialId,
      folder: f.ref,
    });
    setBusy(undefined);
    if (!r.ok) return setProblem(r.problem);
    props.onDone(r.value.connection.connectionId);
  };
  return (
    <div className="stack">
      <nav aria-label="Where you are in the drive" className="row">
        <Button variant="quiet" onClick={() => setTrail([])} disabled={trail.length === 0}>
          Drives
        </Button>
        {trail.map((f, i) => (
          <Button key={f.ref} variant="quiet" onClick={() => setTrail(trail.slice(0, i + 1))} disabled={i === trail.length - 1}>
            / {f.name}
          </Button>
        ))}
      </nav>
      {folders.state.phase === 'loading' ? <Spinner label="Listing folders" /> : null}
      {folders.state.phase === 'error' ? <ProblemNotice problem={folders.state.problem} onRetry={folders.reload} /> : null}
      {folders.state.phase === 'ready' && folders.state.value.length === 0 ? <p className="muted">No folders here.</p> : null}
      {folders.state.phase === 'ready' && folders.state.value.length > 0 ? (
        <ul className="connect-list" aria-label="Folders">
          {folders.state.value.map((f) => (
            <li key={f.ref} className="card connect-row">
              <strong>{f.name}</strong>
              <div className="connect-row-end">
                <Button onClick={() => setTrail([...trail, f])} aria-label={`Look inside ${f.name}`}>
                  Look inside
                </Button>
                <Button variant="primary" pending={busy === f.ref} onClick={() => void connect(f)} aria-label={`Connect ${f.name}`}>
                  Connect this folder
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {busy !== undefined ? <Spinner label="Reading the folder" /> : null}
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
    </div>
  );
}

// -- add: a folder on a computer -----------------------------------------------------------------------------------------------

function AddComputer(props: { ws: string; onDone: (id: string, pairing: Pairing) => void; onCancel: () => void }) {
  const { client } = useSession();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>(undefined);
  const create = async () => {
    setBusy(true);
    setProblem(undefined);
    const r = await client.createSourceConnection(props.ws, { kind: 'agent_folder' });
    setBusy(false);
    if (!r.ok) return setProblem(r.problem);
    if (r.value.pairing === undefined) return setProblem({ kind: 'malformed', message: 'XO did not return a pairing code.' });
    props.onDone(r.value.connection.connectionId, r.value.pairing);
  };
  return (
    <div className="stack">
      <h3>Connect a folder on a computer</h3>
      <p>
        Use this when the folder is on someone's own computer and XO runs elsewhere. You get a one-time code; on that computer, the XO agent
        pairs with it and then sends the folder to XO. It only reads the folder, and it only connects out to XO, so nothing on that computer
        needs opening up.
      </p>
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      <div className="row">
        <Button variant="primary" pending={busy} onClick={() => void create()}>
          Get a pairing code
        </Button>
        <Button variant="quiet" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function PairingSteps(props: { pairing: Pairing; serverAddress: string | undefined }) {
  const cmd = agentCommands(props.serverAddress, props.pairing.code);
  return (
    <section className="card sc-pairing" aria-label="Pair the computer">
      <h4>On the computer with the folder</h4>
      <ol>
        <li>Install the XO command-line tool on it.</li>
        <li>
          Pair the folder (the code works once, until {formatWhen(props.pairing.expiresAt)}):
          <pre>
            <code>{cmd.pair}</code>
          </pre>
        </li>
        <li>
          Keep it running, also after a restart:
          <pre>
            <code>{cmd.start}</code>
          </pre>
        </li>
      </ol>
      <p className="small">
        Pairing code: <strong className="sc-code">{props.pairing.code}</strong>
      </p>
      {props.serverAddress === undefined ? (
        <p className="muted small">
          Replace &lt;this XO address&gt; with the address the computer uses to reach XO. Your administrator can set it once
          (XO_PUBLIC_BASE_URL) so it is filled in here.
        </p>
      ) : null}
    </section>
  );
}

// -- detail --------------------------------------------------------------------------------------------------------------------

const PAIRING_POLL_MS = 5000;
const SCHEDULES: readonly { label: string; sync: { mode: 'manual' } | { mode: 'interval'; everyMinutes: number } }[] = [
  { label: 'When someone asks', sync: { mode: 'manual' } },
  { label: 'Every 15 minutes', sync: { mode: 'interval', everyMinutes: 15 } },
  { label: 'Every hour', sync: { mode: 'interval', everyMinutes: 60 } },
  { label: 'Every day', sync: { mode: 'interval', everyMinutes: 1440 } },
];

function ConnectionDetail(props: {
  ws: string;
  id: string;
  role: WorkspaceRole | undefined;
  options: SourceConnectionOptions;
  pairing?: Pairing;
  onBack: () => void;
}) {
  const { client } = useSession();
  const load = useLoad(() => client.getSourceConnection(props.ws, props.id), [props.ws, props.id]);
  const [current, setCurrent] = useState<SourceConnectionDetail | undefined>(undefined);
  const [pairing, setPairing] = useState<Pairing | undefined>(props.pairing);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<ApiProblem | undefined>(undefined);
  const [confirmRetire, setConfirmRetire] = useState(false);
  // The newest of what was loaded and what the last action answered.
  const loaded = loadedValue(load.state);
  const c = current === undefined ? loaded : loaded === undefined || current.revision > loaded.revision ? current : loaded;

  // A folder on a computer: keep looking until the agent pairs and has sent the folder.
  const waiting = c?.kind === 'agent_folder' && (c.agent?.paired !== true || c.lastSync === undefined) && c.retiredAt === undefined;
  const reload = useRef(load.reload);
  reload.current = load.reload;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => reload.current(), PAIRING_POLL_MS);
    return () => clearInterval(t);
  }, [waiting]);
  useEffect(() => {
    if (c?.agent?.paired === true) setPairing(undefined);
  }, [c?.agent?.paired]);

  if (c === undefined)
    return load.state.phase === 'error' ? (
      <div className="stack">
        <ProblemNotice problem={load.state.problem} onRetry={load.reload} />
        <Button variant="quiet" onClick={props.onBack}>
          Back to folders and drives
        </Button>
      </div>
    ) : (
      <Skeleton label="Loading the connection" rows={3} />
    );

  const act = async (
    name: string,
    run: () => Promise<Result<SourceConnectionDetail | { connection: SourceConnectionDetail; pairing?: Pairing }>>,
  ) => {
    setBusy(name);
    setProblem(undefined);
    const r = await run();
    setBusy(undefined);
    if (!r.ok) return setProblem(r.problem);
    if ('connection' in r.value) {
      setCurrent(r.value.connection);
      if (r.value.pairing !== undefined) setPairing(r.value.pairing);
    } else setCurrent(r.value);
  };
  const f = freshnessView(c.freshness);
  const retired = c.retiredAt !== undefined;
  const manage = may(props.role, 'manage') && !retired;
  const author = may(props.role, 'author') && !retired;
  const unpaired = c.kind === 'agent_folder' && c.agent?.paired !== true;

  return (
    <div className="stack">
      <Button variant="quiet" onClick={props.onBack}>
        Back to folders and drives
      </Button>
      <h3>{c.displayName}</h3>
      <p className="muted">
        {KIND_LABEL[c.kind]} · {plural(c.files, 'file')} · read-only
      </p>
      <p>
        <Badge tone={f.tone}>{f.label}</Badge> {f.detail !== undefined ? <span className="small">{f.detail}</span> : null}
      </p>
      {c.kind === 'agent_folder' ? <p role="status">{agentLine(c)}</p> : null}
      {!retired ? <p className="small">{scheduleLine(c)}</p> : null}
      {pairing !== undefined && unpaired ? <PairingSteps pairing={pairing} serverAddress={props.options.agent.serverAddress} /> : null}
      {unpaired && pairing === undefined && manage ? (
        <p className="small">The pairing code is shown once. If it was lost or has expired, make a new one.</p>
      ) : null}
      {c.lastSync !== undefined ? (
        <div className="stack" aria-label="Last sync">
          {syncReportLines(c.lastSync).map((l) => (
            <p key={l} className="small">
              {l}
            </p>
          ))}
        </div>
      ) : null}

      <div className="row" role="group" aria-label="Actions">
        {author && !c.paused && !unpaired ? (
          <Button
            variant="primary"
            pending={busy === 'sync'}
            onClick={() => void act('sync', () => client.syncSourceConnection(props.ws, c.connectionId))}
          >
            Sync now
          </Button>
        ) : null}
        {manage ? (
          <Button
            pending={busy === 'pause'}
            onClick={() => void act('pause', () => client.changeSourceConnection(props.ws, c.connectionId, c.paused ? 'resume' : 'pause'))}
          >
            {c.paused ? 'Resume' : 'Pause'}
          </Button>
        ) : null}
        {manage && c.kind === 'agent_folder' ? (
          <Button pending={busy === 'pair'} onClick={() => void act('pair', () => client.pairSourceAgent(props.ws, c.connectionId))}>
            {unpaired ? 'Make a new pairing code' : 'Pair a different computer'}
          </Button>
        ) : null}
        {manage && !confirmRetire ? (
          <Button variant="danger" onClick={() => setConfirmRetire(true)}>
            Retire
          </Button>
        ) : null}
      </div>
      {c.kind !== 'agent_folder' && manage ? (
        <label className="row">
          Sync{' '}
          <select
            aria-label="How often XO syncs"
            value={c.sync.mode === 'manual' ? 'manual' : String(c.sync.everyMinutes)}
            onChange={(e) => {
              const s = SCHEDULES.find((x) => (x.sync.mode === 'manual' ? 'manual' : String(x.sync.everyMinutes)) === e.target.value);
              if (s !== undefined) void act('schedule', () => client.scheduleSourceConnection(props.ws, c.connectionId, s.sync));
            }}
          >
            {SCHEDULES.map((s) => (
              <option key={s.label} value={s.sync.mode === 'manual' ? 'manual' : String(s.sync.everyMinutes)}>
                {s.label}
              </option>
            ))}
            {c.sync.mode === 'interval' &&
            !SCHEDULES.some(
              (s) => s.sync.mode === 'interval' && s.sync.everyMinutes === (c.sync as { everyMinutes: number }).everyMinutes,
            ) ? (
              <option value={String(c.sync.everyMinutes)}>Every {c.sync.everyMinutes} minutes</option>
            ) : null}
          </select>
        </label>
      ) : null}
      {confirmRetire ? (
        <div className="card stack" role="alertdialog" aria-label="Retire this connection?">
          <p>
            XO stops syncing {c.displayName} and retires every version it holds. Knowledge that cites them is held for review. Nothing is
            changed where the files live{c.kind === 'agent_folder' ? ', and the agent on the computer stops' : ''}.
          </p>
          <div className="row">
            <Button
              variant="danger"
              pending={busy === 'retire'}
              onClick={() =>
                void act('retire', () => client.changeSourceConnection(props.ws, c.connectionId, 'retire')).then(() =>
                  setConfirmRetire(false),
                )
              }
            >
              Retire it
            </Button>
            <Button variant="quiet" onClick={() => setConfirmRetire(false)}>
              Keep it
            </Button>
          </div>
        </div>
      ) : null}
      {busy !== undefined && busy !== 'sync' ? <Spinner label="Working" /> : null}
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}

      {c.proposals.length > 0 ? <Proposals ws={props.ws} connection={c} canDecide={author} onDecided={() => load.reload()} /> : null}

      {c.items.length > 0 ? (
        <details>
          <summary>{plural(c.items.length, 'file')}</summary>
          <ul className="connect-history" aria-label="Files">
            {c.items.slice(0, 200).map((i) => (
              <li key={i.key} className="small">
                {i.key} · {formatBytes(i.sizeBytes)} · {formatWhen(i.modifiedAt)}
              </li>
            ))}
          </ul>
          {c.items.length > 200 ? <p className="muted small">and {c.items.length - 200} more</p> : null}
        </details>
      ) : null}
    </div>
  );
}

function Proposals(props: { ws: string; connection: SourceConnectionDetail; canDecide: boolean; onDecided: () => void }) {
  const { client } = useSession();
  const [problem, setProblem] = useState<ApiProblem | undefined>(undefined);
  const decide = async (proposalId: string, decision: 'confirmed' | 'rejected') => {
    setProblem(undefined);
    const r = await client.decideSourceRole(props.ws, props.connection.connectionId, proposalId, decision);
    if (!r.ok) return setProblem(r.problem);
    props.onDecided();
  };
  return (
    <section className="stack" aria-label="What XO thinks these are">
      <h4>What XO thinks these are</h4>
      <ul className="connect-list">
        {props.connection.proposals.map((p) => (
          <li key={p.proposalId} className="card stack">
            <strong>Looks like {p.label}</strong>
            <ul className="small">
              {p.basis.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
            {p.status === 'confirmed' ? (
              <p className="small">Confirmed{p.changedSinceDecision ? ', but the file changed since' : ''}.</p>
            ) : null}
            {p.status === 'rejected' ? <p className="small">Set aside.</p> : null}
            {p.status === 'proposed' && props.canDecide ? (
              <div className="row">
                <Button onClick={() => void decide(p.proposalId, 'confirmed')}>Yes, that's right</Button>
                <Button variant="quiet" onClick={() => void decide(p.proposalId, 'rejected')}>
                  No
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
    </section>
  );
}
