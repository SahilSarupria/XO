import { useState } from 'react';
import type { ApiProblem } from '../platform/client';
import type { ItemSourceView } from '../platform/wire-control';
import { useGuardedAction } from './actions';
import { ItemSourcePicker } from './ItemSourcePicker';
import { Button, ProblemNotice } from './primitives';
import { useSession } from './session';
import { chooseItemSource } from './useStartWorkflow';

/**
 * UW-12b (ADR 0052): "Preview what it would do". Prepares exactly what a start would do for today's items (what each would send, to
 * whom is not shown here but in the reviewer's preview) without sending, starting or approving anything. It never approves: a
 * reviewer approves a preview in the Inbox, and a preview can be made as often as needed.
 */
export function PreviewWhatItWouldDo(props: {
  workspaceId: string;
  workflowId: string;
  compilationId: string;
  name: string;
  disabledReason?: string;
}) {
  const { client } = useSession();
  const { run, busy } = useGuardedAction();
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [choices, setChoices] = useState<{ definitionId: string; certificateId: string; sources: readonly ItemSourceView[] } | undefined>();

  const prepare = async (definitionId: string, certificateId: string, source: ItemSourceView | undefined) => {
    const p = await client.prepareBatchPreview(
      props.workspaceId,
      definitionId,
      certificateId,
      {},
      source !== undefined ? { connectionId: source.connectionId, proposalId: source.proposalId } : undefined,
    );
    if (!p.ok) {
      setProblem(p.problem);
      return;
    }
    setNote(
      `Nothing was sent, started or approved. The preview covers ${p.value.total} ${p.value.total === 1 ? 'item' : 'items'}; a reviewer can look at it in the Inbox.`,
    );
  };

  const preview = () =>
    void run(async () => {
      setProblem(undefined);
      setNote(undefined);
      const cert = await client.certifyWorkflow(props.workspaceId, props.compilationId, props.workflowId, props.name);
      if (!cert.ok) {
        setProblem(cert.problem);
        return;
      }
      const definitionId = cert.value.scope.definitionId;
      if (definitionId === undefined) {
        setNote('This workflow cannot be previewed yet.');
        return;
      }
      const sources = await client.itemSources(props.workspaceId, definitionId);
      if (!sources.ok) {
        setProblem(sources.problem);
        return;
      }
      const choice = chooseItemSource(sources.value);
      if (choice.kind === 'none') {
        setNote(choice.message);
        return;
      }
      if (choice.kind === 'several') {
        setChoices({ definitionId, certificateId: cert.value.certificateId, sources: sources.value.sources.filter((s) => s.usable) });
        return;
      }
      await prepare(definitionId, cert.value.certificateId, choice.kind === 'one' ? choice.source : undefined);
    });

  return (
    <div className="wm-preview">
      <Button onClick={preview} pending={busy} disabled={props.disabledReason !== undefined} title={props.disabledReason}>
        Preview what it would do
      </Button>
      <ItemSourcePicker
        sources={choices?.sources}
        disabled={busy}
        onCancel={() => setChoices(undefined)}
        onChoose={(s) => {
          const c = choices;
          setChoices(undefined);
          if (c !== undefined) void run(() => prepare(c.definitionId, c.certificateId, s));
        }}
      />
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      {note !== undefined ? (
        <p className="notice notice-info small" role="status">
          {note}
        </p>
      ) : null}
    </div>
  );
}
