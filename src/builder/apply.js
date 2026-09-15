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
export function planGenerated(db, { items = [], links = [], poolIds = new Set(), castNames = [], allowLead = false }) {
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

  return { lead, people, entries, links: linkWrites, any: items.length > 0, generated: items.some((i) => i.origin === 'generated') };
}

/** Make the one card a generated lead is allowed to become. Before the story exists. */
export function createLeadCard(db, lead, { opening = '' } = {}) {
  return db.writeCharacter({ name: lead.name, description: lead.content, firstMessage: opening || '' });
}

/**
 * Write a checked plan. Call inside db.transaction, after the story exists.
 *
 * @returns {{ bookId, importId, entryIds: Object<draftId, entryId> }}
 */
export function writeGenerated(db, storyId, plan, { title = 'Story', builder = {}, leadCardId = null } = {}) {
  if (!plan.any) return { bookId: null, importId: null, entryIds: {} };

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

  const bookId = db.createLorebook(
    plan.generated ? `${title} — Story Builder` : `${title} — written for this story`,
    plan.generated ? 'Proposed by the Nexus Story Builder for this story, and accepted in review.' : 'Written in review for this story.',
  );
  if (importId) db.raw.prepare(`UPDATE lorebooks SET import_id=? WHERE id=?`).run(importId, bookId);
  if (importId && leadCardId) db.raw.prepare(`UPDATE characters SET import_id=? WHERE id=?`).run(importId, leadCardId);
  db.raw.prepare(`INSERT OR IGNORE INTO story_lorebooks (story_id,lorebook_id) VALUES (?,?)`).run(storyId, bookId);

  const entryIds = {};
  const provenance = (x) => ({ origin: x.origin, draftId: x.draftId, edited: x.edited, builder: importId });

  for (const p of plan.people) {
    const id = db.saveEntry(bookId, {
      kind: 'character', title: p.name, content: p.content, summary: p.summary, keys: p.keys,
      order: 100, constant: false, enabled: true, original: provenance(p),
    });
    entryIds[p.draftId] = id;
    if (NPC_ROLES.includes(p.role)) {
      // The same guard every cast member passes, however they got here.
      const entry = db.listEntries(bookId).find((e) => e.id === id);
      if (!personFromEntry(entry).person) throw new CompositionError(`"${p.name}" could not be read back as a person.`);
      db.setStoryNpc(storyId, id, p.role);
    }
  }
  for (const e of plan.entries) {
    entryIds[e.draftId] = db.saveEntry(bookId, {
      kind: e.kind, title: e.title, content: e.content, summary: e.summary, keys: e.keys,
      order: 100, constant: e.alwaysOn, enabled: true, original: provenance(e),
    });
  }
  // A lead who became a card is linked to as that card.
  if (plan.lead && leadCardId) entryIds[plan.lead.draftId] = null;

  for (const l of plan.links) {
    const from = entryIds[l.from];
    if (!from) continue;
    if (l.toLead && leadCardId) db.linkEntryToCharacter(from, leadCardId);
    else if (l.characterId) db.linkEntryToCharacter(from, l.characterId);
    else if (l.aboutId) db.linkEntryToEntry(from, l.aboutId);
    else if (l.aboutDraftId && entryIds[l.aboutDraftId]) db.linkEntryToEntry(from, entryIds[l.aboutDraftId]);
  }

  if (importId) {
    db.settleImport(importId, 'story', [
      { kind: 'story', id: storyId, part: 'primary' },
      { kind: 'lorebook', id: bookId, part: 'piece' },
      ...(leadCardId ? [{ kind: 'character', id: leadCardId, part: 'piece' }] : []),
    ]);
  }
  return { bookId, importId, entryIds };
}

/**
 * Turn a reviewed draft into accepted items and links for Apply.
 *
 * A convenience for callers holding a whole draft: every generated or manual
 * item whose draftId is in `accept` (or all of them, if accept is omitted)
 * becomes an item; generated links go with them when both ends are accepted.
 * Roles, sections, titles and text are taken from the draft as edited.
 */
export function acceptedFromDraft(draft, accept = null) {
  const ok = (id) => !accept || accept.includes(id);
  const items = [];
  for (const r of draft.casting) {
    if (!['generated', 'manual'].includes(r.origin) || !ok(r.draftId)) continue;
    if (r.suggested === 'excluded') continue;
    items.push({ type: 'person', draftId: r.draftId, origin: r.origin, name: r.name, role: r.suggested, content: r.content, summary: r.summary, keys: r.keys, promote: r.promote === true, edited: r.edited === true });
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
