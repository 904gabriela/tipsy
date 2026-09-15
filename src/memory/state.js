// The world state: what is true right now, and how it got that way.
//
// The state is never stored as one mutable blob. Each message records only
// what it changed, and the state for any point in the story is those changes
// folded together along the path from the beginning to there.
//
// That is what makes branching work. Two paths through the tree fold to two
// different states without a single line of branch-handling code, because
// they simply fold different lists.

import { ladderOf, rungFor, ceilingFor, damp, renderStanding, gainScale } from './arc.js';

export function emptyState() {
  return {
    clock: { elapsed: 'P0D', display: '', lastSkip: null },
    characters: {},   // id -> { present, location, wearing, hurt, mood, wants, relations, reluctance }
    facts: {},        // id -> { text, knownBy[], secrecy, since, until, supersededBy }
    threads: {},      // id -> { kind, text, owedBy, owedTo, status, weight, opened, lastRaised, raiseCount, keys[] }
    places: {},       // id -> { name, note }
    scene: { where: '', who: [], note: '' },
  };
}

// Names survive whatever alphabet they are written in. The earlier version
// kept only a-z, which turned a Japanese name into an empty string and
// silently dropped that person from every list.
const slug = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

/** A short stable hash, so two facts with similar openings get distinct ids. */
function shortHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0').slice(0, 6);
}
const factId = (f, at) => f.id || `F${String(at).padStart(4, '0')}-${shortHash(slug(f.text))}`;
const arr = (v) => (Array.isArray(v) ? v : []);

// ---------------------------------------------------------------- threads
//
// An unfinished matter has three states and only three. The model is asked
// what happened to a thread and answers in its own words — "strengthened",
// "deepened", "still open, now in car after leaving Black Lotus" — and every
// one of those became a stored lifecycle state, so filtering for what is
// still owed missed most of it. What it says is kept, as a note; what is
// stored as status is one of these.

export const STATUS = { OPEN: 'open', RESOLVED: 'resolved', RETIRED: 'retired' };

/**
 * Is this still owed?
 *
 * Reads through whatever the status happens to say, so a story recorded
 * before the vocabulary existed — with "active", "strengthened", "still open,
 * now in car" — is counted correctly without rewriting a single stored row.
 */
export const isOpen = (t) => normalizeStatus(t?.status) === STATUS.OPEN;

export function normalizeStatus(raw, previous = null) {
  const s = String(raw ?? '').toLowerCase();
  if (!s) return previous || STATUS.OPEN;
  if (/\b(resolv|fulfil|done|kept|closed|complete|settled|answered|paid|delivered)/.test(s)) return STATUS.RESOLVED;
  if (/\b(retir|abandon|moot|obsolete|dropped|no longer|never mind|overtaken)/.test(s)) return STATUS.RETIRED;
  // in-progress, active, updated, deepened, strengthened, and any sentence at
  // all: still owed. The wording is kept in `note`, not in the status.
  return STATUS.OPEN;
}

const STOP = new Set(`a an the and or but of in on at to for with from by is are was were be been
being will would can could should may might must do does did what whether that this these those
he she it they them his her their its him who whom which why how about after before during over
under again once here there while because until not no yes has have had if then than so very just
more most other some such own same too own s t re ll ve d m`.split(/\s+/));

/**
 * What an unfinished matter is ABOUT, as a set of content words.
 *
 * The old identity hashed the exact sentence and stamped the message depth
 * into it, so the same promise raised at message 52 and again at 144 became
 * two threads with the same hash and different prefixes. Yours has one
 * question recorded eight times because of it.
 *
 * Matching on content words instead lets a rewording land on the same row,
 * while two different obligations — teaching someone to hide, and a trip to
 * Rome — share almost nothing and stay apart.
 */
export function threadWords(text) {
  return new Set(
    String(text || '').toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

/**
 * How much two matters are the same matter.
 *
 * Plain overlap is not enough on its own. "Patrick will take Reiko to Rome"
 * and "Patrick took Reiko to Rome last spring" are one promise and its
 * keeping, but the second says more, and counting shared words against the
 * total pushes them apart — which opened a second thread for something
 * already done.
 *
 * So a short matter wholly contained in a longer one counts as the same,
 * provided it is specific enough to mean anything: three content words at
 * least, or "Patrick will call" would swallow every promise he ever made.
 */
const overlap = (a, b) => {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const jaccard = shared / (a.size + b.size - shared);
  const smaller = Math.min(a.size, b.size);
  const containment = smaller >= 3 ? shared / smaller : 0;
  return Math.max(jaccard, containment);
};

/**
 * The thread this one already is, if any.
 *
 * Conservative on purpose: it must be owed by the same person and share most
 * of what it is about. Two obligations that merely happen in the same place
 * do not merge, and a resolved one is still matched — so that mentioning it
 * again updates it rather than opening a second copy of something already
 * done.
 */
export function findThread(threads, incoming, { floor = 0.6 } = {}) {
  const words = threadWords(incoming.text);
  const owed = slug(incoming.owedBy || '');
  let best = null;
  let bestScore = 0;
  for (const [id, t] of Object.entries(threads)) {
    if (owed && slug(t.owedBy || '') && slug(t.owedBy) !== owed) continue;
    const score = overlap(words, threadWords(t.text));
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return bestScore >= floor ? best : null;
}

// No message depth in the id. Identity is what the matter IS, so the same
// matter raised twice is the same row.
const threadId = (t) => t.id || `T-${shortHash(slug(t.text))}`;

/**
 * Fold one message's changes into the state.
 *
 * Deltas describe changes, never the whole picture, so an extractor that
 * says nothing about a character leaves that character exactly as they were.
 * That is deliberate: a model asked to restate everything every turn will
 * quietly drop things, and those drops look exactly like forgetting.
 */
export function applyDelta(state, delta, { messageId = null, at = 0, arc = null } = {}) {
  if (!delta || typeof delta !== 'object') return state;
  const s = state;

  // When a story has a ladder, closeness stops being whatever the model says
  // and becomes something we compute. See arc.js for why that has to be here
  // rather than in the prompt.
  const ladder = arc && arc.on !== false ? ladderOf(arc) : null;
  const scale = ladder ? gainScale(arc) : 1;
  // The slower of the two sets the pace. One person being easy to reach does
  // not make the other one easier.
  const reluctanceOf = (a, b) => Math.max(
    Number(arc?.reluctance?.[a]) || 0,
    Number(arc?.reluctance?.[b]) || 0,
  );
  const startingScore = (a, b) => Number(arc?.start?.[[a, b].sort().join('|')]) || 0;

  if (delta.clock) {
    if (delta.clock.elapsed) s.clock.elapsed = delta.clock.elapsed;
    if (delta.clock.display) s.clock.display = delta.clock.display;
    if (delta.clock.skipped) s.clock.lastSkip = { amount: delta.clock.skipped, at };
  }

  if (delta.scene) {
    // The extractor is told to leave these empty when nothing changed, so an
    // empty value is silence, not "nowhere" and "nobody".
    if (delta.scene.where) s.scene.where = delta.scene.where;
    if (Array.isArray(delta.scene.who) && delta.scene.who.length) s.scene.who = delta.scene.who.map(slug).filter(Boolean);
    if (delta.scene.note) s.scene.note = delta.scene.note;
  }

  for (const [rawId, patch] of Object.entries(delta.characters || {})) {
    const id = slug(rawId);
    if (!id) continue;
    const c = (s.characters[id] ||= {
      name: patch.name || rawId, present: false, location: '', wearing: '',
      hurt: [], mood: '', wants: '', relations: {}, reluctance: null, misses: 0,
    });
    c.misses = 0;
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) { delete c[k]; continue; }
      if (k === 'relations') {
        for (const [otherRaw, rel] of Object.entries(v || {})) {
          const other = slug(otherRaw);
          // Two people can start somewhere other than nowhere: a story that
          // was already running when the ladder arrived, or a history that
          // happened off the page. A floor they climb from, not a pin.
          const r = (c.relations[other] ||= {
            stage: '', score: startingScore(id, other), since: 0,
          });
          // A single dramatic message must not jump a relationship. The model
          // proposes a nudge; the size of that nudge is ours to decide.
          if (typeof rel.delta === 'number') {
            const capped = Math.max(-3, Math.min(3, rel.delta));
            const confidence = typeof rel.confidence === 'number' ? Math.max(0, Math.min(1, rel.confidence)) : 0.7;
            let gain = capped * (0.35 + 0.65 * confidence);
            // Kept as a fraction on purpose. Rounding each step to a whole
            // number means a heavily damped nudge rounds to nothing, and a
            // reluctant character never moves at all however long you try.
            if (ladder) gain = damp(gain, reluctanceOf(id, other)) * scale;
            r.score = Math.max(0, Math.min(100, (r.score || 0) + gain));
          }

          if (ladder) {
            // The rung is ours, computed from the score, and the score is
            // held one point below the next door until the time has been
            // served. This is what makes a stage impossible to skip.
            const was = rungFor(ladder, r.score);
            const ceiling = ceilingFor(ladder, Number.isFinite(r.rung) ? r.rung : was,
              Number.isFinite(r.since) ? r.since : 0, at);
            r.score = Math.min(r.score, ceiling);
            const nowRung = rungFor(ladder, r.score);
            if (nowRung !== r.rung) {
              r.rung = nowRung;
              r.stage = ladder[nowRung].name;
              r.since = at;
            }
            // Whatever the model called it survives as colour, never as the
            // authority on where they actually stand.
            if (rel.stage) r.note = rel.stage;
          } else {
            if (rel.stage && rel.stage !== r.stage) { r.stage = rel.stage; r.since = at; }
          }
          if (rel.note) r.note = rel.note;
        }
        continue;
      }
      if (k === 'hurt' && Array.isArray(v)) { c.hurt = v; continue; }
      c[k] = v;
    }
  }

  // Everyone the extractor did not mention ages by one. Left long enough
  // untouched they drop out of the sheet, which keeps it from growing
  // forever without ever asking a model to decide what to forget.
  const mentioned = new Set(Object.keys(delta.characters || {}).map(slug));
  for (const [id, c] of Object.entries(s.characters)) {
    if (!mentioned.has(id)) c.misses = (c.misses || 0) + 1;
  }

  for (const f of arr(delta.facts)) {
    if (!f || typeof f !== 'object' || !f.text) continue;
    const id = factId(f, at);
    const existing = s.facts[id];
    // A fact that contradicts an older one revokes it rather than sitting
    // beside it. Keeping both is measurably worse than having no memory,
    // because the stale one keeps resurfacing as if it were still true.
    if (f.supersedes && s.facts[f.supersedes]) {
      s.facts[f.supersedes].until = at;
      s.facts[f.supersedes].supersededBy = id;
    }
    s.facts[id] = {
      text: f.text,
      knownBy: [...new Set([...arr(existing?.knownBy), ...arr(f.knownBy).map(slug).filter(Boolean)])],
      secrecy: f.secrecy ?? existing?.secrecy ?? 0,
      veil: f.veil || existing?.veil || '',
      since: existing?.since ?? at,
      until: null,
      supersededBy: null,
      origin: existing?.origin ?? messageId,
    };
  }

  for (const k of arr(delta.knowledge)) {
    const f = k && s.facts[k.fact];
    if (!f) continue;
    f.knownBy = arr(f.knownBy);
    for (const who of arr(k.learnedBy).map(slug).filter(Boolean)) {
      if (!f.knownBy.includes(who)) f.knownBy.push(who);
    }
  }

  for (const t of arr(delta.threads)) {
    if (!t || typeof t !== 'object' || !t.text) continue;
    // The same matter raised again updates the row it already has.
    const id = t.id || findThread(s.threads, t) || threadId(t);
    const existing = s.threads[id];

    // Something already done does not come undone because it was mentioned.
    // Only an explicit resolution or retirement moves it off open.
    const asked = normalizeStatus(t.status, existing?.status);
    const status = existing?.status === STATUS.RESOLVED && asked === STATUS.OPEN
      ? STATUS.RESOLVED
      : asked;

    s.threads[id] = {
      kind: t.kind || 'thread',
      // A rewording of something already known is not an improvement on it.
      // The first phrasing is the one the story used when it happened.
      text: existing?.text || t.text,
      owedBy: slug(t.owedBy || '') || existing?.owedBy || '',
      owedTo: slug(t.owedTo || '') || existing?.owedTo || '',
      status,
      // What the model actually said about it, kept out of the lifecycle.
      note: t.status && normalizeStatus(t.status) !== String(t.status).toLowerCase()
        ? String(t.status).slice(0, 120)
        : existing?.note || '',
      // Every message that raised this matter, so nothing loses its source.
      seen: [...new Set([...(existing?.seen || []), messageId].filter(Boolean))].slice(-40),
      mentions: (existing?.mentions || 0) + 1,
      weight: typeof t.weight === 'number' ? Math.max(0, Math.min(1, t.weight)) : existing?.weight ?? 0.6,
      keys: Array.isArray(t.keys) ? t.keys : arr(existing?.keys),
      needs: Array.isArray(t.needs) ? t.needs : arr(existing?.needs),
      opened: existing?.opened ?? at,
      lastRaised: existing?.lastRaised ?? null,
      raiseCount: existing?.raiseCount ?? 0,
      cooldownUntil: existing?.cooldownUntil ?? 0,
      origin: existing?.origin ?? messageId,
    };
  }

  const justCreated = new Set(
    arr(delta.threads).filter((t) => t && t.text).map((t) => t.id || findThread(s.threads, t) || threadId(t))
  );

  for (const u of arr(delta.threadUpdates)) {
    const t = u && s.threads[u.id];
    if (!t) continue;
    // Opening a thread is not the same as returning to it. Without this a
    // promise made this turn immediately falls silent for forty messages.
    if (justCreated.has(u.id)) continue;
    if (u.status) {
      const asked = normalizeStatus(u.status, t.status);
      // Mentioning something already done does not undo it.
      t.status = t.status === STATUS.RESOLVED && asked === STATUS.OPEN ? STATUS.RESOLVED : asked;
      if (normalizeStatus(u.status) !== String(u.status).toLowerCase()) t.note = String(u.status).slice(0, 120);
    }
    if (u.raised) {
      t.lastRaised = at;
      t.raiseCount = (t.raiseCount || 0) + 1;
      // Raised and still unresolved? Back off further each time, so a thread
      // the story is ignoring stops nagging instead of repeating forever.
      t.cooldownUntil = at + 40 * t.raiseCount;
    }
    if (u.weight !== undefined) t.weight = Math.max(0, Math.min(1, u.weight));
  }

  return s;
}

/** Drop characters nobody has mentioned in a long while. */
export function evict(state, threshold = 8, keep = 14) {
  const entries = Object.entries(state.characters);
  for (const [id, c] of entries) {
    if ((c.misses || 0) > threshold && !c.present) delete state.characters[id];
  }
  const left = Object.entries(state.characters);
  if (left.length > keep) {
    left.sort((a, b) => (a[1].misses || 0) - (b[1].misses || 0));
    for (const [id] of left.slice(keep)) delete state.characters[id];
  }
  return state;
}

/**
 * Build the state as of a message, from the nearest snapshot forward.
 * @param {object} db
 * @param {string} messageId
 */
export function stateAt(db, messageId, { overrides = true, arc = undefined } = {}) {
  if (!messageId) return emptyState();
  const path = db.pathTo(messageId, 50000);
  if (!path.length) return emptyState();

  // Read once here rather than in the fold loop: a long story folds thousands
  // of deltas and each one would otherwise re-read the same settings row.
  const theArc = arc !== undefined ? arc
    : (db.arcFor ? db.arcFor(path[path.length - 1].story_id) : null);

  // Walk back from the end for the newest snapshot on this exact path.
  let startIndex = 0;
  let state = emptyState();
  for (let i = path.length - 1; i >= 0; i--) {
    const snap = db.getSnapshot(path[i].id);
    if (snap) { state = snap; startIndex = i + 1; break; }
  }

  for (let i = startIndex; i < path.length; i++) {
    const mem = db.getMessageMemory(path[i].id);
    if (mem && mem.delta) applyDelta(state, mem.delta, { messageId: path[i].id, at: i, arc: theArc });
  }

  // Hand corrections always win. Snapshots are written without them, so a
  // correction you later delete does not stay baked in.
  if (overrides) {
    for (const o of db.overridesFor(path[path.length - 1].story_id)) {
      if (o.after_id && !path.some((m) => m.id === o.after_id)) continue;  // other branch
      let value;
      try { value = o.value === null ? undefined : JSON.parse(o.value); } catch { continue; }
      setPath(state, o.path, value);
    }
  }

  return evict(state);
}

function setPath(obj, path, value) {
  const parts = String(path).split('/').filter(Boolean);
  // A correction to a fact, thread or person that is not on this branch
  // must not conjure a half-built one into being; it just does not apply here.
  if (['facts', 'threads', 'characters'].includes(parts[0]) && parts.length >= 3) {
    if (!obj[parts[0]] || !obj[parts[0]][parts[1]]) return;
  }
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (value === undefined) delete node[last];
  else node[last] = value;
}

// ---------------------------------------------------------------------------
// Turning the state into the block the model actually reads.

/**
 * Everything the model is told about the world right now.
 *
 * Two rules matter here and both come from measurement, not taste.
 * Only what a character DOES know is ever written down: telling a model what
 * someone must not mention reliably makes them mention it. And only people
 * actually in the scene get a full sheet, because the rest is noise.
 */
export function renderState(state, {
  threadsDue = [], cast = [], arc = null, openSecrets = null,
  // Who the player is, once a story knows. An imported conversation had no
  // persona when it was read, so the extractor had nothing to call you and
  // wrote "user". Resolving it here means the name appears everywhere it is
  // read from now on, without rewriting a single stored record — the history
  // says what it said, and the reading of it is corrected.
  playerName = '',
} = {}) {
  const out = [];
  const GENERIC = new Set(['user', 'them', 'you', 'player', 'protagonist']);
  const name = (id) => {
    if (playerName && GENERIC.has(String(id).toLowerCase())) return playerName;
    return state.characters[id]?.name || id.replace(/-/g, ' ');
  };
  const arcOn = !!(arc && arc.on !== false);

  if (state.clock.display) out.push(`NOW: ${state.clock.display}`);
  if (state.scene.where) out.push(`WHERE: ${state.scene.where}`);

  // The cast arrives as full names ("katsuki-bakugo") while the extractor
  // tends to use what the story calls people ("bakugo"), so match loosely.
  const inCast = (id) => cast.some((c) => c === id || c.includes(id) || id.includes(c));
  const onStage = Object.entries(state.characters)
    .filter(([id, c]) => c.present || state.scene.who.includes(id) || inCast(id));

  if (onStage.length) {
    const lines = onStage.map(([id, c]) => {
      const bits = [];
      if (c.location) bits.push(`at ${c.location}`);
      if (c.wearing) bits.push(`wearing ${c.wearing}`);
      if (c.hurt?.length) bits.push(`hurt: ${c.hurt.join(', ')}`);
      if (c.mood) bits.push(c.mood);
      if (c.wants) bits.push(`wants ${c.wants}`);
      // With a ladder in play the standing block below says where everyone
      // is, in order and with what that stage means. Repeating a bare stage
      // name here would only give the model a second, shorter answer to the
      // same question.
      if (!arcOn) {
        const rel = Object.entries(c.relations || {})
          .filter(([, r]) => r.stage)
          .map(([other, r]) => `${name(other)}: ${r.stage}`);
        if (rel.length) bits.push(`with ${rel.join('; ')}`);
      }
      const reluctance = typeof c.reluctance === 'number' ? c.reluctance
        : Number(arc?.reluctance?.[id]);
      if (Number.isFinite(reluctance) && reluctance > 0) bits.push(reluctanceWords(reluctance));
      return `  ${name(id)} — ${bits.join('. ') || 'here'}`;
    });
    out.push(`WHO IS HERE\n${lines.join('\n')}`);
  }

  if (arcOn) {
    const standing = renderStanding(state, arc, {
      present: onStage.map(([id]) => id),
      name,
    });
    if (standing) out.push(standing);
  }

  // The positive half of the knowledge ledger, and only that half. Every
  // live fact goes in, newest first. An earlier version showed only facts
  // whose knower happened to be on stage, and since the extractor omits
  // people who have not changed, most facts never reached the model at all.
  // A secret that is in the prompt is a secret that can slip out, whoever is
  // speaking. So when the gate is running, the hottest ones are held out of
  // the text entirely until this turn is judged to be about them, and only
  // their shape is left behind. See secrets.js.
  const held = openSecrets ? new Set(openSecrets) : null;
  const withheld = (id, f) => held && f.secrecy >= 2 && !held.has(id);

  const live = Object.entries(state.facts)
    .filter(([, f]) => f && !f.until)
    .sort((a, b) => (b[1].since ?? 0) - (a[1].since ?? 0));
  const known = live.filter(([id, f]) => arr(f.knownBy).length && !withheld(id, f));
  if (known.length) {
    const byWho = {};
    for (const [, f] of known.slice(0, 40)) {
      for (const who of f.knownBy) (byWho[who] ||= []).push(f.text);
    }
    const lines = Object.entries(byWho)
      .map(([who, texts]) => `  ${name(who)} knows: ${texts.slice(0, 10).join('; ')}`);
    out.push(`WHAT EACH PERSON CAN DRAW ON\n${lines.join('\n')}`);
  }

  const secrets = live.filter(([id, f]) => f.secrecy >= 1 && arr(f.knownBy).length && !withheld(id, f));
  if (secrets.length) {
    out.push(`NOT COMMON KNOWLEDGE\n${secrets.slice(0, 10).map(([, f]) =>
      `  ${f.text} — held by ${f.knownBy.map(name).join(', ')}`).join('\n')}\nThese are real, but only the people named above have them. They come out through someone choosing to say them, or through being discovered, never by accident.`);
  }

  // What is left of the withheld ones: that they exist, who is carrying them,
  // and nothing else. Enough to write someone being evasive, which everyone
  // in the room can see anyway, and not enough to say the thing out loud.
  if (held) {
    const veiled = live.filter(([id, f]) => withheld(id, f) && arr(f.knownBy).length);
    if (veiled.length) {
      const byWho = {};
      for (const [, f] of veiled.slice(0, 12)) {
        for (const who of f.knownBy) (byWho[who] ||= []).push(f.veil || 'something they have not said');
      }
      out.push(`CARRYING SOMETHING\n${Object.entries(byWho).map(([who, shapes]) =>
        `  ${name(who)} — ${[...new Set(shapes)].slice(0, 3).join('; ')}`).join('\n')}\nWhat these are is not written down here and you do not need it. Write the weight of it: the pause, the subject changed, the answer that is true and incomplete. Do not invent the content, and do not have anyone work it out.`);
    }
  }

  const open = Object.values(state.threads)
    .filter((t) => t && isOpen(t))
    .sort((a, b) => (b.opened ?? 0) - (a.opened ?? 0));
  if (open.length) {
    out.push(`STILL UNFINISHED\n${open.slice(0, 10).map((t) =>
      `  ${t.text}${t.owedBy ? ` (${name(t.owedBy)})` : ''}`).join('\n')}`);
  }

  if (threadsDue.length) {
    out.push(`WORTH RAISING NOW\n${threadsDue.map((t) =>
      `  ${t.text}${t.owedBy ? ` — ${name(t.owedBy)} has not come back to this` : ''}`).join('\n')}\nOne of these may surface this scene if the moment suits it. Do not force it.`);
  }

  return out.join('\n\n');
}

const reluctanceWords = (r) => {
  if (r >= 0.9) return 'will not say it unprompted, and resents being pushed';
  if (r >= 0.6) return 'reaches for honesty and stops short more often than not';
  if (r >= 0.3) return 'needs a reason before saying what they mean';
  return 'says what they mean';
};

export function stateSummaryForUi(state, { playerName = '' } = {}) {
  const live = Object.values(state.facts).filter((f) => !f.until);
  // The same resolution the prompt does: a story that has since been given a
  // persona reads its old generic records under that name, without a single
  // stored record being rewritten.
  const GENERIC = new Set(['user', 'them', 'you', 'player', 'protagonist']);
  const shown = (id, c) => (playerName && GENERIC.has(String(id).toLowerCase())
    ? { id, ...c, name: playerName, wasGeneric: true }
    : { id, ...c });
  return {
    clock: state.clock,
    scene: state.scene,
    characters: Object.entries(state.characters).map(([id, c]) => shown(id, c)),
    facts: Object.entries(state.facts).map(([id, f]) => ({ id, ...f })),
    threads: Object.entries(state.threads).map(([id, t]) => ({ id, ...t })),
    counts: {
      characters: Object.keys(state.characters).length,
      facts: live.length,
      retired: Object.keys(state.facts).length - live.length,
      threads: Object.values(state.threads).filter(isOpen).length,
      closed: Object.values(state.threads).filter((t) => !isOpen(t)).length,
    },
  };
}
