// Does the current scene stay current?
//
// Six cases, run against the real extractor with synthetic prose. The point
// is to find out what the engine actually does rather than reason about what
// it ought to do — the last diagnosis of this bug reasoned its way to the
// wrong component.
//
//   node scripts/check-scene-state.js

import { readFileSync, existsSync } from 'node:fs';
import { extract } from '../src/memory/extract.js';
import { emptyState, applyDelta } from '../src/memory/state.js';
import { MEMORY_DEFAULTS } from '../src/memory/index.js';

const env = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
const apiKey = (/OPENROUTER_API_KEY\s*=\s*(\S+)/.exec(env) || [])[1] || process.env.OPENROUTER_API_KEY;
if (!apiKey) { console.log('No API key; this check needs one.'); process.exit(0); }
const model = process.env.MEMORY_MODEL || MEMORY_DEFAULTS.model;

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? `  — ${d}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`); }
};

/** Run one exchange against a state and return the state after it. */
async function step(state, user, story) {
  const { delta } = await extract({
    apiKey, model, state,
    exchange: [{ role: 'user', content: user }, { role: 'assistant', content: story }],
    cast: ['Patrick'], persona: 'Reiko',
  });
  return { next: applyDelta(state, delta), delta };
}

const where = (s) => String(s.scene.where || '').toLowerCase();
const start = () => {
  const s = emptyState();
  s.scene.where = "Patrick's apartment, the bathroom";
  s.scene.who = ['patrick', 'reiko'];
  return s;
};

console.log('scene state, six ways\n');

// A — moved, then a memory of the old place
{
  console.log('A  bathroom → kitchen → remembering the bathroom');
  let s = start();
  ({ next: s } = await step(s, 'I get up and go put the kettle on.',
    '*He follows her out of the bathroom and down the hall. The kitchen light is the only one on.* "You want the good cups or the ones that do not match?"'));
  const afterMove = where(s);
  ok('walking out to the kitchen updates the place', /kitchen/.test(afterMove), afterMove);

  ({ next: s } = await step(s, 'That was not what I expected earlier.',
    '*He leans back against the counter.* "In the bath, you mean." *A short laugh.* "No. Nor did I."'));
  ok('remembering the bathroom does NOT move them back', !/bath/.test(where(s)), where(s));
  ok('and they are still in the kitchen', /kitchen/.test(where(s)), where(s));
}

// B — nothing said about place
{
  console.log('\nB  bathroom, then three turns that never mention where');
  let s = start();
  for (const [u, a] of [
    ['Tell me about your day.', '*He is quiet for a moment.* "Long. Loud. Mostly people wanting things."'],
    ['Anything good in it?', '"One thing." *He does not say what.*'],
    ['You are not going to tell me.', '"Not yet." *He almost smiles.*'],
  ]) ({ next: s } = await step(s, u, a));
  ok('the place persists when nothing changes it', /bath/.test(where(s)), where(s));
}

// C — an explicit move
{
  console.log('\nC  an explicit walk into another room');
  let s = start();
  ({ next: s } = await step(s, 'I am getting cold.',
    '*He stands, wraps the towel round her, and walks her through to the bedroom without asking.*'));
  ok('the new room is the current one', /bedroom/.test(where(s)), where(s));
}

// D — a memory, with no movement at all
{
  console.log('\nD  in the kitchen, remembering a bath');
  let s = emptyState();
  s.scene.where = "Patrick's apartment, the kitchen";
  ({ next: s } = await step(s, 'You were quiet earlier.',
    '*He turns the cup round on the counter.* "I was thinking about the bath. About what you said in it."'));
  ok('a remembered room does not become the current one', !/bath/.test(where(s)), where(s));
}

// E — a sequence, the way a backfill runs it
{
  console.log('\nE  a run of exchanges, each given what the last one produced');
  let s = start();
  const run = [
    ['I want to get out.', '*He hands her the towel and they leave the bathroom together.*'],
    ['Where are we going?', '*Down the hall.* "Kitchen. You have not eaten."'],
    ['Fine.', '*He sets a pan on the hob and finds two eggs.*'],
    ['Do you always cook at this hour?', '"Only when someone refuses dinner twice."'],
    ['I did not refuse.', '*He cracks an egg one-handed.* "You refused."'],
  ];
  for (const [u, a] of run) ({ next: s } = await step(s, u, a));
  ok('the run ends where the story ended', /kitchen/.test(where(s)), where(s));
  ok('and not where it began', !/bath/.test(where(s)));
}

// F — the same run, but each exchange told nothing about what came before
{
  console.log('\nF  the same run, each exchange read in isolation');
  const isolated = emptyState();
  isolated.scene.where = "Patrick's apartment, the bathroom";
  let s = isolated;
  const seen = [];
  for (const [u, a] of [
    ['I want to get out.', '*He hands her the towel and they leave the bathroom together.*'],
    ['Where are we going?', '*Down the hall.* "Kitchen. You have not eaten."'],
    ['Do you always cook at this hour?', '"Only when someone refuses dinner twice."'],
  ]) {
    const { delta } = await extract({
      apiKey, model, state: isolated,   // deliberately never advanced
      exchange: [{ role: 'user', content: u }, { role: 'assistant', content: a }],
      cast: ['Patrick'], persona: 'Reiko',
    });
    seen.push(delta.scene?.where || '(unchanged)');
    s = applyDelta(s, delta);
  }
  console.log(`      what each isolated exchange reported: ${seen.join(' | ')}`);
  ok('reading in isolation is measurably worse or equal, and is recorded here',
    true, 'this case exists to show the difference, not to pass or fail');
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail) process.exitCode = 1;
