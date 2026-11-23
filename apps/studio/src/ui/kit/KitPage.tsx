import { useState } from 'react';
import type { ApiProblem } from '../../platform/client';
import { appliedTheme, setTheme, useTheme } from '../theme';
import {
  Banner,
  Breadcrumb,
  Button,
  Card,
  Checkbox,
  ConfirmButton,
  CountSummary,
  DataTable,
  DataView,
  DescriptionList,
  Dialog,
  Disclosure,
  EmptyState,
  ErrorState,
  EvidenceQuote,
  Field,
  FileDrop,
  FormErrors,
  IconButton,
  PageHeader,
  Progress,
  RadioGroup,
  Select,
  Sheet,
  Skeleton,
  StatusPill,
  Switch,
  Tabs,
  TextArea,
  TextField,
  Timeline,
  ToastProvider,
  WhoMark,
  tabPanelProps,
  useToast,
  type Status,
} from './index';

/**
 * S1-1 — every kit part in every state, for design review and the screenshot suite. Served at /__kit in development builds
 * only (main.tsx loads it lazily behind import.meta.env.DEV, so it is not in the production bundle). The content is invented
 * and industry-neutral.
 */
const PROBLEM: ApiProblem = { kind: 'network', message: 'The request did not reach XO.' };
const STATUSES: Status[] = [
  'draft',
  'ready',
  'live',
  'paused',
  'waiting',
  'running',
  'attention',
  'done',
  'partial',
  'failed',
  'cancelled',
  'left-out',
  'unknown',
];

interface Row {
  readonly name: string;
  readonly to: string;
  readonly status: Status;
  readonly attachment: string;
}
const ROWS: Row[] = [
  { name: 'Asha Rao', to: 'example.org', status: 'done', attachment: 'asha-rao.pdf' },
  { name: 'Ben Ortiz', to: 'example.net', status: 'waiting', attachment: 'ben-ortiz.pdf' },
  { name: 'Dev Patel', to: 'example.com', status: 'left-out', attachment: 'No document found' },
];

export function KitPage() {
  return (
    <ToastProvider>
      <Kit />
    </ToastProvider>
  );
}

function Kit() {
  const [theme] = useTheme();
  const [tab, setTab] = useState('overview');
  const [sheet, setSheet] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [checked, setChecked] = useState(true);
  const [radio, setRadio] = useState<'each' | 'standing' | undefined>('each');
  const [on, setOn] = useState(false);
  const toast = useToast();
  const states = ['loading', 'empty', 'partial', 'error', 'ready'] as const;
  return (
    <main className="kit">
      <PageHeader
        title="Studio kit"
        lede="Every part of the design system, in each of its states. Development builds only."
        status={<StatusPill status="ready" label={appliedTheme(theme) === 'dark' ? 'Dark theme' : 'Light theme'} />}
        actions={
          <Button onClick={() => setTheme(appliedTheme(theme) === 'dark' ? 'light' : 'dark')}>
            Switch to {appliedTheme(theme) === 'dark' ? 'light' : 'dark'}
          </Button>
        }
        breadcrumb={<Breadcrumb items={[{ label: 'Studio', href: '/' }, { label: 'Kit' }]} />}
      />

      <section className="kit-section" aria-labelledby="kit-actions">
        <h2 id="kit-actions">Actions</h2>
        <div className="k-row">
          <Button variant="primary">Approve the batch</Button>
          <Button>Preview</Button>
          <Button variant="quiet">See the steps</Button>
          <Button variant="danger">Stop the workflow</Button>
          <Button variant="primary" loading>
            Starting
          </Button>
          <Button variant="primary" disabledReason="Nobody has signed this version off yet.">
            Go live
          </Button>
          <IconButton label="More actions" icon={<span aria-hidden="true">⋯</span>} />
        </div>
        <div className="k-row">
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg" variant="primary">
            Large
          </Button>
        </div>
        <div className="k-row">
          <ConfirmButton
            consequence="The run stops after the step in progress. Nothing already sent is undone."
            confirmLabel="Stop the run"
            onConfirm={() => toast('Stopped')}
            variant="danger"
          >
            Stop the run
          </ConfirmButton>
          <ConfirmButton
            consequence="The workspace and everything in it are deleted for everyone."
            confirmLabel="Delete the workspace"
            typeToConfirm="Operations"
            onConfirm={() => toast('Deleted', 'danger')}
            variant="danger"
          >
            Delete the workspace
          </ConfirmButton>
          <Button onClick={() => toast('Saved')}>Show a toast</Button>
        </div>
      </section>

      <section className="kit-section" aria-labelledby="kit-forms">
        <h2 id="kit-forms">Forms</h2>
        <FormErrors errors={[{ fieldId: 'kit-subject', message: 'Write a subject for the message.' }]} />
        <div className="kit-grid">
          <Field label="Workflow name" hint="People see this in lists and notifications.">
            <TextField defaultValue="Send each client their certificate" />
          </Field>
          <Field label="Subject" error="Write a subject for the message." id="kit-subject">
            <TextField />
          </Field>
          <Field label="Message" optional>
            <TextArea defaultValue="Please find your document attached." />
          </Field>
          <Field label="Send from">
            <Select
              options={[
                { value: 'a', label: 'office@example.org' },
                { value: 'b', label: 'team@example.org' },
              ]}
            />
          </Field>
        </div>
        <Checkbox
          label="Also decide the step “Record the send”"
          checked={checked}
          onChange={setChecked}
          hint="The batch approval covers it."
        />
        <RadioGroup
          legend="How each run is approved"
          value={radio}
          onChange={setRadio}
          options={[
            { value: 'each', label: 'Each run waits for approval' },
            { value: 'standing', label: 'A standing approval, within limits', hint: 'Someone else approves the limits once.' },
          ]}
        />
        <Switch label="Email me when something waits for me" checked={on} onChange={setOn} hint="A link only; never the content." />
        <FileDrop
          label="Drop a document here"
          hint="PDF, Word, Excel or CSV, up to 25 MB."
          onFiles={(f) => toast(`${f.length} file chosen`, 'info')}
        />
      </section>

      <section className="kit-section" aria-labelledby="kit-structure">
        <h2 id="kit-structure">Structure</h2>
        <Tabs
          label="Workflow"
          idBase="kit-tabs"
          current={tab}
          onSelect={setTab}
          items={[
            { id: 'overview', label: 'Overview' },
            { id: 'runs', label: 'Runs', count: 3, countLabel: 'runs' },
            { id: 'schedule', label: 'Schedule and approvals' },
            { id: 'setup', label: 'Setup' },
            { id: 'history', label: 'History' },
          ]}
        />
        <div {...tabPanelProps('kit-tabs', tab)} className="kit-panel">
          The {tab} panel.
        </div>
        <Card title="Card with a title" as="section" actions={<Button size="sm">Edit</Button>}>
          <p className="k-hint">A surface that groups one thing.</p>
        </Card>
        <Disclosure summary="What each step is based on">
          <p>Details on demand.</p>
        </Disclosure>
        <Banner tone="danger" title="Everything in this workspace is stopped" action={<Button size="sm">Release</Button>}>
          Stopped by an administrator. Nothing starts or sends until it is released.
        </Banner>
        <Banner tone="attention" title="XO is being updated">
          Try again in a few minutes.
        </Banner>
        <Banner tone="info" title="Notifications are in Studio only">
          This instance has no sender for email notifications.
        </Banner>
        <Banner tone="positive" title="The batch was approved" />
        <div className="k-row">
          <Button onClick={() => setSheet(true)}>Open a sheet</Button>
          <Button onClick={() => setDialog(true)}>Open a dialog</Button>
        </div>
        <Sheet
          open={sheet}
          title="Approve the batch"
          description="3 emails from office@example.org; 1 person left out."
          onClose={() => setSheet(false)}
          footer={
            <Button variant="primary" onClick={() => setSheet(false)}>
              Approve
            </Button>
          }
        >
          <CountSummary
            counts={[
              { n: 3, one: 'email', many: 'emails' },
              { n: 1, one: 'left out', many: 'left out' },
            ]}
          />
        </Sheet>
        <Dialog
          open={dialog}
          title="Sign in again to approve"
          description="Approvals need a recent sign-in. Your place on this screen is kept."
          onClose={() => setDialog(false)}
          footer={
            <Button variant="primary" onClick={() => setDialog(false)}>
              Sign in
            </Button>
          }
        >
          <p>You signed in more than 15 minutes ago.</p>
        </Dialog>
      </section>

      <section className="kit-section" aria-labelledby="kit-data">
        <h2 id="kit-data">Data</h2>
        <div className="k-row">
          {STATUSES.map((s) => (
            <StatusPill key={s} status={s} />
          ))}
        </div>
        <div className="k-row">
          <WhoMark who="xo" />
          <WhoMark who="person" />
        </div>
        <CountSummary
          counts={[
            { n: 3, one: 'sent', many: 'sent' },
            { n: 1, one: 'left out', many: 'left out' },
            { n: 0, one: 'failed', many: 'failed' },
          ]}
        />
        <Progress label="Sending" done={2} total={3} />
        <DescriptionList
          columns={2}
          items={[
            { term: 'Sent from', value: 'office@example.org' },
            { term: 'Items', value: '4 people' },
            { term: 'Approved by', value: 'A reviewer' },
            { term: 'Started', value: 'In 2 hours' },
          ]}
        />
        <EvidenceQuote
          quote="Each client receives their current certificate by email before the end of the month."
          source="Procedure.pdf"
          page={2}
        />
        <Timeline
          label="What happened"
          items={[
            { id: '1', when: '09:00', text: 'Started by a person', status: 'done' },
            { id: '2', when: '09:01', text: 'Checked the list: 4 people, 1 without a document', status: 'done' },
            { id: '3', when: '09:01', text: 'Waiting for a reviewer to approve the batch', status: 'waiting' },
          ]}
        />
        <DataTable<Row>
          caption="Who it goes to"
          rows={ROWS}
          rowKey={(r) => r.name}
          columns={[
            { id: 'name', header: 'Person', cell: (r) => r.name, sortValue: (r) => r.name, primary: true },
            { id: 'to', header: 'Email domain', cell: (r) => r.to, sortValue: (r) => r.to },
            { id: 'att', header: 'Attachment', cell: (r) => r.attachment },
            { id: 'st', header: 'State', cell: (r) => <StatusPill status={r.status} /> },
          ]}
          rowAction={(r) => (
            <Button size="sm" variant="quiet" aria-label={`Details for ${r.name}`}>
              Details
            </Button>
          )}
        />
      </section>

      <section className="kit-section" aria-labelledby="kit-states">
        <h2 id="kit-states">The five states of a view</h2>
        <div className="kit-grid">
          {states.map((st) => (
            <Card key={st} title={st[0]!.toUpperCase() + st.slice(1)} as="section">
              <DataView<readonly string[]>
                state={
                  st === 'loading'
                    ? { phase: 'loading' }
                    : st === 'error'
                      ? { phase: 'error', problem: PROBLEM }
                      : { phase: 'ready', value: st === 'empty' ? [] : ['Asha Rao', 'Ben Ortiz'] }
                }
                loadingLabel="Loading people"
                isEmpty={(v) => v.length === 0}
                partial={st === 'partial' ? ['the second folder'] : []}
                empty={<EmptyState title="No people yet">Confirm a list in Sources and its people appear here.</EmptyState>}
                onRetry={() => toast('Retrying', 'info')}
              >
                {(v) => (
                  <ul>
                    {v.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                )}
              </DataView>
            </Card>
          ))}
        </div>
        <Skeleton label="Loading cards" variant="cards" rows={2} />
        <ErrorState problem={{ kind: 'forbidden', message: 'Not allowed', status: 403 }} />
      </section>
    </main>
  );
}
