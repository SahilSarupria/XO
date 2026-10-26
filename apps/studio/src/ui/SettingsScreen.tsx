import { useState, type ReactNode } from 'react';
import { can, roleLabel, whyNot } from '../domain/access';
import type { ApiProblem } from '../platform/client';
import type { Workspace } from '../platform/wire';
import type { RuntimeStatus, SettingsView } from '../platform/wire-studio';
import { MembersPanel } from './MembersPanel';
import { Badge, Button, formatWhen, loadedValue, ProblemNotice, Skeleton, useLoad } from './primitives';
import { useSession, type Mode } from './session';
import { useTheme, type Theme } from './theme';

export const SETTINGS_TABS = [
  'General',
  'Members',
  'Models and runtime',
  'Data and residency',
  'Trust and signing',
  'Notifications',
] as const;
export type Tab = (typeof SETTINGS_TABS)[number];
const TABS = SETTINGS_TABS;

const LOCATIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'this_computer', label: 'This computer' },
  { id: 'private_server', label: 'Private server' },
  { id: 'cloud', label: 'Cloud' },
];

const STATUS_TONE = { online: 'success', degraded: 'warning', offline: 'danger' } as const;

/**
 * Settings. Everything here is read from and saved to the platform. The platform reports, for each setting, whether it
 * is ENFORCED or only DECLARED, and this screen repeats that wording instead of improving on it: residency is a
 * declaration, "require signed packages" is a presence check (nothing verifies signatures), and runtime location can
 * only be one the deployment offers. Saving is guarded by the revision the screen loaded, so a change made elsewhere is
 * reported rather than overwritten.
 */
export function SettingsScreen(props: { workspace: Workspace; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(props.initialTab ?? 'General');
  return (
    <section className="section" aria-labelledby="settings-h">
      <h2 id="settings-h" className="visually-hidden">
        Settings
      </h2>
      <div className="settings">
        <div className="settings-nav" role="tablist" aria-label="Settings sections">
          <p className="settings-title" aria-hidden="true">
            Settings
          </p>
          {TABS.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>
        <div className="settings-body" role="tabpanel" aria-label={tab}>
          {tab === 'General' ? <GeneralTab workspace={props.workspace} /> : null}
          {tab === 'Members' ? (
            <MembersPanel
              workspaceId={props.workspace.workspaceId}
              role={props.workspace.role}
              personal={props.workspace.kind === 'personal'}
            />
          ) : null}
          {tab === 'Models and runtime' ? <ModelsTab workspace={props.workspace} /> : null}
          {tab === 'Data and residency' ? <ResidencyTab workspace={props.workspace} /> : null}
          {tab === 'Trust and signing' ? <TrustTab workspace={props.workspace} /> : null}
          {tab === 'Notifications' ? <NotificationsTab workspace={props.workspace} /> : null}
        </div>
      </div>
    </section>
  );
}

function GeneralTab(props: { workspace: Workspace }) {
  const { mode, setMode } = useSession();
  const [theme, setTheme] = useTheme();
  const modes: readonly Mode[] = ['user', 'builder'];
  const w = props.workspace;
  return (
    <>
      <h3>Detail level</h3>
      <p className="muted small">
        User mode keeps to plain language. Builder mode adds technical screens. Neither changes what you are allowed to do.
      </p>
      <div className="radio-list" role="radiogroup" aria-label="Detail level">
        {modes.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} className="radio-row" onClick={() => setMode(m)}>
            <span className="radio-dot" aria-hidden="true" />
            {m === 'user' ? 'User mode' : 'Builder mode'}
          </button>
        ))}
      </div>
      <h3>Appearance</h3>
      <div className="radio-list" role="radiogroup" aria-label="Theme">
        {(['dark', 'light'] as const satisfies readonly Theme[]).map((t) => (
          <button key={t} type="button" role="radio" aria-checked={theme === t} className="radio-row" onClick={() => setTheme(t)}>
            <span className="radio-dot" aria-hidden="true" />
            {t === 'dark' ? 'Dark theme' : 'Light theme'}
          </button>
        ))}
      </div>
      <h3>Workspace</h3>
      <dl className="xoi-dl">
        <div className="xoi-dl-row">
          <dt>Name</dt>
          <dd>{w.name ?? 'Untitled workspace'}</dd>
        </div>
        {w.kind !== undefined ? (
          <div className="xoi-dl-row">
            <dt>Type</dt>
            <dd>{w.kind === 'personal' ? 'Personal (one person)' : 'Team'}</dd>
          </div>
        ) : null}
        {w.memberCount !== undefined ? (
          <div className="xoi-dl-row">
            <dt>Members</dt>
            <dd>{w.memberCount}</dd>
          </div>
        ) : null}
        <div className="xoi-dl-row">
          <dt>Declared region</dt>
          <dd>{w.regionLabel ?? w.region ?? 'Not set'}</dd>
        </div>
        {w.role !== undefined ? (
          <div className="xoi-dl-row">
            <dt>Your role</dt>
            <dd>{roleLabel(w.role)}</dd>
          </div>
        ) : null}
      </dl>
    </>
  );
}

/** Shared load + save wiring for the tabs that edit platform settings. */
function useSettingsEditor(workspace: Workspace) {
  const { client } = useSession();
  const view = useLoad(() => client.getSettings(workspace.workspaceId), [client, workspace.workspaceId]);
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const canEdit = can(workspace.role, 'manage');
  const current = loadedValue(view.state);

  async function save(patch: Record<string, unknown>) {
    if (current === undefined) return;
    setSaving(true);
    setProblem(undefined);
    setNotice(undefined);
    const r = await client.updateSettings(workspace.workspaceId, { expectedRevision: current.settings.revision, ...patch });
    setSaving(false);
    if (r.ok) {
      setNotice('Saved.');
      view.reload();
      return;
    }
    if (r.problem.reason === 'stale_revision') {
      setNotice('These settings were changed by someone else, so nothing was saved. The latest values are shown; make your change again.');
      view.reload();
      return;
    }
    setProblem(r.problem);
  }
  return {
    view,
    current,
    problem,
    saving,
    notice,
    canEdit,
    save,
    editHint: canEdit ? undefined : whyNot(workspace.role, 'manage', 'changing settings'),
  };
}

function Feedback(props: { ed: ReturnType<typeof useSettingsEditor> }) {
  const { ed } = props;
  return (
    <>
      {ed.view.state.phase === 'loading' ? <Skeleton label="Loading settings" rows={3} /> : null}
      {ed.view.state.phase === 'error' ? <ProblemNotice problem={ed.view.state.problem} onRetry={ed.view.reload} /> : null}
      {ed.problem !== undefined ? <ProblemNotice problem={ed.problem} /> : null}
      {ed.notice !== undefined ? (
        <p className="notice notice-info small" role="status">
          {ed.notice}
        </p>
      ) : null}
      {ed.editHint !== undefined && ed.current !== undefined ? <p className="muted small">{ed.editHint}</p> : null}
    </>
  );
}

function SaveRow(props: { ed: ReturnType<typeof useSettingsEditor>; dirty: boolean; onSave: () => void }) {
  return (
    <div className="card-actions">
      <Button
        variant="primary"
        onClick={props.onSave}
        disabled={!props.ed.canEdit || props.ed.saving || !props.dirty}
        title={props.ed.editHint}
      >
        {props.ed.saving ? 'Saving…' : 'Save changes'}
      </Button>
    </div>
  );
}

function RuntimeStatusCard(props: { workspaceId: string }) {
  const { client } = useSession();
  const status = useLoad(() => client.getRuntimeStatus(props.workspaceId), [client, props.workspaceId]);
  const s: RuntimeStatus | undefined = loadedValue(status.state);
  return (
    <section className="xoi-card" aria-labelledby="runtime-status-h">
      <div className="row between">
        <h3 id="runtime-status-h">Runtime status</h3>
        {s !== undefined ? (
          <Badge tone={STATUS_TONE[s.status]}>{s.status === 'online' ? 'Online' : s.status === 'degraded' ? 'Degraded' : 'Offline'}</Badge>
        ) : null}
      </div>
      {status.state.phase === 'loading' ? <Skeleton label="Checking the runtime" rows={2} /> : null}
      {status.state.phase === 'error' ? <ProblemNotice problem={status.state.problem} onRetry={status.reload} /> : null}
      {s !== undefined ? (
        <>
          <p className="small">
            {s.mountedPackages} {s.mountedPackages === 1 ? 'XO' : 'XOs'} installed · {s.capabilityCount}{' '}
            {s.capabilityCount === 1 ? 'capability' : 'capabilities'} · checked {formatWhen(s.checkedAt)}
          </p>
          <p className="muted small">
            “Online” means this server answered and the workspace runtime started. It does not say a model is reachable.
            {s.modelUsable ? ' A model is selected and has credentials on the server.' : ' No usable model is selected for this workspace.'}
          </p>
          {s.warnings.length > 0 ? (
            <ul className="bare-list small" aria-label="Runtime warnings">
              {s.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      <Button variant="quiet" onClick={status.reload}>
        Check again
      </Button>
    </section>
  );
}

function ModelsTab(props: { workspace: Workspace }) {
  const ed = useSettingsEditor(props.workspace);
  return (
    <>
      <RuntimeStatusCard workspaceId={props.workspace.workspaceId} />
      <Feedback ed={ed} />
      {ed.current !== undefined ? <ModelsForm key={ed.current.settings.revision} view={ed.current} ed={ed} /> : null}
    </>
  );
}

function ModelsForm(props: { view: SettingsView; ed: ReturnType<typeof useSettingsEditor> }) {
  const { settings, effect } = props.view;
  const [location, setLocation] = useState(settings.runtimeLocation);
  const [primary, setPrimary] = useState(settings.primary ?? { provider: '', model: '' });
  const [fallback, setFallback] = useState(settings.fallback ?? { provider: '', model: '' });
  const [airGapped, setAirGapped] = useState(settings.airGapped);
  const choice = (c: { provider: string; model: string }) => (c.provider === '' ? null : { provider: c.provider, model: c.model.trim() });
  const dirty =
    location !== settings.runtimeLocation ||
    airGapped !== settings.airGapped ||
    JSON.stringify(choice(primary)) !== JSON.stringify(settings.primary) ||
    JSON.stringify(choice(fallback)) !== JSON.stringify(settings.fallback);
  const off = !props.ed.canEdit || props.ed.saving;
  const modelField = (label: string, value: { provider: string; model: string }, set: (v: { provider: string; model: string }) => void) => (
    <div className="field-row">
      <label className="field">
        {label} provider
        <select value={value.provider} disabled={off} onChange={(e) => set({ ...value, provider: e.target.value })}>
          <option value="">None</option>
          {effect.providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}
              {p.local ? ' (runs locally)' : ''}
              {p.configured ? '' : ' — no credentials on the server'}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        {label} model
        <input
          value={value.model}
          disabled={off || value.provider === ''}
          onChange={(e) => set({ ...value, model: e.target.value })}
          autoComplete="off"
        />
      </label>
    </div>
  );
  return (
    <>
      <h3>Where XOs run</h3>
      <div className="radio-list" role="radiogroup" aria-label="Where XOs run">
        {LOCATIONS.map((l) => {
          const available = effect.availableLocations.includes(l.id);
          return (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={location === l.id}
              aria-disabled={!available || off}
              disabled={!available || off}
              title={available ? undefined : 'This deployment does not offer it'}
              className="radio-row"
              onClick={() => setLocation(l.id)}
            >
              <span className="radio-dot" aria-hidden="true" />
              {l.label}
              {available ? null : <span className="muted small"> · not offered by this deployment</span>}
            </button>
          );
        })}
      </div>
      <h3>Model</h3>
      <p className="muted small">
        Used by Ask XO. Studio never asks for or stores a key: a provider works only if the server has its credentials.
      </p>
      {modelField('Primary', primary, setPrimary)}
      {modelField('Fallback', fallback, setFallback)}
      <label className="radio-row">
        <input type="checkbox" checked={airGapped} disabled={off} onChange={(e) => setAirGapped(e.target.checked)} /> Air-gapped mode
      </label>
      <p className="muted small">
        Blocks importing from a link and any model that runs off this machine. Only a local model can be selected while it is on. It does
        not stop the platform software itself from being reached by the network.
      </p>
      <SaveRow
        ed={props.ed}
        dirty={dirty}
        onSave={() =>
          void props.ed.save({
            runtime: { location },
            model: { primary: choice(primary), fallback: choice(fallback) },
            airGapped,
          })
        }
      />
    </>
  );
}

function ResidencyTab(props: { workspace: Workspace }) {
  const { client } = useSession();
  const ed = useSettingsEditor(props.workspace);
  const regions = useLoad(() => client.listRegions(), [client]);
  return (
    <>
      <h3>Data residency</h3>
      <Feedback ed={ed} />
      {ed.current !== undefined ? (
        <ResidencyForm
          key={ed.current.settings.revision}
          view={ed.current}
          ed={ed}
          regions={loadedValue(regions.state) ?? []}
          regionsProblem={regions.state.phase === 'error' ? regions.state.problem : undefined}
        />
      ) : null}
    </>
  );
}

function ResidencyForm(props: {
  view: SettingsView;
  ed: ReturnType<typeof useSettingsEditor>;
  regions: readonly { id: string; label: string }[];
  regionsProblem: ApiProblem | undefined;
}) {
  const [region, setRegion] = useState(props.view.settings.region ?? '');
  return (
    <>
      <p className="notice notice-info small">{props.view.effect.residencyNote}</p>
      {props.regionsProblem !== undefined ? <ProblemNotice problem={props.regionsProblem} /> : null}
      <label className="field">
        Required region
        <select value={region} disabled={!props.ed.canEdit || props.ed.saving} onChange={(e) => setRegion(e.target.value)}>
          <option value="" disabled={props.view.settings.region !== null}>
            Not set
          </option>
          {props.regions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <SaveRow
        ed={props.ed}
        dirty={region !== (props.view.settings.region ?? '') && region !== ''}
        onSave={() => void props.ed.save({ region })}
      />
    </>
  );
}

function TrustTab(props: { workspace: Workspace }) {
  const ed = useSettingsEditor(props.workspace);
  return (
    <>
      <h3>Trust and signing</h3>
      <Feedback ed={ed} />
      {ed.current !== undefined ? <TrustForm key={ed.current.settings.revision} view={ed.current} ed={ed} /> : null}
    </>
  );
}

function TrustForm(props: { view: SettingsView; ed: ReturnType<typeof useSettingsEditor> }) {
  const [required, setRequired] = useState(props.view.settings.requireSignedPackages);
  return (
    <>
      <label className="radio-row">
        <input
          type="checkbox"
          checked={required}
          disabled={!props.ed.canEdit || props.ed.saving}
          onChange={(e) => setRequired(e.target.checked)}
        />{' '}
        Require packages to carry a signature
      </label>
      <p className="notice notice-warning small">{props.view.effect.signedPackagesNote}</p>
      <Row
        label="Verifying who signed a package"
        status="Not available"
        note="XO does not check signatures or know whose key is whose, so a signed package is not shown as verified anywhere in Studio."
      />
      <Row label="Compiler attestation" status="Not available" note="This platform has no compiler-attestation facility." />
      <SaveRow
        ed={props.ed}
        dirty={required !== props.view.settings.requireSignedPackages}
        onSave={() => void props.ed.save({ trust: { requireSignedPackages: required } })}
      />
    </>
  );
}

function Row(props: { label: string; status: string; note: ReactNode }) {
  return (
    <div className="xoi-card">
      <div className="row between">
        <strong>{props.label}</strong>
        <Badge tone="neutral">{props.status}</Badge>
      </div>
      <p className="muted small">{props.note}</p>
    </div>
  );
}

function NotificationsTab(props: { workspace: Workspace }) {
  const ed = useSettingsEditor(props.workspace);
  return (
    <>
      <h3>Notifications</h3>
      <p className="muted small">Notifications appear inside Studio (in the Inbox). There is no email, push or webhook delivery.</p>
      <Feedback ed={ed} />
      {ed.current !== undefined ? <NotificationsForm key={ed.current.settings.revision} view={ed.current} ed={ed} /> : null}
    </>
  );
}

function NotificationsForm(props: { view: SettingsView; ed: ReturnType<typeof useSettingsEditor> }) {
  const n = props.view.settings.notifications;
  const [v, setV] = useState(n);
  const off = !props.ed.canEdit || props.ed.saving;
  const items: ReadonlyArray<[keyof typeof n, string]> = [
    ['onEscalation', 'When something needs a person to decide'],
    ['onRunFailure', 'When a run fails'],
    ['onWorkflowComplete', 'When a process finishes'],
  ];
  return (
    <>
      {items.map(([key, label]) => (
        <label key={key} className="radio-row">
          <input type="checkbox" checked={v[key]} disabled={off} onChange={(e) => setV({ ...v, [key]: e.target.checked })} /> {label}
        </label>
      ))}
      <SaveRow ed={props.ed} dirty={JSON.stringify(v) !== JSON.stringify(n)} onSave={() => void props.ed.save({ notifications: v })} />
    </>
  );
}
