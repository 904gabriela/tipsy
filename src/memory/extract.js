// Watching the story and writing down what changed.
//
// This runs after every reply, on a separate cheap model, and never touches
// the prose. It reports changes only: an extractor asked to restate the whole
// world every turn will quietly drop things, and a dropped fact is
// indistinguishable from forgetting.
//
// The model doing this must be uncensored. Not for the sake of it, but
// because a model that sanitises its input will silently euphemise exactly
// the plot-critical details this whole system exists to keep.

/** In order of how completely they filled the record. See the note in extract(). */
export const PREFERRED_PROVIDERS = ['Baidu', 'Wafer', 'DeepInfra', 'Venice'];
/**
 * Return a clean, parseable, empty record, which is worse than an error
 * because nothing downstream can notice. Re-check with
 * `node scripts/check-memory-model.js` if the memory ever feels thin.
 */
export const AVOID_PROVIDERS = ['Alibaba', 'AtlasCloud', 'NextBit', 'StreamLake'];

export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string', description: 'One sentence: what happened in this exchange. Plain and concrete.' },
    clock: {
      type: 'object', additionalProperties: false,
      properties: {
        display: { type: 'string', description: 'Human reading of the in-story time now, e.g. "Day 14, evening". Empty if unknown or unchanged.' },
        skipped: { type: 'string', description: 'If time jumped, how much, e.g. "two weeks". Otherwise empty.' },
      },
    },
    scene: {
      type: 'object', additionalProperties: false,
      properties: {
        // "Empty if unchanged" on its own produced empty every single time,
        // including for "he walks her through to the bedroom". The scene then
        // stayed in a bathroom for two hundred messages while the story moved
        // through the whole flat. Leaving it out has to be the narrow case,
        // and moving has to be named as the thing that requires an answer.
        where: {
          type: 'string',
          description: 'Where the scene is happening NOW, at the end of this exchange. Compare it with the "Place:" line you were given. If anyone moved at all — another room, outside, a different building, into or out of a vehicle — write the new place in full, e.g. "Patrick\'s apartment, the kitchen". Leave this empty ONLY when they are still in exactly the place you were given. Somebody TALKING about another place, or remembering something that happened elsewhere, is not a move: leave it empty then.',
        },
        who: { type: 'array', items: { type: 'string' }, description: 'Everyone physically present now.' },
      },
    },
    characters: {
      type: 'array',
      description: 'Only characters whose situation actually changed. Leave out anyone unchanged.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string' },
          present: { type: 'boolean' },
          location: { type: 'string' },
          wearing: { type: 'string' },
          hurt: { type: 'array', items: { type: 'string' } },
          mood: { type: 'string', description: 'How this character feels right now, in a few words. About them, never about your own task.' },
          wants: { type: 'string', description: 'What this character is trying to get in this scene, in a few words, e.g. "an answer from Reiko" or "to leave without being asked why". Never write about the story, the reader, or your own job.' },
          relations: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['toward'],
              properties: {
                toward: { type: 'string' },
                delta: { type: 'number', description: 'How much closer or further this exchange moved them, between -3 and 3. Most exchanges are 0 or 1.' },
                stage: { type: 'string', description: 'Only if the nature of the relationship genuinely changed, e.g. "guarded honesty".' },
                confidence: { type: 'number', description: '0 to 1. How sure you are.' },
              },
            },
          },
        },
      },
    },
    // Top level on purpose, not nested inside each character.
    //
    // It lived under characters[].relations first, and measured against 128
    // real exchanges the extractor filled it three times. A deeply nested
    // optional array is one a model skips. The same information asked for as
    // its own top-level list gets answered.
    relations: {
      type: 'array',
      description: 'How the people in this scene now stand with each other. Include EVERY pair who were both present, even when nothing moved between them — a delta of 0 is the normal answer and still belongs here. Leaving a pair out loses the only record the story keeps of two people getting closer.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['from', 'toward', 'delta'],
        properties: {
          from: { type: 'string', description: 'Whose feeling this is.' },
          toward: { type: 'string', description: 'Who it is about.' },
          delta: { type: 'number', description: 'How far this exchange moved them, -3 to 3. 0 for an ordinary exchange, which is most of them. 1 for a real moment: something admitted, a kindness, a wound, a line crossed or refused. 2 or 3 only when a scene changes where they stand for good. Negative when it pushed them apart.' },
          stage: { type: 'string', description: 'A few words for what is between them now, e.g. "guarded honesty". Only when it genuinely reads differently than before.' },
          confidence: { type: 'number', description: '0 to 1. How sure you are.' },
        },
      },
    },
    facts: {
      type: 'array',
      description: 'Concrete things this exchange established. Be generous: an injury, an object someone now has, where someone lives, a refusal, something admitted, something seen. If a detail would matter two hundred messages later, record it. Only new ones.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['text', 'knownBy'],
        properties: {
          text: { type: 'string', description: 'The fact in one plain line, e.g. "Bakugo refused to promise he would not go after Todoroki alone" or "Bakugo has a bandaged right hand".' },
          knownBy: { type: 'array', items: { type: 'string' }, description: 'Everyone who now knows this. If it happened openly in front of people, that is everyone present. Never list who does not know.' },
          secrecy: { type: 'number', description: '0 anyone present saw it and nobody minds who else learns it. 1 private: not announced, but not guarded either. 2 actively hidden: somebody would be harmed or exposed if this reached the wrong person, or it was told in confidence, or someone is lying to keep it in. If in doubt between 1 and 2, and somebody would suffer for it coming out, choose 2.' },
          veil: { type: 'string', description: 'Only for secrecy 2, and leave it out otherwise. A short phrase naming the SUBJECT the holder avoids, not the secret and not this moment. Always of the form "will not talk about X" or "goes quiet whenever X comes up", where X is the topic, e.g. "will not talk about the year she was away". Never the thing being hidden. Never a description of what just happened in the scene.' },
          supersedes: { type: 'string', description: 'Id of a fact this makes untrue, if any.' },
        },
      },
    },
    knowledge: {
      type: 'array',
      description: 'Existing facts that someone newly learned this exchange.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['fact', 'learnedBy'],
        properties: {
          fact: { type: 'string', description: 'The id of the existing fact.' },
          learnedBy: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    threads: {
      type: 'array',
      description: 'Debts the story has taken on. Almost every exchange creates NONE. Only record something that would still be unresolved, and would still matter, fifty messages from now. Never record what happens next in this scene.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['text', 'kind'],
        properties: {
          kind: { type: 'string', description: 'promise, debt, secret-kept, vow, or plan. Use "plan" only for something arranged for a later day.' },
          text: { type: 'string', description: 'One line, concrete, naming who owes what to whom.' },
          owedBy: { type: 'string' },
          owedTo: { type: 'string' },
          weight: { type: 'number', description: '0 to 1. How much the story would suffer if this were never returned to.' },
          keys: { type: 'array', items: { type: 'string' }, description: 'Words that would naturally come up when this becomes relevant.' },
          needs: { type: 'array', items: { type: 'string' }, description: 'Only the people who must be physically in the scene for this to be raised naturally, normally the one who owes it and the one owed. Do not list people the thread is merely about.' },
        },
      },
    },
    threadUpdates: {
      type: 'array',
      description: 'Existing threads that moved this exchange.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string' },
          status: { type: 'string', description: 'open, in-progress, kept, broken, or dropped.' },
          raised: { type: 'boolean', description: 'True if this exchange actually brought it up.' },
        },
      },
    },
    newNames: {
      type: 'array',
      description: 'People named in this exchange who are not already in the cast or the lore.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string' },
          about: { type: 'string', description: 'Everything the story has established about them so far, in a line or two.' },
        },
      },
    },
  },
  required: ['summary'],
};

export const PROMPT = `You keep the records for an ongoing story. You do not write the story and you never comment on it. You read the last exchange and write down what changed, as data.

Rules that matter:

Report only what CHANGED. If a character's situation is the same as it was, leave them out entirely. Never restate the world.

One exception, and it is important: anyone who SPOKE or ACTED in this exchange has changed something, even if only their mood, and belongs in the characters list. A scene with two people talking in it that reports no characters at all has not been read.

For knowledge, record only who DOES know something. Never record who does not know, never phrase anything as an absence. That list is kept elsewhere and writing it here makes it leak.

Secrecy is not about how dramatic something is, it is about what happens if the wrong person hears it. Told in confidence is secrecy 2. Someone lying to cover it is secrecy 2. A crime, an affair, a debt, a real name, who somebody works for: secrecy 2 the moment anyone would be harmed by it travelling. A confession is still secrecy 2 after it has been confessed, because the person told is now keeping it too.

When something is being actively hidden, mark it secrecy 2 and give it a veil.

A veil names the SUBJECT the holder steers away from, as a standing habit, in one short phrase. "Will not talk about the docks." "Goes quiet whenever her brother comes up." That is the whole form.

Three ways to get it wrong. "Is hiding that she was at the docks that night" is the secret again in a quieter voice. "Leans close and speaks too quietly for anyone else to hear" describes this one moment rather than a standing habit. "Something happened" names nothing at all and is useless. The veil is the only part of a hidden fact the story is normally allowed to see, so it has to be both safe on its own and worth having.

Leave veil out entirely for anything that is not secrecy 2. Never write "none" or "n/a" in it.

Whenever two people are in a scene together and anything passes between them, report the relation between them. A delta of 0 is a perfectly good answer and you should use it often. What is wrong is leaving the pair out: that does not say "nothing happened", it says the exchange was not read, and the story loses the only record it has of two people getting closer.

The sizes: 0 for an ordinary exchange. 1 for a real moment — something admitted, a kindness, a wound, a line crossed or refused. 2 or 3 only for a scene that changes where two people stand for good.

Do not try to pace the story. You are not the one deciding how fast anybody gets close: the app takes your number, shrinks it, and holds it against how long the story has actually run. Your job is to report what you saw, honestly and at the right size. Holding back here does not make a slow burn, it makes a blank record.

A thread is a debt the story has taken on, and they are RARE. Most exchanges create none at all. Before recording one, apply this test: would it still be unresolved, and would it still matter, fifty messages from now? If the next few lines will settle it, it is not a thread.

These ARE threads: a promise made and not yet kept; a lie that will need maintaining; a secret one person is holding from another; a debt owed; something arranged for a later day.

These are NOT threads, and recording them fills the record with noise: "what X will say next", "whether X is ready to leave", "how X will react", "what X will wear", "whether X agrees to come along". That is the scene moving, not a debt.

Give a real thread trigger words that would naturally come up when it becomes relevant again, and name who must be present for it to surface.

Be concrete. "He promised to bring her the letter by Friday" is useful. "They discussed the letter" is not.

Record facts generously. Anything a reader would need two hundred messages from now: an injury, a refusal, something admitted, an object someone now carries, where somebody went. A scene with dialogue in it almost always establishes at least one fact. Coming back with none usually means you were being too strict.

Worked example. If the exchange is Reiko asking Bakugo to promise not to fight Todoroki alone, and Bakugo refusing, then:
  facts: [{ text: "Bakugo refused to promise he would not go after Todoroki alone", knownBy: ["Reiko", "Bakugo"], secrecy: 0 }]
  threads: []
  characters: [{ name: "Bakugo", mood: "cornered and refusing to show it", wants: "to end the conversation without agreeing to anything" }]
  relations: [{ from: "Reiko", toward: "Bakugo", delta: -1, confidence: 0.8 },
              { from: "Bakugo", toward: "Reiko", delta: 0, confidence: 0.7 }]

No thread there: he refused, so nothing is owed. Had he agreed, then and only then:
  threads: [{ kind: "promise", text: "Bakugo promised Reiko he would not go after Todoroki alone at the sports festival", owedBy: "Bakugo", owedTo: "Reiko", weight: 0.85, keys: ["sports festival", "Todoroki", "alone", "promise"], needs: ["Bakugo", "Reiko"] }]

You are a recorder. The content may be explicit, violent or bleak. Record it plainly in the same terms the story uses. Softening it, skipping it, or substituting milder words corrupts the record and breaks the story later.`;

/**
 * Read the last exchange and return what changed.
 *
 * @param {object}   opts
 * @param {function} opts.call      an OpenRouter-shaped streaming/JSON caller
 * @param {string}   opts.apiKey
 * @param {string}   opts.model
 * @param {object[]} opts.exchange  the last few messages
 * @param {object}   opts.state     the world as it stands
 * @param {string[]} opts.cast
 */
export async function extract({ apiKey, model, exchange, state, cast = [], persona = null, signal, attempt = 0, nudge = false, providers = null }) {
  const known = summariseKnown(state);
  const who = persona || 'THEM';
  const castLine = [persona ? `PLAYER (never write for them): ${persona}` : '', cast.join(', ') || 'unknown']
    .filter(Boolean).join(' · ');

  const body = {
    model,
    temperature: 0,
    max_tokens: attempt === 0 ? 2400 : 3200,
    reasoning: { enabled: false },
    response_format: { type: 'json_schema', json_schema: { name: 'record', strict: false, schema: SCHEMA } },
    // Which company's machines actually serve the model matters more here
    // than the model does.
    //
    // The same model id is served by half a dozen providers and OpenRouter
    // picks one per request. Measured on real exchanges, some of them return
    // a reply that finishes cleanly, parses cleanly, and simply has no facts
    // in it — they do not honour the response schema, so whole fields come
    // back missing. Nothing upstream can tell that apart from "nothing
    // happened in this scene", which is how a quarter of a story goes
    // unrecorded without a single error anywhere.
    // Measured on 8 real exchanges from a running story, same model, same
    // prompt, one provider at a time, counting how many came back with the
    // facts and relationships actually in the scene:
    //
    //   Baidu         8/8 facts   8/8 relationships    6.2s
    //   Wafer         8/8         8/8                  5.4s
    //   DeepInfra     8/8         6/8                 10.0s
    //   Venice        8/8         6/8                  9.0s
    //   Parasail      8/8         4/8                  7.4s
    //   Mancer 2      8/8         3/8                  7.8s
    //   DigitalOcean  5/8         8/8                 80.9s
    //   StreamLake    3/8         8/8                  5.9s
    //   Alibaba       0/8         0/8                  1.8s
    //   AtlasCloud    0/8         0/8                  2.5s
    //   NextBit       0/6         0/6                  3.3s
    //   (routed automatically) 5/8  5/8               13.5s
    //
    // Fallbacks stay on, so a bad day for one provider is a slower reply
    // rather than a lost one, but the two that return empty records are
    // never used.
    provider: {
      order: providers?.order?.length ? providers.order : PREFERRED_PROVIDERS,
      ignore: providers?.ignore?.length ? providers.ignore : AVOID_PROVIDERS,
      require_parameters: true,
    },
    messages: [
      { role: 'system', content: PROMPT },
      {
        role: 'user',
        content: `THE WORLD AS IT STANDS\n${known}\n\nCAST: ${castLine}\n\nTHE LAST EXCHANGE\n${exchange.map((m) => `${m.role === 'user' ? who : 'STORY'}: ${m.content}`).join('\n\n')}\n\nWrite down what changed.${
          nudge ? '\n\nThis exchange has things in it that a reader would need later. Your last attempt recorded none of them. Fill in the facts array.' : ''}`,
      },
    ],
  };

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Tipsy memory' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`The memory pass failed (${res.status}). ${detail.slice(0, 160)}`);
  }

  const json = await res.json();
  const text = json.choices?.[0]?.message?.content ?? '';
  const parsed = safeParse(text);

  if (!parsed) {
    // Almost always the reply ran out of room. Ask once more with more of it.
    if (attempt === 0) {
      return extract({ apiKey, model, exchange, state, cast, persona, signal, attempt: 1, providers });
    }
    const err = new Error('The memory pass returned something unreadable.');
    err.sample = text.slice(0, 300);
    err.finish = json.choices?.[0]?.finish_reason;
    throw err;
  }

  // A summary describing something happening, with an empty facts list under
  // it, is the extractor losing the exchange rather than there being nothing
  // in it. Measured at about one run in four on a flash model, which over a
  // long story is a quarter of everything simply never written down. One
  // retry with the omission pointed out fixes nearly all of them.
  const lost = !nudge
    && String(parsed.summary || '').trim().length > 25
    && !(parsed.facts || []).length
    && !(parsed.threads || []).length
    && !(parsed.characters || []).length;
  if (lost) {
    const second = await extract({ apiKey, model, exchange, state, cast, persona, signal, nudge: true, providers })
      .catch(() => null);
    if (second && second.delta.facts.length) return { ...second, nudged: true };
  }

  return { delta: toDelta(parsed), raw: parsed, usage: json.usage, model: json.model, recovered: attempt > 0 };
}

/**
 * Get JSON out of whatever came back.
 *
 * Three things go wrong in practice and all three are recoverable. The model
 * wraps the object in prose or a code fence. It adds a trailing comma. Or it
 * runs out of room mid-object and the text simply stops, which is the common
 * one on a long exchange.
 */
function safeParse(text) {
  const attempt = (s) => { try { return JSON.parse(s); } catch { return null; } };

  let out = attempt(text);
  if (out) return out;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) { out = attempt(fenced[1]); if (out) return out; }

  const first = text.indexOf('{');
  if (first < 0) return null;
  const body = text.slice(first);

  const last = body.lastIndexOf('}');
  if (last > 0) { out = attempt(body.slice(0, last + 1)); if (out) return out; }

  return repairTruncated(body);
}

/**
 * Close a cut-off object. Walk the text tracking strings and nesting, drop
 * whatever partial value was being written, and shut the brackets that are
 * still open. A record missing its last field beats no record at all.
 */
function repairTruncated(text) {
  const stack = [];
  let inString = false;
  let escaped = false;

  // Every point where the text was between complete values, remembered along
  // with how deep the nesting was there. Closing with the depth measured at
  // the END of a truncated string would add the wrong number of brackets.
  const cutPoints = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length) cutPoints.push({ at: i + 1, close: [...stack] });
    } else if (ch === ',' && stack.length) {
      cutPoints.push({ at: i, close: [...stack] });
    }
  }

  const candidates = [];
  if (!inString) candidates.push(text + stack.slice().reverse().join(''));
  // Newest first: keep as much of the record as will still parse.
  for (const p of cutPoints.reverse()) {
    candidates.push(text.slice(0, p.at) + p.close.slice().reverse().join(''));
  }

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* try the next shape */ }
  }
  return null;
}

/** The schema is shaped for a model to fill in; the state wants it keyed. */
function toDelta(r) {
  const characters = {};
  for (const c of r.characters || []) {
    if (!c.name) continue;
    const patch = { name: c.name };
    for (const k of ['present', 'location', 'wearing', 'mood', 'wants']) {
      if (c[k] !== undefined && c[k] !== '') patch[k] = c[k];
    }
    if (Array.isArray(c.hurt)) patch.hurt = c.hurt;
    if (Array.isArray(c.relations) && c.relations.length) {
      patch.relations = {};
      for (const rel of c.relations) {
        if (!rel.toward) continue;
        patch.relations[rel.toward] = {
          delta: rel.delta, stage: rel.stage, confidence: rel.confidence,
        };
      }
    }
    characters[c.name] = patch;
  }

  // The top-level list is the one the extractor reliably fills; the nested
  // form above is still read so an older record keeps working.
  for (const rel of r.relations || []) {
    if (!rel || !rel.from || !rel.toward) continue;
    const c = (characters[rel.from] ||= { name: rel.from });
    c.relations ||= {};
    c.relations[rel.toward] = {
      ...(c.relations[rel.toward] || {}),
      delta: rel.delta, stage: rel.stage, confidence: rel.confidence,
    };
  }

  return {
    summary: r.summary || '',
    clock: r.clock || {},
    scene: r.scene || {},
    characters,
    facts: (r.facts || []).map((f) => {
      // Models fill an optional field rather than leave it out, so "none" and
      // "n/a" arrive as if they were veils and would be shown to the story.
      const veil = /^\s*(none|n\/a|null|-)?\s*$/i.test(f.veil || '') ? '' : f.veil;
      // A veil is the thing you only write for something being hidden. When
      // one arrives on a fact scored 0, the number is the mistake, not the
      // veil: measured, the extractor reliably writes "shuts down any talk of
      // the locker" and then marks the confession it belongs to as open.
      const secrecy = veil && (f.secrecy ?? 0) < 2 ? 2 : (f.secrecy ?? 0);
      return { text: f.text, knownBy: f.knownBy || [], secrecy, veil, supersedes: f.supersedes };
    }),
    knowledge: (r.knowledge || []).map((k) => ({ fact: k.fact, learnedBy: k.learnedBy || [] })),
    threads: (r.threads || []).map((t) => ({
      kind: t.kind, text: t.text, owedBy: t.owedBy, owedTo: t.owedTo,
      weight: t.weight, keys: t.keys || [],
      needs: t.needs || [t.owedBy, t.owedTo].filter(Boolean),
    })),
    threadUpdates: r.threadUpdates || [],
    newNames: r.newNames || [],
  };
}

/** A compact picture of the world, so the extractor knows what already exists. */
function summariseKnown(state) {
  const lines = [];
  const name = (id) => state.characters[id]?.name || id;

  if (state.clock.display) lines.push(`Time: ${state.clock.display}`);
  if (state.scene.where) lines.push(`Place: ${state.scene.where}`);

  const people = Object.entries(state.characters).slice(0, 12);
  if (people.length) {
    lines.push('People: ' + people.map(([id, c]) =>
      `${c.name || id}${c.present ? ' (here)' : ''}`).join(', '));
  }

  const facts = Object.entries(state.facts).filter(([, f]) => !f.until).slice(0, 25);
  if (facts.length) {
    lines.push('Established:\n' + facts.map(([id, f]) =>
      `  [${id}] ${f.text} — known to ${f.knownBy.map(name).join(', ') || 'nobody yet'}`).join('\n'));
  }

  const threads = Object.entries(state.threads)
    .filter(([, t]) => t.status === 'open' || t.status === 'in-progress').slice(0, 20);
  if (threads.length) {
    lines.push('Unfinished:\n' + threads.map(([id, t]) =>
      `  [${id}] ${t.text} (${t.status})`).join('\n'));
  }

  return lines.join('\n') || 'Nothing recorded yet. This is the beginning.';
}

// ---------------------------------------------------------------------------

const SUMMARY_PROMPT = `You compress scenes for an ongoing story's records. Given a run of messages, write what happened in a short paragraph.

Keep every concrete thing: names, what was promised and by whom, what was decided, what was revealed, where it happened, injuries, gifts, arrivals and departures. Those are the only reason this record exists.

Drop the prose itself. No atmosphere, no description, no dialogue quoted at length.

Never soften. If something explicit, violent or ugly happened, say so plainly. A record that flinches is a record that lies, and the story will be built on it later.

Write only the paragraph.`;

/** Fold a run of messages into one scene, for when the story outgrows the window. */
export async function summarise({ apiKey, model, messages, persona = null, signal }) {
  const who = persona || 'THEM';
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Tipsy memory' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 700,
      reasoning: { enabled: false },
      messages: [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: messages.map((m) => `${m.role === 'user' ? who : 'STORY'}: ${m.content}`).join('\n\n') },
      ],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Could not fold that scene (${res.status}).`);
  const json = await res.json();
  return {
    content: (json.choices?.[0]?.message?.content ?? '').trim(),
    usage: json.usage,
  };
}

/** Words that should pull a scene back when they come up again. */
export function keysFor(text) {
  const stop = new Set('the a an and or but of in on at to for with from by is are was were be been this that they them his her their it its he she you your not no'.split(' '));
  const counts = new Map();
  for (const m of String(text).matchAll(/\b([A-Z][a-z]{2,}(?:[ \t]+[A-Z][a-z]{2,})?)\b/g)) {
    const term = m[1].replace(/^(The|A|An) /, '').trim();
    if (!term || stop.has(term.toLowerCase())) continue;
    counts.set(term, (counts.get(term) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
}
