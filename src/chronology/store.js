/**
 * When a piece of knowledge is true, kept apart from what it means.
 *
 * A source says that Bakugo is proud: that is semantics, and it lives in
 * entry_semantics. The same source says this is how he stands on the first
 * day and not after his first defeat: that is chronology, and it lives here.
 * Two facts about one piece, and writing either one never touches the other.
 * A piece is placed by pointing at it, never by copying it; one piece is one
 * piece however many things are known about when it is true.
 *
 * Three things, and the order they nest in:
 *
 *   continuity   a reusable ordered chronology — "My Hero Academia canon".
 *                Neither a source nor a story. A source can feed one; a story
 *                will one day sit somewhere in one. Not here yet.
 *   position     a named point in a continuity, ordered by an explicit
 *                ordinal and nothing else. Its token is the author's own
 *                stable handle (POST_USJ); its label is what a person reads.
 *                Nothing compares names to decide what comes first.
 *   placement    a piece is true FROM a position onward. That is all the
 *                material proves: later states layer over earlier ones and a
 *                reader orders by position. No end and no "supersedes" link,
 *                because nothing in the material asserts either.
 *
 * Provenance is the semantic model's, exactly: proposed or approved, an
 * inference cannot be approved as it stands, evidence says who produced the
 * reading, and an approved placement records the hash of the piece's words so
 * a changed piece is marked NEEDS RECHECK rather than silently trusted.
 *
 * Nothing here runs an analyser, and nothing here is read by activation,
 * retrieval, ownership or prompt precedence.
 */

import { randomUUID } from 'node:crypto';
import { entryHash } from '../semantics/authority.js';

export class ChronologyError extends Error {}

const ORIGINS = ['native', 'converted', 'manual', 'generated', 'inferred'];
const STATUSES = ['proposed', 'approved'];
const now = () => Date.now();
const j = (v) => JSON.stringify(v ?? {});
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const q = (db) => db.raw;

function checkProvenance(origin, status) {
  if (!ORIGINS.includes(origin)) throw new ChronologyError('A chronology reading needs an origin.');
  if (!STATUSES.includes(status)) throw new ChronologyError('A chronology reading is proposed or approved.');
  // An inference is a suggestion. Nothing a machine guessed is approved here.
  if (status === 'approved' && origin === 'inferred') throw new ChronologyError('An inference cannot be approved as it stands; a person approves it through review.');
}

// ---------------------------------------------------------------- writes

/** A new continuity. It belongs to no source and no story. */
export function createContinuity(db, { name, description = '', origin, status, evidence = {} }) {
  if (!String(name || '').trim()) throw new ChronologyError('A continuity needs a name.');
  checkProvenance(origin, status);
  const id = randomUUID();
  q(db).prepare(`INSERT INTO continuities (id,name,description,origin,status,evidence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, String(name).trim(), String(description || ''), origin, status, j(evidence), now(), now());
  return id;
}

/**
 * A position in a continuity. Its place in the order is the ordinal given,
 * and only that; two positions cannot share an ordinal or a token.
 */
export function addPosition(db, { continuityId, ordinal, token, label = '', origin, status, evidence = {} }) {
  if (!q(db).prepare('SELECT 1 FROM continuities WHERE id=?').get(continuityId)) throw new ChronologyError('No such continuity.');
  if (!Number.isInteger(ordinal)) throw new ChronologyError('A position has a whole-number ordinal.');
  if (!String(token || '').trim()) throw new ChronologyError('A position needs a token.');
  checkProvenance(origin, status);
  const id = randomUUID();
  try {
    q(db).prepare(`INSERT INTO continuity_positions (id,continuity_id,ordinal,token,label,origin,status,evidence,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, continuityId, ordinal, String(token).trim(), String(label || ''), origin, status, j(evidence), now(), now());
  } catch (err) {
    if (/UNIQUE/.test(String(err.message))) throw new ChronologyError('That continuity already has a position with this ordinal or token.');
    throw err;
  }
  return id;
}

/**
 * Say when a piece is true: from this position onward.
 *
 * The piece keeps every word and every semantic reading it has. This writes a
 * row that points at it. Placing it again in the same continuity replaces the
 * old placement, so a piece is never in two places in one continuity.
 */
export function placeEntry(db, { entryId, fromPositionId, origin, status, confidence = null, evidence = {} }) {
  checkProvenance(origin, status);
  if (confidence !== null && !['high', 'medium', 'low'].includes(confidence)) throw new ChronologyError('Confidence is high, medium or low.');
  const entry = q(db).prepare('SELECT id, title, content, keys FROM lore_entries WHERE id=?').get(entryId);
  if (!entry) throw new ChronologyError('No such entry.');
  const at = q(db).prepare('SELECT id, continuity_id FROM continuity_positions WHERE id=?').get(fromPositionId);
  if (!at) throw new ChronologyError('No such position.');
  const hash = status === 'approved' ? entryHash({ ...entry, keys: parse(entry.keys, []) }) : null;
  const id = randomUUID();
  q(db).prepare(`INSERT INTO entry_placements (id,entry_id,continuity_id,from_position_id,origin,status,confidence,evidence,content_hash,reviewed_at,created_at,updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(entry_id, continuity_id) DO UPDATE SET
                   from_position_id=excluded.from_position_id, origin=excluded.origin, status=excluded.status,
                   confidence=excluded.confidence, evidence=excluded.evidence, content_hash=excluded.content_hash,
                   reviewed_at=excluded.reviewed_at, updated_at=excluded.updated_at`)
    .run(id, entryId, at.continuity_id, at.id, origin, status, confidence, j(evidence), hash,
      status === 'approved' ? now() : null, now(), now());
  return q(db).prepare('SELECT id FROM entry_placements WHERE entry_id=? AND continuity_id=?').get(entryId, at.continuity_id).id;
}

/** Take a placement back. The piece and its semantics are untouched. */
export function unplaceEntry(db, { entryId, continuityId }) {
  return q(db).prepare('DELETE FROM entry_placements WHERE entry_id=? AND continuity_id=?').run(entryId, continuityId).changes;
}

// ----------------------------------------------------------------- reads

/**
 * One placement's reading, from what is stored and nothing else.
 *
 *   approved   somebody approved it
 *   recheck    approved, and the piece's words have changed since
 *   proposed   a placement exists and nobody has approved it
 */
function placementState(row, entry) {
  if (row.status !== 'approved') return 'proposed';
  const live = entryHash({ ...entry, keys: parse(entry.keys, []) });
  return row.content_hash && row.content_hash !== live ? 'recheck' : 'approved';
}

const positionShape = (p) => ({ id: p.id, ordinal: p.ordinal, token: p.token, label: p.label, status: p.status, origin: p.origin });

/**
 * Every continuity, its positions in order, and how much is placed in it.
 * Counts are named for their unit: a continuity with three positions and
 * twelve placed pieces is not "fifteen things".
 */
export function chronologyView(db) {
  const continuities = q(db).prepare('SELECT * FROM continuities ORDER BY created_at').all();
  return {
    continuityCount: continuities.length,
    continuities: continuities.map((c) => {
      const positions = q(db).prepare('SELECT * FROM continuity_positions WHERE continuity_id=? ORDER BY ordinal').all(c.id);
      const placements = q(db).prepare('SELECT status FROM entry_placements WHERE continuity_id=?').all(c.id);
      return {
        id: c.id, name: c.name, description: c.description, status: c.status, origin: c.origin,
        positionCount: positions.length,
        positions: positions.map((p) => ({
          ...positionShape(p),
          placedPieceCount: q(db).prepare('SELECT COUNT(*) c FROM entry_placements WHERE from_position_id=?').get(p.id).c,
        })),
        placedPieceCount: placements.length,
        approvedPlacementCount: placements.filter((x) => x.status === 'approved').length,
        proposedPlacementCount: placements.filter((x) => x.status !== 'approved').length,
      };
    }),
  };
}

/** The placements of a set of entries, keyed by entry id, each with its state. */
function placementsOf(db, entries) {
  const out = new Map();
  if (!entries.length) return out;
  const marks = entries.map(() => '?').join(',');
  const rows = q(db).prepare(`SELECT pl.*, p.ordinal, p.token, p.label, p.status AS position_status, c.name AS continuity_name
      FROM entry_placements pl
      JOIN continuity_positions p ON p.id = pl.from_position_id
      JOIN continuities c ON c.id = pl.continuity_id
     WHERE pl.entry_id IN (${marks})`).all(...entries.map((e) => e.id));
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const r of rows) {
    const list = out.get(r.entry_id) || [];
    list.push({
      continuityId: r.continuity_id, continuityName: r.continuity_name,
      from: { id: r.from_position_id, ordinal: r.ordinal, token: r.token, label: r.label },
      state: placementState(r, byId.get(r.entry_id)),
      origin: r.origin, status: r.status, confidence: r.confidence, evidence: parse(r.evidence, {}),
    });
    out.set(r.entry_id, list);
  }
  return out;
}

/**
 * For one source: which of its approved pieces are placed in time, and which
 * are not. A piece with no approved semantics is not counted as unplaced —
 * it is not yet anything, so when it is true is not yet a question.
 */
export function sourceChronology(db, lorebookId) {
  const entries = q(db).prepare('SELECT id, title, content, keys FROM lore_entries WHERE lorebook_id=? ORDER BY display_index').all(lorebookId);
  const approved = new Set(q(db).prepare(`SELECT s.entry_id FROM entry_semantics s JOIN lore_entries e ON e.id=s.entry_id
                                          WHERE e.lorebook_id=? AND s.status='approved'`).all(lorebookId).map((r) => r.entry_id));
  const placed = placementsOf(db, entries);
  const pieces = entries.map((e) => ({
    pieceId: e.id, title: e.title,
    semanticallyApproved: approved.has(e.id),
    placements: placed.get(e.id) || [],
  }));
  return {
    sourceId: lorebookId,
    totalPieceCount: pieces.length,
    approvedPieceCount: pieces.filter((p) => p.semanticallyApproved).length,
    placedPieceCount: pieces.filter((p) => p.placements.length).length,
    approvedUnplacedPieceCount: pieces.filter((p) => p.semanticallyApproved && !p.placements.length).length,
    recheckPlacementCount: pieces.reduce((n, p) => n + p.placements.filter((x) => x.state === 'recheck').length, 0),
    pieces,
  };
}

/**
 * For one entity: which of the knowledge that is its own has a place in time.
 * Ownership is the semantic model's — defines, or an approved subject — and
 * is read from there; nothing here decides whose a piece is.
 */
export function entityChronology(db, entityId) {
  const entries = q(db).prepare(`SELECT DISTINCT e.id, e.title, e.content, e.keys, s.category
      FROM lore_entries e JOIN entry_semantics s ON s.entry_id = e.id AND s.status = 'approved'
      LEFT JOIN entry_relations r ON r.entry_id = e.id AND r.relation = 'subject' AND r.status = 'approved'
     WHERE s.defines_entity_id = ? OR r.entity_id = ?`).all(entityId, entityId);
  const placed = placementsOf(db, entries);
  const knowledge = entries.map((e) => ({
    pieceId: e.id, title: e.title, category: e.category,
    placements: placed.get(e.id) || [],
  }));
  return {
    entityId,
    ownedPieceCount: knowledge.length,
    placedPieceCount: knowledge.filter((k) => k.placements.length).length,
    unplacedPieceCount: knowledge.filter((k) => !k.placements.length).length,
    knowledge: knowledge.sort((a, b) => {
      const oa = a.placements[0]?.from.ordinal; const ob = b.placements[0]?.from.ordinal;
      if (oa === undefined && ob === undefined) return 0;
      if (oa === undefined) return 1;
      if (ob === undefined) return -1;
      return oa - ob;
    }),
  };
}
