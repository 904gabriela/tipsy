// The slow burn, as machinery rather than as an instruction.
//
// Telling a model to "take it slow" does not work for long. It complies for
// twenty messages, then a single charged scene arrives and the relationship
// jumps four stages in one reply, because nothing in the prompt can stop it.
//
// So the pacing is not advice here. It is a ladder the story climbs, and the
// rung is computed by us, from a number the model can only nudge. The model
// is told where two people stand; it is never the thing that decides.
//
// Two gates, and both have to open:
//   closeness  — a score that only moves a little per exchange
//   time       — messages that have to pass at the current rung first
//
// The second matters more than it looks. Without it an intense night of
// writing can still run the whole ladder, because closeness is all the model
// is pushing on. With it, the story has to actually be long.

/** A rung is {name, at, dwell, note, notYet}. Ordered, lowest first. */
export const DEFAULT_LADDER = [
  {
    name: 'strangers',
    at: 0,
    dwell: 0,
    note: 'They do not know each other. Everything is surface: what is said is what is meant, and neither goes looking for more.',
    notYet: 'Nothing has been risked between them yet.',
  },
  {
    name: 'circling',
    at: 10,
    dwell: 25,
    note: 'They have noticed each other. There is interest and neither will name it. Conversation finds reasons to keep going.',
    notYet: 'Neither has admitted to wanting anything from the other.',
  },
  {
    name: 'an understanding',
    at: 22,
    dwell: 45,
    note: 'Something unspoken has settled between them. They read each other well enough to skip explanations. Touch, if it happens, is brief and deniable.',
    notYet: 'Nothing has been said out loud, and either of them could still walk away clean.',
  },
  {
    name: 'close',
    at: 40,
    dwell: 60,
    note: 'They trust each other with things they do not hand out. Being near each other is a relief rather than a charge.',
    notYet: 'Neither has said what they actually want.',
  },
  {
    name: 'wanting',
    at: 60,
    dwell: 80,
    note: 'It is no longer deniable, to themselves or to each other. What holds them back now is a choice, not ignorance.',
    notYet: 'They have not acted on it.',
  },
  {
    name: 'together',
    at: 80,
    dwell: 80,
    note: 'They have acted on it and stayed. What they are is settled; what it costs them is not.',
    notYet: '',
  },
];

export const ARC_DEFAULTS = {
  on: true,
  ladder: DEFAULT_LADDER,
  /** slug -> 0..1. How hard this person is to get close to. */
  reluctance: {},
  /** Higher is slower. 1 is the calibrated default; 2 takes twice as long. */
  pace: 1,
};

/**
 * How much of a raw nudge becomes closeness.
 *
 * Measured, not guessed, and measured twice. Fourteen real exchanges from a
 * running romance were re-read by the extractor, which reported 1.86 points
 * of raw movement per exchange. This number is set so that that rate crosses
 * the whole ladder in roughly five hundred messages at the default pace —
 * long enough to be a slow burn, short enough to actually arrive.
 *
 * The first calibration was done against an extractor that was barely
 * reporting relationships at all, and was four times too generous as a
 * result. Worth remembering if the extractor ever changes again: this number
 * is only meaningful next to a measurement of what it actually reports.
 *
 * The dwell gates sit underneath as a floor, so a story that pushes as hard
 * as the extractor is allowed to still cannot arrive early.
 */
export const GAIN = 0.08;
export const gainScale = (arc) => GAIN / Math.max(0.25, Math.min(5, Number(arc?.pace) || 1));

const slug = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

/** The ladder, always usable: sorted, deduped, and starting at zero. */
export function ladderOf(arc) {
  const raw = Array.isArray(arc?.ladder) && arc.ladder.length ? arc.ladder : DEFAULT_LADDER;
  const rungs = raw
    .filter((r) => r && String(r.name || '').trim())
    .map((r) => ({
      name: String(r.name).trim(),
      at: Math.max(0, Math.min(100, Number(r.at) || 0)),
      dwell: Math.max(0, Number(r.dwell) || 0),
      note: String(r.note || ''),
      notYet: String(r.notYet || ''),
    }))
    .sort((a, b) => a.at - b.at);
  if (!rungs.length) return DEFAULT_LADDER;
  rungs[0] = { ...rungs[0], at: 0, dwell: 0 };   // you always start somewhere
  return rungs;
}

/**
 * Spread thresholds and waiting times evenly across however many stages
 * there are, so nobody ever has to type a number to add one.
 *
 * The top rung lands at 80 rather than 100 deliberately: the last stretch of
 * a ladder should be reachable in a story someone actually finishes.
 */
export function respace(names) {
  const n = Math.max(1, names.length);
  const TOP = 80;
  const FLOOR = 290;                 // messages before the top is possible
  return names.map((r, i) => ({
    name: String(r.name || `stage ${i + 1}`).trim(),
    note: String(r.note || ''),
    notYet: String(r.notYet || ''),
    at: i === 0 ? 0 : Math.round((TOP * i) / (n - 1 || 1)),
    dwell: i === 0 ? 0 : Math.round(FLOOR / (n - 1 || 1)),
  }));
}

/** Which rung a score sits on. */
export function rungFor(ladder, score) {
  let i = 0;
  for (let k = 0; k < ladder.length; k++) if (score >= ladder[k].at) i = k;
  return i;
}

/**
 * The ceiling a relationship may reach right now.
 *
 * This is the whole gate. You cannot pass the next rung's threshold until
 * you have spent `dwell` messages on the one you are standing on, so a score
 * that wants to run ahead is simply held one point short of the door.
 *
 * @param {object[]} ladder
 * @param {number}   current  the rung they are on
 * @param {number}   since    the message index they reached it at
 * @param {number}   now      the message index being applied
 */
export function ceilingFor(ladder, current, since, now) {
  const next = ladder[current + 1];
  if (!next) return 100;                                  // top of the ladder
  const waited = now - (Number.isFinite(since) ? since : 0);
  if (waited >= next.dwell) return 100;                   // the door is open
  return Math.max(0, next.at - 1);                        // held just below it
}

/**
 * How much of a nudge actually lands.
 *
 * Reluctance damps moving closer and leaves pulling away alone, because a
 * guarded person does not take longer to be hurt. This is the dial that
 * makes one character a slow burn and another not, without touching the
 * ladder everyone shares.
 */
export function damp(gain, reluctance = 0) {
  if (gain <= 0) return gain;
  const r = Math.max(0, Math.min(1, Number(reluctance) || 0));
  // At the top of the dial, twice as long. Further than that and a character
  // stops being hard to reach and simply never arrives, which reads as the
  // engine being broken rather than as them being guarded.
  return gain * (1 - 0.5 * r);
}

/** What the model is told about the ladder. Cached: this never changes mid-story. */
export function renderLadder(arc) {
  if (!arc || arc.on === false) return '';
  const ladder = ladderOf(arc);
  const lines = ladder.map((r, i) => `${i + 1}. ${r.name}${r.note ? ` — ${r.note}` : ''}`);
  return `# How closeness works here
Every relationship in this story sits on one of these, in order. Stages are not skipped and they are not hurried: reaching the next one takes time on the page, not one good conversation. A single charged scene moves things a little. It does not move things a stage.

${lines.join('\n')}

You will be told below where each pair currently stands. Write them there. If a scene pushes toward something further along the list, let it push and let it not arrive.`;
}

/**
 * Where each pair stands, for the volatile block.
 *
 * Only pairs involving someone in the scene, and only where a rung above the
 * first has been reached, so a story with one relationship in it does not
 * carry a wall of "strangers".
 */
export function renderStanding(state, arc, { present = [], name = (id) => id } = {}) {
  if (!arc || arc.on === false) return '';
  const ladder = ladderOf(arc);
  const here = new Set(present.map(slug));
  const lines = [];
  const seen = new Set();

  for (const [id, c] of Object.entries(state.characters || {})) {
    for (const [other, r] of Object.entries(c.relations || {})) {
      const pair = [id, other].sort().join('|');
      if (seen.has(pair)) continue;
      if (here.size && !here.has(id) && !here.has(other)) continue;
      seen.add(pair);

      const i = rungFor(ladder, r.score || 0);
      const rung = ladder[i];
      const next = ladder[i + 1];
      if (i === 0 && !r.note) continue;

      let line = `  ${name(id)} and ${name(other)} — ${rung.name}.`;
      if (rung.note) line += ` ${rung.note}`;
      if (next && rung.notYet) line += ` ${rung.notYet}`;
      // Whatever the record called it, quoted so it reads as colour and not
      // as a second, looser answer to where they stand.
      if (r.note) line += ` The record calls it "${r.note}".`;
      lines.push(line);
    }
  }

  if (!lines.length) return '';
  return `WHERE PEOPLE STAND\n${lines.join('\n')}`;
}

/** Everything the slow-burn screen wants to show, in plain numbers. */
export function standingSummary(state, arc, now = 0) {
  const ladder = ladderOf(arc);
  const out = [];
  const seen = new Set();
  for (const [id, c] of Object.entries(state.characters || {})) {
    for (const [other, r] of Object.entries(c.relations || {})) {
      const pair = [id, other].sort().join('|');
      if (seen.has(pair)) continue;
      seen.add(pair);
      const i = rungFor(ladder, r.score || 0);
      const next = ladder[i + 1] || null;
      const since = Number.isFinite(r.since) ? r.since : 0;
      const waited = now - since;
      const ceiling = ceilingFor(ladder, i, since, now);
      out.push({
        a: id,
        b: other,
        score: Math.round(r.score || 0),
        stage: ladder[i].name,
        rung: i,
        of: ladder.length,
        next: next ? next.name : null,
        needs: next ? next.at : null,
        waited,
        dwell: next ? next.dwell : 0,
        held: !!(next && ceiling < next.at),
        messagesLeft: next ? Math.max(0, next.dwell - waited) : 0,
        note: r.note || '',
      });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

export { slug as arcSlug };
