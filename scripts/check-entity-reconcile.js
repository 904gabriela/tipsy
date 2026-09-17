// The Builder's inventions, held against who already exists.
//
//   node scripts/check-entity-reconcile.js
//
// Pure and offline: a fixed inventory, generated names, and the three honest
// answers. The promises held here: nothing merges on its own, different types
// never merge, a settled pair is not asked about again, and an unanswered
// maybe blocks the way.

import { reconcileGenerated, classifyGenerated, nameTokens, sameName } from '../src/builder/reconcile-entities.js';

let pass = 0; let fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? `  — ${d}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

const INVENTORY = [
  { id: 'e-marco', ref: 'marco', name: 'Marco', type: 'person', aliases: [], status: 'confirmed' },
  { id: 'e-pent', ref: 'penthouse', name: 'Penthouse', type: 'place', aliases: [], status: 'confirmed' },
  { id: 'e-safe', ref: 'safehouse', name: 'Safehouse', type: 'place', aliases: [], status: 'confirmed' },
  { id: 'e-patrick', ref: 'patrick', name: 'Patrick Moretti', type: 'person', aliases: ['Patrick', 'The Saint'], status: 'confirmed' },
  { id: 'e-ghost', ref: 'ghost', name: 'The Ghost', type: 'person', aliases: [], status: 'unconfirmed' },
];

section('the golden four');
{
  const { items, unresolved } = reconcileGenerated([
    { draftId: 'g1', name: 'Marco Rossi', type: 'person' },
    { draftId: 'g2', name: "Patrick's Penthouse", type: 'place' },
    { draftId: 'g3', name: 'Industrial Safehouse', type: 'place' },
    { draftId: 'g4', name: 'Sofia Bell', type: 'person' },
  ], INVENTORY);
  const by = Object.fromEntries(items.map((x) => [x.draftId, x]));
  ok('Marco Rossi may be Marco, and nobody decides but a person',
    by.g1.decision === 'possible' && by.g1.candidates.some((c) => c.name === 'Marco'), by.g1.reason);
  ok("Patrick's Penthouse may be the Penthouse",
    by.g2.decision === 'possible' && by.g2.candidates.some((c) => c.name === 'Penthouse'), by.g2.reason);
  ok('Industrial Safehouse may be the Safehouse',
    by.g3.decision === 'possible' && by.g3.candidates.some((c) => c.name === 'Safehouse'), by.g3.reason);
  ok('Sofia Bell is simply new', by.g4.decision === 'new', by.g4.reason);
  ok('nothing merged on its own', items.every((x) => x.decision !== 'reuse'));
  ok('the three maybes block the way until answered', unresolved === 3);
}

section('reuse, said plainly');
{
  const byRef = classifyGenerated({ name: 'Patrick', type: 'person', ref: 'patrick' }, INVENTORY);
  ok('an explicit ref is reuse, not a guess', byRef.decision === 'reuse' && byRef.entity.id === 'e-patrick', byRef.reason);
  const byName = classifyGenerated({ name: 'Marco', type: 'person' }, INVENTORY);
  ok('an exact name of one confirmed entity is reuse', byName.decision === 'reuse' && byName.entity.id === 'e-marco');
  const byAlias = classifyGenerated({ name: 'The Saint', type: 'person' }, INVENTORY);
  ok('an exact alias is reuse too', byAlias.decision === 'reuse' && byAlias.entity.id === 'e-patrick');
  const tidied = classifyGenerated({ name: 'marco', type: 'person' }, INVENTORY);
  ok('case and punctuation do not defeat an exact match', tidied.decision === 'reuse');
}

section('what never merges');
{
  const crossType = classifyGenerated({ name: 'Marco', type: 'place' }, INVENTORY);
  ok('the same name as a different type is not the same thing', crossType.decision !== 'reuse'
    && crossType.candidates.every((c) => c.name !== 'Marco'), crossType.decision);
  const refCross = classifyGenerated({ name: 'Marco', type: 'place', ref: 'marco' }, INVENTORY);
  ok('even an explicit ref cannot cross types', refCross.decision === 'new', refCross.reason);
  const ghostly = classifyGenerated({ name: 'The Ghost', type: 'person' }, INVENTORY);
  ok('an exact match against a guess is a question, not a merge',
    ghostly.decision === 'possible' && /not confirmed/.test(ghostly.candidates[0].why), ghostly.candidates[0].why);
  const far = classifyGenerated({ name: 'Rosa Delgado', type: 'person' }, INVENTORY);
  ok('mere similarity of feel is nothing', far.decision === 'new');
}

section('a pair already ruled separate');
{
  // A person once decided that a Marco Rossi is not Marco. The question is settled.
  const isSettled = (candidateId, name) => candidateId === 'e-marco' && sameName(name, 'Marco Rossi');
  const again = classifyGenerated({ name: 'Marco Rossi', type: 'person' }, INVENTORY, isSettled);
  ok('it is not asked again', again.decision === 'new', again.reason);
  const other = classifyGenerated({ name: "Marco's Brother", type: 'person' }, INVENTORY, isSettled);
  ok('but a different name still asks', other.decision === 'possible', other.reason);
}

section('the reviewer answers');
{
  const gen = [{ draftId: 'g1', name: 'Marco Rossi', type: 'person' }];
  const useExisting = reconcileGenerated(gen, INVENTORY, { decisions: { g1: { use: 'existing', id: 'e-marco' } } });
  ok('"use existing" resolves to that entity', useExisting.items[0].resolution === 'reuse'
    && useExisting.items[0].entity.id === 'e-marco' && useExisting.unresolved === 0);
  const keepNew = reconcileGenerated(gen, INVENTORY, { decisions: { g1: { use: 'new' } } });
  ok('"keep as new" resolves the other way', keepNew.items[0].resolution === 'new' && keepNew.unresolved === 0);
  const wrong = reconcileGenerated(gen, INVENTORY, { decisions: { g1: { use: 'existing', id: 'e-pent' } } });
  ok('an answer naming someone who was never offered does not count',
    wrong.items[0].resolution === null && wrong.unresolved === 1);
}

section('the pieces themselves');
ok('tokens survive possessives and case', nameTokens("Patrick's Penthouse").join('/') === 'patrick/penthouse');
ok('and accents', nameTokens('Renée').join('/') === 'renee');
ok('empty names match nothing', classifyGenerated({ name: '  ', type: 'person' }, INVENTORY).decision === 'new');

console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exit(fail ? 1 : 0);
