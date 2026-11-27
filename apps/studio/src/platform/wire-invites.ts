/**
 * S1-9 — invitation links (`…/invitations`, `POST /invitations/accept`). The link's token is returned once, when it is made; it is
 * never listed. Everything is checked; a field that breaks the contract makes the whole answer a problem.
 */
import { WireParseError, arr, obj, optStr, str } from './wire';

export type InvitationState = 'pending' | 'used' | 'revoked' | 'expired';
const STATES: readonly string[] = ['pending', 'used', 'revoked', 'expired'];

export interface InvitationView {
  readonly invitationId: string;
  readonly role: string;
  readonly state: InvitationState;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly usedAt?: string;
}

function parseOne(v: unknown, path: string): InvitationView {
  const o = obj(v, path);
  const state = str(o['state'], `${path}.state`);
  if (!STATES.includes(state)) throw new WireParseError(`${path}.state`, STATES.join(', '));
  const usedAt = optStr(o['usedAt'], `${path}.usedAt`);
  return {
    invitationId: str(o['invitationId'], `${path}.invitationId`),
    role: str(o['role'], `${path}.role`),
    state: state as InvitationState,
    createdBy: str(o['createdBy'], `${path}.createdBy`),
    createdAt: str(o['createdAt'], `${path}.createdAt`),
    expiresAt: str(o['expiresAt'], `${path}.expiresAt`),
    ...(usedAt !== undefined ? { usedAt } : {}),
  };
}

export const parseInvitationList = (v: unknown): InvitationView[] =>
  arr(obj(v, 'body')['invitations'], 'invitations').map((x, i) => parseOne(x, `invitations[${i}]`));
export const parseInvitationMade = (v: unknown): { invitation: InvitationView; token: string } => {
  const o = obj(v, 'body');
  return { invitation: parseOne(o['invitation'], 'invitation'), token: str(o['token'], 'token') };
};
export const parseInvitation = (v: unknown): InvitationView => parseOne(obj(v, 'body')['invitation'], 'invitation');
export const parseJoined = (v: unknown): { workspaceId: string; role: string } => {
  const o = obj(v, 'body');
  return { workspaceId: str(o['workspaceId'], 'workspaceId'), role: str(o['role'], 'role') };
};
