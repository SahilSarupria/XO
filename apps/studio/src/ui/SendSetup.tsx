import { useEffect, useRef, useState } from 'react';
import { EMPTY_SEND, buildSendBinding, readSendBinding, sendProblems, withBinding, type SendValues } from '../domain/sendSetup';
import { can, whyNot } from '../domain/access';
import type { ApiProblem } from '../platform/client';
import { useQuery, wsKey } from '../platform/query';
import type { EmailAccount } from '../platform/wire-send';
import type { WorkspaceRole } from '../platform/wire';
import { Banner, Button, Card, Checkbox, Field, FieldMapper, RadioGroup, Select, Skeleton, TextField, type MapperRow } from './kit';
import { ProblemNotice, formatWhen, loadedValue } from './primitives';
import { useSession } from './session';

const ROWS: readonly MapperRow[] = [
  {
    key: 'to',
    label: 'Who it goes to',
    hint: 'The column that holds each person’s email address. XO writes only to people in a list you confirmed.',
    allowText: false,
  },
  { key: 'subject', label: 'Subject', allowText: true },
  { key: 'body', label: 'Message', allowText: true, multiline: true },
];
const POLL_MS = 4000;
const PROVIDER_NAME: Record<EmailAccount['provider'], string> = {
  google: 'Gmail',
  microsoft: 'Outlook or Microsoft 365',
  smtp: 'Email account',
};

/**
 * The send set-up of a workflow: the account it sends from, and where the address, subject, message and each person's document come
 * from (ADR 0049). Saving changes how XO acts, so the platform asks for the manage role and a recent sign-in; Studio shows what it
 * answers and keeps the choices on screen.
 */
export function SendSetup(props: {
  workspaceId: string;
  definitionId: string;
  /** The steps of the workflow: the name XO knows each by and how it reads to a person. */
  steps: readonly { readonly name: string; readonly label: string }[];
  role: WorkspaceRole | undefined;
  onSaved: () => void;
}) {
  const { client } = useSession();
  const ws = props.workspaceId;
  const accounts = useQuery(wsKey(ws, 'email-accounts'), () => client.emailAccounts(ws));
  const bindings = useQuery(wsKey(ws, 'connector-bindings'), () => client.getBindings(ws));
  const sources = useQuery(wsKey(ws, `item-sources/${props.definitionId}`), () => client.itemSources(ws, props.definitionId));
  const bound = loadedValue(bindings.state);
  const columns = loadedValue(sources.state)?.fieldsUsed ?? [];
  const sending = props.steps.filter((s) => /send|mail|message|notify|tell|inform/i.test(`${s.name} ${s.label}`));

  const [capability, setCapability] = useState('');
  const [account, setAccount] = useState<string | undefined>(undefined);
  const [values, setValues] = useState<SendValues>(EMPTY_SEND);
  const [attach, setAttach] = useState(false);
  const [shown, setShown] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>(undefined);
  const [saved, setSaved] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);

  const existing = bound?.bindings.find((b) => b.adapter === 'email' && (capability === '' || b.capability === capability));
  // Pick the step once: the one already set up, else the only one that reads like sending, else the person chooses.
  useEffect(() => {
    if (capability !== '' || bound === undefined) return;
    const e = bound.bindings.find((b) => b.adapter === 'email' && props.steps.some((s) => s.name === b.capability));
    const pick = e?.capability ?? (sending.length === 1 ? sending[0]!.name : props.steps.length === 1 ? props.steps[0]!.name : '');
    if (pick !== '') setCapability(pick);
  }, [bound, capability, props.steps, sending]);
  // Show what is already saved for the chosen step, once per step.
  const shownFor = useRef('');
  useEffect(() => {
    if (capability === '' || bound === undefined || shownFor.current === capability) return;
    shownFor.current = capability;
    const b = bound.bindings.find((x) => x.adapter === 'email' && x.capability === capability);
    const r = readSendBinding(b);
    setValues(r.values);
    setAttach(r.attachDocument);
    setAccount(b?.credentialId);
    setSaved(undefined);
    setShown(true);
  }, [capability, bound]);

  const active = (loadedValue(accounts.state) ?? []).filter((a) => a.state === 'active');
  const chosenAccount = account ?? (active.length === 1 ? active[0]!.credentialId : undefined);
  const errors = tried ? sendProblems(values, chosenAccount, capability) : {};
  const allowed = can(props.role, 'manage');

  const save = async () => {
    setTried(true);
    setSaved(undefined);
    if (bound === undefined || chosenAccount === undefined || Object.keys(sendProblems(values, chosenAccount, capability)).length > 0)
      return;
    setBusy(true);
    setProblem(undefined);
    const next = buildSendBinding({ capability, credentialId: chosenAccount, values, attachDocument: attach });
    const r = await client.putBindings(ws, withBinding(bound.bindings, next), bound.revision);
    setBusy(false);
    if (!r.ok) {
      setProblem(r.problem);
      // Another change in between: reload what is saved so the next try starts from it.
      if (r.problem.status === 412) bindings.reload();
      return;
    }
    setSaved(formatWhen(new Date().toISOString()));
    bindings.reload();
    props.onSaved();
  };

  if (accounts.state.phase === 'loading' || bindings.state.phase === 'loading') return <Skeleton label="Loading the send set-up" />;
  const failed = [accounts.state, bindings.state].find((s) => s.phase === 'error');
  if (failed?.phase === 'error') return <ProblemNotice problem={failed.problem} onRetry={() => (accounts.reload(), bindings.reload())} />;

  return (
    <Card title="Sending email">
      <div className="stack">
        <p>
          Choose the account this workflow sends from, then say where each part of the message comes from. Nothing is sent until a person
          approves it.
        </p>
        <Field label="Which step sends the message?" {...(errors['capability'] !== undefined ? { error: errors['capability'] } : {})}>
          <Select
            value={capability}
            onChange={(e) => setCapability(e.target.value)}
            options={[{ value: '', label: 'Choose a step' }, ...props.steps.map((s) => ({ value: s.name, label: s.label }))]}
          />
        </Field>
        <Accounts
          ws={ws}
          accounts={active}
          chosen={chosenAccount}
          onChoose={setAccount}
          reload={accounts.reload}
          allowed={allowed}
          role={props.role}
          error={errors['account']}
        />
        {shown || existing !== undefined ? (
          <>
            <FieldMapper
              rows={ROWS}
              columns={columns}
              values={values}
              onChange={(k, v) => setValues((o) => ({ ...o, [k]: v }))}
              errors={errors}
            />
            <Checkbox
              label="Attach each person’s document"
              checked={attach}
              onChange={setAttach}
              hint="Uses the document XO matched to each person in a source you confirmed."
            />
          </>
        ) : null}
        {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
        {saved !== undefined ? (
          <Banner tone="positive" title="Send set-up saved">
            The next check before starting uses it. Saved {saved}.
          </Banner>
        ) : null}
        <div className="row">
          <Button
            variant="primary"
            loading={busy}
            onClick={() => void save()}
            {...(!allowed ? { disabledReason: whyNot(props.role, 'manage', 'changing how XO sends') } : {})}
          >
            Save send set-up
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Accounts(props: {
  ws: string;
  accounts: readonly EmailAccount[];
  chosen: string | undefined;
  onChoose: (id: string) => void;
  reload: () => void;
  allowed: boolean;
  role: WorkspaceRole | undefined;
  error: string | undefined;
}) {
  const { client } = useSession();
  const [consent, setConsent] = useState<{ authorizationUrl: string; expiresAt: string; provider: 'google' | 'microsoft' } | undefined>(
    undefined,
  );
  const [problem, setProblem] = useState<ApiProblem | undefined>(undefined);
  const [password, setPassword] = useState(false);
  const reload = useRef(props.reload);
  reload.current = props.reload;
  const count = props.accounts.length;
  const waiting = consent !== undefined;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => reload.current(), POLL_MS);
    return () => clearInterval(t);
  }, [waiting, count]);
  useEffect(() => {
    if (count > 0) setConsent(undefined);
  }, [count]);

  const connect = async (provider: 'google' | 'microsoft') => {
    setProblem(undefined);
    const r = await client.startEmailConsent(props.ws, provider);
    if (!r.ok) return setProblem(r.problem);
    setConsent({ ...r.value, provider });
  };
  const why = props.allowed ? {} : { disabledReason: whyNot(props.role, 'manage', 'connecting an email account') };
  return (
    <div className="stack">
      {count > 0 ? (
        <RadioGroup
          legend="Send from"
          value={props.chosen ?? ''}
          onChange={props.onChoose}
          options={props.accounts.map((a) => ({
            value: a.credentialId,
            label: `${a.accountLabel ?? PROVIDER_NAME[a.provider]} (${PROVIDER_NAME[a.provider]})`,
          }))}
        />
      ) : (
        <p>No email account is connected yet.</p>
      )}
      {props.error !== undefined ? (
        <p className="k-error" role="alert">
          {props.error}
        </p>
      ) : null}
      <div className="row">
        <Button variant="secondary" onClick={() => void connect('google')} {...why}>
          Connect Gmail
        </Button>
        <Button variant="secondary" onClick={() => void connect('microsoft')} {...why}>
          Connect Outlook
        </Button>
        <Button variant="quiet" onClick={() => setPassword((v) => !v)} {...why}>
          Use an app password
        </Button>
      </div>
      {consent !== undefined ? (
        <div className="stack">
          <a className="btn btn-primary" href={consent.authorizationUrl} target="_blank" rel="noopener noreferrer">
            Open {consent.provider === 'google' ? 'Google' : 'Microsoft'} to allow sending
          </a>
          <p className="muted small" role="status">
            Waiting for you to allow it. This page carries on by itself once you have; the link works until {formatWhen(consent.expiresAt)}.
          </p>
        </div>
      ) : null}
      {password ? <AppPassword ws={props.ws} onDone={() => (setPassword(false), props.reload())} /> : null}
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
    </div>
  );
}

function AppPassword(props: { ws: string; onDone: () => void }) {
  const { client } = useSession();
  const [f, setF] = useState({ host: '', username: '', password: '', label: '' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>(undefined);
  const ready = f.host.trim() !== '' && f.username.trim() !== '' && f.password !== '';
  const submit = async () => {
    setBusy(true);
    setProblem(undefined);
    const r = await client.addEmailPassword(props.ws, {
      provider: 'smtp',
      host: f.host.trim(),
      username: f.username.trim(),
      password: f.password,
      ...(f.label.trim() !== '' ? { label: f.label.trim() } : {}),
    });
    setBusy(false);
    if (!r.ok) return setProblem(r.problem);
    setF({ host: '', username: '', password: '', label: '' });
    props.onDone();
  };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((o) => ({ ...o, [k]: e.target.value }));
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label="Mail server" hint="For example smtp.example.com:587">
        <TextField value={f.host} onChange={set('host')} autoComplete="off" />
      </Field>
      <Field label="Account name or address">
        <TextField value={f.username} onChange={set('username')} autoComplete="off" />
      </Field>
      <Field label="App password" hint="XO keeps it sealed and never shows it again.">
        <TextField type="password" value={f.password} onChange={set('password')} autoComplete="new-password" />
      </Field>
      <Field label="A name for this account" optional>
        <TextField value={f.label} onChange={set('label')} />
      </Field>
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      <div className="row">
        <Button
          variant="primary"
          type="submit"
          loading={busy}
          {...(!ready ? { disabledReason: 'Fill in the server, the account and the password.' } : {})}
        >
          Connect account
        </Button>
      </div>
    </form>
  );
}
