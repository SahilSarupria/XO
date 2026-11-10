import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { linkArtifacts } from '../src/link.js';

const A = {
  xo: 'a',
  items: [
    { id: 'r1', v: 1 },
    { id: 'r2', v: 2 },
  ],
};
const B = {
  xo: 'b',
  items: [
    { id: 'r2', v: 2 },
    { id: 'r3', v: 3 },
  ],
};

describe('linking trees, knowledge and safety rules across XOs', () => {
  it('unions distinct ids and deduplicates identical definitions, reporting the overlap', () => {
    const r = linkArtifacts('safety', [A, B], { order: [] });
    assert.deepEqual(
      r.items.map((i) => i.id),
      ['r1', 'r2', 'r3'],
    );
    assert.deepEqual(r.overlaps, [{ id: 'r2', xos: ['a', 'b'] }]);
    assert.equal(r.hasUnresolved, false);
  });
  it('a same-id disagreement is decided only by the declared precedence; otherwise it is blocked and left out, never merged or guessed', () => {
    const b2 = { xo: 'b', items: [{ id: 'r1', v: 99 }] };
    const byOrder = linkArtifacts('tree', [A, b2], { order: ['b', 'a'] });
    assert.deepEqual(byOrder.conflicts, [{ id: 'r1', xos: ['a', 'b'], resolution: 'precedence:b' }]);
    assert.equal(byOrder.items.find((i) => i.id === 'r1')?.v, 99);
    const none = linkArtifacts('safety', [A, b2], { order: [] });
    assert.equal(none.hasUnresolved, true);
    assert.deepEqual(none.blocked, ['r1']);
    assert.equal(
      none.items.some((i) => i.id === 'r1'),
      false,
    );
    // an XO that is not in the order cannot win, even against a listed one that is absent from the conflict
    assert.equal(linkArtifacts('knowledge', [A, b2], { order: ['c'] }).hasUnresolved, true);
    // no field-level merging: the winner is taken whole
    const w = linkArtifacts(
      'tree',
      [
        { xo: 'a', items: [{ id: 'x', p: 1, q: 1 }] },
        { xo: 'b', items: [{ id: 'x', p: 2 }] },
      ],
      { order: ['b'] },
    );
    assert.deepEqual(w.items[0], { id: 'x', p: 2 });
  });
  it('is deterministic regardless of input order, and refuses duplicate ids inside one XO', () => {
    const one = linkArtifacts('safety', [A, B], { order: [] });
    const two = linkArtifacts('safety', [B, A], { order: [] });
    assert.deepEqual(one.items, two.items);
    assert.throws(() => linkArtifacts('tree', [{ xo: 'a', items: [{ id: 'x' }, { id: 'x' }] }], { order: [] }), /duplicate tree id "x"/);
  });
});
