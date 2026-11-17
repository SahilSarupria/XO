// UW-12a part 2: which person a file is named after — full names, joined, other spellings, nicknames and initials, in tiers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPath, nameWords, personName, proposeRoles, spellingKey, type DiscoveryItem, type PersonName } from '../src/index.js';

const PEOPLE = [
  'Asha Rao',
  'Venkatesh Iyengar',
  'Lakshmi Srivastava',
  'Robert Dsouza',
  'Anirudh Chaudhary',
  'Arun Rao',
  'Imran',
  'Mr. Joseph Fernandes',
]
  .map((v, i) => personName(i, v))
  .filter((p): p is PersonName => p !== undefined);
const who = (path: string) => {
  const m = matchPath(path, PEOPLE);
  return m.outcome === 'matched'
    ? `${m.kind}:${PEOPLE.find((p) => p.index === m.person)!.words.join(' ')}`
    : m.outcome === 'ambiguous'
      ? `ambiguous:${m.kind}`
      : 'none';
};

test('nameWords splits camelCase, digits and punctuation; honorifics are not part of a name', () => {
  assert.deepEqual(nameWords('Certificates/VenkateshIyengar_2026.pdf'), ['certificates', 'venkatesh', 'iyengar', '2026', 'pdf']);
  assert.deepEqual(personName(0, 'Mr. Joseph Fernandes')?.words, ['joseph', 'fernandes']);
  assert.equal(spellingKey('lakshmi'), spellingKey('laxmi'));
  assert.equal(spellingKey('chaudhary'), spellingKey('choudhari'));
});

test('tiers: full, joined, another spelling, a nickname, initials', () => {
  assert.equal(who('Certificates/Asha_Rao_certificate.pdf'), 'full:asha rao');
  assert.equal(who('Certificates/rao asha.pdf'), 'full:asha rao', 'order does not matter');
  assert.equal(who('Certificates/asharao.pdf'), 'joined:asha rao');
  assert.equal(who('Certificates/raoasha-2026.pdf'), 'joined:asha rao');
  assert.equal(who('Certificates/Laxmi Shrivastav.pdf'), 'spelling:lakshmi srivastava');
  assert.equal(who('Certificates/Aniruddh Choudhari.pdf'), 'spelling:anirudh chaudhary');
  assert.equal(who('Certificates/Venkatesh Iyenger.pdf'), 'spelling:venkatesh iyengar', 'one typing error');
  assert.equal(who('Certificates/Venky Iyengar.pdf'), 'nickname:venkatesh iyengar');
  assert.equal(who('Certificates/Venkat_Iyengar.pdf'), 'nickname:venkatesh iyengar', 'a long enough start of the first name');
  assert.equal(who('Certificates/Bob Dsouza.pdf'), 'nickname:robert dsouza');
  assert.equal(who('Certificates/R. Dsouza.pdf'), 'initials:robert dsouza');
  assert.equal(who('Certificates/Dsouza R.pdf'), 'initials:robert dsouza');
  assert.equal(who('Certificates/rdsouza.pdf'), 'initials:robert dsouza');
  assert.equal(who('Certificates/J Fernandes.pdf'), 'initials:joseph fernandes');
  assert.equal(who('Certificates/Imran certificate.pdf'), 'full:imran');
});

test('ambiguity is never resolved by guessing; a stronger tier decides before a weaker one; unrelated names match no one', () => {
  assert.equal(who('Certificates/A Rao.pdf'), 'ambiguous:initials', 'Asha Rao and Arun Rao both have initial A');
  assert.equal(who('Certificates/Rao.pdf'), 'none', 'a surname alone is no one');
  assert.equal(who('Certificates/Asha Rao and Arun Rao.pdf'), 'ambiguous:full');
  assert.equal(who('Certificates/Arun Rao (copy for A Rao).pdf'), 'full:arun rao', 'the full name decides before initials are tried');
  assert.equal(who('Certificates/Venkata Raman.pdf'), 'none');
  assert.equal(who('Certificates/V. Iyengar.pdf'), 'initials:venkatesh iyengar');
  assert.equal(who('Certificates/Iyengar family V2.pdf'), 'none', 'an initial must stand next to the surname: "V2" is a version');
  assert.equal(who('Certificates/Rob.pdf'), 'none', 'a nickname alone is no one');
});

test('discovery reports how files were matched, and loose matches make the proposal weak', () => {
  const doc = (key: string): DiscoveryItem => ({
    key,
    name: key.split('/').at(-1)!,
    extension: '.pdf',
    sourceId: 'src_x',
    digestSha256: key,
  });
  const items: DiscoveryItem[] = [
    {
      ...doc('clients.csv'),
      extension: '.csv',
      tables: [
        {
          recordSetId: '#1',
          rows: 3,
          columns: [
            { header: 'Client name', values: ['Asha Rao', 'Venkatesh Iyengar', 'Robert Dsouza'] },
            { header: 'Email', values: ['a@x.in', 'v@x.in', 'r@x.in'] },
          ],
        },
      ],
    },
    doc('Certificates/Asha Rao certificate.pdf'),
    doc('Certificates/Venky Iyengar certificate.pdf'),
    doc('Certificates/R Dsouza certificate.pdf'),
    doc('Certificates/Asha Rao certificate (2).pdf'),
  ];
  const p = proposeRoles(items).find((x) => x.role === 'per_person_documents')!;
  assert.equal(p.strength, 'weak');
  assert.equal(p.counts['matched'], 4);
  assert.equal(p.counts['by_full'], 2);
  assert.equal(p.counts['by_nickname'], 1);
  assert.equal(p.counts['by_initials'], 1);
  assert.equal(p.counts['peopleWithSeveral'], 1);
  assert.ok(p.basis.includes('2 of these only by a short form of the first name, or initials (worth a look)'), p.basis.join(' | '));
  assert.ok(p.basis.includes('1 has more than one'));
});
