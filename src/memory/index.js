// The memory engine, as the server uses it.

import { stateAt, emptyState, applyDelta, stateSummaryForUi, isOpen, STATUS, normalizeStatus } from './state.js';
import { threadsDue, explainThread, looksLikeSceneMomentum } from './threads.js';
import { extract, summarise, keysFor } from './extract.js';
import { hotSecrets, gate, shouldGate, SECRET_DEFAULTS } from './secrets.js';
import { ladderOf, standingSummary, respace, ARC_DEFAULTS, DEFAULT_LADDER } from './arc.js';

export { stateAt, emptyState, stateSummaryForUi, threadsDue, explainThread };
export { hotSecrets, gate, shouldGate, SECRET_DEFAULTS };
export { ladderOf, standingSummary, respace, ARC_DEFAULTS, DEFAULT_LADDER };
// Reconstructing a story's history and settling where its scene is now are
// two different jobs. This is the second one.
export { reconcileScene, sceneWindow, applyReconciliation } from './reconcile.js';

/**
 * Threads that were never really debts.
 *
 * An earlier version of the extractor treated every open narrative question
 * as unfinished business, so a long story ended up with a hundred of them and
 * "what she does next" competed with a promise made three hundred messages
 * ago. This finds those, so they can be closed with your say-so. It never
 * touches a promise, a debt or a secret, however old.
 */
export function tidyable(db, headId) {
  const state = stateAt(db, headId);
  const now = db.pathTo(headId).length;
  const out = [];
  for (const [id, t] of Object.entries(state.threads || {})) {
    if (!isOpen(t)) continue;
    if (!looksLikeSceneMomentum(t)) continue;
    // Still recent enough to matter is left alone; this is about the tail.
    const age = now - (t.opened || 0);
    if (age < 20) continue;
    out.push({ id, text: t.text, kind: t.kind, age, opened: t.opened, weight: t.weight });
  }
  return out.sort((a, b) => b.age - a.age);
}

export const MEMORY_DEFAULTS = {
  on: true,
  model: 'deepseek/deepseek-v4-flash',
  snapshotEvery: 25,       // write the whole state down this often
  foldAfter: 40,           // start folding once this many messages sit outside the window
  foldSize: 10,            // messages per folded scene
  verbatimFloor: 20,       // never fold anything this recent
  proposeLore: true,
  // Which companies' machines may serve that model. Null means the measured
  // defaults in extract.js, which exist because two of them return records
  // that parse perfectly and contain nothing.
  providers: null,
};

const slug = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

// Long enough that no real story hits it. Anything shorter silently loses
// the oldest part of the path, and with it every scene folded from there.
const WHOLE = 50000;

/**
 * What memory contributes to this turn's prompt.
 * Cheap: no model calls, just folding what has already been written down.
 */
export function memoryFor(db, storyId, headId, { cast = [], settings = {}, openSecrets = null } = {}) {
  const cfg = { ...MEMORY_DEFAULTS, ...(settings.memory || {}) };
  if (!cfg.on) return null;

  const state = stateAt(db, headId);
  const path = db.pathTo(headId, WHOLE);
  const now = path.length;

  const recent = path.slice(-4).map((m) => m.content).join('\n');
  const present = [
    ...(state.scene.who || []),
    ...Object.entries(state.characters).filter(([, c]) => c.present).map(([id]) => id),
    ...cast.map(slug),
  ];

  const lastRaised = Math.max(-Infinity, ...Object.values(state.threads)
    .map((t) => t.lastRaised ?? -Infinity));

  const due = threadsDue(state, {
    now,
    present: [...new Set(present)],
    recentText: recent,
    where: state.scene.where,
    lastRaisedAnywhere: lastRaised,
  });

  // Only scenes that cover messages now outside the verbatim window.
  const windowStart = Math.max(0, path.length - (settings.historyLimit ?? 60));
  const olderIds = new Set(path.slice(0, windowStart).map((m) => m.id));
  const episodes = db.episodesOnPath(headId)
    .filter((e) => e.covers.some((id) => olderIds.has(id)));

  const coveredIds = new Set();
  for (const e of episodes) for (const id of e.covers) coveredIds.add(id);

  return {
    state, threadsDue: due, episodes, coveredIds: [...coveredIds], now,
    present: [...new Set(present)],
    openSecrets,
  };
}

/**
 * Read the newest exchange and write down what changed.
 * Runs after the reply has already been sent, so it never delays the story.
 */
export async function remember(db, { storyId, messageId, apiKey, settings = {}, cast = [], persona = null }) {
  const cfg = { ...MEMORY_DEFAULTS, ...(settings.memory || {}) };
  if (!cfg.on || !apiKey) return null;
  if (db.getMessageMemory(messageId)) return null;

  const path = db.pathTo(messageId, WHOLE);
  if (!path.length) return null;

  // The reply and the message it answered, which is the smallest unit that
  // makes sense: a reply on its own has no idea what prompted it.
  const exchange = path.slice(-2).map((m) => ({ role: m.role, content: m.content }));
  const parent = path[path.length - 2];
  const state = stateAt(db, parent ? parent.id : null);

  const { delta, raw, usage, model } = await extract({
    apiKey, model: cfg.model, exchange, state, cast, persona,
    providers: cfg.providers,
  });

  db.saveMessageMemory(messageId, storyId, {
    summary: delta.summary,
    delta,
    extracted: {
      newNames: raw.newNames || [],
      usage,
    },
    model,
  });

  // Write the whole state down now and then, so jumping to a branch later is
  // a short walk rather than replaying the story from the beginning.
  // Without hand corrections, so deleting a correction later really undoes it.
  const depth = path.length;
  if (depth % cfg.snapshotEvery === 0) {
    db.saveSnapshot(messageId, storyId, stateAt(db, messageId, { overrides: false }));
  }

  return { delta, newNames: raw.newNames || [], usage };
}

/**
 * Fold scenes that have fallen out of the window.
 *
 * The rule that matters: a message must be covered by the verbatim window or
 * by a folded scene. Never neither. A gap there is invisible from the outside
 * and the story quietly gets built on a hole.
 */
export async function fold(db, { storyId, headId, apiKey, settings = {}, persona = null }) {
  const cfg = { ...MEMORY_DEFAULTS, ...(settings.memory || {}) };
  if (!cfg.on || !apiKey) return { folded: 0, failed: 0 };

  const path = db.pathTo(headId, WHOLE);
  const keep = Math.max(cfg.verbatimFloor, settings.historyLimit ?? 60);
  const outside = path.length - keep;
  if (outside < cfg.foldAfter) return { folded: 0, failed: 0 };

  const covered = new Set();
  for (const e of db.episodesOnPath(headId)) for (const id of e.covers) covered.add(id);

  const uncovered = path.slice(0, outside).filter((m) => !covered.has(m.id));
  if (uncovered.length < 2) return { folded: 0, failed: 0 };

  // Whole batches first, then whatever is left as one short final scene, so
  // that nothing sits outside the window with no scene covering it.
  const batches = [];
  let i = 0;
  for (; i + cfg.foldSize <= uncovered.length; i += cfg.foldSize) batches.push(uncovered.slice(i, i + cfg.foldSize));
  if (uncovered.length - i >= 2) batches.push(uncovered.slice(i));

  let folded = 0;
  let failed = 0;
  for (const batch of batches) {
    const chainHash = batch[batch.length - 1].chain_hash + ':' + batch.length;
    let content = '';
    for (let attempt = 0; attempt < 2 && !content; attempt++) {
      try {
        ({ content } = await summarise({
          apiKey, model: cfg.model, persona,
          messages: batch.map((m) => ({ role: m.role, content: m.content })),
        }));
      } catch { content = ''; }
    }
    if (!content) { failed++; continue; }   // reported, never silently skipped
    db.saveEpisode(storyId, {
      layer: 0,
      chainHash,
      content,
      covers: batch.map((m) => m.id),
      anchorId: batch[batch.length - 1].id,
      keys: keysFor(content),
    });
    folded++;
  }
  return { folded, failed };
}

/** Anything on this path that neither the window nor a scene covers. */
export function gaps(db, headId, historyLimit = 60) {
  const path = db.pathTo(headId, WHOLE);
  const keep = Math.max(0, path.length - historyLimit);
  const covered = new Set();
  for (const e of db.episodesOnPath(headId)) for (const id of e.covers) covered.add(id);
  const missing = path.slice(0, keep).filter((m) => !covered.has(m.id));
  return { missing: missing.length, total: path.length, outsideWindow: keep };
}

/** Catch up a story that was played before memory was switched on. */
export async function backfill(db, { storyId, headId, apiKey, settings = {}, cast = [], persona = null, onProgress }) {
  const todo = db.unreadOnPath(headId, WHOLE);
  let done = 0;
  let consecutiveFailures = 0;
  let lastError = null;
  let stoppedEarly = false;
  for (const m of todo) {
    try {
      await remember(db, { storyId, messageId: m.id, apiKey, settings, cast, persona });
      done++;
      consecutiveFailures = 0;
      if (onProgress) onProgress(done, todo.length);
    } catch (e) {
      // One unreadable exchange should not stop the rest. Three in a row is
      // not a bad exchange, it is a bad key, no credit, or a dead model, and
      // every later call would fail the same way.
      lastError = e.message;
      if (++consecutiveFailures >= 3) { stoppedEarly = true; break; }
    }
  }
  const f = await fold(db, { storyId, headId, apiKey, settings, persona });
  return { read: done, of: todo.length, folded: f.folded, foldFailed: f.failed, stoppedEarly, lastError };
}

/** Turn names the story invented into lore entries you can accept or reject. */
export function loreProposals(db, storyId, headId) {
  const path = db.pathTo(headId, WHOLE);
  const seen = new Map();
  for (const m of path) {
    const mem = db.getMessageMemory(m.id);
    for (const n of mem?.extracted?.newNames || []) {
      if (!n.name) continue;
      const key = slug(n.name);
      if (!seen.has(key)) seen.set(key, { name: n.name, about: n.about || '', firstSeen: m.id, times: 0 });
      seen.get(key).times++;
    }
  }
  return [...seen.values()].sort((a, b) => b.times - a.times);
}
