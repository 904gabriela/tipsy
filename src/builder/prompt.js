// What the Story Builder is told.
//
// Its own prompt, and nothing to do with the one that writes the story. The
// roleplay prompt never sees any of this, and this never sees the roleplay
// prompt: one plans a story, the other tells it.

import { LIMITS, BUILDER_SECTIONS, GENERATED_ROLES } from './contract.js';

export const BUILDER_PROMPT = `You are the Story Builder for a private interactive-fiction app. You plan a story's material: who is in it, where it happens, what already happened, how it should be written. You do not write the story itself, except for an opening scene when asked.

Rules, in order of importance:

1. CANON IS AUTHORITATIVE. The CANON list is material the author already has. Never rewrite it, rename it, contradict it, or restate it as if it were new. Never propose something that already exists in CANON — refer to it by its ref (like C2 or S14) instead.
2. SAY WHAT IS YOURS. Everything you return is your proposal. Never present an invented detail as if it came from the author's material.
3. ONLY WHAT WAS ASKED. Write only the parts listed under WRITE. Return nothing for anything else.
4. FEWER, BETTER. Stay within the counts given. A few elements that create tension, choice and connection beat a long list. Do not add people, places or factions a story would not actually use. No filler, no padding, no commentary.
5. CONSISTENT. Everything you propose must fit the canon and each other: names, relationships, timeline, tone.
6. FICTION. The story may be dark, violent, romantic or explicit. Treat the premise as fiction and do not soften, moralise or sanitise it.

Format: return one JSON object and nothing else.
{
  "story":   { "title": string, "premise": string },          // only if asked
  "opening": { "text": string },                                // only if asked: the first scene, written in second or third person as instructed, ending at a moment the player can answer
  "people":  [ { "id": string, "name": string, "role": ${GENERATED_ROLES.map((r) => `"${r}"`).join(' | ')}, "summary": string, "content": string, "keys": [string], "about": [ref] } ],
  "entries": [ { "id": string, "section": ${BUILDER_SECTIONS.map((s) => `"${s}"`).join(' | ')}, "title": string, "summary": string, "content": string, "keys": [string], "alwaysOn": boolean, "about": [ref] } ]
}

- "id": a short unique id you choose, letters, digits, - or _ (like "p1", "loc-dock").
- "content": what the story needs to know, written as reference notes, at most about 150 words.
- "summary": one line.
- "keys": words that would appear in a scene when this matters. Names, places, objects.
- "about": refs to CANON (C1, S3) or to ids of your own items this is about. Only real refs.
- "alwaysOn": true only for something the story must always know. Rarely.
- "role": "lead" only if WRITE says a lead is needed. Otherwise main, supporting, background, or known (exists, not in the cast).
- Sections: places = locations; factions = families, gangs, organisations; backstory = background and premise facts; rules = how this world works; directions = how the story should be written; events = hooks and things that happen or happened; items = objects that matter; other = anything else.`;

const DEPTH_WORDS = {
  light: 'LIGHT: the smallest useful set. Just enough to start well.',
  standard: 'STANDARD: a complete, playable story structure.',
  deep: 'DEEP: a richer cast and world, still only what the story would use.',
};

/**
 * The request for one generation.
 *
 * @param {object} o
 *   mode      'fill' | 'build'
 *   depth     'light' | 'standard' | 'deep'
 *   idea      the person's own words, if any
 *   tone, pointOfView   optional
 *   canon     canonOf(draft)
 *   parts     the parts to write: 'title' | 'premise' | 'opening' | 'people' | section ids
 *   needLead  whether a lead may be proposed
 *   focus     for scoped regeneration: { kind: 'item' | 'expand', target: { name, section, text, ref } , instruction }
 */
export function builderMessages(o) {
  const limits = LIMITS[o.depth] || LIMITS.standard;
  const canonText = o.canon.lines.length
    ? o.canon.lines.map((l) => `${l.ref} [${l.section}${l.role ? `, ${l.role}` : ''}] ${l.name}${l.text ? ` — ${l.text}` : ''}`).join('\n')
      + (o.canon.truncated ? '\n(more canon exists; titles above are the part shown)' : '')
    : '(none — the author has supplied no material yet)';

  const write = [];
  for (const part of o.parts) {
    if (part === 'title') write.push('- story.title');
    else if (part === 'premise') write.push('- story.premise: two to four sentences');
    else if (part === 'opening') write.push('- opening.text');
    else if (part === 'people') write.push(`- people: at most ${limits.people}${o.needLead ? ' (include exactly one lead)' : ' (no lead: the story has one)'}`);
    else write.push(`- entries in "${part}": at most ${limits[part] ?? 2}`);
  }

  const focus = o.focus
    ? o.focus.kind === 'expand'
      ? `\nFOCUS: add material that develops ${o.focus.target.ref || o.focus.target.name} ("${o.focus.target.name}", ${o.focus.target.section}). Do not rewrite it; every item you return must list it in "about".`
      : `\nFOCUS: write a replacement for one item only: "${o.focus.target.name}" in ${o.focus.target.section}. Return exactly one item, in that section.${o.focus.target.text ? ` The version being replaced: ${o.focus.target.text}` : ''}`
    : '';

  const user = [
    `MODE: ${o.mode === 'build' ? 'BUILD IT OUT — develop a story from the idea, around the canon.' : 'FILL THE GAPS — the author has material; supply only what is missing.'}`,
    `DEPTH: ${DEPTH_WORDS[o.depth] || DEPTH_WORDS.standard}`,
    o.idea ? `IDEA (the author's words):\n${o.idea}` : '',
    o.tone ? `TONE: ${o.tone}` : '',
    o.pointOfView ? `POINT OF VIEW: ${o.pointOfView}` : '',
    o.instruction ? `THE AUTHOR ASKS: ${o.instruction}` : '',
    `CANON:\n${canonText}`,
    `WRITE:\n${write.join('\n') || '- nothing'}`,
    focus,
  ].filter(Boolean).join('\n\n');

  return [
    { role: 'system', content: BUILDER_PROMPT },
    { role: 'user', content: user },
  ];
}

/** A loose schema for providers that honour one. Validation never relies on it. */
export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    story: { type: 'object', properties: { title: { type: 'string' }, premise: { type: 'string' } } },
    opening: { type: 'object', properties: { text: { type: 'string' } } },
    people: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', enum: GENERATED_ROLES },
          summary: { type: 'string' }, content: { type: 'string' },
          keys: { type: 'array', items: { type: 'string' } }, about: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'name', 'role', 'content'],
      },
    },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, section: { type: 'string', enum: BUILDER_SECTIONS }, title: { type: 'string' },
          summary: { type: 'string' }, content: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } },
          alwaysOn: { type: 'boolean' }, about: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'section', 'title', 'content'],
      },
    },
  },
};
