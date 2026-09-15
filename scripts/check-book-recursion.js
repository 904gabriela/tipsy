// One story may keep one book out of recursion without changing the book.
//
//   node scripts/check-book-recursion.js
//
// No model calls, no database: synthetic entries straight into activate(), so
// what is tested is the rule and nothing else.

import { activate } from '../src/engine/lorebook.js';

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? `  — ${d}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`); }
};

// Book A talks about the harbour and mentions the Ninth Pillar.
// Book B is about the Ninth Pillar and mentions the harbour back.
const entry = (o) => ({
  keys: [], secondaryKeys: [], enabled: true, constant: false, order: 100, group: '',
  probability: 100, useProbability: false, ...o,
});
const A = (extra = {}) => [
  entry({ id: 'a1', keys: ['harbour'], content: 'The harbour. Everything arrives past the Ninth Pillar.', ...extra }),
  entry({ id: 'a2', keys: ['chandlery'], content: 'The chandlery sells rope and opinions.', ...extra }),
];
const B = (extra = {}) => [
  entry({ id: 'b1', keys: ['Ninth Pillar'], content: 'The Ninth Pillar hums. It stands above the harbour.', ...extra }),
  entry({ id: 'b2', keys: ['Glasswrights'], content: 'The Glasswrights cut the pillars and answer to nobody.', ...extra }),
];
const scene = [{ role: 'user', name: 'You', content: 'I walk down to the harbour before dawn.' }];
const run = (entries, opts = {}) => activate(entries, scene, { budget: 6000, scanDepth: 2, recursive: true, ...opts });
const fired = (r) => r.entries.map((e) => e.id).sort().join(',');

console.log('A  a story that has set nothing');
{
  const r = run([...A(), ...B()]);
  ok('behaves exactly as before: the harbour pulls the pillar in',
    fired(r) === 'a1,b1', fired(r));
  const withNulls = run([...A({ bookRecursion: null }), ...B({ bookRecursion: null })]);
  ok('an explicit null is the same as no value at all', fired(withNulls) === fired(r), fired(withNulls));
}

console.log('\nB  the story has switched recursion off entirely');
{
  const r = run([...A(), ...B({ bookRecursion: 'block' })], { recursive: false });
  ok('nothing recurses, whatever the books say', fired(r) === 'a1', fired(r));
}

console.log('\nC  one book blocked, the other left alone');
{
  const r = run([...A(), ...B({ bookRecursion: 'block' })]);
  ok('the blocked book is not pulled in by hearsay', !fired(r).includes('b1'), fired(r));
  ok('and the open book still fires from the scene', fired(r).includes('a1'));

  // Now the other way round: the scene names the blocked book directly.
  const direct = activate([...A(), ...B({ bookRecursion: 'block' })],
    [{ role: 'user', name: 'You', content: 'I stand under the Ninth Pillar.' }],
    { budget: 6000, scanDepth: 2, recursive: true });
  ok('a blocked book still activates normally from the scene',
    direct.entries.some((e) => e.id === 'b1'), fired(direct));
  ok('but it does not seed a cascade back into the open book',
    !fired(direct).includes('a1'), fired(direct));

  // And constants in a blocked book are unaffected.
  const konst = activate([...A(), ...B({ bookRecursion: 'block' })].map((e) => (e.id === 'b2' ? { ...e, constant: true } : e)),
    scene, { budget: 6000, scanDepth: 2, recursive: true });
  ok('always-on entries in a blocked book still come in',
    konst.entries.some((e) => e.id === 'b2'), fired(konst));
}

console.log('\nD/E/F  the entry flags still do their own jobs');
{
  const stop = run([...A().map((e) => (e.id === 'a1' ? { ...e, preventRecursion: true } : e)), ...B()]);
  ok('preventRecursion still stops a cascade', !fired(stop).includes('b1'), fired(stop));

  const exclude = run([...A(), ...B().map((e) => (e.id === 'b1' ? { ...e, excludeRecursion: true } : e))]);
  ok('excludeRecursion still keeps an entry out', !fired(exclude).includes('b1'), fired(exclude));

  const delayed = run([...A(), ...B().map((e) => (e.id === 'b1' ? { ...e, delayUntilRecursion: true } : e))]);
  ok('delayUntilRecursion still fires only on the second pass',
    fired(delayed).includes('b1'), fired(delayed));

  const both = run([...A(), ...B({ bookRecursion: 'block' }).map((e) => (e.id === 'b1' ? { ...e, delayUntilRecursion: true } : e))]);
  ok('but not when its book is blocked', !fired(both).includes('b1'), fired(both));
}

console.log('\nG  a book that says nothing is unchanged');
{
  const before = run([...A(), ...B()]);
  const after = run([...A(), ...B({ bookRecursion: undefined })]);
  ok('undefined is the same as absent', fired(before) === fired(after), fired(after));
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail) process.exitCode = 1;
