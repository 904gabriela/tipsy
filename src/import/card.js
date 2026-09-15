// Reading character cards.
//
// Three generations of the format are in the wild. V1 is a flat object with
// six fields. V2 moved everything under `data` and added greetings, an
// embedded lorebook and prompt overrides. V3 added nicknames, assets and
// group-only greetings. Cards from Pygmalion-era tools use different names
// again.
//
// All of them normalize to one shape, and the original is kept so that
// exporting gives back what came in.

import { ImportError } from './png.js';
import { normalizeLorebook } from './lorebook.js';

const num = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const str = (v) => (v === undefined || v === null ? '' : String(v));
const strArray = (v) => (Array.isArray(v) ? v.map(str).filter((s) => s.length > 0) : []);

/** Which generation of the format is this? */
export function detectCardSpec(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.spec === 'chara_card_v3') return 'v3';
  if (json.spec === 'chara_card_v2') return 'v2';
  // A standalone V3 lorebook also nests a name under `data`, and is not a card.
  if (json.spec === 'lorebook_v3') return null;
  if (json.data && typeof json.data === 'object' && json.data.entries !== undefined && json.data.first_mes === undefined) return null;
  if (json.data && typeof json.data === 'object' && json.data.name !== undefined) return 'v2';
  if (json.char_name !== undefined || json.char_persona !== undefined) return 'pygmalion';

  // A lorebook also carries a name and a description, so those two alone are
  // not enough to call something a character. Top-level entries settle it:
  // a card keeps its lore under character_book, never at the top.
  if (json.entries !== undefined) return null;
  if (json.name !== undefined && json.description !== undefined) return 'v1';
  return null;
}

function fromPygmalion(j) {
  return {
    name: str(j.char_name),
    description: str(j.char_persona),
    scenario: str(j.world_scenario),
    firstMessage: str(j.char_greeting),
    exampleDialogue: str(j.example_dialogue),
    personality: '',
  };
}

/**
 * Read a character card of any generation.
 * @param {object} json
 * @param {string} [sourceName] filename, used as a fallback name
 */
export function normalizeCard(json, sourceName = '') {
  const spec = detectCardSpec(json);
  if (!spec) {
    throw new ImportError(
      'NOT_A_CARD',
      'This file does not look like a character card. It may be a lorebook, or an export from something else.'
    );
  }

  if (spec === 'pygmalion') {
    const p = fromPygmalion(json);
    return { ...blankCard(), ...p, spec, _original: json };
  }

  // V2 and V3 nest under `data`. V1 is flat.
  const d = (spec === 'v1') ? json : (json.data || json);
  const ext = (d.extensions && typeof d.extensions === 'object') ? d.extensions : {};

  let lorebook = null;
  if (d.character_book && d.character_book.entries) {
    try {
      lorebook = normalizeLorebook(d.character_book, `${str(d.name)} lorebook`);
    } catch {
      lorebook = null; // a broken embedded book should not sink the card
    }
  }

  return {
    spec,
    name: str(d.name) || sourceName.replace(/\.(json|png|charx)$/i, '') || 'Unnamed character',
    nickname: str(d.nickname),

    // The parts that become the prompt.
    description: str(d.description),
    personality: str(d.personality),
    scenario: str(d.scenario),
    firstMessage: str(d.first_mes),
    exampleDialogue: str(d.mes_example),
    alternateGreetings: strArray(d.alternate_greetings),
    groupOnlyGreetings: strArray(d.group_only_greetings),

    // Prompt overrides. Empty means "use my own settings".
    systemPrompt: str(d.system_prompt),
    postHistoryInstructions: str(d.post_history_instructions),
    depthPrompt: ext.depth_prompt ? {
      text: str(ext.depth_prompt.prompt),
      depth: Number(ext.depth_prompt.depth ?? 4),
      role: str(ext.depth_prompt.role || 'system'),
    } : null,

    // Never sent to the model. For your eyes and for filtering.
    creatorNotes: str(d.creator_notes),

    // Where the card keeps its art. A PNG card IS the picture; a JSON one
    // points at it, usually on the site it came from. "none" is what the
    // exporters write when there is none, so it is not a link.
    avatar: (() => {
      const a = str(d.avatar) || str(json.avatar);
      return a && a !== 'none' ? a : '';
    })(),
    creator: str(d.creator),
    version: str(d.character_version),
    tags: strArray(d.tags),

    lorebook,
    // A card can name a separate lorebook file it expects to be paired with.
    linkedWorld: str(ext.world),
    talkativeness: ext.talkativeness !== undefined ? Number(ext.talkativeness) : null,
    assets: Array.isArray(d.assets) ? d.assets : [],

    _original: json,
  };
}

function blankCard() {
  return {
    spec: null, name: '', nickname: '',
    description: '', personality: '', scenario: '',
    firstMessage: '', exampleDialogue: '',
    alternateGreetings: [], groupOnlyGreetings: [],
    systemPrompt: '', postHistoryInstructions: '', depthPrompt: null,
    creatorNotes: '', creator: '', version: '', tags: [], avatar: '',
    lorebook: null, linkedWorld: '', talkativeness: null, assets: [],
  };
}

/**
 * Point out things about a card that will cause trouble later, in plain words.
 * A card is never rejected for these; the user decides what to do.
 */
export function auditCard(card) {
  const notes = [];
  const est = (s) => Math.round(s.length / 4);

  const alwaysOn = est(card.description) + est(card.personality) + est(card.scenario);
  if (alwaysOn > 2000) {
    notes.push({
      level: 'cost',
      text: `This character's description, personality and scenario come to about ${num(alwaysOn)} tokens, and all of it is sent with every single message.`,
    });
  }

  if (est(card.firstMessage) > 4000) {
    notes.push({
      level: 'odd',
      text: `The opening message is about ${num(est(card.firstMessage))} tokens, which is far longer than a greeting. It looks like a previous story was pasted in to carry memory forward. Worth moving into the story proper.`,
    });
  }

  if (card.exampleDialogue && est(card.exampleDialogue) > 1500) {
    notes.push({
      level: 'cost',
      text: 'The example dialogue is long. It teaches voice well but is charged for on every message.',
    });
  }

  if (card.linkedWorld) {
    notes.push({
      level: 'info',
      text: `This card expects a separate lorebook called "${card.linkedWorld}". Import that too, or its lore will be missing.`,
    });
  }

  return notes;
}
