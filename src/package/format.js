// Nexus Story Package, version 1: the shape, the rules, and one canonical form.
//
// A package carries people, what is known about them, and the stories they
// are in, without flattening any of it into a card's description:
//
//   {
//     "format": "nexus-package", "version": 1,
//     "package":    { id, title, role, domains?, extensions? },
//     "entities":   [{ ref, type, name, aliases? }],
//     "characters": [{ ref, name, nickname?, entity?, core, openings, creatorNotes?, tags?, extensions? }],
//     "personas":   [{ ref, name, entity?, core }],
//     "sources":    [{ ref, name, description?, role, domains?, subject?, story?, settings?, entries, extensions? }],
//     "stories":    [{ ref, title, persona?, cast, sources, exclusions?, npcs?, directions?, premise? }],
//     "extensions": {}
//   }
//
// Refs are local to one package. The same ref in two packages is not the same
// person; reusing an existing entity is a decision made at import.
//
// `subject` on a source means the source is reusable material primarily about
// that entity. It says nothing about any single entry: entries say what they
// are about in their own `semantics`. `story` on a source makes it that one
// story's own material.
//
// Knowledge visibility (private, restricted, hidden, known-by) is NOT part of
// v1. Nexus does not enforce it yet, and accepting it would promise a privacy
// the prompt does not keep, so the validator refuses it.
//
// Pure: no database, no network.

import { ENTITY_TYPES, PERSON_CATEGORIES, WORLD_CATEGORIES, PACKAGE_ROLES } from '../semantics/authority.js';

export const FORMAT = 'nexus-package';
export const VERSION = 1;

const REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const DOMAIN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_TEXT = 1_000_000;
const MAX_ENTRIES = 20_000;
export const ENTITY_CATEGORIES = [...PERSON_CATEGORIES, 'profile'];
export const POLICIES = ['always', 'keywords', 'advanced'];
export const RESERVED_VISIBILITY = ['visibility', 'knownBy', 'knowers', 'hiddenFrom', 'private'];

export const CHARACTER_CORE = ['identity', 'appearance', 'personality', 'behavior', 'speechStyle', 'speechExamples', 'systemInstructions', 'postHistoryInstructions', 'depthPrompt'];
export const PERSONA_CORE = ['identity', 'appearance', 'personality', 'behavior', 'speechStyle'];

/** Every activation field, with the value an entry has when the field is not given. */
export const ACTIVATION_DEFAULTS = {
  keys: [], secondaryKeys: [], selective: true, selectiveLogic: 0,
  caseSensitive: false, matchWholeWords: false, useRegex: false,
  probability: 100, useProbability: true, order: 100, position: 0, depth: 4, role: 0,
  scanDepth: null, excludeRecursion: false, preventRecursion: false, delayUntilRecursion: 0,
  group: '', groupOverride: false, groupWeight: 100, useGroupScoring: false,
  sticky: null, cooldown: null, delay: null, ignoreBudget: false, vectorized: false, decorators: [],
};

export class PackageError extends Error {
  constructor(message, errors = []) { super(message); this.name = 'PackageError'; this.status = 400; this.errors = errors; }
}

// ------------------------------------------------------------------ validate

/**
 * Check a package against v1.
 *
 * Strict about shape: an unknown field is an error, not silently dropped, so
 * nothing in a file can quietly fail to arrive. Vendor data belongs under an
 * `extensions` object where one is allowed, and is kept as it is.
 *
 * @returns {{ ok: boolean, errors: {path: string, message: string}[], warnings: {path: string, message: string}[] }}
 */
export function validatePackage(pkg) {
  const errors = [];
  const warnings = [];
  const err = (path, message) => errors.push({ path, message });
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = (v, path, { required = false, max = MAX_TEXT } = {}) => {
    if (v === undefined) { if (required) err(path, 'is required.'); return; }
    if (typeof v !== 'string') { err(path, 'must be text.'); return; }
    if (required && !v.trim()) err(path, 'must not be empty.');
    if (v.length > max) err(path, `is longer than ${max} characters.`);
  };
  const strList = (v, path) => {
    if (v === undefined) return;
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) err(path, 'must be a list of text.');
  };
  const known = (obj, path, allowed) => {
    for (const k of Object.keys(obj)) {
      if (RESERVED_VISIBILITY.includes(k)) {
        err(`${path}.${k}`, 'Knowledge visibility is reserved for a later package version. Nexus does not enforce who knows what yet, so v1 does not accept it.');
      } else if (!allowed.includes(k)) {
        err(`${path}.${k}`, 'is not part of Nexus Package v1. Put vendor data under "extensions" where it is allowed.');
      }
    }
  };
  // Domains are tags, written the way Nexus stores them, so a round trip cannot change them.
  const domains = (v, path) => {
    if (v === undefined) return;
    if (!Array.isArray(v)) { err(path, 'must be a list of tags.'); return; }
    const seen = new Set();
    v.forEach((d, i) => {
      if (typeof d !== 'string' || !DOMAIN.test(d)) err(`${path}[${i}]`, 'must be a lower-case tag: letters and digits, words joined by "-" (for example "first-aid").');
      else if (seen.has(d)) err(`${path}[${i}]`, `"${d}" is listed twice.`);
      seen.add(d);
    });
  };
  const extensions = (v, path) => { if (v !== undefined && !isObj(v)) err(path, 'must be an object.'); };
  const refOf = (v, path) => {
    if (typeof v !== 'string' || !REF.test(v)) { err(path, 'must be a ref: letters, digits, ".", "_" or "-", starting with a letter or digit.'); return false; }
    return true;
  };
  const uniqueRefs = (list, path) => {
    const seen = new Set();
    list.forEach((x, i) => {
      if (!isObj(x)) return;
      if (refOf(x.ref, `${path}[${i}].ref`)) {
        if (seen.has(x.ref)) err(`${path}[${i}].ref`, `"${x.ref}" is used twice.`);
        seen.add(x.ref);
      }
    });
    return seen;
  };
  const list = (v, path, { required = false } = {}) => {
    if (v === undefined) { if (required) err(path, 'is required.'); return []; }
    if (!Array.isArray(v)) { err(path, 'must be a list.'); return []; }
    return v;
  };

  if (!isObj(pkg)) return { ok: false, errors: [{ path: '', message: 'A package is a JSON object.' }], warnings };
  if (pkg.format !== FORMAT) err('format', `must be "${FORMAT}".`);
  if (pkg.version !== VERSION) {
    err('version', typeof pkg.version === 'number' && pkg.version > VERSION
      ? `is ${pkg.version}; this Nexus reads version ${VERSION}.` : `must be ${VERSION}.`);
  }
  known(pkg, '', ['format', 'version', 'package', 'entities', 'characters', 'personas', 'sources', 'stories', 'extensions']);
  extensions(pkg.extensions, 'extensions');

  if (!isObj(pkg.package)) err('package', 'is required.');
  else {
    const p = pkg.package;
    known(p, 'package', ['id', 'title', 'role', 'domains', 'extensions']);
    str(p.id, 'package.id', { required: true, max: 200 });
    str(p.title, 'package.title', { required: true, max: 500 });
    if (!PACKAGE_ROLES.includes(p.role)) err('package.role', `must be one of ${PACKAGE_ROLES.join(', ')}.`);
    domains(p.domains, 'package.domains');
    extensions(p.extensions, 'package.extensions');
  }

  // ---- entities
  const entities = list(pkg.entities, 'entities');
  const entityRefs = uniqueRefs(entities, 'entities');
  const entityType = new Map();
  entities.forEach((e, i) => {
    const path = `entities[${i}]`;
    if (!isObj(e)) { err(path, 'must be an object.'); return; }
    known(e, path, ['ref', 'type', 'name', 'aliases']);
    if (!ENTITY_TYPES.includes(e.type)) err(`${path}.type`, `must be one of ${ENTITY_TYPES.join(', ')}.`);
    str(e.name, `${path}.name`, { required: true, max: 500 });
    strList(e.aliases, `${path}.aliases`);
    entityType.set(e.ref, e.type);
  });
  const entityRef = (v, path, { person = false } = {}) => {
    if (!refOf(v, path)) return false;
    if (!entityRefs.has(v)) { err(path, `"${v}" is not an entity in this package.`); return false; }
    if (person && entityType.get(v) !== 'person') err(path, `"${v}" is a ${entityType.get(v)}; only a person can be a character or persona.`);
    return true;
  };

  // ---- characters and personas
  const coreBlock = (core, path, slots) => {
    if (core === undefined) return;
    if (!isObj(core)) { err(path, 'must be an object.'); return; }
    known(core, path, slots);
    for (const k of slots) {
      if (k === 'depthPrompt') {
        if (core.depthPrompt !== undefined && core.depthPrompt !== null && !isObj(core.depthPrompt)) err(`${path}.depthPrompt`, 'must be an object or null.');
      } else str(core[k], `${path}.${k}`);
    }
  };
  const characters = list(pkg.characters, 'characters');
  const characterRefs = uniqueRefs(characters, 'characters');
  const characterEntity = new Map();
  characters.forEach((c, i) => {
    const path = `characters[${i}]`;
    if (!isObj(c)) { err(path, 'must be an object.'); return; }
    known(c, path, ['ref', 'name', 'nickname', 'entity', 'core', 'openings', 'creatorNotes', 'tags', 'extensions']);
    str(c.name, `${path}.name`, { required: true, max: 500 });
    str(c.nickname, `${path}.nickname`, { max: 500 });
    if (c.entity !== undefined && entityRef(c.entity, `${path}.entity`, { person: true })) characterEntity.set(c.ref, c.entity);
    coreBlock(c.core, `${path}.core`, CHARACTER_CORE);
    if (c.openings !== undefined) {
      if (!isObj(c.openings)) err(`${path}.openings`, 'must be an object.');
      else {
        known(c.openings, `${path}.openings`, ['scenario', 'first', 'alternates']);
        str(c.openings.scenario, `${path}.openings.scenario`);
        str(c.openings.first, `${path}.openings.first`);
        strList(c.openings.alternates, `${path}.openings.alternates`);
      }
    }
    str(c.creatorNotes, `${path}.creatorNotes`);
    strList(c.tags, `${path}.tags`);
    extensions(c.extensions, `${path}.extensions`);
  });

  const personas = list(pkg.personas, 'personas');
  const personaRefs = uniqueRefs(personas, 'personas');
  personas.forEach((p, i) => {
    const path = `personas[${i}]`;
    if (!isObj(p)) { err(path, 'must be an object.'); return; }
    known(p, path, ['ref', 'name', 'entity', 'core']);
    str(p.name, `${path}.name`, { required: true, max: 500 });
    if (p.entity !== undefined) entityRef(p.entity, `${path}.entity`, { person: true });
    coreBlock(p.core, `${path}.core`, PERSONA_CORE);
  });

  // ---- stories (refs first; sources point at them)
  const stories = list(pkg.stories, 'stories');
  const storyRefs = uniqueRefs(stories, 'stories');

  // ---- sources
  const sources = list(pkg.sources, 'sources');
  const sourceRefs = uniqueRefs(sources, 'sources');
  const entryRefsBySource = new Map();
  const ownerOf = new Map();
  let entryCount = 0;
  sources.forEach((s, i) => {
    const path = `sources[${i}]`;
    if (!isObj(s)) { err(path, 'must be an object.'); return; }
    known(s, path, ['ref', 'name', 'description', 'role', 'domains', 'subject', 'story', 'settings', 'entries', 'extensions']);
    str(s.name, `${path}.name`, { required: true, max: 500 });
    str(s.description, `${path}.description`);
    if (!PACKAGE_ROLES.includes(s.role)) err(`${path}.role`, `must be one of ${PACKAGE_ROLES.join(', ')}.`);
    domains(s.domains, `${path}.domains`);
    if (s.subject !== undefined) entityRef(s.subject, `${path}.subject`);
    if (s.story !== undefined && refOf(s.story, `${path}.story`)) {
      if (!storyRefs.has(s.story)) err(`${path}.story`, `"${s.story}" is not a story in this package.`);
      else ownerOf.set(s.ref, s.story);
    }
    if (s.subject !== undefined && s.story !== undefined) err(path, "A source is either reusable material about someone (subject) or one story's own material (story), not both.");
    if (s.settings !== undefined) {
      if (!isObj(s.settings)) err(`${path}.settings`, 'must be an object.');
      else {
        known(s.settings, `${path}.settings`, ['scanDepth', 'tokenBudget', 'recursive']);
        for (const k of ['scanDepth', 'tokenBudget']) {
          const v = s.settings[k];
          if (v !== undefined && v !== null && !(Number.isInteger(v) && v >= 0)) err(`${path}.settings.${k}`, 'must be a whole number or null.');
        }
        if (s.settings.recursive !== undefined && typeof s.settings.recursive !== 'boolean') err(`${path}.settings.recursive`, 'must be true or false.');
      }
    }
    extensions(s.extensions, `${path}.extensions`);

    const entries = list(s.entries, `${path}.entries`, { required: true });
    entryCount += entries.length;
    const refs = uniqueRefs(entries, `${path}.entries`);
    entryRefsBySource.set(s.ref, refs);
    entries.forEach((e, k) => validateEntry(e, `${path}.entries[${k}]`));
  });
  if (entryCount > MAX_ENTRIES) err('sources', `hold ${entryCount} entries; the limit is ${MAX_ENTRIES}.`);

  function validateEntry(e, path) {
    if (!isObj(e)) { err(path, 'must be an object.'); return; }
    known(e, path, ['ref', 'title', 'content', 'enabled', 'summary', 'activation', 'semantics', 'extensions']);
    str(e.title, `${path}.title`, { max: 2000 });
    str(e.content, `${path}.content`, { required: true });
    if (e.enabled !== undefined && typeof e.enabled !== 'boolean') err(`${path}.enabled`, 'must be true or false.');
    str(e.summary, `${path}.summary`);
    extensions(e.extensions, `${path}.extensions`);

    const a = e.activation;
    if (!isObj(a)) err(`${path}.activation`, 'is required.');
    else {
      known(a, `${path}.activation`, ['policy', 'constant', ...Object.keys(ACTIVATION_DEFAULTS)]);
      if (a.policy === 'auto') err(`${path}.activation.policy`, '"auto" is reserved and not available yet. Use always, keywords or advanced.');
      else if (!POLICIES.includes(a.policy)) err(`${path}.activation.policy`, `must be one of ${POLICIES.join(', ')}.`);
      strList(a.keys, `${path}.activation.keys`);
      strList(a.secondaryKeys, `${path}.activation.secondaryKeys`);
      if (a.constant !== undefined && a.policy !== 'advanced') err(`${path}.activation.constant`, 'is only given with policy "advanced"; "always" and "keywords" already say it.');
      if (a.constant !== undefined && typeof a.constant !== 'boolean') err(`${path}.activation.constant`, 'must be true or false.');
      if (a.policy === 'keywords' && !(Array.isArray(a.keys) && a.keys.some((k) => typeof k === 'string' && k.trim()))) {
        err(`${path}.activation.keys`, 'must hold at least one keyword when the policy is "keywords".');
      }
      for (const [k, d] of Object.entries(ACTIVATION_DEFAULTS)) {
        const v = a[k];
        if (v === undefined || ['keys', 'secondaryKeys'].includes(k)) continue;
        if (k === 'decorators') { strList(v, `${path}.activation.decorators`); continue; }
        if (typeof d === 'boolean' && typeof v !== 'boolean') err(`${path}.activation.${k}`, 'must be true or false.');
        if (typeof d === 'string' && typeof v !== 'string') err(`${path}.activation.${k}`, 'must be text.');
        if ((typeof d === 'number' || d === null) && !(v === null ? d === null : Number.isFinite(v))) err(`${path}.activation.${k}`, d === null ? 'must be a number or null.' : 'must be a number.');
      }
    }

    const m = e.semantics;
    if (m === undefined) return;
    if (!isObj(m)) { err(`${path}.semantics`, 'must be an object.'); return; }
    known(m, `${path}.semantics`, ['scope', 'category', 'subject', 'defines', 'related', 'displayPath']);
    if (!['entity', 'world', 'other'].includes(m.scope)) err(`${path}.semantics.scope`, 'must be entity, world or other.');
    const allowed = m.scope === 'entity' ? ENTITY_CATEGORIES : m.scope === 'world' ? WORLD_CATEGORIES : ['other'];
    if (!allowed.includes(m.category)) {
      err(`${path}.semantics.category`, `"${m.category}" is not a ${m.scope || ''} category. Use one of ${allowed.join(', ')}; a universe's own words ("Quirk", "Magic") go in displayPath.`);
    }
    if (m.subject !== undefined) entityRef(m.subject, `${path}.semantics.subject`);
    if (m.defines !== undefined) entityRef(m.defines, `${path}.semantics.defines`);
    if (m.scope === 'entity' && m.subject === undefined && m.defines === undefined) err(`${path}.semantics`, 'An entity entry names the entity it is about (subject) or defines (defines).');
    if (m.scope !== 'entity' && (m.subject !== undefined || m.defines !== undefined)) err(`${path}.semantics`, 'Only an entity entry has a subject or defines an entity.');
    if (m.subject !== undefined && m.defines !== undefined) err(`${path}.semantics`, 'An entry either defines an entity or is about one, not both.');
    if (m.related !== undefined) {
      if (!Array.isArray(m.related)) err(`${path}.semantics.related`, 'must be a list of entity refs.');
      else {
        const seen = new Set();
        m.related.forEach((r, k) => {
          if (!entityRef(r, `${path}.semantics.related[${k}]`)) return;
          if (seen.has(r)) err(`${path}.semantics.related[${k}]`, `"${r}" is listed twice.`);
          if (r === m.subject || r === m.defines) err(`${path}.semantics.related[${k}]`, `"${r}" is already what this entry is about.`);
          seen.add(r);
        });
      }
    }
    if (m.displayPath !== undefined) {
      if (!Array.isArray(m.displayPath) || !m.displayPath.length || m.displayPath.length > 8
        || m.displayPath.some((g) => typeof g !== 'string' || !g.trim() || g.trim().length > 80)) {
        err(`${path}.semantics.displayPath`, 'must be a list of one to eight group names, each 1 to 80 characters.');
      }
    }
  }

  // ---- stories
  const attachedTo = new Map();
  stories.forEach((st, i) => {
    const path = `stories[${i}]`;
    if (!isObj(st)) { err(path, 'must be an object.'); return; }
    known(st, path, ['ref', 'title', 'persona', 'cast', 'sources', 'exclusions', 'npcs', 'directions', 'premise']);
    str(st.title, `${path}.title`, { required: true, max: 500 });
    str(st.directions, `${path}.directions`);
    str(st.premise, `${path}.premise`);
    if (st.persona !== undefined && refOf(st.persona, `${path}.persona`) && !personaRefs.has(st.persona)) err(`${path}.persona`, `"${st.persona}" is not a persona in this package.`);

    const cast = list(st.cast, `${path}.cast`, { required: true });
    let leads = 0;
    const castSeen = new Set();
    cast.forEach((c, k) => {
      const cp = `${path}.cast[${k}]`;
      if (!isObj(c)) { err(cp, 'must be an object.'); return; }
      known(c, cp, ['character', 'role', 'entity']);
      if (refOf(c.character, `${cp}.character`)) {
        if (!characterRefs.has(c.character)) err(`${cp}.character`, `"${c.character}" is not a character in this package.`);
        if (castSeen.has(c.character)) err(`${cp}.character`, `"${c.character}" is cast twice.`);
        castSeen.add(c.character);
      }
      if (!['lead', 'cast'].includes(c.role)) err(`${cp}.role`, 'must be lead or cast.');
      if (c.role === 'lead') leads++;
      if (c.entity !== undefined && entityRef(c.entity, `${cp}.entity`, { person: true })) {
        const own = characterEntity.get(c.character);
        if (own && own !== c.entity) err(`${cp}.entity`, `"${c.character}" already represents "${own}".`);
      }
    });
    if (leads !== 1) err(`${path}.cast`, 'A story has exactly one lead.');

    const attached = new Set();
    list(st.sources, `${path}.sources`, { required: true }).forEach((a, k) => {
      const ap = `${path}.sources[${k}]`;
      if (!isObj(a)) { err(ap, 'must be an object.'); return; }
      known(a, ap, ['source', 'recursion']);
      if (refOf(a.source, `${ap}.source`)) {
        if (!sourceRefs.has(a.source)) err(`${ap}.source`, `"${a.source}" is not a source in this package.`);
        if (attached.has(a.source)) err(`${ap}.source`, `"${a.source}" is attached twice.`);
        attached.add(a.source);
        if (!attachedTo.has(a.source)) attachedTo.set(a.source, new Set());
        attachedTo.get(a.source).add(st.ref);
      }
      if (a.recursion !== undefined && a.recursion !== null && a.recursion !== 'block') err(`${ap}.recursion`, 'must be "block" or null.');
    });
    const entryIn = (o, p) => {
      if (!isObj(o)) { err(p, 'must be an object.'); return; }
      if (!refOf(o.source, `${p}.source`) || !refOf(o.entry, `${p}.entry`)) return;
      if (!attached.has(o.source)) err(`${p}.source`, `"${o.source}" is not attached to this story.`);
      else if (!entryRefsBySource.get(o.source)?.has(o.entry)) err(`${p}.entry`, `"${o.entry}" is not an entry of "${o.source}".`);
    };
    list(st.exclusions, `${path}.exclusions`).forEach((x, k) => {
      if (isObj(x)) known(x, `${path}.exclusions[${k}]`, ['source', 'entry']);
      entryIn(x, `${path}.exclusions[${k}]`);
    });
    list(st.npcs, `${path}.npcs`).forEach((n, k) => {
      const np = `${path}.npcs[${k}]`;
      if (isObj(n)) {
        known(n, np, ['source', 'entry', 'role']);
        if (!['main', 'supporting', 'background'].includes(n.role)) err(`${np}.role`, 'must be main, supporting or background.');
      }
      entryIn(n, np);
    });
  });

  for (const [source, story] of ownerOf) {
    const on = attachedTo.get(source) || new Set();
    if (!on.has(story)) err(`sources.${source}`, `is "${story}"'s own material but "${story}" does not attach it.`);
    for (const other of on) if (other !== story) err(`sources.${source}`, `is "${story}"'s own material and cannot also be attached to "${other}".`);
  }
  if (!entities.length && !characters.length && !personas.length && !sources.length && !stories.length) {
    warnings.push({ path: '', message: 'The package is empty.' });
  }
  return { ok: errors.length === 0, errors, warnings };
}

// ------------------------------------------------------------------ canonical

const byRef = (a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
const text = (v) => (typeof v === 'string' ? v : '');
const withExtensions = (out, ext) => (ext && Object.keys(ext).length ? { ...out, extensions: ext } : out);

/**
 * One package in its canonical form: every default written out, keys in a
 * fixed order, unordered lists sorted by ref. Two packages that mean the same
 * thing serialise to the same bytes. The exporter produces exactly this.
 */
export function canonicalPackage(pkg) {
  const out = {
    format: FORMAT,
    version: VERSION,
    package: withExtensions({
      id: pkg.package.id,
      title: pkg.package.title,
      role: pkg.package.role,
      domains: [...(pkg.package.domains || [])],
    }, pkg.package.extensions),
    entities: (pkg.entities || []).map((e) => ({ ref: e.ref, type: e.type, name: e.name, aliases: [...(e.aliases || [])] })).sort(byRef),
    characters: (pkg.characters || []).map((c) => withExtensions({
      ref: c.ref,
      name: c.name,
      nickname: text(c.nickname),
      ...(c.entity ? { entity: c.entity } : {}),
      core: Object.fromEntries(CHARACTER_CORE.map((k) => [k, k === 'depthPrompt' ? (c.core?.depthPrompt ?? null) : text(c.core?.[k])])),
      openings: { scenario: text(c.openings?.scenario), first: text(c.openings?.first), alternates: [...(c.openings?.alternates || [])] },
      creatorNotes: text(c.creatorNotes),
      tags: [...(c.tags || [])],
    }, c.extensions)).sort(byRef),
    personas: (pkg.personas || []).map((p) => ({
      ref: p.ref,
      name: p.name,
      ...(p.entity ? { entity: p.entity } : {}),
      core: Object.fromEntries(PERSONA_CORE.map((k) => [k, text(p.core?.[k])])),
    })).sort(byRef),
    sources: (pkg.sources || []).map((s) => withExtensions({
      ref: s.ref,
      name: s.name,
      description: text(s.description),
      role: s.role,
      domains: [...(s.domains || [])],
      ...(s.subject ? { subject: s.subject } : {}),
      ...(s.story ? { story: s.story } : {}),
      settings: { scanDepth: s.settings?.scanDepth ?? null, tokenBudget: s.settings?.tokenBudget ?? null, recursive: s.settings?.recursive ?? true },
      entries: (s.entries || []).map(canonicalEntry),
    }, s.extensions)).sort(byRef),
    stories: (pkg.stories || []).map((st) => {
      const lead = (st.cast || []).filter((c) => c.role === 'lead');
      const rest = (st.cast || []).filter((c) => c.role !== 'lead').sort((a, b) => (a.character < b.character ? -1 : a.character > b.character ? 1 : 0));
      const pair = (a, b) => `${a.source}\0${a.entry}` < `${b.source}\0${b.entry}` ? -1 : 1;
      return {
        ref: st.ref,
        title: st.title,
        ...(st.persona ? { persona: st.persona } : {}),
        cast: [...lead, ...rest].map((c) => ({ character: c.character, role: c.role, ...(c.entity ? { entity: c.entity } : {}) })),
        sources: (st.sources || []).map((a) => ({ source: a.source, recursion: a.recursion ?? null })).sort((a, b) => (a.source < b.source ? -1 : 1)),
        exclusions: (st.exclusions || []).map((x) => ({ source: x.source, entry: x.entry })).sort(pair),
        // Cast order is meaningful, so npcs keep theirs.
        npcs: (st.npcs || []).map((n) => ({ source: n.source, entry: n.entry, role: n.role })),
        directions: text(st.directions),
        premise: text(st.premise),
      };
    }).sort(byRef),
  };
  return withExtensions(out, pkg.extensions);
}

function canonicalEntry(e) {
  const a = e.activation || {};
  const activation = { policy: a.policy };
  for (const [k, d] of Object.entries(ACTIVATION_DEFAULTS)) {
    const v = a[k] === undefined ? d : a[k];
    activation[k] = Array.isArray(v) ? [...v] : v;
  }
  if (a.policy === 'advanced') activation.constant = a.constant ?? false;
  const out = {
    ref: e.ref,
    title: text(e.title),
    content: e.content,
    enabled: e.enabled ?? true,
    summary: text(e.summary),
    activation,
  };
  if (e.semantics) {
    const m = e.semantics;
    out.semantics = {
      scope: m.scope,
      category: m.category,
      ...(m.subject ? { subject: m.subject } : {}),
      ...(m.defines ? { defines: m.defines } : {}),
      related: [...(m.related || [])].sort(),
      ...(m.displayPath ? { displayPath: m.displayPath.map((g) => g.trim()) } : {}),
    };
  }
  return withExtensions(out, e.extensions);
}

/** Whether an entry is always on, from its activation. */
export const isConstant = (activation) => activation.policy === 'always' || (activation.policy === 'advanced' && activation.constant === true);

/** A readable, stable ref from a name. */
export function slugRef(name, fallback = 'item') {
  const s = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || fallback;
}

/** Hand out refs that are unique within one list, preferring each thing's own. */
export function refAllocator() {
  const used = new Set();
  return (wanted, fallback) => {
    const base = wanted && REF.test(wanted) ? wanted : slugRef(fallback);
    let ref = base;
    for (let n = 2; used.has(ref); n++) ref = `${base}-${n}`;
    used.add(ref);
    return ref;
  };
}
