import { ErrorCode } from '@xo/errors';

/**
 * Which capabilities may receive an approval record.
 *
 * An approval is an acknowledgement about something the platform can actually carry out, so it
 * is only recordable when the capability's binding status is `resolved`. This is the same
 * three-way split execution already reports (`execution-routes.ts`): the error code returned
 * for a blocked approval is the code execution would report for that binding status.
 *
 * This is an eligibility *filter*, not an authorization mechanism. Approval still does not
 * imply authorization or execution: execution independently re-derives the binding from the
 * stored compilation and re-checks the approval record (`executions/execute-capability.ts`).
 * That second check is deliberately kept, because approval records written before this filter
 * existed may legitimately be present.
 *
 * Fails closed: any status this function does not recognise blocks approval.
 */
export function approvalBlockedCode(bindingStatus: string): ErrorCode | undefined {
  switch (bindingStatus) {
    case 'resolved':
      return undefined;
    case 'ambiguous':
      return ErrorCode.BINDING_AMBIGUOUS;
    case 'denied':
      return ErrorCode.BINDING_DENIED;
    case 'unresolved':
    default:
      return ErrorCode.BINDING_UNRESOLVED;
  }
}
