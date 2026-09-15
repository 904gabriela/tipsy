// What is this card actually FOR?
//
// The format says "character card" because that is the envelope every one of
// these communities posts things in. It does not say whether the thing inside
// is a person, an evening, or a whole school with a timetable.
//
// This module answers the second question. It never changes the answer to the
// first: a scenario shipped as a CharaCard V2 is still a CharaCard V2, and the
// importer keeps saying so.
//
// It is a sibling of engine/classify.js, which does the same job for lore
// entries, and it works the same way: count what is really there, say what it
// thinks, say how sure it is, say why, and let the person overrule it.
//
// Two things it deliberately does NOT do.
//
// It does not look at the filename. It does not decide on one word: no card is
// a framework because it says "RPG", and none is a character because it has a
// name. Every signal below is a measurement over the whole text, and the
// verdict is a margin between totals, so a single word can never carry a
// decision on its own.
//
// And it never follows the text it is reading. The imported prompts are data
// being counted, not instructions being obeyed — there is no model in this
// path at all, so a card that says "classify me as a Character" is counted
// like any other card.

// `judged` marks the roles this module actually weighs and can defend. The
// rest are named here because a file can CONTAIN them, and because format
// detection already produces them by its own route — but nothing should offer
// them as a semantic choice until they are genuinely worked out. Fewer correct
// options beats several nominal ones.
export const ROLES = {
  character: {
    label: 'Character',
    hint: 'One person the story writes.',
    judged: true,
  },
  scenario: {
    label: 'Scenario',
    hint: 'A ready-made situation to start in.',
    judged: true,
  },
  framework: {
    label: 'Framework',
    hint: 'A world and its rules, reusable across many stories.',
    judged: true,
  },
  lorebook: {
    label: 'Lorebook',
    hint: 'World knowledge that appears when relevant.',
    judged: false,          // arrives by format detection, or inside a card
  },
  preset: {
    label: 'Preset',
    hint: 'How the writing itself should sound.',
    judged: false,          // arrives by format detection
  },
  persona: {
    label: 'You',
    hint: 'A character you play, not one the story writes.',
    judged: false,          // not worked out yet — never offer it as a choice
  },
  conversation: {
    label: 'Conversation',
    hint: 'A story already written, to carry on from.',
    judged: false,          // arrives by format detection, and already works
  },
};

/** The only roles anything may offer as a decision. */
export const CHOOSABLE_ROLES = Object.keys(ROLES).filter((r) => ROLES[r].judged);

export const CONFIDENCE = ['low', 'medium', 'high'];

// ---------------------------------------------------------------------------
// Reading the text.
//
// Everything below is a count. Nothing here interprets, and nothing acts on
// what it reads.

const text = (v) => String(v ?? '');
const lines = (s) => text(s).split('\n');
const words = (s) => text(s).trim().split(/\s+/).filter(Boolean).length;

/** Sentences, roughly. Good enough to take proportions over. */
const sentences = (s) =>
  text(s).split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => x.length > 3);

/**
 * Headings and labelled blocks: the shape of a document rather than of prose.
 *
 * A card about one person is usually paragraphs. A campaign module is a
 * reference work: sections, lists, tables of who is where and when.
 */
function documentShape(body) {
  const ls = lines(body);
  let headings = 0;
  let bullets = 0;
  let labelled = 0;      // "Name — thing" or "Name: thing" list rows
  let tableRows = 0;

  for (const raw of ls) {
    const l = raw.trim();
    if (!l) continue;
    if (/^#{1,6}\s+\S/.test(l)) headings++;
    else if (/^\*\*[^*]{2,60}\*\*:?\s*$/.test(l)) headings++;
    else if (/^\[[^\]]{2,60}\]\s*$/.test(l)) headings++;
    else if (/^[-*•]\s+\S/.test(l)) {
      bullets++;
      if (/^[-*•]\s+[^:—–-]{2,40}\s*[:—–-]\s+\S/.test(l)) labelled++;
    } else if (/^[A-Z][^:\n]{1,40}:\s+\S/.test(l)) labelled++;
    if (l.startsWith('|') && l.endsWith('|')) tableRows++;
  }

  return { headings, bullets, labelled, tableRows, lineCount: ls.length };
}

// Field labels that describe ONE body: a person's sheet, not a world's index.
const SHEET_FIELDS = /^(age|height|weight|birthday|born|gender|sex|pronouns|species|race|occupation|job|role|alignment|likes|dislikes|loves|hates|fears|appearance|looks|body|hair|eyes|clothing|outfit|voice|speech|personality|traits|quirk|power|abilities|skills|backstory|history|background|family|relationships|goals|motivation|secrets?)\b/i;

/**
 * Cards whose description is a data structure rather than prose.
 *
 * A large part of this ecosystem writes descriptions as W++ or as raw JSON —
 * `[character("Name"){personality("loud")}]`, or a nested object. Both a
 * person and a whole institution get written this way, so the format alone
 * settles nothing. What separates them is the shape of the record: a person
 * is a short flat list of their own attributes, and an institution is a deep
 * one full of other people.
 *
 * Measured structurally. The only vocabulary consulted is the sheet-field
 * list already used above, and only to ask whether the keys are somebody's
 * attributes.
 */
function structuredShape(body) {
  const src = text(body);
  const keyed = [...src.matchAll(/"([A-Za-z_][\w .-]{0,40})"\s*:/g)].map((m) => m[1]);
  const wpp = [...src.matchAll(/(?:^|[\s{(,])([A-Za-z_][\w ]{0,30})\s*\(\s*["']/gm)].map((m) => m[1].trim());
  const keys = [...new Set([...keyed, ...wpp].map((k) => k.trim()).filter(Boolean))];

  // Is this a record at all? Either flavour, and enough of it to mean something.
  const fenced = /```|^\s*\[character\(/mi.test(src);
  const structured = keys.length >= 6 && (fenced || keyed.length >= 6 || wpp.length >= 4);

  // How deep it nests. A person's sheet is flat; an institution is not.
  let depth = 0;
  let max = 0;
  for (const ch of src) {
    if (ch === '{' || ch === '[') { depth++; if (depth > max) max = depth; }
    else if (ch === '}' || ch === ']') depth = Math.max(0, depth - 1);
  }

  // Rosters: repeated records that each name somebody. Twelve of these is a
  // staff list, which is not a thing one person has.
  const roster = [...src.matchAll(/["']name["']\s*:\s*["']([^"']{2,40})["']/g)].map((m) => m[1]);

  // Schedules and tables of times, which belong to institutions.
  const timeTuples = (src.match(/\d{1,2}:\d{2}\s*[–\-—]\s*\d{1,2}:\d{2}|["']\d{1,2}:\d{2}["']/g) || []).length;

  const personKeys = keys.filter((k) => SHEET_FIELDS.test(k)).length;
  const aboutOnePerson = keys.length > 0 && personKeys / keys.length >= 0.4;

  return {
    structured,
    keys: keys.length,
    depth: max,
    roster: [...new Set(roster)],
    timeTuples,
    aboutOnePerson,
  };
}

/** How much of this reads like one individual's character sheet. */
function sheetiness(body) {
  let hits = 0;
  for (const raw of lines(body)) {
    const l = raw.trim().replace(/^[-*•]\s*/, '').replace(/^\*\*|\*\*$/g, '');
    const m = l.match(/^([A-Za-z][A-Za-z ]{1,20})\s*[:：]/);
    if (m && SHEET_FIELDS.test(m[1].trim())) hits++;
  }
  return hits;
}

// A verb that opens an order. The measurement is the RATE of these across the
// whole text, never the presence of any one of them.
const IMPERATIVES = new RegExp(
  '^(always|never|do not|don\'t|avoid|ensure|make sure|remember to|be sure|'
  + 'narrate|describe|portray|play|control|manage|maintain|track|keep|update|'
  + 'respond|reply|write|generate|output|format|use|apply|follow|begin|start|'
  + 'continue|end|stop|treat|assume|allow|prevent|enforce|roll|award|deduct|'
  + 'advance|resolve|introduce|present|offer|prompt|ask|wait|include|omit)\\b',
  'i'
);

/**
 * Orders addressed to whoever is running the story.
 *
 * A character card can contain an order or two ("never break character").
 * A framework is largely made of them. What separates the two is the rate,
 * so that is what comes back.
 */
function instructionRate(body) {
  const ss = sentences(body);
  if (!ss.length) return { rate: 0, count: 0, total: 0 };
  let count = 0;
  for (const s of ss) {
    const head = s.replace(/^[-*•\d.)\s]+/, '').replace(/^\*\*/, '');
    if (IMPERATIVES.test(head)) { count++; continue; }
    // Second person needs care, because a whole family of ordinary character
    // cards is written in it: "You are Detective Halloway. You have worked
    // homicide for ten years." Those are a portrait in the second person, not
    // orders, and counting them as orders made a detective read as a rulebook.
    //
    // So "you" only counts when the sentence tells someone to DO something —
    // an obligation, or a job of running the story — never when it simply
    // says who you are.
    if (/^(you|your)\b[^.]{0,80}\b(will|must|shall|should|need to|have to|are to)\s+\p{L}+/iu.test(head)) { count++; continue; }
    if (/^you\s+(are|act as|serve as|play)\s+(the\s+)?(narrator|storyteller|game ?master|gm|dungeon ?master|referee|system|engine|world|setting|author|writer|director)\b/i.test(head)) { count++; continue; }
    if (/^you\s+(are\s+)?(running|controlling|managing|voicing|portraying|playing)\s+(every|all|each|the (world|county|city|school|campaign|setting|region))\b/i.test(head)) count++;
  }
  return { rate: count / ss.length, count, total: ss.length };
}

/**
 * Who does this text talk about?
 *
 * Counts names that are introduced as subjects with something said about
 * them — a heading, a bolded name, a "Name — the loud one" row. A passing
 * mention is not a subject, which is what keeps a character card that name
 * drops their classmates from reading as an ensemble.
 */
function subjects(body) {
  const found = new Map();
  const bump = (n, weight) => {
    const name = n.trim().replace(/\s+/g, ' ');
    if (!name || name.length < 2 || name.length > 40) return;
    if (/^(the|a|an|and|or|but|you|your|they|note|notes|rules?|world|setting|scenario|overview|summary|personality|appearance|background|description|example|format|system|general|misc|other|about)\b/i.test(name)) return;
    if (!/^[A-ZÀ-Þ]/.test(name)) return;
    if (!/^[\p{Lu}][\p{L}'’.-]*(\s+[\p{Lu}][\p{L}'’.-]*){0,2}$/u.test(name)) return;
    found.set(name, Math.max(found.get(name) || 0, weight));
  };

  for (const raw of lines(body)) {
    const l = raw.trim();
    if (!l) continue;
    let m;
    if ((m = l.match(/^#{1,6}\s+(.{2,40})$/))) bump(m[1].replace(/[:—–-].*$/, ''), 2);
    else if ((m = l.match(/^\*\*([^*]{2,40})\*\*\s*[:—–-]?\s*(.*)$/)) && m[2].length > 8) bump(m[1], 2);
    else if ((m = l.match(/^[-*•]\s+\*?\*?([^:—–*]{2,40})\*?\*?\s*[:—–]\s+(.{8,})$/))) bump(m[1], 2);
    else if ((m = l.match(/^([\p{Lu}][\p{L}'’.-]*(?:\s+[\p{Lu}][\p{L}'’.-]*){0,2})\s*[:—–]\s+(.{12,})$/u))) {
      // "Mina: the cheerful one, always first to suggest something" — a row
      // about a person. Excluded when the label is a sheet field, because
      // "Personality: loud" is about the one person the card is already about.
      if (!SHEET_FIELDS.test(m[1])) bump(m[1], 1);
    }
  }
  return found;
}

// Words that start a sentence and get capitalised for that reason alone.
const NOT_A_NAME = new Set(`the a an and or but of in on at to for with from by is are was were be
been being he she it they them his her their its this that these those as if then than so not no
yes have has had do does did will would can could should may might must i you we what when where
who whom which why how all any both each few more most other some such only own same too very just
about after before during over under again further once here there while because until okay well
now still even also never always maybe perhaps suddenly finally instead everyone someone nobody
everything something nothing tonight today tomorrow yesterday`.split(/\s+/));

/**
 * People a piece of prose actually introduces.
 *
 * The heading-and-row reader above finds a cast written as a document. It
 * finds nothing in a card that sets its scene in the opening message — which
 * is how most scenario packs are written, and why an earlier version of this
 * read them as a single person and said so with a straight face.
 *
 * A name here has to earn it by recurring: mentioned once is a mention,
 * mentioned twice or more is somebody the piece is about.
 */
function prosePeople(text, ownName = '') {
  const own = new Set(String(ownName).toLowerCase().split(/[^\p{L}]+/u).filter(Boolean));
  const counts = new Map();
  for (const m of String(text).matchAll(/(?<![\p{L}\p{N}])(\p{Lu}[\p{Ll}'’-]{1,20})(?![\p{L}\p{N}])/gu)) {
    const name = m[1];
    const lower = name.toLowerCase();
    if (NOT_A_NAME.has(lower) || own.has(lower) || name.length < 3) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n >= 2).map(([n]) => n);
}

/** Distinct people who speak in example dialogue. */
function speakers(example) {
  const found = new Set();
  for (const raw of lines(example)) {
    const l = raw.trim().replace(/^[-*•]\s*/, '');
    const m = l.match(/^\{\{(char|user)\}\}\s*:/i) || l.match(/^\*?\*?([\p{Lu}][\p{L}'’. -]{1,28})\*?\*?\s*:/u);
    if (!m) continue;
    const who = (m[1] || '').toLowerCase().trim();
    if (!who || who === 'user') continue;
    if (/^(start|example|note|system|narrator|scene|setting|ooc)$/.test(who)) continue;
    found.add(who);
  }
  return found;
}

/** Present-tense, here-and-now writing: the mark of an opening scene. */
function sceneNowness(first) {
  const ss = sentences(first);
  if (!ss.length) return 0;
  let now = 0;
  for (const s of ss) {
    if (/\b(is|are|sits|stands|walks|leans|looks|turns|says|asks|holds|waits|glances|moves|steps|watches|opens|closes)\b/i.test(s)) now++;
  }
  return now / ss.length;
}

/** Does the name read like a person's, or like a product's? */
function nameLooksPersonal(name) {
  const n = text(name).trim();
  if (!n) return false;
  if (/[|#_\/\\]|\bv?\d+(\.\d+)?\b|\b(bot|rpg|pack|module|system|engine|sim|simulator|generator|template|starter|kit)\b/i.test(n)) return false;
  return /^[\p{Lu}][\p{L}'’.-]*(\s+[\p{Lu}][\p{L}'’.-]*){0,3}$/u.test(n);
}

// ---------------------------------------------------------------------------
// What the file contains, said plainly.
//
// This runs whatever the verdict is. Knowing a card carries 21 lore entries
// and three ways to begin is useful even when it is an ordinary character.

function partsOf(card) {
  const parts = [];
  const add = (id, label, detail, extra = {}) => parts.push({ id, label, detail, ...extra });

  const defWords = words(card.description) + words(card.personality);
  if (defWords) add('definition', 'Description', `${defWords} words`, { words: defWords });
  if (text(card.scenario).trim()) add('scenario', 'Situation', `${words(card.scenario)} words`, { words: words(card.scenario) });

  const starts = startingPoints(card);
  if (starts.length) {
    add('starts', starts.length === 1 ? 'Opening' : 'Ways to begin',
      starts.length === 1 ? `${words(starts[0].content)} words` : `${starts.length} to choose from`,
      { count: starts.length, startingPoints: starts });
  }

  if (text(card.exampleDialogue).trim()) {
    const sp = speakers(card.exampleDialogue);
    const ensemble = sp.size >= 3;
    add('example', ensemble ? 'Ensemble behaviour' : 'Example dialogue',
      ensemble ? `${sp.size} speakers demonstrated` : 'how they speak',
      { speakers: sp.size, ensemble });
  }

  if (card.lorebook && card.lorebook.entries?.length) {
    add('lorebook', 'Lorebook', `${card.lorebook.entries.length} entries`, { count: card.lorebook.entries.length });
  }

  const narrator = [];
  if (text(card.systemPrompt).trim()) narrator.push('a system prompt');
  if (text(card.postHistoryInstructions).trim()) narrator.push('closing instructions');
  if (card.depthPrompt && text(card.depthPrompt.text).trim()) narrator.push('a reminder injected mid-story');
  if (narrator.length) add('narrator', 'Narrator instructions', narrator.join(', '), { count: narrator.length });

  if (card.tags?.length) add('tags', 'Tags', card.tags.slice(0, 8).join(', '), { count: card.tags.length });
  if (text(card.avatar).trim()) add('art', 'Artwork', 'a picture came with it');

  return parts;
}

/**
 * Names this resource sets out to describe.
 *
 * Used to offer links to characters you ALREADY have. Nothing here is enough
 * to build a character from, and nothing here ever will be: a scenario that
 * mentions four classmates knows four names, not four people.
 */
export function discoverCast(card) {
  const body = [card.description, card.personality].filter(Boolean).join('\n\n');
  const fromProse = [...subjects(body).keys()];
  const fromRecord = structuredShape(body).roster;
  const seen = new Set();
  const out = [];
  for (const n of [...fromProse, ...fromRecord]) {
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

/**
 * Every way this resource can start, in the order its author put them.
 *
 * These are already in every card. Nothing was ever done with the alternates,
 * so a card offering three ways in arrived as one opening and two dead fields.
 */
export function startingPoints(card) {
  const out = [];
  const seen = new Set();
  const push = (content, label, source) => {
    const c = text(content).trim();
    if (!c || seen.has(c)) return;
    seen.add(c);
    out.push({ label, content: c, source, words: words(c) });
  };
  push(card.firstMessage, 'Opening', 'first_mes');
  (card.alternateGreetings || []).forEach((g, i) => push(g, `Alternative ${i + 1}`, `alternate_greetings[${i}]`));
  (card.groupOnlyGreetings || []).forEach((g, i) => push(g, `With a group ${i + 1}`, `group_only_greetings[${i}]`));
  return out;
}

// ---------------------------------------------------------------------------
// The verdict.

/**
 * Weigh a normalized character card and say what it is really for.
 *
 * @param {object} card the output of normalizeCard
 * @param {{format?: string}} [meta] the technical format, which is never changed
 * @returns {{role, confidence, score, because, alternatives, parts, signals}}
 */
export function classifyCard(card, meta = {}) {
  const body = [card.description, card.personality].filter(Boolean).join('\n\n');
  const all = [body, card.scenario].filter(Boolean).join('\n\n');

  const shape = documentShape(body);
  const struct = structuredShape(body);
  const orders = instructionRate(all);
  const subj = subjects(body);
  const sheet = sheetiness(body);
  const sp = speakers(card.exampleDialogue);
  const starts = startingPoints(card);
  const loreCount = card.lorebook?.entries?.length || 0;
  const bodyWords = words(body);
  const nowness = sceneNowness(card.firstMessage);
  const personalName = nameLooksPersonal(card.name);

  // How many named people this text actually sets out to describe. Two is a
  // duo, which a character card can legitimately be; three upward is a cast.
  // A structured record hides its people inside the data, so its roster
  // counts too — otherwise a staff list of twelve reads as nobody at all.
  // Three ways a card can introduce its cast, and it only has to use one:
  // as a document of headings, as a structured record, or as prose in the
  // opening. A scenario pack almost always uses the third.
  const inProse = prosePeople([card.scenario, card.firstMessage, body].filter(Boolean).join('\n'), card.name);

  // Names in prose are weak evidence on their own. A character card names the
  // people around its person — Bakugo's card names his classmates, Patrick's
  // names his family — and counting those as a cast turned six real people
  // into maybes. So prose names count only where there is little else to go
  // on, or where there are too many of them to be anyone's supporting cast.
  const proseCounts = (bodyWords < 200 || inProse.length >= 6) ? inProse.length : 0;
  const castSize = Math.max(subj.size, struct.roster.length, proseCounts);

  const signals = {
    bodyWords,
    headings: shape.headings,
    labelledRows: shape.labelled,
    tableRows: shape.tableRows,
    instructionRate: Number(orders.rate.toFixed(3)),
    instructionCount: orders.count,
    castSize,
    sheetFields: sheet,
    exampleSpeakers: sp.size,
    startingPoints: starts.length,
    loreEntries: loreCount,
    sceneNowness: Number(nowness.toFixed(2)),
    personalName,
    hasScenario: Boolean(text(card.scenario).trim()),
    hasSystemPrompt: Boolean(text(card.systemPrompt).trim()),
    structured: struct.structured,
    structuredKeys: struct.keys,
    structuredDepth: struct.depth,
    rosterNames: struct.roster.length,
    timeTuples: struct.timeTuples,
    structuredAboutOnePerson: struct.aboutOnePerson,
  };

  // Every push carries its own reason, so the verdict can explain itself in
  // the words of what it measured rather than as a number.
  const score = { character: 0, scenario: 0, framework: 0 };
  const why = { character: [], scenario: [], framework: [] };
  const push = (role, points, reason) => {
    if (!points) return;
    score[role] += points;
    if (points > 0) why[role].push(reason);
  };

  // ---- one person
  if (sheet >= 3) push('character', 3, `${sheet} lines read as one person's sheet`);
  else if (sheet >= 1) push('character', 1, 'a line or two of personal detail');
  if (personalName) push('character', 1.5, 'the name reads like a person');
  // "Only one subject" is evidence only when there was something to read. A
  // card with twenty words of description, whose whole scene lives in the
  // opening message, describes nobody — and calling that "one person" is how
  // four scenario packs arrived as people.
  if (castSize <= 1 && bodyWords >= 120) push('character', 2, 'only one subject is described');
  // A W++ or JSON sheet whose keys are somebody's own attributes.
  if (struct.structured && struct.aboutOnePerson) {
    push('character', 3, `${struct.keys} structured fields, and they are one person's`);
  }
  if (sp.size === 1) push('character', 2, 'the example dialogue has a single speaker');
  if (text(card.personality).trim()) push('character', 1.5, 'it has a personality field');
  // Prose that describes rather than orders. A data record is neither, and
  // scoring it here was how a school timetable read as a quiet personality.
  if (bodyWords && orders.rate < 0.12 && !struct.structured) {
    push('character', 1.5, 'it describes rather than instructs');
  }

  // ---- a situation
  if (signals.hasScenario) push('scenario', 2, 'it sets out a situation');
  if (nowness > 0.5 && words(card.firstMessage) > 60) push('scenario', 2, 'the opening is a scene already in progress');
  if (castSize >= 3) push('scenario', 2, `${castSize} people are set up in it`);
  // A demonstration with nineteen voices in it is not a sample of how one
  // person talks, and counting it the same as three was why the classroom
  // card tied with itself. The evidence grows with the room, to a ceiling.
  if (sp.size >= 3) {
    push('scenario', Math.min(4, 1.5 + (sp.size - 2) * 0.5), `${sp.size} people speak in the example`);
  }
  // A short card whose scene is set in its opening message rather than in a
  // description: the ordinary shape of a downloaded scenario pack.
  if (bodyWords < 200 && words(card.firstMessage) > 250 && castSize >= 2) {
    push('scenario', 2, 'it says almost nothing about a person and opens straight into a scene');
  }
  if (bodyWords > 0 && bodyWords < 700 && castSize >= 2) push('scenario', 1, 'it is short and about a group');
  if (starts.length >= 2 && bodyWords < 900) push('scenario', 1, `${starts.length} ways to begin`);

  // ---- a world and its rules
  if (orders.rate >= 0.25 && orders.count >= 6) push('framework', 3, `${orders.count} of ${orders.total} sentences are instructions`);
  else if (orders.rate >= 0.15 && orders.count >= 4) push('framework', 1.5, 'much of it is instructions');
  if (shape.headings >= 5) push('framework', 2.5, `${shape.headings} sections, like a reference document`);
  else if (shape.headings >= 3) push('framework', 1, 'it is divided into sections');
  if (shape.labelled >= 8) push('framework', 1.5, `${shape.labelled} labelled rows of structure`);
  if (shape.tableRows >= 4) push('framework', 1, 'it contains tables');
  if (bodyWords > 1800) push('framework', 1.5, 'it is long enough to be a reference work');
  if (!personalName && bodyWords > 400) push('framework', 1, 'the name is not a person');
  if (loreCount >= 12 && bodyWords > 600) push('framework', 1, `${loreCount} lore entries come with it`);
  // A structured record that is not anybody's sheet: a world written down.
  if (struct.structured && !struct.aboutOnePerson) {
    if (struct.keys >= 20) push('framework', 3, `${struct.keys} structured fields, none of them a person's`);
    else if (struct.keys >= 10) push('framework', 1.5, `${struct.keys} structured fields describing a setting`);
  }
  if (struct.roster.length >= 6) push('framework', 2, `a roster of ${struct.roster.length} named people`);
  if (struct.depth >= 4 && struct.structured) push('framework', 1, 'the record nests several levels deep');
  if (struct.timeTuples >= 4) push('framework', 1, 'it contains a timetable');
  if (starts.length >= 3) push('framework', 1, `${starts.length} separate ways in`);
  if (signals.hasSystemPrompt && orders.rate >= 0.2) push('framework', 1, 'it brings its own narrator instructions');

  // A lorebook alone proves nothing. Cards about one person routinely carry
  // their own lore, and an earlier draft of this filed every one of them as a
  // framework for exactly that reason.
  if (loreCount > 0 && castSize <= 1 && sheet >= 2) {
    push('character', 1.5, 'its lore is about the person it describes');
  }

  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [topRole, topScore] = ranked[0];
  const [nextRole, nextScore] = ranked[1];
  const margin = topScore - nextScore;

  let confidence = 'low';
  if (topScore >= 4 && margin >= 3) confidence = 'high';
  else if (topScore >= 3 && margin >= 1.5) confidence = 'medium';
  else if (topScore >= 2) confidence = 'low';

  // Nothing measurable at all: a near-empty card is a character by default,
  // because that is what the format says and there is nothing to argue with.
  if (topScore === 0) {
    return {
      role: 'character',
      confidence: 'low',
      score: { ...score },
      because: ['Nothing in it says what it is, so its format is all we have to go on.'],
      alternatives: [],
      components: loreCount ? [{ role: 'lorebook', score: null, because: [`${loreCount} entries came inside it`] }] : [],
      parts: partsOf(card),
      signals,
      format: meta.format || card.spec || null,
    };
  }

  // An alternative says "the verdict itself may be wrong". A component says
  // "the verdict is right, and there is also this inside". They are different
  // claims and collapsing them loses the second one: a card can be firmly a
  // Character and still carry a scenario's worth of opening setup that the
  // import plan may want to use.
  const alternatives = margin < 2.5 && nextScore >= 2
    ? [{ role: nextRole, because: why[nextRole].slice(0, 2) }]
    : [];

  // Three, not two: a single thin signal is not a component. One `scenario`
  // field reading "the bathhouse and the street outside" is a setting note on
  // a character card, and announcing it as a scenario inside her is the kind
  // of noise that makes a review screen worth ignoring.
  const components = Object.entries(score)
    .filter(([role, value]) => role !== topRole && value >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([role, value]) => ({ role, score: value, because: why[role].slice(0, 3) }));

  if (loreCount) {
    components.push({
      role: 'lorebook',
      score: null,
      because: [`${loreCount} entries came inside it`],
    });
  }

  return {
    role: topRole,
    confidence,
    score: { ...score },
    because: why[topRole].slice(0, 4),
    alternatives,
    components,
    parts: partsOf(card),
    signals,
    format: meta.format || card.spec || null,
  };
}

/**
 * The one question the rest of the app asks: can this go straight in?
 *
 * An ordinary character card with nothing odd about it should never stop to
 * ask permission. Hundreds of those are the normal case.
 */
export const isFastPath = (verdict) =>
  verdict.role === 'character' && verdict.confidence === 'high' && !verdict.alternatives.length;
