import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { leadingRunInHeading, synthesizeTitle } from '../src/semantic/title.js';

describe('bold run-in headings', () => {
  it('uses the author heading instead of the first eight words', () => {
    assert.equal(
      synthesizeTitle('**Dock safety (Northgate terminal).** Forklift operators must complete a refresher course every twelve months.'),
      'Dock safety (Northgate terminal)',
    );
    assert.equal(synthesizeTitle('__Filing window: damage.__ A damage claim must be filed within 9 days.'), 'Filing window: damage');
  });
  it('is not fooled by unterminated, empty or overlong markers', () => {
    assert.equal(leadingRunInHeading('**unterminated heading and then lots of text'), undefined);
    assert.equal(leadingRunInHeading('**** empty'), undefined);
    assert.equal(leadingRunInHeading(`**${'x'.repeat(130)}.** body`), undefined);
    assert.equal(leadingRunInHeading('plain paragraph'), undefined);
  });
  it('keeps the old behaviour for ordinary content', () => {
    assert.equal(synthesizeTitle('one two three four five six seven eight nine'), 'one two three four five six seven eight…');
    assert.equal(synthesizeTitle('   '), '(untitled)');
  });
});
