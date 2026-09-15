// The other kind of preset: SillyTavern's chat-completion presets.
//
// Two unrelated things are both called "a preset" in this corner of the
// internet, and the difference matters.
//
// A ChungusHub preset is a document with holes in it and named controls that
// fill them. This one is older and simpler: a couple of big blocks of prose
// plus the sampler numbers. It has no controls, no sections and no setups.
// What it does have is the two positions that matter — one block before the
// conversation and one after it — and those map exactly onto how this app
// already builds a prompt, so it converts cleanly rather than approximately.
//
// The fields, and what each one really is:
//
//   main_prompt          the system prompt. Read first, before everything.
//   jailbreak_prompt     SillyTavern's name for post-history instructions:
//                        sent AFTER the conversation, which is why it is the
//                        most obeyed text in the whole prompt. The name is a
//                        holdover; it is just "the last word".
//   impersonation_prompt used only when you ask the AI to write YOUR turn.
//                        Nothing to do with normal replies.
//   assistant_prefill    words put in the model's mouth, as if it had already
//                        started replying. It continues from there.
//   the sampler numbers  temperature and friends.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v) => (typeof v === 'string' ? v : '');

/** Does this look like one? */
export function looksLikeSTPreset(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
  if (Array.isArray(json.items) || Array.isArray(json.entries)) return false;   // ours, or a lorebook
  const marks = ['main_prompt', 'jailbreak_prompt', 'impersonation_prompt', 'assistant_prefill', 'nsfw_prompt'];
  const hasProse = marks.some((k) => typeof json[k] === 'string');
  const hasDials = ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty']
    .some((k) => Number.isFinite(Number(json[k])));
  return hasProse && hasDials;
}

/**
 * The sampler numbers, and which of them actually do anything.
 *
 * Measured rather than assumed. Against one pinned provider at temperature
 * 1.1, asking the same question three times:
 *
 *   top_p 0.01        gave the identical sentence three times — applied
 *   top_k 1           kept varying — the provider ignores it
 *   min_p 1           kept varying — ignored too
 *
 * So temperature and top_p are real here, and the rest depend entirely on who
 * is serving the model. They are carried through anyway, because they cost
 * nothing and a different model may honour them, but the import says plainly
 * that they may do nothing rather than implying they are doing work.
 *
 * Values that mean "off" are dropped rather than sent: a file exported from
 * another app writes whatever was in its boxes, and its idea of off is not
 * always a zero.
 */
export function auditSamplers(json) {
  const notes = [];
  const out = {};
  const inert = [];

  const t = num(json.temperature);
  if (t !== null && t > 0) out.temperature = Math.min(2, Math.max(0.05, t));

  const tp = num(json.top_p);
  if (tp !== null && tp > 0 && tp < 1) out.topP = tp;

  const fp = num(json.frequency_penalty);
  if (fp) out.frequencyPenalty = Math.max(-2, Math.min(2, fp));
  const pp = num(json.presence_penalty);
  if (pp) out.presencePenalty = Math.max(-2, Math.min(2, pp));

  const tk = num(json.top_k);
  if (tk && tk > 0) { out.topK = Math.round(tk); inert.push('top_k'); }

  const rp = num(json.repetition_penalty);
  if (rp && rp !== 1) { out.repetitionPenalty = Math.max(0.5, Math.min(2, rp)); inert.push('repetition_penalty'); }

  const ta = num(json.top_a);
  if (ta && ta > 0) { out.topA = ta; inert.push('top_a'); }

  const mp = num(json.min_p);
  if (mp && mp > 0 && mp < 1) { out.minP = mp; inert.push('min_p'); }
  else if (mp !== null && mp >= 1) {
    notes.push('Its min_p was 1, which is outside the range the setting is meant for. Left off.');
  }

  if (inert.length) {
    notes.push(`It also sets ${inert.join(', ')}. Those are passed along, but the model you are on ignores them — measured, not guessed. Temperature and top_p are the two that actually bite here.`);
  }

  if (json.names_in_completion === true) out.includeNames = true;
  return { settings: out, notes };
}

/**
 * Turn one into a preset this app can use.
 *
 * Converted into the same shape as every other preset here — a prompt with
 * positions — rather than kept as a special case, so it can be opened in the
 * editor, given controls, and saved as your own.
 */
export function convertSTPreset(json, filename = 'preset') {
  const notes = [];
  const { settings, notes: samplerNotes } = auditSamplers(json);
  notes.push(...samplerNotes);

  const main = str(json.main_prompt).trim();
  const jail = str(json.jailbreak_prompt).trim();
  const nsfw = str(json.nsfw_prompt).trim();
  const impersonation = str(json.impersonation_prompt).trim();
  const prefill = str(json.assistant_prefill).trim();

  const items = [];

  if (main) {
    items.push({
      name: 'Main prompt',
      role: 'system',
      enabled: true,
      content: main,
      note: 'The system prompt, read before everything else. It came from the file exactly as written.',
    });
  }
  if (nsfw) {
    items.push({
      name: 'Content rules',
      role: 'system',
      enabled: true,
      content: nsfw,
      note: 'A separate content block the file carried. Kept apart so you can switch it off on its own.',
    });
  }

  // The cast, you, and the world. The file never says where these go because
  // SillyTavern places them itself; here they have to be written down.
  items.push({
    name: 'Story bible',
    role: 'system',
    enabled: true,
    content: '<story_bible>\n\n<character>\n{{character}}\n</character>\n\n<protagonist>\n{{persona}}\n</protagonist>\n\n<world_info>\n{{lorebook}}\n</world_info>\n\n</story_bible>',
    note: 'This app writes down where the cast, your character and the lore go. The file did not carry it, because SillyTavern places those itself.',
  });

  items.push({
    name: 'Earlier in this story',
    role: 'system',
    enabled: true,
    content: '<earlier>\nAll of this already happened. Treat it as settled, stay consistent with it, and draw on it rather than reciting it back.\n\n{{memory}}\n</earlier>',
    note: 'Folded scenes from further back than the recent window. Empty until the story is long enough to have any, and the block removes itself while it is.',
  });

  items.push({
    name: 'The story so far',
    role: 'system',
    enabled: true,
    content: '{{chatHistory}}',
    note: 'The conversation itself. Everything above this is billed at the cached rate; everything below is charged in full every message.',
  });

  if (jail) {
    items.push({
      name: 'The last word',
      role: 'system',
      enabled: true,
      content: jail,
      note: 'SillyTavern calls this the jailbreak. It is really just the block sent after the conversation, which is why the model obeys it more than anything else. Nothing about it is a trick.',
    });
  }

  if (!main && !jail && !nsfw) {
    return { ok: false, notes: ['That file has sampler numbers but no prompt text in it, so there is nothing to convert.'] };
  }

  // Filenames arrive as "DeepClean_-_A_preset_for_Deepseek.json", so the
  // underscores and the orphaned dash both have to go, and the run of spaces
  // they leave behind with them.
  const name = str(json.name)
    || String(filename).replace(/\.json$/i, '').replace(/[_]+/g, ' ')
      .replace(/\s+-\s+/g, ' — ').replace(/\s{2,}/g, ' ').trim()
    || 'Imported preset';

  if (impersonation) notes.push('It carries an impersonation prompt, for having the AI write your turn. This app has no such button yet, so it is kept with the preset but unused.');
  if (prefill) notes.push('It carries an assistant prefill, which puts the first words in the model\'s mouth. That is switched on for this preset.');
  notes.push('Converted into an ordinary preset here, so you can open it, add controls to it, and make it your own.');

  return {
    ok: true,
    notes,
    name,
    settings,
    extras: { impersonation, prefill },
    script: {
      name,
      meta: {
        author: str(json.author),
        description: `Imported from a SillyTavern preset file.${main ? '' : ' It had no main prompt.'}`,
        writtenFor: 'Converted from another app. The two blocks it carries are placed the way this app builds a prompt: one before the conversation, one after it.',
      },
      items,
      controls: [],
      sections: [],
      bundles: [],
      pruneEmptyBlocks: true,
      exampleSeparator: '***',
    },
  };
}
