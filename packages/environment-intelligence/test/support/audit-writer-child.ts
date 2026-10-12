/**
 * Test-only child process: appends attempt events to a FileAuditLog as fast as it can and prints `ACK <sequence> <i>`
 * only AFTER each record was acknowledged. The parent SIGKILLs it mid-stream to prove acknowledged events survive.
 */
import { FileAuditLog, type AuditRecordRequest } from '../../src/index.js';

const dir = process.argv[2];
if (dir === undefined) process.exit(3);
const opened = await FileAuditLog.open({ dir });
if (!opened.ok) {
  console.log(`ERR ${opened.error.code}`);
  process.exit(2);
}
console.log('READY');
for (let i = 0; ; i += 1) {
  const event: AuditRecordRequest = {
    idempotencyKey: `op_child_${i}:attempt`,
    operationId: `op_child_${i}`,
    phase: 'attempt',
    outcome: 'attempted',
    operation: 'discover',
    occurredAt: new Date().toISOString(),
    principal: { kind: 'service', id: 'child-writer' },
    connectorId: 'xo.local-filesystem',
    permission: 'filesystem.list',
  };
  const r = await opened.value.record(event);
  if (r.ok) console.log(`ACK ${r.value.sequence} ${i}`);
}
