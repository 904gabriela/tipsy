// Making a reviewed composition real, and taking a source back out.
//
// A draft is suggestions. What arrives here is what somebody looked at and
// agreed to, and it is written all at once or not at all: a story that got
// its source but not its cast, or its cast but not its links, is a story in a
// state nobody chose.
//
// Everything written is a reference. No lore entry is copied or edited, no
// card is created, and nothing here touches messages, memory or story state.

import { personFromEntry, nameFromTitle, normalizeRole, NPC_ROLES, SECTIONS } from './compose.js';

export class CompositionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const unique = (xs) => [...new Set(xs.filter(Boolean))];

/**
 * Check a reviewed composition against what exists, before anything is written.
 *
 * Returns the writes to make. Throws on anything that would put the story in
 * a state the model cannot hold: somebody who is not a person in the cast, a
 * lore-backed lead, two leads, material from a book the story will not read.
 */
export function planComposition(db, { storyId = null, existingBookIds = [], lorebookIds = [], casting = [], links = [], recursion = {} }) {
  const newBooks = unique(lorebookIds).filter((id) => !existingBookIds.includes(id));
  for (const id of newBooks) {
    if (!db.getLorebook(id)) throw new CompositionError('One of those sources is no longer in the library.', 404);
  }
  const books = unique([...existingBookIds, ...newBooks]);
  const pool = new Map();
  for (const id of books) for (const e of db.listEntries(id)) pool.set(e.id, e);

  const npcs = [];     // { entryId, role } to set
  const drop = [];     // entryIds to take out of the cast
  const cards = [];    // { characterId, role } — new stories only
  const seen = new Set();

  for (const raw of casting) {
    const role = normalizeRole(raw.role);
    if (!role) throw new CompositionError(`"${raw.role}" is not a part somebody can have.`);

    if (raw.characterId) {
      if (seen.has(`c:${raw.characterId}`)) continue;
      seen.add(`c:${raw.characterId}`);
      if (!db.getCharacter(raw.characterId)) throw new CompositionError('One of those characters is no longer in the library.', 404);
      cards.push({ characterId: raw.characterId, role });
      continue;
    }

    const entry = pool.get(raw.entryId);
    if (!entry) throw new CompositionError('Somebody in that cast comes from a source this story is not using.');
    if (seen.has(`e:${entry.id}`)) continue;
    seen.add(`e:${entry.id}`);

    if (role === 'known' || role === 'excluded') { drop.push(entry.id); continue; }

    // Checked here and not only in the draft, so nothing that calls this can
    // put "Vancetti Family" in the cast however the request was made.
    const verdict = personFromEntry(entry);
    if (!verdict.person) {
      throw new CompositionError(`"${entry.title}" is not a person, so it cannot be in the cast. It stays in the story's material.`);
    }
    if (role === 'lead') {
      throw new CompositionError(`${verdict.name} has no character card, and a lead needs one. Make them a character first, or pick a lead who has a card.`);
    }
    if (!NPC_ROLES.includes(role)) throw new CompositionError(`"${role}" is not a part somebody can have.`);
    npcs.push({ entryId: entry.id, role });
  }

  const leads = cards.filter((c) => c.role === 'lead');
  if (leads.length > 1) throw new CompositionError('A story has one lead. Choose which of them it is.');

  const linkWrites = [];
  for (const l of links) {
    if (!pool.has(l.entryId)) throw new CompositionError('A link points at material this story is not using.');
    if (l.characterId) {
      if (!db.getCharacter(l.characterId)) throw new CompositionError('A link points at a character that is no longer in the library.', 404);
      linkWrites.push({ entryId: l.entryId, characterId: l.characterId });
    } else if (l.aboutId) {
      if (!pool.has(l.aboutId)) throw new CompositionError('A link points at material this story is not using.');
      if (l.aboutId !== l.entryId) linkWrites.push({ entryId: l.entryId, aboutId: l.aboutId });
    }
  }

  const policies = {};
  for (const id of newBooks) if (recursion && recursion[id] === 'block') policies[id] = 'block';

  return { storyId, newBooks, policies, npcs, drop, cards, leads, links: linkWrites };
}

/**
 * Write a checked plan. Call inside db.transaction.
 *
 * Books already connected keep how this story uses them; only new ones are
 * added, with a recursion policy only if one was chosen for them.
 */
export function writeComposition(db, storyId, plan) {
  for (const id of plan.newBooks) {
    db.raw.prepare(`INSERT OR IGNORE INTO story_lorebooks (story_id,lorebook_id) VALUES (?,?)`).run(storyId, id);
    if (plan.policies[id]) db.setStoryLorebookRecursion(storyId, id, plan.policies[id]);
  }
  for (const n of plan.npcs) db.setStoryNpc(storyId, n.entryId, n.role);
  for (const id of plan.drop) db.removeStoryNpc(storyId, id);
  for (const l of plan.links) {
    if (l.characterId) db.linkEntryToCharacter(l.entryId, l.characterId);
    else db.linkEntryToEntry(l.entryId, l.aboutId);
  }
}

/**
 * Apply a reviewed composition to a story that already exists.
 *
 * Cards already in the story are left exactly as they are: adding a source
 * does not recast the story. Everything else goes in one transaction.
 */
export function applyToStory(db, storyId, body) {
  const story = db.getStory(storyId);
  if (!story) throw new CompositionError('No such story.', 404);
  return db.transaction(() => {
    const plan = planComposition(db, { ...body, storyId, existingBookIds: story.lorebookIds, casting: (body.casting || []).filter((c) => !c.characterId) });
    writeComposition(db, storyId, plan);
    const after = db.getStory(storyId);
    return {
      sources: after.lorebookIds.length,
      added: plan.newBooks.length,
      cast: after.characters.length,
      npcs: db.storyNpcs(storyId).length,
      links: plan.links.length,
    };
  });
}

/**
 * What a story would lose if a source were taken out of it.
 *
 * Counted from the same reading the review uses, so the numbers match what
 * the person saw when they added it.
 */
export function sourceRemovalPreview(db, storyId, lorebookId, compose) {
  const story = db.getStory(storyId);
  if (!story) throw new CompositionError('No such story.', 404);
  if (!story.lorebookIds.includes(lorebookId)) throw new CompositionError('That source is not part of this story.', 404);
  const book = db.getLorebook(lorebookId);
  const draft = compose(book.entries, { characters: [], storyCards: story.characters });
  const ids = new Set(book.entries.map((e) => e.id));
  const cast = db.storyNpcs(storyId).filter((n) => ids.has(n.entry_id));
  const policy = db.storyLorebookSettings(storyId).find((r) => r.lorebook_id === lorebookId)?.recursion || null;
  const personaFrom = story.persona && story.persona.from_entry && ids.has(story.persona.from_entry) ? story.persona.name : null;

  return {
    source: { id: book.id, name: book.name, entries: book.entries.length },
    loses: [
      { id: 'people', label: 'People written about in it', count: draft.casting.filter((r) => r.backing === 'lore').length },
      ...draft.sections.filter((s) => s.count).map((s) => ({ id: s.id, label: SECTIONS.find((x) => x.id === s.id)?.label || s.label, count: s.count })),
    ],
    castLeaving: cast.map((n) => ({ entryId: n.entry_id, name: nameFromTitle(n.title).name || n.title, role: n.role })),
    recursion: policy,
    personaFrom,
    keeps: [
      'the source itself, in your Library',
      'every lore entry in it, unchanged',
      'character cards',
      'every message in the story',
      'what each entry is about',
    ],
  };
}

/**
 * Take a source out of a story.
 *
 * Removes the story's connection to the book and the cast memberships that
 * stand on the book's entries — those people have nothing to stand on once
 * the book is gone, and the preview names each one first.
 *
 * Kept: the book, its entries, every card, every message, and the links
 * saying what an entry is about. Those links describe the material, not this
 * story, and another story may be using the same book.
 */
export function removeSource(db, storyId, lorebookId) {
  const story = db.getStory(storyId);
  if (!story) throw new CompositionError('No such story.', 404);
  if (!story.lorebookIds.includes(lorebookId)) throw new CompositionError('That source is not part of this story.', 404);
  return db.transaction(() => {
    const ids = new Set(db.listEntries(lorebookId).map((e) => e.id));
    const leaving = db.storyNpcs(storyId).filter((n) => ids.has(n.entry_id));
    for (const n of leaving) db.removeStoryNpc(storyId, n.entry_id);
    db.raw.prepare(`DELETE FROM story_lorebooks WHERE story_id=? AND lorebook_id=?`).run(storyId, lorebookId);
    return { removed: lorebookId, castLeft: leaving.length };
  });
}
