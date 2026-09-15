// Presets that explain themselves.
//
// A plain preset is a row of numbers: temperature 0.92, max tokens 1400. Those
// mean nothing to anyone who has not read the documentation, so in practice
// they get left alone, and the one dial that would actually have fixed the
// problem never gets touched.
//
// A script preset is the other shape. The prompt is written once, with holes
// in it, and each hole is filled by a control that says in plain words what
// each of its choices does. "Prose style: Literary — interiority and imagery,
// beautiful on a strong model, purple on a weak one." You can pick that
// without knowing anything about how any of it works.
//
// This is the ChungusHub preset format, read losslessly: items, controls,
// sections and bundles, exactly as written. Nothing is reinterpreted and
// nothing is dropped, so a preset written elsewhere behaves the same here.

import { estimateTokens } from './prompt.js';

/**
 * Every macro the app answers, not just the obvious five.
 *
 * Taken from ChungusHub's own registry, because a preset written there uses
 * whichever of these its author reached for, and one that quietly resolves to
 * nothing here is a preset that half works with no way to tell.
 */
export const SLOT_MACROS = [
  'character', 'persona', 'lorebook', 'memory', 'chatHistory',
  'lastMessage', 'lastUserMessage', 'lastCharMessage',
  'time', 'date', 'weekday', 'isotime', 'isodate',
  'description', 'personality', 'scenario', 'charFirstMessage',
  'mesExamples', 'mesExamplesRaw', 'charPrompt', 'charInstruction',
  'charVersion', 'charCreatorNotes', 'charCreator',
];

/**
 * Macros whose value is different on every single turn.
 *
 * These decide where an item is allowed to sit. Anything holding one of them
 * cannot live in the cached half of the prompt: the cache is the longest run
 * of unchanged bytes at the front, so a clock in the system block quietly
 * re-bills the entire world every time the minute rolls over. An item that
 * uses one is moved after the conversation instead, which costs a few tokens
 * at full rate rather than everything at full rate.
 */
export const VOLATILE_MACROS = new Set([
  'time', 'isotime', 'date', 'weekday', 'isodate',
  'lastMessage', 'lastUserMessage', 'lastCharMessage',
]);

/** {{chatHistoryLast20}} and friends: the registered name is a shape. */
const cappedHistory = (name) => {
  const m = /^chatHistoryLast(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
};

const str = (v) => (typeof v === 'string' ? v : '');
const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * Read a preset file into the shape the rest of the app uses.
 *
 * Forgiving on the way in: a preset missing its sections still works, a
 * control with an unknown type is kept and reported rather than thrown away,
 * and anything it cannot use is listed in `notes` so the import screen can
 * say so instead of silently losing it.
 */
export function parseScript(raw) {
  const notes = [];
  if (!raw || typeof raw !== 'object') return { ok: false, notes: ['That file is not a preset.'] };
  if (!Array.isArray(raw.items) || !raw.items.length) {
    return { ok: false, notes: ['A preset needs an "items" list: the blocks that make up the prompt.'] };
  }

  const items = raw.items.map((it, i) => ({
    name: str(it.name) || `Block ${i + 1}`,
    role: it.role === 'user' || it.role === 'assistant' ? it.role : 'system',
    content: str(it.content),
    enabled: it.enabled !== false,
    note: str(it.note),
  }));

  const KNOWN = ['radio', 'select', 'range', 'tags', 'toggle', 'textarea'];
  const controls = arr(raw.controls).map((c, i) => {
    const type = KNOWN.includes(c.type) ? c.type : 'textarea';
    if (!KNOWN.includes(c.type)) notes.push(`"${str(c.label) || c.id}" is a ${c.type} control, which this app does not have yet. It is shown as a text box.`);
    return {
      id: str(c.id) || `ctrl_${i}`,
      macro: str(c.macro),
      label: str(c.label) || str(c.macro),
      help: str(c.help),
      advice: str(c.advice) || 'optional',
      group: str(c.group),
      type,
      options: arr(c.options).map((o) => ({
        id: str(o.id),
        label: str(o.label),
        description: str(o.description),
        injectedText: str(o.injectedText),
      })),
      defaultOptionId: str(c.defaultOptionId),
      defaultOptionIds: arr(c.defaultOptionIds).map(str),
      min: Number.isFinite(c.min) ? c.min : 0,
      max: Number.isFinite(c.max) ? c.max : 100,
      step: Number.isFinite(c.step) ? c.step : 1,
      defaultRange: arr(c.defaultRange).slice(0, 2).map(Number),
      rangeTemplate: str(c.rangeTemplate),
      tagSeparator: typeof c.tagSeparator === 'string' ? c.tagSeparator : ', ',
      allowCustom: c.allowCustom !== false,
      customPlaceholder: str(c.customPlaceholder),
      defaultOn: c.defaultOn !== false,
      onText: str(c.onText),
      offText: str(c.offText),
      defaultText: str(c.defaultText),
      placeholder: str(c.placeholder),
      textTemplate: str(c.textTemplate) || '{{value}}',
    };
  });

  // A macro written into an item with no control behind it resolves to
  // nothing, which is a silent hole in the prompt rather than an error.
  const haveMacro = new Set([...controls.map((c) => c.macro), ...SLOT_MACROS, 'char', 'user']);
  const used = new Set();
  for (const it of items) for (const m of str(it.content).matchAll(/\{\{(\w+)\}\}/g)) used.add(m[1]);
  for (const m of used) if (!haveMacro.has(m)) notes.push(`The prompt uses {{${m}}} but nothing fills it in. It will come out empty.`);
  for (const c of controls) if (c.macro && !used.has(c.macro)) notes.push(`"${c.label}" is never used by the prompt, so changing it will do nothing.`);

  const sections = arr(raw.sections).map((s) => ({
    id: str(s.id),
    title: str(s.title) || str(s.id),
    description: str(s.description),
    icon: str(s.icon),
  }));
  // Any group a control claims that has no section of its own still needs
  // somewhere to be drawn.
  for (const c of controls) {
    if (c.group && !sections.some((s) => s.id === c.group)) sections.push({ id: c.group, title: c.group, description: '', icon: '' });
  }

  const bundles = arr(raw.bundles).map((b) => ({
    id: str(b.id),
    name: str(b.name),
    description: str(b.description),
    values: b.values && typeof b.values === 'object' ? b.values : {},
  }));

  return {
    ok: true,
    notes,
    script: {
      name: str(raw.name) || 'Untitled preset',
      meta: {
        author: str(raw.meta?.author),
        version: str(raw.meta?.version),
        description: str(raw.meta?.description),
        writtenFor: str(raw.meta?.writtenFor),
      },
      items, controls, sections, bundles,
      pruneEmptyBlocks: raw.pruneEmptyBlocks !== false,
      exampleSeparator: str(raw.exampleSeparator) || '***',
      continuePrompt: str(raw.continuePrompt),
    },
  };
}

/** Every control at whatever its author set it to. */
export function defaultValues(script) {
  const out = {};
  for (const c of script.controls || []) {
    if (!c.macro) continue;
    if (c.type === 'radio' || c.type === 'select') out[c.macro] = c.defaultOptionId || c.options[0]?.id || '';
    else if (c.type === 'tags') out[c.macro] = [...c.defaultOptionIds];
    else if (c.type === 'range') out[c.macro] = c.defaultRange.length === 2 ? [...c.defaultRange] : [c.min, c.max];
    else if (c.type === 'toggle') out[c.macro] = c.defaultOn;
    else out[c.macro] = c.defaultText;
  }
  return out;
}

/** What one control contributes to the prompt, as text. */
export function textFor(control, value) {
  const c = control;
  switch (c.type) {
    case 'radio':
    case 'select': {
      const chosen = c.options.find((o) => o.id === value) || c.options.find((o) => o.id === c.defaultOptionId);
      return chosen ? chosen.injectedText : '';
    }
    case 'range': {
      const [a, b] = Array.isArray(value) && value.length === 2 ? value : c.defaultRange;
      if (!c.rangeTemplate) return '';
      return c.rangeTemplate.replace(/\{\{min\}\}/g, String(a)).replace(/\{\{max\}\}/g, String(b));
    }
    case 'tags': {
      const ids = Array.isArray(value) ? value : c.defaultOptionIds;
      const parts = ids.map((id) => {
        const found = c.options.find((o) => o.id === id);
        // A tag the reader typed is not in the options list, and its id is
        // its text. Dropping those would quietly lose every custom entry.
        return found ? found.injectedText : String(id);
      }).filter(Boolean);
      return parts.join(c.tagSeparator);
    }
    case 'toggle':
      return value === false ? c.offText : c.onText;
    default: {
      const v = String(value ?? '').trim();
      if (!v) return '';
      return c.textTemplate.replace(/\{\{value\}\}/g, v);
    }
  }
}

/** What each control costs, for the screen that shows it next to the control. */
export function costOf(script, values) {
  const out = {};
  let total = 0;
  for (const c of script.controls || []) {
    if (!c.macro) continue;
    const n = estimateTokens(textFor(c, values[c.macro]));
    out[c.id] = n;
    total += n;
  }
  return { perControl: out, total };
}

/** Which controls are no longer where the chosen setup put them. */
export function driftFrom(script, values, bundleId) {
  const bundle = (script.bundles || []).find((b) => b.id === bundleId);
  const base = bundle ? { ...defaultValues(script), ...bundle.values } : defaultValues(script);
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return (script.controls || [])
    .filter((c) => c.macro && !same(values[c.macro], base[c.macro]))
    .map((c) => c.id);
}

/**
 * Drop blocks whose only content was a macro that came out empty.
 *
 * A preset writes <world_info>{{lorebook}}</world_info> and early in a story
 * no lore has fired yet. Left alone that ships an empty pair of tags, which
 * reads to a model as "this story has no world", the opposite of the truth.
 */
const TAG_OPEN = /<([A-Za-z][A-Za-z0-9_-]*)>/g;
const MACRO_NAMES = (t) => [...new Set([...String(t).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))];

function findClose(text, name, from) {
  const open = new RegExp(`<${name}>`, 'g');
  const close = new RegExp(`</${name}>`, 'g');
  let depth = 1;
  let at = from;
  for (;;) {
    close.lastIndex = at;
    const c = close.exec(text);
    if (!c) return -1;
    open.lastIndex = at;
    let o = open.exec(text);
    while (o && o.index < c.index) { depth++; open.lastIndex = o.index + o[0].length; o = open.exec(text); }
    depth--;
    if (depth === 0) return c.index;
    at = c.index + c[0].length;
  }
}

/**
 * One level of the pruning walk. Returns what survives, plus what the level
 * needs to know to decide whether its parent survives.
 */
function pruneLevel(text, values) {
  const open = new RegExp(TAG_OPEN.source, 'g');
  let out = '';
  let ownText = '';
  let dynamic = false;
  let survivingChildren = 0;
  let pos = 0;
  let m;

  while ((m = open.exec(text)) !== null) {
    const name = m[1];
    const innerStart = m.index + m[0].length;
    const closeAt = findClose(text, name, innerStart);
    if (closeAt === -1) continue;              // unmatched: it is just text

    const before = text.slice(pos, m.index);
    out += before;
    ownText += before;

    const child = pruneLevel(text.slice(innerStart, closeAt), values);
    if (shouldPrune(child, values)) {
      dynamic = true;                          // a pruned child can empty us out
    } else {
      out += `<${name}>${child.out}</${name}>`;
      dynamic = dynamic || child.dynamic;
      survivingChildren++;
    }
    pos = closeAt + name.length + 3;
    open.lastIndex = pos;
  }

  const rest = text.slice(pos);
  out += rest;
  ownText += rest;
  const directMacros = MACRO_NAMES(ownText);
  return { out, dynamic: dynamic || directMacros.length > 0, directMacros, survivingChildren };
}

function shouldPrune(block, values) {
  // A block with no macros anywhere in it was written as plain text and is
  // never anybody's framing. Left alone.
  if (!block.dynamic) return false;
  // Emptied out entirely. A typo'd macro stays literal, which keeps its block
  // non-empty and visible, rather than disappearing where you cannot find it.
  if (!fillNames(block.out, values).trim()) return true;
  // The framing case: every macro this block owns came back empty, so its
  // static words are a frame around content that is not there and go with it.
  // A surviving child always vetoes.
  if (block.survivingChildren > 0 || block.directMacros.length === 0) return false;
  return block.directMacros.every((name) => name in values && !String(values[name]).trim());
}

/** One pass, and unknown names are left exactly as written. */
function fillNames(text, values) {
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (whole, key) => (key in values ? values[key] : whole));
}

/**
 * Drop blocks whose only content was a macro that came out empty.
 *
 * A preset writes <world_info>{{lorebook}}</world_info> and early in a story
 * no lore has fired yet. Left alone that ships an empty pair of tags, which
 * reads to a model as "this story has no world", the opposite of the truth.
 *
 * Bottom-up, and deliberately conservative in two directions: a block of
 * plain text with no macros in it is never touched, and a macro nobody
 * recognises keeps its block alive so the mistake is visible in the prompt
 * instead of silently eating the paragraph around it.
 */
export function pruneEmpty(text, values = {}) {
  if (!text || !text.includes('<')) return text;
  const { out } = pruneLevel(text, values);
  return out === text ? text : out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Build the prompt blocks this preset describes.
 *
 * The order the preset wrote them in is kept exactly, with one thing imposed
 * on top: whatever sits before the history stays in the cached half and
 * whatever sits after it stays in the per-turn half. Every preset worth
 * having is already written that way round, and the one that is not would
 * otherwise quietly re-bill the whole world on every message.
 */
export function renderScript(script, values, { slots = {}, sub = (t) => t, history = [] } = {}) {
  const macros = { ...slots };
  for (const c of script.controls || []) {
    // Resolved last, so an author-defined control can never shadow an app
    // macro of the same name.
    if (c.macro && !(c.macro in macros)) macros[c.macro] = textFor(c, values[c.macro]);
  }

  // {{chatHistoryLast20}} is a shape rather than a name, so it is answered
  // only where it is actually written.
  const withCapped = (text) => {
    const out = { ...macros };
    for (const name of MACRO_NAMES(text)) {
      const n = cappedHistory(name);
      if (n === null) continue;
      out[name] = history.slice(-n)
        .map((m) => `${m.role === 'user' ? '{{user}}' : '{{char}}'}: ${m.content}`).join('\n\n');
    }
    return out;
  };

  const fill = (text) => {
    const vals = withCapped(text);
    // {{chatHistory}} is structural and {{char}}/{{user}} belong to the name
    // substitution that runs after this, so neither is answered here.
    const guarded = { ...vals };
    delete guarded.chatHistory;
    let out = script.pruneEmptyBlocks ? pruneEmpty(text, guarded) : text;
    out = fillNames(out, guarded);
    return sub(out).trim();
  };

  const before = [];
  const after = [];
  const moved = [];
  let memoryBlock = '';
  let sawHistory = false;

  for (const item of script.items || []) {
    if (!item.enabled) continue;
    if (/\{\{chatHistory\}\}/.test(item.content)) { sawHistory = true; continue; }

    // The folded-scenes block belongs at the head of the conversation rather
    // than in the cached half: it grows as the story does, and keeping it
    // above would re-bill everything above it every time a scene is folded.
    if (/\{\{memory\}\}/.test(item.content)) {
      memoryBlock = fill(item.content);
      continue;
    }

    const text = fill(item.content);
    if (!text) continue;

    // A clock, or the newest line, in a block that would otherwise be cached.
    // Leaving it there re-bills the whole prompt every time its value moves,
    // which for {{time}} is once a minute. It goes after the conversation
    // instead: the same words, at a fraction of the cost.
    const volatileHere = MACRO_NAMES(item.content).filter((n) => VOLATILE_MACROS.has(n));
    if (!sawHistory && volatileHere.length) {
      moved.push({ name: item.name, because: volatileHere });
      after.push({ name: item.name, role: item.role, content: text });
      continue;
    }

    (sawHistory ? after : before).push({ name: item.name, role: item.role, content: text });
  }

  return { before, after, memoryBlock, sawHistory, moved };
}
