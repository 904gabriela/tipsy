// A first real call: take one of your actual character cards, build a prompt
// the way the app will, send it, and report what came back and what it cost.
//
//   node scripts/try-model.js "Katsuki Bakugo.json" [model]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importFile } from '../src/import/index.js';

const KEY = readFileSync('.env', 'utf8').match(/^OPENROUTER_API_KEY\s*=\s*(.+)$/m)?.[1].trim();
if (!KEY) { console.error('No OPENROUTER_API_KEY in .env'); process.exit(1); }

const file = process.argv[2] || 'Katsuki Bakugo.json';
const model = process.argv[3] || 'x-ai/grok-4.20';

const bytes = new Uint8Array(readFileSync(join('samples', file)));
const { data: card, name } = importFile(file, bytes);

// The stable half of the prompt. In the real app this is cached, so it is
// paid for once and read cheaply thereafter. Nothing dynamic goes in here.
const system = [
  `You are writing a roleplay with ${name}. Write only ${name} and the world around them. Never write for the user's character, never decide what they say or do.`,
  'Write in third person, present tense, in flowing prose. Vary sentence length. No summarising, no wrapping a scene up neatly, no reaching for a hopeful note that the scene has not earned.',
  'Aim for two to four paragraphs.',
  '',
  `# ${name}`,
  card.description,
  card.personality ? `\n## Personality\n${card.personality}` : '',
  card.scenario ? `\n## Scenario\n${card.scenario}` : '',
].filter(Boolean).join('\n');

const opening = card.firstMessage.slice(0, 2000);
const userLine = process.argv[4]
  || 'Reiko pushes the door open with her shoulder, both hands full, and stops when she sees him already sitting there. "You waited."';

const body = {
  model,
  messages: [
    { role: 'system', content: system },
    ...(opening ? [{ role: 'assistant', content: opening }] : []),
    { role: 'user', content: userLine },
  ],
  temperature: 0.95,
  max_tokens: 900,
  usage: { include: true },
};

const t0 = Date.now();
const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

if (!res.ok) {
  console.error(`HTTP ${res.status}`);
  console.error((await res.text()).slice(0, 800));
  process.exit(1);
}

const json = await res.json();
const choice = json.choices?.[0];
const u = json.usage || {};

console.log(`model    ${json.model || model}`);
console.log(`provider ${json.provider || '(not reported)'}`);
console.log(`took     ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`finish   ${choice?.finish_reason}`);
console.log(`tokens   ${u.prompt_tokens} in / ${u.completion_tokens} out`);
if (u.cost !== undefined) console.log(`cost     $${Number(u.cost).toFixed(5)}`);
console.log(`\n${'-'.repeat(70)}\n`);
console.log(choice?.message?.content ?? '(no content returned)');
