// Can a free local model keep the records?
//
//   node scripts/check-background-model.js
//
// Twelve cases against the SAME schema and the SAME prompt the app uses, so
// the comparison is of models and nothing else. The paid model that is already
// trusted runs the same cases as the reference.
//
// What is being judged is not cleverness. It is whether the thing can be
// trusted to write down a story's memory without inventing any of it, because
// a wrong fact kept for two hundred messages is worse than a missing one.

import { readFileSync, existsSync } from 'node:fs';
import { SCHEMA, PROMPT, PREFERRED_PROVIDERS, AVOID_PROVIDERS } from '../src/memory/extract.js';

const env = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
const apiKey = (/OPENROUTER_API_KEY\s*=\s*(\S+)/.exec(env) || [])[1] || process.env.OPENROUTER_API_KEY;
const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';

const CANDIDATES = [
  { id: 'qwen3:8b', kind: 'ollama', label: 'qwen3:8b (local)' },
  { id: 'llama3.1:latest', kind: 'ollama', label: 'llama3.1:8b (local)' },
  { id: 'deepseek/deepseek-v4-flash', kind: 'openrouter', label: 'deepseek-v4-flash (paid, current)' },
];

// ---------------------------------------------------------------- the cases
//
// Each case says what a careful record-keeper should and should not write
// down. `must` has to be true; `mustNot` must not.

const at = (where, who = ['Patrick', 'Reiko']) => ({ where, who });

const CASES = [
  {
    name: '1  a move to another room',
    place: "Patrick's penthouse, the bathroom",
    user: 'I am getting cold.',
    story: '*He stands, wraps the towel round her, and walks her through to the kitchen without asking.*',
    must: (r) => /kitchen/i.test(r.scene?.where || ''),
    why: 'the new room is recorded',
  },
  {
    name: '2  no move at all',
    place: "Patrick's penthouse, the bathroom",
    user: 'Tell me about your day.',
    story: '*He is quiet for a moment.* "Long. Loud. Mostly people wanting things."',
    must: (r) => !r.scene?.where || /bathroom/i.test(r.scene.where),
    why: 'the place is left alone',
  },
  {
    name: '3  remembering somewhere else',
    place: "Patrick's penthouse, the kitchen",
    user: 'You were quiet earlier.',
    story: '*He turns the cup round on the counter.* "I was thinking about the bath. About what you said in it."',
    must: (r) => !r.scene?.where || /kitchen/i.test(r.scene.where),
    mustNot: (r) => /bath/i.test(r.scene?.where || ''),
    why: 'a remembered room does not become the current one',
  },
  {
    name: '4  a relationship moving',
    place: "Patrick's penthouse, the kitchen",
    user: 'I was scared you would not come back.',
    story: '*He stops. Puts the glass down.* "I know." *He does not explain, and he does not leave the room either.* "I should have called."',
    must: (r) => Array.isArray(r.relations) && r.relations.length >= 1,
    why: 'the pair is reported at all',
  },
  {
    name: '5  a real promise',
    place: "Patrick's penthouse, the kitchen",
    user: 'I never know what to do when it starts.',
    story: '"Then I will teach you." *He means it, which is worse.* "How to get out of a room without anyone watching you go. Next week."',
    must: (r) => (r.threads || []).length >= 1,
    why: 'an actual promise becomes unfinished business',
  },
  {
    name: '6  small talk that owes nothing',
    place: "Patrick's penthouse, the kitchen",
    user: 'Is there coffee?',
    story: '*He points at the pot without looking up from the paper.* "Second shelf."',
    mustNot: (r) => (r.threads || []).length > 0,
    why: 'nothing is owed, so nothing is recorded as owed',
  },
  {
    name: '7  a promise being kept',
    place: "Patrick's penthouse, the kitchen",
    user: 'You said you would show me.',
    story: '*He puts down the cup and stands.* "Come on then." *And he does: twenty minutes, three exits, no jokes about it.*',
    must: (r) => (r.threads || []).length >= 1 || (r.threadUpdates || []).length >= 1,
    why: 'keeping a promise is recorded as something',
  },
  {
    name: '8  who is in the room',
    place: "Patrick's penthouse, the living room",
    user: 'Who was that at the door?',
    story: '*Salvatore comes in without taking his coat off.* "We need to talk." *He looks at Reiko.* "Alone."',
    must: (r) => JSON.stringify(r.scene?.who || []).toLowerCase().includes('salvatore')
      || (r.characters || []).some((c) => /salvatore/i.test(c.name || '')),
    why: 'somebody arriving is noticed',
  },
  {
    name: '9  a concrete fact',
    place: "Patrick's penthouse, the kitchen",
    user: 'What happened to your hand?',
    story: '*The knuckles on his right hand are split and freshly cleaned.* "A door." *It was not a door.*',
    must: (r) => (r.facts || []).some((f) => /hand|knuckle/i.test(f.text || '')),
    why: 'an injury is written down',
  },
  {
    name: '10 something told in confidence',
    place: "Patrick's penthouse, the kitchen",
    user: 'Does anyone else know?',
    story: '"Nobody. Not Salvatore, not my brother." *He looks at her properly.* "If it goes further than this room, people get hurt."',
    must: (r) => (r.facts || []).some((f) => Number(f.secrecy) >= 2),
    why: 'a guarded secret is marked as guarded',
  },
  {
    name: '11 three people at once',
    place: 'the Black Lotus, a private booth',
    user: 'I sit down next to Patrick.',
    story: '*Salvatore pours for all three. Patrick does not touch his.* "So," *Salvatore says to Reiko,* "you are the one." *Patrick answers before she can.* "She is not part of this."',
    must: (r) => (r.relations || []).length >= 2 || (r.characters || []).length >= 2,
    why: 'a three-hander is read as more than one pair',
  },
  {
    name: '12 nothing happens',
    place: "Patrick's penthouse, the kitchen",
    user: 'Mm.',
    story: '*Rain on the window. Neither of them says anything for a while.*',
    mustNot: (r) => (r.facts || []).length > 2 || (r.threads || []).length > 0,
    why: 'a quiet beat does not invent a record',
  },
];

// ------------------------------------------------------------- the transport

const userTurn = (c) => `THE WORLD AS IT STANDS\nPlace: ${c.place}\nPeople: Patrick (here), Reiko (here)\n\n`
  + `CAST: PLAYER (never write for them): Reiko · Patrick\n\nTHE LAST EXCHANGE\n`
  + `Reiko: ${c.user}\n\nSTORY: ${c.story}\n\nWrite down what changed.`;

async function askOllama(model, c, signal) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: SCHEMA,               // Ollama constrains generation to the schema
      options: { temperature: 0, num_ctx: 8192 },
      think: false,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: userTurn(c) },
      ],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const text = j.message?.content || '';
  // HTTP 200 is not success. The record has to parse and be an object.
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
  return parsed;
}

async function askOpenRouter(model, c, signal) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Tipsy background bench' },
    body: JSON.stringify({
      model, temperature: 0, max_tokens: 2400, reasoning: { enabled: false },
      response_format: { type: 'json_schema', json_schema: { name: 'record', strict: false, schema: SCHEMA } },
      provider: { order: PREFERRED_PROVIDERS, ignore: AVOID_PROVIDERS, require_parameters: true },
      messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: userTurn(c) }],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return JSON.parse(j.choices?.[0]?.message?.content || '{}');
}

// ------------------------------------------------------------------- the run

const results = [];
for (const cand of CANDIDATES) {
  if (cand.kind === 'openrouter' && !apiKey) { console.log(`skipping ${cand.label}: no key`); continue; }
  console.log(`\n=== ${cand.label} ===`);
  let good = 0; let bad = 0; let broken = 0; let ms = 0;
  const failedCases = [];

  for (const c of CASES) {
    const t0 = Date.now();
    let r = null; let err = null;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 120000);
      r = cand.kind === 'ollama'
        ? await askOllama(cand.id, c, ac.signal)
        : await askOpenRouter(cand.id, c, ac.signal);
      clearTimeout(timer);
    } catch (e) { err = e.message; }
    const took = Date.now() - t0;
    ms += took;

    if (!r) {
      broken++;
      console.log(`  BROKEN  ${c.name}  — ${err}`);
      failedCases.push(c.name);
      continue;
    }
    const okMust = c.must ? c.must(r) : true;
    const okNot = c.mustNot ? !c.mustNot(r) : true;
    if (okMust && okNot) { good++; console.log(`  ok      ${c.name}  (${(took / 1000).toFixed(1)}s)`); }
    else {
      bad++;
      failedCases.push(c.name);
      const what = !okMust ? `did not: ${c.why}` : `should not have: ${c.why}`;
      console.log(`  WRONG   ${c.name}  — ${what}  (${(took / 1000).toFixed(1)}s)`);
    }
  }
  results.push({ ...cand, good, bad, broken, avg: ms / CASES.length, failedCases });
}

console.log('\n================== side by side ==================\n');
console.log('  model                              right  wrong  broken   avg      cost');
for (const r of results) {
  const cost = r.kind === 'ollama' ? '€0' : 'paid';
  console.log(`  ${r.label.padEnd(34)} ${String(r.good).padStart(4)}   ${String(r.bad).padStart(4)}   ${String(r.broken).padStart(5)}  ${(r.avg / 1000).toFixed(1)}s  ${cost.padStart(6)}`);
}
for (const r of results) {
  if (r.failedCases.length) console.log(`\n  ${r.label} missed: ${r.failedCases.join(' · ')}`);
}
