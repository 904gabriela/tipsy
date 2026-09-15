// Deciding which lore entries go into this message.
//
// This follows SillyTavern's behaviour closely, because your books were
// written against it: the same keywords, the same always-on entries, the same
// priority order, the same timing rules. If it behaved differently your lore
// would fire in the wrong places.
//
// Three things SillyTavern does are deliberately not copied, and each is
// marked below. They are bugs rather than features, and reproducing them
// would only cost you lore you meant to see.

import { POSITION, LOGIC } from '../import/lorebook.js';

// A non-word character between messages, so that "whole word" matching still
// works for a keyword sitting at the very start of a line.
const SEP = '\x01';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A key is a regular expression only if it is written as one: /like this/i */
function asRegex(key) {
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(key.trim());
  if (!m) return null;
  try { return new RegExp(m[1], m[2]); } catch { return null; }
}

function matchKey(haystack, key, entry) {
  if (!key) return false;
  const rx = asRegex(key);
  if (rx) return rx.test(haystack);

  const h = entry.caseSensitive ? haystack : haystack.toLowerCase();
  const n = entry.caseSensitive ? key : key.toLowerCase();

  if (entry.matchWholeWords) {
    const words = n.trim().split(/\s+/);
    if (words.length > 1) return h.includes(n);
    return new RegExp(`(?:^|\\W)(${esc(n)})(?:$|\\W)`).test(h);
  }
  return h.includes(n);
}

/** How many of an entry's keys hit. Used when entries compete within a group. */
function score(haystack, entry) {
  const primary = entry.keys.filter((k) => matchKey(haystack, k, entry)).length;
  if (primary === 0) return 0;
  const secondary = entry.secondaryKeys.filter((k) => matchKey(haystack, k, entry)).length;
  switch (entry.selectiveLogic) {
    case LOGIC.AND_ALL:
      return secondary === entry.secondaryKeys.length ? primary + secondary : primary;
    case LOGIC.AND_ANY:
      return primary + secondary;
    default:
      return primary;
  }
}

function secondaryPasses(haystack, entry) {
  if (!entry.selective || entry.secondaryKeys.length === 0) return true;
  const hits = entry.secondaryKeys.map((k) => matchKey(haystack, k, entry));
  switch (entry.selectiveLogic) {
    case LOGIC.AND_ANY: return hits.some(Boolean);
    case LOGIC.NOT_ALL: return hits.some((h) => !h);
    case LOGIC.NOT_ANY: return !hits.some(Boolean);
    case LOGIC.AND_ALL: return hits.every(Boolean);
    default: return true;
  }
}

/**
 * How much evidence one key really is, measured inside its own book.
 *
 * "hero" in a superhero book is not a trigger, it is the wallpaper: nearly
 * every entry says it. "Stain" in the same book names one person. The
 * difference is not a list of banned words — it could not be, because "mafia",
 * "magic", "school" and "vampire" are each the wallpaper of some book and a
 * precise trigger in another. So it is counted: a short single word that turns
 * up across a quarter of the book is that book's background noise, whatever
 * the book happens to be about.
 *
 * This never blocks an entry the conversation actually asked for. It only
 * decides whether a key is strong enough to fire an entry that nothing in the
 * scene mentioned — one surfaced purely by another entry's text.
 */
function buildSpecificity(entries) {
  const contents = entries.map((e) => String(e.content || '').toLowerCase());
  const threshold = Math.max(3, Math.ceil(entries.length * 0.25));
  const cache = new Map();
  return (key) => {
    const k = String(key || '').trim().toLowerCase();
    if (!k) return false;
    if (cache.has(k)) return cache.get(k);
    let specific;
    // An author who wrote a regular expression meant exactly what they wrote.
    if (asRegex(key)) specific = true;
    // A phrase names something; a long word usually does too.
    else if (k.split(/\s+/).length >= 2 || k.length >= 12) specific = true;
    else specific = contents.filter((c) => c.includes(k)).length < threshold;
    cache.set(k, specific);
    return specific;
  };
}

/**
 * The text an entry gets to search. Recent messages, newest first, cut to the
 * entry's own scan depth if it sets one.
 */
function haystackFor(entry, recent, defaultDepth, includeNames) {
  const depth = entry.scanDepth ?? defaultDepth;
  if (depth <= 0) return '';
  const slice = recent.slice(0, depth);
  return SEP + slice
    .map((m) => (includeNames && m.name ? `${m.name}: ${m.content}` : m.content))
    .join(`\n${SEP}`);
}

/**
 * Work out which entries fire this turn.
 *
 * @param {object[]} entries     every enabled entry from every active book
 * @param {object[]} recent      messages newest-first: {role, name, content}
 * @param {object}   opts
 * @param {number}   opts.budget     token ceiling for lore this turn
 * @param {number}   opts.scanDepth  how many messages to search by default
 * @param {boolean}  opts.recursive  may entries trigger other entries
 * @param {number}   opts.messageCount  how far into the story we are, for timers
 * @param {object}   opts.timers     persisted {sticky:{}, cooldown:{}} state
 * @param {boolean}  opts.includeNames  does the speaker's name count as text
 * @param {function} opts.countTokens
 */
export function activate(rawEntries, recent, opts = {}) {
  // A draft from the editor may be missing the lists a stored entry has.
  const entries = rawEntries.map((e) => ({
    keys: [], secondaryKeys: [], group: '', enabled: true, order: 100,
    ...e,
    id: e.id || String(e.uid ?? Math.random()),
  }));
  const {
    budget = 8000,
    scanDepth = 2,
    recursive = true,
    messageCount = 0,
    timers = { sticky: {}, cooldown: {} },
    includeNames = false,
    countTokens = (s) => Math.ceil(s.length / 4),
    maxRecursionSteps = 8,
  } = opts;

  // Highest order wins ties and gets first claim on the budget.
  const sorted = [...entries].sort((a, b) => b.order - a.order);

  // Worked out once from this book, not from a list of words anyone typed.
  const isSpecific = buildSpecificity(entries);

  /**
   * A book this story has chosen to keep out of recursion.
   *
   * Two effects, which are the story-level equivalents of the two entry flags
   * an author can already set, without touching either of them: entries here
   * cannot be surfaced BY recursion, and their text cannot feed it. A book
   * written as a dense cross-referenced graph reaches its whole self in one
   * hop, and that is a property of the book, not of any entry in it.
   *
   * Null is the default and means exactly what it meant before this existed.
   */
  const blocked = (e) => e.bookRecursion === 'block';

  const activated = new Map();      // id -> entry
  const failedRoll = new Set();
  const groupsDecided = new Set();  // a group speaks once per turn, not once per pass
  const trace = [];                 // why each entry did or did not fire
  let recursionText = '';
  let used = 0;
  let usedRecursive = 0;
  let constantTokens = 0;
  let overflowed = false;
  let pass = 0;

  const isSticky = (e) => {
    const t = timers.sticky[e.id];
    return !!t && messageCount < t.end;
  };
  const isCooling = (e) => {
    const t = timers.cooldown[e.id];
    return !!t && messageCount < t.end;
  };
  const isDelayed = (e) => e.delay != null && messageCount < e.delay;

  while (pass < maxRecursionSteps) {
    const firedThisPass = [];

    for (const e of sorted) {
      if (activated.has(e.id) || failedRoll.has(e.id)) continue;
      if (!e.enabled) continue;

      if (isDelayed(e)) { trace.push({ id: e.id, fired: false, why: 'waiting until later in the story' }); continue; }
      const sticky = isSticky(e);
      if (isCooling(e) && !sticky) { trace.push({ id: e.id, fired: false, why: 'recently used, cooling down' }); continue; }

      const recursing = pass > 0;
      if (!recursing && e.delayUntilRecursion) continue;
      if (recursing && e.excludeRecursion && !sticky) continue;

      if (e.constant || sticky) {
        firedThisPass.push({ e, why: sticky ? 'held from an earlier message' : 'always on' });
        continue;
      }
      if (e.keys.length === 0) continue;

      // What the scene itself says, kept separate from what other entries
      // say. The conversation is ground truth; entry text is hearsay.
      const windowText = haystackFor(e, recent, scanDepth, includeNames);
      const recursionHay = recursing && recursionText ? `${SEP}${recursionText}` : '';
      const hay = windowText + (recursionHay ? `\n${recursionHay}` : '');

      let hit = e.keys.find((k) => matchKey(windowText, k, e));
      let from = null;
      if (hit) {
        const nowText = haystackFor(e, recent.slice(0, 1), 1, includeNames);
        from = matchKey(nowText, hit, e) ? 'this turn' : 'a recent turn';
      } else if (recursionHay && !blocked(e)) {
        // Nothing in the scene asked for this. Another entry's text mentioned
        // it, which is a real and useful thing — "the fight at Kamino" should
        // bring in Kamino — but only when the mention is specific. Letting a
        // book's commonest word do it turns three entries into sixteen and
        // the same sixteen fire whatever the scene is.
        hit = e.keys.find((k) => matchKey(recursionHay, k, e) && isSpecific(k));
        if (hit) from = 'another entry that fired';
        else {
          const weak = e.keys.find((k) => matchKey(recursionHay, k, e));
          if (weak) {
            trace.push({
              id: e.id, fired: false, key: weak, from: 'another entry that fired',
              why: `only "${weak}" matched, and only inside another entry`,
            });
          }
          continue;
        }
      }
      if (!hit) continue;
      if (!secondaryPasses(hay, e)) { trace.push({ id: e.id, fired: false, why: 'its extra conditions were not met' }); continue; }

      firedThisPass.push({ e, why: `matched "${hit}"`, hay, hit, from, pass });
    }

    if (firedThisPass.length === 0) break;

    // Only one entry from a group may speak. Highest order wins outright when
    // any member says so, otherwise it is a weighted draw.
    const kept = resolveGroups(firedThisPass, recent, scanDepth, includeNames, groupsDecided, trace);

    for (const item of kept) {
      const e = item.e;
      if (e.useProbability && e.probability < 100 && !isSticky(e)) {
        if (Math.random() * 100 > e.probability) {
          failedRoll.add(e.id);
          trace.push({ id: e.id, fired: false, why: `chance roll missed (${e.probability}%)` });
          continue;
        }
      }

      const cost = countTokens(e.content);

      // Always-on entries live in the cached, frozen part of the prompt.
      // Charging them against the per-turn budget was starving the entries
      // the scene is actually about, which is exactly the "budget full"
      // symptom, so they are accounted for separately.
      if (e.constant) {
        constantTokens += cost;
        activated.set(e.id, e);
        trace.push({ id: e.id, fired: true, why: item.why, tokens: cost, from: item.from, pass: item.pass, key: item.hit });
        continue;
      }

      // An entry the scene actually named gets the budget it needs. An entry
      // that nothing in the scene named — surfaced only because some other
      // entry's text mentioned it — draws on a smaller, separate allowance.
      //
      // This is the difference between retrieval and an avalanche in a book
      // written as an encyclopedia, where every entry cross-references every
      // other and one hop from any hub reaches the lot. They still compete in
      // the author's own priority order, so what survives is what the author
      // ranked highest, not whatever happened to be checked first.
      if (item.from === 'another entry that fired' && !e.ignoreBudget) {
        const share = Math.round(budget * (opts.recursionShare ?? 0.25));
        if (usedRecursive + cost > share) {
          trace.push({
            id: e.id, fired: false, key: item.hit, from: item.from,
            why: `nothing in the scene mentioned it, and the ${share}-token allowance for follow-on lore is full`,
          });
          continue;
        }
        usedRecursive += cost;
      }

      if (!e.ignoreBudget && used + cost > budget) {
        // Unlike SillyTavern, a skipped entry is not counted against the
        // budget for the entries after it. Its text never went anywhere,
        // so charging for it would silently starve everything below.
        overflowed = true;
        trace.push({ id: e.id, fired: false, why: 'no room left in the lore budget' });
        continue;
      }

      used += cost;
      activated.set(e.id, e);
      trace.push({ id: e.id, fired: true, why: item.why, tokens: cost, from: item.from, pass: item.pass, key: item.hit });
    }

    if (!recursive || overflowed) break;
    const feed = kept
      .filter((i) => activated.has(i.e.id) && !i.e.preventRecursion && !blocked(i.e))
      .map((i) => i.e.content);
    if (feed.length === 0) break;
    // Accumulate, so a third pass can still see what the first one surfaced.
    recursionText = recursionText ? `${recursionText}\n${feed.join('\n')}` : feed.join('\n');
    pass++;
  }

  const fired = [...activated.values()];
  return {
    entries: fired,
    byPosition: groupByPosition(fired),
    tokens: used,
    constantTokens,
    budget,
    overflowed,
    trace,
    timers: advanceTimers(fired, entries, timers, messageCount),
  };
}

function resolveGroups(items, recent, scanDepth, includeNames, decided, trace) {
  const grouped = new Map();
  const loose = [];
  for (const item of items) {
    const g = item.e.group.trim();
    if (!g) { loose.push(item); continue; }
    if (!grouped.has(g)) grouped.set(g, []);
    grouped.get(g).push(item);
  }

  const winners = [];
  for (const [name, members] of grouped) {
    if (decided.has(name)) {
      for (const m of members) trace.push({ id: m.e.id, fired: false, why: `another entry from "${name}" was already chosen` });
      continue;
    }
    decided.add(name);
    if (members.length === 1) { winners.push(members[0]); continue; }

    if (members.some((m) => m.e.groupOverride)) {
      const w = members.reduce((a, b) => (b.e.order > a.e.order ? b : a));
      for (const m of members) if (m !== w) trace.push({ id: m.e.id, fired: false, why: `"${name}" always prefers a higher-priority entry` });
      winners.push(w);
      continue;
    }
    if (members.some((m) => m.e.useGroupScoring)) {
      const scored = members.map((m) => ({
        m,
        s: score(haystackFor(m.e, recent, scanDepth, includeNames), m.e),
      }));
      const best = Math.max(...scored.map((x) => x.s));
      const top = scored.filter((x) => x.s === best).map((x) => x.m);
      const w = pickWeighted(top);
      for (const m of members) if (m !== w) trace.push({ id: m.e.id, fired: false, why: `"${name}" chose a different entry this time` });
      winners.push(w);
      continue;
    }
    const w = pickWeighted(members);
    for (const m of members) if (m !== w) trace.push({ id: m.e.id, fired: false, why: `"${name}" chose a different entry this time` });
    winners.push(w);
  }
  return [...loose, ...winners].sort((a, b) => b.e.order - a.e.order);
}

function pickWeighted(items) {
  const total = items.reduce((a, i) => a + (i.e.groupWeight || 100), 0);
  let roll = Math.random() * total;
  for (const i of items) {
    roll -= (i.e.groupWeight || 100);
    if (roll <= 0) return i;
  }
  return items[items.length - 1];
}

/**
 * Lore is assembled lowest order first, so the most important entries sit
 * closest to the conversation, which is where models weight them most.
 */
function groupByPosition(fired) {
  const out = {
    beforeCharacter: [], afterCharacter: [],
    authorNoteTop: [], authorNoteBottom: [],
    atDepth: new Map(), outlets: new Map(),
  };
  const ordered = [...fired].sort((a, b) => a.order - b.order);
  for (const e of ordered) {
    switch (e.position) {
      case POSITION.AFTER_CHAR: out.afterCharacter.push(e); break;
      case POSITION.AN_TOP: out.authorNoteTop.push(e); break;
      case POSITION.AN_BOTTOM: out.authorNoteBottom.push(e); break;
      case POSITION.AT_DEPTH: {
        const k = `${e.depth}:${e.role}`;
        if (!out.atDepth.has(k)) out.atDepth.set(k, []);
        out.atDepth.get(k).push(e);
        break;
      }
      case POSITION.OUTLET: {
        // Outlets keep the same low-to-high order as everything else, unlike
        // SillyTavern, which reverses them by accident.
        const n = e.outletName || 'default';
        if (!out.outlets.has(n)) out.outlets.set(n, []);
        out.outlets.get(n).push(e);
        break;
      }
      default: out.beforeCharacter.push(e);
    }
  }
  return out;
}

/** Start and expire the sticky and cooldown windows for entries that fired. */
function advanceTimers(fired, allEntries, timers, messageCount) {
  const sticky = { ...timers.sticky };
  const cooldown = { ...timers.cooldown };

  for (const k of Object.keys(sticky)) if (messageCount >= sticky[k].end) {
    // Looked up among every entry, not just this turn's: a sticky that runs
    // out on a turn where it did not fire must still start its cooldown.
    const entry = allEntries.find((e) => e.id === k);
    delete sticky[k];
    // A sticky window that ends rolls straight into its cooldown, so an entry
    // cannot re-fire on the very next message.
    if (entry && entry.cooldown) cooldown[k] = { start: messageCount, end: messageCount + entry.cooldown };
  }
  for (const k of Object.keys(cooldown)) if (messageCount >= cooldown[k].end) delete cooldown[k];

  for (const e of fired) {
    if (e.sticky && !sticky[e.id]) sticky[e.id] = { start: messageCount, end: messageCount + e.sticky };
    else if (e.cooldown && !e.sticky && !cooldown[e.id]) cooldown[e.id] = { start: messageCount, end: messageCount + e.cooldown };
  }
  return { sticky, cooldown };
}
