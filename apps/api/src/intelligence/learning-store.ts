import { randomUUID } from 'node:crypto';
import type { BlobStore } from '@xo/storage';
import type { LearningEvent, LearningPort, LearningRecord } from '@xo/intelligence';

/**
 * The LEARN queue: where corrections, outcomes and feedback from the customer chat land. Every entry is a CLAIM
 * awaiting an authorized reviewer (`status: "pending_review"`) — recording one never changes what any answer says.
 * Nothing in this version reads the queue back into answers; the review workflow is a separate step.
 */
export interface StoredLearningEvent {
  readonly eventId: string;
  readonly workspaceId: string;
  readonly identityId: string;
  readonly role: string;
  readonly kind: LearningEvent['kind'];
  readonly statement: string;
  readonly aboutTurnId?: string;
  readonly aboutEvidenceIds: readonly string[];
  readonly status: 'pending_review';
  readonly createdAt: string;
}

export const LEARNING_EVENT_PATTERN = /^lrn_[0-9a-f]{32}$/;

export class FsLearningPort implements LearningPort {
  constructor(
    private readonly store: BlobStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(event: LearningEvent): Promise<LearningRecord> {
    const eventId = `lrn_${randomUUID().replace(/-/g, '')}`;
    const stored: StoredLearningEvent = {
      eventId,
      workspaceId: event.principal.workspaceId,
      identityId: event.principal.identityId,
      role: event.principal.role,
      kind: event.kind,
      statement: event.statement,
      ...(event.aboutTurnId !== undefined ? { aboutTurnId: event.aboutTurnId } : {}),
      aboutEvidenceIds: event.aboutEvidenceIds,
      status: 'pending_review',
      createdAt: this.now().toISOString(),
    };
    const put = await this.store.put(`learning/${eventId}.json`, JSON.stringify(stored), { contentType: 'application/json' });
    if (!put.ok) throw put.error;
    return { eventId, reviewRequired: true };
  }
}
