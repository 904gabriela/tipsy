// A preset never overwrites a story's own directions.
//
//   PORT=8871 DB_PATH=data/preset.db node server.js &   then   node scripts/check-preset-safety.js 8871
//
// A preset owns generation settings and its writing style (presetInstructions).
// The story owns its directions. Applying a preset may replace the first and
// must never touch the second. Presets saved before the split may still carry
// `directions`; applying one reads that as its writing style.

import { open } from '../src/db/index.js';

const PORT = Number(process.argv[2] || 8871);
const B = `http://localhost:${PORT}`;
// Only for writing a preset row in the old format, which no route can now create.
const db = open(process.env.DB_PATH || 'data/preset.db');

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? `  — ${d}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`); }
};
const G = (p) => fetch(B + p).then(async (r) => ({ status: r.status, body: await r.json() }));
const J = (p, b, method = 'POST') => fetch(B + p, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

const CARD = {
  spec: 'chara_card_v2', spec_version: '2.0',
  data: { name: 'Mara Quell', description: 'A lighthouse keeper.', personality: 'Dry.', scenario: '', first_mes: 'The lamp needs trimming.', mes_example: '', system_prompt: '', post_history_instructions: '', tags: [], extensions: {} },
};
const card = (await fetch(`${B}/api/import`, {
  method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'mara.json' }, body: Buffer.from(JSON.stringify(CARD)),
}).then((r) => r.json()));

const newStory = async (directions) => {
  const { body } = await J('/api/stories', { characterIds: [card.id], title: 'Preset safety' });
  if (directions !== undefined) {
    const cur = (await G(`/api/stories/${body.id}`)).body.settings;
    await J(`/api/stories/${body.id}`, { settings: { ...cur, directions } }, 'PATCH');
  }
  return body.id;
};
const settingsOf = async (id) => (await G(`/api/stories/${id}`)).body.settings;
const rawSettingsOf = (id) => JSON.parse(db.raw.prepare('SELECT settings FROM stories WHERE id=?').get(id).settings || '{}');
const use = (id, presetId) => J(`/api/stories/${id}/use-preset`, { presetId });
const stableOf = async (id) => (await G(`/api/stories/${id}/prompt`)).body.messages.find((m) => m.role === 'system' && !m.volatile)?.content || '';

// A long, unique story direction with the characters most likely to be mangled.
const LONG = Array.from({ length: 400 }, (_, i) => `Rule ${i}: keep "quotes", ‘curly’, café, 日本語, tabs\tand  double  spaces.`).join('\n\n');

// ---------------------------------------------------------------- A
console.log('\nA  story directions are preserved');
{
  const legacy = db.savePreset({ name: 'Old style preset', settings: { temperature: 0.7, maxTokens: 900, directions: 'Preset style text' } });
  const sid = await newStory(LONG);
  const r = await use(sid, legacy);
  const s = await settingsOf(sid);
  ok('applied', r.status === 200);
  ok('story directions EXACTLY unchanged', s.directions === LONG, `${s.directions.length} chars`);
  ok('presetInstructions is the preset text', s.presetInstructions === 'Preset style text');
  ok('generation settings applied', s.temperature === 0.7 && s.maxTokens === 900);
}

// ---------------------------------------------------------------- B
console.log('\nB  built-ins');
{
  const { body } = await G('/api/presets');
  for (const id of ['builtin-slow-burn', 'builtin-long-prose', 'builtin-fast']) {
    const p = body.presets.find((x) => x.id === id);
    const sid = await newStory(LONG);
    const r = await use(sid, id);
    const s = await settingsOf(sid);
    const stable = await stableOf(sid);
    const style = `# Writing style\n${p.settings.presetInstructions}`;
    const own = `# How this story is written\n${LONG}`;
    ok(`${p.name}: applied through the server`, r.status === 200 && r.body.name === p.name);
    ok(`${p.name}: story directions unchanged`, s.directions === LONG);
    ok(`${p.name}: style carried as presetInstructions, not directions`, s.presetInstructions === p.settings.presetInstructions && p.settings.directions === undefined);
    ok(`${p.name}: generation settings applied`, s.temperature === p.settings.temperature && s.maxTokens === p.settings.maxTokens && (!p.settings.model || s.model === p.settings.model));
    ok(`${p.name}: style reaches the request, before the story's directions`, stable.includes(style) && stable.includes(own) && stable.indexOf(style) < stable.indexOf(own));
  }
}

// ---------------------------------------------------------------- C
console.log('\nC  a story with no directions');
{
  const sid = await newStory();
  await use(sid, 'builtin-long-prose');
  const s = await settingsOf(sid);
  const raw = rawSettingsOf(sid);
  const stable = await stableOf(sid);
  ok('directions remain empty', s.directions === '' && (raw.directions === undefined || raw.directions === ''));
  ok('presetInstructions receives the preset text', String(raw.presetInstructions || '').startsWith('Write at length'));
  ok('no "How this story is written" block appears', !stable.includes('# How this story is written'));
}

// ---------------------------------------------------------------- D
console.log('\nD  switching presets leaves no stale style');
{
  const a = (await J('/api/presets', { name: 'A', settings: { temperature: 0.8, presetInstructions: 'Use restrained literary prose.' } })).body.id;
  const b = (await J('/api/presets', { name: 'B', settings: { temperature: 1.1 } })).body.id;
  const legacyNone = db.savePreset({ name: 'Old, no style', settings: { maxTokens: 500 } });
  const sid = await newStory('Our own rule.');
  await use(sid, a);
  ok('A applied its style', (await settingsOf(sid)).presetInstructions === 'Use restrained literary prose.');
  await use(sid, b);
  const s = await settingsOf(sid);
  ok("B has none: A's style is cleared", s.presetInstructions === '' && !(await stableOf(sid)).includes('restrained literary prose'));
  ok('B applied its settings', s.temperature === 1.1);
  await use(sid, a);
  await use(sid, legacyNone);
  ok('an old preset with no directions also clears it', (await settingsOf(sid)).presetInstructions === '');
  await use(sid, 'builtin-fast');
  await use(sid, b);
  ok('a built-in style is cleared the same way', (await settingsOf(sid)).presetInstructions === '');
  ok('story directions untouched throughout', (await settingsOf(sid)).directions === 'Our own rule.');
}

// ---------------------------------------------------------------- E
console.log('\nE  saving a preset from a story');
{
  const sid = await newStory('SECRET STORY-SPECIFIC DIRECTIONS');
  const src = (await J('/api/presets', { name: 'style only', settings: { presetInstructions: 'Reusable prose style', temperature: 0.66 } })).body.id;
  await use(sid, src);
  const s = await settingsOf(sid);
  // Exactly what the panel sends: the story's whole settings.
  const saved = (await J('/api/presets', { name: 'From a story', settings: s })).body.id;
  const row = (await G(`/api/presets/${saved}`)).body.settings;
  ok('the new preset carries the style', row.presetInstructions === 'Reusable prose style' && row.temperature === 0.66);
  ok('the new preset does not carry the story directions', row.directions === undefined && !JSON.stringify(row).includes('SECRET STORY-SPECIFIC'));
}

// ---------------------------------------------------------------- F
console.log('\nF  an old preset row');
{
  const before = { temperature: 0.5, directions: 'Legacy preset instruction.' };
  const id = db.savePreset({ name: 'Legacy row', settings: before });
  const rowBefore = db.raw.prepare('SELECT name, settings, updated_at FROM presets WHERE id=?').get(id);
  const sid = await newStory('Mine.');
  await use(sid, id);
  const rowAfter = db.raw.prepare('SELECT name, settings, updated_at FROM presets WHERE id=?').get(id);
  const s = await settingsOf(sid);
  ok('the stored preset is untouched', JSON.stringify(rowBefore) === JSON.stringify(rowAfter) && JSON.parse(rowAfter.settings).directions === 'Legacy preset instruction.');
  ok('its directions are applied as presetInstructions', s.presetInstructions === 'Legacy preset instruction.');
  ok('story directions untouched', s.directions === 'Mine.');
  const both = db.savePreset({ name: 'Both fields', settings: { presetInstructions: 'New field.', directions: 'Old field.' } });
  await use(sid, both);
  ok('where both exist, presetInstructions wins', (await settingsOf(sid)).presetInstructions === 'New field.');
}

// ---------------------------------------------------------------- G
console.log('\nG  explicit story edits still write directions');
{
  const sid = await newStory();
  await use(sid, 'builtin-slow-burn');
  // The Directions editor sends the merged settings with new directions.
  const cur = await settingsOf(sid);
  await J(`/api/stories/${sid}`, { settings: { ...cur, directions: 'Edited by hand.' } }, 'PATCH');
  ok('the Directions editor writes story directions', (await settingsOf(sid)).directions === 'Edited by hand.');
  ok('and leaves the preset style alone', (await settingsOf(sid)).presetInstructions.startsWith('Take your time'));
  const book = (await J('/api/lorebooks', { name: 'Instructions' })).body.id;
  const entry = (await J(`/api/lorebooks/${book}/entries`, { title: 'Pacing', kind: 'direction', constant: true, keys: [], content: 'Never resolve a scene in the message it starts.' })).body.id;
  const r = await J(`/api/stories/${sid}/absorb-directions`, { entryIds: [entry] });
  const s = await settingsOf(sid);
  ok('absorb-directions writes story directions', r.status === 200 && s.directions === 'Edited by hand.\n\nNever resolve a scene in the message it starts.');
  ok('and leaves the preset style alone', s.presetInstructions.startsWith('Take your time'));
  await use(sid, 'builtin-fast');
  ok('a preset applied afterwards keeps the absorbed directions', (await settingsOf(sid)).directions === 'Edited by hand.\n\nNever resolve a scene in the message it starts.');
}

// ------------------------------------------------ unchanged elsewhere
console.log('\n   unchanged elsewhere');
{
  ok('an unknown preset is still a 404', (await use(await newStory(), 'no-such-preset')).status === 404);
  // Defaults for new stories keep accepting starting directions, as before.
  await J('/api/defaults', { directions: 'Default opening rule.' });
  const sid = await newStory();
  ok('defaults still give a new story its starting directions', (await settingsOf(sid)).directions === 'Default opening rule.');
  await J('/api/defaults', {});
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
db.close?.();
process.exitCode = fail ? 1 : 0;
