// The rule that decides whether a recorded scene is replaced.
//
//   node scripts/check-reconcile.js
//
// No model calls: the reading is the model's job and is tested elsewhere.
// What is tested here is the decision made with its answer, because that is
// what protects a correct state from a confident guess.

import { emptyState } from '../src/memory/state.js';
import { applyReconciliation, sceneWindow } from '../src/memory/reconcile.js';

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? `  — ${d}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`); }
};
const at = (where, who = ['patrick', 'reiko']) => {
  const s = emptyState();
  s.scene.where = where;
  s.scene.who = who;
  s.clock.display = 'late evening';
  return s;
};

console.log('A  an explicit move');
{
  const s = at("Patrick's penthouse, the bedroom");
  const r = applyReconciliation(s, { changed: true, location: "Patrick's penthouse, the kitchen", locationConfidence: 'high' }, { before: s.scene.where });
  ok('the recorded place is replaced', r.applied && /kitchen/i.test(s.scene.where), s.scene.where);
}

console.log('\nB  a move nobody narrated');
{
  const s = at("Patrick's penthouse, the bedroom");
  // What the window establishes without a walk being described.
  const r = applyReconciliation(s, { changed: true, location: "Patrick's penthouse, the kitchen", locationConfidence: 'medium' }, { before: s.scene.where });
  ok('a strongly implied move still counts', r.applied, `${r.before} → ${r.after}`);
  ok('and it says why', /happen there/.test(r.reason), r.reason);
}

console.log('\nC  a remembered room');
{
  const s = at("Patrick's penthouse, the kitchen");
  const r = applyReconciliation(s, { changed: false, location: '', locationConfidence: 'high' }, { before: s.scene.where });
  ok('nothing moves', !r.applied && /kitchen/i.test(s.scene.where), s.scene.where);
  ok('and the reason is recorded', r.reason.length > 0, r.reason);
}

console.log('\nD  a window with no setting in it at all');
{
  const s = at("Patrick's penthouse, the kitchen");
  const r = applyReconciliation(s, { changed: false }, { before: s.scene.where });
  ok('the known place survives', !r.applied && /kitchen/i.test(s.scene.where));
}

console.log('\nE  a guess must not beat a record');
{
  const s = at("Patrick's penthouse, the kitchen");
  const r = applyReconciliation(s, { changed: true, location: 'somewhere in the city', locationConfidence: 'low' }, { before: s.scene.where });
  ok('low confidence is refused', !r.applied && /kitchen/i.test(s.scene.where), r.reason);

  const s2 = at("Patrick's penthouse, the kitchen");
  const r2 = applyReconciliation(s2, { changed: true, location: '', locationConfidence: 'high' }, { before: s2.scene.where });
  ok('"it changed" without naming anywhere is refused', !r2.applied, r2.reason);

  const s3 = at("Patrick's penthouse, the kitchen");
  const r3 = applyReconciliation(s3, { changed: true, location: "patrick's penthouse, the KITCHEN", locationConfidence: 'high' }, { before: s3.scene.where });
  ok('the same place written again is not a change', !r3.applied, r3.reason);
}

console.log('\nF  who is actually in the room');
{
  const s = at("Patrick's penthouse, the kitchen", ['patrick', 'reiko', 'salvatore']);
  applyReconciliation(s, { changed: false, presentCharacters: ['Patrick', 'Reiko'] }, { before: s.scene.where });
  ok('someone who left stops being present', !s.scene.who.includes('salvatore'), s.scene.who.join(', '));
  ok('and the people still there remain', s.scene.who.includes('patrick') && s.scene.who.includes('reiko'));

  const s2 = at("Patrick's penthouse, the kitchen", ['patrick', 'reiko']);
  applyReconciliation(s2, { changed: false }, { before: s2.scene.where });
  ok('saying nothing about presence changes nobody', s2.scene.who.length === 2);
}

console.log('\n   the time, on the same rule');
{
  const s = at("Patrick's penthouse, the kitchen");
  applyReconciliation(s, { changed: false, time: 'past one in the morning' }, { before: s.scene.where });
  ok('an established time is taken', /past one/.test(s.clock.display), s.clock.display);
  const s2 = at("Patrick's penthouse, the kitchen");
  applyReconciliation(s2, { changed: false, time: '' }, { before: s2.scene.where });
  ok('an empty one leaves the clock alone', s2.clock.display === 'late evening');
}

console.log('\n   the window it reads');
{
  const path = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}`, depth: i }));
  const w = sceneWindow(path);
  ok('it is the last few turns, not the whole story', w.length === 8, `${w.length} messages`);
  ok('and it ends on the newest one', w[w.length - 1].depth === 39);
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail) process.exitCode = 1;
