// The import and library experience, over HTTP, against a throwaway server.
//
//   PORT=8821 DB_PATH=data/lib.db node server.js &   then   node scripts/check-library.js 8821
//
// Everything here goes through the same endpoints the browser uses, so a
// route that changes shape fails here rather than in your hands.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 8821);
const B = `http://localhost:${PORT}`;
const DIR = 'tests/fixtures/semantics';

let pass = 0; let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};

const G = (p) => fetch(B + p).then(async (r) => ({ status: r.status, body: await r.json() }));
const J = (p, b) => fetch(B + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

/** Exactly what the file input does: raw bytes, name in a header. */
const drop = (name, bytes, keep = false) => fetch(`${B}/api/import${keep ? '?keep=1' : ''}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(name) },
  body: bytes,
}).then(async (r) => ({ status: r.status, body: await r.json() }));

const fixture = (f) => readFileSync(join(DIR, f));
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const people = files.filter((f) => /^[AFHJK]/.test(f));
const odd = files.filter((f) => /^[BCDGIL]/.test(f));

// ---------------------------------------------------- A. a pile of characters
console.log('A  twenty obvious characters at once');
{
  // Five distinct cards, renamed four times over, which is what a bulk drop
  // of downloads actually looks like: many files, all plainly people.
  const twenty = [];
  for (let copy = 0; copy < 4; copy++) {
    for (const f of people) {
      const j = JSON.parse(fixture(f).toString('utf8'));
      j.data.name = `${j.data.name} ${copy + 1}`;
      twenty.push([`${copy}-${f}`, Buffer.from(JSON.stringify(j))]);
    }
  }
  const results = [];
  for (const [n, bytes] of twenty) results.push((await drop(n, bytes)).body);

  ok('all twenty came in', results.length === 20 && results.every((r) => r.kind === 'character'),
    `${results.filter((r) => r.kind === 'character').length} characters`);
  ok('none of them asked a question', results.every((r) => !r.needsReview));
  ok('each says it took the fast path', results.every((r) => r.role === 'character' && r.confidence === 'high'));

  const lib = (await G('/api/library')).body;
  ok('and they are all in the collection', lib.characters.length >= 20, `${lib.characters.length} in the library`);
  ok('their tags came with them',
    new Set(lib.characters.flatMap((c) => c.tags)).size >= 8,
    `${new Set(lib.characters.flatMap((c) => c.tags)).size} distinct tags`);
  ok('their greetings were kept as ways to begin',
    lib.characters.some((c) => c.starts >= 1));
}

// ------------------------------------------------------------ B. a mixed drop
console.log('\nB  a mixed handful');
{
  const drops = [
    ['Bakugo-ish.json', 'A-single-character.json'],
    ['Hawks-ish.json', 'F-character-with-lorebook.json'],
    ['Patrick-ish.json', 'K-second-person-character.json'],
    ['Sleepover.json', 'B-ensemble-scenario.json'],
    ['Infinity.json', 'D-campaign-framework.json'],
  ];
  const out = [];
  for (const [as, from] of drops) {
    const j = JSON.parse(fixture(from).toString('utf8'));
    j.data.name = `${j.data.name} (mixed)`;
    out.push((await drop(as, Buffer.from(JSON.stringify(j)))).body);
  }
  const straightIn = out.filter((r) => r.kind === 'character');
  const held = out.filter((r) => r.needsReview);
  ok('the three people went straight in', straightIn.length === 3,
    straightIn.map((r) => r.name.split(' ')[0]).join(', '));
  ok('only two waited for a look', held.length === 2,
    held.map((r) => `${r.name.split(' ')[0]}→${r.plan.role}`).join(', '));
  ok('and the people were not held up by them',
    straightIn.every((r) => r.id));
  ok('the queue says what each one looks like',
    held.some((r) => r.plan.role === 'scenario') && held.some((r) => r.plan.role === 'framework'));
  ok('and offers only the roles it can defend',
    held.every((r) => r.plan.choices.map((c) => c.role).join(',') === 'character,scenario,framework'));
  ok('with plain words for each one',
    held[0].plan.choices.every((c) => c.hint && !/charaCard|spec_v2/i.test(c.hint)));
}

// ----------------------------------------------- C. one package, joined up
console.log('\nC  a world arrives as one package');
{
  const j = JSON.parse(fixture('D-campaign-framework.json').toString('utf8'));
  j.data.name = 'VERRIDGE for review';
  const held = (await drop('verridge.json', Buffer.from(JSON.stringify(j)))).body;
  ok('it was held for a look', held.needsReview === true);
  const p = held.plan;
  ok('it reads as a world', p.role === 'framework' && p.confidence === 'high');
  ok('its contents are listed', p.parts.length >= 4, p.parts.map((x) => x.label).join(', '));
  ok('the lore is named among them', p.parts.some((x) => /21 entries/.test(x.detail)));
  ok('the ways in are named too', p.parts.some((x) => /3 to choose from/.test(x.detail)));
  ok('the narrator instructions are named', p.parts.some((x) => x.id === 'narrator'));
  ok('and it says what it would make, as one package',
    p.resources.length === 3 && p.resources[0].part === 'primary',
    p.resources.map((r) => r.label).join(' + '));

  const took = await J('/api/import/commit', { importId: held.importId });
  ok('bringing it in makes the world', took.body.kind === 'framework');
  const f = (await G(`/api/frameworks/${took.body.id}`)).body;
  ok('with its lore attached', f.lorebooks?.[0]?.entries === 21);
  ok('and its three ways in', f.startingPoints.length === 3);
  ok('it appears on its own shelf, not among the people',
    (await G('/api/library')).body.frameworks.some((x) => x.id === took.body.id)
    && !(await G('/api/library')).body.characters.some((x) => x.name === 'VERRIDGE for review'));
}

// -------------------------------------------------------- D. saying otherwise
console.log('\nD  overruling it');
{
  const j = JSON.parse(fixture('D-campaign-framework.json').toString('utf8'));
  j.data.name = 'VERRIDGE as a person';
  const held = (await drop('verridge2.json', Buffer.from(JSON.stringify(j)))).body;
  const took = await J('/api/import/commit', { importId: held.importId, role: 'character' });
  ok('it can be brought in as a person instead', took.body.kind === 'character');
  ok('and it knows you overruled it', took.body.overridden === true);
  const rec = (await G(`/api/imports/${held.importId}`)).body;
  ok('the record keeps both readings',
    rec.detectedRole === 'framework' && rec.chosenRole === 'character',
    `read as ${rec.detectedRole}, kept as ${rec.chosenRole}`);
  ok('and still knows which file it was', Boolean(rec.filename));
}

// --------------------------------------------------------- E/F. ways to begin
console.log('\nE/F  openings');
{
  const j = JSON.parse(fixture('H-full-field-regression.json').toString('utf8'));
  j.data.name = 'Dario with four ways';
  const r = (await drop('dario4.json', Buffer.from(JSON.stringify(j)))).body;
  const starts = (await G(`/api/starts/character/${r.id}`)).body.starts;
  ok('a card with four openings keeps all four', starts.length === 4, `${starts.length}`);
  ok('each one carries enough text to tell them apart',
    starts.every((s) => s.content.length > 20));

  const chosen = starts[2];
  const story = await J('/api/stories', { characterIds: [r.id], startingPointId: chosen.id });
  const opened = (await G(`/api/stories/${story.body.id}`)).body;
  ok('the one you pick is the one the story opens on',
    opened.messages[0].content.slice(0, 30) === chosen.content.slice(0, 30),
    `opened on "${opened.messages[0].content.slice(0, 34)}…"`);

  const single = JSON.parse(fixture('A-single-character.json').toString('utf8'));
  single.data.name = 'Rin with one way';
  const one = (await drop('rin1.json', Buffer.from(JSON.stringify(single)))).body;
  const oneStarts = (await G(`/api/starts/character/${one.id}`)).body.starts;
  ok('a card with one opening offers exactly one, so nothing is asked',
    oneStarts.length === 1, `${oneStarts.length}`);
  const plain = await J('/api/stories', { characterIds: [one.id] });
  ok('and starting it still opens on the greeting',
    (await G(`/api/stories/${plain.body.id}`)).body.messages.length === 1);
}

// ------------------------------------------------------------- G. duplicates
console.log('\nG  the same file twice');
{
  const j = JSON.parse(fixture('J-structured-character.json').toString('utf8'));
  j.data.name = 'Sable the only one';
  const bytes = Buffer.from(JSON.stringify(j));
  const first = (await drop('sable.json', bytes)).body;
  ok('the first one comes in', first.kind === 'character');

  const again = (await drop('sable.json', bytes)).body;
  ok('the same bytes are recognised, not imported twice', again.kind === 'duplicate', again.kind);
  ok('and it says where the first one went', Boolean(again.already?.importId));
  ok('the library did not grow',
    (await G('/api/library')).body.characters.filter((c) => c.name === 'Sable the only one').length === 1);

  const renamed = (await drop('sable-copy.json', bytes)).body;
  ok('a different filename is still the same file', renamed.kind === 'duplicate');

  const kept = (await drop('sable.json', bytes, true)).body;
  ok('but you can keep both on purpose', kept.kind === 'character');
  ok('and then there are two',
    (await G('/api/library')).body.characters.filter((c) => c.name === 'Sable the only one').length === 2);

  const edited = JSON.parse(bytes.toString('utf8'));
  edited.data.description += ' One more sentence.';
  const near = (await drop('sable-edited.json', Buffer.from(JSON.stringify(edited)))).body;
  ok('a nearly-identical card is NOT treated as the same file', near.kind === 'character');
}

// ------------------------------------------------------- H/I. finding things
console.log('\nH/I  finding things again');
{
  const lib = (await G('/api/library')).body;
  // The same filter the shelf runs, applied here so a change to the payload
  // that breaks searching fails in a test rather than in her hands.
  const match = (items, text, tags = []) => {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((c) => {
      const mine = new Set((c.tags || []).map((t) => String(t).toLowerCase()));
      for (const t of tags) if (!mine.has(t)) return false;
      const hay = `${c.name} ${c.nickname || ''} ${c.description || ''} ${[...mine].join(' ')}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  };
  ok('searching a tag finds the cards that carry it',
    match(lib.characters, '', ['mafia']).length > 0,
    `${match(lib.characters, '', ['mafia']).length} tagged mafia`);
  ok('searching a name finds the person', match(lib.characters, 'dario').length > 0);
  ok('searching words from a description finds them',
    match(lib.characters, 'homicide').length > 0,
    `${match(lib.characters, 'homicide').length} for "homicide"`);
  ok('two tags narrow rather than widen',
    match(lib.characters, '', ['mafia', 'crime']).length <= match(lib.characters, '', ['mafia']).length);
  ok('every card carries what the shelf needs to draw it',
    lib.characters.every((c) => c.name && 'avatar' in c && Array.isArray(c.tags) && 'created_at' in c));
  ok('and what it needs to sort by',
    lib.characters.every((c) => 'last_used' in c && 'starts' in c));
}

// --------------------------------------------- J. the shelves the app reads
console.log('\nJ  the collection the app draws from');
{
  const lib = (await G('/api/library')).body;
  ok('characters are still there, in the shape they always were',
    Array.isArray(lib.characters) && lib.characters.length > 20);
  ok('lorebooks are still there', Array.isArray(lib.lorebooks));
  ok('stories are still there', Array.isArray(lib.stories));
  ok('personas are still there', Array.isArray(lib.personas));
  ok('and the two new shelves are added, not substituted',
    Array.isArray(lib.scenarios) && Array.isArray(lib.frameworks),
    `${lib.scenarios.length} scenarios, ${lib.frameworks.length} worlds`);
  ok('a world says how much is in it',
    lib.frameworks.every((f) => 'lorebooks' in f && 'starts' in f && 'stories' in f));
  ok('a scenario says how many ways it can begin',
    lib.scenarios.every((s) => 'starts' in s));
}

// --------------------------------------------------- scenario into a story
console.log('\nstarting from a scenario');
{
  const j = JSON.parse(fixture('B-ensemble-scenario.json').toString('utf8'));
  j.data.name = 'Sleepover to play';
  const held = (await drop('sleepover.json', Buffer.from(JSON.stringify(j)))).body;
  const took = await J('/api/import/commit', { importId: held.importId });
  ok('it became a scenario', took.body.kind === 'scenario');
  const s = (await G(`/api/scenarios/${took.body.id}`)).body;
  ok('with three ways to begin', s.startingPoints.length === 3);

  const one = await J(`/api/scenarios/${s.id}/start`, { startingPointId: s.startingPoints[1].id });
  const two = await J(`/api/scenarios/${s.id}/start`, { startingPointId: s.startingPoints[0].id });
  ok('two stories can start from it', one.body.storyId !== two.body.storyId);
  const a = (await G(`/api/stories/${one.body.storyId}`)).body;
  const b = (await G(`/api/stories/${two.body.storyId}`)).body;
  ok('each opens where it was told to', a.messages[0].content !== b.messages[0].content);
  ok('and they are separate continuities', a.id !== b.id && a.messages.length === 1 && b.messages.length === 1);
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail) process.exitCode = 1;
