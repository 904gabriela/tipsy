// Bringing in a Nexus Story Package.
//
// A native package says what everything is, and it is trusted: its semantics
// are stored as approved, with origin 'native', exactly as written. Nothing
// here classifies, guesses, or calls a model — this module imports neither the
// legacy classifiers nor the provider, and the checks hold it to that.
//
// What IS a decision is how the package meets the library you already have:
// whether a character becomes a new card or uses one you have, and whether a
// package's person is a new entity or one that already exists. `inspectPackage`
// proposes those decisions; `importPackage` carries out the ones it is given.
// Everything is written in one transaction.

import { createHash } from 'node:crypto';
import { newId } from '../db/index.js';
import {
  createEntity, currentEntity, declareInSource, setEntrySemantics, setRelation, setSourceRole,
  bindCard, bindCharacterEntity, bindPersonaEntity, resolveNpcEntity,
} from '../semantics/store.js';
import { validatePackage, canonicalPackage, isConstant, PackageError, FORMAT } from './format.js';

const now = () => Date.now();
const j = (v) => JSON.stringify(v ?? null);

/** The legacy `kind` for a native entry, read straight off its semantics. A mapping, not a guess. */
function kindFor(semantics, entityType) {
  if (!semantics) return 'note';
  if (semantics.defines) return { person: 'character', place: 'place', faction: 'faction', item: 'item', event: 'event', concept: 'premise' }[entityType.get(semantics.defines)] || 'note';
  return { direction: 'direction', rule: 'rule', event: 'event', item: 'item', background: 'premise' }[semantics.category] || 'note';
}

export const packageHash = (pkg) => createHash('sha256').update(JSON.stringify(canonicalPackage(pkg))).digest('hex');

/**
 * What importing this package would do, before anything is written.
 *
 * Default decisions follow what was approved:
 *   - every package entity is NEW; reusing one you have is always a choice.
 *   - in a package with stories, a character becomes a new card unless a card
 *     with the same name exists, in which case using that card is proposed.
 *     In a package without stories (source material only), no card is made
 *     unless asked for. Personas follow the same rule.
 * A name match is only ever a suggestion for the person to confirm.
 */
export function inspectPackage(db, pkg) {
  const validation = validatePackage(pkg);
  if (!validation.ok) return { ok: false, ...validation };
  const hasStories = (pkg.stories || []).length > 0;
  const candidates = { characters: {}, personas: {} };
  const decisions = { entities: {}, characters: {}, personas: {} };

  for (const e of pkg.entities || []) decisions.entities[e.ref] = { use: 'new' };
  for (const c of pkg.characters || []) {
    const match = db.findCharacterByName(c.name);
    if (match) candidates.characters[c.ref] = { id: match.id, name: match.name };
    decisions.characters[c.ref] = !hasStories ? { use: 'skip' } : match ? { use: 'existing', id: match.id } : { use: 'create' };
  }
  for (const p of pkg.personas || []) {
    const match = db.raw.prepare('SELECT id, name FROM personas WHERE name = ? COLLATE NOCASE ORDER BY created_at LIMIT 1').get(String(p.name).trim());
    if (match) candidates.personas[p.ref] = { id: match.id, name: match.name };
    decisions.personas[p.ref] = !hasStories ? { use: 'skip' } : match ? { use: 'existing', id: match.id } : { use: 'create' };
  }

  const before = db.raw.prepare(`SELECT id, committed_at FROM imports WHERE format = ? AND committed_at IS NOT NULL
                                   AND json_valid(analysis) AND json_extract(analysis, '$.packageId') = ? ORDER BY committed_at`).all(FORMAT, pkg.package.id);
  const warnings = [...validation.warnings];
  if (before.length) warnings.push({ path: 'package.id', message: `This package was imported before (${before.length} time${before.length > 1 ? 's' : ''}). Importing again makes new copies.` });

  return {
    ok: true, errors: [], warnings, decisions, candidates,
    alreadyImported: before.map((r) => ({ importId: r.id, at: r.committed_at })),
    counts: {
      entities: (pkg.entities || []).length, characters: (pkg.characters || []).length, personas: (pkg.personas || []).length,
      sources: (pkg.sources || []).length, entries: (pkg.sources || []).reduce((n, s) => n + s.entries.length, 0), stories: (pkg.stories || []).length,
    },
  };
}

/**
 * Import a package with the decisions given (missing ones take the defaults
 * from inspectPackage).
 *
 * @param {object} opts
 * @param {object} [opts.decisions]     { entities, characters, personas } keyed by ref
 * @param {object} [opts.baseSettings]  settings a new story starts from (the app's defaults)
 * @param {string} [opts.filename]
 * @returns {{ importId, entities, characters, personas, sources, entries, stories }} ref → id maps
 */
export function importPackage(db, pkg, { decisions = {}, baseSettings = {}, filename = '' } = {}) {
  const inspected = inspectPackage(db, pkg);
  if (!inspected.ok) throw new PackageError('This is not a valid Nexus package.', inspected.errors);
  const chosen = {
    entities: { ...inspected.decisions.entities, ...(decisions.entities || {}) },
    characters: { ...inspected.decisions.characters, ...(decisions.characters || {}) },
    personas: { ...inspected.decisions.personas, ...(decisions.personas || {}) },
  };
  const problems = [];
  const fail = (path, message) => problems.push({ path, message });

  return db.transaction(() => {
    const out = { entities: {}, characters: {}, personas: {}, sources: {}, entries: {}, stories: {} };
    const entityType = new Map((pkg.entities || []).map((e) => [e.ref, e.type]));
    const entityByRef = new Map((pkg.entities || []).map((e) => [e.ref, e]));

    // ---- entities
    for (const e of pkg.entities || []) {
      const d = chosen.entities[e.ref] || { use: 'new' };
      if (d.use === 'existing') {
        const found = d.id ? currentEntity(db, d.id) : null;
        if (!found) { fail(`entities.${e.ref}`, 'The existing entity chosen for this does not exist.'); continue; }
        if (found.type !== e.type) { fail(`entities.${e.ref}`, `The existing entity chosen is a ${found.type}, not a ${e.type}.`); continue; }
        out.entities[e.ref] = found.id;
      } else if (d.use === 'new') {
        out.entities[e.ref] = createEntity(db, { type: e.type, name: e.name, aliases: e.aliases || [] });
      } else fail(`entities.${e.ref}`, 'An entity decision is "new" or "existing".');
    }

    // ---- characters
    const created = { characters: [], personas: [] };
    for (const c of pkg.characters || []) {
      const d = chosen.characters[c.ref] || { use: 'create' };
      const entityId = c.entity ? out.entities[c.entity] : null;
      if (d.use === 'skip') continue;
      if (d.use === 'existing') {
        const card = d.id ? db.getCharacter(d.id) : null;
        if (!card) { fail(`characters.${c.ref}`, 'The existing card chosen for this does not exist.'); continue; }
        if (entityId && card.entity_id && currentEntity(db, card.entity_id)?.id !== entityId) {
          fail(`characters.${c.ref}`, `"${card.name}" already represents a different person. Choose that person for "${c.entity}", or make a new card.`);
          continue;
        }
        out.characters[c.ref] = card.id;
        continue;
      }
      if (d.use !== 'create') { fail(`characters.${c.ref}`, 'A character decision is "create", "existing" or "skip".'); continue; }
      const id = newId();
      const core = c.core || {};
      db.raw.prepare(`INSERT INTO characters (id,name,nickname,description,personality,scenario,first_message,example_dialogue,
                        alternate_greetings,system_prompt,post_history_instructions,depth_prompt,creator_notes,tags,linked_world,
                        spec,original,appearance,behavior,speech_style,created_at,updated_at)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, c.name.trim(), c.nickname || '', core.identity || '', core.personality || '', c.openings?.scenario || '',
        c.openings?.first || '', core.speechExamples || '', j(c.openings?.alternates || []), core.systemInstructions || '',
        core.postHistoryInstructions || '', core.depthPrompt ? j(core.depthPrompt) : null, c.creatorNotes || '', j(c.tags || []), '',
        'nexus-package-v1', j({ nexus: { package: pkg.package.id, ref: c.ref, ...(c.extensions ? { extensions: c.extensions } : {}) } }),
        core.appearance || null, core.behavior || null, core.speechStyle || null, now(), now());
      // A native character is bound to the package's own entity for it: declared, not guessed.
      if (entityId) bindCharacterEntity(db, id, entityId);
      out.characters[c.ref] = id;
      created.characters.push(id);
    }

    // ---- personas
    for (const p of pkg.personas || []) {
      const d = chosen.personas[p.ref] || { use: 'create' };
      const entityId = p.entity ? out.entities[p.entity] : null;
      if (d.use === 'skip') continue;
      if (d.use === 'existing') {
        const persona = d.id ? db.getPersona(d.id) : null;
        if (!persona) { fail(`personas.${p.ref}`, 'The existing persona chosen for this does not exist.'); continue; }
        if (entityId && persona.entity_id && currentEntity(db, persona.entity_id)?.id !== entityId) {
          fail(`personas.${p.ref}`, `"${persona.name}" already represents a different person.`);
          continue;
        }
        out.personas[p.ref] = persona.id;
        continue;
      }
      if (d.use !== 'create') { fail(`personas.${p.ref}`, 'A persona decision is "create", "existing" or "skip".'); continue; }
      const core = p.core || {};
      const id = db.savePersona({
        name: p.name.trim(), description: core.identity || '',
        personality: core.personality, appearance: core.appearance, behavior: core.behavior, speechStyle: core.speechStyle,
      });
      if (entityId) bindPersonaEntity(db, id, entityId);
      out.personas[p.ref] = id;
      created.personas.push(id);
    }

    // ---- sources, entries and their semantics
    const addLorebook = db.raw.prepare(`INSERT INTO lorebooks (id,name,description,scan_depth,token_budget,recursive,from_character,original,created_at,updated_at)
                                        VALUES (?,?,?,?,?,?,NULL,?,?,?)`);
    for (const s of pkg.sources || []) {
      const bookId = newId();
      addLorebook.run(bookId, s.name.trim(), s.description || '', s.settings?.scanDepth ?? null, s.settings?.tokenBudget ?? null,
        (s.settings?.recursive ?? true) ? 1 : 0,
        j({ nexus: { package: pkg.package.id, ref: s.ref, ...(s.extensions ? { extensions: s.extensions } : {}) } }), now(), now());
      out.sources[s.ref] = bookId;
      out.entries[s.ref] = {};

      // Every entity this source speaks of is declared by it, under the package's own ref.
      const used = new Set();
      if (s.subject) used.add(s.subject);
      for (const e of s.entries) {
        const m = e.semantics;
        if (!m) continue;
        if (m.subject) used.add(m.subject);
        if (m.defines) used.add(m.defines);
        for (const r of m.related || []) used.add(r);
      }
      for (const ref of used) {
        const ent = entityByRef.get(ref);
        if (!out.entities[ref]) continue;
        declareInSource(db, {
          lorebookId: bookId, entityId: out.entities[ref], localRef: ref, localName: ent.name, localAliases: ent.aliases || [],
          origin: 'native', status: 'approved',
        });
      }

      for (const e of s.entries) {
        const a = { ...e.activation };
        const entryId = db.saveEntry(bookId, {
          title: e.title || '', content: e.content, enabled: e.enabled ?? true, summary: e.summary || '',
          keys: a.keys || [], secondaryKeys: a.secondaryKeys || [], constant: isConstant(a),
          selective: a.selective, selectiveLogic: a.selectiveLogic, caseSensitive: a.caseSensitive, matchWholeWords: a.matchWholeWords,
          useRegex: a.useRegex, probability: a.probability, useProbability: a.useProbability, order: a.order, position: a.position,
          depth: a.depth, role: a.role, scanDepth: a.scanDepth, excludeRecursion: a.excludeRecursion, preventRecursion: a.preventRecursion,
          delayUntilRecursion: a.delayUntilRecursion, group: a.group, groupOverride: a.groupOverride, groupWeight: a.groupWeight,
          useGroupScoring: a.useGroupScoring, sticky: a.sticky, cooldown: a.cooldown, delay: a.delay, ignoreBudget: a.ignoreBudget,
          vectorized: a.vectorized, decorators: a.decorators,
          kind: kindFor(e.semantics, entityType),
          original: { origin: 'native', nexus: { package: pkg.package.id, source: s.ref, ref: e.ref, ...(e.extensions ? { extensions: e.extensions } : {}) } },
        });
        out.entries[s.ref][e.ref] = entryId;
        const m = e.semantics;
        if (!m) continue;
        if ([m.subject, m.defines, ...(m.related || [])].some((r) => r && !out.entities[r])) continue; // reported with the entity
        setEntrySemantics(db, {
          entryId, scope: m.scope, category: m.category, definesEntityId: m.defines ? out.entities[m.defines] : null,
          origin: 'native', status: 'approved', activationPolicy: a.policy, displayPath: m.displayPath || null,
        });
        if (m.subject) setRelation(db, { entryId, entityId: out.entities[m.subject], relation: 'subject', origin: 'native', status: 'approved' });
        for (const r of m.related || []) setRelation(db, { entryId, entityId: out.entities[r], relation: 'related', origin: 'native', status: 'approved' });
      }
    }

    // ---- stories
    for (const st of pkg.stories || []) {
      const lead = st.cast.find((c) => c.role === 'lead');
      const ordered = [lead, ...st.cast.filter((c) => c !== lead)];
      const missing = ordered.filter((c) => !out.characters[c.character]);
      if (missing.length) {
        for (const c of missing) fail(`stories.${st.ref}.cast`, `"${c.character}" is in this story but no card was chosen for them.`);
        continue;
      }
      const settings = { ...baseSettings };
      if (st.directions) settings.directions = st.directions;
      if (st.premise) settings.premise = st.premise;
      const storyId = db.createStory({
        title: st.title.trim(),
        characterIds: ordered.map((c) => out.characters[c.character]),
        lorebookIds: st.sources.map((a) => out.sources[a.source]),
        personaId: st.persona ? out.personas[st.persona] || null : null,
        settings,
      });
      out.stories[st.ref] = storyId;
      for (const a of st.sources) if (a.recursion === 'block') db.setStoryLorebookRecursion(storyId, out.sources[a.source], 'block');
      for (const x of st.exclusions || []) db.excludeEntry(storyId, out.entries[x.source][x.entry]);
      for (const n of st.npcs || []) {
        const entryId = out.entries[n.source][n.entry];
        db.setStoryNpc(storyId, entryId, n.role, resolveNpcEntity(db, entryId));
      }
      // Which card is which person here: the story's own statement, else the card's.
      const byRef = new Map((pkg.characters || []).map((c) => [c.ref, c]));
      for (const c of st.cast) {
        const entityRef = c.entity || byRef.get(c.character)?.entity;
        if (entityRef && out.entities[entityRef]) bindCard(db, { storyId, entityId: out.entities[entityRef], characterId: out.characters[c.character] });
      }
    }

    // ---- what each source is for, and who or what owns it
    const ownerRef = new Map((pkg.sources || []).filter((s) => s.story).map((s) => [s.ref, s.story]));
    for (const s of pkg.sources || []) {
      const ownerStoryId = s.story ? out.stories[ownerRef.get(s.ref)] || null : null;
      if (s.story && !ownerStoryId) continue; // its story failed, already reported
      setSourceRole(db, {
        lorebookId: out.sources[s.ref], role: s.role, origin: 'native', status: 'approved', domains: s.domains || [],
        subjectEntityId: s.subject ? out.entities[s.subject] || null : null, ownerStoryId,
      });
    }

    if (problems.length) throw new PackageError('The package could not be imported with these choices.', problems);

    const importId = db.recordImport({
      filename, source: 'package', format: FORMAT, spec: 'v1', detectedRole: pkg.package.role, confidence: 'native',
      analysis: {
        packageId: pkg.package.id, title: pkg.package.title, role: pkg.package.role, domains: pkg.package.domains || [],
        ...(pkg.package.extensions ? { extensions: pkg.package.extensions } : {}),
        ...(pkg.extensions ? { rootExtensions: pkg.extensions } : {}),
        decisions: chosen,
      },
      original: JSON.stringify(pkg), hash: packageHash(pkg),
    });
    db.settleImport(importId, pkg.package.role, [
      ...Object.values(out.stories).map((id) => ({ kind: 'story', id, part: 'primary' })),
      ...created.characters.map((id) => ({ kind: 'character', id })),
      ...created.personas.map((id) => ({ kind: 'persona', id })),
      ...Object.values(out.sources).map((id) => ({ kind: 'lorebook', id })),
    ]);
    return { importId, ...out };
  });
}
