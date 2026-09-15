// Working out what a lore entry actually is.
//
// Imported books carry no type. Everything is just an entry with keywords.
// But the kinds behave very differently — a character belongs in the world,
// while a rule about how to write belongs in the story's instructions where
// it is cached and stops competing with the world for space.
//
// These are guesses. Every one is overridable, and the editor says so.

export const KINDS = {
  character: { label: 'Character', hint: 'A person in the story' },
  place: { label: 'Place', hint: 'Somewhere things happen' },
  faction: { label: 'Group', hint: 'A family, gang, agency or organisation' },
  premise: { label: 'Backstory', hint: 'History, motivation, a wound, a theme' },
  item: { label: 'Thing', hint: 'An object, a power, a piece of equipment' },
  event: { label: 'Event', hint: 'Something that happened, or is about to' },
  rule: { label: 'World rule', hint: 'How this world works' },
  direction: { label: 'Direction', hint: 'An instruction about how to write, not something true in the world' },
  note: { label: 'Note', hint: 'Anything else' },
};

const has = (text, words) => words.some((w) => text.includes(w));
const countMatches = (text, words) => words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);

// A word people actually write at the front of an entry, and what it means.
const LABELS = {
  event: 'event',
  location: 'place',
  place: 'place',
  setting: 'place',
  area: 'place',
  venue: 'place',
  organization: 'faction',
  organisation: 'faction',
  faction: 'faction',
  group: 'faction',
  agency: 'faction',
  team: 'faction',
  family: 'faction',
  character: 'character',
  person: 'character',
  persona: 'character',
  item: 'item',
  object: 'item',
  equipment: 'item',
  weapon: 'item',
  quirk: 'item',
  power: 'item',
  ability: 'item',
  rule: 'rule',
  law: 'rule',
  system: 'rule',
  concept: 'rule',
  term: 'rule',
  lore: 'rule',
  'world state': 'rule',
  'world event': 'event',
  era: 'rule',
  timeline: 'event',
  backstory: 'premise',
  history: 'premise',
  background: 'premise',
  relationship: 'premise',
  theme: 'premise',
  guideline: 'direction',
  guidelines: 'direction',
  instruction: 'direction',
  instructions: 'direction',
  style: 'direction',
  format: 'direction',
  note: 'note',
  notes: 'note',
};

/**
 * What the entry says it is, before any guessing.
 *
 * Most real lorebooks label their entries: "Event: the Sports Festival",
 * "---- Location: Ground Gamma", "Organization: the Safety Commission". An
 * earlier version of this ignored all of that and guessed from the prose,
 * which filed 55 places and events as people.
 */
function explicitLabel(entry) {
  const title = String(entry.title || '').trim();
  // Leading dashes and whitespace are decoration in a lot of exported books.
  const head = String(entry.content || '').replace(/^[\s\-–—=*_#]+/, '').slice(0, 120);
  const body = String(entry.content || '');

  // A stat block settles it before anything else looks at the words. A hero
  // called "Rule" would otherwise be filed as a rule.
  if (/^\s*role\s*:/im.test(body) && /^\s*quirk\s*:/im.test(body)) {
    return { kind: 'character', because: 'It has a role and a power, the shape of a character sheet.' };
  }

  // These words in a title mean "how to write", near enough always, wherever
  // in the title they sit: "CORE — Canon & Continuity Rules", "Global Erotic
  // Style", "RP — Japanese Dialogue Rendering".
  if (/\b(rules?|guidelines?|instructions?|style|rendering|formatting|format|consistency|continuity|protocol|directive|conventions?)\b/i.test(title)
      && !/^\s*(rule|law)\s*[:—–-]/i.test(title)) {
    return { kind: 'direction', because: 'Its title is about how to write, not about the world.' };
  }

  // A body written as guidance to the writer — "- Guidance:", "- Instruction:",
  // "- Rule:" — is an instruction however its title reads. "Sensual
  // Lovemaking" looks like a name; its text is a note to the author.
  if (/^\s*[-*•]?\s*(guidance|instruction|rule|guideline|tip|note to (the )?(writer|ai))\s*:/im.test(body)) {
    return { kind: 'direction', because: 'It is written as guidance to the writer.' };
  }

  for (const source of [title, head]) {
    const m = /^([A-Za-z][A-Za-z ]{2,20}?)\s*[:—–-]\s*\S/.exec(source);
    if (!m) continue;
    const word = m[1].trim().toLowerCase().replace(/\s+/g, ' ');
    // "User Persona — Reiko" and "Persona: Reiko" both name the player.
    if (/\b(user )?persona\b/.test(word)) {
      return { kind: 'character', playable: true, because: 'It is labelled as the character you play.' };
    }
    const direct = LABELS[word] || LABELS[word.split(' ').pop()];
    if (direct) return { kind: direct, because: `It is labelled "${m[1].trim()}".` };
  }

  // "Describes the cowgirl position", "Guidelines for dirty talk",
  // "Instructions for giving a handjob" — these tell the AI how to write a
  // thing, they are not facts about the world.
  if (/^\s*(describes?|guidelines?\s+for|instructions?\s+for|general\s+instructions|transformation\s+for|rules?\s+for|how\s+to|tips?\s+for|a\s+guide\s+to)\b/i.test(title)
      || /^\s*(describes?|guidelines?\s+for|instructions?\s+for|general\s+instructions|transformation\s+for)\b/i.test(head)) {
    return { kind: 'direction', because: 'It describes how to write something rather than stating a fact.' };
  }

  // "Keigo Takami: Hawks" — a real name and the name they go by. But only
  // when the text behaves like it is about a person: "Sensual Lovemaking /
  // Making Love" and "World State: Dark Hero" fit the same shape and are not.
  const twoNames = /^(\p{Lu}[\p{Ll}']+(?:\s+\p{Lu}[\p{Ll}']+){0,2})\s*[:/—–-]\s*(\p{Lu}[\p{Ll}']+.*)$/u.exec(title);
  if (twoNames && !LABELS[twoNames[1].toLowerCase()]) {
    const lower = body.toLowerCase();
    const pronouns = (lower.match(/\b(he|him|his|she|her|hers|they|them|their)\b/g) || []).length;
    const personish = pronouns >= 2
      || /^\s*(role|quirk|age|birthday|height|occupation|hero name|alias)\s*:/im.test(body)
      || /\b(was born|grew up|his|her)\b/.test(lower);
    if (personish) return { kind: 'character', because: 'The title is a name and an alias, and the text is about a person.' };
  }

  return null;
}

/**
 * Guess what an entry is.
 * @returns {{kind: string, confidence: number, because: string, playable?: boolean}}
 */
export function classifyEntry(entry) {
  const title = String(entry.title || '').toLowerCase();
  const body = String(entry.content || '').toLowerCase();
  const text = `${title}\n${body}`;
  const keys = (entry.keys || []).map((k) => String(k).toLowerCase());

  // What it says it is always beats what it looks like.
  const said = explicitLabel(entry);
  if (said) return { confidence: 0.95, ...said };

  // --- directions first, because getting these wrong is the expensive mistake

  const directionWords = [
    'you must', 'you should', 'do not write', 'never write', 'always write',
    'avoid using', 'response length', 'reply length', 'word count',
    'formatting', 'render dialogue', 'in character', 'stay in character',
    'break character', 'ooc', 'out of character', 'narration style',
    'writing style', 'prose style', 'point of view', 'third person',
    'first person', 'past tense', 'present tense', 'paragraph',
    'do not summarize', 'do not repeat', 'system instruction', 'ai should',
    'the model', 'the assistant', 'never speak for', 'do not speak for',
  ];
  const titleSaysRules = /\b(rule|rules|core|system|instruction|guideline|directive|protocol|format|style|meta)\b/.test(title);
  const directionHits = countMatches(text, directionWords);

  // An entry keyed to a person's name is about that person, even when it
  // says how they speak. "Bakugo — Speech Style" is lore, not an instruction,
  // and moving it out of the book would silence the character.
  const looksLikeName = (entry.keys || []).some((k) => /^\p{Lu}\p{Ll}+( \p{Lu}\p{Ll}+)?$/u.test(String(k).trim()));
  const directionBar = looksLikeName ? 4 : (titleSaysRules ? 2 : 3);

  if (directionHits >= directionBar) {
    return {
      kind: 'direction',
      confidence: directionHits >= 4 ? 0.9 : 0.7,
      because: 'It tells the AI how to write rather than saying something true about the world.',
    };
  }

  // --- a person

  const personWords = [
    'quirk:', 'age:', 'height:', 'appearance', 'personality', 'wears', 'hair',
    'eyes', 'voice', 'speaks', 'her name', 'his name', 'their name',
    'born', 'years old', 'loves', 'hates', 'fears', 'wants', 'believes',
    'grew up', 'childhood', 'trained', 'works as', 'known as', 'owns',
  ];
  const personHits = countMatches(text, personWords);

  // An entry about a person is thick with pronouns pointing at that person.
  // That is a better signal than any list of words, because it does not
  // depend on how the writer happens to phrase things.
  const words = body.split(/\W+/).filter(Boolean);
  const pronouns = words.filter((w) => ['he', 'him', 'his', 'she', 'her', 'hers', 'they', 'them', 'their'].includes(w)).length;
  const pronounRate = words.length ? pronouns / words.length : 0;
  const aboutAPerson = /\b(man|woman|boy|girl|person|he|she)\b/.test(body);

  // "Salvatore is an experienced, pragmatic, observant man" — a name, a
  // linking verb, and a word for a human. Writers who avoid pronouns and
  // repeat the name still write this shape.
  const calledAPerson = /\b(is|was|are|were)\b[^.!?]{0,80}\b(man|woman|boy|girl|person|guy|lady|kid|teenager|student|teacher|hero|villain|figure)\b/.test(body);

  // A name used over and over as the subject is itself the signal.
  const subject = String(entry.title || (entry.keys || [])[0] || '').toLowerCase().trim();
  const namedOften = subject.length > 2
    && (body.match(new RegExp(`\\b${subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')) || []).length >= 2;

  if (personHits >= 3
      || (looksLikeName && personHits >= 2)
      || (pronounRate >= 0.02 && pronouns >= 3 && aboutAPerson)
      || (looksLikeName && pronounRate >= 0.015 && pronouns >= 2)
      || (calledAPerson && (looksLikeName || namedOften))) {
    const strong = personHits >= 4 || pronounRate >= 0.04 || calledAPerson;
    return { kind: 'character', confidence: strong ? 0.85 : 0.6, because: 'It describes a person.' };
  }

  // --- a group

  if (has(text, ['family', 'clan', 'agency', 'gang', 'syndicate', 'organisation', 'organization', 'guild', 'academy', 'the league', 'faction'])
      && countMatches(text, ['members', 'led by', 'leader', 'run by', 'controls', 'operates']) >= 1) {
    return { kind: 'faction', confidence: 0.65, because: 'It describes a group of people.' };
  }

  // --- a place

  if (has(text, ['located', 'building', 'street', 'district', 'city', 'town', 'room', 'bar', 'club',
    'apartment', 'house', 'campus', 'school', 'dorm', 'floor', 'entrance', 'inside', 'outside'])
      && countMatches(text, ['located', 'smells', 'lit by', 'walls', 'windows', 'door', 'ceiling', 'quiet', 'loud']) >= 1) {
    return { kind: 'place', confidence: 0.6, because: 'It describes somewhere.' };
  }

  // --- how the world works

  if (has(text, ['society', 'law', 'illegal', 'licence', 'license', 'government', 'population',
    'system', 'technology', 'magic', 'everyone', 'anyone who'])) {
    return { kind: 'rule', confidence: 0.5, because: 'It describes how this world works generally.' };
  }

  // --- something that happened

  if (has(text, ['years ago', 'months ago', 'when they were', 'after the', 'during the', 'the night', 'happened'])) {
    return { kind: 'premise', confidence: 0.5, because: 'It describes history or motivation.' };
  }

  if (keys.length && keys.every((k) => k.split(/\s+/).length <= 2)) {
    return { kind: 'note', confidence: 0.3, because: 'Not obviously any one thing.' };
  }

  return { kind: 'note', confidence: 0.2, because: 'Not obviously any one thing.' };
}

// ---------------------------------------------------------------------------
// Turning a pasted block of text into an entry.
//
// The complaint this solves: you have a paragraph about a character and you
// do not want to fill in six boxes before you can save it.

const STOP = new Set(`the a an and or but of in on at to for with from by is are was were be been
being he she it they them his her their its this that these those as if then than so not no yes
have has had do does did will would can could should may might must i you we what when where who
whom which why how all any both each few more most other some such only own same too very just
about after before during over under again further once here there when while because until`.split(/\s+/));

/**
 * Read a pasted block and fill in what can be worked out.
 * Nothing is guessed silently — every field comes back with a reason.
 */
export function parsePasted(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) return null;

  const lines = text.split('\n');
  let title = '';
  let body = text;

  // A heading, a bold line, or a short first line followed by a blank one.
  const firstReal = lines.find((l) => l.trim());
  const idx = lines.indexOf(firstReal);
  const cleaned = String(firstReal || '').replace(/^#+\s*/, '').replace(/^\*\*(.+)\*\*$/, '$1').trim();
  const isHeading = /^#+\s/.test(firstReal || '')
    || /^\*\*.+\*\*$/.test((firstReal || '').trim())
    || (cleaned.length <= 60 && !/[.!?]$/.test(cleaned) && (lines[idx + 1] || '').trim() === '');

  if (isHeading && cleaned) {
    title = cleaned;
    body = lines.slice(idx + 1).join('\n').trim();
    // A single short line is a name AND the whole of what we know. Keep it
    // as content too, or the entry saves with nothing in it.
    if (!body) body = text;
  } else {
    // "Name, 17, Class 1-A." — take the part before the first comma or full stop.
    const head = cleaned.split(/[,.:—–-]/)[0].trim();
    title = head.length >= 2 && head.length <= 48 ? head : cleaned.slice(0, 48);
  }

  // Trigger words: capitalised terms that recur, plus the title's own words.
  const proper = new Map();
  // Spaces and tabs only. A plain \s here runs names together across a line
  // break and produces triggers that can never match anything.
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])(\p{Lu}\p{Ll}+(?:[ \t]+\p{Lu}\p{Ll}+){0,2})(?![\p{L}\p{N}])/gu)) {
    let term = m[1].trim().replace(/[ \t]+/g, ' ');
    // "The Black Lotus" should trigger on "Black Lotus", never on "The".
    term = term.replace(/^(the|a|an) /i, '');
    if (!term || term.length < 2) continue;
    if (term.split(' ').every((w) => STOP.has(w.toLowerCase()))) continue;
    proper.set(term, (proper.get(term) || 0) + 1);
  }

  const seen = new Set();
  const keys = [];
  const add = (k) => {
    const clean = String(k).replace(/\s+/g, ' ').trim();
    const lower = clean.toLowerCase();
    if (!clean || clean.length < 2 || seen.has(lower) || STOP.has(lower)) return;
    if (keys.length >= 10) return;
    seen.add(lower);
    keys.push(clean);
  };
  // A short title is a good trigger. A long one is not, and neither are its
  // individual words: "Speech" from "Bakugo — Speech Style" would fire the
  // entry on any speech at all.
  if (title && title.split(/\s+/).length <= 3) add(title);
  for (const [k] of [...proper.entries()].sort((a, b) => b[1] - a[1])) add(k);

  const draft = { title, content: body, keys };
  const guess = classifyEntry(draft);

  // A one-line summary for the card face.
  const firstSentence = body.split(/(?<=[.!?])\s/)[0] || body;

  return {
    ...draft,
    kind: guess.kind,
    summary: firstSentence.slice(0, 180),
    notes: [
      title ? `Title taken from the ${isHeading ? 'heading' : 'first line'}.` : 'No title found — give it one.',
      keys.length ? `${keys.length} trigger word${keys.length === 1 ? '' : 's'} suggested from names in the text.` : 'No trigger words found — add some, or make it always-on.',
      `Looks like a ${KINDS[guess.kind].label.toLowerCase()}. ${guess.because}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Priority, in words rather than numbers.

export const WEIGHTS = [
  { name: 'Minor', order: 20, hint: 'Flavour. First to be dropped when space runs short.' },
  { name: 'Supplementary', order: 50, hint: 'Useful background.' },
  { name: 'Standard', order: 100, hint: 'Most things belong here.' },
  { name: 'Important', order: 150, hint: 'Gets in ahead of ordinary lore.' },
  { name: 'Critical', order: 200, hint: 'Never dropped while there is any room at all.' },
];

export const weightFor = (order) =>
  WEIGHTS.reduce((best, w) => (Math.abs(w.order - order) < Math.abs(best.order - order) ? w : best), WEIGHTS[2]);
