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

/** The headings people use, over the types the engine stores. */
export const SECTIONS = [
  { id: 'casting', label: 'Casting', kinds: ['character'] },
  { id: 'places', label: 'Locations', kinds: ['place'] },
  { id: 'factions', label: 'Factions', kinds: ['faction'] },
  { id: 'backstory', label: 'Background', kinds: ['premise'] },
  { id: 'rules', label: 'Rules', kinds: ['rule'] },
  { id: 'directions', label: 'Directions', kinds: ['direction'] },
  { id: 'events', label: 'Events', kinds: ['event'] },
  { id: 'items', label: 'Things', kinds: ['item'] },
  { id: 'other', label: 'Other', kinds: ['note'] },
];

export const ROLES = ['lead', 'main', 'supporting', 'background', 'out'];

const tokens = (s) => Math.ceil(String(s || '').length / 4);
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** A person's name, as opposed to a heading like "Core Identity". */
const looksLikeAName = (title) => {
  const t = String(title || '').trim();
  if (!t || t.length > 40) return false;
  // A heading about somebody is not somebody. "Core Identity", "The Saint
  // Reputation", "How Patrick Communicates" and "Vancetti Family" all describe
  // a person or a group; none of them is a person to cast.
  if (/^(how|what|when|where|why|the way)\b/i.test(t)) return false;
  if (/\b(identity|reputation|wound|rule|rules|guidance|style|arc|overview|engine|boundary|agency|phase|threat|connection|attachment|autonomy|fear|childhood|abandonment|recruitment|devotion|regression|protection|escape|plan|family|organization|organisation|clan|syndicate|crew|house|order|council|surface|underworld)\b/i.test(t)) return false;
  // One to three capitalised words, and no word that is plainly a common noun
  // carrying the phrase.
  if (!/^[\p{Lu}][\p{L}'’.-]*(\s+[\p{Lu}][\p{L}'’.-]*){0,2}$/u.test(t)) return false;
  return true;
};

/**
 * How much evidence there is that somebody belongs in this story.
 *
 * Counted, never assumed: how often the story itself names them, whether the
 * author marked the entry always-on, and how much was written about them.
 * The result is a suggestion with its reason attached, so a person can
 * disagree with it knowing what it was looking at.
 */
function suggestRole(entry, { transcript = '', leadNames = [] } = {}) {
  const name = String(entry.title || '').trim();
  const first = norm(name).split(' ')[0];
  const isLead = leadNames.some((n) => norm(n) === norm(name) || (first && norm(n).startsWith(first)));
  if (isLead) return { role: 'lead', why: 'the story is about them' };

  let mentions = 0;
  if (first && first.length > 2 && transcript) {
    mentions = (transcript.match(new RegExp(`(?<![\\p{L}])${first}(?![\\p{L}])`, 'giu')) || []).length;
  }
  if (mentions >= 40) return { role: 'main', why: `named ${mentions} times in the story`, mentions };
  if (mentions >= 5) return { role: 'supporting', why: `named ${mentions} times`, mentions };
  if (mentions > 0) return { role: 'background', why: `mentioned ${mentions} time${mentions === 1 ? '' : 's'}`, mentions };
  if (entry.constant) return { role: 'supporting', why: 'the author marked it always-on', mentions: 0 };
  return { role: 'background', why: 'not named in the story yet', mentions: 0 };
}

/**
 * Which people and places a piece of material is about.
 *
 * Only names that are actually in its title, its keys or its opening lines,
 * matched against people the package itself contains. No inference from
 * which file it arrived in.
 */
function relatesTo(entry, people) {
  const hay = norm(`${entry.title} ${(entry.keys || []).join(' ')} ${String(entry.content || '').slice(0, 400)}`);
  const out = [];
  for (const p of people) {
    if (p.id === entry.id) continue;
    const n = norm(p.title);
    if (!n || n.length < 4) continue;
    const first = n.split(' ')[0];
    if (hay.includes(n) || (first.length > 3 && new RegExp(`(?<![\\p{L}])${first}(?![\\p{L}])`, 'u').test(hay))) {
      out.push(p.id);
    }
  }
  return out;
}

/**
 * Read a package into a story draft.
 *
 * @param {object[]} entries  the package's entries, exactly as stored
 * @param {object}   ctx      { characters, transcript, storyTitle, mode }
 * @returns a draft: references and suggestions, nothing written
 */
export function composeSource(entries, ctx = {}) {
  const { characters = [], transcript = '', storyTitle = '', mode = 'organize' } = ctx;

  const enabled = entries.filter((e) => e.enabled !== 0 && e.enabled !== false);
  const people = enabled.filter((e) => e.kind === 'character' && looksLikeAName(e.title));
  // A character entry whose title is not a name is a sheet about somebody —
  // "Core Identity", "The Saint Reputation". Those are background material,
  // not members of the cast, and putting them in Casting is what made the
  // old screen unreadable.
  const aboutPeople = enabled.filter((e) => e.kind === 'character' && !looksLikeAName(e.title));

  // Somebody with a card already counts as that card, not as a new person.
  const byName = new Map(characters.map((c) => [norm(c.name), c]));
  const leadNames = [storyTitle, ...characters.filter((c) => c.story_role === 'lead').map((c) => c.name)];

  const casting = people.map((e) => {
    const card = byName.get(norm(e.title))
      || characters.find((c) => norm(c.name).startsWith(norm(e.title).split(' ')[0]) && norm(e.title).length > 4);
    const s = suggestRole(e, { transcript, leadNames });
    return {
      entryId: e.id,
      name: e.title,
      characterId: card ? card.id : null,
      backing: card ? 'card' : 'lore',
      suggested: card ? (card.story_role === 'lead' ? 'lead' : s.role) : s.role,
      why: card ? 'already a character in your library' : s.why,
      mentions: s.mentions ?? 0,
      tokens: tokens(e.content),
      always: !!e.constant,
      keys: (e.keys || []).slice(0, 4),
    };
  }).sort((a, b) => ROLES.indexOf(a.suggested) - ROLES.indexOf(b.suggested) || b.mentions - a.mentions);

  const brief = (e) => ({
    entryId: e.id, title: e.title || '(untitled)', kind: e.kind,
    tokens: tokens(e.content), always: !!e.constant,
    keys: (e.keys || []).slice(0, 4),
    about: relatesTo(e, people),
  });

  const sections = SECTIONS.filter((s) => s.id !== 'casting').map((s) => {
    const list = s.id === 'backstory'
      ? [...enabled.filter((e) => s.kinds.includes(e.kind)), ...aboutPeople]
      : enabled.filter((e) => s.kinds.includes(e.kind));
    return { ...s, count: list.length, items: list.map(brief) };
  }).filter((s) => s.count);

  // Anything the reader could not place. Reported rather than filed away.
  const placed = new Set([
    ...people.map((e) => e.id),
    ...sections.flatMap((s) => s.items.map((i) => i.entryId)),
  ]);
  const unclear = enabled.filter((e) => !placed.has(e.id)).map(brief);

  return {
    mode,
    casting,
    sections,
    unclear,
    totals: {
      entries: enabled.length,
      disabled: entries.length - enabled.length,
      people: casting.length,
      tokens: enabled.reduce((n, e) => n + tokens(e.content), 0),
      alwaysOn: enabled.filter((e) => e.constant).length,
    },
    // Said out loud so the screen can promise it: nothing has been written.
    invented: 0,
  };
}
