import { useEffect, useMemo, useRef, useState } from 'react';
import type { Result } from '../platform/client';
import type { ActionResult, AddSourceEntry, ConnectCapabilities, ConnectSource, FolderPreview } from '../platform/wire-connect';
import {
  MAX_RETAINED_ITEMS,
  addSourceLabel,
  buildTree,
  dashboardKnowledgeLine,
  effectsSentence,
  filesUnder,
  plural,
  readSummary,
  removalSentences,
  removeLearnedResult,
  removeLearnedSentences,
  selectionSummary,
  stateView,
  toggleNode,
  triState,
  visibleActions,
  type TreeNode,
} from '../domain/connect';
import { Badge, Button, EmptyState, formatBytes, formatWhen, ProblemNotice, Section, Skeleton, Spinner, useLoad } from './primitives';
import { useSession } from './session';
import '../styles/connect.css';

type Route =
  | { readonly kind: 'list' }
  | { readonly kind: 'add' }
  | { readonly kind: 'detail'; readonly id: string }
  | { readonly kind: 'edit'; readonly id: string };

/**
 * Connect (C7). Everything shown comes from the Connect HTTP contract; nothing is invented or mocked in the app. What is OFFERED follows
 * what the server says the caller may do (`/connect/capabilities`); the server decides every action again when it runs.
 */
export function ConnectSection() {
  const [route, setRoute] = useState<Route>({ kind: 'list' });
  const { client } = useSession();
  const caps = useLoad(() => client.connectCapabilities(), []);
  const capabilities: ConnectCapabilities | undefined = caps.state.phase === 'ready' ? caps.state.value : undefined;
  return (
    <div className="connect-screen">
      {route.kind === 'list' ? <ConnectHome capabilities={capabilities} capsFailed={caps.state.phase === 'error'} go={setRoute} /> : null}
      {route.kind === 'add' ? (
        <FolderWizard onDone={(id) => setRoute({ kind: 'detail', id })} onCancel={() => setRoute({ kind: 'list' })} />
      ) : null}
      {route.kind === 'edit' ? (
        <FolderWizard
          sourceId={route.id}
          onDone={(id) => setRoute({ kind: 'detail', id })}
          onCancel={() => setRoute({ kind: 'detail', id: route.id })}
        />
      ) : null}
      {route.kind === 'detail' ? <SourceDetail id={route.id} capabilities={capabilities} go={setRoute} /> : null}
    </div>
  );
}

// -- home ----------------------------------------------------------------------------------------------------------------------

function ConnectHome(props: { capabilities: ConnectCapabilities | undefined; capsFailed: boolean; go: (r: Route) => void }) {
  const { client } = useSession();
  const dash = useLoad(() => client.connectDashboard(), []);
  const sources = useLoad(() => client.connectSources(), []);
  const catalog = useLoad(() => client.connectCatalog(), []);
  const canManage = props.capabilities?.manageSources === true;
  return (
    <Section title="Connect" lede="Bring your organization's data into XO. XO reads only what you choose, and never changes it.">
      {dash.state.phase === 'ready' ? (
        <div className="connect-stats" aria-label="Summary">
          <div className="card">
            <span className="muted">Connected sources</span>
            <strong>{dash.state.value.connectedSources}</strong>
          </div>
          <div className="card">
            <span className="muted">Needs your attention</span>
            <strong>{dash.state.value.needsAttention}</strong>
          </div>
          <div className="card">
            <span className="muted">Knowledge</span>
            <p>{dashboardKnowledgeLine(dash.state.value)}</p>
          </div>
        </div>
      ) : dash.state.phase === 'error' ? (
        <ProblemNotice problem={dash.state.problem} onRetry={dash.reload} />
      ) : (
        <Skeleton label="Loading summary" rows={1} />
      )}

      <h3>Your sources</h3>
      {sources.state.phase === 'loading' ? <Skeleton label="Loading your sources" rows={2} /> : null}
      {sources.state.phase === 'error' ? <ProblemNotice problem={sources.state.problem} onRetry={sources.reload} /> : null}
      {sources.state.phase === 'ready' && sources.state.value.length === 0 ? (
        <EmptyState title="Connect your first source">Choose a folder on this computer. XO reads only the items you choose.</EmptyState>
      ) : null}
      {sources.state.phase === 'ready' ? (
        <ul className="connect-list">
          {sources.state.value.map((s) => (
            <SourceRow key={s.id} source={s} onOpen={() => props.go({ kind: 'detail', id: s.id })} />
          ))}
        </ul>
      ) : null}

      <h3>Add a source</h3>
      {props.capsFailed ? <p className="muted">XO could not confirm what you may do here, so changing actions are hidden.</p> : null}
      {!props.capsFailed && props.capabilities !== undefined && !canManage ? (
        <p className="muted">You can look at connected sources, but you cannot add or change them.</p>
      ) : null}
      {catalog.state.phase === 'ready' ? (
        <div className="connect-add">
          {catalog.state.value.map((e) => (
            <AddCard key={e.kind} entry={e} canStart={canManage} onStart={() => props.go({ kind: 'add' })} />
          ))}
        </div>
      ) : catalog.state.phase === 'error' ? (
        <ProblemNotice problem={catalog.state.problem} onRetry={catalog.reload} />
      ) : (
        <Skeleton label="Loading" rows={1} />
      )}
    </Section>
  );
}

function AddCard(props: { entry: AddSourceEntry; canStart: boolean; onStart: () => void }) {
  const v = addSourceLabel(props.entry);
  return (
    <div className="card connect-add-card">
      <h4>{v.title}</h4>
      <p className="muted">{props.entry.note}</p>
      {v.canStart ? (
        <Button variant="primary" disabled={!props.canStart} onClick={props.onStart}>
          Choose folder
        </Button>
      ) : (
        <Badge tone="neutral">Coming soon</Badge>
      )}
    </div>
  );
}

function SourceRow(props: { source: ConnectSource; onOpen: () => void }) {
  const v = stateView(props.source);
  return (
    <li className="card connect-row">
      <div>
        <strong>{props.source.displayName}</strong>
        <p className="muted">
          {plural(props.source.selection.includedItems, 'item')} chosen · read-only
          {props.source.lastReadAt !== undefined ? ` · last read ${formatWhen(props.source.lastReadAt)}` : ''}
        </p>
        <p className="small">{v.summary}</p>
      </div>
      <div className="connect-row-end">
        <Badge tone={v.tone}>{v.label}</Badge>
        <Button onClick={props.onOpen}>Open</Button>
      </div>
    </li>
  );
}

// -- wizard --------------------------------------------------------------------------------------------------------------------

function FolderWizard(props: { sourceId?: string; onDone: (id: string) => void; onCancel: () => void }) {
  const { client } = useSession();
  const editing = props.sourceId !== undefined;
  const [root, setRoot] = useState('');
  const [preview, setPreview] = useState<FolderPreview | undefined>(undefined);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<'listing' | 'saving' | undefined>(editing ? 'listing' : undefined);
  const [problem, setProblem] = useState<Extract<Result<unknown>, { ok: false }>['problem'] | undefined>(undefined);
  const [query, setQuery] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (!editing || started.current) return;
    started.current = true;
    void client.connectSourceFolder(props.sourceId as string).then((r) => {
      setBusy(undefined);
      if (!r.ok) return setProblem(r.problem);
      setPreview(r.value.preview);
      setSelected(new Set(r.value.selectedKeys));
    });
  }, [client, editing, props.sourceId]);

  const list = async (): Promise<void> => {
    setBusy('listing');
    setProblem(undefined);
    const r = await client.connectPreviewFolder(root.trim());
    setBusy(undefined);
    if (!r.ok) return setProblem(r.problem);
    setPreview(r.value);
    setSelected(new Set()); // never preselect
  };

  const save = async (): Promise<void> => {
    setBusy('saving');
    setProblem(undefined);
    const keys = [...selected];
    const r: Result<ActionResult> = editing
      ? await client.connectSelection(props.sourceId as string, keys)
      : await client.connectFolder(root.trim(), keys);
    setBusy(undefined);
    if (!r.ok) return setProblem(r.problem);
    props.onDone(r.value.source.id);
  };

  const tree = useMemo(() => (preview === undefined ? undefined : buildTree(preview.entries)), [preview]);
  const summary = preview === undefined ? { files: 0, bytes: 0 } : selectionSummary(preview.entries, selected);
  const tooMany = summary.files > MAX_RETAINED_ITEMS;

  return (
    <Section
      title={editing ? 'Change what XO reads' : 'Choose what XO may read'}
      lede="Nothing is read until you confirm, and nothing is chosen until you choose it."
    >
      {preview === undefined ? (
        <div className="stack">
          {!editing ? (
            <>
              <label htmlFor="connect-root">Folder on this computer</label>
              <input
                id="connect-root"
                className="input"
                value={root}
                onChange={(e) => setRoot(e.target.value)}
                placeholder="/path/to/the/folder"
                autoComplete="off"
              />
              <p className="muted small">
                Enter the full path of one folder. XO lists the names inside it so you can choose; it reads no file content yet.
              </p>
            </>
          ) : null}
          {busy === 'listing' ? <Spinner label="Listing the folder" /> : null}
          {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
          <div className="row">
            {!editing ? (
              <Button variant="primary" pending={busy === 'listing'} disabled={root.trim().length === 0} onClick={() => void list()}>
                List folder
              </Button>
            ) : null}
            <Button variant="quiet" onClick={props.onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="stack">
          <input
            className="input"
            aria-label="Search names"
            placeholder="Search names"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {preview.truncated ? (
            <p className="notice notice-warning">
              The listing is incomplete (a limit was reached). Choose from what is shown, or narrow the folder.
            </p>
          ) : null}
          {tree !== undefined ? (
            <div className="connect-tree" role="tree" aria-label="Folder contents">
              <TreeView node={tree} selected={selected} onChange={setSelected} query={query.trim().toLowerCase()} />
            </div>
          ) : null}
          <p aria-live="polite">
            {summary.files === 0 ? 'Nothing chosen yet.' : `${plural(summary.files, 'item')} chosen (${formatBytes(summary.bytes)}).`}{' '}
            <span className="muted">Only items XO can read as text can be chosen.</span>
          </p>
          {tooMany ? <p className="notice notice-warning">XO can keep up to {MAX_RETAINED_ITEMS} items per source. Choose fewer.</p> : null}
          {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
          <div className="row">
            <Button variant="primary" pending={busy === 'saving'} disabled={summary.files === 0 || tooMany} onClick={() => void save()}>
              {editing ? 'Save selection' : 'Confirm selection'}
            </Button>
            <Button variant="quiet" onClick={props.onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

function TreeView(props: { node: TreeNode; selected: ReadonlySet<string>; onChange: (s: ReadonlySet<string>) => void; query: string }) {
  const { node, selected, onChange, query } = props;
  const matches = (n: string): boolean => query === '' || n.toLowerCase().includes(query);
  return (
    <ul role="group" className="connect-tree-list">
      {node.folders.map((f) => {
        if (query !== '' && !matches(f.name) && !filesUnder(f).some((x) => matches(x.name))) return null;
        const tri = triState(f, selected);
        return (
          <li key={f.path} role="treeitem" aria-expanded="true">
            <label>
              <input
                type="checkbox"
                checked={tri === 'all'}
                ref={(el) => {
                  if (el !== null) el.indeterminate = tri === 'some';
                }}
                disabled={filesUnder(f).every((x) => !x.contentAcquirable)}
                onChange={() => onChange(toggleNode(f, selected))}
              />{' '}
              <strong>{f.name}</strong> <span className="muted">({plural(filesUnder(f).length, 'file')})</span>
            </label>
            <TreeView node={f} selected={selected} onChange={onChange} query={query} />
          </li>
        );
      })}
      {node.files
        .filter((x) => matches(x.name) || query === '')
        .map((x) => (
          <li key={x.key} role="treeitem">
            <label>
              <input
                type="checkbox"
                checked={selected.has(x.key)}
                disabled={!x.contentAcquirable}
                onChange={() => {
                  const next = new Set(selected);
                  if (next.has(x.key)) next.delete(x.key);
                  else next.add(x.key);
                  onChange(next);
                }}
              />{' '}
              {x.name} <span className="muted">{formatBytes(x.sizeBytes)}</span>
              {!x.contentAcquirable ? <span className="muted"> · XO cannot read this type as text</span> : null}
            </label>
          </li>
        ))}
    </ul>
  );
}

// -- detail --------------------------------------------------------------------------------------------------------------------

function SourceDetail(props: { id: string; capabilities: ConnectCapabilities | undefined; go: (r: Route) => void }) {
  const { client } = useSession();
  const load = useLoad(() => client.connectSource(props.id), [props.id]);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<Extract<Result<unknown>, { ok: false }>['problem'] | undefined>(undefined);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removeItems, setRemoveItems] = useState(false);

  if (load.state.phase === 'loading') return <Skeleton label="Loading this source" rows={3} />;
  if (load.state.phase === 'error' && load.state.stale === undefined)
    return <ProblemNotice problem={load.state.problem} onRetry={load.reload} />;
  const source = load.state.phase === 'ready' ? load.state.value : load.state.phase === 'error' ? load.state.stale : undefined;
  if (source === undefined) return <Skeleton label="Loading this source" rows={3} />;

  const view = stateView(source);
  const actions = visibleActions(view, props.capabilities);
  const run = async (name: string, fn: () => Promise<Result<ActionResult>>): Promise<void> => {
    setBusy(name);
    setProblem(undefined);
    const r = await fn();
    setBusy(undefined);
    if (!r.ok) return setProblem(r.problem);
    setNote(effectsSentence(r.value.effects));
    load.reload();
  };
  const lastRead = [...(source.history ?? [])].reverse().find((h) => h.kind === 'read')?.read;

  return (
    <Section
      title={source.displayName}
      lede="Read-only: XO never edits, moves or deletes anything in this folder."
      actions={
        <Button variant="quiet" onClick={() => props.go({ kind: 'list' })}>
          Back to Connect
        </Button>
      }
    >
      <div className="row">
        <Badge tone={view.tone}>{view.label}</Badge>
        <span>{view.summary}</span>
      </div>
      {load.state.phase === 'error' ? <ProblemNotice problem={load.state.problem} onRetry={load.reload} /> : null}
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      {note !== undefined ? (
        <p className="notice" role="status">
          {note}
        </p>
      ) : null}
      {props.capabilities !== undefined && !props.capabilities.manageSources ? (
        <p className="muted">You can look at this source, but you cannot change it.</p>
      ) : null}

      <div className="row">
        {actions.includes('read') ? (
          <Button variant="primary" pending={busy === 'read'} onClick={() => void run('read', () => client.connectRead(source.id))}>
            Read now
          </Button>
        ) : null}
        {actions.includes('check') ? (
          <Button pending={busy === 'check'} onClick={() => void run('check', () => client.connectCheck(source.id))}>
            Check again
          </Button>
        ) : null}
        {actions.includes('change_selection') ? (
          <Button onClick={() => props.go({ kind: 'edit', id: source.id })}>Change what XO reads</Button>
        ) : null}
        {actions.includes('disconnect') ? (
          <Button pending={busy === 'disconnect'} onClick={() => void run('disconnect', () => client.connectDisconnect(source.id))}>
            Disconnect
          </Button>
        ) : null}
        {actions.includes('reconnect') ? (
          <Button
            variant="primary"
            pending={busy === 'reconnect'}
            onClick={() => void run('reconnect', () => client.connectReconnect(source.id))}
          >
            Reconnect
          </Button>
        ) : null}
        {actions.includes('change_selection') ? <Button onClick={() => setRemoveItems(true)}>Remove what XO learned…</Button> : null}
        {actions.includes('remove') ? (
          <Button variant="danger" onClick={() => setConfirmRemove(true)}>
            Remove source…
          </Button>
        ) : null}
      </div>
      {busy === 'read' ? <Spinner label="Reading" /> : null}
      {lastRead !== undefined ? (
        <p>
          <strong>Last read:</strong> {readSummary(lastRead)}
        </p>
      ) : null}

      {removeItems ? (
        <RemoveLearnedPanel
          id={source.id}
          onCancel={() => setRemoveItems(false)}
          onDone={(text) => {
            setRemoveItems(false);
            setNote(text);
            load.reload();
          }}
        />
      ) : null}
      {confirmRemove ? (
        <RemoveDialog
          id={source.id}
          name={source.displayName}
          onCancel={() => setConfirmRemove(false)}
          onRemoved={() => props.go({ kind: 'list' })}
        />
      ) : null}

      <h3>History</h3>
      {(source.history ?? []).length === 0 ? <p className="muted">Nothing yet.</p> : null}
      <ul className="connect-history">
        {[...(source.history ?? [])].reverse().map((h, i) => (
          <li key={`${h.at}-${i}`}>
            <span className="muted">{formatWhen(h.at)}</span>{' '}
            {h.kind === 'read' && h.read !== undefined
              ? readSummary(h.read)
              : h.kind === 'connected'
                ? `Connected with ${plural(h.includedItems ?? 0, 'chosen item')}.`
                : h.kind === 'learned_removed'
                  ? `Removed what XO learned from items (${plural(h.retired ?? 0, 'piece')} of evidence retired).`
                  : h.kind === 'selection_changed'
                    ? `Selection changed to ${plural(h.includedItems ?? 0, 'chosen item')}.`
                    : h.kind === 'disconnected'
                      ? 'Disconnected.'
                      : 'Reconnected.'}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function RemoveDialog(props: { id: string; name: string; onCancel: () => void; onRemoved: () => void }) {
  const { client } = useSession();
  const preview = useLoad(() => client.connectRemovalPreview(props.id), [props.id]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Extract<Result<unknown>, { ok: false }>['problem'] | undefined>(undefined);
  const remove = async (): Promise<void> => {
    setBusy(true);
    const r = await client.connectRemove(props.id);
    setBusy(false);
    if (!r.ok) return setProblem(r.problem);
    props.onRemoved();
  };
  return (
    <div className="notice notice-danger" role="alertdialog" aria-label={`Remove ${props.name}`}>
      <strong>Remove {props.name}?</strong>
      {preview.state.phase === 'loading' ? <Spinner label="Checking what removal affects" /> : null}
      {preview.state.phase === 'error' ? <ProblemNotice problem={preview.state.problem} onRetry={preview.reload} /> : null}
      {preview.state.phase === 'ready' ? removalSentences(preview.state.value).map((s) => <p key={s}>{s}</p>) : null}
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      <div className="row">
        <Button variant="quiet" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button variant="danger" pending={busy} disabled={preview.state.phase !== 'ready'} onClick={() => void remove()}>
          Remove source
        </Button>
      </div>
    </div>
  );
}

function RemoveLearnedPanel(props: { id: string; onCancel: () => void; onDone: (text: string) => void }) {
  const { client } = useSession();
  const folder = useLoad(() => client.connectSourceFolder(props.id), [props.id]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Extract<Result<unknown>, { ok: false }>['problem'] | undefined>(undefined);
  if (folder.state.phase === 'loading') return <Spinner label="Listing your selected items" />;
  if (folder.state.phase === 'error') return <ProblemNotice problem={folder.state.problem} onRetry={folder.reload} />;
  const chosen = folder.state.value.preview.entries.filter(
    (e) => folder.state.phase === 'ready' && folder.state.value.selectedKeys.includes(e.key),
  );
  const run = async (): Promise<void> => {
    setBusy(true);
    setProblem(undefined);
    const r = await client.connectRemoveLearned(props.id, [...picked]);
    setBusy(false);
    if (!r.ok) return setProblem(r.problem);
    props.onDone(removeLearnedResult(r.value));
  };
  return (
    <div className="notice notice-danger" role="alertdialog" aria-label="Remove what XO learned">
      <strong>Remove what XO learned from selected items</strong>
      {chosen.length === 0 ? <p>No items are selected right now.</p> : null}
      <ul className="connect-tree-list">
        {chosen.map((e) => (
          <li key={e.key}>
            <label>
              <input
                type="checkbox"
                checked={picked.has(e.key)}
                onChange={() => {
                  const next = new Set(picked);
                  if (next.has(e.key)) next.delete(e.key);
                  else next.add(e.key);
                  setPicked(next);
                }}
              />{' '}
              {e.key}
            </label>
          </li>
        ))}
      </ul>
      {picked.size > 0 ? removeLearnedSentences(picked.size).map((t) => <p key={t}>{t}</p>) : null}
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      <div className="row">
        <Button variant="quiet" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button variant="danger" pending={busy} disabled={picked.size === 0} onClick={() => void run()}>
          Remove what XO learned
        </Button>
      </div>
    </div>
  );
}
