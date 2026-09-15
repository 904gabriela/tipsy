// Keeping a secret by not writing it down.
//
// Every other approach to this fails the same way. You put the secret in the
// prompt and add "Patrick does not know this", and one model in five has
// Patrick reference it within twenty messages — not because it disobeyed, but
// because the text was there and a plausible next sentence used it. The
// instruction is a speed bump; the presence of the words is the problem.
//
// So: two passes. A small cheap call reads the last exchange and decides
// whether this turn is actually about a given secret. If it is not, the
// secret's text never enters the story call at all, and only its shape does
// — enough to write someone holding something back, which is visible in the
// room anyway. If it is, the text goes in with who holds it.
//
// This runs before the reply, so it costs a little time. It only runs when
// there is a hot secret with its holder in the scene, which in practice is a
// minority of turns, and the call is two hundred tokens on a flash model.

const slug = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

export const SECRET_DEFAULTS = {
  on: true,
  model: 'deepseek/deepseek-v4-flash',
  /** Below this, a secret is merely private and is shown normally. */
  from: 2,
};

/**
 * The secrets worth gating this turn.
 *
 * Only ones actively hidden, still true, and with somebody holding them who
 * is in the scene. A secret whose holder is not here cannot slip out of
 * anybody's mouth, so there is nothing to gate and nothing to pay for.
 */
export function hotSecrets(state, { present = [], from = 2 } = {}) {
  // Loosely, on purpose. The cast list carries full names ("katsuki-bakugo")
  // and the extractor writes what the story calls people ("bakugo"). Matching
  // these exactly is how an earlier version of this silently found nobody
  // present and never ran at all.
  const here = present.map(slug).filter(Boolean);
  const isHere = (who) => {
    const w = slug(who);
    return !!w && here.some((h) => h === w || h.includes(w) || w.includes(h));
  };
  const out = [];
  for (const [id, f] of Object.entries(state.facts || {})) {
    if (!f || f.until) continue;
    if ((f.secrecy ?? 0) < from) continue;
    const holders = Array.isArray(f.knownBy) ? f.knownBy : [];
    if (!holders.length) continue;
    if (here.length && !holders.some(isHere)) continue;
    out.push({
      id,
      text: f.text,
      veil: f.veil || '',
      holders,
      since: f.since ?? 0,
    });
  }
  // Capped: one call each, run together, and a scene with more than a handful
  // of actively hidden things in it is not a scene the gate can help with.
  // Newest first, because a secret made this week is the one still live.
  return out.sort((a, b) => (b.since ?? 0) - (a.since ?? 0)).slice(0, 6);
}

const PROMPT = `You are a gatekeeper for one story's hidden information. You do not write the story. You decide one thing: is the moment about to be written actually about THIS ONE secret?

Answer YES only if one of these is plainly true:
  - somebody just asked about it directly, or asked a question it is the answer to
  - evidence of it has just surfaced where someone can see it
  - the person holding it has just decided to tell, or has started to
  - someone who does not know has said something that lands on it exactly

Answer NO for:
  - the subject coming up in passing
  - the holder being tense, evasive, or thinking about it
  - the scene being emotionally suited to a confession
  - it having been hidden a long time
  - a general conversation about honesty, trust, or the past
  - a DIFFERENT secret being the one in question

NO is the normal answer. Being wrong towards NO delays a reveal; being wrong towards YES spills something the story cannot take back.

Judge the LAST line of the exchange, the one marked as being answered. The lines before it are there only so you can read it. What they were about does not decide this.

The scene will not use the secret's own words, and matching words is not the test. A harbour is the docks. A transfer is a payment. "That week" can be the night in question. A photograph of someone somewhere is evidence they were there. Judge what is actually happening, and if the scene has plainly landed on the thing itself under another name, that is YES.

Answer exactly one word: YES or NO`;

/**
 * One call per secret, not one call for the list.
 *
 * Measured, and the difference is not small. Handed a lettered list and a
 * scene where exactly one secret should open, a flash model picks the first
 * item on the list regardless of which one the scene is about — the same
 * position bias that shows up in every ranking task. Asked about one secret
 * on its own, with nothing to compare it against, it gets it right.
 *
 * The calls run together, so two secrets cost the same wall-clock as one.
 * Fails closed throughout: an error, a timeout, an unreadable answer all mean
 * the secret stays out of the prompt.
 */
export async function gate({ apiKey, model, secrets, exchange = [], persona = null, signal }) {
  if (!secrets.length) return { open: [], asked: false, why: 'nothing hidden in this scene' };
  if (!apiKey) return { open: [], asked: false, why: 'no key' };

  const who = persona || 'THEM';
  // The last line is the one being answered, and it is the one that decides.
  // Left as an undifferentiated run of three, the judgement drifts toward
  // whatever the earlier two were about, and a direct question sitting at the
  // end of a conversation about something else reads as closed.
  const lines = exchange.slice(-3);
  const scene = lines
    .map((m, i) => {
      const speaker = m.role === 'user' ? who : 'STORY';
      const body = String(m.content).slice(0, 2000);
      return i === lines.length - 1
        ? `>>> THE LINE BEING ANSWERED, which is what you are judging <<<\n${speaker}: ${body}`
        : `${speaker}: ${body}`;
    })
    .join('\n\n');

  const askOne = async (s) => {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Tipsy secrets' },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 5,
          reasoning: { enabled: false },
          messages: [
            { role: 'system', content: PROMPT },
            {
              role: 'user',
              content: `THE SECRET\n${s.text}\nHeld by: ${s.holders.join(', ')}\n\nTHE LAST EXCHANGE\n${scene}\n\nIs this moment about that secret?`,
            },
          ],
        }),
        signal,
      });
      if (!res.ok) return { id: s.id, open: false, error: `status ${res.status}` };
      const json = await res.json();
      const text = String(json.choices?.[0]?.message?.content ?? '').trim();
      return { id: s.id, open: /^\s*yes\b/i.test(text), usage: json.usage };
    } catch (e) {
      // Deliberately quiet and deliberately closed. A gate that opens when
      // something is wrong opens at exactly the worst moment.
      return { id: s.id, open: false, error: e.message };
    }
  };

  const verdicts = await Promise.all(secrets.map(askOne));
  const open = verdicts.filter((v) => v.open).map((v) => v.id);
  const errors = verdicts.filter((v) => v.error);

  return {
    open,
    asked: true,
    checked: secrets.length,
    why: errors.length ? `${errors.length} of ${secrets.length} could not be checked, so they stayed shut`
      : open.length ? 'the scene has reached them'
        : 'nothing in this scene reaches them',
    error: errors[0]?.error || null,
    usage: verdicts.reduce((a, v) => ({
      prompt_tokens: (a.prompt_tokens || 0) + (v.usage?.prompt_tokens || 0),
      completion_tokens: (a.completion_tokens || 0) + (v.usage?.completion_tokens || 0),
      cost: (a.cost || 0) + (v.usage?.cost || 0),
    }), {}),
  };
}

/** Whether it is worth paying for a gate call at all this turn. */
export function shouldGate(settings, secrets) {
  const cfg = { ...SECRET_DEFAULTS, ...(settings.secrets || {}) };
  return cfg.on && secrets.length > 0;
}
