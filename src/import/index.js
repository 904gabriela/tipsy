// One entry point for importing anything the user drops in.
//
// The user should never have to know whether a file is a card, a lorebook,
// a chat export, or which generation of which format it is. They pick files;
// we work it out.

import { isPNG, extractCardFromPNG, ImportError } from './png.js';
import { normalizeCard, detectCardSpec, auditCard } from './card.js';
import { normalizeLorebook, auditLorebook } from './lorebook.js';
import { parseScript } from '../engine/script.js';
import { looksLikeSTPreset, convertSTPreset } from './preset-st.js';

export { ImportError, auditCard, auditLorebook };

/** Numbers read to a person, not to a machine. */
export const num = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const count = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;

/** Chat exports we know how to read. */
function detectChatExport(json) {
  if (!json || typeof json !== 'object') return null;
  if (typeof json.app === 'string' && Array.isArray(json.messages)) {
    return json.app.toLowerCase().includes('fictionlab') ? 'fictionlab' : 'generic';
  }
  return null;
}

function normalizeChatExport(json, sourceName) {
  const messages = json.messages.map((m, i) => ({
    index: i,
    role: m.role === 'assistant' || m.role === 'user' ? m.role : (m.is_user ? 'user' : 'assistant'),
    content: String(m.content ?? m.mes ?? m.text ?? ''),
  }));
  return {
    source: json.app || 'unknown',
    exportedAt: json.exportedAt || null,
    title: (json.scenario && json.scenario.name) || sourceName.replace(/\.json$/i, ''),
    scenario: json.scenario || null,
    persona: json.userCharacter || null,
    settings: json.settings || null,
    messages,
    _original: json,
  };
}

/**
 * Work out what a file is and read it.
 * @param {string} filename
 * @param {Uint8Array|string} data raw bytes for PNG, text or bytes for JSON
 * @returns {{kind: string, name: string, data: object, notes: Array}}
 */
export function importFile(filename, data) {
  const bytes = typeof data === 'string' ? null : data;

  // A PNG can only be a character card.
  if (bytes && isPNG(bytes)) {
    const { json, chunk } = extractCardFromPNG(bytes);
    const card = normalizeCard(json, filename);
    return {
      kind: 'character',
      name: card.name,
      data: card,
      notes: auditCard(card),
      detail: `Character card, ${chunk === 'ccv3' ? 'version 3' : 'version 2'}, read from the image.`,
    };
  }

  const text = typeof data === 'string'
    ? data
    : new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ImportError('BAD_JSON', 'This file is not a PNG image and is not readable as JSON. It may be damaged, or it may be a format we do not know yet.');
  }

  const chat = detectChatExport(json);
  if (chat) {
    const c = normalizeChatExport(json, filename);
    return {
      kind: 'chat',
      name: c.title,
      data: c,
      notes: [],
      detail: `Saved conversation from ${c.source}, ${c.messages.length} messages.`,
    };
  }

  if (detectCardSpec(json)) {
    const card = normalizeCard(json, filename);
    const notes = auditCard(card);
    if (card.lorebook) {
      notes.push({
        level: 'info',
        text: `This card carries its own lorebook of ${card.lorebook.entries.length} entries, which came in with it.`,
      });
    }
    return {
      kind: 'character',
      name: card.name,
      data: card,
      notes,
      detail: `Character card, ${card.spec === 'v3' ? 'version 3' : card.spec === 'v2' ? 'version 2' : 'older format'}.`,
    };
  }

  // The older kind of preset: two blocks of prose and the sampler numbers,
  // as SillyTavern and the sites around it export them. Converted into the
  // same shape as everything else here rather than kept as a special case.
  if (looksLikeSTPreset(json)) {
    const c = convertSTPreset(json, filename);
    if (!c.ok) throw new ImportError('BAD_PRESET', c.notes[0]);
    const blocks = c.script.items.filter((i) => !/\{\{(chatHistory|memory)\}\}/.test(i.content) && !i.content.includes('{{character}}')).length;
    return {
      kind: 'preset',
      name: c.name,
      data: c.script,
      settings: c.settings,
      extras: c.extras,
      notes: c.notes.map((text) => ({ level: 'info', text })),
      detail: `Preset from another app, ${count(blocks, 'block of writing rules', 'blocks of writing rules')} plus its dials.`,
    };
  }

  // A preset that writes the prompt itself, with controls that fill its
  // holes. Checked before lorebooks because both are loose JSON objects, and
  // this one is unmistakable: nothing else has items plus controls.
  if (Array.isArray(json.items) && Array.isArray(json.controls)) {
    const parsed = parseScript(json);
    if (!parsed.ok) throw new ImportError('BAD_PRESET', parsed.notes[0] || 'That preset could not be read.');
    const s = parsed.script;
    return {
      kind: 'preset',
      name: s.name,
      data: s,
      notes: parsed.notes.map((text) => ({ level: 'info', text })),
      detail: [
        `Preset${s.meta.version ? ` v${s.meta.version}` : ''}${s.meta.author ? ` by ${s.meta.author}` : ''}`,
        `${count(s.controls.length, 'control', 'controls')} across ${count(s.sections.length, 'section', 'sections')}`,
        s.bundles.length ? `${count(s.bundles.length, 'ready-made setup', 'ready-made setups')}` : '',
      ].filter(Boolean).join(', ') + '.',
    };
  }

  if (json.entries !== undefined || (json.spec === 'lorebook_v3' && json.data)) {
    const book = normalizeLorebook(json, filename);
    const audit = auditLorebook(book);
    const notes = [];
    if (audit.duplicates.length) {
      notes.push({ level: 'cleanup', text: `${count(audit.duplicates.length, 'entry repeats', 'entries repeat')} text already in this book.` });
    }
    if (audit.unreachable.length) {
      const u = audit.unreachable.length;
      notes.push({
        level: 'cleanup',
        text: u === 1
          ? '1 entry has no trigger words and is not always-on, so it can never fire.'
          : `${num(u)} entries have no trigger words and are not always-on, so they can never fire.`,
      });
    }
    if (audit.alwaysOnTokens > 3000) {
      notes.push({
        level: 'cost',
        text: `${count(audit.alwaysOnCount, 'entry is', 'entries are')} always-on, adding about ${num(audit.alwaysOnTokens)} tokens to every message.`,
      });
    }
    return {
      kind: 'lorebook',
      name: book.name,
      data: book,
      notes,
      audit,
      detail: `Lorebook, ${book.entries.length} entries.`,
    };
  }

  throw new ImportError('UNKNOWN_FORMAT', 'We could not tell what this file is. It is valid JSON but does not look like a character, a lorebook, or a saved conversation.');
}
