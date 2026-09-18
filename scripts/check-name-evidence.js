// What counts as evidence that somebody is in a source, and what does not.
//
// Reading one real library taught the deterministic pass its manners; reading a
// second one showed what it had learned by accident. A lorebook whose entries
// are titled "04 CLASS 1-A — Katsuki Bakugo" and whose every character record
// repeats the headings NAME:, STABLE CORE: and LIMITED KNOWLEDGE: produced a
// person called STABLE CORE, a person called Hero Killer who was "named in the
// first sentence" of an entry that never mentions him, and ninety-one character
// sheets read as instructions to the narrator.
//
// These checks describe what the pass may conclude from a name, using sources
// shaped like the real ones rather than copies of them. No real title, person
// or lorebook from anyone's library appears here.
//
//   node scripts/check-name-evidence.js
//
// Throwaway databases.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../src/db/index.js';
import { analyzeSource } from '../src/conversion/analyze.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};
const tmp = () => join(mkdtempSync(join(tmpdir(), 'nexus-names-')), 'x.db');

/** A source built from plain entries, analysed the way the screen asks for it. */
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
const names = (draft, type = null) => draft.entities
  .filter((e) => !type || e.type === type).map((e) => e.name).sort();
const entityNamed = (draft, name) => draft.entities.find((e) => e.name.toLowerCase() === name.toLowerCase());
const entryTitled = (draft, title) => draft.entries.find((e) => e.title === title);
const subjectOf = (draft, title) => {
  const e = entryTitled(draft, title);
  const ref = e?.proposal?.subject;
  return ref ? draft.entities.find((x) => x.ref === ref)?.name ?? ref : null;
};
const definesOf = (draft, title) => {
  const e = entryTitled(draft, title);
  const ref = e?.proposal?.defines;
  return ref ? draft.entities.find((x) => x.ref === ref)?.name ?? ref : null;
};

// A character record shaped like the ones a templated lorebook produces: a run
// of shouted field headings, and prose that plainly describes a person.
const record = (who, she = true) => `NAME: ${who}
STABLE CORE: Determined, watchful, and slow to trust.
${she ? 'She' : 'He'} is careful with people ${she ? 'she' : 'he'} does not know yet, and ${she ? 'her' : 'his'} mother worries about it.
VOICE AND SOCIAL HABITS: Clipped in public, warmer alone.
LIMITED KNOWLEDGE: Nothing beyond ordinary personal thoughts.`;

// ---------------------------------------------------------------- A
// Two words that are ordinary on their own do not become a way of naming the
// pair. "Hero" in "Hero Course" is not the Hero Killer; "Core" in a heading is
// not a person called STABLE CORE.
console.log('A  half of a two-word label is not the label');
{
  const draft = analyse([
    { title: 'The school', kind: 'place', keys: ['school'], content: 'An elite school with a Hero Course, a General Studies course and a Support Course. Faculty are active or retired heroes with distinct teaching styles. Admission proves potential, not mastery.' },
    { title: 'Street talk', kind: 'note', keys: ['Hero Killer'], content: 'People still speak of the Hero Killer in low voices. The Hero Killer has not been seen since the spring.' },
    { title: 'Aftermath', kind: 'note', keys: ['Hero Killer'], content: 'The Hero Killer left the district changed, and the Hero Course was reorganised because of it.' },
  ]);
  const hk = entityNamed(draft, 'Hero Killer');
  ok('a two-word name the source looks things up by is still found', !!hk, names(draft).join(', '));
  ok('but "Hero" alone is not one of its aliases',
    !hk || !hk.aliases.some((a) => a.toLowerCase() === 'hero'), JSON.stringify(hk?.aliases));
  const school = entryTitled(draft, 'The school');
  ok('so an entry that only says "Hero Course" is not about the Hero Killer',
    subjectOf(draft, 'The school') !== 'Hero Killer', `subject ${JSON.stringify(subjectOf(draft, 'The school'))}`);
  ok('and no evidence claims that name is present there',
    !(school?.evidence || []).some((v) => /Hero Killer/.test(String(v.detail))),
    (school?.evidence || []).map((v) => v.type).join(', '));

  // The other half of the same rule: capitalised words the source never looks
  // anything up by, and never writes possessively, are its vocabulary rather
  // than its cast. A technique is not a person because it recurs.
  const loose = analyse([
    { title: 'Training', kind: 'note', keys: ['training'], content: 'Students practise Full Cowling until it stops costing them a broken finger. Full Cowling is the difference between a technique and an injury.' },
    { title: 'The exam', kind: 'note', keys: ['exam'], content: 'Full Cowling was not permitted during the Entrance Exam, and the Entrance Exam decided who stayed.' },
    { title: 'Afterwards', kind: 'note', keys: ['after'], content: 'Nobody who passed the Entrance Exam forgot it, and Full Cowling came later.' },
  ]);
  ok('a phrase met only in passing is not made into somebody',
    !entityNamed(loose, 'Full Cowling') && !entityNamed(loose, 'Entrance Exam'),
    loose.entities.map((e) => `${e.name} (${e.type})`).join(', ') || 'no entities');
}

// ---------------------------------------------------------------- B
// A title that begins with the source's own filing system is filed, not named.
// The prefix repeats across many entries; the part after it does not.
console.log('\nB  a filing prefix is not part of anybody\'s name');
{
  const draft = analyse([
    { title: '04 CLASS 1-A — Rina Okabe', kind: 'character', keys: ['Rina Okabe', 'Okabe'], content: record('Rina Okabe') },
    { title: '04 CLASS 1-A — Sen Fujimoto', kind: 'character', keys: ['Sen Fujimoto'], content: record('Sen Fujimoto', false) },
    { title: '04 CLASS 1-A — Aya Morikawa', kind: 'character', keys: ['Aya Morikawa'], content: record('Aya Morikawa') },
    { title: '07 STAFF — Hana Terada', kind: 'character', keys: ['Hana Terada'], content: record('Hana Terada') },
    { title: '07 STAFF — Goro Minami', kind: 'character', keys: ['Goro Minami'], content: record('Goro Minami', false) },
    { title: '07 STAFF — Noe Sakaguchi', kind: 'character', keys: ['Noe Sakaguchi'], content: record('Noe Sakaguchi') },
    { title: '09 VILLAINS — Kuro Ishimaru', kind: 'character', keys: ['Kuro Ishimaru'], content: record('Kuro Ishimaru', false) },
    { title: '09 VILLAINS — Mika Tsurugi', kind: 'character', keys: ['Mika Tsurugi'], content: record('Mika Tsurugi') },
    { title: '09 VILLAINS — Ren Hayakawa', kind: 'character', keys: ['Ren Hayakawa'], content: record('Ren Hayakawa', false) },
  ]);
  const found = names(draft, 'person');
  ok('the people are found under their own names', found.includes('Rina Okabe') && found.includes('Hana Terada'), found.join(', '));
  ok('no entity carries the filing prefix in its name',
    !draft.entities.some((e) => /^\d\d\s/.test(e.name)), draft.entities.map((e) => e.name).join(' | '));
  ok('and the entry is read as defining that person', definesOf(draft, '04 CLASS 1-A — Rina Okabe') === 'Rina Okabe',
    `defines ${JSON.stringify(definesOf(draft, '04 CLASS 1-A — Rina Okabe'))}`);
  ok('across more than one family of the same source',
    definesOf(draft, '09 VILLAINS — Kuro Ishimaru') === 'Kuro Ishimaru',
    `defines ${JSON.stringify(definesOf(draft, '09 VILLAINS — Kuro Ishimaru'))}`);
}

// ---------------------------------------------------------------- C
// A heading that every record repeats is the template speaking, not a person.
console.log('\nC  a heading repeated by every record is not a person');
{
  const draft = analyse([
    { title: 'Rina Okabe', kind: 'character', keys: ['Rina Okabe'], content: record('Rina Okabe') },
    { title: 'Sen Fujimoto', kind: 'character', keys: ['Sen Fujimoto'], content: record('Sen Fujimoto') },
    { title: 'Hana Terada', kind: 'character', keys: ['Hana Terada'], content: record('Hana Terada') },
    { title: 'Goro Minami', kind: 'character', keys: ['Goro Minami'], content: record('Goro Minami') },
  ]);
  for (const heading of ['STABLE CORE', 'LIMITED KNOWLEDGE', 'VOICE AND SOCIAL HABITS', 'SOCIAL HABITS']) {
    ok(`"${heading}" is nobody`, !entityNamed(draft, heading), names(draft).join(', '));
  }
  // Said once more without naming them, so a heading nobody predicted is caught
  // too: a field label shouted at the start of a line, in record after record.
  const shouted = draft.entities.filter((e) => /^[A-Z][A-Z ]{3,}$/.test(e.name));
  ok('no shouted field label became an entity at all', shouted.length === 0,
    shouted.map((e) => `${e.name} (${e.type})`).join(', '));
  ok('the people in the same source are still found',
    names(draft, 'person').includes('Rina Okabe') && names(draft, 'person').includes('Goro Minami'),
    names(draft, 'person').join(', '));
  ok('and no entry is proposed as being about a heading',
    !draft.entries.some((e) => ['stable core', 'limited knowledge'].includes(String(subjectOf(draft, e.title)).toLowerCase())));
}

// ---------------------------------------------------------------- D
// The opposite case must keep working: a real multi-word name, and the ordinary
// habit of calling somebody by one half of it.
console.log('\nD  real names, and the ordinary ways of shortening them');
{
  const draft = analyse([
    { title: 'Aurelio Fontana', kind: 'character', keys: ['Aurelio Fontana', 'Fontana'], content: 'Aurelio Fontana, 46, keeps the books for three families and has never been arrested. He is careful, quiet and owed favours by everyone.' },
    { title: 'The Fontana Rooms', kind: 'place', keys: ['Fontana Rooms'], content: 'The Fontana Rooms is a members-only club above the old arcade. Aurelio meets people there when he wants to be seen meeting them.' },
    { title: 'A favour', kind: 'note', keys: ['favour'], content: 'Aurelio never asks twice. When Aurelio calls it in, it is already decided.' },
  ]);
  ok('a person with two names is found', !!entityNamed(draft, 'Aurelio Fontana'), names(draft, 'person').join(', '));
  const a = entityNamed(draft, 'Aurelio Fontana');
  ok('and "Aurelio" alone refers to them', (a?.aliases || []).some((x) => x.toLowerCase() === 'aurelio'), JSON.stringify(a?.aliases));
  ok('an entry that only says "Aurelio" is about them', subjectOf(draft, 'A favour') === 'Aurelio Fontana',
    `subject ${JSON.stringify(subjectOf(draft, 'A favour'))}`);
  ok('a place with a shared word is its own thing, not the person',
    definesOf(draft, 'The Fontana Rooms') === 'The Fontana Rooms' || entityNamed(draft, 'The Fontana Rooms'),
    names(draft).join(', '));
}

// ---------------------------------------------------------------- E
// The behaviour a real conversion already depends on: a person with a profile,
// a family, a place, and a name the source never explains.
console.log('\nE  what a working source already relies on');
{
  const draft = analyse([
    { title: 'Aurelio Fontana', kind: 'character', keys: ['Aurelio Fontana', 'Fontana'], content: 'Aurelio Fontana, 46, runs the family\'s legitimate business and its other one. Careful, quiet, and slow to anger.' },
    { title: 'Core Identity', kind: 'character', keys: ['identity'], content: 'Aurelio Fontana is a man who keeps his word and expects the same. He does not raise his voice.' },
    { title: 'Fontana Family', kind: 'faction', keys: ['Fontana Family'], content: 'The Fontana Family is led by Aurelio and holds the river quarter. Members are recruited young and rarely leave.' },
    { title: 'The Glasshouse', kind: 'place', keys: ['Glasshouse'], content: 'The Glasshouse is a restaurant on the quay, and neutral ground where the families meet.' },
    { title: 'Mireille Guidance', kind: 'character', keys: ['Mireille'], content: 'Mireille is composed, curious and stubborn when she believes she is right. She can challenge Aurelio directly.' },
    { title: 'An evening', kind: 'note', keys: ['Mireille'], content: 'Aurelio waited while Mireille finished speaking, which he did for nobody else.' },
  ]);
  ok('the person is found', !!entityNamed(draft, 'Aurelio Fontana'), names(draft, 'person').join(', '));
  ok('the family is a faction', entityNamed(draft, 'Fontana Family')?.type === 'faction', names(draft, 'faction').join(', '));
  ok('the place is a place', entityNamed(draft, 'The Glasshouse')?.type === 'place', names(draft, 'place').join(', '));
  ok('an entry about them, with no name of its own, is about them',
    subjectOf(draft, 'Core Identity') === 'Aurelio Fontana', `subject ${JSON.stringify(subjectOf(draft, 'Core Identity'))}`);
  // The protection that matters most: a name this source never describes must
  // not quietly become the person the source is mostly about.
  const mir = entryTitled(draft, 'Mireille Guidance');
  ok('an entry naming somebody the source never describes is not handed to the lead',
    subjectOf(draft, 'Mireille Guidance') !== 'Aurelio Fontana' || (mir?.namedButUnknown || []).length > 0,
    `subject ${JSON.stringify(subjectOf(draft, 'Mireille Guidance'))}, namedButUnknown ${JSON.stringify(mir?.namedButUnknown)}`);
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exitCode = fail ? 1 : 0;
