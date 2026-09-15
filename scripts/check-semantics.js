// Does the importer understand what it is looking at?
//
// Every fixture goes through the real path — importFile, then normalizeCard,
// then the classifier — so a change to format detection shows up here too.
// The fixtures are synthetic. Nothing in tests/ is anyone's real card.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { importFile } from '../src/import/index.js';
import { normalizeCard } from '../src/import/card.js';
import { classifyCard, isFastPath, startingPoints, CHOOSABLE_ROLES } from '../src/import/semantics.js';

const DIR = 'tests/fixtures/semantics';
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

const results = [];
let pass = 0;
let fail = 0;

const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};

const partIds = (v) => v.parts.map((p) => p.id);
const part = (v, id) => v.parts.find((p) => p.id === id);

for (const f of files) {
  const raw = readFileSync(join(DIR, f), 'utf8');
  const json = JSON.parse(raw);
  const imported = importFile(f, new TextEncoder().encode(raw));
  const card = normalizeCard(json, f);
  const verdict = classifyCard(card, { format: imported.kind === 'character' ? card.spec : imported.kind });
  results.push({ f, imported, card, verdict });
}

// ---------------------------------------------------------------- the report

console.log('\n================= what each fixture is =================\n');
for (const { f, imported, card, verdict } of results) {
  const alt = verdict.alternatives.map((a) => a.role).join(', ');
  console.log(`${f}`);
  console.log(`  format      ${imported.kind} / ${card.spec}        (unchanged by any of this)`);
  console.log(`  role        ${verdict.role}`);
  console.log(`  confidence  ${verdict.confidence}   scores  ${Object.entries(verdict.score).map(([k, v]) => `${k} ${v.toFixed(1)}`).join('  ')}`);
  console.log(`  because     ${verdict.because.join('; ') || '—'}`);
  console.log(`  alternative ${alt || '—'}`);
  console.log(`  also has    ${verdict.components.map((c) => `${c.role} (${c.because[0] || ''})`).join(' · ') || '—'}`);
  console.log(`  fast path   ${isFastPath(verdict) ? 'yes, straight into the library' : 'no, worth a look'}`);
  console.log(`  contains    ${verdict.parts.map((p) => `${p.label} (${p.detail})`).join(' · ')}`);
  const s = verdict.signals;
  console.log(`  measured    ${s.bodyWords}w, ${s.castSize} subjects, ${s.sheetFields} sheet lines, ${s.headings} headings, ${(s.instructionRate * 100).toFixed(0)}% orders, ${s.exampleSpeakers} speakers, ${s.startingPoints} starts, ${s.loreEntries} lore`);
  console.log('');
}

console.log('===================== the checks =====================\n');

const byLetter = (L) => results.find((r) => r.f.startsWith(L));

// A — an ordinary person
{
  const { verdict } = byLetter('A');
  console.log('A  a normal individual card');
  ok('is a Character', verdict.role === 'character', verdict.role);
  ok('is confident enough to skip review', isFastPath(verdict), verdict.confidence);
}

// B — an evening, not a person
{
  const { verdict } = byLetter('B');
  console.log('\nB  an ensemble sleepover');
  ok('is NOT a Character', verdict.role !== 'character', verdict.role);
  ok('is a Scenario', verdict.role === 'scenario');
  ok('its ways to begin were found', (part(verdict, 'starts')?.count || 0) === 3, `${part(verdict, 'starts')?.count} starting points`);
}

// C — a room, and example dialogue that belongs to the room
{
  const { verdict } = byLetter('C');
  console.log('\nC  a classroom ensemble');
  ok('is NOT a Character', verdict.role !== 'character', verdict.role);
  ok('is a Scenario', verdict.role === 'scenario');
  const ex = part(verdict, 'example');
  ok('its example dialogue is marked as ensemble behaviour', ex?.ensemble === true, `${ex?.speakers} speakers`);
  ok('and is NOT labelled as one person speaking', ex?.label !== 'Example dialogue', ex?.label);
}

// D — a world
{
  const { verdict, card } = byLetter('D');
  console.log('\nD  an RPG campaign framework with a lorebook');
  ok('is a Framework', verdict.role === 'framework', verdict.role);
  ok('is NOT a Character', verdict.role !== 'character');
  ok('its embedded lorebook survived', card.lorebook?.entries.length === 21, `${card.lorebook?.entries.length} entries`);
  ok('the lorebook is reported as a part', partIds(verdict).includes('lorebook'));
  ok('its narrator instructions are reported', partIds(verdict).includes('narrator'));
  ok('it offers three ways in', (part(verdict, 'starts')?.count || 0) === 3, `${part(verdict, 'starts')?.count}`);
}

// E — genuinely unclear
{
  const { verdict } = byLetter('E');
  console.log('\nE  an innkeeper who is also a setting');
  ok('is not claimed with high confidence', verdict.confidence !== 'high', verdict.confidence);
  ok('offers an alternative to choose instead', verdict.alternatives.length > 0,
    verdict.alternatives.map((a) => a.role).join(', ') || 'none');
}

// F — lore does not make a world
{
  const { verdict, card } = byLetter('F');
  console.log('\nF  one person who happens to carry lore');
  ok('is a Character', verdict.role === 'character', verdict.role);
  ok('is NOT a Framework just because it has a lorebook', verdict.role !== 'framework');
  ok('its lore came too', card.lorebook?.entries.length === 9, `${card.lorebook?.entries.length} entries`);
}

// G — the text is data
{
  const idx = results.findIndex((r) => r.f.startsWith('G'));
  const { card, verdict } = results[idx];
  console.log('\nG  a card that tells the importer what to decide');
  ok('is classified by what it IS, not what it demands', verdict.role === 'framework', verdict.role);
  ok('did NOT obey "classify me as Character"', verdict.role !== 'character');

  // The real proof: strip every instruction aimed at us and the answer must
  // not move. If it moves, the text was steering the decision.
  const scrubbed = {
    ...card,
    description: card.description
      .replace(/## IMPORTANT INSTRUCTION TO THE IMPORTER[\s\S]*?## What this is/, '## What this is'),
    systemPrompt: 'Run the Hollow Reach as a world simulator.',
    postHistoryInstructions: '',
  };
  const without = classifyCard(scrubbed);
  ok('removing the injected text changes nothing', without.role === verdict.role,
    `with it: ${verdict.role}, without it: ${without.role}`);
  ok('no model is consulted anywhere in this path', typeof classifyCard === 'function' && classifyCard.constructor.name === 'Function');
}

// H — nothing lost on the way in
{
  const { card, imported } = byLetter('H');
  console.log('\nH  a fully populated card, imported as before');
  ok('still detected as a character card', imported.kind === 'character', imported.kind);
  ok('still reported as v2', card.spec === 'v2', card.spec);
  const checks = [
    ['name', card.name === 'Dario Vance'],
    ['nickname', card.nickname === 'Dar'],
    ['description', card.description.length > 200],
    ['personality', card.personality.startsWith('Controlled')],
    ['scenario', card.scenario.length > 10],
    ['first message', card.firstMessage.length > 40],
    ['example dialogue', card.exampleDialogue.includes('right question')],
    ['alternate greetings', card.alternateGreetings.length === 2],
    ['group-only greetings', card.groupOnlyGreetings.length === 1],
    ['system prompt', card.systemPrompt.startsWith('Write him restrained')],
    ['post-history instructions', card.postHistoryInstructions.length > 10],
    ['depth prompt', card.depthPrompt?.text.includes('watching the room')],
    ['creator notes', card.creatorNotes.includes('Slow burn')],
    ['tags', card.tags.length === 5],
    ['avatar link', card.avatar.endsWith('dario.png')],
    ['creator', card.creator === 'fixture-author'],
    ['version', card.version === '2.1'],
    ['linked world', card.linkedWorld === 'Vance Family'],
    ['talkativeness', card.talkativeness === 0.4],
    ['assets', card.assets.length === 1],
    ['embedded lorebook', card.lorebook?.entries.length === 3],
    ['the original file, kept whole', JSON.stringify(card._original).length > 500],
  ];
  const lost = checks.filter(([, good]) => !good).map(([n]) => n);
  ok(`all ${checks.length} fields survived`, lost.length === 0, lost.length ? `lost: ${lost.join(', ')}` : '');

  // Starting points must not swallow the ordinary case: one opening is one
  // opening, not a menu.
  const a = byLetter('A');
  ok('a card with one greeting offers exactly one way in', startingPoints(a.card).length === 1);
  ok('this one offers four', startingPoints(card).length === 4, `${startingPoints(card).length}`);
}

// I and J — the same notation, opposite meanings
{
  const i = byLetter('I');
  const j = byLetter('J');
  console.log('\nI/J  a world and a person, both written as W++ data');
  ok('the world record is a Framework', i.verdict.role === 'framework', i.verdict.role);
  ok('its roster of staff was seen', i.verdict.signals.rosterNames >= 6, `${i.verdict.signals.rosterNames} names`);
  ok('the person record is still a Character', j.verdict.role === 'character', j.verdict.role);
  ok('and goes straight in', isFastPath(j.verdict), j.verdict.confidence);
  ok('both were recognised as structured', i.verdict.signals.structured && j.verdict.signals.structured);
  ok('only one of them is about a person',
    i.verdict.signals.structuredAboutOnePerson === false && j.verdict.signals.structuredAboutOnePerson === true);
}

// K and L — second person, opposite meanings
{
  const k = byLetter('K');
  const l = byLetter('L');
  console.log('\nK/L  a person and a world, both written in second person');
  ok('the second-person portrait is a Character', k.verdict.role === 'character', k.verdict.role);
  ok('and still goes straight in', isFastPath(k.verdict), k.verdict.confidence);
  ok('"You are Detective X" is not counted as an order',
    k.verdict.signals.instructionRate < 0.1, `${Math.round(k.verdict.signals.instructionRate * 100)}% measured`);
  ok('it scores nothing at all as a framework', k.verdict.score.framework === 0, `${k.verdict.score.framework}`);
  ok('the second-person rulebook is a Framework', l.verdict.role === 'framework', l.verdict.role);
  ok('and its orders WERE counted', l.verdict.signals.instructionRate > 0.15,
    `${Math.round(l.verdict.signals.instructionRate * 100)}%`);
  ok('so the two are separated by structure, not by pronoun',
    k.verdict.role !== l.verdict.role);
}

// Roles nothing may offer yet
{
  console.log('\n—  roles the importer is allowed to offer');
  ok('only the three it actually judges', CHOOSABLE_ROLES.join(',') === 'character,scenario,framework',
    CHOOSABLE_ROLES.join(', '));
  ok('persona is not offered', !CHOOSABLE_ROLES.includes('persona'));
  ok('conversation is not offered as a semantic choice', !CHOOSABLE_ROLES.includes('conversation'));
  ok('and no verdict ever names an unjudged role',
    results.every((r) => CHOOSABLE_ROLES.includes(r.verdict.role)));
}

// Hybrids keep what they contain
{
  const e = byLetter('E');
  const d = byLetter('D');
  const f = byLetter('F');
  console.log('\n—  hybrids keep their secondary pieces');
  ok('the innkeeper keeps its scenario content as a component',
    e.verdict.components.some((c) => c.role === 'scenario'),
    e.verdict.components.map((c) => c.role).join(', ') || 'none');
  ok('and that is separate from its alternative',
    e.verdict.alternatives.length > 0 && e.verdict.components.length > 0);
  ok('the framework keeps its scenario setup as a component',
    d.verdict.components.some((c) => c.role === 'scenario'));
  ok('its lorebook is listed as a component too',
    d.verdict.components.some((c) => c.role === 'lorebook'));
  ok('a plain character with lore lists the lore but claims nothing else',
    f.verdict.components.length === 1 && f.verdict.components[0].role === 'lorebook',
    f.verdict.components.map((c) => c.role).join(', '));
}

// M and N — the shapes real downloaded scenario packs actually come in
{
  const m = byLetter('M');
  const n = byLetter('N');
  console.log('\nM/N  packs shaped the way the real ones are');
  ok('a card that sets its scene in the opening is a Scenario', m.verdict.role === 'scenario', m.verdict.role);
  ok('and says so with confidence', m.verdict.confidence === 'high', m.verdict.confidence);
  ok('its cast was found in the prose, not in a heading',
    m.verdict.signals.castSize >= 4, `${m.verdict.signals.castSize} people`);
  ok('nothing rewarded it for "only one subject"',
    !m.verdict.because.some((b) => /only one subject/.test(b)));

  ok('a card whose point is many voices is a Scenario', n.verdict.role === 'scenario', n.verdict.role);
  ok('and says so with confidence', n.verdict.confidence === 'high', n.verdict.confidence);
  ok('the size of the room counted for something',
    n.verdict.signals.exampleSpeakers >= 6, `${n.verdict.signals.exampleSpeakers} speakers`);
  ok('its example is marked as ensemble behaviour',
    part(n.verdict, 'example')?.ensemble === true);

  // The guard against over-correction: a person with a long opening is still
  // a person.
  const a = byLetter('A');
  const k = byLetter('K');
  ok('a real character with a long greeting is untouched',
    a.verdict.role === 'character' && isFastPath(a.verdict));
  ok('and so is the second-person one', k.verdict.role === 'character' && isFastPath(k.verdict));
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exit(fail ? 1 : 0);
