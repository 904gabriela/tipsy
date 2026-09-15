// Which company's machines should read your story?
//
//   node scripts/check-memory-model.js                     the story with the most messages
//   node scripts/check-memory-model.js <story id>
//   node scripts/check-memory-model.js <story id> 12       how many exchanges to sample
//
// The same model id on OpenRouter is served by several companies, and it is
// routed to a different one on every request. They are not equivalent. Some
// of them do not honour the response format, so the record comes back
// finished, valid, parseable, and empty — which nothing downstream can tell
// apart from "nothing happened in that scene".
//
// This re-reads real exchanges from one of your stories, one provider at a
// time, and counts what each actually found. It never prints your writing.
// Costs a few cents. Worth re-running if the memory ever feels thin.

import { readFileSync } from 'node:fs';
import { open } from '../src/db/index.js';
import { PREFERRED_PROVIDERS, AVOID_PROVIDERS } from '../src/memory/extract.js';

const key = (() => {
  const fromEnv = process.env.OPENROUTER_API_KEY;
  if (fromEnv) return fromEnv.trim().replace(/^["']|["']$/g, '');
  const env = readFileSync('.env', 'utf8');
  return /OPENROUTER_API_KEY\s*=\s*["']?([^"'\r\n]+)/.exec(env)?.[1].trim();
})();
if (!key) { console.error('No OpenRouter key. Put it in .env and try again.'); process.exit(1); }

const db = open(process.env.DB_PATH || 'data/tipsy.db');

// Pull the schema and prompt straight out of the extractor, so this measures
// what the app really sends rather than a copy that drifts.
const src = readFileSync('src/memory/extract.js', 'utf8');
const SCHEMA = (0, eval)('(' + src.slice(src.indexOf('const SCHEMA = ') + 15, src.indexOf('const PROMPT = ')).trim().replace(/;$/, '') + ')');
const PROMPT = src.split('const PROMPT = `')[1].split('`;')[0];

const stories = db.listStories();
const storyId = process.argv[2] || stories.sort((a, b) => b.message_count - a.message_count)[0]?.id;
const want = Number(process.argv[3] || 8);
const story = storyId ? db.getStory(storyId) : null;
if (!story) { console.error('No story to read. Play a little first.'); process.exit(1); }

const path = db.pathTo(story.head_id, 50000);
const replies = path.map((m, i) => ({ m, prev: path[i - 1] }))
  .filter(({ m, prev }) => m.role === 'assistant' && prev);
if (replies.length < 4) { console.error('That story is too short to measure. Play a little more.'); process.exit(1); }

const step = Math.max(1, Math.floor(replies.length / want));
const sample = replies.filter((_, i) => i % step === 0).slice(0, want);
const model = { ...{ model: 'deepseek/deepseek-v4-flash' }, ...(story.settings.memory || {}) }.model;
const persona = story.persona ? story.persona.name : 'THEM';

console.log(`Story  : ${story.title}  (${path.length} messages)`);
console.log(`Model  : ${model}`);
console.log(`Reading ${sample.length} exchanges from each provider. Your writing is never printed.\n`);

async function ask({ prev, m }, provider) {
  const t = Date.now();
  const body = {
    model, temperature: 0, max_tokens: 2400, reasoning: { enabled: false },
    response_format: { type: 'json_schema', json_schema: { name: 'record', strict: false, schema: SCHEMA } },
    provider: provider === '(routed automatically)'
      ? { require_parameters: true }
      : { order: [provider], allow_fallbacks: false, require_parameters: true },
    messages: [
      { role: 'system', content: PROMPT },
      {
        role: 'user',
        content: `THE LAST EXCHANGE\n${[prev, m].map((x) =>
          `${x.role === 'user' ? persona : 'STORY'}: ${x.content}`).join('\n\n')}\n\nWrite down what changed.`,
      },
    ],
  };
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Tipsy provider check' },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    if (j.error) return { skip: j.error.message };
    let p = null;
    try { p = JSON.parse(j.choices?.[0]?.message?.content ?? ''); } catch { /* counted as empty */ }
    return {
      ms: Date.now() - t,
      facts: p?.facts?.length ?? 0,
      rels: p?.relations?.length ?? 0,
      hidden: (p?.facts || []).filter((f) => (f.secrecy ?? 0) >= 2).length,
      cost: j.usage?.cost ?? 0,
    };
  } catch (e) { return { skip: e.message }; }
}

// Everyone who serves this model, plus the automatic choice for comparison.
let candidates = [...PREFERRED_PROVIDERS, ...AVOID_PROVIDERS];
try {
  const eps = await fetch(`https://openrouter.ai/api/v1/models/${model}/endpoints`, {
    headers: { Authorization: `Bearer ${key}` },
  }).then((r) => r.json());
  const named = (eps?.data?.endpoints || []).map((e) => e.provider_name).filter(Boolean);
  if (named.length) candidates = [...new Set(named)];
} catch { /* fall back to the ones we already know about */ }

const rows = [];
for (const provider of ['(routed automatically)', ...candidates]) {
  const rs = await Promise.all(sample.map((s) => ask(s, provider)));
  const good = rs.filter((r) => !r.skip);
  if (!good.length) { console.log(`${provider.padEnd(24)} not available for this model`); continue; }
  const n = good.length;
  const withFacts = good.filter((r) => r.facts).length;
  const withRels = good.filter((r) => r.rels).length;
  const row = {
    provider,
    facts: withFacts / n,
    rels: withRels / n,
    hidden: good.reduce((a, r) => a + r.hidden, 0),
    ms: Math.round(good.reduce((a, r) => a + r.ms, 0) / n),
    cost: good.reduce((a, r) => a + r.cost, 0),
  };
  rows.push(row);
  console.log(`${provider.padEnd(24)} recorded something in ${String(withFacts).padStart(2)}/${n} exchanges, `
    + `who-stands-where in ${String(withRels).padStart(2)}/${n}, `
    + `${String(row.hidden).padStart(2)} marked secret, ${String(row.ms).padStart(5)}ms, $${row.cost.toFixed(4)}`);
}

const scored = rows.filter((r) => r.provider !== '(routed automatically)')
  .map((r) => ({ ...r, score: r.facts + r.rels - (r.ms > 20000 ? 0.4 : 0) }))
  .sort((a, b) => b.score - a.score);

console.log(`\nCurrently preferred, in order: ${PREFERRED_PROVIDERS.join(', ')}`);
console.log(`Currently refused            : ${AVOID_PROVIDERS.join(', ')}`);

if (scored.length) {
  const good = scored.filter((r) => r.score >= 1.4).map((r) => r.provider);
  const bad = scored.filter((r) => r.facts < 0.5).map((r) => r.provider);
  console.log(`\nWhat this run suggests:`);
  console.log(`  prefer : ${good.length ? good.join(', ') : 'nothing scored well enough — try a different model'}`);
  console.log(`  refuse : ${bad.length ? bad.join(', ') : 'none of them came back empty this time'}`);
  const same = good.join(',') === PREFERRED_PROVIDERS.join(',');
  console.log(same
    ? '\nSame as what the app already uses. Nothing to change.'
    : '\nDifferent from what the app uses. To change it, edit PREFERRED_PROVIDERS and\nAVOID_PROVIDERS at the top of src/memory/extract.js.');
}
