/**
 * A source, as a person reads it.
 *
 * A source is stored as a flat list of entries. Nobody thinks in entries. This
 * projects one source into the two ways it can actually be understood, and
 * keeps them apart:
 *
 *   filing    the structure the source's own author put in its titles
 *             ("01 CORE — …", "11 TIMELINE — …"). Read from the title at
 *             projection time. Never stored, never approved, never semantics.
 *
 *   semantic  what somebody has approved: who a piece is about, what kind of
 *             thing it is. This is the only truth here.
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD:
 *
 *     Source filing can organise review without becoming semantic truth.
 *
 * A title that reads "05 CLASS 1-B — Hiryu Rin" is excellent evidence about
 * how its author filed it. It is not a statement that the piece defines a
 * person called Hiryu Rin. Filing groups material so a person can review it a
 * group at a time; only that person's decision makes it mean anything.
 *
 * Nothing here writes. No analyzer runs, no model is asked, no entity is
 * created, nothing is approved, and no proposal is ever reported as settled.
 *
 * Counts are named for their unit, always. A group of people has an
 * entityCount and a pieceCount and they are different numbers; there is no
 * bare `count` anywhere in this shape.
 *
 * Every piece of the source appears exactly once in `pieces`. The views hold
 * pieceIds and nothing else, so a piece seen through filing and through
 * semantics is the same piece seen twice, never two copies of one row.
 */

import { CATEGORY_GROUP } from './profile.js';
import { semanticViews } from './store.js';

/** Which heading an entity's own type reads under. */
const TYPE_GROUP = {
  person: 'People', place: 'Places', faction: 'Factions',
  concept: 'Concepts', item: 'Things', event: 'Events',
};
const TYPE_ORDER = ['People', 'Places', 'Factions', 'Concepts', 'Things', 'Events'];

/** The order world material reads in, borrowed from the order a dossier uses. */
const WORLD_ORDER = ['Background', 'Rules', 'Events', 'Things', 'Directives', 'Reference', 'Other'];

// A filing prefix is what stands before the first separator in a title. The
// separator must be a spaced dash or pipe, or a colon: a bare hyphen is not one,
// because "05 CLASS 1-B" and "Class 1-A" are ordinary names with hyphens in them.
const DASHED = /^(.{1,40}?)\s+[—–|]\s+(.+)$/;
const COLONED = /^([^:—–|]{1,40}):\s+(.+)$/;

/**
 * The author's own filing for one title, or null where there is none.
 *
 * Deterministic and independent: this reads the title and nothing else. It is
 * not the analyzer, shares no heuristics with it, and its answer is never
 * stored. Where a title carries more than one separator only the first is a
 * group; the rest stays in `rest` for whoever needs it later.
 *
 * @param {string} title
 * @returns {{ group: string, rest: string }|null}
 */
export function filingOf(title) {
  const t = String(title || '').trim();
  if (!t) return null;
  const m = DASHED.exec(t) || COLONED.exec(t);
  if (!m) return null;
  const group = m[1].trim();
  const rest = m[2].trim();
  if (!group || !rest) return null;
  return { group, rest };
}

/**
 * How a piece's reading stands, from what is stored and nothing else.
 *
 *   approved   somebody approved it
 *   recheck    approved, and the entry has changed since
 *   proposed   a reading exists and nobody has approved it
 *   unread     no reading at all
 */
function readingOf(view) {
  if (!view) return 'unread';
  if (view.state === 'approved') return 'approved';
  if (view.state === 'recheck') return 'recheck';
  return 'proposed';
}

/**
 * Who an approved reading says a piece belongs to.
 *
 *   entity     an approved reading names the entity it defines or is about
 *   world      an approved reading that belongs to nobody in particular
 *   unsettled  no approved ownership yet — whether or not a proposal exists
 *
 * "unsettled" is deliberately one state. A piece nobody has read and a piece
 * with a proposed owner are equally not owned, and the difference between them
 * is a reading state, reported separately.
 */
function ownershipOf(view) {
  if (!view?.authoritative) return 'unsettled';
  const owner = view.defines || view.subject;
  if (owner) return 'entity';
  // An approved entity-scoped reading with nobody in it is incomplete, not
  // world material. It is counted as unsettled and flagged on the piece.
  if (view.scope === 'entity') return 'unsettled';
  return 'world';
}

/**
 * One source, projected.
 *
 * @param {object} db
 * @param {string} lorebookId
 * @returns {object|null} null when there is no such source
 */
export function sourceProjection(db, lorebookId) {
  const book = db.getLorebook(lorebookId);
  if (!book) return null;

  const entries = db.listEntries(lorebookId);
  const views = semanticViews(db, entries);

  // ---------------------------------------------------------------- pieces
  // The one place a piece exists. Everything below points at these by id.
  const pieces = entries.map((e) => {
    const view = views.get(e.id) || null;
    const reading = readingOf(view);
    const ownership = ownershipOf(view);
    const owner = view?.authoritative ? (view.defines || view.subject) : null;
    const approved = reading === 'approved' || reading === 'recheck';
    return {
      pieceId: e.id,
      title: e.title || 'Untitled',
      characters: String(e.content || '').length,
      displayIndex: e.display_index,
      enabled: !!e.enabled,
      // The author's filing. Read from the title, stored nowhere.
      filing: filingOf(e.title),
      reading,
      ownership,
      // Only ever set from an approved reading.
      owner: owner ? { id: owner.id, name: owner.canonical_name || owner.name, type: owner.type } : null,
      scope: approved ? view.scope : null,
      category: approved ? view.category : null,
      displayPath: approved ? view.displayPath : null,
      // An approved entity reading that names nobody: somebody must finish it.
      incomplete: approved && view.scope === 'entity' && !owner,
      // Everything a proposal says, marked as a proposal and never merged into
      // the fields above. Null unless a proposed reading is actually stored.
      proposal: reading === 'proposed'
        ? {
          scope: view.scope,
          category: view.category,
          displayPath: view.displayPath,
          subjects: (view.proposedSubjects || []).filter(Boolean)
            .map((x) => ({ id: x.id, name: x.canonical_name || x.name, type: x.type })),
        }
        : null,
    };
  });
  const byId = new Map(pieces.map((p) => [p.pieceId, p]));

  // ---------------------------------------------------------------- filing
  // The author's structure, in the order the source itself is in.
  const filingGroups = new Map();
  const unfiled = [];
  for (const p of pieces) {
    if (!p.filing) { unfiled.push(p.pieceId); continue; }
    const at = filingGroups.get(p.filing.group) || { name: p.filing.group, pieceIds: [] };
    at.pieceIds.push(p.pieceId);
    filingGroups.set(p.filing.group, at);
  }
  const groups = [...filingGroups.values()]
    .map((g) => ({ name: g.name, pieceCount: g.pieceIds.length, pieceIds: g.pieceIds }))
    .sort((a, b) => (byId.get(a.pieceIds[0]).displayIndex - byId.get(b.pieceIds[0]).displayIndex));
  if (unfiled.length) groups.push({ name: 'Unfiled', pieceCount: unfiled.length, pieceIds: unfiled });

  const filing = {
    groups,
    groupCount: groups.length - (unfiled.length ? 1 : 0),
    filedPieceCount: pieces.length - unfiled.length,
    unfiledPieceCount: unfiled.length,
  };

  // -------------------------------------------------------------- semantic
  // Approved readings only. A proposal never reaches this half of the shape.
  const owners = new Map();
  const worldGroups = new Map();
  let ownedPieceCount = 0;
  let ownerlessPieceCount = 0;
  for (const p of pieces) {
    if (p.ownership === 'entity') {
      ownedPieceCount += 1;
      const at = owners.get(p.owner.id) || { ...p.owner, pieceIds: [] };
      at.pieceIds.push(p.pieceId);
      owners.set(p.owner.id, at);
    } else if (p.ownership === 'world') {
      ownerlessPieceCount += 1;
      const name = CATEGORY_GROUP[p.category] || 'Other';
      const at = worldGroups.get(name) || { name, pieceIds: [] };
      at.pieceIds.push(p.pieceId);
      worldGroups.set(name, at);
    }
  }

  const entityGroups = new Map();
  for (const o of owners.values()) {
    const name = TYPE_GROUP[o.type] || 'Other';
    const at = entityGroups.get(name) || { name, entities: [] };
    at.entities.push({ id: o.id, name: o.name, type: o.type, pieceCount: o.pieceIds.length, pieceIds: o.pieceIds });
    entityGroups.set(name, at);
  }
  const rank = (order) => (name) => (order.indexOf(name) === -1 ? order.length : order.indexOf(name));
  const semantic = {
    entityGroups: [...entityGroups.values()]
      .map((g) => ({
        name: g.name,
        entityCount: g.entities.length,
        pieceCount: g.entities.reduce((n, e) => n + e.pieceCount, 0),
        entities: g.entities.sort((a, b) => b.pieceCount - a.pieceCount || a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => rank(TYPE_ORDER)(a.name) - rank(TYPE_ORDER)(b.name)),
    worldGroups: [...worldGroups.values()]
      .map((g) => ({ name: g.name, pieceCount: g.pieceIds.length, pieceIds: g.pieceIds }))
      .sort((a, b) => rank(WORLD_ORDER)(a.name) - rank(WORLD_ORDER)(b.name)),
    entityCount: owners.size,
    ownedPieceCount,
    ownerlessPieceCount,
  };

  // --------------------------------------------------------------- reading
  // How far the source has got. These are states of review, not of filing.
  const count = (fn) => pieces.filter(fn).length;
  const reading = {
    approvedPieceCount: count((p) => p.reading === 'approved' || p.reading === 'recheck'),
    recheckPieceCount: count((p) => p.reading === 'recheck'),
    proposedPieceCount: count((p) => p.reading === 'proposed'),
    unreadPieceCount: count((p) => p.reading === 'unread'),
    incompletePieceCount: count((p) => p.incomplete),
    unsettledPieceCount: count((p) => p.ownership === 'unsettled'),
  };

  return {
    source: {
      id: book.id,
      name: book.name,
      description: book.description || '',
      totalPieceCount: pieces.length,
    },
    filing,
    semantic,
    reading,
    pieces,
  };
}
