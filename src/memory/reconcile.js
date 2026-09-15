// Where are they NOW?
//
// The sequential extractor reads one exchange at a time and reports what
// changed. That is the right shape for history — it is how a story's facts,
// promises and relationships get written down without restating the world
// every turn — and it has one blind spot.
//
// A story moves people explicitly: "he takes her through to the bedroom."
// It also moves them implicitly: nobody narrates the walk, and four messages
// later the kitchen is simply where the scene is. Exchange by exchange, that
// second kind has no moment to notice. Read six messages together and it is
// obvious.
//
// So this is a second, narrow job, not a second memory system. It answers one
// question — where are they at the END of this window, and who is there — and
// it is told to leave the answer alone when the window does not settle it. It
// never touches facts, promises, relationships or summaries: those were
// already read properly, once each, in order.

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['changed'],
  properties: {
    changed: {
      type: 'boolean',
      description: 'True only if the excerpt clearly establishes a DIFFERENT place from the one you were given.',
    },
    location: {
      type: 'string',
      description: 'Where the characters are at the very END of the excerpt, written in full, e.g. "Patrick\'s penthouse, the kitchen". Empty when nothing has changed.',
    },
    locationConfidence: {
      type: 'string',
      description: 'high when the excerpt plainly happens there; medium when it is strongly implied; low when you are guessing.',
    },
    presentCharacters: {
      type: 'array',
      items: { type: 'string' },
      description: 'Only the people actually in the scene at the END of the excerpt. Not everyone mentioned, not people talked about, not people who left.',
    },
    time: {
      type: 'string',
      description: 'The in-story time at the end of the excerpt if the excerpt establishes it, e.g. "late night". Empty if it does not.',
    },
  },
};

const PROMPT = `You are given the last few messages of an ongoing story, and the place the story is currently recorded as being in.

Answer one question: where are the characters at the END of this excerpt?

Read the whole excerpt together, not message by message. A story does not always narrate people walking from one room to another — often the walk is skipped and a later passage simply happens somewhere else. If the closing messages plainly take place somewhere other than the recorded place, that is a change, even when no one described the journey.

What is NOT a change:
- somebody talking about another place
- a memory of something that happened elsewhere
- a place named inside quoted speech
- a plan to go somewhere later
- the excerpt's earlier messages, if the LAST ones have moved on

If the excerpt does not settle the question, say so: changed false, and leave the location empty. A recorded place that is merely stale is better than a place you invented. Never guess to fill the field.

For who is present: only the people actually in the scene at the end. Not everyone named, not people being discussed, not anyone who has left.

Report nothing else. No facts, no promises, no relationships, no summary.`;

/**
 * Reconcile the current scene against the last few canonical messages.
 *
 * @param {object[]} window  messages oldest-first: {role, content}
 * @param {object}   state   the state as reconstructed so far
 * @returns {{applied: boolean, before: string, after: string, reason: string, raw: object}}
 */
export async function reconcileScene({
  apiKey, model, window: win = [], state, persona = null, signal,
  providers = null, minConfidence = 'medium',
}) {
  const before = String(state?.scene?.where || '');
  if (!win.length) return { applied: false, before, after: before, reason: 'nothing recent to read', raw: null };

  const who = persona || 'THEM';
  const excerpt = win.map((m) => `${m.role === 'user' ? who : 'STORY'}: ${m.content}`).join('\n\n');

  const body = {
    model,
    temperature: 0,
    max_tokens: 600,
    reasoning: { enabled: false },
    response_format: { type: 'json_schema', json_schema: { name: 'scene', strict: false, schema: SCHEMA } },
    messages: [
      { role: 'system', content: PROMPT },
      { role: 'user', content: `RECORDED PLACE\n${before || '(nothing recorded)'}\n\nTHE LAST FEW MESSAGES\n${excerpt}\n\nWhere are they at the end of this?` },
    ],
  };
  if (providers) body.provider = providers;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Tipsy scene' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`The scene check failed (${res.status}).`);
  const json = await res.json();
  let raw;
  try { raw = JSON.parse(json.choices?.[0]?.message?.content || '{}'); } catch { raw = {}; }

  return applyReconciliation(state, raw, { before, minConfidence });
}

/**
 * The decision, kept separate from the call so it can be tested without one.
 *
 * Conservative by construction: a recorded place is only replaced when the
 * window says it changed, names somewhere, and is sure enough. Everything
 * else leaves the state exactly as the sequential pass left it.
 */
export function applyReconciliation(state, raw = {}, { before = '', minConfidence = 'medium' } = {}) {
  const rank = { low: 0, medium: 1, high: 2 };
  const said = String(raw.location || '').trim();
  const confidence = String(raw.locationConfidence || '').toLowerCase();
  const sure = (rank[confidence] ?? -1) >= (rank[minConfidence] ?? 1);

  const result = { applied: false, before, after: before, reason: '', raw, confidence };

  if (!raw.changed) { result.reason = 'the recent window does not move them'; }
  else if (!said) { result.reason = 'it said the place changed but did not name one'; }
  else if (!sure) { result.reason = `only ${confidence || 'unstated'} confidence, so the recorded place stands`; }
  else if (said.toLowerCase() === before.toLowerCase()) { result.reason = 'the same place, written again'; }
  else {
    state.scene.where = said;
    result.applied = true;
    result.after = said;
    result.reason = `the last messages happen there (${confidence})`;
  }

  // Presence and time are corrected alongside, and only when offered. The
  // same rule applies: silence leaves what was already there.
  if (Array.isArray(raw.presentCharacters) && raw.presentCharacters.length) {
    const slug = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
    state.scene.who = raw.presentCharacters.map(slug).filter(Boolean);
    result.who = state.scene.who;
  }
  if (String(raw.time || '').trim()) {
    state.clock.display = String(raw.time).trim();
    result.time = state.clock.display;
  }
  return result;
}

/** Enough recent turns to settle a scene, without dragging in an old one. */
export function sceneWindow(path, { turns = 8 } = {}) {
  return path.slice(-turns).map((m) => ({ role: m.role, content: m.content, depth: m.depth }));
}
