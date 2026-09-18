// Three composite keys in Nexus join two pieces of text with a NUL between
// them: a message's chain hash, the fingerprint that decides an entry is a
// duplicate, and the order exclusions take in a canonical package.
//
// The separator is the whole point. "A" + "BC" and "AB" + "C" are different
// things, and without something between the halves they read as the same
// string. NUL is used because it cannot appear in the words being joined.
//
// These checks describe that property, not how it is spelled. Writing the
// separator as a literal byte, as \0, or as a unicode escape must all pass.
// Removing it must not.
//
//   node scripts/check-separators.js
//
// Throwaway databases. Nothing here reads anyone's real library.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../src/db/index.js';
import { validatePackage, canonicalPackage } from '../src/package/format.js';
import { packageHash } from '../src/package/import.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};
const tmp = () => join(mkdtempSync(join(tmpdir(), 'nexus-sep-')), 'x.db');

// ---------------------------------------------------------------- A
// A message's hash folds in its parent's, its role and its text. Two messages
// whose role and text run together into the same string must still hash
// differently, or a branch could be mistaken for another one.
console.log('A  a message hash tells "user"+"hello" from "use"+"rhello"');
{
  const db = open(tmp());
  const storyId = db.createStory({ title: 'Separator' });
  const hashOf = (role, content) => db.getMessage(db.addMessage({ storyId, role, content })).chain_hash;

  // Pairs that concatenate identically and split differently.
  const pairs = [
    [['user', 'hello'], ['use', 'rhello']],
    [['assistant', 'x'], ['assistan', 'tx']],
    [['system', 'ab'], ['syste', 'mab']],
  ];
  for (const [[r1, c1], [r2, c2]] of pairs) {
    const a = hashOf(r1, c1);
    const b = hashOf(r2, c2);
    ok(`${JSON.stringify(r1)}+${JSON.stringify(c1)} and ${JSON.stringify(r2)}+${JSON.stringify(c2)} hash differently`,
      a !== b, `${a} vs ${b}`);
    ok('  and both are the same string once joined, which is why this matters',
      `${r1}${c1}` === `${r2}${c2}`, JSON.stringify(`${r1}${c1}`));
  }

  // The same words always give the same hash: the separator adds a boundary,
  // it does not add noise.
  ok('the same role and text always hash the same', hashOf('user', 'steady') === hashOf('user', 'steady'));

  // A child's hash folds in its parent's, so the same words under different
  // parents differ. That is the branch-awareness the separator protects.
  const root = db.addMessage({ storyId, role: 'user', content: 'root' });
  const other = db.addMessage({ storyId, role: 'user', content: 'elsewhere' });
  const underRoot = db.getMessage(db.addMessage({ storyId, parentId: root, role: 'user', content: 'same words' })).chain_hash;
  const underOther = db.getMessage(db.addMessage({ storyId, parentId: other, role: 'user', content: 'same words' })).chain_hash;
  ok('the same words under different parents hash differently', underRoot !== underOther);
  db.close();
}

// ---------------------------------------------------------------- B
// Copying entries skips anything already there with the same title and body.
// The two halves need a boundary, or a title that borrows a letter from the
// body counts as a copy of one that does not.
console.log('\nB  a duplicate is the same title AND the same body, not the two run together');
{
  const db = open(tmp());
  const from = db.createLorebook('From', '');
  const to = db.createLorebook('To', '');
  const base = { order: 100, enabled: true, constant: false, probability: 100, keys: [] };

  // Already in the destination: title "AB", body "C".
  db.saveEntry(to, { ...base, title: 'AB', content: 'C' });
  // Offered from the source: title "A", body "BC". Run together both are "ABC".
  const a = db.saveEntry(from, { ...base, title: 'A', content: 'BC' });
  const result = db.copyEntries(from, to, [a.id ?? a]);
  ok('"A"+"BC" is not treated as a copy of "AB"+"C"', result.copied === 1 && result.already === 0,
    JSON.stringify(result));
  ok('so the destination holds both', db.listEntries(to).length === 2, `${db.listEntries(to).length} entries`);

  // The genuine duplicate is still recognised, so the boundary has not simply
  // turned the check off.
  const again = db.saveEntry(from, { ...base, title: 'AB', content: 'C' });
  const second = db.copyEntries(from, to, [again.id ?? again]);
  ok('a real duplicate is still skipped', second.copied === 0 && second.already === 1, JSON.stringify(second));
  db.close();
}

// ---------------------------------------------------------------- C
// A canonical package orders a story's exclusions by source then entry. Two
// exclusions whose source and entry run together into the same string must
// still order the same way every time, because that order is part of what the
// package hashes to.
console.log('\nC  a canonical package orders "book"+"a-b" and "book-a"+"b" the same way every time');
{
  const entry = (ref, title) => ({
    ref, title, content: `${title} body`, enabled: true, summary: '', activation: { policy: 'always' },
  });
  const build = (exclusions) => ({
    format: 'nexus-package',
    version: 1,
    package: { id: 'separator-boundary', title: 'Separator boundary', role: 'story-package' },
    entities: [],
    characters: [{ ref: 'lead', name: 'Lead' }],
    personas: [],
    sources: [
      { ref: 'book', name: 'Book', role: 'world', entries: [entry('a-b', 'A b')] },
      { ref: 'book-a', name: 'Book A', role: 'world', entries: [entry('b', 'B')] },
    ],
    stories: [{
      ref: 'story',
      title: 'Story',
      cast: [{ character: 'lead', role: 'lead' }],
      sources: [{ source: 'book' }, { source: 'book-a' }],
      exclusions,
    }],
  });
  const one = build([{ source: 'book-a', entry: 'b' }, { source: 'book', entry: 'a-b' }]);
  const other = build([{ source: 'book', entry: 'a-b' }, { source: 'book-a', entry: 'b' }]);

  ok('the fixture is a valid v1 package', (validatePackage(one).errors || []).length === 0,
    (validatePackage(one).errors || []).map((e) => `${e.path}: ${e.message}`).join(' | '));
  ok('and so is the same package written the other way round', (validatePackage(other).errors || []).length === 0);

  const order = (p) => canonicalPackage(p).stories[0].exclusions.map((x) => `${x.source}/${x.entry}`);
  ok('both orderings canonicalise to the same order', JSON.stringify(order(one)) === JSON.stringify(order(other)),
    order(one).join(' , '));
  // With a boundary "book" sorts before "book-a"; run together, "book-ab"
  // sorts before "booka-b" and the two swap places.
  ok('and that order is the one a boundary gives', JSON.stringify(order(one)) === JSON.stringify(['book/a-b', 'book-a/b']),
    order(one).join(' , '));
  ok('so the package hashes the same whichever way it was written', packageHash(one) === packageHash(other),
    packageHash(one).slice(0, 32));
}

// ---------------------------------------------------------------- D
// The separator is a NUL, whatever the source file calls it.
console.log('\nD  the separator is the NUL character itself');
{
  ok('a literal NUL and the escape \\0 are the same character', '\0'.charCodeAt(0) === 0);
  ok('and the same character built from its code point', String.fromCharCode(0).charCodeAt(0) === 0 && '\0' === String.fromCharCode(0));
  ok('joining with it is not joining with nothing', `a${'\0'}b` !== 'ab');
  ok('and it is one code unit', `a${'\0'}b`.length === 3);
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exitCode = fail ? 1 : 0;
