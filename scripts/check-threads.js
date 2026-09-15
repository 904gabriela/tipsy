// Unfinished business: one matter, one row.
//
//   node scripts/check-threads.js
//
// No model calls. These feed deltas straight into applyDelta, because what is
// being tested is the bookkeeping, not the reading — and the bookkeeping is
// where one question became eight rows.

import { emptyState, applyDelta, normalizeStatus, isOpen, STATUS } from '../src/memory/state.js';

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? `  — ${d}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`); }
};

const feed = (state, threads, at, messageId = `m${at}`) =>
  applyDelta(state, { threads }, { at, messageId });
const list = (s) => Object.entries(s.threads).map(([id, t]) => ({ id, ...t }));

// ---------------------------------------------------- the vocabulary is closed
console.log('what may be stored as a status');
{
  const cases = [
    ['open', STATUS.OPEN], ['in-progress', STATUS.OPEN], ['active', STATUS.OPEN],
    ['updated', STATUS.OPEN], ['deepened', STATUS.OPEN], ['strengthened', STATUS.OPEN],
    ['still open, now in car after leaving Black Lotus', STATUS.OPEN],
    ['resolved', STATUS.RESOLVED], ['kept', STATUS.RESOLVED], ['fulfilled', STATUS.RESOLVED],
    ['abandoned', STATUS.RETIRED], ['no longer matters', STATUS.RETIRED],
  ];
  const wrong = cases.filter(([raw, want]) => normalizeStatus(raw) !== want);
  ok('every observed wording maps to one of three', wrong.length === 0,
    wrong.map(([r]) => r).join(', ') || 'open, resolved, retired');

  let s = emptyState();
  s = feed(s, [{ text: 'Patrick will explain the blood', status: 'strengthened', owedBy: 'patrick' }], 10);
  s = feed(s, [{ text: 'Patrick will explain the blood on his hands', status: 'still open, now in the car', owedBy: 'patrick' }], 52);
  const stored = [...new Set(list(s).map((t) => t.status))];
  ok('nothing but the enum reaches storage',
    stored.every((v) => Object.values(STATUS).includes(v)), stored.join(', '));
  ok('what the model actually said is kept as a note',
    list(s)[0].note.length > 0, `"${list(s)[0].note.slice(0, 40)}"`);
}

// ------------------------------------------------------ one matter, one row
console.log('\nthe same promise, raised again');
{
  let s = emptyState();
  s = feed(s, [{ text: "Patrick will teach Reiko how to hide when she is scared", owedBy: 'patrick' }], 20);
  s = feed(s, [{ text: "Patrick will teach her how to hide when she's scared", owedBy: 'patrick' }], 60);
  s = feed(s, [{ text: 'Patrick promised to teach Reiko to hide when scared', owedBy: 'patrick' }], 140);
  ok('three mentions make one thread', list(s).length === 1, `${list(s).length} threads`);
  ok('and it counted the mentions', list(s)[0].mentions === 3, `${list(s)[0].mentions}`);
  ok('it kept the wording it was first given',
    /how to hide when she is scared/.test(list(s)[0].text));
  ok('and remembers every message that raised it',
    (list(s)[0].seen || []).length === 3, `${(list(s)[0].seen || []).length} sources`);
  ok('the id carries no message depth', !/^T\d/.test(list(s)[0].id), list(s)[0].id);
}

// ------------------------------------------------------ different obligations
console.log('\ntwo different promises');
{
  let s = emptyState();
  s = feed(s, [{ text: "Patrick will teach Reiko how to hide fear", owedBy: 'patrick' }], 10);
  s = feed(s, [{ text: 'Patrick will take Reiko to Rome', owedBy: 'patrick' }], 12);
  ok('they stay apart', list(s).length === 2, `${list(s).length} threads`);

  // Same place, different obligation: these must not merge either.
  s = feed(s, [{ text: 'Patrick will explain what happened at the Black Lotus', owedBy: 'patrick' }], 20);
  s = feed(s, [{ text: 'Reiko will decide what to wear to the Black Lotus', owedBy: 'reiko' }], 22);
  ok('same place, different people, different obligations', list(s).length === 4, `${list(s).length}`);
}

// -------------------------------------------------------- fulfilled, and stays so
console.log('\na promise kept');
{
  let s = emptyState();
  s = feed(s, [{ text: 'Patrick will take Reiko to Rome', owedBy: 'patrick' }], 10);
  ok('it starts open', isOpen(list(s)[0]));

  s = feed(s, [{ text: 'Patrick will take Reiko to Rome', status: 'kept', owedBy: 'patrick' }], 80);
  ok('keeping it resolves the same thread', list(s).length === 1 && list(s)[0].status === STATUS.RESOLVED,
    `${list(s).length} thread, ${list(s)[0].status}`);

  // Talked about afterwards. It must not come back.
  s = feed(s, [{ text: 'Patrick took Reiko to Rome last spring', owedBy: 'patrick' }], 200);
  ok('mentioning it later does not reopen it', list(s)[0].status === STATUS.RESOLVED, list(s)[0].status);
  ok('and it did not spawn a second copy', list(s).length === 1, `${list(s).length}`);

  s = applyDelta(s, { threadUpdates: [{ id: list(s)[0].id, status: 'active' }] }, { at: 220 });
  ok('nor does an update that calls it active', list(s)[0].status === STATUS.RESOLVED, list(s)[0].status);
}

// ------------------------------------------------------------ retiring one
console.log('\nsomething that stopped mattering');
{
  let s = emptyState();
  s = feed(s, [{ text: 'Reiko will meet Salvatore on Thursday', owedBy: 'reiko' }], 10);
  s = feed(s, [{ text: 'Reiko will meet Salvatore on Thursday', status: 'no longer matters', owedBy: 'reiko' }], 60);
  ok('it retires', list(s)[0].status === STATUS.RETIRED, list(s)[0].status);
  ok('and is not counted as owed', !isOpen(list(s)[0]));
}

// ------------------------------------------------ legacy rows read correctly
console.log('\nrows written before the vocabulary existed');
{
  const legacy = emptyState();
  legacy.threads = {
    'T0052-aaa': { text: 'What happened at the Black Lotus', status: 'still open, now in car after leaving Black Lotus' },
    'T0090-bbb': { text: 'What Salvatore wanted', status: 'active' },
    'T0096-ccc': { text: 'Whether Patrick explains the blood', status: 'strengthened' },
    'T0010-ddd': { text: 'Whether Reiko meets Salvatore', status: 'resolved' },
  };
  const open = Object.values(legacy.threads).filter(isOpen).length;
  ok('old free-text statuses are still read correctly', open === 3, `${open} of 4 still owed`);
  ok('and nothing was rewritten to achieve it',
    legacy.threads['T0052-aaa'].status.startsWith('still open'));
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail) process.exitCode = 1;
