import { useState } from 'react';
import type { AskAnswer } from '../platform/wire-ask';
import { Banner, Button, Card, EvidenceQuote } from './kit';
import type { AskedTurn } from './useChat';

/** What the person can do from an answer card. The Ask route starts nothing: every action here opens a normal screen. */
export interface AskActions {
  /** Go to a place, a workflow or a run (a "navigate" answer, or the workflow of a prepared start). */
  readonly onGo: (target: { place: string; workflowId?: string; runId?: string }) => void;
  /** Create the proposed workflow from a goal and a read source. Creating is not starting. */
  readonly onCreateWorkflow: (goal: string, compilationId: string) => Promise<boolean>;
}

/**
 * S1-3b — the answers of the Ask box that are not a chat reply, as cards under the conversation. Each says what happened, then
 * what to do; none claims more than the platform returned.
 */
export function AskTurns(props: { turns: readonly AskedTurn[]; actions: AskActions; onDismiss: (id: string) => void }) {
  if (props.turns.length === 0) return null;
  return (
    <ol className="ask-turns" aria-label="Answers from the Ask box">
      {props.turns.map((t) => (
        <li key={t.id} className="ask-turn">
          <p className="ask-question">{t.question}</p>
          <AnswerCard answer={t.answer} actions={props.actions} />
          <Button variant="quiet" size="sm" onClick={() => props.onDismiss(t.id)}>
            Dismiss
          </Button>
        </li>
      ))}
    </ol>
  );
}

function AnswerCard(props: { answer: Exclude<AskAnswer, { kind: 'answer' }>; actions: AskActions }) {
  const a = props.answer;
  const [refused, setRefused] = useState(false);
  switch (a.kind) {
    case 'cannot':
      return (
        <Banner tone="attention" title={a.reason}>
          {a.whatWouldHelp}
        </Banner>
      );
    case 'navigate':
      return (
        <Card
          title={a.label}
          actions={
            <Button
              variant="primary"
              onClick={() =>
                props.actions.onGo({
                  place: a.place,
                  ...(a.workflowId ? { workflowId: a.workflowId } : {}),
                  ...(a.runId ? { runId: a.runId } : {}),
                })
              }
            >
              Open {a.label}
            </Button>
          }
        >
          <p>This opens a screen. Nothing changes.</p>
        </Card>
      );
    case 'analyse':
      return (
        <Card
          title={a.fileName}
          actions={
            a.canUseAsSource ? (
              <Button variant="primary" onClick={() => props.actions.onGo({ place: 'sources' })}>
                Use it as a source
              </Button>
            ) : undefined
          }
        >
          <p>{a.summary}</p>
          {a.found.documentKinds
            .slice(0, 1)
            .flatMap((k) =>
              k.evidence.slice(0, 2).map((e, i) => <EvidenceQuote key={`${k.kind}-${i}`} quote={e.matched} source={a.fileName} />),
            )}
        </Card>
      );
    case 'start': {
      const w = a.workflow;
      const p = a.proposal;
      return (
        <Card
          title={w !== undefined ? w.name : 'A new workflow'}
          actions={
            w !== undefined ? (
              <Button
                variant={a.ready ? 'primary' : 'secondary'}
                onClick={() => props.actions.onGo({ place: 'work', workflowId: w.workflowId })}
              >
                {a.ready ? 'Open to start' : 'Open the workflow'}
              </Button>
            ) : p !== undefined ? (
              <Button
                variant="primary"
                onClick={() => void props.actions.onCreateWorkflow(p.goal, p.compilationId).then((ok) => setRefused(!ok))}
              >
                Create this workflow
              </Button>
            ) : undefined
          }
        >
          <p>{a.summary}</p>
          {a.why !== undefined ? (
            <Banner tone="attention" title="Not ready to start">
              {a.why}
            </Banner>
          ) : null}
          {refused ? (
            <Banner tone="attention" title="XO could not create it from that">
              Nothing was created. Open Work to create it yourself.
            </Banner>
          ) : null}
          {a.ready ? <p>You will see what it will do and approve it before anything is sent.</p> : null}
        </Card>
      );
    }
  }
}
