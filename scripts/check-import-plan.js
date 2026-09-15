// Does one file become the right things, already joined up?
//
// Runs every fixture through the real path — importFile, classify, plan,
// apply — against a throwaway database, and then checks the four concepts
// stay apart: a character is not a scenario, a scenario is not a framework,
// and a framework is not a story.

import { readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { open } from '../src/db/index.js';
import { importFile } from '../src/import/index.js';
import { normalizeCard } from '../src/import/card.js';
import { classifyCard } from '../src/import/semantics.js';
import { planFor, applyPlan, startFromScenario } from '../src/import/plan.js';

const DB = process.env.DB_PATH || 'data/plan-check.db';
for (const suffix of ['', '-wal', '-shm']) if (existsSync(DB + suffix)) rmSync(DB + suffix);
const db = open(DB);

const DIR = 'tests/fixtures/semantics';
let pass = 0; let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};

/** The whole path one dropped file takes, minus the HTTP. */
function bringIn(file, role = null) {
  const raw = readFileSync(join(DIR, file), 'utf8');
  const result = importFile(file, new TextEncoder().encode(raw));
  const card = normalizeCard(JSON.parse(raw), file);
  const verdict = classifyCard(card, { format: card.spec });
  const plan = planFor(card, verdict, role);
  const importId = db.recordImport({
    filename: file, source: 'file',
    format: `chara_card_${card.spec}`, spec: card.spec,
    detectedRole: verdict.role, confidence: verdict.confidence,
    analysis: verdict, original: JSON.stringify(card._original),
  });
  const applied = applyPlan(db, { card, plan, importId });
  return { result, card, verdict, plan, importId, ...applied };
}

/** The messages actually on a story's current path. */
const msgs = (storyId) => {
  const s = db.getStory(storyId);
  return s && s.head_id ? db.pathTo(s.head_id) : [];
};

const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const brought = {};
for (const f of files) brought[f[0]] = bringIn(f);

console.log('\n============== what each file turned into ==============\n');
for (const [letter, b] of Object.entries(brought)) {
  console.log(`${letter}  ${b.card.name.slice(0, 34).padEnd(36)} ${b.plan.role.padEnd(10)} ${b.plan.fastPath ? 'fast' : 'review'}  →  ${b.created.map((c) => c.kind).join(' + ')}`);
}

console.log('\n===================== the checks =====================\n');

// ---- the fast path is still the fast path
{
  console.log('the ordinary case');
  const plain = ['A', 'F', 'H', 'J', 'K'];
  ok('every plain character card took the fast path',
    plain.every((L) => brought[L].plan.fastPath), plain.join(', '));
  ok('and each became exactly one character',
    plain.every((L) => brought[L].primary.kind === 'character'));
  ok('none of them created a scenario or a framework',
    plain.every((L) => !brought[L].created.some((c) => c.kind === 'scenario' || c.kind === 'framework')));
  const h = brought.H;
  ok('a fully populated card kept every field', db.getCharacter(h.primary.id).name === 'Dario Vance');
  const hc = db.getCharacter(h.primary.id);
  ok('including its tags, for the library to filter on', hc.tags.length === 5, hc.tags.join(', '));
  ok('and its own lorebook came with it, as it always did',
    db.listLorebooks().some((b) => b.from_character === h.primary.id));
}

// ---- scenarios
{
  console.log('\nscenarios');
  const b = brought.B;
  ok('the sleepover became a scenario', b.primary.kind === 'scenario');
  const s = db.getScenario(b.primary.id);
  ok('it carries its premise', s.premise.length > 100, `${s.premise.length} chars`);
  ok('it kept all three ways to begin', s.startingPoints.length === 3, `${s.startingPoints.length}`);
  ok('the openings are labelled, not just dumped',
    s.startingPoints.map((x) => x.label).join(', ') === 'Opening, Alternative 1, Alternative 2',
    s.startingPoints.map((x) => x.label).join(', '));
  ok('and each one records which card field it came from',
    s.startingPoints.every((x) => x.source));

  const c = brought.C;
  const sc = db.getScenario(c.primary.id);
  ok('the classroom kept its ensemble dialogue', sc.ensemble.length > 100, `${sc.ensemble.length} chars`);
  ok('and it is NOT attributed to any character',
    !db.listCharacters().some((x) => x.name === 'Actuate — Year 2 Classroom'));
  ok('its cast was discovered as names', sc.cast.length >= 4, `${sc.cast.length} names`);
  ok('none of those names became an invented character card',
    sc.cast.every((x) => x.characterId === null || db.getCharacter(x.characterId)),
    sc.cast.filter((x) => x.characterId).length + ' matched the library');
}

// ---- frameworks
{
  console.log('\nframeworks');
  const d = brought.D;
  ok('the campaign became a framework', d.primary.kind === 'framework');
  const f = db.getFramework(d.primary.id);
  ok('its world text is there', f.world.length > 1000, `${f.world.length} chars`);
  ok('its narrator instructions are separate from its world',
    f.narrator.length > 20 && f.narrator !== f.world);
  ok('its closing instructions are kept apart too', f.closing.length > 10);
  ok('its mid-story reminder survived', Boolean(f.depthNote?.text));
  ok('its 21 lore entries are linked to it, not orphaned',
    f.lorebookIds.length === 1 && db.getLorebook(f.lorebookIds[0]).entries.length === 21,
    `${f.lorebookIds.length} book`);
  ok('it offers three ways in', f.startingPoints.length === 3);
  ok('it did NOT become a character', !db.listCharacters().some((x) => x.name.includes('VERRIDGE')));
  ok('and it did NOT become a story', !db.listStories().some((x) => x.title.includes('VERRIDGE')));

  const g = brought.G;
  ok('the injection card is a framework too, not what it demanded', g.primary.kind === 'framework');
}

// ---- one file, several linked things
{
  console.log('\none file, several things, already joined');
  const d = brought.D;
  const rec = db.getImport(d.importId);
  ok('the import record knows the format it arrived in', rec.format === 'chara_card_v2', rec.format);
  ok('it kept the original file whole', rec.original.length > 2000, `${rec.original.length} chars`);
  ok('it remembers what was detected', rec.detected_role === 'framework');
  ok('and what was committed', rec.chosen_role === 'framework');
  ok('it kept the reasons', (rec.analysis.because || []).length > 0);
  ok('and the components it found', (rec.analysis.components || []).length > 0);
  ok('it links to everything it produced', rec.resources.length === 2,
    rec.resources.map((r) => r.kind).join(' + '));
  ok('one of which is marked the primary one',
    rec.resources.filter((r) => r.part === 'primary').length === 1);
  ok('and the lorebook can be traced back to the same file',
    db.importOf('lorebook', db.getFramework(d.primary.id).lorebookIds[0]) === d.importId);
}

// ---- overriding the verdict
{
  console.log('\nsaying no to the verdict');
  const raw = readFileSync(join(DIR, 'D-campaign-framework.json'), 'utf8');
  const card = normalizeCard(JSON.parse(raw), 'D-campaign-framework.json');
  const verdict = classifyCard(card);
  const plan = planFor(card, verdict, 'character');
  ok('a framework can be forced to a character', plan.role === 'character');
  ok('and it knows it was overruled', plan.overridden === true);
  const importId = db.recordImport({
    filename: 'D-again.json', format: 'chara_card_v2', spec: card.spec,
    detectedRole: verdict.role, confidence: verdict.confidence,
    analysis: verdict, original: JSON.stringify(card._original),
  });
  const out = applyPlan(db, { card, plan, importId });
  ok('it really became a character', out.primary.kind === 'character');
  const rec = db.getImport(importId);
  ok('and the record still says what the classifier thought',
    rec.detected_role === 'framework' && rec.chosen_role === 'character',
    `detected ${rec.detected_role}, chosen ${rec.chosen_role}`);
}

// ---- scenario becomes a story
{
  console.log('\nstarting a story from a scenario');
  const b = brought.B;
  const s = db.getScenario(b.primary.id);
  const first = startFromScenario(db, s.id, { title: 'The first night' });
  const story = db.getStory(first.storyId);
  ok('a story was made', Boolean(story));
  ok('it took the scenario premise', String(story.settings.premise || '').length > 100);
  ok('it opened on the chosen starting point', first.usedStartingPoint === s.startingPoints[0].id);
  ok('and that opening is its first message', msgs(first.storyId).length === 1,
    `${msgs(first.storyId).length} message`);
  ok('it remembers which scenario it came from', story.scenario_id === s.id);

  // The point of a template: two stories, same mould, separate lives.
  const second = startFromScenario(db, s.id, {
    title: 'A different night', startingPointId: s.startingPoints[2].id,
  });
  ok('a second story can start from the same scenario', second.storyId !== first.storyId);
  ok('and can begin somewhere else', second.usedStartingPoint === s.startingPoints[2].id);
  db.addMessage({ storyId: first.storyId, parentId: db.getStory(first.storyId).head_id, role: 'user', content: 'Only in the first story.' });
  ok('writing in one does not reach the other',
    msgs(first.storyId).length === 2 && msgs(second.storyId).length === 1,
    `${msgs(first.storyId).length} vs ${msgs(second.storyId).length}`);
  ok('editing the scenario afterwards does not reach either',
    (() => {
      db.saveScenario({ id: s.id, name: s.name, premise: 'CHANGED', directions: '', ensemble: '', cast: [], tags: [] });
      return String(db.getStory(first.storyId).settings.premise).includes('sleepover')
        || !String(db.getStory(first.storyId).settings.premise).includes('CHANGED');
    })());
}

// ---- many stories, one framework
{
  console.log('\nmany stories on one world');
  const f = db.getFramework(brought.D.primary.id);
  const made = ['Reiko joins', 'Villain AU', 'Sports festival'].map((t) =>
    db.createStory({ title: t, settings: {}, frameworkId: f.id }));
  ok('three stories can use the same framework',
    db.listStories().filter((s) => s.framework_id === f.id).length === 3);
  ok('the framework knows how many use it', db.listFrameworks().find((x) => x.id === f.id).stories === 3);
  db.addMessage({ storyId: made[0], parentId: null, role: 'user', content: 'Only here.' });
  ok('they do not share history',
    msgs(made[0]).length === 1 && msgs(made[1]).length === 0);
  ok('and none of them IS the framework',
    made.every((id) => db.getStory(id).title !== f.name));
  ok('using a world does not copy it into the story',
    String(db.getStory(made[0]).settings.premise || '') === '');
}

// ---- nothing was quietly reinterpreted
{
  console.log('\nwhat was already there');
  // Counted from what the classifier actually decided rather than written in
  // by hand, so adding a fixture cannot make this fail for no reason.
  const wanted = Object.values(brought).reduce((acc, b) => {
    acc[b.plan.role] = (acc[b.plan.role] || 0) + 1;
    return acc;
  }, {});
  ok('exactly the scenarios the classifier called scenarios',
    db.listScenarios().length === (wanted.scenario || 0),
    `${db.listScenarios().length} of ${wanted.scenario || 0}`);
  ok('and one framework per framework, plus the one forced back to a person',
    db.listFrameworks().length === (wanted.framework || 0),
    `${db.listFrameworks().length} of ${wanted.framework || 0}`);
  // Six cards are people. The seventh is the campaign module that the
  // override test deliberately forced in here, which is the point of having
  // an override: when you say it is a character, it is a character.
  const chars = db.listCharacters();
  const people = chars.filter((c) => c.name !== 'VERRIDGE ACADEMY RPG # v3');
  ok('no card became a character by accident', people.length === 6,
    `${people.length}: ${people.map((c) => c.name.split(' ')[0]).join(', ')}`);
  ok('and the one forced in by hand is there because it was asked for',
    chars.length === 7 && chars.some((c) => c.name === 'VERRIDGE ACADEMY RPG # v3'));
  ok('every character kept its openings where it has them',
    db.startingPoints('character', brought.H.primary.id).length === 4,
    `${db.startingPoints('character', brought.H.primary.id).length} for Dario`);
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
db.close();
for (const suffix of ['', '-wal', '-shm']) if (existsSync(DB + suffix)) rmSync(DB + suffix);
process.exit(fail ? 1 : 0);
