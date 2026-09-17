// Accepted Story Builder material becoming real.
//
// Only what the person accepted arrives here, and it arrives as structured
// items, never as one block of text. Each becomes an ordinary lore entry in a
// book made for the story, so the engine treats it exactly like anything
// imported: keys, activation, budget, recursion, exclusions.
//
// Where it came from is kept with the tables that already exist for it:
//
//   imports          one record per apply, source = 'builder', holding what was accepted
//   import_resources what that record produced: the story, the book, any card
//   lorebooks.import_id   the book points at its record
//   lore_entries.original  { origin: 'generated' | 'manual', draftId, edited }
//
// Imported material has source 'file' or 'url' on the same table, and material
// typed in the app has no record at all. So "from Source X", "from the Story
// Builder" and "written by hand" are told apart without a new column.
//
// People are lore-backed by default. A generated person becomes a global
// Character card only when they are the lead and the person explicitly asked
// for a card to be made (promote: true); otherwise a generated lead is refused.

import { nameFromTitle, personFromEntry, NPC_ROLES } from '../import/compose.js';
import { CompositionError } from '../import/compose-apply.js';
import { BUILDER_SECTIONS, SECTION_KIND, HARD } from './contract.js';
import { resolveNpcEntity, recordLinkEvidence, createEntity, declareInSource, setEntrySemantics, distinguish, areDistinct } from '../semantics/store.js';
import { entityInventory } from '../semantics/composition.js';
import { reconcileGenerated, sameName } from './reconcile-entities.js';
import { storyMaterialSource } from '../semantics/authoring.js';
import { slugRef } from '../package/format.js';

/** Which sections carry things that ARE entities, and what kind. */
const ENTRY_ENTITY_TYPE = { places: 'place', factions: 'faction', events: 'event', items: 'item' };

/** "Something with exactly this name was already ruled not to be that one." */
const settledLookup = (db) => {
  const all = db.raw.prepare('SELECT id, canonical_name FROM lore_entities').all();
  return (candidateId, name) => all.some((e) => e.id !== candidateId
    && sameName(e.canonical_name, name) && areDistinct(db, candidateId, e.id));
};

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_ITEMS = 60;
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Check accepted generated items before anything is written.
 *
 * @param {object} db
 * @param {object} o
 *   items      accepted items: { draftId, origin, type: 'person'|'entry', ... }
 *   links      { fromDraftId, characterId | aboutId | aboutDraftId }
 *   poolIds    entry ids the story reads after this apply
 *   castNames  names already in the story (cards and lore-backed people)
 *   allowLead  whether a generated lead may be accepted (new stories only)
 */
export function planGenerated(db, { items = [], links = [], poolIds = new Set(), castNames = [], allowLead = false, bookIds = [], reconcile = {} }) {
  if (!Array.isArray(items) || !Array.isArray(links)) throw new CompositionError('Generated material must be a list.');
  if (items.length > MAX_ITEMS) throw new CompositionError(`At most ${MAX_ITEMS} generated items can be accepted at once.`);

  const seen = new Set();
  const taken = new Set(castNames.map(norm));
  const people = [];
  const entries = [];
  let lead = null;

  for (const raw of items) {
    if (!raw || typeof raw !== 'object') throw new CompositionError('A generated item could not be read.');
    const draftId = str(raw.draftId);
    if (!ID.test(draftId)) throw new CompositionError('A generated item has no usable id.');
    if (seen.has(draftId)) throw new CompositionError(`Two generated items share the id "${draftId}".`);
    seen.add(draftId);
    if (!['generated', 'manual'].includes(raw.origin)) {
      throw new CompositionError('Only generated or hand-written material is created here. Source material already exists.');
    }
    const content = str(raw.content);
    if (!content || content.length > HARD.contentChars) throw new CompositionError(`"${raw.name || raw.title}" needs a description of at most ${HARD.contentChars} characters.`);
    const keys = (Array.isArray(raw.keys) ? raw.keys : []).map(str).filter((k) => k && k.length <= HARD.keyChars).slice(0, HARD.keys);
    const common = {
      draftId, origin: raw.origin, content, keys,
      summary: str(raw.summary).slice(0, HARD.summaryChars),
      edited: raw.edited === true,
    };

    if (raw.type === 'person') {
      const name = str(raw.name);
      if (!name || name.length > HARD.nameChars || !nameFromTitle(name).name) throw new CompositionError(`"${name}" is not a person's name.`);
      if (taken.has(norm(name))) throw new CompositionError(`${name} is already in this story. Use the one that is there rather than making a second.`);
      taken.add(norm(name));
      const role = raw.role;
      if (role === 'lead') {
        if (!allowLead) throw new CompositionError('This story already has its lead.');
        if (lead) throw new CompositionError('A story has one lead. Choose which of them it is.');
        if (raw.promote !== true) {
          throw new CompositionError(`${name} would lead the story but has no character card. Choose an existing card to lead, or accept making ${name} a card.`);
        }
        lead = { ...common, name, keys: [...new Set([name, ...keys])] };
        continue;
      }
      if (![...NPC_ROLES, 'known'].includes(role)) throw new CompositionError(`"${role}" is not a part a generated person can have.`);
      people.push({ ...common, name, role, keys: [...new Set([name, ...keys])] });
      continue;
    }

    if (raw.type === 'entry') {
      const title = str(raw.title);
      if (!title || title.length > HARD.titleChars) throw new CompositionError('A generated entry needs a title.');
      if (!BUILDER_SECTIONS.includes(raw.section)) throw new CompositionError(`"${raw.section}" is not a section.`);
      entries.push({ ...common, title, section: raw.section, kind: SECTION_KIND[raw.section], alwaysOn: raw.alwaysOn === true, keys: keys.length ? keys : [title] });
      continue;
    }
    throw new CompositionError('A generated item must be a person or an entry.');
  }

  const linkWrites = [];
  for (const l of links) {
    if (!l || !seen.has(str(l.fromDraftId))) throw new CompositionError('A link starts from something that was not accepted.');
    if (l.aboutDraftId) {
      if (!seen.has(l.aboutDraftId)) throw new CompositionError('A link points at something that was not accepted.');
      if (lead && l.aboutDraftId === lead.draftId) { linkWrites.push({ from: l.fromDraftId, toLead: true }); continue; }
      linkWrites.push({ from: l.fromDraftId, aboutDraftId: l.aboutDraftId });
    } else if (l.aboutId) {
      if (!poolIds.has(l.aboutId)) throw new CompositionError('A link points at material this story is not using.');
      linkWrites.push({ from: l.fromDraftId, aboutId: l.aboutId });
    } else if (l.characterId) {
      if (!db.getCharacter(l.characterId)) throw new CompositionError('A link points at a character that is no longer in the library.', 404);
      linkWrites.push({ from: l.fromDraftId, characterId: l.characterId });
    } else {
      throw new CompositionError('A link points at nothing.');
    }
  }

  // ---- who the accepted material claims to be, against who already exists.
  // Deterministic, offline, and blocking: nothing that may be somebody already
  // here is written until a person has said which it is.
  const inventory = entityInventory(db, bookIds);
  const claimed = [
    ...(lead ? [{ draftId: lead.draftId, name: lead.name, type: 'person' }] : []),
    ...people.map((p) => ({ draftId: p.draftId, name: p.name, type: 'person' })),
    ...entries.filter((e) => ENTRY_ENTITY_TYPE[e.section]).map((e) => ({ draftId: e.draftId, name: e.title, type: ENTRY_ENTITY_TYPE[e.section] })),
  ];
  const reconciliation = reconcileGenerated(claimed, inventory, { isSettled: settledLookup(db), decisions: reconcile });
  if (reconciliation.unresolved) {
    const open = reconciliation.items.find((x) => x.resolution === null);
    throw new CompositionError(
      `Nexus cannot tell whether "${open.name}" is ${open.candidates.map((c) => c.name).join(' or ')}. In Review, choose the existing one or keep it as new before applying.`);
  }
  // Anything the reviewer said IS an existing entity, and anything that exactly
  // is one, is not written again: the existing one is simply used.
  const dropped = new Set(reconciliation.items.filter((x) => x.resolution === 'reuse').map((x) => x.draftId));
  // Something ruled "keep as new" is a decision worth keeping: the pair is
  // recorded as distinct so nobody is asked the same question again.
  const distinctions = reconciliation.items
    .filter((x) => x.decision === 'possible' && x.resolution === 'new')
    .map((x) => ({ draftId: x.draftId, from: x.candidates.map((c) => c.id) }));

  return {
    lead: lead && dropped.has(lead.draftId) ? null : lead,
    people: people.filter((p) => !dropped.has(p.draftId)),
    entries: entries.filter((e) => !dropped.has(e.draftId)),
    links: linkWrites,
    any: items.length > 0,
    generated: items.some((i) => i.origin === 'generated'),
    reconciliation,
    reusedExisting: reconciliation.items.filter((x) => x.resolution === 'reuse').map((x) => ({ name: x.name, as: x.entity?.name || x.name })),
    distinctions,
  };
}

/** Make the one card a generated lead is allowed to become. Before the story exists. */
export function createLeadCard(db, lead, { opening = '' } = {}) {
  return db.writeCharacter({ name: lead.name, description: lead.content, firstMessage: opening || '' });
}

/**
 * The one package a story's own material lives in, if it has one.
 *
 * Marked on the book itself (`lorebooks.original = {"generatedFor": storyId}`),
 * so it is found again whether or not the story still reads it: taking it out
 * of the story and building again reconnects the same book instead of making a
 * second one.
 */
export function storyPackage(db, storyId) {
  // Either mark means the same thing: this book is the story's own material.
  // Old Builder books said it as generatedFor; the canonical container says it
  // as managedFor, the way every Nexus-managed source is marked.
  return db.raw.prepare(
    `SELECT id, name, import_id FROM lorebooks
     WHERE json_valid(original) AND (json_extract(original, '$.generatedFor') = ?
        OR json_extract(original, '$.managedFor.storyId') = ?)
     ORDER BY created_at LIMIT 1`,
  ).get(storyId, storyId) || null;
}

/**
 * Write a checked plan. Call inside db.transaction, after the story exists.
 *
 * Each story has one package for material made for it, created the first time
 * and appended to afterwards. Every apply that includes generated material
 * gets its own import record — generation provenance — but they all feed the
 * same package. Nothing already in the package is overwritten: a proposal
 * with the same kind and name as something already accepted is skipped and
 * reported, so accepting the same draft twice does not duplicate it.
 *
 * @returns {{ bookId, importId, entryIds: Object<draftId, entryId>, skipped: string[], created: boolean }}
 */
export function writeGenerated(db, storyId, plan, { title = 'Story', builder = {}, leadCardId = null } = {}) {
  if (!plan.any) return { bookId: null, importId: null, entryIds: {}, skipped: [], created: false };

  const importId = plan.generated
    ? db.recordImport({
      source: 'builder',
      filename: title,
      format: 'story-builder',
      detectedRole: 'story',
      analysis: { mode: builder.mode || null, depth: builder.depth || null, model: builder.model || null },
      original: JSON.stringify({
        version: 1,
        people: plan.people.map(({ draftId, name, role, origin, edited }) => ({ draftId, name, role, origin, edited })),
        entries: plan.entries.map(({ draftId, title: t, section, origin, edited }) => ({ draftId, title: t, section, origin, edited })),
        lead: plan.lead ? { draftId: plan.lead.draftId, name: plan.lead.name } : null,
      }),
    })
    : null;

  // One story, one container of its own material. A story that already has an
  // old Builder book keeps feeding it, so nothing splits; a story without one
  // uses the same Story Material container that hand-written material uses —
  // what distinguishes generated from manual is each entry's own provenance,
  // not a second visible source.
  let pkg = storyPackage(db, storyId);
  const created = !pkg && !db.raw.prepare(
    `SELECT 1 x FROM lorebooks WHERE json_valid(original) AND json_extract(original, '$.managedFor.kind')='story-material' AND json_extract(original, '$.managedFor.storyId')=?`).get(storyId);
  if (!pkg) {
    const id = storyMaterialSource(db, storyId);
    pkg = { id, import_id: db.raw.prepare('SELECT import_id FROM lorebooks WHERE id=?').get(id)?.import_id || null };
  } else {
    // A legacy Builder book gains the canonical ownership mark it always
    // meant: this story's own material. Read-compatibly — generatedFor stays.
    const owned = db.raw.prepare('SELECT owner_story_id FROM source_semantics WHERE lorebook_id=?').get(pkg.id);
    if (!owned) {
      db.raw.prepare(`INSERT INTO source_semantics (lorebook_id, package_role, domains, owner_story_id, origin, status, confidence, evidence, created_at, updated_at)
        VALUES (?, 'mixed', '[]', ?, 'native', 'approved', 'high', '{}', ?, ?)`).run(pkg.id, storyId, Date.now(), Date.now());
    }
  }
  const bookId = pkg.id;
  // The book points at the record that first filled it; every later record
  // lists the book among what it produced.
  if (importId && !pkg.import_id) db.raw.prepare(`UPDATE lorebooks SET import_id=? WHERE id=?`).run(importId, bookId);
  if (importId && leadCardId) db.raw.prepare(`UPDATE characters SET import_id=? WHERE id=?`).run(importId, leadCardId);
  db.raw.prepare(`INSERT OR IGNORE INTO story_lorebooks (story_id,lorebook_id) VALUES (?,?)`).run(storyId, bookId);

  const existing = new Map(db.listEntries(bookId).map((e) => [`${e.kind}|${norm(e.title)}`, e.id]));
  const entryIds = {};
  const skipped = [];
  const provenance = (x) => ({ origin: x.origin, draftId: x.draftId, edited: x.edited, builder: importId });

  // Accepted material gains its identity as it is written: the person said yes
  // in review, so the entity, its declaration and its defining reading are
  // approved — with an origin that says exactly how it got here. Nothing a
  // model produced becomes truth before this moment.
  const distinctFrom = new Map((plan.distinctions || []).map((d) => [d.draftId, d.from]));
  const settleEntity = (draftId, entryId, name, type, origin) => {
    const entityId = createEntity(db, { type, name });
    declareInSource(db, {
      lorebookId: bookId, entityId, localRef: uniqueRef(db, bookId, name), localName: name,
      origin: 'generated', status: 'approved', evidence: { accepted: 'in Builder review' },
    });
    setEntrySemantics(db, {
      entryId, scope: 'entity', category: 'profile', definesEntityId: entityId,
      origin: origin === 'manual' ? 'manual' : 'generated', status: 'approved', confidence: 'high',
      evidence: { accepted: 'in Builder review' },
    });
    for (const other of distinctFrom.get(draftId) || []) {
      if (other !== entityId) distinguish(db, other, entityId);
    }
    return entityId;
  };
  const uniqueRef = (dbh, book, name) => {
    const base = slugRef(name, 'entity');
    let ref = base;
    for (let n = 2; dbh.raw.prepare('SELECT 1 x FROM source_entities WHERE lorebook_id=? AND local_ref=?').get(book, ref); n++) ref = `${base}-${n}`;
    return ref;
  };

  for (const p of plan.people) {
    const already = existing.get(`character|${norm(p.name)}`);
    if (already) { entryIds[p.draftId] = already; skipped.push(p.name); continue; }
    const id = db.saveEntry(bookId, {
      kind: 'character', title: p.name, content: p.content, summary: p.summary, keys: p.keys,
      order: 100, constant: false, enabled: true, original: provenance(p),
    });
    existing.set(`character|${norm(p.name)}`, id);
    entryIds[p.draftId] = id;
    const entityId = settleEntity(p.draftId, id, p.name, 'person', p.origin);
    if (NPC_ROLES.includes(p.role)) {
      // The same guard every cast member passes, however they got here.
      const entry = db.listEntries(bookId).find((e) => e.id === id);
      if (!personFromEntry(entry).person) throw new CompositionError(`"${p.name}" could not be read back as a person.`);
      // One person, one cast row: the identity written a moment ago is theirs.
      db.setStoryNpc(storyId, id, p.role, entityId || resolveNpcEntity(db, id));
    }
  }
  for (const e of plan.entries) {
    const key = `${e.kind}|${norm(e.title)}`;
    const already = existing.get(key);
    if (already) { entryIds[e.draftId] = already; skipped.push(e.title); continue; }
    const id = db.saveEntry(bookId, {
      kind: e.kind, title: e.title, content: e.content, summary: e.summary, keys: e.keys,
      order: 100, constant: e.alwaysOn, enabled: true, original: provenance(e),
    });
    existing.set(key, id);
    entryIds[e.draftId] = id;
    // A place, a faction, an event or a thing is an entity too, and the review
    // just approved it.
    if (ENTRY_ENTITY_TYPE[e.section]) settleEntity(e.draftId, id, e.title, ENTRY_ENTITY_TYPE[e.section], e.origin);
  }
  // A lead who became a card is linked to as that card.
  if (plan.lead && leadCardId) entryIds[plan.lead.draftId] = null;

  // Links accepted with generated material are evidence, not semantics: the
  // Story Builder proposed them and review left them ticked.
  for (const l of plan.links) {
    const from = entryIds[l.from];
    if (!from) continue;
    const evidence = { source: 'builder-review', entryId: from };
    if (l.toLead && leadCardId) recordLinkEvidence(db, { ...evidence, characterId: leadCardId });
    else if (l.characterId) recordLinkEvidence(db, { ...evidence, characterId: l.characterId });
    else if (l.aboutId) recordLinkEvidence(db, { ...evidence, aboutId: l.aboutId });
    else if (l.aboutDraftId && entryIds[l.aboutDraftId]) recordLinkEvidence(db, { ...evidence, aboutId: entryIds[l.aboutDraftId] });
  }

  if (importId) {
    db.settleImport(importId, 'story', [
      { kind: 'story', id: storyId, part: 'primary' },
      { kind: 'lorebook', id: bookId, part: 'piece' },
      ...(leadCardId ? [{ kind: 'character', id: leadCardId, part: 'piece' }] : []),
    ]);
  }
  return { bookId, importId, entryIds, skipped, created };
}

/**
 * Turn a reviewed draft into accepted items and links for Apply.
 *
 * A convenience for callers holding a whole draft: every generated or manual
 * item whose draftId is in `accept` (or all of them, if accept is omitted)
 * becomes an item; generated links go with them when both ends are accepted.
 * Roles, sections, titles and text are taken from the draft as edited.
 *
 * Promotion is never read from the draft. A draft is something a model helped
 * write; making someone a card is the person's decision, passed separately as
 * the draftIds they chose.
 */
export function acceptedFromDraft(draft, accept = null, promote = []) {
  const ok = (id) => !accept || accept.includes(id);
  const items = [];
  for (const r of draft.casting) {
    if (!['generated', 'manual'].includes(r.origin) || !ok(r.draftId)) continue;
    if (r.suggested === 'excluded') continue;
    items.push({ type: 'person', draftId: r.draftId, origin: r.origin, name: r.name, role: r.suggested, content: r.content, summary: r.summary, keys: r.keys, promote: promote.includes(r.draftId), edited: r.edited === true });
  }
  for (const s of draft.sections) {
    for (const i of s.items) {
      if (!['generated', 'manual'].includes(i.origin) || !ok(i.draftId)) continue;
      items.push({ type: 'entry', draftId: i.draftId, origin: i.origin, section: s.id, title: i.title, content: i.content, summary: i.summary, keys: i.keys, alwaysOn: i.always === true, edited: i.edited === true });
    }
  }
  const ids = new Set(items.map((i) => i.draftId));
  const links = draft.links
    .filter((l) => l.origin === 'generated' && l.approved && ids.has(l.fromDraftId) && (!l.aboutDraftId || ids.has(l.aboutDraftId)))
    .map((l) => ({ fromDraftId: l.fromDraftId, ...(l.aboutDraftId ? { aboutDraftId: l.aboutDraftId } : l.aboutId ? { aboutId: l.aboutId } : { characterId: l.characterId }) }));
  return { items, links };
}
