// The same thing twice, and the same thing later.
//
// A library fills up with two different problems that look alike. One is the
// same file imported three times: three sources whose every entry matches, of
// which two are simply clutter. The other is a pack that was revised: thirty-two
// entries became thirty-four, two of them rewritten. Those are not clutter, and
// treating them alike would lose somebody's work.
//
// So there are two answers here and they never blur:
//
//   exact      identical content, normalised. Safe to call copies.
//   possible   related, by name or by import lineage or by overlapping
//              entries — worth comparing, never worth merging.
//
// What counts as content is deliberately narrow. Two sources are the same when
// what they SAY and how they BEHAVE are the same: titles, text, keys, whether an
// entry is on, whether it is always on, its order and its odds. What is NOT
// content: who reviewed it, what anybody approved about it, when it arrived,
// what it is called in the library. A copy somebody organised and a copy nobody
// touched hold the same material — the preview says which is which, and the
// person chooses.
//
// Deterministic. No model is asked anything, here or anywhere near here.

import { createHash } from 'node:crypto';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const parse = (s, fallback) => { try { return JSON.parse(s ?? ''); } catch { return fallback; } };

/** Keys compared as a set: the same triggers in a different order are the same triggers. */
const keysOf = (e) => {
  const k = parse(e.keys, []);
  return (Array.isArray(k) ? k : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean).sort();
};

// Everything about an entry that changes what it says or when it says it.
// Tuning counts: a pack with one directive switched off, or firing at a
// different depth, behaves differently and is not the same pack. Ids,
// timestamps, display order in the editor and review history do not count.
const ENTRY_FIELDS = [
  'enabled', 'constant', 'selective', 'selective_logic', 'ord', 'position', 'depth', 'role',
  'probability', 'use_probability', 'case_sensitive', 'match_whole_words', 'use_regex',
  'scan_depth', 'exclude_recursion', 'prevent_recursion', 'delay_until_recursion',
  'grp', 'group_override', 'group_weight', 'use_group_scoring',
  'sticky', 'cooldown', 'delay', 'ignore_budget', 'vectorized', 'kind',
];

/** One entry, reduced to what it means and how it fires. */
export function entryFingerprint(e) {
  return JSON.stringify([
    String(e.title ?? '').trim(),
    String(e.content ?? ''),
    keysOf(e),
    (parse(e.secondary_keys, []) || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean).sort(),
    ENTRY_FIELDS.map((f) => {
      const v = e[f];
      if (v === null || v === undefined || v === '') return null;
      return typeof v === 'boolean' ? (v ? 1 : 0) : v;
    }),
  ]);
}

/** The columns entryFingerprint reads, for the one SELECT that feeds it. */
export const ENTRY_COLUMNS = ['title', 'content', 'keys', 'secondary_keys', ...ENTRY_FIELDS].join(', ');

/**
 * A whole source, reduced the same way.
 *
 * Entries are sorted by their own fingerprint, so two copies that were written
 * to the database in a different order still match. The source's own name is
 * not in it: renaming your copy does not make it a different pack.
 */
export function sourceFingerprint(db, lorebookId) {
  const entries = db.raw.prepare(
    `SELECT ${ENTRY_COLUMNS} FROM lore_entries WHERE lorebook_id=?`).all(lorebookId);
  const parts = entries.map(entryFingerprint).sort();
  const book = db.raw.prepare('SELECT scan_depth, token_budget, recursive FROM lorebooks WHERE id=?').get(lorebookId) || {};
  return sha(JSON.stringify([
    parts,
    // How the source itself is read. Two packs with different budgets are not
    // interchangeable even if every entry matches.
    Number(book.scan_depth ?? 0), Number(book.token_budget ?? 0), book.recursive ? 1 : 0,
  ]));
}

// Everything a card actually is. Name included — for a person, the name IS
// content — but not avatars, timestamps, ids or which entity it was bound to.
const CARD_FIELDS = ['name', 'nickname', 'description', 'personality', 'scenario', 'first_message',
  'example_dialogue', 'alternate_greetings', 'system_prompt', 'post_history_instructions',
  'depth_prompt', 'creator_notes', 'linked_world', 'appearance', 'behavior', 'speech_style'];

/** A character card, reduced to what it would say to a model. */
export function characterFingerprint(db, characterId) {
  const row = db.raw.prepare('SELECT * FROM characters WHERE id=?').get(characterId);
  if (!row) return null;
  const tags = (parse(row.tags, []) || []).map((t) => String(t).trim().toLowerCase()).sort();
  return sha(JSON.stringify([CARD_FIELDS.map((f) => String(row[f] ?? '').trim()), tags]));
}

/**
 * Groups of two or more resources whose content is identical.
 *
 * @returns {Array<{kind, fingerprint, ids: string[]}>}
 */
export function findExactDuplicates(db, kind = 'source') {
  const ids = kind === 'source'
    // A source with nothing in it is not a copy of another source with nothing
    // in it. Emptiness is not evidence: any two empty packs match, and calling
    // them copies of each other would put two unrelated names in one group and
    // invite somebody to keep the wrong one. They are still perfectly ordinary
    // unused things, and cleanup still offers them as that.
    ? db.raw.prepare(`SELECT id FROM lorebooks l
        WHERE EXISTS (SELECT 1 FROM lore_entries e WHERE e.lorebook_id = l.id)`).all().map((r) => r.id)
    : db.raw.prepare('SELECT id FROM characters').all().map((r) => r.id);
  const byPrint = new Map();
  for (const id of ids) {
    const print = kind === 'source' ? sourceFingerprint(db, id) : characterFingerprint(db, id);
    if (!print) continue;
    byPrint.set(print, [...(byPrint.get(print) || []), id]);
  }
  return [...byPrint.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([fingerprint, group]) => ({ kind, fingerprint, ids: group }));
}

/**
 * Which copies are actually surplus.
 *
 * Being in a group of copies is not the same as being disposable. Three
 * identical packs are three members of one group and TWO redundant copies: one
 * has to stay. And if a story is already reading one of them, the keeper is
 * decided — every unused copy beside it is surplus.
 *
 * This is a recommendation, not a rule. Somebody who deliberately selects every
 * copy and is blocked by nothing may still delete the lot; that is their call,
 * and it goes through the ordinary dependency preview like anything else.
 *
 * @param {Array} groups  from findExactDuplicates
 * @param {function} status  id → { used, protected }
 * @returns {{ groups, members, redundant: string[], blocked: string[] }}
 */
export function redundantCopies(groups, status) {
  const redundant = [];
  const blocked = [];
  let members = 0;
  for (const g of groups) {
    members += g.ids.length;
    const free = g.ids.filter((id) => { const s = status(id); return s && !s.used && !s.protected; });
    const kept = g.ids.filter((id) => { const s = status(id); return !s || s.used || s.protected; });
    blocked.push(...kept);
    // Something already keeps this material: every spare copy is spare. Nothing
    // does: one stays, and it is not this module's business which.
    redundant.push(...(kept.length ? free : free.slice(1)));
  }
  return { groups: groups.length, members, redundant, blocked };
}

/** Names compared the way a person would: case, punctuation and spacing aside. */
const loose = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Sources that may be versions of each other.
 *
 * Three conservative signals, any one of which is enough to ask about, and none
 * of which is ever enough to act on:
 *
 *   lineage   they came from the same imported file
 *   name      the same name, loosely read
 *   overlap   more than half the entries of the smaller one appear, word for
 *             word, in the larger
 *
 * Exact copies are excluded: those are a different question with a different
 * answer. Nothing here is ordered "best first" — there is no such thing.
 */
export function findPossibleVersions(db) {
  const books = db.raw.prepare('SELECT id, name, import_id FROM lorebooks').all();
  const print = new Map(books.map((b) => [b.id, sourceFingerprint(db, b.id)]));
  const entries = new Map(books.map((b) => [b.id, new Set(
    db.raw.prepare(`SELECT ${ENTRY_COLUMNS} FROM lore_entries WHERE lorebook_id=?`)
      .all(b.id).map(entryFingerprint))]));

  const related = (a, b) => {
    if (print.get(a.id) === print.get(b.id)) return null;          // an exact copy, not a version
    if (a.import_id && a.import_id === b.import_id) return 'they came from the same file';
    if (loose(a.name) && loose(a.name) === loose(b.name)) return 'they have the same name';
    const ea = entries.get(a.id); const eb = entries.get(b.id);
    const big = Math.max(ea.size, eb.size);
    if (big) {
      const small = ea.size <= eb.size ? ea : eb;
      let shared = 0;
      for (const x of small) if ((small === ea ? eb : ea).has(x)) shared++;
      // Measured against the LARGER of the two. A small pack whose every entry
      // also appears inside a big one is contained by it, not a revision of it,
      // and calling that a version would put half the library in one heap.
      if (shared / big > 0.7) return `${shared} of their entries are word for word the same`;
    }
    return null;
  };

  // Pairs, never chains. If A resembles B and B resembles C, that is two
  // questions: joining them would let one weak link drag in a whole shelf, and
  // a heap of seven unrelated packs is worse than no answer at all.
  const pairs = [];
  for (let i = 0; i < books.length; i++) {
    for (let k = i + 1; k < books.length; k++) {
      const why = related(books[i], books[k]);
      if (why) pairs.push({ ids: [books[i].id, books[k].id], why: [why] });
    }
  }
  return pairs;
}

/**
 * Two sources, side by side.
 *
 * Entries are matched by title first, because that is how a person recognises
 * one. Same title and same everything is unchanged; same title and different
 * anything is changed, and the difference is named in words rather than dumped.
 *
 * @returns {{ same, added, removed, changed, details }}
 */
export function compareSources(db, aId, bId) {
  const read = (id) => db.raw.prepare(
    `SELECT id, ${ENTRY_COLUMNS} FROM lore_entries WHERE lorebook_id=?`).all(id);
  const a = read(aId); const b = read(bId);
  const index = (list) => {
    const m = new Map();
    for (const e of list) m.set(`${String(e.title ?? '').trim().toLowerCase()}`, [...(m.get(String(e.title ?? '').trim().toLowerCase()) || []), e]);
    return m;
  };
  const ai = index(a); const bi = index(b);
  const details = { same: [], added: [], removed: [], changed: [] };

  for (const [title, mine] of ai) {
    const theirs = bi.get(title) || [];
    for (let i = 0; i < mine.length; i++) {
      const other = theirs[i];
      if (!other) { details.removed.push({ title: mine[i].title }); continue; }
      if (entryFingerprint(mine[i]) === entryFingerprint(other)) { details.same.push({ title: mine[i].title }); continue; }
      const how = [];
      if (String(mine[i].content ?? '') !== String(other.content ?? '')) how.push('the words');
      if (JSON.stringify(keysOf(mine[i])) !== JSON.stringify(keysOf(other))) how.push('what brings it in');
      const on = (e) => !(e.enabled === 0 || e.enabled === false);
      if (on(mine[i]) !== on(other)) how.push(on(other) ? 'switched on' : 'switched off');
      if (!!mine[i].constant !== !!other.constant) how.push(other.constant ? 'always on' : 'no longer always on');
      if (Number(mine[i].ord ?? 0) !== Number(other.ord ?? 0)) how.push('where it sits');
      if (Number(mine[i].probability ?? 100) !== Number(other.probability ?? 100)) how.push('how often it fires');
      // Something differs — the fingerprints said so — but it is one of the
      // finer activation settings this screen does not name. Say that, rather
      // than showing a difference with nothing beside it.
      details.changed.push({ title: mine[i].title, how: how.length ? how : ['how it is set up'] });
    }
  }
  for (const [title, theirs] of bi) {
    const mine = ai.get(title) || [];
    for (let i = mine.length; i < theirs.length; i++) details.added.push({ title: theirs[i].title });
  }
  return {
    same: details.same.length, added: details.added.length,
    removed: details.removed.length, changed: details.changed.length,
    details,
  };
}
