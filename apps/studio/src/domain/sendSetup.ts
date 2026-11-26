/**
 * S1-5 — the send set-up of a workflow in plain words (ADR 0049): which email account sends, who it goes to, the subject and the
 * message, and whether each person's document goes with it. This file only turns the person's choices into the platform's binding
 * arguments and back; the platform validates and decides everything else.
 */
import type { MapperValue } from '../ui/kit';
import type { BindingArgument, ConnectorBindingView } from '../platform/wire-send';

export const SEND_ROWS = ['to', 'subject', 'body'] as const;
export type SendRow = (typeof SEND_ROWS)[number];
export type SendValues = Readonly<Record<SendRow, MapperValue>>;

export const EMPTY_SEND: SendValues = { to: { from: 'none' }, subject: { from: 'none' }, body: { from: 'none' } };

/** A column name the platform accepts (lower snake case). */
export const COLUMN = /^[a-z][a-z0-9_]{0,63}$/;
/** The document of each person, as a confirmed pairing gives it (ADR 0049 part 2). */
const DOCUMENT_ARGS: Readonly<Record<string, string>> = {
  attachmentSha256: 'document_sha256',
  attachmentFilename: 'document_name',
  attachmentContentType: 'document_type',
};

/** The binding that sends for one step; the connector names are fixed, the person chooses the rest. */
export function buildSendBinding(input: {
  readonly capability: string;
  readonly credentialId: string;
  readonly values: SendValues;
  readonly attachDocument: boolean;
}): ConnectorBindingView {
  const args: Record<string, BindingArgument> = {};
  for (const k of SEND_ROWS) {
    const v = input.values[k];
    if (v.from === 'column') args[k] = { field: v.column };
    else if (v.from === 'text') args[k] = { const: v.text };
  }
  if (input.attachDocument) for (const [name, field] of Object.entries(DOCUMENT_ARGS)) args[name] = { field };
  return {
    capability: input.capability,
    connector: 'mail',
    kind: 'smtp',
    operation: 'send',
    sideEffect: 'irreversible',
    adapter: 'email',
    credentialId: input.credentialId,
    arguments: args,
    rest: {},
  };
}

/** What is wrong with the choices, in words, by row; empty when they can be saved. */
export function sendProblems(values: SendValues, credentialId: string | undefined, capability: string): Record<string, string> {
  const e: Record<string, string> = {};
  if (capability === '') e['capability'] = 'Choose the step that sends the message.';
  if (credentialId === undefined) e['account'] = 'Choose the account that sends.';
  const to = values.to;
  if (to.from !== 'column') e['to'] = 'Choose the column that holds each person’s email address.';
  for (const k of SEND_ROWS) {
    const v = values[k];
    if (v.from === 'column' && !COLUMN.test(v.column)) e[k] = 'Use lower case and underscores, as in client_email.';
    else if (v.from === 'none' && k !== 'to') e[k] = k === 'subject' ? 'Give the subject.' : 'Give the message.';
    else if (v.from === 'text' && v.text.trim() === '') e[k] = k === 'subject' ? 'Write the subject.' : 'Write the message.';
    else if (k === 'subject' && v.from === 'text' && v.text.length > 200) e[k] = 'Keep the subject under 200 characters.';
    else if (v.from === 'text' && v.text.length > 4000) e[k] = 'Keep this under 4,000 characters.';
  }
  return e;
}

/** The choices an existing send binding stands for (so the page shows what is saved). */
export function readSendBinding(b: ConnectorBindingView | undefined): { values: SendValues; attachDocument: boolean } {
  if (b?.arguments === undefined) return { values: EMPTY_SEND, attachDocument: false };
  const one = (k: SendRow): MapperValue => {
    const a = b.arguments?.[k];
    if (a === undefined) return { from: 'none' };
    return 'field' in a ? { from: 'column', column: a.field } : { from: 'text', text: String(a.const) };
  };
  return {
    values: { to: one('to'), subject: one('subject'), body: one('body') },
    attachDocument: b.arguments['attachmentSha256'] !== undefined,
  };
}

/** The bindings after this one is saved: the same step's old binding is replaced; every other binding stays as it was. */
export function withBinding(all: readonly ConnectorBindingView[], next: ConnectorBindingView): ConnectorBindingView[] {
  return [...all.filter((b) => b.capability !== next.capability), next];
}
