// A source can be read without being changed.
//
// D1 projects one source two ways. One is the filing its own author put in the
// titles; the other is what somebody has actually approved. The whole point of
// this file is that those two never become the same thing:
//
//     Source filing can organise review without becoming semantic truth.
//
// A title reading "05 CLASS 1-B — Hiryu Rin" tells us how its author filed the
// piece. It does not tell us the piece defines a person. The projection must
// group it for review and still report it as belonging to nobody, because
// nobody has said so yet.
//
// The checks below also hold the counting straight. A group of people has an
// entityCount and a pieceCount and they are different numbers; four people who
// between them carry thirteen pieces must never be reported as "four".
//
//   node scripts/check-source-projection.js
//
// Throwaway databases, plus a VACUUM copy of the real library when one is
// there. Production is opened read-only to make the copy and never written.

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { open } from '../src/db/index.js';
import { createEntity, declareInSource, setEntrySemantics, setRelation } from '../src/semantics/store.js';
import { entityProfile } from '../src/semantics/profile.js';
import { sourceProjection, filingOf } from '../src/semantics/source-projection.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};
const note = (s) => console.log(`  NOTE  ${s}`);
const tmp = (tag) => join(mkdtempSync(join(tmpdir(), `nexus-${tag}-`)), 'x.db');
const rows = (db, table) => db.raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;

// ---------------------------------------------------------------- filing
console.log('\nThe author\'s filing, read from a title and nowhere else');

ok('a spaced em dash files a title', filingOf('01 CORE — Canon and continuity')?.group === '01 CORE');
ok('a hyphen inside a name is not a separator',
  filingOf('05 CLASS 1-B — Hiryu Rin')?.group === '05 CLASS 1-B',
  JSON.stringify(filingOf('05 CLASS 1-B — Hiryu Rin')));
ok('only the first separator makes the group',
  filingOf('11 TIMELINE — POST_USJ — U.S.J. attack survived')?.group === '11 TIMELINE');
ok('what follows the first separator is kept whole',
  filingOf('11 TIMELINE — POST_USJ — U.S.J. attack survived')?.rest === 'POST_USJ — U.S.J. attack survived');
ok('a colon files a title', filingOf('NOTE: something')?.group === 'NOTE');
ok('a title with no separator is not filed', filingOf('Love and Attachment') === null);
ok('a bare hyphen does not file a title', filingOf('Well-being') === null);
ok('a separator with nothing before it does not file', filingOf('— orphaned') === null);
ok('a separator with nothing after it does not file', filingOf('01 CORE —') === null);
ok('an empty title is not filed', filingOf('') === null && filingOf(null) === null);

// ------------------------------------------------------------- the invariant
console.log('\nSOURCE FILING != SEMANTIC TRUTH');

const build = () => {
  const db = open(tmp('proj'));
  const book = db.createLorebook('HARBOUR MASTER CANON', '');
  const add = (title, content, kind = 'note') => db.saveEntry(book, {
    order: 100, enabled: true, constant: false, probability: 100,
    keys: [], kind, title, content,
  });
  return { db, book, add };
};

{
  const { db, book, add } = build();

  // Filed by its author, and read by a machine as something it is not. Nobody
  // has approved anything about it. This is the shape of the real failure.
  const rin = add('05 CLASS 1-B — Hiryu Rin', 'NAME: Hiryu Rin | QUIRK: Scales');
  setEntrySemantics(db, {
    entryId: rin, scope: 'world', category: 'direction', origin: 'inferred', status: 'proposed',
  });

  // Filed the same way, and genuinely approved as a person's own entry.
  const kendo = add('05 CLASS 1-B — Itsuka Kendo', 'NAME: Itsuka Kendo | QUIRK: Big Fist');
  const kendoId = createEntity(db, { type: 'person', name: 'Itsuka Kendo' });
  declareInSource(db, { lorebookId: book, entityId: kendoId, localRef: 'kendo', localName: 'Itsuka Kendo', origin: 'manual', status: 'approved' });
  setEntrySemantics(db, {
    entryId: kendo, scope: 'entity', category: 'profile', definesEntityId: kendoId,
    origin: 'manual', status: 'approved',
  });

  // Filed, approved, and about somebody without defining them.
  const kendoTwo = add('05 CLASS 1-B — Itsuka Kendo — how she speaks', 'Direct and friendly.');
  setEntrySemantics(db, { entryId: kendoTwo, scope: 'entity', category: 'speech', origin: 'manual', status: 'approved' });
  setRelation(db, { entryId: kendoTwo, entityId: kendoId, relation: 'subject', origin: 'manual', status: 'approved' });

  // Approved, and about nobody in particular.
  const world = add('03 WORLD — Hero society', 'Licensing and agencies.');
  setEntrySemantics(db, { entryId: world, scope: 'world', category: 'background', origin: 'manual', status: 'approved' });

  // Filed, and never read at all.
  add('03 WORLD — Key cities', 'Travel context.');

  // Not filed by anybody, and never read.
  add('Loose ends', 'Nothing in particular.');

  const before = { sem: rows(db, 'entry_semantics'), rel: rows(db, 'entry_relations'), ent: rows(db, 'lore_entities') };
  const p = sourceProjection(db, book);
  const after = { sem: rows(db, 'entry_semantics'), rel: rows(db, 'entry_relations'), ent: rows(db, 'lore_entities') };

  ok('projecting a source writes nothing', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));

  const at = (id) => p.pieces.find((x) => x.pieceId === id);
  const filedUnder = (name) => p.filing.groups.find((g) => g.name === name);

  ok('a proposal-only piece is filed by its author',
    filedUnder('05 CLASS 1-B').pieceIds.includes(rin));
  ok('a proposal-only piece belongs to nobody',
    at(rin).ownership === 'unsettled', `ownership=${at(rin).ownership}`);
  ok('a proposal-only piece is reported as proposed, not approved',
    at(rin).reading === 'proposed');
  ok('a proposed reading never sets the approved fields',
    at(rin).category === null && at(rin).scope === null && at(rin).owner === null);
  ok('a proposed reading is still visible, under proposal',
    at(rin).proposal?.category === 'direction' && at(rin).proposal?.scope === 'world');
  ok('a piece filed as 1-B and read as a directive is NOT world material',
    !p.semantic.worldGroups.some((g) => g.pieceIds.includes(rin)),
    `world groups: ${JSON.stringify(p.semantic.worldGroups.map((g) => g.name))}`);
  ok('a piece filed as 1-B and read as a directive is NOT anybody\'s',
    !p.semantic.entityGroups.some((g) => g.entities.some((e) => e.pieceIds.includes(rin))));

  ok('an approved piece filed the same way IS its person\'s',
    p.semantic.entityGroups.find((g) => g.name === 'People').entities
      .find((e) => e.name === 'Itsuka Kendo').pieceIds.includes(kendo));
  ok('filing and semantics disagree without either one winning',
    at(kendo).filing.group === '05 CLASS 1-B' && at(kendo).owner.name === 'Itsuka Kendo');
  ok('approved world material reads under its category',
    p.semantic.worldGroups.find((g) => g.name === 'Background')?.pieceIds.includes(world));
  ok('an unread piece is unread, not proposed',
    at(db.listEntries(book).find((e) => e.title === '03 WORLD — Key cities').id).reading === 'unread');

  // ------------------------------------------------------------ the units
  console.log('\nCounts say what they count');

  const people = p.semantic.entityGroups.find((g) => g.name === 'People');
  ok('one person carrying two pieces is one entity and two pieces',
    people.entityCount === 1 && people.pieceCount === 2, `entityCount=${people.entityCount} pieceCount=${people.pieceCount}`);
  ok('no group carries a bare "count" field',
    !('count' in people) && !('count' in p.filing.groups[0]) && !('count' in p.semantic.worldGroups[0]));
  ok('reading states add up to every piece',
    p.reading.approvedPieceCount + p.reading.proposedPieceCount + p.reading.unreadPieceCount === p.source.totalPieceCount,
    `${p.reading.approvedPieceCount}+${p.reading.proposedPieceCount}+${p.reading.unreadPieceCount} = ${p.source.totalPieceCount}`);
  ok('owned and ownerless never include what nobody has settled',
    p.semantic.ownedPieceCount + p.semantic.ownerlessPieceCount + p.reading.unsettledPieceCount === p.source.totalPieceCount,
    `${p.semantic.ownedPieceCount}+${p.semantic.ownerlessPieceCount}+${p.reading.unsettledPieceCount} = ${p.source.totalPieceCount}`);

  // -------------------------------------------------------- one identity
  console.log('\nEvery piece is one piece');

  const ids = p.pieces.map((x) => x.pieceId);
  ok('a piece appears once in pieces', new Set(ids).size === ids.length);
  const filedIds = p.filing.groups.flatMap((g) => g.pieceIds);
  ok('filing accounts for every piece exactly once',
    filedIds.length === ids.length && new Set(filedIds).size === ids.length);
  const semIds = [
    ...p.semantic.entityGroups.flatMap((g) => g.entities.flatMap((e) => e.pieceIds)),
    ...p.semantic.worldGroups.flatMap((g) => g.pieceIds),
  ];
  ok('the semantic view never shows a piece twice', new Set(semIds).size === semIds.length);
  ok('the semantic view holds only approved pieces',
    semIds.every((id) => ['approved', 'recheck'].includes(at(id).reading)), `${semIds.length} shown`);
  ok('the views carry ids, not copies of the piece',
    p.filing.groups.every((g) => g.pieceIds.every((x) => typeof x === 'string')));

  db.close();
}

// -------------------------------------------------------------- real sources
console.log('\nThe real library, on a throwaway copy');

const PROD = 'data/tipsy.db';
if (!existsSync(PROD)) {
  note('no data/tipsy.db here — real-source checks skipped');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-projreal-'));
  const COPY = join(dir, 'copy.db');
  const beforeHash = () => {
    const d = new DatabaseSync(PROD, { readOnly: true });
    const n = {
      entities: d.prepare('SELECT COUNT(*) c FROM lore_entities').get().c,
      semantics: d.prepare('SELECT COUNT(*) c FROM entry_semantics').get().c,
      relations: d.prepare('SELECT COUNT(*) c FROM entry_relations').get().c,
    };
    d.close();
    return n;
  };
  const prodBefore = beforeHash();
  { const src = new DatabaseSync(PROD, { readOnly: true }); src.exec(`VACUUM INTO '${COPY.replace(/\\/g, '/')}'`); src.close(); }

  const db = open(COPY);
  const books = db.raw.prepare('SELECT id, name FROM lorebooks').all();
  const find = (re) => books.find((b) => re.test(b.name));
  const mha = find(/MHA MASTER/i);
  const saint = find(/Saint/i);

  if (!mha) note('no MHA MASTER CANON in this library — skipped');
  else {
    const p = sourceProjection(db, mha.id);
    console.log(`\n  ${p.source.name} — ${p.source.totalPieceCount} pieces`);
    for (const g of p.filing.groups) console.log(`      ${String(g.pieceCount).padStart(3)}  ${g.name}`);

    const ids = p.pieces.map((x) => x.pieceId);
    const filedIds = p.filing.groups.flatMap((g) => g.pieceIds);
    ok('every MHA piece is accounted for exactly once in filing',
      filedIds.length === p.source.totalPieceCount && new Set(filedIds).size === p.source.totalPieceCount,
      `${filedIds.length} of ${p.source.totalPieceCount}, ${new Set(filedIds).size} distinct`);
    ok('MHA piece ids are unique', new Set(ids).size === ids.length);
    ok('MHA group piece counts sum to the whole source',
      p.filing.groups.reduce((n, g) => n + g.pieceCount, 0) === p.source.totalPieceCount);
    ok('MHA has nothing approved, so the semantic view is empty',
      p.semantic.entityCount === 0 && p.semantic.ownedPieceCount === 0 && p.semantic.ownerlessPieceCount === 0,
      `entities ${p.semantic.entityCount}, owned ${p.semantic.ownedPieceCount}, ownerless ${p.semantic.ownerlessPieceCount}`);
    ok('no MHA piece is reported as approved',
      p.reading.approvedPieceCount === 0 && p.reading.unsettledPieceCount === p.source.totalPieceCount);
    ok('nothing in MHA is called a Narrative Rule on a proposal\'s word',
      !p.semantic.worldGroups.some((g) => g.name === 'Directives'),
      `world groups: ${JSON.stringify(p.semantic.worldGroups.map((g) => g.name))}`);
    ok('MHA semantic rows on the copy stay at zero',
      db.raw.prepare('SELECT COUNT(*) c FROM entry_semantics s JOIN lore_entries e ON e.id=s.entry_id WHERE e.lorebook_id=?').get(mha.id).c === 0);
  }

  if (!saint) note('no Saint source in this library — skipped');
  else {
    const p = sourceProjection(db, saint.id);
    console.log(`\n  ${p.source.name} — ${p.source.totalPieceCount} pieces`);
    for (const g of p.semantic.entityGroups) {
      console.log(`      ${g.name} · ${g.entityCount} entities · ${g.pieceCount} pieces`);
      for (const e of g.entities) console.log(`          ${String(e.pieceCount).padStart(2)}  ${e.name}`);
    }
    for (const g of p.semantic.worldGroups) console.log(`      World · ${g.name} · ${g.pieceCount} pieces`);
    console.log(`      owned ${p.semantic.ownedPieceCount} · ownerless ${p.semantic.ownerlessPieceCount}`
      + ` · approved ${p.reading.approvedPieceCount} · unsettled ${p.reading.unsettledPieceCount}`);

    const semIds = [
      ...p.semantic.entityGroups.flatMap((g) => g.entities.flatMap((e) => e.pieceIds)),
      ...p.semantic.worldGroups.flatMap((g) => g.pieceIds),
    ];
    ok('every approved Saint piece is placed exactly once',
      semIds.length === p.reading.approvedPieceCount && new Set(semIds).size === semIds.length,
      `${semIds.length} placed, ${p.reading.approvedPieceCount} approved`);
    ok('owned plus ownerless equals what is approved',
      p.semantic.ownedPieceCount + p.semantic.ownerlessPieceCount === p.reading.approvedPieceCount,
      `${p.semantic.ownedPieceCount}+${p.semantic.ownerlessPieceCount} = ${p.reading.approvedPieceCount}`);
    ok('entity count and piece count are different numbers and both are right',
      p.semantic.entityCount < p.semantic.ownedPieceCount,
      `${p.semantic.entityCount} entities carry ${p.semantic.ownedPieceCount} pieces`);

    const patrick = db.raw.prepare("SELECT id FROM lore_entities WHERE canonical_name LIKE 'Patrick%'").get();
    if (patrick) {
      const shot = JSON.stringify(entityProfile(db, patrick.id));
      sourceProjection(db, saint.id);
      ok('projecting a source leaves Patrick\'s dossier identical',
        JSON.stringify(entityProfile(db, patrick.id)) === shot,
        `${JSON.parse(shot).knowledge.reusable.map((g) => `${g.name}(${g.count})`).join(' ')}`);
    }
  }

  db.close();
  const prodAfter = beforeHash();
  ok('the real library is untouched by all of this',
    JSON.stringify(prodBefore) === JSON.stringify(prodAfter), JSON.stringify(prodAfter));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exitCode = fail ? 1 : 0;
