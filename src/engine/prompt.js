// Building the text that gets sent.
//
// The order here is not cosmetic. Providers cache a prompt by its prefix: the
// longest run of bytes at the front that has not changed since last time is
// billed at roughly a tenth of the normal rate. So everything stable goes
// first and never moves, and everything that changes per message goes last,
// after the conversation.
//
// Putting the volatile block at the front instead would re-bill the entire
// world on every single message. On a long story that is the difference
// between a few dollars a month and a few hundred.

import { activate } from './lorebook.js';
import { POSITION } from '../import/lorebook.js';
import { renderState } from '../memory/state.js';
import { renderLadder } from '../memory/arc.js';
import { renderScript } from './script.js';

export const estimateTokens = (s) => Math.ceil(String(s || '').length / 4);

/**
 * {{char}}, {{user}} and friends, as every card in the wild expects.
 *
 * `stable` is set for the cached half of the prompt. There, {{random}} and
 * {{roll}} are left alone: expanding them would give every request a
 * different prefix and quietly switch the cache off.
 */
export function substitute(text, { char = '', user = '', original = '', stable = false } = {}) {
  let out = String(text || '')
    .replace(/\{\{char\}\}/gi, char)
    .replace(/\{\{user\}\}/gi, user)
    .replace(/<BOT>/gi, char)
    .replace(/<USER>/gi, user)
    .replace(/\{\{original\}\}/gi, original)
    .replace(/\{\{newline\}\}/gi, '\n')
    .replace(/\{\{trim\}\}/gi, '')
    .replace(/\{\{\/\/[^}]*\}\}/g, '')           // {{// comments}} are for you, not the model
    .replace(/\{\{comment:[^}]*\}\}/gi, '');
  if (!stable) {
    out = out
      .replace(/\{\{random:([^}]*)\}\}/gi, (_, list) => {
        const opts = list.split(/::|,/).map((s) => s.trim()).filter(Boolean);
        return opts.length ? opts[Math.floor(Math.random() * opts.length)] : '';
      })
      .replace(/\{\{roll:d?(\d+)\}\}/gi, (_, n) => String(1 + Math.floor(Math.random() * Number(n))));
  }
  return out;
}

const DEFAULT_CONTRACT = `You are writing an ongoing story with one other person. They write their own character; you write everyone and everything else.

Never write dialogue, actions, thoughts or decisions for their character. Stop and let them answer.

Write in flowing prose. Vary your sentence lengths. Stay inside the scene: no summarising what just happened, no tidy closing line, no reaching for a hopeful note the scene has not earned. If a moment is ugly or unresolved, leave it that way.

Do not repeat phrasings you have already used. Do not restate what the other person just said before responding to it.`;

const HARD_RULE = `One rule overrides everything above. The person you are writing with plays their own character. Never write their dialogue, their actions, their thoughts or their choices, and never repeat their last message back at them before responding. Write your reply and stop, so they can answer.`;

/**
 * Assemble everything.
 *
 * Returns the message array to send, plus a full account of what went in and
 * what it cost, so the app can show you rather than make you guess.
 */
export function buildPrompt({
  story,
  characters = [],
  persona = null,
  history = [],            // oldest first: {role, content}
  loreEntries = [],
  settings = {},
  timers = { sticky: {}, cooldown: {} },
  authorNote = '',
  memory = null,           // { state, threadsDue, episodes, coveredIds }
  // 'impersonate' asks for YOUR next line instead of theirs; 'continue' asks
  // for more of the last reply, to be glued onto its end.
  mode = null,
  // The world this story stands in, if it stands in one. Referenced, never
  // copied: editing it reaches the next message of every story using it, and
  // reaches none of their history.
  framework = null,
}) {
  const s = {
    contract: DEFAULT_CONTRACT,
    directions: '',
    historyLimit: 60,
    loreBudget: 6000,
    scanDepth: 3,
    recursive: true,
    includeNames: false,
    ...settings,
  };

  const lead = characters[0] || null;
  const names = {
    char: lead ? (lead.nickname || lead.name) : '',
    user: persona ? persona.name : 'You',
  };
  // Two flavours: one for the frozen block, one for everything after it.
  const subStable = (t, original = '') => substitute(t, { ...names, original, stable: true });
  const sub = (t) => substitute(t, names);
  const slugName = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

  // Which lore fires. Scanned newest first, which is how keywords are found.
  const recent = [...history].reverse().map((m) => ({
    role: m.role,
    name: m.role === 'user' ? names.user : names.char,
    content: m.content,
  }));

  const lore = activate(loreEntries, recent, {
    budget: s.loreBudget,
    scanDepth: s.scanDepth,
    recursive: s.recursive,
    includeNames: s.includeNames,
    messageCount: history.length,
    timers,
    countTokens: estimateTokens,
  });

  // ---- the frozen half -----------------------------------------------------
  // Anything below changes only when you edit the story's cast or settings.
  // It must not contain the date, a random value, or anything per-message.

  const stable = [];

  // A script preset writes the whole prompt itself, with holes in it that the
  // controls fill. When there is one, it replaces our own contract and
  // directions entirely — two sets of instructions about voice and pacing in
  // the same prompt is how you get a model that follows neither.
  const script = s.script && Array.isArray(s.script.items) ? s.script : null;
  let scripted = null;
  if (script) {
    const constantLoreText = lore.entries.filter((e) => e.constant).map((e) => e.content).join('\n\n');
    const firedLoreText = lore.entries.filter((e) => !e.constant).map((e) => e.content).join('\n\n');
    const now = new Date();
    const lastOf = (role) => [...history].reverse().find((m) => m.role === role)?.content || '';
    const sep = script.exampleSeparator || '***';
    // <START> is how every card in the wild marks the break between example
    // exchanges; the preset gets to choose what that break looks like.
    const examples = (t) => String(t || '').split(/<START>/i)
      .map((b) => b.trim()).filter(Boolean).map((b) => `${sep}\n${b}`).join('\n\n');

    scripted = renderScript(script, s.dials || {}, {
      sub: (t) => subStable(t),
      history,
      slots: {
        character: characters.map((c) => [
          `# ${c.nickname || c.name}`,
          c.description, c.personality && `## Personality\n${c.personality}`,
          c.scenario && `## Setting\n${c.scenario}`,
          c.example_dialogue && `## How they speak\n${examples(c.example_dialogue)}`,
        ].filter(Boolean).join('\n\n')).join('\n\n---\n\n'),
        persona: persona ? [persona.name, persona.description].filter(Boolean).join('\n') : '',
        lorebook: [constantLoreText, firedLoreText].filter(Boolean).join('\n\n'),
        memory: (memory?.episodes || []).map((e) => e.content).join('\n\n'),

        // The newest turns, as inline copies. The turns themselves still ride
        // the conversation; these take nothing away from it.
        lastMessage: history[history.length - 1]?.content || '',
        lastUserMessage: lastOf('user'),
        lastCharMessage: lastOf('assistant'),

        // Read as they substitute, like SillyTavern's. That is exactly why
        // any block holding one is kept out of the cached half.
        time: now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
        isotime: now.toTimeString().slice(0, 5),
        date: now.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }),
        isodate: now.toISOString().slice(0, 10),
        weekday: now.toLocaleDateString(undefined, { weekday: 'long' }),

        // The card, field by field, for a preset that wants tighter control
        // than the whole-sheet blob gives it.
        description: lead?.description || '',
        personality: lead?.personality || '',
        scenario: lead?.scenario || '',
        charFirstMessage: lead?.first_message || '',
        mesExamples: examples(lead?.example_dialogue),
        mesExamplesRaw: lead?.example_dialogue || '',
        charPrompt: lead?.system_prompt || '',
        charInstruction: lead?.post_history_instructions || '',
        charVersion: lead?.spec || '',
        charCreatorNotes: lead?.creator_notes || '',
        // Not a column of its own; cards that carry it keep it in the file
        // they arrived as, which is stored whole.
        charCreator: (() => {
          try { return JSON.parse(lead?.original || '{}')?.data?.creator || ''; } catch { return ''; }
        })(),
      },
    });
    for (const block of scripted.before) stable.push(block.content);
  }

  // A card may bring its own instructions, and they replace our general
  // guidance about voice and pacing. But one rule is never theirs to
  // override: whoever you are writing with owns their own character. Cards
  // written for other apps routinely forget this, and the result is a reply
  // that answers on your behalf before you have said anything.
  if (!script) {
    if (lead && lead.system_prompt) {
      // {{original}} in a card means "whatever the app would have said here".
      stable.push(`${subStable(lead.system_prompt, s.contract)}\n\n${HARD_RULE}`);
    } else {
      stable.push(s.contract);
    }
  }
  // ---- the world this story stands in --------------------------------------
  //
  // Three different kinds of thing, kept as three blocks rather than one, and
  // each capped. A campaign module can be twenty thousand words long; sending
  // all of it would not make the model know the world better, it would push
  // everything else further from the end of the prompt and cost a fortune
  // doing it.
  //
  // The caps are token counts, and what goes first when there is not room is
  // decided here rather than by whatever happened to be longest:
  //   the narrator rules are how to run the place and are kept;
  //   the world is what the place is, and is trimmed;
  //   the ensemble examples are the first thing dropped entirely.
  const world = {
    included: [], dropped: [], trimmed: [], tokens: 0,
  };
  if (framework) {
    const cap = (text, limit, what) => {
      const t = String(text || '').trim();
      if (!t) return '';
      if (estimateTokens(t) <= limit) return t;
      // Cut on a paragraph so the block ends on a whole thought.
      const parts = t.split(/\n\n+/);
      const kept = [];
      let used = 0;
      for (const para of parts) {
        const cost = estimateTokens(para);
        if (used + cost > limit) break;
        kept.push(para);
        used += cost;
      }
      world.trimmed.push({ what, from: estimateTokens(t), to: used || limit });
      return kept.join('\n\n') || t.slice(0, limit * 4);
    };

    const narrator = cap(framework.narrator, s.frameworkNarratorBudget ?? 900, 'narrator rules');

    // Card authors routinely write the same rule twice — once in the
    // description and again in the system prompt — and both of those become
    // parts of a world here. Sending it twice does not make it truer; it
    // makes the prompt longer and the model's attention worse. So a line that
    // is already in the narrator rules comes out of the world description,
    // because the rules are where a rule belongs.
    const ruleLines = new Set(
      String(narrator || '').split('\n').map((l) => l.trim()).filter((l) => l.length >= 30)
    );
    let deduped = 0;
    const worldSource = String(framework.world || '').split('\n').filter((line) => {
      if (!ruleLines.has(line.trim())) return true;
      deduped++;
      return false;
    }).join('\n').replace(/\n{3,}/g, '\n\n');
    if (deduped) world.trimmed.push({ what: 'lines already in the narrator rules', from: deduped, to: 0 });

    const worldText = cap(worldSource, s.frameworkWorldBudget ?? 1500, 'world');

    // What the place IS. Read before the story's own premise, because the
    // premise happens inside it.
    if (worldText) {
      // Not "# The world": always-on lore already owns that heading further
      // down, and two blocks under one name read as one contradictory block.
      stable.push(`# The world we are in\n${subStable(worldText)}`);
      world.included.push('world');
      world.tokens += estimateTokens(worldText);
    }
    // How to RUN the place. Deliberately a separate heading from "how this
    // story is written": one is the world's machinery, the other is prose
    // style, and a preset owns the second without touching the first.
    if (narrator) {
      stable.push(`# How this world is run\n${subStable(narrator)}`);
      world.included.push('narrator');
      world.tokens += estimateTokens(narrator);
    }

  }

  // What this story is about, as opposed to how it is written. Set once when
  // you begin it, and it belongs above the cast: it is the frame they stand
  // in. A preset never overwrites it, because it is yours and not the
  // preset's.
  if (String(s.premise || '').trim()) stable.push(`# This story\n${subStable(s.premise.trim())}`);

  if (s.directions.trim()) stable.push(`# How this story is written\n${subStable(s.directions.trim())}`);

  // The ladder belongs in the cached half: it is the same every message for
  // the life of the story, and it is the part that has to be read as a rule
  // rather than as a note about right now.
  const ladderText = renderLadder(s.arc);
  if (ladderText) stable.push(ladderText);

  // With a script, the cast, the persona and the always-on lore have already
  // gone in wherever the preset asked for them, through its own macros.
  // Adding them again here would send every character sheet twice.
  if (!script) {
    for (const c of characters) {
      const parts = [`# ${c.nickname || c.name}`];
      if (c.description) parts.push(subStable(c.description));
      if (c.personality) parts.push(`## Personality\n${subStable(c.personality)}`);
      if (c.scenario) parts.push(`## Setting\n${subStable(c.scenario)}`);
      stable.push(parts.join('\n\n'));
    }

    if (persona && persona.description) {
      stable.push(`# ${persona.name}\nThe person you are writing with plays this character. Never write for them.\n\n${subStable(persona.description)}`);
    }

    if (lead && lead.example_dialogue) {
      stable.push(`# How ${names.char} speaks\n${subStable(lead.example_dialogue)}`);
    }
  }

  // How scenes here tend to go: an ensemble demonstration, not any one
  // person's voice, so it is never labelled as anybody's. It sits after the
  // cast because a real character card outranks a general example of the
  // room, and it is the first thing dropped when it will not fit.
  //
  // Two can arrive. The world may bring one, and a story started from a
  // scenario carries that scenario's own. They are different things — a
  // world's is how scenes go anywhere in it, a scenario's is how THIS room
  // behaves — so both may stand, unless they are literally the same text,
  // which happens when a scenario belongs to the world it came with.
  {
    const budget = s.frameworkEnsembleBudget ?? 700;
    const seen = new Set();
    const offer = (raw, label, note) => {
      const t = String(raw || '').trim();
      if (!t) return;
      const fingerprint = t.replace(/\s+/g, ' ');
      if (seen.has(fingerprint)) {
        world.dropped.push({ what: `${label} (duplicate)`, tokens: estimateTokens(t), why: 'the same text had already gone in' });
        return;
      }
      if (estimateTokens(t) > budget) {
        world.dropped.push({ what: label, tokens: estimateTokens(t), why: `longer than the ${budget}-token allowance for examples` });
        return;
      }
      seen.add(fingerprint);
      stable.push(`# ${note}\nExamples of the shape of a scene, not lines for anyone to repeat.\n\n${subStable(t)}`);
      world.included.push(label);
      world.tokens += estimateTokens(t);
    };
    if (framework) offer(framework.ensemble, 'ensemble', 'How scenes in this world go');
    // Carried over when the story was started from a scenario. This is the
    // classroom case: a multi-speaker demonstration that belongs to the room
    // and was never any one person's voice.
    offer(s.ensembleExample, 'scenario ensemble', 'How scenes here tend to go');
  }

  if (!script) {

    // Always-on lore belongs here, not in the tail: it is the same every
    // message, so keeping it in the stable half means paying for it once per
    // session. It lives here and nowhere else, whatever position its author
    // gave it.
    const constantLore = lore.entries.filter((e) => e.constant);
    if (constantLore.length) {
      stable.push(`# The world\n${constantLore.map((e) => subStable(e.content)).join('\n\n')}`);
    }
  }

  const systemText = stable.filter(Boolean).join('\n\n---\n\n');

  // ---- the conversation ----------------------------------------------------

  const tail = history.slice(-s.historyLimit);
  const dropped = history.length - tail.length;
  const messages = [{ role: 'system', content: systemText, _cache: true }];

  // Everything older than the window survives here, as folded scenes. This
  // sits at the head of the conversation rather than in the system block,
  // because it grows as the story does and would otherwise re-bill the whole
  // world every time a new scene was folded.
  const episodes = memory?.episodes || [];
  if (episodes.length) {
    messages.push({
      role: 'system',
      // A script that asked for {{memory}} has already framed it in its own
      // words; only fall back to ours when it did not.
      content: scripted?.memoryBlock
        || `EARLIER IN THIS STORY\n\n${episodes.map((e) => e.content).join('\n\n')}`,
      _episodes: true,
    });
  }

  // Depth-injected lore sits inside the history, counted back from the end.
  const atDepth = new Map();
  for (const [key, list] of lore.byPosition.atDepth) {
    const raw = Number(key.split(':')[0]);
    const depth = Number.isFinite(raw) ? raw : 4;    // 0 is a real depth, not "unset"
    const own = list.filter((e) => !e.constant);      // constants are already in the stable block
    if (!own.length) continue;
    if (!atDepth.has(depth)) atDepth.set(depth, []);
    atDepth.get(depth).push(...own);
  }

  let injectedTokens = 0;
  const injectAt = (list) => {
    const content = list.map((e) => sub(e.content)).join('\n\n');
    injectedTokens += estimateTokens(content);
    messages.push({ role: 'system', content });
  };

  tail.forEach((m, i) => {
    const fromEnd = tail.length - i;
    const inject = atDepth.get(fromEnd);
    if (inject) injectAt(inject);
    messages.push({ role: m.role, content: m.content });
  });
  // Depth 0 means "after the newest message".
  if (atDepth.get(0)) injectAt(atDepth.get(0));

  // ---- the volatile half ---------------------------------------------------
  // Everything that can differ from one message to the next, all of it after
  // the conversation so that none of it can spoil the cache above.

  const volatile = [];

  // What the marks in the writing mean. Late on purpose: formatting is the
  // first thing a model drifts away from over a long scene, and the last
  // thing it read is the thing it holds onto.
  const marks = (s.notation?.on !== false ? s.notation?.marks || [] : [])
    .filter((m) => m && m.mark && m.means);
  if (marks.length) {
    volatile.push(`HOW THIS IS WRITTEN\n${marks.map((m) => `  ${m.mark} — ${m.means}`).join('\n')}\nUse the same marks the same way. They are how the two of you are reading each other.`);
  }

  // Whatever the preset wrote after its history block. This is where a script
  // puts the things that must be read last: style, format, and the rules the
  // model is most likely to drift away from over a long scene.
  for (const block of scripted?.after || []) volatile.push(block.content);

  // Everything keyed that is not placed somewhere more specific. Author's
  // note entries have their own slot below, so they are left out here or
  // they would be sent twice. Outlet entries have nowhere else to go.
  // With a script, all of this already went in through {{lorebook}}.
  const triggered = script ? [] : lore.entries.filter(
    (e) => !e.constant
      && e.position !== POSITION.AT_DEPTH
      && e.position !== POSITION.AN_TOP
      && e.position !== POSITION.AN_BOTTOM
  );
  if (triggered.length) {
    volatile.push(`# Relevant right now\n${triggered.map((e) => sub(e.content)).join('\n\n')}`);
  }
  const an = [
    ...lore.byPosition.authorNoteTop.filter((e) => !e.constant).map((e) => sub(e.content)),
    authorNote ? sub(authorNote) : '',
    ...lore.byPosition.authorNoteBottom.filter((e) => !e.constant).map((e) => sub(e.content)),
  ].filter(Boolean);
  if (an.length) volatile.push(an.join('\n\n'));

  // The world's closing instructions, then the character's. Order is the
  // precedence: whatever is read last is what a model holds onto hardest, and
  // between a world's general rule and this person's own card, the card wins.
  if (framework && String(framework.closing || '').trim()) {
    volatile.push(sub(framework.closing.trim()));
    world.included.push('closing');
  }
  if (framework && framework.depthNote && String(framework.depthNote.text || '').trim()) {
    // The card format means "insert this N turns from the end". This app has
    // that machinery for lore entries, but using it here would move the cache
    // boundary back N turns on every single message — the difference between
    // a few dollars a month and a few hundred. So depth is mapped to the
    // volatile tail, which is depth 0: still after the conversation, still
    // the last thing read, but not N turns up. Said out loud rather than
    // quietly pretended.
    volatile.push(sub(framework.depthNote.text.trim()));
    world.included.push('depth note');
  }

  if (lead && lead.post_history_instructions) volatile.push(substitute(lead.post_history_instructions, { ...names, original: '' }));
  if (lead && lead.depthPrompt && lead.depthPrompt.text) volatile.push(sub(lead.depthPrompt.text));

  // The world as it stands, and it goes last of everything. It changes on
  // every single turn, so anywhere earlier would spoil the cache for the
  // whole conversation above it — the difference between a few dollars a
  // month and a few hundred.
  let stateText = '';
  if (memory && memory.state) {
    stateText = renderState(memory.state, {
      playerName: persona ? persona.name : '',
      threadsDue: memory.threadsDue || [],
      cast: characters.map((c) => slugName(c.name)),
      arc: s.arc,
      openSecrets: memory.openSecrets || null,
    });
    if (stateText) volatile.unshift(`WHERE THINGS STAND\n\n${stateText}`);
  }

  if (volatile.length) {
    messages.push({ role: 'system', content: volatile.join('\n\n'), _volatile: true });
  }

  // ---- moving the story without typing -------------------------------------

  if (mode === 'impersonate') {
    // The one rule this whole app is built around is that it never writes for
    // you. This is the single exception, and it only exists because you asked
    // for it by name, so it says so out loud rather than quietly flipping the
    // rule over.
    const who = persona ? persona.name : 'the protagonist';
    messages.push({
      role: 'system',
      _volatile: true,
      content: sub(s.impersonation || `You are standing in for ${who} for one message, because they asked you to.

Write ONLY what ${who} thinks, feels, says or does. Not one word for anyone else: no dialogue, no reactions, no thoughts for any other character, and nothing the world does in reply. If the moment needs someone else to act, stop and end there.

Keep it short, one paragraph or two, in the same voice and tense as the rest of the story. End on something the scene can answer: a line spoken, a question, a move made.

Write the message and nothing else. No preamble, no quotation marks around the whole thing, no note about what you are doing.`),
    });
    return account();
  }

  if (mode === 'continue') {
    const last = tail[tail.length - 1];
    messages.push({
      role: 'system',
      _volatile: true,
      // A preset can carry its own wording for this; both formats have a
      // field for it, and the author's phrasing is usually tuned to it.
      content: sub(s.continuePrompt || script?.continuePrompt || `Continue your previous message. What you write will be glued onto the end of it exactly as you send it, so write only the new text: no repetition, no rephrasing, no lead-in, and no acknowledgement of this instruction.

If it broke off mid-sentence, finish that sentence first. If it ended cleanly, carry on from that exact moment. Keep the same tense, point of view and voice.`),
    });
    // The reply so far, so it continues rather than starts. Only when the last
    // thing on the page is theirs; continuing your own line is not a thing.
    if (last && last.role === 'assistant') {
      messages.push({ role: 'assistant', content: last.content, _prefill: true });
    }
    return account();
  }

  // Words put in the model's mouth, as if it had already begun. It continues
  // from them rather than starting fresh, which is why a half-written opening
  // steers a reply harder than any instruction about it would.
  const prefill = String(s.prefill || '').trim();
  if (prefill) messages.push({ role: 'assistant', content: sub(prefill), _prefill: true });

  return account();

  // ---- the account ---------------------------------------------------------

  function account() {
  const stableTokens = estimateTokens(systemText);
  const historyTokens = tail.reduce((a, m) => a + estimateTokens(m.content), 0) + injectedTokens;
  const volatileTokens = volatile.reduce((a, t) => a + estimateTokens(t), 0);
  const episodeTokens = episodes.reduce((a, e) => a + estimateTokens(e.content), 0);

  // The one thing that must never happen: a stretch of the story covered by
  // neither the recent window nor a folded scene. A gap there is invisible —
  // the model simply writes as if those messages never existed, confidently.
  const coveredByEpisode = new Set(memory?.coveredIds || []);
  const missing = dropped
    ? history.slice(0, dropped).filter((m) => m.id && !coveredByEpisode.has(m.id)).length
    : 0;

  return {
    messages,
    lore,
    report: {
      total: stableTokens + historyTokens + volatileTokens + episodeTokens,
      stable: stableTokens,
      history: historyTokens,
      volatile: volatileTokens,
      messagesSent: tail.length,
      messagesDropped: dropped,
      loreFired: lore.entries.length,
      loreTokens: lore.tokens,
      loreConstantTokens: lore.constantTokens || 0,
      loreBudget: lore.budget,
      loreOverflowed: lore.overflowed,
      episodes: episodes.length,
      episodeTokens,
      script: script ? script.name : null,
      // What the world contributed, and what it was not allowed to. Present
      // as null rather than an empty shape when there is no world, so a story
      // without one reads exactly as it did before any of this existed.
      framework: (framework || world.included.length || world.dropped.length) ? {
        name: framework?.name || '',
        included: world.included,
        dropped: world.dropped,
        trimmed: world.trimmed,
        tokens: world.tokens,
        loreEntries: framework?.loreCount ?? null,
      } : null,
      stateTokens: estimateTokens(stateText),
      unremembered: missing,
      // Only the volatile block and the newest turn are charged at full rate
      // once a session is warm. This is the number that decides your bill.
      cacheable: stableTokens + historyTokens + episodeTokens,
    },
  };
  }
}
