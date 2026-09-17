// Reading evidence out of legacy text, deterministically.
//
// Everything here is plain string work: sentences, capitalised names, word
// lists and overlaps. No model, no embeddings, nothing that could answer
// differently tomorrow. Each helper returns what it saw, so every proposal
// built on top of it can say exactly why.

// ------------------------------------------------------------------ words

const WEEKDAYS_MONTHS = new Set(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);

/** Words that are capitalised for grammar or emphasis, never names on their own. */
const NOT_NAMES = new Set([
  'I', 'He', 'She', 'They', 'It', 'We', 'You', 'His', 'Her', 'Hers', 'Their', 'Its', 'Our', 'My', 'Your', 'Him', 'Them', 'Me', 'Us',
  'The', 'A', 'An', 'This', 'That', 'These', 'Those', 'There', 'Here', 'When', 'Where', 'Why', 'How', 'What', 'Who', 'Which', 'While',
  'After', 'Before', 'Once', 'If', 'But', 'And', 'Or', 'So', 'Not', 'No', 'Never', 'Do', 'Does', 'Did', 'Every', 'Each', 'Some', 'One',
  'Still', 'Also', 'Only', 'Even', 'Just', 'Then', 'Now', 'As', 'At', 'In', 'On', 'Of', 'For', 'With', 'From', 'To', 'By', 'Into', 'Over',
  'Under', 'Behind', 'Inside', 'Outside', 'Until', 'Unless', 'Because', 'Although', 'Though', 'Yet', 'All', 'Most', 'Many', 'Few',
  'Other', 'Others', 'Any', 'Both', 'Either', 'Neither', 'Let', 'Keep', 'Allow', 'Track', 'Maintain', 'Prioritize', 'Prioritise',
  'Ground', 'Stay', 'Call', 'Write', 'Describe', 'Avoid', 'Use', 'Show', 'Treat', 'Remember', 'Make', 'Give', 'Reach', 'Ensure',
  'Yes', 'Maybe', 'Perhaps', 'Sometimes', 'Often', 'Always', 'Later', 'Earlier', 'Today', 'Tonight', 'Tomorrow', 'Yesterday',
  'Once', 'Twice', 'First', 'Second', 'Third', 'Last', 'Next', 'New', 'Old', 'People', 'Characters', 'Character', 'Someone',
  ...WEEKDAYS_MONTHS,
]);

const HONORIFICS = new Set(['Don', 'Donna', 'Mr', 'Mrs', 'Ms', 'Miss', 'Dr', 'Doctor', 'Lord', 'Lady', 'Sir', 'Dame', 'Captain', 'Madam', 'Master', 'Professor', 'Father', 'Sister', 'Uncle', 'Aunt']);
const CONNECTORS = new Set(['of', 'de', 'da', 'di', 'del', 'van', 'von', 'la', 'le']);
const SHOUTS = /^(RULE|RULES|HIDDEN|PHASE|DISABLED|ONLY|NOTE|IMPORTANT|WARNING|OOC|NSFW|AND|OR|NOT|DO|NEVER|ALWAYS|THE|A)$/;

export const PLACEHOLDER = /\{\{\s*(user|char)\s*\}\}/gi;

/** Sentences of a text, placeholders kept, whitespace flattened. */
export function sentences(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
    .split(/(?<=[.!?])\s+(?=["“'‘(]?[A-Z0-9{])|\s+[—–]\s+(?=[A-Z])/)
    .map((s) => s.trim()).filter(Boolean);
}

export const normalize = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[’']s\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '');

export const tokens = (s) => normalize(s).split(' ').filter((w) => w.length > 2);

/** Overlap of two word sets, 0..1. */
export function jaccard(a, b) {
  const A = new Set(a); const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
}

/** Whole-word, case-insensitive occurrence count. */
export function countPhrase(text, phrase) {
  if (!phrase) return 0;
  const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return (String(text || '').match(new RegExp(`(^|[^\\p{L}\\p{N}])${esc}(?=$|[^\\p{L}\\p{N}])`, 'giu')) || []).length;
}

// ------------------------------------------------------------------ names

/**
 * Capitalised name-like runs in a text.
 *
 * A run starting a sentence might just be grammar, so each is marked
 * `midSentence` or not; a word that only ever appears capitalised at the
 * start of sentences is weak evidence of a name. Possessives are noted and
 * stripped: "Jane's" is a mention of Jane.
 *
 * @returns {{ name: string, midSentence: boolean, possessive: boolean, sentence: number, atStart: boolean }[]}
 */
export function nameRuns(text) {
  const out = [];
  sentences(String(text || '').replace(PLACEHOLDER, 'SOMEONE')).forEach((sentence, si) => {
    const words = sentence.split(/\s+/);
    let run = [];
    let runStart = -1;
    let possessive = false;
    const flush = (endIndex) => {
      while (run.length && (CONNECTORS.has(run[run.length - 1]) || run[run.length - 1] === 'The')) run.pop();
      while (run.length && NOT_NAMES.has(run[0]) && !(run[0] === 'The' && run.length > 1)) { run.shift(); runStart++; }
      if (run.length && !(run.length === 1 && (HONORIFICS.has(run[0]) || run[0] === 'The'))) {
        const name = run.join(' ');
        if (!(run.length === 1 && NOT_NAMES.has(run[0]))) {
          out.push({ name, midSentence: runStart > 0, atStart: runStart === 0, possessive, sentence: si });
        }
      }
      run = []; runStart = -1; possessive = false;
      void endIndex;
    };
    words.forEach((raw, wi) => {
      const lead = raw.replace(/^["“'‘(\[]+/, '');
      const poss = /[’']s[,.;:!?)"”]*$/.test(lead);
      const word = lead.replace(/[’']s[,.;:!?)"”]*$/, '').replace(/[,.;:!?)"”\]]+$/, '');
      const endsClause = /[,.;:!?)"”\]]$/.test(lead) || poss;
      const isCap = /^[A-Z][\p{L}'’-]*$/u.test(word) && !SHOUTS.test(word) && word !== 'SOMEONE';
      const isNumber = /^\d{3,4}$/.test(word) && run.length > 0;
      const isConnector = CONNECTORS.has(word) && run.length > 0;
      const isThe = word === 'The' && run.length === 0;
      if (isCap || isNumber || isConnector || isThe) {
        if (!run.length) runStart = wi;
        run.push(word);
        if (poss) possessive = true;
        if (endsClause) flush(wi);
      } else if (run.length) flush(wi);
    });
    if (run.length) flush(words.length);
  });
  return out;
}

/** Keys that look like proper names: capitalised words, not a shout, no placeholder. */
export const capitalisedKeys = (keys) => (keys || []).filter((k) => /^[A-Z][\p{L}'’-]*(\s+[A-Z0-9][\p{L}\p{N}'’-]*)*$/u.test(String(k).trim()) && !PLACEHOLDER.test(k) && !SHOUTS.test(k));

// ------------------------------------------------------------------ titles

/**
 * A legacy title with its phase and status wrapping taken off.
 *
 *   "Penthouse (DISABLED — late story)"  → name "Penthouse", phase "late story"
 *   "DISABLED — late story home"          → name "",          phase "late story home"
 *   "Knowledge Boundary (RULE)"          → name "Knowledge Boundary", marker "RULE"
 */
export function cleanTitle(title) {
  let t = String(title || '').trim();
  let phase = null;
  const markers = [];
  const paren = t.match(/\s*\(([^)]*(DISABLED|PHASE|RULE|HIDDEN)[^)]*)\)\s*$/i);
  if (paren) { phase = /RULE/i.test(paren[1]) && !/DISABLED|PHASE/i.test(paren[1]) ? null : paren[1].trim(); if (/RULE/i.test(paren[1])) markers.push('RULE'); t = t.slice(0, paren.index).trim(); }
  const lead = t.match(/^(DISABLED(?:\s+until\s+[^—–-]+)?)\s*[—–-]\s*(.*)$/i);
  if (lead) { phase = `${lead[1]} — ${lead[2]}`.trim(); t = ''; }
  if (/\bRULE\b/.test(t)) { markers.push('RULE'); t = t.replace(/\bRULE\b/, '').trim(); }
  return { name: t, phase, markers };
}

// ------------------------------------------------------------------ lexicons

/** Words in a name that say what kind of thing it is. */
export const TYPE_WORDS = {
  faction: ['family', 'organization', 'organisation', 'clan', 'gang', 'syndicate', 'cartel', 'guild', 'crew', 'brotherhood', 'sisterhood', 'cult', 'league', 'alliance', 'council', 'agency', 'legion', 'mafia', 'outfit', 'society', 'union', 'network', 'group', 'order', 'company', 'corporation', 'triad', 'yakuza', 'house of'],
  // Specific enough to name one place. "City" or "World" is a setting, not an entity.
  place: ['penthouse', 'safehouse', 'nightclub', 'club', 'bar', 'apartment', 'room', 'armory', 'armoury', 'warehouse', 'station', 'market', 'restaurant', 'hotel', 'tower', 'castle', 'palace', 'temple', 'church', 'academy', 'school', 'hospital', 'estate', 'manor', 'mansion', 'office', 'precinct', 'dock', 'docks', 'harbour', 'harbor', 'lounge', 'library', 'basement', 'garden', 'vault', 'territory', 'district', 'street', 'café', 'cafe', 'shop', 'studio', 'bunker', 'lair', 'base', 'headquarters',
    // Ordinary words for a place that were simply missing, so an entry saying
    // "X is a village" found no type at all and described nobody.
    'village', 'town', 'city', 'inn', 'tavern', 'quay', 'bridge', 'farm', 'camp', 'prison', 'alley', 'tunnel', 'cellar', 'attic', 'rooftop'],
  item: ['pistol', 'revolver', 'gun', 'rifle', 'knife', 'blade', 'sword', 'ring', 'necklace', 'amulet', 'locket', 'phone', 'burner', 'bouquet', 'key', 'badge', 'mask'],
  event: ['war', 'battle', 'massacre', 'festival', 'wedding', 'summit', 'heist', 'betrayal', 'leak', 'reunion', 'sighting', 'revelation', 'incident', 'attack', 'raid'],
};

/** Content that describes a kind of thing. */
export const TYPE_LANGUAGE = {
  person: [/\b(he|she)\s+(is|was|has|had|does|never|always|wants|prefers|keeps|owns|handles)\b/i, /\b\d{2},\s/, /\byears? old\b/i, /\b(man|woman|boy|girl|boss|fixer|capo|enforcer|mentor|friend|guard|owner|leader|killer)\b/i],
  place: [/\b(nightclub|club|apartment|residence|building|district|room|floor|windows?|elevators?|neutral ground|located|high above|kitchen|library|premises|venue|warehouse|headquarters)\b/i],
  faction: [/\bled by\b/i, /\b(members?|organi[sz]ation|criminal power|hierarchy|territor(y|ial)|expansion|rival family|syndicate|alliances?)\b/i],
  item: [/\b(pistol|revolver|gun|rifle|weapon|blade|knife|sword|ring|necklace|plated|engraved|carries|kept apart)\b/i],
  event: [/\b(escalat\w*|conflict|war|attack|battle|happened|took place|broke out)\b/i],
};

/** Title and content words for each category of knowledge about someone. */
export const PERSON_LEXICON = {
  identity: ['identity', 'core', 'reputation', 'overview', 'profile', 'who is', 'alias', 'underworld name', 'known as', 'called'],
  appearance: ['appearance', 'looks', 'scar', 'hair', 'eyes', 'tall', 'height', 'build', 'wears', 'tattoo', 'face', 'broad-shouldered', 'cm'],
  personality: ['personality', 'temperament', 'traits', 'charismatic', 'stubborn', 'witty', 'confident', 'observant', 'composed'],
  speech: ['communicat', 'speaks', 'speech', 'voice', 'texts', 'calls', 'messages', 'tone', 'talks', 'dialogue', 'says'],
  behavior: ['behavio', 'conduct', 'register', 'manner', 'acts', 'cooks', 'handles'],
  backstory: ['childhood', 'backstory', 'history', 'foster', 'detention', 'juvenile', 'recruit', 'grew up', 'origin', 'orphan', 'as a child', 'first time', 'years ago', 'years later', 'took him in', 'took her in', 'arc'],
  psychology: ['fear', 'wound', 'trauma', 'abandonment', 'attachment', 'insecur', 'psycholog', 'internaliz', 'internalis', 'nightmare', 'shame', 'guilt', 'autonomy', 'compartmentaliz'],
  relationship: ['love', 'relationship', 'bond', 'devotion', 'romance', 'intimacy', 'affection', 'lover', 'partner', 'boyfriend', 'girlfriend'],
  secret: ['secret', 'hidden', 'nobody knows', 'no one knows', 'conceal'],
  goal: ['goal', 'wants to', 'plan', 'ambition', 'escape', 'retirement', 'exit', 'dream'],
  skill: ['skill', 'marksmanship', 'trained', 'training', 'expert', 'proficient'],
  // What a person can do that ordinary people cannot, whatever the universe
  // calls it. The universe's own word — Quirk, Magic, Cybernetics, bloodline —
  // is a display group, never a category: see Package v1 §"Category vs
  // displayPath". So this list is what those words mean, and stays generic.
  ability: ['ability', 'abilities', 'power', 'powers', 'quirk', 'magic', 'spell', 'spells', 'supernatural',
    'cybernetic', 'cyberware', 'implant', 'augment', 'transformation', 'transform', 'bloodline', 'clan',
    'mutation', 'gift', 'curse', 'domain', 'technique', 'manifest', 'awaken', 'range', 'limitation',
    'limitations', 'cost', 'costs', 'drawback', 'recharge', 'cooldown', 'mastery', 'combat style', 'fighting style'],
  equipment: ['weapon', 'gear', 'equipment', 'carries'],
  // What somebody holds to be right. Values live here with beliefs: telling
  // them apart would need a category Nexus does not have (see the note on
  // habit, below).
  belief: ['believes', 'belief', 'principle', 'principles', 'code of', 'faith', 'ethic', 'ethics', 'moral',
    'morals', 'value', 'values', 'conviction', 'creed', 'honour', 'honor', 'loyalty', 'stands for',
    'will not compromise', 'refuses to'],
  // What somebody does by habit, and what they like. Preferences live here
  // rather than in a `preference` category of their own: adding a category
  // would widen the enumerated list Package v1 froze, which is a decision for
  // the person who froze it, not a side effect of a lexicon fix.
  habit: ['every monday', 'every week', 'habit', 'habits', 'ritual', 'routine', 'always carries',
    'prefers', 'prefer', 'preference', 'preferences', 'likes', 'dislikes', 'favourite', 'favorite',
    'taste', 'tastes', 'enjoys', 'hates', 'cannot stand', 'drinks', 'smokes', 'eats', 'sleeps'],
};

export const WORLD_LEXICON = {
  event: ['threat', 'war', 'escalat', 'attack', 'conflict', 'campaign matures', 'pressure', 'betrayal', 'summit'],
  rule: ['forbidden', 'rules', 'law', 'must not', 'is not allowed', 'neutral'],
  reference: ['describes', 'guide', 'guidelines', 'instructions for', 'technique', 'position', 'how to', 'step', 'safe techniques'],
  item: ['weapon', 'device', 'object', 'artifact', 'artefact'],
};

/** Verbs that open an instruction. */
export const IMPERATIVES = /^(never|do not|don't|always|keep|let|track|maintain|prioriti[sz]e|ground|allow|call back|stay|describe|write|narrate|avoid|make|use|show|reach|treat|remember|respect|ensure|give|infer|portray|focus|include|emphasi[sz]e|end|begin|start|vary|depict|reflect|match|mirror|not every|you are|you must|you should)\b/i;
/** Language about the telling rather than the told. */
export const NARRATION = /\b(a character|characters|the character|a hurt character|the scene|scenes|every beat|beat|narrat\w*|in character|roleplay|immersion|continuity|the model|dialogue|prose|reply|replies|response|{{user}}|{{char}}|the story|the world is|background figures)\b/i;

/**
 * A sentence that tells the telling what to do.
 *
 * "never", "must" and "do not" are ordinary words in ordinary prose — "she has
 * never told him", "he must have wondered why", "she does not know" — and
 * finding one anywhere in a sentence says nothing. A direction has structure:
 * it either opens as a command, or it says who must do what, and that someone is
 * the model, the reader, or characters in general rather than a person in the
 * story.
 *
 * Deliberately narrow. A missed direction is one entry filed as a fact, which
 * review can correct; a false one takes somebody's psychology and files it as an
 * instruction to the narrator, which reads as Nexus not understanding the story.
 */

/** Who a direction can be aimed at: the telling, never a person in it. */
const ADDRESSEE = String.raw`(?:you|your|the model|the ai|the narrator|the writer|the response|the reply|the prose|the narration|the scene|the story|scenes|characters|npcs|dialogue|\{\{user\}\}|\{\{char\}\}|nexus)`;
/** What it tells them to do. An imperative verb, not "have" or "be". */
const DIRECTED = String.raw`(?:reveal|narrate|write|describe|mention|speak|act|break|use|allow|let|refer|say|state|answer|reply|respond|address|assume|decide|control|voice|play|invent|add|skip|repeat|summari[sz]e|explain|end|begin|start|include|exclude|show|tell|treat|track|keep|maintain|stay|avoid|react|respond|remember|follow|obey|ignore|portray|depict|reflect|match|mirror|ground|prioriti[sz]e|emphasi[sz]e|vary|call)`;

const DIRECTIVE_PATTERNS = [
  // An imperative opening: "Never reveal…", "Do not narrate…", "Always keep…"
  new RegExp(String.raw`^(?:never|do not|don'?t|always|please)\s+${DIRECTED}\b`, 'i'),
  // A bare imperative opening: "Keep replies short.", "Narrate only what…"
  new RegExp(String.raw`^${DIRECTED}\b`, 'i'),
  // Someone in the telling is told what to do: "Characters must react…",
  // "You should never…", "The model may not…"
  new RegExp(String.raw`\b${ADDRESSEE}\s+(?:must|should|shall|may not|cannot|can't|must never|should never|will|are to|is to|needs? to|has to|have to)\s+(?:not\s+|never\s+)?${DIRECTED}\b`, 'i'),
  // "…must be earned", "…should be avoided": a rule about the telling, in the
  // passive, with the telling as its subject.
  new RegExp(String.raw`\b${ADDRESSEE}\s+(?:must|should|shall|may not|cannot)\s+(?:not\s+|never\s+)?be\b`, 'i'),
  // An explicit second-person command anywhere: "you must never break character"
  /\byou (?:must|should|shall|may) (?:not |never )?\w+/i,
];

/**
 * Whether one sentence is a direction to the telling.
 *
 * Checked against the sentence with any leading marker stripped, so
 * "— Never reveal the secret" reads as the command it is.
 */
export function directiveSentence(s) {
  const t = String(s || '').replace(/^[^A-Za-z{]+/, '').trim();
  if (!t) return false;
  // A person in the story doing something is not a direction, however the
  // sentence is worded: "he must have wondered", "she has never told him".
  if (/\b(?:must|should|would|might|may|could) have\b/i.test(t)) return false;
  return DIRECTIVE_PATTERNS.some((re) => re.test(t));
}
/** Words that tie two entities together. */
export const RELATIONSHIP_LANGUAGE = /\b(led by|leads|owned by|owns|owner|works for|member of|operates inside|serves|mentor|took (him|her) in|trusted|trusts|loyal|rival|friend|enemy|partner|boss|capo|father|mother|brother|sister|wife|husband|lover|son|daughter|family|gave|given|betray\w*|killed|protects|employs|hired|men|associates?|allied|married|raised)\b/i;

/**
 * A life told as history: an age, or a time long past, with something that happened.
 * General enough for any character's backstory, and tied to no particular one.
 */
export const LIFE_HISTORY = {
  age: /\b(at |aged |when (he|she|they) (was|were) )?(five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(-\w+)?|thirty|forty|\d{1,2})\b/i,
  past: /\b(was|were|had|did|took|gave|given|learned|left|died|grew|moved|met|started|became|lost|found|believed|spent)\b/i,
  phrases: /\b(was born|grew up|as a (child|boy|girl)|years (ago|later)|back then|used to be|before (that|then)|first deliberate|for the first time)\b/i,
};
/** Told as a life: an age with something that happened, or a phrase about the past. */
export const readsAsHistory = (text) => LIFE_HISTORY.phrases.test(text) || (LIFE_HISTORY.age.test(text) && LIFE_HISTORY.past.test(text));
