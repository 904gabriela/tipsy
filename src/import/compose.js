// Turning a package of material into a story you can see.
//
// Adding a source used to mean one row in story_lorebooks, and everything
// inside it — the people, the places, the families, the wound a man carries —
// stayed invisible inside a file. The story said "world and lore: Phase
// Engine Lore" and that was the whole of it.
//
// This reads the package and says what is in it, in the sections a person
// thinks in. It copies nothing and changes nothing: a draft is a list of
// references and suggestions, and it becomes real only when somebody says so.
//
// In "organize" mode it invents nothing whatsoever. Every person, place and
// faction it reports is an entry that already existed, and if it cannot tell
// what something is, it says so instead of guessing.
//
// It works with or without a story. A new story has no conversation, so the
// evidence comes from the source itself: what is always on, what the opening
// names, who the lead's own card talks about, how many other entries refer to
// somebody. An existing story adds what its conversation says, as one more
// kind of evidence rather than the only one.

/** The headings people use, over the types the engine stores. */
export const SECTIONS = [
  { id: 'casting', label: 'Casting', kinds: ['character'] },
  { id: 'places', label: 'Locations', kinds: ['place'] },
  { id: 'factions', label: 'Factions', kinds: ['faction'] },
  { id: 'backstory', label: 'Background & Premise', kinds: ['premise'] },
  { id: 'rules', label: 'Rules', kinds: ['rule'] },
  { id: 'directions', label: 'Directions', kinds: ['direction'] },
  { id: 'events', label: 'Events', kinds: ['event'] },
  { id: 'items', label: 'Items', kinds: ['item'] },
  { id: 'other', label: 'Other', kinds: ['note'] },
];

/**
 * Every state a person can have in a draft.
 *
 * Only the first four are story membership. "known" means the person is in
 * the story's knowledge pool through its source and nothing more; "excluded"
 * means somebody decided against them. Neither is ever stored as cast.
 */
export const ROLES = ['lead', 'main', 'supporting', 'background', 'known', 'excluded'];
export const CAST_ROLES = ['lead', 'main', 'supporting', 'background'];
export const NPC_ROLES = ['main', 'supporting', 'background'];

/** Older drafts said "out". It meant excluded, and still does. */
export const normalizeRole = (r) => (r === 'out' ? 'excluded' : ROLES.includes(r) ? r : null);

const tokens = (s) => Math.ceil(String(s || '').length / 4);
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const keysOf = (e) => (Array.isArray(e.keys) ? e.keys : []).map(String);

// Words that make a title a heading about something rather than somebody's
// name. "Vancetti Family" is a family, "Abandonment Wound" is a wound,
// "Heights Alliance (Dorms)" is a building. None of them can be cast.
const NOT_A_NAME = new Set(`
  identity reputation wound rule rules guidance style arc overview engine boundary
  agency phase threat connection attachment autonomy fear childhood abandonment
  recruitment devotion regression register protection escape plan surface underworld
  personality persona profile background backstory history relationship relationships
  dynamics secret secrets memory memories communication communicates trauma habits
  speech voice appearance traits notes note info system context timeline controller
  world lore setting premise scenario directions instructions reminder core quirks
  kill love detention foster
  family organization organisation clan syndicate crew order council league alliance
  gang guild class squad team faction army police association company corporation
  society union cartel mafia
  house home abode dorm dorms office gym stadium hospital apartment mall fortress joint
  studio ward school academy city street club bar room hall tower building district
  park station base hideout headquarters lab laboratory market restaurant cafe café
  penthouse safehouse warehouse island village town kingdom empire realm forest
  mountain river lake sea temple church prison jail court palace castle manor estate
  incident raid test festival war battle exam attack invasion tournament ceremony
  charts billboard
`.split(/\s+/).filter(Boolean));

// A label in front of a title says what kind of heading it is: "Event: ...",
// "WORLD — ...", "User Persona — ...".
const LABEL_PREFIX = /^(?:event|world(?:\s+context)?|core|rules?|user\s+persona|persona|player|narrator|system|location|place|faction|item|note|disabled|guide|lore)\s*[:—–-]/i;
const CAPS_PREFIX = /^[A-Z][A-Z0-9 &]{2,}\s*[:—–]/;
const PARTICLES = new Set(['de', 'da', 'di', 'del', 'van', 'von', 'bin', 'al', 'le', 'la', 'du']);

/**
 * The name a title gives, or null with the reason it is not a person's name.
 *
 * "Izuku Midoriya: Deku", "Katsuki Bakugo / Dynamight" and "Kurogiri (Oboro)"
 * are people with an alias attached; the name is the part before it.
 */
export function nameFromTitle(title) {
  const t = String(title || '').trim();
  if (!t) return { name: null, reason: 'untitled' };
  if (LABEL_PREFIX.test(t) || CAPS_PREFIX.test(t)) return { name: null, reason: 'a labelled heading' };
  if (/^(how|what|when|where|why|the way|the)\b/i.test(t)) return { name: null, reason: 'a heading, not a name' };

  const name = t.split(/\s*(?::|\s\/\s|\s[—–]\s|\(|,)\s*/)[0].trim();
  if (!name || name.length > 40 || /\d/.test(name)) return { name: null, reason: 'not a name' };
  const words = name.split(/\s+/);
  if (words.length > 4) return { name: null, reason: 'too long to be a name' };
  for (const w of words) {
    const bare = w.toLowerCase().replace(/[^\p{L}]/gu, '');
    if (NOT_A_NAME.has(bare)) return { name: null, reason: `"${w}" describes something, it is not a name` };
    if (/^[\p{Ll}]/u.test(w) && !PARTICLES.has(bare)) return { name: null, reason: 'a phrase, not a name' };
    if (!/^[\p{Lu}]/u.test(w) && !PARTICLES.has(bare)) return { name: null, reason: 'not a name' };
  }
  return { name, reason: null };
}

/**
 * Whether an entry is a person who could be cast, and under what name.
 *
 * Three things all have to hold. The engine typed it a character. Its title
 * is a name, not a heading. And the entry is actually about that name: the
 * name leads its keys or opens its text. That last check exists because real
 * packages carry entries titled "Mitsuki Bakugo" whose text is Katsuki's
 * profile, and casting the title would cast the wrong person.
 *
 * Anything that fails stays exactly where the engine put it and is shown in
 * its section. It is never a cast member because the check was unsure.
 */
export function personFromEntry(e) {
  if (!e || e.kind !== 'character') return { person: false, reason: 'not typed as a character' };
  const { name, reason } = nameFromTitle(e.title);
  if (!name) return { person: false, reason };

  // A name word the author wrote as an ordinary lowercase key is an ordinary
  // word: "childhood", "fear", "recruitment".
  const lowerKeys = new Set(keysOf(e).filter((k) => k === k.toLowerCase()).map((k) => k.trim()));
  for (const w of name.split(/\s+/)) {
    const bare = w.toLowerCase();
    if (lowerKeys.has(bare) && bare !== w) return { person: false, reason: `"${w}" is used as an ordinary word` };
  }

  const first = name.split(/\s+/)[0];
  const said = (text) => wordIn(text, name) || (first.length >= 3 && wordIn(text, first));
  const head = String(e.content || '').slice(0, 200);
  const firstKey = keysOf(e)[0] || '';
  if (!said(head) && !said(firstKey)) {
    return { person: false, reason: 'titled as a person, but the text is about something or someone else', mismatch: true };
  }
  return { person: true, name };
}

/** A name as a whole word, capitalised the way names are. */
function wordIn(text, word) {
  if (!word) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(word)}(?![\\p{L}\\p{N}])`, 'u').test(String(text || ''));
}
function countIn(text, word) {
  if (!word || !text) return 0;
  return (String(text).match(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(word)}(?![\\p{L}\\p{N}])`, 'gu')) || []).length;
}

/**
 * The words that identify somebody in running text.
 *
 * The full name always. The given name as well, when it is long enough to
 * mean something and nobody else in the package shares it — "Todoroki" is
 * four people, "Salvatore" is one.
 */
const HONORIFICS = new Set(['don', 'dr', 'mr', 'mrs', 'ms', 'sir', 'lady', 'lord', 'miss', 'madam', 'captain', 'detective']);
function handlesFor(name, shared) {
  const out = [name];
  const words = name.split(/\s+/).filter((w) => !HONORIFICS.has(w.toLowerCase().replace(/\.$/, '')));
  if (words.length > 1 || words[0] !== name) {
    const first = words[0];
    const last = words[words.length - 1];
    if (first && first.length >= 4 && !shared.has(first)) out.push(first);
    // A surname only when nobody else in the package carries it: "Costa" is
    // one man, "Todoroki" is a family.
    if (last && last !== first && last.length >= 4 && !shared.has(last)) out.push(last);
  }
  return out;
}
const mentionsOf = (text, handles) => {
  if (!text) return 0;
  // The full name is inside every mention of it, so the shorter handles are
  // counted and the full name only when there is nothing shorter.
  if (handles.length === 1) return countIn(text, handles[0]);
  return Math.max(...handles.slice(1).map((h) => countIn(text, h)));
};

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * Turn the evidence about one person into a suggestion.
 *
 * Deliberately conservative. With nothing to go on a person is Known — in the
 * story's knowledge through the source, not placed in the cast — because
 * inventing importance is worse than asking somebody to raise it.
 */
function suggest(evidence) {
  const why = [];
  let score = 0;
  const { mentions, transcript, opening, constant, protagonist, leadNames, namesLead, leadName, refs, card, long, enabled } = evidence;

  if (!enabled) return { role: 'known', why: ['switched off in the source'], score: 0 };

  if (transcript) {
    // Somebody the story keeps coming back to is central to it, whatever the
    // source says.
    if (mentions >= 40) { score += 4; why.push(`mentioned ${mentions} times in the story`); }
    else if (mentions >= 5) { score += 2; why.push(`mentioned ${mentions} times in the story`); }
    else if (mentions > 0) { score += 1; why.push(`mentioned ${mentions} time${mentions === 1 ? '' : 's'} in the story`); }
    else why.push('not named in the story yet');
  }
  if (protagonist) { score += 2; why.push('the source calls them a lead'); }
  if (opening) { score += 2; why.push(`named in the ${opening}`); }
  if (constant) { score += 2; why.push('always on in the source'); }
  if (leadNames) { score += 2; why.push(`${leadName}’s card names them`); }
  else if (namesLead) { score += 1; why.push(`connected to ${leadName}`); }
  if (refs >= 4) { score += 2; why.push(`appears in ${refs} other entries`); }
  else if (refs >= 2) { score += 1; why.push(`appears in ${refs} other entries`); }
  if (card) { score += 1; why.push('has a character card in your library'); }
  if (long) { score += 1; why.push('written about at length'); }

  const role = score >= 6 ? 'main' : score >= 4 ? 'supporting' : score >= 2 ? 'background' : 'known';
  if (!why.length) why.push('little in the source points to them yet');
  return { role, why, score };
}

/**
 * What a piece of material is about, with how sure that is.
 *
 *   high   — the name is in its title or its first sentence
 *   medium — the name is one of its keys
 *   low    — the name only turns up in its opening lines
 *
 * Only names that are there. Never where the file came from.
 */
function aboutness(entry, target) {
  const title = String(entry.title || '');
  const content = String(entry.content || '');
  const firstSentence = content.split(/(?<=[.!?])\s+|\n/)[0].slice(0, 200);
  for (const h of target.handles) {
    if (wordIn(title, h) || wordIn(title, `${h}’s`) || wordIn(firstSentence, h)) {
      return { confidence: 'high', why: wordIn(title, h) || title.includes(h) ? `${target.name} is in its title` : `its first sentence names ${target.name}` };
    }
  }
  for (const h of target.handles) {
    if (keysOf(entry).some((k) => wordIn(k, h))) return { confidence: 'medium', why: `${target.name} is one of its keys` };
  }
  for (const h of target.handles) {
    if (wordIn(content.slice(0, 400), h)) return { confidence: 'low', why: `${target.name} is mentioned near the start` };
  }
  return null;
}

/**
 * Read a package into a story draft.
 *
 * @param {object[]} entries  the package's entries, exactly as stored
 * @param {object}   ctx
 *   characters   every card in the library, for "has a card" evidence only
 *   storyCards   cards already in the story, each with story_role
 *   leadCards    cards chosen to be in a new story; the first leads
 *   transcript   the story so far, if there is one
 *   premise      what the person wrote the story is
 *   opening      the greeting the story will open on
 *   storyNpcs    lore-backed people already in the story: [{entry_id, role}]
 *   mode         'organize' — invent nothing
 * @returns a draft: references and suggestions, nothing written
 */
export function composeSource(entries, ctx = {}) {
  const {
    characters = [], storyCards = [], leadCards = [], transcript = '',
    premise = '', opening = '', storyNpcs = [], mode = 'organize',
  } = ctx;
  const existing = storyCards.length > 0 || !!transcript;

  const all = entries.map((e) => ({ ...e, enabled: !(e.enabled === 0 || e.enabled === false) }));

  // ---------------------------------------------------------------- people
  const verdicts = new Map(all.map((e) => [e.id, personFromEntry(e)]));
  const personEntries = all.filter((e) => verdicts.get(e.id).person);

  // Cards in play. In a new story, the ones chosen; in an existing one, the
  // ones already there. The lead comes first in both.
  const cardsInPlay = existing
    ? [...storyCards].sort((a, b) => (b.story_role === 'lead') - (a.story_role === 'lead'))
    : leadCards;
  const lead = existing ? cardsInPlay.find((c) => c.story_role === 'lead') || null : cardsInPlay[0] || null;
  const cardHandles = (c) => [...new Set([c.name, c.nickname, String(c.name || '').split(/\s+/)[0]]
    .map((s) => String(s || '').trim()).filter((s) => s.length >= 3))];

  // One person, however many entries describe them. The one whose keys lead
  // with the name is the one used; the rest are shown as the same person.
  const groups = new Map();
  for (const e of personEntries) {
    const name = verdicts.get(e.id).name;
    const k = norm(name);
    if (!groups.has(k)) groups.set(k, { name, entries: [] });
    groups.get(k).entries.push(e);
  }
  // Name words more than one person carries, which therefore identify nobody.
  const wordCount = new Map();
  for (const g of groups.values()) {
    for (const w of new Set(g.name.split(/\s+/))) wordCount.set(w, (wordCount.get(w) || 0) + 1);
  }
  for (const c of cardsInPlay) {
    for (const w of new Set(String(c.name || '').split(/\s+/))) wordCount.set(w, (wordCount.get(w) || 0) + 1);
  }
  const shared = new Set([...wordCount].filter(([, n]) => n > 1).map(([w]) => w));

  const leadText = lead
    ? [lead.description, lead.personality, lead.scenario, lead.first_message].filter(Boolean).join('\n')
    : '';
  const openingText = String(opening || '');
  const premiseText = String(premise || '');
  const sizes = [...groups.values()].map((g) => Math.max(...g.entries.map((e) => String(e.content || '').length)));
  const med = median(sizes);
  const npcRole = new Map(storyNpcs.map((n) => [n.entry_id, n.role]));

  const casting = [];
  const matchedCardIds = new Set();

  for (const g of groups.values()) {
    const primary = [...g.entries].sort((a, b) => {
      const ka = norm(keysOf(a)[0] || '').startsWith(norm(g.name).split(' ')[0]) ? 1 : 0;
      const kb = norm(keysOf(b)[0] || '').startsWith(norm(g.name).split(' ')[0]) ? 1 : 0;
      return (b.enabled - a.enabled) || (kb - ka) || (String(b.content).length - String(a.content).length);
    })[0];
    const handles = handlesFor(g.name, shared);
    const ids = new Set(g.entries.map((e) => e.id));

    // Somebody the story already has a card for is that card, not a second
    // copy of them.
    const inPlay = cardsInPlay.find((c) => norm(c.name) === norm(g.name)
      || (c.nickname && norm(c.nickname) === norm(g.name)));
    if (inPlay) {
      matchedCardIds.add(inPlay.id);
      const row = casting.find((r) => r.characterId === inPlay.id);
      if (row) row.entryIds.push(...ids);
      else casting.push(cardRow(inPlay, { entryIds: [...ids] }));
      continue;
    }

    const refs = all.filter((e) => !ids.has(e.id)
      && handles.some((h) => wordIn(`${e.title}\n${keysOf(e).join(' ')}\n${e.content}`, h))).length;
    const libraryCard = characters.find((c) => norm(c.name) === norm(g.name)) || null;
    const openingHit = handles.some((h) => wordIn(openingText, h)) ? 'opening'
      : handles.some((h) => wordIn(premiseText, h)) ? 'premise' : null;
    const leadHandles = lead ? cardHandles(lead) : [];
    // The lead's own card naming somebody is the author placing them in the
    // lead's life. Their entry naming the lead is weaker: most entries in a
    // package about one man name him.
    const leadNames = !!lead && handles.some((h) => wordIn(leadText, h));
    const namesLead = !!lead && leadHandles.some((h) => wordIn(primary.content, h));

    const s = suggest({
      enabled: g.entries.some((e) => e.enabled),
      transcript: !!transcript,
      mentions: mentionsOf(transcript, handles),
      opening: openingHit,
      constant: g.entries.some((e) => e.constant && e.enabled),
      protagonist: /\b(protagonist|main character|love interest)\b/i.test(primary.content),
      leadNames,
      namesLead,
      leadName: lead ? lead.name : '',
      refs,
      card: !!libraryCard,
      long: med > 0 && String(primary.content).length >= med * 2,
    });

    // Already in this story: what they are stays what they are, and says so.
    const current = g.entries.map((e) => npcRole.get(e.id)).find(Boolean);
    casting.push({
      key: `entry:${primary.id}`,
      entryId: primary.id,
      entryIds: [...ids],
      characterId: null,
      libraryCardId: libraryCard ? libraryCard.id : null,
      name: g.name,
      backing: 'lore',
      canLead: false,
      suggested: current || s.role,
      current: current || null,
      why: current ? ['already in this story', ...s.why] : s.why,
      score: s.score,
      mentions: mentionsOf(transcript, handles),
      refs,
      tokens: tokens(primary.content),
      always: !!primary.constant,
      enabled: primary.enabled,
      keys: keysOf(primary).slice(0, 4),
      lorebookId: primary.lorebook_id || null,
    });
  }

  // Cards in play that the source never mentions are still in the story.
  for (const c of cardsInPlay) {
    if (!matchedCardIds.has(c.id) && !casting.some((r) => r.characterId === c.id)) casting.push(cardRow(c, { entryIds: [] }));
  }

  function cardRow(c, { entryIds }) {
    const isLead = lead && c.id === lead.id;
    const role = existing
      ? (c.story_role === 'lead' ? 'lead' : CAST_ROLES.includes(c.story_role) ? c.story_role : 'main')
      : (isLead ? 'lead' : 'main');
    return {
      key: `card:${c.id}`,
      entryId: null,
      entryIds,
      characterId: c.id,
      libraryCardId: c.id,
      name: c.name,
      backing: 'card',
      canLead: true,
      suggested: role,
      current: existing ? role : null,
      locked: existing,
      why: isLead ? ['the story is theirs'] : existing ? ['already in this story'] : ['you chose them'],
      score: 99,
      mentions: 0,
      refs: 0,
      tokens: tokens(`${c.description || ''}${c.personality || ''}${c.scenario || ''}`),
      always: true,
      enabled: true,
      keys: [],
      lorebookId: null,
    };
  }

  const order = (r) => ROLES.indexOf(r.suggested);
  casting.sort((a, b) => order(a) - order(b) || b.score - a.score || a.name.localeCompare(b.name));

  // ----------------------------------------------------- what is about whom
  const targets = [
    ...cardsInPlay.map((c) => ({ kind: 'character', id: c.id, name: c.name, handles: cardHandles(c) })),
    ...casting.filter((r) => r.backing === 'lore').map((r) => ({
      kind: 'entry', id: r.entryId, name: r.name, handles: handlesFor(r.name, shared), entryIds: new Set(r.entryIds),
    })),
  ];
  const peopleIds = new Set(casting.flatMap((r) => r.entryIds));
  const links = [];
  for (const e of all) {
    // People are people. What they are to each other is a relationship, and
    // relationships are not what this is for.
    if (peopleIds.has(e.id)) continue;
    const found = [];
    for (const t of targets) {
      if (t.entryIds && t.entryIds.has(e.id)) continue;
      const a = aboutness(e, t);
      if (a) found.push({ t, ...a });
    }
    const rank = { high: 0, medium: 1, low: 2 };
    found.sort((x, y) => rank[x.confidence] - rank[y.confidence]);
    // A rule or a direction that happens to name somebody in passing is not
    // about them. Only a clear statement counts there.
    const passing = ['rule', 'direction', 'note'].includes(e.kind);
    for (const f of found.filter((x) => !(passing && x.confidence === 'low')).slice(0, 3)) {
      links.push({
        entryId: e.id,
        entryTitle: e.title || '(untitled)',
        ...(f.t.kind === 'character' ? { characterId: f.t.id } : { aboutId: f.t.id }),
        targetName: f.t.name,
        confidence: f.confidence,
        why: f.why,
        // Low confidence is shown and left for a person to confirm.
        approved: f.confidence !== 'low',
      });
    }
  }
  const aboutOf = (id) => links.filter((l) => l.entryId === id && l.approved).map((l) => l.targetName);

  // --------------------------------------------------------------- sections
  const brief = (e, note = '') => ({
    entryId: e.id, title: e.title || '(untitled)', kind: e.kind,
    tokens: tokens(e.content), always: !!e.constant, enabled: e.enabled,
    keys: keysOf(e).slice(0, 4),
    lorebookId: e.lorebook_id || null,
    about: aboutOf(e.id),
    ...(note ? { note } : {}),
  });

  const byKind = (kinds) => all.filter((e) => kinds.includes(e.kind) && !peopleIds.has(e.id));
  const sections = SECTIONS.filter((s) => s.id !== 'casting').map((s) => {
    let items = byKind(s.kinds).map((e) => brief(e));
    if (s.id === 'backstory') {
      // A character entry that is not a person is a sheet about somebody —
      // "Core Identity", "Abandonment". It is background, not cast.
      items = [...items, ...all
        .filter((e) => e.kind === 'character' && !peopleIds.has(e.id) && !verdicts.get(e.id).mismatch)
        .map((e) => brief(e, verdicts.get(e.id).reason))];
    }
    if (s.id === 'other') {
      items = [...items, ...all
        .filter((e) => e.kind === 'character' && !peopleIds.has(e.id) && verdicts.get(e.id).mismatch)
        .map((e) => brief(e, 'titled as a person, but the text is about someone else'))];
    }
    return { id: s.id, label: s.label, kinds: s.kinds, count: items.length, items };
  });

  // Anything the reader could not place. Reported rather than filed away.
  const placed = new Set([...peopleIds, ...sections.flatMap((s) => s.items.map((i) => i.entryId))]);
  const unclear = all.filter((e) => !placed.has(e.id)).map((e) => brief(e));

  const count = (role) => casting.filter((r) => r.suggested === role).length;
  return {
    mode,
    context: existing ? 'existing' : 'new',
    lead: lead ? { characterId: lead.id, name: lead.name } : null,
    casting,
    sections,
    unclear,
    links,
    totals: {
      entries: all.length,
      enabled: all.filter((e) => e.enabled).length,
      disabled: all.filter((e) => !e.enabled).length,
      people: casting.length,
      cast: casting.filter((r) => CAST_ROLES.includes(r.suggested)).length,
      known: count('known'),
      tokens: all.filter((e) => e.enabled).reduce((n, e) => n + tokens(e.content), 0),
      alwaysOn: all.filter((e) => e.constant && e.enabled).length,
      links: links.length,
    },
    // Said out loud so the screen can promise it: nothing has been written.
    invented: 0,
  };
}
