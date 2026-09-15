// Deciding when an old promise should come back.
//
// This is the whole reason the project exists, so it is worth being exact
// about why it works the way it does.
//
// Search-based memory cannot do this. Retrieval fires when your new message
// resembles the old one, so a promise nobody has mentioned in four hundred
// messages is never pulled back. It needs the opposite: something that grows
// more insistent the longer it is ignored, and a gate that keeps it quiet
// until the moment can carry it.

/**
 * How much an unfinished thread is pressing.
 * Rises towards 1 the longer it goes unaddressed, then flattens, so an old
 * thread stays available without ever completely taking over.
 */
import { isOpen } from './state.js';

export function pressure(thread, now, tau = 120) {
  const since = Math.max(0, now - Math.max(thread.opened || 0, thread.lastRaised || 0));
  return 1 - Math.exp(-since / tau);
}

/**
 * Whether this is a good moment, from things we can actually check.
 * No model call, no embeddings: presence, words on the page, and how tense
 * the scene is. Cheap enough to run every turn.
 */
const slug = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

export function fit(thread, { present = [], recentText = '', calm = true, where = '' }) {
  let score = 0;
  const here = new Set(present.map(slug));
  const need = (thread.needs || []).map(slug).filter(Boolean);
  const everyoneHere = need.length === 0 || need.every((who) => here.has(who));
  if (everyoneHere) score += 0.30;
  else return 0;                       // nobody to say it to

  const text = String(recentText).toLowerCase();
  const keys = (thread.keys || []).map((k) => String(k).toLowerCase());
  if (keys.some((k) => k && text.includes(k))) score += 0.25;

  if (calm) score += 0.20;
  if (thread.where && where && String(where).toLowerCase().includes(String(thread.where).toLowerCase())) score += 0.15;
  if (thread.owedBy && here.has(slug(thread.owedBy))) score += 0.10;

  return Math.min(1, score);
}

const TENSE = /\b(fight|fighting|attack|attacked|blood|bleeding|scream|screaming|explosion|gun|knife|villain|emergency|running|chase|panic|dying|dead)\b/i;

/**
 * A promise resurfacing lands. "What she will say next" resurfacing is
 * nonsense, so anything that shape has to clear a far higher bar.
 */
const KIND_WEIGHT = {
  promise: 1, vow: 1, debt: 0.95, 'secret-kept': 0.95, secret: 0.95,
  plan: 0.8, thread: 0.6, action: 0.5, instruction: 0.4,
  question: 0.35, scene: 0.2,
};
const kindWeight = (kind) => KIND_WEIGHT[String(kind || 'thread').toLowerCase()] ?? 0.6;

/** Threads that were never really debts, only the scene moving along. */
export function looksLikeSceneMomentum(thread) {
  const t = String(thread.text || '');
  const kind = String(thread.kind || '').toLowerCase();
  if (['promise', 'vow', 'debt', 'secret-kept', 'secret'].includes(kind)) return false;
  return /^\s*(what|whether|how|will|does|if|when)\b/i.test(t)
    || /\b(will (respond|react|say|do|wear|decide|agree|choose))\b/i.test(t);
}

/**
 * Pick at most one thread to offer the narrator this turn.
 *
 * At most one, deliberately. Handing a model three things to bring up
 * produces a reply that dutifully mentions all three, which reads nothing
 * like a person remembering something.
 */
export function threadsDue(state, {
  now = 0,
  present = [],
  recentText = '',
  where = '',
  threshold = 0.55,
  globalCooldown = 25,
  lastRaisedAnywhere = -Infinity,
} = {}) {
  if (now - lastRaisedAnywhere < globalCooldown) return [];

  const calm = !TENSE.test(recentText);
  const candidates = [];

  for (const [id, t] of Object.entries(state.threads || {})) {
    if (!isOpen(t)) continue;
    if (now < (t.cooldownUntil || 0)) continue;

    // Nobody brings up a four-hundred-message-old promise in the middle of a
    // fight. Tension blocks outright rather than merely scoring lower, unless
    // the scene is already about this thread, in which case it belongs there.
    if (!calm) {
      const text = String(recentText).toLowerCase();
      const onTopic = (t.keys || []).some((k) => k && text.includes(String(k).toLowerCase()));
      if (!onTopic) continue;
    }

    const f = fit(t, { present, recentText, calm, where });
    if (f === 0) continue;

    const p = pressure(t, now);
    const score = (t.weight ?? 0.6) * (0.55 * p + 0.45 * f) * kindWeight(t.kind);
    if (score >= threshold) candidates.push({ id, ...t, pressure: p, fit: f, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 1);
}

/** Everything the memory screen wants to show about why a thread is quiet. */
export function explainThread(thread, state, ctx) {
  const now = ctx.now ?? 0;
  const p = pressure(thread, now);
  const f = fit(thread, ctx);
  const score = (thread.weight ?? 0.6) * (0.55 * p + 0.45 * f);

  const reasons = [];
  if (!isOpen(thread)) reasons.push(`It is marked ${thread.status}.`);
  if (now < (thread.cooldownUntil || 0)) reasons.push(`Raised recently — resting until message ${thread.cooldownUntil}.`);
  const here = new Set((ctx.present || []).map(slug));
  const missing = (thread.needs || []).filter((who) => who && !here.has(slug(who)));
  if (missing.length) reasons.push(`${missing.join(' and ')} not in the scene.`);
  if (f > 0 && score < 0.55) reasons.push('Building, but not pressing enough yet.');

  return {
    pressure: Math.round(p * 100),
    fit: Math.round(f * 100),
    score: Math.round(score * 100),
    ready: score >= 0.55 && f > 0,
    why: reasons.length ? reasons.join(' ') : 'Ready to surface when the scene suits it.',
  };
}
