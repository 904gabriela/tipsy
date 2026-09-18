// When Nexus says it is sure, what is it sure of?
//
// Knowing which name a sentence contains is not the same as knowing what the
// sentence says. A timeline record naming a training camp was read, with high
// confidence, as that camp's *skill* — the name was right and the reading was
// nonsense. An entry that arrives already ticked is one a person may never look
// at, so that is the one place certainty has to be earned across the whole
// reading and not just the name.
//
// These checks use sources shaped like real ones. Nothing here is copied from
// anyone's library.
//
//   node scripts/check-confidence-safety.js

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
const tmp = () => join(mkdtempSync(join(tmpdir(), 'nexus-conf-')), 'x.db');
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
const settled = (p) => !!p && !(p.scope === 'entity' && !p.subject && !p.defines);
const of = (draft, title) => draft.entries.find((e) => e.title === title);
const ticked = (draft, title) => {
  const e = of(draft, title);
  return !!e && e.confidence === 'high' && settled(e.proposal) && e.current !== 'approved';
};
const reading = (draft, title) => {
  const e = of(draft, title);
  const p = e?.proposal || {};
  const nm = (r) => draft.entities.find((x) => x.ref === r)?.name ?? null;
  return `${p.scope}/${p.category} defines ${JSON.stringify(nm(p.defines))} subject ${JSON.stringify(nm(p.subject))} [${e?.confidence}]`;
};

// A source with a place, a group, and timeline records that mention them — the
// shape that produced the wrong certainties.
const WORLD = [
  { title: 'Cedar Hollow Training Camp', kind: 'place', keys: ['Cedar Hollow Training Camp'], content: 'Cedar Hollow Training Camp is a training ground in the hills, with cabins, a river crossing and a long approach road. It is used for exercises away from the school.' },
  { title: 'The Lantern Training Society', kind: 'faction', keys: ['Lantern Training Society'], content: 'The Lantern Training Society is an organisation of graduates who fund the school quietly. Members are recruited late and rarely named in public.' },
  { title: 'Nadia Belmonte', kind: 'character', keys: ['Nadia Belmonte', 'Belmonte'], content: 'NAME: Nadia Belmonte\nSTABLE CORE: Watchful, dry, and hard to impress.\nShe is steady under pressure and her mother taught her to be.\nVOICE: Clipped in public, warmer alone.' },
  // A source says a thing twice. One entry alone is thin evidence of anything,
  // and these checks are about certainty, so the fixture gives them what a real
  // lorebook gives them: other entries that mention them in passing.
  { title: 'The approach road', kind: 'place', keys: ['road'], content: 'The road up to Cedar Hollow Training Camp is single track for the last mile, and Nadia Belmonte knows every turn of it.' },
  { title: 'Funding', kind: 'note', keys: ['funding'], content: 'The Lantern Training Society pays for the cabins at Cedar Hollow Training Camp, and Nadia Belmonte has never asked where the money comes from.' },
];

console.log('A  a place does not have a skill');
{
  const draft = analyse([...WORLD,
    { title: 'TIMELINE — Cedar Hollow Training Camp in progress', kind: 'event', keys: ['Cedar Hollow Training Camp'], content: 'PRECONDITION: term ends. EVENT: the classes train at Cedar Hollow Training Camp for a week. Cedar Hollow Training Camp is crowded and the river crossing is used daily.' },
  ]);
  ok('the timeline record does not arrive ticked', !ticked(draft, 'TIMELINE — Cedar Hollow Training Camp in progress'), reading(draft, 'TIMELINE — Cedar Hollow Training Camp in progress'));
  ok('and it is still offered, not thrown away', !!of(draft, 'TIMELINE — Cedar Hollow Training Camp in progress')?.proposal);
}

console.log('\nB  nor an appearance');
{
  const draft = analyse([...WORLD,
    { title: 'TIMELINE — The Lantern Training Society in progress', kind: 'event', keys: ['Lantern Training Society'], content: 'PRECONDITION: the camp week. EVENT FRAME: the students move into the halls the Lantern Training Society paid for. The Lantern Training Society is thanked at the opening and says little.' },
  ]);
  ok('a group is not given a personal category with certainty', !ticked(draft, 'TIMELINE — The Lantern Training Society in progress'), reading(draft, 'TIMELINE — The Lantern Training Society in progress'));
}

console.log('\nC  an event record is not somebody\'s backstory just because they are in it');
{
  const draft = analyse([...WORLD,
    { title: 'TIMELINE — The river crossing', kind: 'event', keys: ['Nadia Belmonte'], content: 'PRECONDITION: camp week. EVENT: the river rises overnight. Nadia Belmonte carries two of the younger students across and says nothing about it afterwards. Nadia Belmonte is quietly praised for it.' },
  ]);
  ok('the event does not arrive ticked as one person\'s own material',
    !ticked(draft, 'TIMELINE — The river crossing'), reading(draft, 'TIMELINE — The river crossing'));
}

console.log('\nD  a family is not a person');
{
  const draft = analyse([...WORLD,
    { title: 'The Belmonte family', kind: 'character', keys: ['Belmonte family'], content: 'The Belmonte family keeps the mill and three of them work it. They are an organisation in everything but name, and members are expected to stay.' },
  ]);
  const e = of(draft, 'The Belmonte family');
  const kind = draft.entities.find((x) => x.ref === (e?.proposal?.defines))?.type;
  ok('a family reads as a group, not a person', kind !== 'person', `defined as ${JSON.stringify(kind)}`);
}

console.log('\nE  a real profile is still something Nexus is sure of');
{
  const draft = analyse(WORLD);
  ok('the person with a NAME: record arrives ticked', ticked(draft, 'Nadia Belmonte'), reading(draft, 'Nadia Belmonte'));
}

console.log('\nF  and so is a clearly defined place or group');
{
  const draft = analyse(WORLD);
  ok('the place arrives ticked', ticked(draft, 'Cedar Hollow Training Camp'), reading(draft, 'Cedar Hollow Training Camp'));
  ok('the group arrives ticked', ticked(draft, 'The Lantern Training Society'), reading(draft, 'The Lantern Training Society'));
}

console.log('\nG  a person\'s own material still reads as theirs');
{
  const draft = analyse([...WORLD,
    { title: 'What she carries', kind: 'character', keys: ['Belmonte'], content: 'Nadia Belmonte keeps her grandfather\'s knife in her coat and has never drawn it. She says it is a reminder rather than a weapon.' },
  ]);
  const e = of(draft, 'What she carries');
  const nm = (r) => draft.entities.find((x) => x.ref === r)?.name ?? null;
  ok('it is about her', nm(e?.proposal?.subject) === 'Nadia Belmonte', reading(draft, 'What she carries'));
  ok('and Nexus is not forced to be unsure about it', e?.confidence !== 'low', `confidence ${e?.confidence}`);
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exitCode = fail ? 1 : 0;
