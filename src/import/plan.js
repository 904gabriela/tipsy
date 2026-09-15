// From "what is this" to "what should exist because of it".
//
// One file is not one object. A campaign module is a world, a lorebook, a set
// of narrator instructions and three ways in — and those four things have to
// arrive already connected to each other, or importing them is just the start
// of the work rather than the end of it.
//
// Two halves, kept apart so the first can be shown to someone before the
// second happens:
//
//   planFor()   reads a card and says what WOULD be created. Writes nothing.
//   applyPlan() creates it. Writes everything in one transaction.
//
// The role can be overridden between the two. That is the whole point of the
// split: the classifier proposes, and it can be told otherwise.

import { classifyCard, startingPoints, discoverCast, isFastPath, CHOOSABLE_ROLES } from './semantics.js';

const text = (v) => String(v ?? '').trim();

/**
 * A line of prose to put under the name.
 *
 * Card descriptions are written in whatever the author had to hand: markdown
 * headings, W++, a fenced block of JSON. Taking the first two sentences of
 * that raw produced summaries reading "## What this is A campaign framework
 * for…", so the notation comes off first and a record with no prose in it at
 * all gets no summary rather than a bad one.
 */
const firstSentences = (s, n = 2) => {
  const stripped = text(s)
    .replace(/```[\s\S]*?```/g, '\n')             // fenced blocks are data, not a summary
    .replace(/^\s*\[character\([\s\S]*$/i, '\n'); // nor is a W++ record

  // Headings, bullets and table rows are dropped whole rather than unmarked.
  // Unmarking them ran the heading into the sentence after it and produced
  // "What this is A campaign framework for…", which reads like a fault.
  const prose = stripped.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^#{1,6}\s/.test(l) && !/^[-*•|]/.test(l) && !/^\*\*[^*]+\*\*:?$/.test(l))
    .join(' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  if (!prose) return '';
  return prose.split(/(?<=[.!?])\s+/).slice(0, n).join(' ').slice(0, 300);
};

/**
 * What this file should become.
 *
 * @param {object} card   a normalized card
 * @param {object} verdict the classifier's reading, or none to work it out here
 * @param {string} [role] override: what to plan for instead of the verdict
 */
export function planFor(card, verdict = null, role = null) {
  const v = verdict || classifyCard(card);
  const chosen = role && CHOOSABLE_ROLES.includes(role) ? role : v.role;
  const starts = startingPoints(card);
  const book = card.lorebook && card.lorebook.entries?.length ? card.lorebook : null;

  const resources = [];
  const add = (kind, label, detail, extra = {}) =>
    resources.push({ kind, label, detail, ...extra });

  if (chosen === 'character') {
    add('character', card.name, 'a person in your library', { part: 'primary' });
    // Kept exactly as it always was: the book rides in on saveCharacter and
    // belongs to the character. Nothing about this path has changed.
    if (book) add('lorebook', book.name, `${book.entries.length} entries, hers`, { part: 'piece', via: 'character' });
  }

  if (chosen === 'scenario') {
    add('scenario', card.name, 'a situation ready to start', { part: 'primary' });
    if (book) add('lorebook', book.name, `${book.entries.length} entries`, { part: 'piece', via: 'link' });
  }

  if (chosen === 'framework') {
    add('framework', card.name, 'a world many stories can use', { part: 'primary' });
    if (book) add('lorebook', book.name, `${book.entries.length} entries`, { part: 'piece', via: 'link' });
  }

  // Reported for every role, because they are content either way. What they
  // MEAN differs — a character's alternates are other ways to meet her, a
  // campaign's are other places to enter the world — but the text is the same
  // text and it survives regardless.
  if (starts.length) {
    add('starting_points', starts.length === 1 ? 'One opening' : `${starts.length} ways to begin`,
      starts.map((s) => s.label).join(', '), { part: 'piece', count: starts.length });
  }

  const cast = chosen === 'character' ? [] : discoverCast(card);

  return {
    role: chosen,
    overridden: chosen !== v.role,
    confidence: v.confidence,
    because: v.because,
    alternatives: v.alternatives,
    components: v.components,
    parts: v.parts,
    signals: v.signals,
    format: v.format,
    fastPath: isFastPath(v) && chosen === v.role,
    resources,
    cast,
    starts,
    name: card.name,
  };
}

/**
 * Make it so.
 *
 * Everything one file produces is written in a single transaction and tied
 * back to the import record, so a campaign and its lorebook and its three
 * openings are connected the moment they exist rather than afterwards by hand.
 *
 * @returns {{created: Array, primary: {kind,id}}}
 */
export function applyPlan(db, { card, plan, importId = null }) {
  return db.transaction(() => {
    const created = [];
    const note = (kind, id, part = 'piece') => { created.push({ kind, id, part }); return id; };

    if (plan.role === 'character') {
      // Untouched path. A character card imports exactly as it did before
      // any of this existed; the only addition is that its greetings are
      // written down somewhere they can be used.
      const id = db.saveCharacter(card);
      note('character', id, 'primary');
      for (const b of db.listLorebooks().filter((x) => x.from_character === id)) note('lorebook', b.id);
      if (plan.starts.length) db.setStartingPoints('character', id, plan.starts);
      if (importId) db.settleImport(importId, 'character', created);
      return { created, primary: { kind: 'character', id } };
    }

    if (plan.role === 'scenario') {
      const id = db.saveScenario({
        name: card.name,
        // The situation itself. A scenario card puts it in either field and
        // often in both, so both come across, in the order a reader meets them.
        premise: [text(card.scenario), text(card.description)].filter(Boolean).join('\n\n'),
        // How to write it, as opposed to what it is.
        directions: text(card.systemPrompt),
        // Example dialogue on an ensemble card demonstrates the room, not a
        // person. It is kept, and kept unattributed.
        ensemble: plan.parts.find((p) => p.id === 'example')?.ensemble ? text(card.exampleDialogue) : '',
        cast: resolveCast(db, plan.cast),
        tags: card.tags || [],
        importId,
        original: JSON.stringify(card._original ?? null),
      });
      note('scenario', id, 'primary');
      linkBook(db, 'scenario', id, card, note);
      if (plan.starts.length) db.setStartingPoints('scenario', id, plan.starts);
      if (importId) db.settleImport(importId, 'scenario', created);
      return { created, primary: { kind: 'scenario', id } };
    }

    if (plan.role === 'framework') {
      const id = db.saveFramework({
        name: card.name,
        summary: firstSentences(card.description || card.creatorNotes),
        world: text(card.description),
        // What the card told the model about running the place. On a
        // framework this is the point of the file, not an override of ours.
        narrator: [text(card.systemPrompt), text(card.personality)].filter(Boolean).join('\n\n'),
        closing: text(card.postHistoryInstructions),
        depthNote: card.depthPrompt || null,
        ensemble: text(card.exampleDialogue),
        tags: card.tags || [],
        importId,
        original: JSON.stringify(card._original ?? null),
      });
      note('framework', id, 'primary');
      linkBook(db, 'framework', id, card, note);
      if (plan.starts.length) db.setStartingPoints('framework', id, plan.starts);
      if (importId) db.settleImport(importId, 'framework', created);
      return { created, primary: { kind: 'framework', id } };
    }

    throw new Error(`No plan for role "${plan.role}".`);
  });
}

/** The book that came inside the card, saved and tied to its owner. */
function linkBook(db, ownerKind, ownerId, card, note) {
  if (!card.lorebook || !card.lorebook.entries?.length) return null;
  const bookId = db.saveLorebook(card.lorebook);
  db.linkLorebook(ownerKind, ownerId, bookId);
  note('lorebook', bookId);
  return bookId;
}

/**
 * Names, matched against the library where a match already exists.
 *
 * A name with no match stays a name. Nothing is invented from it: a scenario
 * that mentions four classmates gets four mentions, not four blank cards that
 * then sit in the library pretending to be people.
 */
function resolveCast(db, names) {
  return names.map((name) => {
    const found = db.findCharacterByName(name);
    return found ? { name, characterId: found.id } : { name, characterId: null };
  });
}

/**
 * Start a story from a scenario.
 *
 * The scenario is a mould, not a parent. What it knows is copied in; what
 * happens next belongs to the story alone. Editing the scenario afterwards
 * reaches nothing, and two stories from the same scenario share nothing.
 */
export function startFromScenario(db, scenarioId, {
  title = null, personaId = null, startingPointId = null, settings = {},
} = {}) {
  const s = db.getScenario(scenarioId);
  if (!s) throw new Error('No such scenario.');
  const framework = s.framework_id ? db.getFramework(s.framework_id) : null;

  return db.transaction(() => {
    // Names that matched a character in the library become real cast. Names
    // that did not are carried as text so the story still knows who is meant.
    const cast = (s.cast || []).map((c) => (c.characterId ? c : { ...c, characterId: db.findCharacterByName(c.name)?.id || null }));
    const characterIds = cast.map((c) => c.characterId).filter(Boolean);
    const mentioned = cast.filter((c) => !c.characterId).map((c) => c.name);

    const lorebookIds = [...new Set([...(s.lorebookIds || []), ...(framework?.lorebookIds || [])])];

    const storySettings = {
      ...settings,
      premise: [s.premise, mentioned.length ? `Also present: ${mentioned.join(', ')}.` : '']
        .filter(Boolean).join('\n\n'),
      directions: [s.directions, settings.directions].filter(Boolean).join('\n\n'),
      // Kept under its own name so the prompt can frame it as the room's
      // behaviour rather than as one person's voice. Nothing reads it yet.
      ensembleExample: s.ensemble || framework?.ensemble || '',
    };

    const storyId = db.createStory({
      title: title || s.name,
      characterIds,
      lorebookIds,
      personaId,
      settings: storySettings,
      frameworkId: s.framework_id || null,
      scenarioId: s.id,
    });

    // The chosen way in becomes the story's first message, exactly as a
    // character card's greeting always has.
    const points = s.startingPoints || [];
    const chosen = points.find((p) => p.id === startingPointId) || points[0] || null;
    if (chosen && text(chosen.content)) {
      db.addMessage({ storyId, parentId: null, role: 'assistant', content: chosen.content });
    }

    return { storyId, usedStartingPoint: chosen?.id || null, cast, lorebookIds };
  });
}
