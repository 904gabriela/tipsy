// Being sure of a reading, and being willing to accept it on someone's behalf,
// are two different questions.
//
// "Gran Torino's Apartment" is plainly a place, and the reading that says so is
// plainly right. But the name kept for it is "Apartment", and one real library
// holds three different apartments written that way. A tick Nexus applies by
// itself is one a person may never look at, so a name that could be any of
// several is left for them — with the reason said, so an unticked strong
// reading does not read as a failure.
//
//   node scripts/check-preselection.js
//
// Throwaway databases. No real title or place appears here.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '../src/db/index.js';
import { analyzeSource } from '../src/conversion/analyze.js';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};
const tmp = () => join(mkdtempSync(join(tmpdir(), 'nexus-pre-')), 'x.db');
const analyse = (entries) => {
  const db = open(tmp());
  const id = db.createLorebook('Fixture', '');
  for (const e of entries) {
    db.saveEntry(id, {
      order: 100, enabled: true, constant: false, probability: 100,
      keys: e.keys || [], kind: e.kind || 'note', title: e.title, content: e.content,
    });
  }
  const draft = analyzeSource(db, id, {});
  db.close();
  return draft;
};
const of = (d, title) => d.entries.find((e) => e.title === title);
const settled = (p) => !!p && !(p.scope === 'entity' && !p.subject && !p.defines);
// The same rule the screen uses to decide what arrives ticked.
const ticked = (d, title) => !!of(d, title)?.autoSelect;
const d3 = (d, title) => {
  const e = of(d, title);
  return d.entities.find((x) => x.ref === e?.proposal?.subject)?.name ?? null;
};
const named = (d, title) => {
  const e = of(d, title);
  return d.entities.find((x) => x.ref === e?.proposal?.defines)?.name ?? null;
};

// A source with somebody who owns things, so a possessive title has an owner.
const PEOPLE = [
  { title: 'Aurelio Fontana', kind: 'character', keys: ['Aurelio Fontana', 'Fontana'], content: 'Aurelio Fontana, 46, keeps the books for three families. He is careful, quiet, and owed favours by everyone.' },
  { title: 'Renata Salk', kind: 'character', keys: ['Renata Salk', 'Salk'], content: 'Renata Salk, 38, runs the night market and misses nothing. She is blunt and difficult to lie to.' },
];

console.log('A  a name that could be any of several is left for you');
{
  const draft = analyse([...PEOPLE,
    { title: "Aurelio's Apartment", kind: 'place', keys: ["Aurelio's Apartment"], content: "Aurelio's Apartment is a small flat above the arcade. The apartment has one window onto the yard and a door he never locks." },
    { title: "Renata's Apartment", kind: 'place', keys: ["Renata's Apartment"], content: "Renata's Apartment is two rooms behind the market. The apartment is warm in winter and full of other people's post." },
  ]);
  ok('the reading still says it is a place', of(draft, "Aurelio's Apartment")?.proposal?.scope === 'entity',
    `${of(draft, "Aurelio's Apartment")?.proposal?.scope}/${of(draft, "Aurelio's Apartment")?.proposal?.category}`);
  ok('and Nexus is still sure of it', of(draft, "Aurelio's Apartment")?.confidence === 'high',
    `confidence ${of(draft, "Aurelio's Apartment")?.confidence}`);
  ok('but it does not arrive ticked', !ticked(draft, "Aurelio's Apartment"), `name kept: ${JSON.stringify(named(draft, "Aurelio's Apartment"))}`);
  ok('and it says why', !!of(draft, "Aurelio's Apartment")?.reviewRisk, of(draft, "Aurelio's Apartment")?.reviewRisk || '(no reason given)');
}

console.log('\nB  an ordinary place is untouched');
{
  const draft = analyse([...PEOPLE,
    { title: 'The Glasshouse', kind: 'place', keys: ['Glasshouse'], content: 'The Glasshouse is a restaurant on the quay, and neutral ground where the families meet. Its windows face the water.' },
  ]);
  ok('it arrives ticked', ticked(draft, 'The Glasshouse'), `confidence ${of(draft, 'The Glasshouse')?.confidence}, name ${JSON.stringify(named(draft, 'The Glasshouse'))}`);
  ok('with nothing held against it', !of(draft, 'The Glasshouse')?.reviewRisk);
}

console.log('\nC  a possessive whose own words give it a name of its own');
{
  const draft = analyse([...PEOPLE,
    { title: "Aurelio's Verity Room", kind: 'place', keys: ['Verity'], content: "Aurelio's Verity Room is a quiet room at the top of the hill house that nobody else uses. The Verity Room has one bell and a locked side door." },
  ]);
  ok('a distinctive name is kept and ticked', ticked(draft, "Aurelio's Verity Room"),
    `name ${JSON.stringify(named(draft, "Aurelio's Verity Room"))}, risk ${JSON.stringify(of(draft, "Aurelio's Verity Room")?.reviewRisk)}`);
}

console.log('\nD  a person is never renamed by this');
{
  const draft = analyse([...PEOPLE,
    { title: "Renata's Brother", kind: 'character', keys: ["Renata's Brother"], content: 'He is nineteen, works the stalls, and has never left the district. He is quieter than his sister and watches everything.' },
  ]);
  const e = of(draft, "Renata's Brother");
  ok('a person entry is not held back by the name rule', !e?.reviewRisk, e?.reviewRisk || 'no risk flagged');
}

console.log('\nE  the two questions stay separate');
{
  const draft = analyse([...PEOPLE,
    { title: "Aurelio's Apartment", kind: 'place', keys: ["Aurelio's Apartment"], content: "Aurelio's Apartment is a small flat above the arcade. The apartment has one window onto the yard and a door he never locks." },
  ]);
  const e = of(draft, "Aurelio's Apartment");
  ok('confidence was not lowered to force the tick off', e?.confidence === 'high', `confidence ${e?.confidence}`);
  ok('the proposal itself is unchanged and still offered', !!e?.proposal?.defines);
}

console.log('\nG  an entry about somebody is not ticked, however clearly it reads');
{
  const draft = analyse([...PEOPLE,
    { title: 'Childhood', kind: 'character', keys: ['childhood'], content: 'Aurelio Fontana grew up above a bakery and learned to read a room before he could read. His mother kept the books before he did.' },
    { title: 'What he is afraid of', kind: 'character', keys: ['fear'], content: 'Aurelio Fontana is afraid of being owed something he cannot repay. He would rather give than borrow, and says so.' },
  ]);
  for (const t of ['Childhood', 'What he is afraid of']) {
    const e = of(draft, t);
    ok(`"${t}" is about somebody, not an introduction of them`, !e?.proposal?.defines && !!e?.proposal?.subject,
      `defines ${JSON.stringify(named(draft, t))}, subject ${JSON.stringify(d3(draft, t))}`);
    ok('  it is not ticked', !ticked(draft, t), `autoSelect ${JSON.stringify(e?.autoSelect)}`);
  }
  // The point the policy turns on: strong evidence, still not ticked. The
  // policy withholds the tick and leaves the confidence alone.
  const strong = ['Childhood', 'What he is afraid of'].map((t) => of(draft, t)).filter((e) => e?.confidence === 'high');
  ok('at least one of them is strongly evidenced and still not ticked',
    strong.length > 0 && strong.every((e) => !e.autoSelect),
    `${strong.length} high, ticked ${strong.filter((e) => e.autoSelect).length}`);
  ok('and none of them was pushed down to unsure',
    ['Childhood', 'What he is afraid of'].every((t) => of(draft, t)?.confidence !== 'low'),
    ['Childhood', 'What he is afraid of'].map((t) => `${t}: ${of(draft, t)?.confidence}`).join(', '));
}

console.log('\nH  a reading already saved is left exactly alone');
{
  const draft = analyse([...PEOPLE,
    { title: 'The Glasshouse', kind: 'place', keys: ['Glasshouse'], content: 'The Glasshouse is a restaurant on the quay, and neutral ground where the families meet. Its windows face the water.' },
  ]);
  ok('nothing here ticks an entry that was already approved',
    draft.entries.every((e) => e.current !== 'approved' || !e.autoSelect));
}

console.log('\nI  nothing sweeps up what Nexus would not decide');
{
  const app = readFileSync(join(here, '..', 'public', 'app.js'), 'utf8');
  // What Nexus is willing to decide is already ticked when the screen opens, so
  // an "accept everything understood" button could only ever add the readings it
  // deliberately withheld. There is no such button, and no handler behind one.
  ok('no bulk action accepts every strong reading at once', !/rv-accept-clear/.test(app));
  ok('and nothing counts them as waiting to be swept up', !/clearWaiting/.test(app));
  // Nor is there one for the weaker suggestions any more. Sharing a category is
  // not evidence that a hundred readings are right, so a suggestion is used one
  // at a time, on its own card, by somebody who looked at it.
  ok('no action accepts a whole group of weaker suggestions', !/data-accept-section/.test(app));
  ok('and no handler behind one', !/acceptSection/.test(app));
  // Every place that ticks a reading ticks exactly one, reached by its own ref.
  // A tick applied while walking the whole set is what a bulk action is, so the
  // shape is what is checked rather than the count.
  ok('nothing ticks readings by walking over all of them',
    !/for \([^)]*review\.entries\.values\(\)[\s\S]{0,300}?\.approve = true/.test(app));
  const ticks = [...app.matchAll(/\.approve = true/g)].length;
  ok('and every place that ticks one is reached from a single entry', ticks > 0, `${ticks} per-entry actions`);
}

console.log('\nF  the screen uses the same rule, and says why');
{
  const app = readFileSync(join(here, '..', 'public', 'app.js'), 'utf8');
  ok('the tick follows the policy rather than repeating it', /approve: !!e\.autoSelect,/.test(app));
  // It is asked as a question about the entry, not confessed as something the
  // analyser failed at: a strong reading left unticked must not read as a
  // failure, and the reason it waits is said where it waits.
  ok('and a held-back reading asks rather than apologises',
    /rather than introducing them\. Save it as being about them\?/.test(app));
  ok('and its group says why such readings wait',
    /Read clearly, and still not accepted on your behalf\./.test(app));
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exitCode = fail ? 1 : 0;
