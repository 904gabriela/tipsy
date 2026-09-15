// What actually reaches the provider, under a load like a real story's.
//
//   PORT=8831 DB_PATH=data/ctx.db node server.js &   then   node scripts/check-context.js 8831
//
// Every assertion here is made against the compiled request, not against the
// code that built it: the test reads the messages that would be sent and
// checks what is in them, what is not, and how many times.

import { open } from '../src/db/index.js';

const PORT = Number(process.argv[2] || 8831);
const B = `http://localhost:${PORT}`;

// The transcript is seeded straight into the file, because there is no route
// that adds a message without asking a model to write one, and forty turns of
// real generation is not a test, it is a bill. Everything being MEASURED still
// goes through the server: the request is compiled by the same endpoint the
// app reads.
const db = open(process.env.DB_PATH || 'data/ctx.db');

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? `  — ${d}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`); }
};
const G = (p) => fetch(B + p).then(async (r) => ({ status: r.status, body: await r.json() }));
const J = (p, b) => fetch(B + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
const drop = (name, obj) => fetch(`${B}/api/import`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(name) },
  body: Buffer.from(JSON.stringify(obj)),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

/** The whole request as one string, and as its parts. */
const compile = async (storyId) => {
  const { body } = await G(`/api/stories/${storyId}/prompt`);
  return {
    ...body,
    all: body.messages.map((m) => m.content).join('\n'),
    stable: body.messages.find((m) => m.role === 'system' && !m.volatile)?.content || '',
    volatile: body.messages.filter((m) => m.volatile).map((m) => m.content).join('\n'),
  };
};
const times = (hay, needle) => hay.split(needle).length - 1;

// ---------------------------------------------------------------- the world
const WORLD_LINE = 'Ashfell stands on nine pillars of black glass and nobody agrees who cut them.';
const NARRATOR_LINE = 'Let side characters walk into a scene without being summoned.';
const ENSEMBLE_LINE = 'Pell: "You are late." Orsi: "I am exactly as late as the boat."';
const CLOSING_LINE = 'End on something the player can answer.';
const DEPTH_LINE = 'Remember which pillar district this scene is in.';

// Twenty-four entries: two that the sample scene should fire, and a great
// many that it should not.
const loreEntries = [
  { keys: ['ninth pillar'], content: 'NINTH PILLAR: the one that hums. Nobody builds within fifty yards of it.', enabled: true, insertion_order: 100 },
  { keys: ['glasswrights'], content: 'GLASSWRIGHTS: the guild that cuts the pillars. They do not explain their work.', enabled: true, insertion_order: 100 },
];
for (let i = 0; i < 22; i++) {
  loreEntries.push({
    keys: [`irrelevancy-${i}`],
    content: `FILLER ${i}: ${'a long and entirely irrelevant description of a distant province that nothing in this scene mentions. '.repeat(12)}`,
    enabled: true,
    insertion_order: 100,
  });
}

const FRAMEWORK_CARD = {
  spec: 'chara_card_v2',
  data: {
    name: 'ASHFELL CAMPAIGN',
    description: `## The world\n\n${WORLD_LINE}\n\nThe city is run by three guilds and a harbour master who answers to none of them. Nothing here is decided quickly, and nothing is decided in public.\n\n## Districts\n\n- The Glass Quarter — where the pillars are cut\n- The Low Harbour — where everything arrives and little leaves\n- The Quiet Rows — where the guilds keep their people\n\n## Rules of the place\n\nYou will track which district a scene is in.\nYou must never write the player's dialogue, actions or decisions.\nAlways let a rumour reach the player second-hand before it becomes true.\n${NARRATOR_LINE}\nDo not resolve a guild dispute inside a single scene.\nAdvance the calendar one day per completed scene.\n\n## Standing\n\nEach guild counts the player from -3 to +3. It moves on action, never on conversation.`,
    personality: '',
    scenario: '',
    first_mes: '*The boat comes in at dusk and the Low Harbour is already emptying.*',
    alternate_greetings: [
      '*The Glass Quarter at first light, and the ninth pillar is humming loud enough to feel through your boots.*',
      '*A guild summons you by name, which is not how any of this is supposed to work.*',
    ],
    mes_example: `<START>\n${ENSEMBLE_LINE}\nPell: "The harbour master will hear about this."\nOrsi: "The harbour master already knows."`,
    system_prompt: `You are running Ashfell. Portray every guild and the city itself.\n${NARRATOR_LINE}`,
    post_history_instructions: CLOSING_LINE,
    creator_notes: 'Load-test fixture.',
    tags: ['campaign', 'city', 'guilds'],
    extensions: { depth_prompt: { prompt: DEPTH_LINE, depth: 4, role: 'system' } },
    character_book: { name: 'Ashfell', entries: loreEntries },
  },
};

const CHARACTER_LINE = 'Vesna keeps her hands still when she is angry, which is most of the time.';
const CHARACTER_CARD = {
  spec: 'chara_card_v2',
  data: {
    name: 'Vesna Adalric',
    description: `${CHARACTER_LINE}\n\nAge: 34\nOccupation: glasswright, third rank\nAppearance: burn scars to the elbow, hair tied back and never tidy\nLikes: the hour before the furnaces light, being contradicted with evidence\nDislikes: the harbour master, being thanked, guild politics\nVoice: flat, precise, and slower than people wait for.`,
    personality: 'Exacting, dry, unwilling to be managed. Warm only where it costs her something.',
    scenario: '',
    first_mes: '*She does not look up from the bench.* "If you are here about the commission, it is late because it is difficult."',
    mes_example: '<START>\n{{user}}: Long night?\n{{char}}: "They are all long." *She does not stop working.*',
    system_prompt: '',
    post_history_instructions: 'Keep her replies short. She is not a talker.',
    tags: ['glasswright', 'original character'],
    extensions: {},
  },
};

const PERSONA_LINE = 'I am Idris, harbour clerk, and I write everything down.';

// --------------------------------------------------------------------- set up
console.log('setting up a story with everything on it\n');

const fw = (await drop('ashfell.json', FRAMEWORK_CARD)).body;
const fwId = (await J('/api/import/commit', { importId: fw.importId })).body.id;
const ch = (await drop('vesna.json', CHARACTER_CARD)).body;

const persona = (await J('/api/personas', { name: 'Idris', description: PERSONA_LINE })).body;
const startPoints = (await G(`/api/starts/framework/${fwId}`)).body.starts;
const chosen = startPoints[1];
const started = (await J(`/api/frameworks/${fwId}/start`, {
  startingPointId: chosen.id, personaId: persona.id, characterIds: [ch.id], title: 'Ashfell load test',
})).body;
const storyId = started.storyId;

// A long transcript, and a current scene that should pull exactly two entries.
const NEWEST = 'I need to ask the glasswrights about the ninth pillar before the tide turns.';
let head = db.getStory(storyId).head_id;
for (let i = 0; i < 40; i++) {
  head = db.addMessage({
    storyId, parentId: head,
    role: i % 2 ? 'assistant' : 'user',
    content: `Turn ${i}: ${'the conversation continues at ordinary length about ordinary things. '.repeat(6)}`,
  });
}
head = db.addMessage({ storyId, parentId: head, role: 'user', content: NEWEST });

const current = db.getStory(storyId);
db.updateStory(storyId, {
  settings: {
    ...current.settings,
    directions: 'Write it cold and procedural.',
    premise: 'A commission has gone wrong and nobody will say whose fault it is.',
  },
});

const c = await compile(storyId);

// ----------------------------------------------------------------- the checks
console.log('\n1  what survives under load');
ok('the speaking character is present', c.stable.includes(CHARACTER_LINE));
ok('their personality is present', c.stable.includes('Exacting, dry, unwilling to be managed'));
ok('the persona is present', c.all.includes(PERSONA_LINE));
ok('the newest turn is present', c.all.includes(NEWEST));
ok('and it is the last thing in the conversation',
  c.messages.filter((m) => m.role === 'user').slice(-1)[0].content === NEWEST);
ok('the story premise survives', c.stable.includes('A commission has gone wrong'));
ok('the story directions survive', c.stable.includes('Write it cold and procedural'));
ok('recent turns survive', c.report.messagesSent >= 20, `${c.report.messagesSent} turns sent`);

console.log('\n2  what the world contributed');
ok('the world text is in', c.stable.includes(WORLD_LINE));
ok('under its own heading', c.stable.includes('# The world we are in'));
ok('the narrator rules are in', c.stable.includes(NARRATOR_LINE));
ok('under a heading of their own, separate from prose style',
  c.stable.includes('# How this world is run') && c.stable.includes('# How this story is written'));
ok('the closing instruction is in the tail, not the cached half',
  c.volatile.includes(CLOSING_LINE) && !c.stable.includes(CLOSING_LINE));
ok('the depth note is in the tail too', c.volatile.includes(DEPTH_LINE));
ok('the report says what the world contributed',
  Array.isArray(c.report.framework?.included) && c.report.framework.included.length >= 3,
  (c.report.framework?.included || []).join(', '));

console.log('\n3  the ensemble examples are examples, not a voice');
const hasEnsemble = c.stable.includes(ENSEMBLE_LINE);
ok('if present, they are never labelled as one person speaking',
  !c.stable.includes('How ASHFELL CAMPAIGN speaks'));
ok('they sit after the character sheet, not before it',
  !hasEnsemble || c.stable.indexOf(CHARACTER_LINE) < c.stable.indexOf(ENSEMBLE_LINE));
ok('and the report says whether they went in or were dropped',
  (c.report.framework.included.includes('ensemble') || c.report.framework.dropped.length > 0),
  hasEnsemble ? 'included' : (c.report.framework.dropped[0]?.why || ''));

console.log('\n4  lore is retrieved, not dumped');
ok('the world has a book of 24 entries available',
  c.sources.lore.available.world === 24, `${c.sources.lore.available.world} available`);
ok('only a couple fired for this scene', c.sources.lore.fired <= 4, `${c.sources.lore.fired} fired`);
ok('the relevant one is in', c.all.includes('NINTH PILLAR'));
ok('the irrelevant ones are NOT in', !c.all.includes('FILLER 7') && !c.all.includes('FILLER 19'));
ok('the report attributes fired lore to the world',
  c.sources.lore.fromWorld >= 1, `${c.sources.lore.fromWorld} from the world`);
ok('the whole book is nowhere in the request',
  times(c.all, 'FILLER ') <= 1, `${times(c.all, 'FILLER ')} filler mentions`);

console.log('\n5  nothing is said twice');
for (const [label, line] of [
  ['the world line', WORLD_LINE], ['the narrator rule', NARRATOR_LINE],
  ['the character line', CHARACTER_LINE], ['the persona line', PERSONA_LINE],
  ['the closing instruction', CLOSING_LINE], ['the depth note', DEPTH_LINE],
  ['the premise', 'A commission has gone wrong'],
]) {
  ok(`${label} appears exactly once`, times(c.all, line) === 1, `${times(c.all, line)}×`);
}
ok('the world is not also rendered as a character sheet',
  !c.stable.includes('# ASHFELL CAMPAIGN'));
ok('and it is not in the cast', !c.all.includes('## Personality\n\n\n'));

console.log('\n6  unused openings are menu choices, not context');
ok('the chosen opening is the first message', c.all.includes(chosen.content.slice(0, 40)));
for (const s of startPoints) {
  if (s.id === chosen.id) continue;
  ok(`an unused opening is absent — "${s.content.slice(0, 28)}…"`, !c.all.includes(s.content.slice(0, 40)));
}
ok('but they are all still on the world for next time',
  (await G(`/api/starts/framework/${fwId}`)).body.starts.length === 3);

console.log('\n7  the budget');
ok('the request has a real total', c.report.total > 0, `${c.report.total} tokens`);
ok('the world did not eat the request',
  c.report.framework.tokens < c.report.total * 0.5,
  `world ${c.report.framework.tokens} of ${c.report.total}`);
ok('lore stayed inside its allowance',
  c.report.loreTokens <= c.report.loreBudget, `${c.report.loreTokens} of ${c.report.loreBudget}`);
ok('the cacheable prefix is most of the request',
  c.report.cacheable > c.report.volatile, `${c.report.cacheable} cached vs ${c.report.volatile} volatile`);

console.log('\n8  the cache boundary');
ok('the volatile block sits after the conversation',
  c.messages.findIndex((m) => m.volatile) > c.messages.findIndex((m) => m.role === 'user'));
ok('nothing per-turn is in the cached half',
  !c.stable.includes('WHERE THINGS STAND') && !c.stable.includes('Relevant right now'));
ok('the world IS in the cached half', c.stable.includes(WORLD_LINE));

// ------------------------------------------------- a story with no world at all
console.log('\n9  a story with no world compiles as before');
{
  const plain = (await J('/api/stories', { characterIds: [ch.id], personaId: persona.id, title: 'No world here' })).body;
  const p = await compile(plain.id);
  ok('no world heading appears anywhere', !p.all.includes('# The world we are in'));
  ok('no empty "how this world is run" block', !p.all.includes('# How this world is run'));
  ok('no ensemble heading', !p.all.includes('# How scenes in this world go'));
  ok('the report says there is no world', p.report.framework === null);
  ok('the character is still there', p.stable.includes(CHARACTER_LINE));
  ok('the persona is still there', p.all.includes(PERSONA_LINE));
  ok('and the greeting opened it', p.messages.some((m) => m.role === 'assistant'));
}

// ------------------------------- a story started from an ensemble scenario
console.log('\n10  a classroom scenario brings its ensemble example');
{
  const classroom = JSON.parse(
    (await import('node:fs')).readFileSync('tests/fixtures/semantics/C-classroom-ensemble.json', 'utf8')
  );
  const MULTI = 'Ms Ferrand: "Fours. I\'ve written them on the board. Move now, discuss after."';
  const held = (await drop('classroom.json', classroom)).body;
  ok('it is held as a scenario, not a person', held.plan?.role === 'scenario', held.plan?.role);
  const took = await J('/api/import/commit', { importId: held.importId });
  const sc = (await G(`/api/scenarios/${took.body.id}`)).body;
  ok('its ensemble example was kept', sc.ensemble.includes('Ms Ferrand'), `${sc.ensemble.length} chars`);

  const st = await J(`/api/scenarios/${sc.id}/start`, { personaId: persona.id });
  const p = await compile(st.body.storyId);
  ok('the multi-speaker example reaches the model', p.all.includes(MULTI));
  ok('exactly once', times(p.all, MULTI) === 1, `${times(p.all, MULTI)}×`);
  ok('under a heading about scenes, not about a person',
    p.stable.includes('# How scenes here tend to go'));
  ok('and it is never attributed to a character',
    !p.all.includes(`How ${classroom.data.name} speaks`)
    && !p.all.includes('# Actuate — Year 2 Classroom'));
  ok('it sits in the cached half', p.stable.includes(MULTI) && !p.volatile.includes(MULTI));
  ok('the report counts it', (p.report.framework?.included || []).includes('scenario ensemble'),
    (p.report.framework?.included || []).join(', '));
  ok('the premise came across too', /second-year classroom/i.test(p.stable));
  ok('the persona still survives', p.all.includes(PERSONA_LINE));
}

console.log('\n11  the same example is never sent twice');
{
  // A scenario whose ensemble is the same text as its world's. Both offer it;
  // only one may go in.
  const sameText = 'Pell: "You are late." Orsi: "I am exactly as late as the boat."';
  const sc = await J('/api/scenarios/none/start', {}).catch(() => null);
  const dbl = (await G('/api/library')).body.scenarios[0];
  ok('there is a scenario to test with', Boolean(dbl));
  if (dbl) {
    const st = await J(`/api/scenarios/${dbl.id}/start`, {});
    const p = await compile(st.body.storyId);
    ok('no ensemble block appears twice',
      (p.stable.match(/# How scenes/g) || []).length <= 2,
      `${(p.stable.match(/# How scenes/g) || []).length} ensemble headings`);
    ok('and identical text would be reported as a duplicate, not sent',
      !p.stable.includes(`${sameText}\n\n${sameText}`));
  }
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail) process.exitCode = 1;
