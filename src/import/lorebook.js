// Reading lorebooks, whatever shape they arrive in.
//
// There is one de facto standard here and at least four spellings of it.
// A standalone SillyTavern export uses camelCase and keys its entries by
// number. A book embedded in a character card uses snake_case. Some tools
// emit an array instead of an object. Files produced by conversion tools
// often carry both spellings of the same field at once, and occasionally
// disagree with themselves.
//
// So every field is read through a list of candidate names, in priority
// order, and the whole original entry is kept alongside the result. Nothing
// is discarded, which is what makes export lossless.

import { ImportError } from './png.js';

// Where an entry gets placed in the prompt. These numbers are the shared
// convention; the string forms only appear inside character cards.
export const POSITION = {
  BEFORE_CHAR: 0,
  AFTER_CHAR: 1,
  AN_TOP: 2,
  AN_BOTTOM: 3,
  AT_DEPTH: 4,
  EM_TOP: 5,
  EM_BOTTOM: 6,
  OUTLET: 7,
};

// How secondary keywords combine with the primary ones.
export const LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };

const first = (obj, names, fallback) => {
  for (const n of names) {
    const v = obj[n];
    if (v !== undefined && v !== null) return v;
  }
  return fallback;
};

const asArray = (v) => {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map(String).filter((s) => s.length > 0);
  if (typeof v === 'string') {
    // A few exporters write comma-separated strings instead of arrays. A
    // regular expression is one key, however many commas it contains.
    if (v.trim().startsWith('/')) return v.trim() ? [v.trim()] : [];
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [String(v)];
};

/** Files from converters often carry two spellings of the same list. Keep both. */
const unionKeys = (...lists) => {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const k of asArray(list)) {
      const lower = k.toLowerCase();
      if (!seen.has(lower)) { seen.add(lower); out.push(k); }
    }
  }
  return out;
};

const asBool = (v, fallback = false) => {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v === 'true' || v === '1';
  return fallback;
};

const asNum = (v, fallback = null) => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function readPosition(entry, ext) {
  const raw = first(entry, ['position'], undefined);
  const fromExt = asNum(ext.position, null);

  if (typeof raw === 'string') {
    // Character-card spelling. The extension value, when present, is more
    // precise, because the card format can only say before or after.
    if (fromExt !== null) return fromExt;
    return raw === 'before_char' ? POSITION.BEFORE_CHAR : POSITION.AFTER_CHAR;
  }
  const n = asNum(raw, null);
  if (n !== null) return n;
  if (fromExt !== null) return fromExt;
  return POSITION.BEFORE_CHAR;
}

/** Lines beginning @@ at the top of an entry's content are directives, not prose. */
function splitDecorators(content) {
  const lines = String(content).split('\n');
  const decorators = [];
  let i = 0;
  while (i < lines.length && /^@@@?[a-z_]/i.test(lines[i].trim())) {
    decorators.push(lines[i].trim());
    i++;
  }
  return { decorators, content: lines.slice(i).join('\n').replace(/^\n+/, '') };
}

/**
 * Turn one entry of any dialect into our shape.
 * @param {object} raw
 * @param {number} index position in the source file, used when there is no id
 */
export function normalizeEntry(raw, index) {
  const ext = (raw.extensions && typeof raw.extensions === 'object') ? raw.extensions : {};
  const { decorators, content } = splitDecorators(first(raw, ['content'], ''));

  // "enabled" and "disable" mean opposite things, and files carry either.
  // When both are present and disagree, `disable` is SillyTavern's own
  // field and the one the author actually clicked; `enabled` is what a
  // converter stamped on afterwards.
  let enabled = true;
  if (raw.disable !== undefined) enabled = !asBool(raw.disable, false);
  else if (raw.enabled !== undefined) enabled = asBool(raw.enabled, true);

  return {
    uid: first(raw, ['uid', 'id'], index),
    outletName: String(first(raw, ['outletName', 'outlet_name'], ext.outlet_name) ?? ''),
    keys: unionKeys(raw.key, raw.keys),
    secondaryKeys: unionKeys(raw.keysecondary, raw.secondary_keys, raw.secondaryKeys),
    content,
    decorators,
    title: first(raw, ['comment', 'name'], ''),

    enabled,
    constant: asBool(first(raw, ['constant'], false)),
    selective: asBool(first(raw, ['selective'], true), true),
    selectiveLogic: asNum(first(raw, ['selectiveLogic', 'selective_logic'], first(ext, ['selectiveLogic', 'selective_logic'], LOGIC.AND_ANY)), LOGIC.AND_ANY),

    order: asNum(first(raw, ['order', 'insertion_order', 'insertionOrder', 'priority'], 100), 100),
    position: readPosition(raw, ext),
    depth: asNum(first(raw, ['depth'], ext.depth), 4),
    role: asNum(first(raw, ['role'], ext.role), 0),

    probability: asNum(first(raw, ['probability'], ext.probability), 100),
    useProbability: asBool(first(raw, ['useProbability', 'use_probability'], ext.useProbability), true),

    caseSensitive: asBool(first(raw, ['caseSensitive', 'case_sensitive'], ext.case_sensitive), false),
    matchWholeWords: asBool(first(raw, ['matchWholeWords', 'match_whole_words'], ext.match_whole_words), false),
    useRegex: asBool(first(raw, ['use_regex', 'useRegex'], false)),

    scanDepth: asNum(first(raw, ['scanDepth', 'scan_depth'], ext.scan_depth), null),
    excludeRecursion: asBool(first(raw, ['excludeRecursion', 'exclude_recursion'], ext.exclude_recursion)),
    preventRecursion: asBool(first(raw, ['preventRecursion', 'prevent_recursion'], ext.prevent_recursion)),
    delayUntilRecursion: first(raw, ['delayUntilRecursion', 'delay_until_recursion'], ext.delay_until_recursion) ?? 0,

    group: String(first(raw, ['group'], ext.group) ?? ''),
    groupOverride: asBool(first(raw, ['groupOverride', 'groupOveride', 'group_override'], ext.group_override)),
    groupWeight: asNum(first(raw, ['groupWeight', 'group_weight'], ext.group_weight), 100),
    useGroupScoring: asBool(first(raw, ['useGroupScoring', 'use_group_scoring'], ext.use_group_scoring), false),

    sticky: asNum(first(raw, ['sticky'], ext.sticky), null),
    cooldown: asNum(first(raw, ['cooldown'], ext.cooldown), null),
    delay: asNum(first(raw, ['delay'], ext.delay), null),

    ignoreBudget: asBool(first(raw, ['ignoreBudget', 'ignore_budget'], ext.ignore_budget)),
    vectorized: asBool(first(raw, ['vectorized'], ext.vectorized)),
    automationId: String(first(raw, ['automationId', 'automation_id'], ext.automation_id) ?? ''),
    triggers: asArray(first(raw, ['triggers'], ext.triggers)),
    characterFilter: first(raw, ['characterFilter', 'character_filter'], null),

    // Everything exactly as it arrived, so nothing is lost on the way out.
    _original: raw,
  };
}

/** Entries arrive as an array or as an object keyed by number. Both are fine. */
function entryList(entries) {
  if (Array.isArray(entries)) return entries;
  if (entries && typeof entries === 'object') {
    // Sort numerically where the keys are numeric, so original order survives.
    return Object.keys(entries)
      .sort((a, b) => {
        const na = Number(a), nb = Number(b);
        if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
        return String(a).localeCompare(String(b));
      })
      .map((k) => entries[k]);
  }
  return [];
}

/**
 * Read a lorebook from any of the shapes we have seen.
 * @param {object} json
 * @param {string} [sourceName] filename, used as a fallback title
 */
export function normalizeLorebook(json, sourceName = '') {
  // A V3 standalone lorebook wraps everything in { spec, data }.
  const body = (json && json.spec === 'lorebook_v3' && json.data) ? json.data : json;

  if (!body || typeof body !== 'object' || body.entries === undefined) {
    throw new ImportError('NOT_A_LOREBOOK', 'This file does not look like a lorebook. It has no entries in it.');
  }

  const raws = entryList(body.entries);
  const entries = raws.map((e, i) => normalizeEntry(e, i));

  return {
    name: String(body.name || sourceName.replace(/\.json$/i, '') || 'Untitled lorebook'),
    description: String(body.description || ''),
    scanDepth: asNum(first(body, ['scan_depth', 'scanDepth', 'defaultScanDepth'], null), null),
    tokenBudget: asNum(first(body, ['token_budget', 'tokenBudget'], null), null),
    recursiveScanning: asBool(first(body, ['recursive_scanning', 'recursiveScanning'], false)),
    entries,
    _original: json,
  };
}

/**
 * Report on a lorebook without changing it: duplicates, entries that can
 * never fire, and how much is loaded into every single message.
 */
export function auditLorebook(book) {
  const live = book.entries.filter((e) => e.enabled);
  const normal = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

  const seen = new Map();
  const duplicates = [];
  for (const e of live) {
    const k = normal(e.content);
    if (!k) continue;
    if (seen.has(k)) duplicates.push({ entry: e, sameAs: seen.get(k) });
    else seen.set(k, e);
  }

  const alwaysOn = live.filter((e) => e.constant);
  const unreachable = live.filter((e) => !e.constant && e.keys.length === 0);
  const estimate = (list) => Math.round(list.reduce((a, e) => a + e.content.length, 0) / 4);

  return {
    total: book.entries.length,
    enabled: live.length,
    disabled: book.entries.length - live.length,
    duplicates,
    unreachable,
    alwaysOnCount: alwaysOn.length,
    alwaysOnTokens: estimate(alwaysOn),
    alwaysOnTokensDeduped: estimate(
      alwaysOn.filter((e, i) => alwaysOn.findIndex((o) => normal(o.content) === normal(e.content)) === i)
    ),
    totalTokens: estimate(live),
  };
}
