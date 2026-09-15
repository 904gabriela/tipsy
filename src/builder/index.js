// The Story Builder: from a draft, a better draft.
//
// Three modes over one contract:
//
//   organize  the composer reads the sources. No model is called; nothing is invented.
//   fill      the model is shown the canon and asked only for what is missing.
//   build     the model develops a story from an idea, around whatever canon exists.
//
// Every call returns a draft and writes nothing. The model is passed in, so
// this has no idea which provider it is talking to and tests can stand in for
// it. What the model says is validated before it is merged, and merging never
// replaces source or manual material.

import {
  MODES, DEPTHS, BUILDER_SECTIONS, DraftError,
  gapsOf, canonOf, validateGeneration, mergeGenerated, checkDraft,
} from './contract.js';
import { builderMessages, RESPONSE_SCHEMA } from './prompt.js';

const MAX_TOKENS = { light: 2500, standard: 5000, deep: 8000 };

async function ask(callModel, messages, depth, signal) {
  const r = await callModel({ messages, schema: RESPONSE_SCHEMA, maxTokens: MAX_TOKENS[depth] || MAX_TOKENS.standard, signal });
  if (!r || r.data === null || r.data === undefined) {
    throw new DraftError('The Story Builder did not return a readable draft. Nothing was changed.', [r?.finishReason === 'length' ? 'the reply was cut off' : 'the reply was not JSON']);
  }
  return r;
}

const summary = (mode, depth, r, parts, gen, extra = {}) => ({
  mode, depth, model: r?.model || null, usage: r?.usage || null,
  parts: [...parts], warnings: gen?.warnings || [], reused: gen?.reused?.length || 0, ...extra,
});

/**
 * Build a draft.
 *
 * @param {object} o
 *   mode         'organize' | 'fill' | 'build'
 *   depth        'light' | 'standard' | 'deep' (default standard)
 *   base         the deterministic draft (fromComposition), possibly empty
 *   idea, tone, pointOfView, instruction   the person's words; all optional except idea for build without canon
 *   callModel    async ({ messages, schema, maxTokens, signal }) → { data, usage, model, finishReason }
 */
export async function buildDraft(o) {
  const mode = o.mode || 'organize';
  const depth = DEPTHS.includes(o.depth) ? o.depth : 'standard';
  if (!MODES.includes(mode)) throw new DraftError(`"${mode}" is not a Story Builder mode.`);
  const base = o.base;

  // Organize invents nothing, so it never asks a model anything.
  if (mode === 'organize') {
    return { ...base, mode, generation: summary(mode, depth, null, [], null, { called: false }) };
  }

  const gaps = gapsOf(base);
  const canonEmpty = base.casting.length === 0 && base.sections.every((s) => !s.count);
  const isNew = base.context !== 'existing';

  let parts;
  if (mode === 'fill') {
    if (canonEmpty && !o.idea && !gaps.have.premise) {
      throw new DraftError('Fill the Gaps needs something to start from: a character, a source, or a premise.');
    }
    parts = gaps.missing.slice();
    if (isNew && !base.story?.title?.value) parts.push('title');
  } else {
    if (canonEmpty && !o.idea && !gaps.have.premise) throw new DraftError('Build It Out needs an idea to start from.');
    parts = [
      ...(isNew && !base.story?.title?.value ? ['title'] : []),
      ...(!gaps.have.premise ? ['premise'] : []),
      ...(isNew && !gaps.have.opening ? ['opening'] : []),
      'people',
      ...BUILDER_SECTIONS.filter((s) => s !== 'other'),
    ];
  }
  if (!parts.length) {
    return { ...base, mode, generation: summary(mode, depth, null, [], { warnings: ['nothing is missing, so nothing was generated'] }, { called: false }) };
  }

  const canon = canonOf(base);
  const messages = builderMessages({
    mode, depth, idea: o.idea, tone: o.tone, pointOfView: o.pointOfView, instruction: o.instruction,
    canon, parts, needLead: !gaps.have.lead,
  });
  const r = await ask(o.callModel, messages, depth, o.signal);
  const gen = validateGeneration(r.data, { draft: base, depth, allowed: new Set(parts), canon });
  const draft = mergeGenerated(base, gen, { parts: new Set(parts) });
  return { ...draft, mode, generation: summary(mode, depth, r, parts, gen, { called: true }) };
}

/** Find a draft item by its temporary id, wherever it is. */
function findItem(draft, draftId) {
  const row = draft.casting.find((r) => r.draftId === draftId);
  if (row) return { item: row, section: 'people', name: row.name, text: row.content };
  for (const s of draft.sections) {
    const i = s.items.find((x) => x.draftId === draftId);
    if (i) return { item: i, section: s.id, name: i.title, text: i.content };
  }
  return null;
}

/** A draft with one scope's generated material taken out, so it can be written again. */
function withoutGenerated(draft, { parts = new Set(), item = null }) {
  const out = structuredClone(draft);
  const gone = (origin, part, id) => origin === 'generated' && (item ? id === item : parts.has(part));
  out.casting = out.casting.filter((r) => !gone(r.origin, 'people', r.draftId));
  for (const s of out.sections) { s.items = s.items.filter((i) => !gone(i.origin, s.id, i.draftId)); s.count = s.items.length; }
  if (!item) {
    for (const p of ['title', 'premise']) if (parts.has(p) && out.story?.[p]?.origin === 'generated') out.story[p] = null;
    if (parts.has('opening') && out.story?.opening?.origin === 'generated') out.story.opening = null;
  }
  return out;
}

/**
 * Generate one part of a draft again, leaving the rest exactly as it was.
 *
 * @param {object} o
 *   draft     the draft to work on (checked, not trusted)
 *   scope     { part: 'title' | 'premise' | 'opening' | 'people' | <section> }
 *             { item: draftId }          — rewrite one generated item
 *             { expand: draftId | { entryId } | { characterId } } — add material that develops one thing
 *   depth, idea, instruction, callModel
 */
export async function regenerate(o) {
  const draft = checkDraft(o.draft);
  const depth = DEPTHS.includes(o.depth) ? o.depth : (draft.generation?.depth || 'standard');
  const scope = o.scope || {};
  const isNew = draft.context !== 'existing';

  if (scope.part) {
    const valid = ['title', 'premise', 'opening', 'people', ...BUILDER_SECTIONS];
    if (!valid.includes(scope.part)) throw new DraftError(`"${scope.part}" is not a part of a draft.`);
    if (scope.part === 'opening' && !isNew) throw new DraftError('An existing story already has its opening.');
    const has = scope.part === 'title' || scope.part === 'premise' ? draft.story?.[scope.part] : scope.part === 'opening' ? draft.story?.opening : null;
    if (has && has.origin !== 'generated') throw new DraftError(`The ${scope.part} came from the author and is not rewritten.`);
    const parts = new Set([scope.part]);
    const base = withoutGenerated(draft, { parts });
    const canon = canonOf(base);
    const r = await ask(o.callModel, builderMessages({
      mode: 'fill', depth, idea: o.idea, instruction: o.instruction, canon, parts: [...parts],
      needLead: !base.casting.some((x) => x.suggested === 'lead'),
    }), depth, o.signal);
    const gen = validateGeneration(r.data, { draft: base, depth, allowed: parts, canon });
    const out = mergeGenerated(base, gen, { parts: new Set() });
    return { ...out, generation: summary(draft.mode, depth, r, parts, gen, { called: true, scope }) };
  }

  if (scope.item) {
    const found = findItem(draft, scope.item);
    if (!found) throw new DraftError('That item is not in the draft.');
    if (found.item.origin !== 'generated') throw new DraftError('Only generated material can be regenerated. Material from a source or written by the author is not rewritten.');
    const parts = new Set([found.section]);
    const base = withoutGenerated(draft, { item: scope.item });
    const canon = canonOf(base);
    const wasLead = found.item.suggested === 'lead';
    const r = await ask(o.callModel, builderMessages({
      mode: 'fill', depth, instruction: o.instruction, canon, parts: [...parts], needLead: wasLead,
      focus: { kind: 'item', target: { name: found.name, section: found.section, text: found.text } },
    }), depth, o.signal);
    const gen = validateGeneration(r.data, { draft: base, depth, allowed: parts, canon });
    // One item was asked for. Anything more is not what was asked.
    const extra = gen.people.length + gen.entries.length - 1;
    if (extra > 0) gen.warnings.push(`${extra} extra item${extra === 1 ? ' was' : 's were'} returned and left out`);
    gen.people = gen.people.slice(0, found.section === 'people' ? 1 : 0);
    gen.entries = gen.entries.slice(0, found.section === 'people' ? 0 : 1);
    const out = mergeGenerated(base, gen, { parts: new Set() });
    return { ...out, generation: summary(draft.mode, depth, r, parts, gen, { called: true, scope }) };
  }

  if (scope.expand) {
    const target = typeof scope.expand === 'string'
      ? findItem(draft, scope.expand)
      : findSource(draft, scope.expand);
    if (!target) throw new DraftError('That item is not in the draft.');
    // Developing something can mean new people around it, or more of its own kind.
    const parts = new Set(['people', target.section]);
    const canon = canonOf(draft);
    const ref = [...canon.refs.entries()].find(([, v]) => (target.item.draftId && v.draftId === target.item.draftId)
      || (target.item.entryId && v.entryId === target.item.entryId)
      || (target.item.characterId && v.characterId === target.item.characterId))?.[0];
    const r = await ask(o.callModel, builderMessages({
      mode: 'fill', depth, instruction: o.instruction, canon, parts: [...parts], needLead: false,
      focus: { kind: 'expand', target: { name: target.name, section: target.section, ref } },
    }), depth, o.signal);
    const gen = validateGeneration(r.data, { draft, depth, allowed: parts, canon });
    // Expanding adds; it never replaces. Only what is about the target is kept.
    const aboutTarget = (x) => x.about.some((a) => a.ref === ref || (target.item.draftId && a.draftId === target.item.draftId));
    const before = gen.people.length + gen.entries.length;
    gen.people = gen.people.filter(aboutTarget);
    gen.entries = gen.entries.filter(aboutTarget);
    const dropped = before - gen.people.length - gen.entries.length;
    if (dropped) gen.warnings.push(`${dropped} item${dropped === 1 ? ' was' : 's were'} not about "${target.name}" and left out`);
    const out = mergeGenerated(draft, gen, { parts: new Set() });
    return { ...out, generation: summary(draft.mode, depth, r, parts, gen, { called: true, scope }) };
  }

  throw new DraftError('Say what to regenerate: a part, an item, or something to expand.');
}

function findSource(draft, { entryId, characterId }) {
  if (characterId) {
    const r = draft.casting.find((x) => x.characterId === characterId);
    return r ? { item: r, section: 'people', name: r.name } : null;
  }
  const r = draft.casting.find((x) => x.entryId === entryId || (x.entryIds || []).includes(entryId));
  if (r) return { item: r, section: 'people', name: r.name };
  for (const s of draft.sections) {
    const i = s.items.find((x) => x.entryId === entryId);
    if (i) return { item: i, section: s.id, name: i.title };
  }
  return null;
}
