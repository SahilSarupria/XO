import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryManager } from '../src/memory/working-memory.js';
import { SessionId } from '../src/ids.js';
test('get() on a never-touched session returns an empty array, never throws', () => {
    const memory = new MemoryManager();
    assert.deepEqual(memory.get(SessionId('never_seen')), []);
});
test('append() accumulates turns in order', () => {
    const memory = new MemoryManager();
    const sessionId = SessionId('s1');
    memory.append(sessionId, { role: 'user', content: 'hi', recordedAt: 't1' });
    memory.append(sessionId, { role: 'assistant', content: 'hello', recordedAt: 't2' });
    assert.deepEqual(memory.get(sessionId).map((t) => t.content), ['hi', 'hello']);
});
test('append() trims the oldest turns once the bound is exceeded', () => {
    const memory = new MemoryManager(2);
    const sessionId = SessionId('s1');
    memory.append(sessionId, { role: 'user', content: 'turn 1', recordedAt: 't1' });
    memory.append(sessionId, { role: 'assistant', content: 'turn 2', recordedAt: 't2' });
    memory.append(sessionId, { role: 'user', content: 'turn 3', recordedAt: 't3' });
    assert.deepEqual(memory.get(sessionId).map((t) => t.content), ['turn 2', 'turn 3']);
});
test('sessions are isolated from each other', () => {
    const memory = new MemoryManager();
    memory.append(SessionId('s1'), { role: 'user', content: 'for s1', recordedAt: 't1' });
    memory.append(SessionId('s2'), { role: 'user', content: 'for s2', recordedAt: 't1' });
    assert.equal(memory.get(SessionId('s1')).length, 1);
    assert.equal(memory.get(SessionId('s1'))[0]?.content, 'for s1');
    assert.equal(memory.get(SessionId('s2'))[0]?.content, 'for s2');
});
test('clear() removes a session\'s history entirely', () => {
    const memory = new MemoryManager();
    const sessionId = SessionId('s1');
    memory.append(sessionId, { role: 'user', content: 'hi', recordedAt: 't1' });
    memory.clear(sessionId);
    assert.deepEqual(memory.get(sessionId), []);
    assert.equal(memory.sessionCount, 0);
});
test('sessionCount reflects the number of distinct sessions with history', () => {
    const memory = new MemoryManager();
    memory.append(SessionId('s1'), { role: 'user', content: 'a', recordedAt: 't1' });
    memory.append(SessionId('s2'), { role: 'user', content: 'b', recordedAt: 't1' });
    assert.equal(memory.sessionCount, 2);
});
//# sourceMappingURL=working-memory.test.js.map