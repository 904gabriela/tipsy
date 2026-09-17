// Writing a Nexus Story Package from what is in the library.
//
// Only what is decided goes out as decided. An exported package is trusted
// when it comes back in, so anything that was merely proposed, or approved and
// then edited since (NEEDS RECHECK), is left out of `semantics` rather than
// laundered into approval by a round trip. Each omission is reported.
//
// A source must have an approved package role to be exported: v1 requires a
// role, and inventing one here would be a guess. Legacy sources become
// exportable once they have been organised.
//
// Deterministic: the same library exports the same bytes.

import { entryHash } from '../semantics/authority.js';
import { currentEntity } from '../semantics/store.js';
import { canonicalPackage, validatePackage, refAllocator, PackageError, FORMAT } from './format.js';

const parse = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

/** A reference to an entity whose ref is decided once every use is known. */
class EntityRef { constructor(id) { this.id = id; } }

/** A story as a package: its cast, persona, the sources it reads, and its own material. */
export function exportStory(db, storyId) {
  const story = db.getStory(storyId);
  if (!story) throw Object.assign(new PackageError('No such story.'), { status: 404 });
  const x = new Exporter(db);
  x.learn('story', storyId);

  const attached = db.storyLorebookSettings(storyId);
  for (const a of attached) x.addSource(a.lorebook_id, { storyId });
  x.failIfBlocked();

  const cards = new Map(db.raw.prepare('SELECT entity_id, character_id FROM story_entity_cards WHERE story_id=?').all(storyId).map((r) => [r.character_id, r.entity_id]));
  const cast = story.characters.map((c) => {
    const ref = x.addCharacter(c.id);
    const own = x.characterEntity.get(c.id) || null;
    const here = cards.get(c.id) ? currentEntity(db, cards.get(c.id))?.id : null;
    return { character: ref, role: c.story_role === 'lead' ? 'lead' : 'cast', ...(here && here !== own ? { entity: x.entityRef(here) } : {}) };
  });
  const persona = story.persona_id ? x.addPersona(story.persona_id) : null;

  const storyRef = x.refs.stories(x.hints.stories.get(storyId), story.title);
  for (const s of x.sources) if (s.ownerStoryId === storyId) s.out.story = storyRef;

  const inExport = (entryId) => x.entryLocation.get(entryId);
  const exclusions = db.storyExclusions(storyId).map((r) => inExport(r.entry_id)).filter(Boolean);
  // Package v1 names a cast member by the entry that introduced them. That is
  // the frozen wire shape and it stays: inside, the cast is people, and an
  // importer works out who from the entry's own approved semantics.
  //
  // One cast member cannot be written this way: somebody whose introducing
  // entry is gone, or who was merged from several. v1 has no way to name them,
  // so they are left out and said out loud rather than dropped in silence.
  const castRows = db.storyNpcs(storyId);
  const npcs = castRows.filter((n) => n.entry_id && inExport(n.entry_id))
    .map((n) => ({ ...inExport(n.entry_id), role: n.role }));
  for (const n of castRows.filter((n) => !n.entry_id || !inExport(n.entry_id))) {
    x.warn(`stories.${storyRef}.npcs`, `${n.name || n.title || 'Somebody'} is in this story's cast, but the entry that introduced them is not in this package, so Package v1 has no way to name them. They are not written.`);
  }

  const provenance = x.provenance('story', storyId);
  const pkg = {
    format: FORMAT, version: 1,
    package: {
      id: provenance?.packageId || `nexus-story-${storyId}`,
      title: provenance?.title || story.title,
      role: provenance?.role || 'story-package',
      domains: provenance?.domains || [],
      ...(provenance?.extensions ? { extensions: provenance.extensions } : {}),
    },
    ...x.collections(),
    stories: [{
      ref: storyRef,
      title: story.title,
      ...(persona ? { persona } : {}),
      cast,
      sources: attached.map((a) => ({ source: x.sourceRef.get(a.lorebook_id), recursion: a.recursion === 'block' ? 'block' : null })),
      exclusions,
      npcs,
      directions: String(story.settings?.directions || ''),
      premise: String(story.settings?.premise || ''),
    }],
    ...(provenance?.rootExtensions ? { extensions: provenance.rootExtensions } : {}),
  };
  return x.finish(pkg);
}

/** Reusable sources on their own: no story, no cards. */
export function exportSources(db, lorebookIds) {
  const x = new Exporter(db);
  for (const id of lorebookIds) x.addSource(id, { storyId: null });
  x.failIfBlocked();
  const provenance = lorebookIds.length ? x.provenance('lorebook', lorebookIds[0]) : null;
  const roles = [...new Set(x.sources.map((s) => s.out.role))];
  const pkg = {
    format: FORMAT, version: 1,
    package: {
      id: provenance?.packageId || `nexus-sources-${lorebookIds[0] || 'empty'}`,
      title: provenance?.title || (x.sources.length === 1 ? x.sources[0].out.name : `${x.sources.length} sources`),
      role: provenance?.role || (roles.length === 1 ? roles[0] : 'mixed'),
      domains: provenance?.domains || [],
      ...(provenance?.extensions ? { extensions: provenance.extensions } : {}),
    },
    ...x.collections(),
    stories: [],
  };
  return x.finish(pkg);
}

class Exporter {
  constructor(db) {
    this.db = db;
    this.warnings = [];
    this.blocked = [];
    this.refs = { entities: refAllocator(), characters: refAllocator(), personas: refAllocator(), sources: refAllocator(), stories: refAllocator() };
    this.entities = new Map();          // entity id → { ref, row }
    this.preferredEntityRef = new Map(); // entity id → the local ref a source gave it
    this.characters = new Map();         // character id → exported object
    this.characterEntity = new Map();
    this.personas = new Map();
    this.sources = [];
    this.sourceRef = new Map();
    this.entryLocation = new Map();      // entry id → { source, entry }
    // Refs a package import remembered for rows that cannot hold one themselves.
    this.hints = { entities: new Map(), personas: new Map(), stories: new Map() };
    this.learned = new Set();
  }

  learn(kind, id) {
    const importId = this.db.importOf(kind, id);
    if (!importId || this.learned.has(importId)) return;
    this.learned.add(importId);
    const refs = this.db.getImport(importId)?.analysis?.refs || {};
    for (const k of Object.keys(this.hints)) {
      for (const [rowId, ref] of Object.entries(refs[k] || {})) if (!this.hints[k].has(rowId)) this.hints[k].set(rowId, ref);
    }
  }

  warn(path, message) { this.warnings.push({ path, message }); }

  provenance(kind, id) {
    const importId = this.db.importOf(kind, id);
    if (!importId) return null;
    const rec = this.db.getImport(importId);
    return rec && rec.format === FORMAT ? rec.analysis : null;
  }

  entityRef(entityId) {
    const e = currentEntity(this.db, entityId);
    if (!e) return null;
    if (!this.entities.has(e.id)) {
      this.entities.set(e.id, { ref: null, row: e });
    }
    return new EntityRef(e.id);
  }

  addCharacter(id) {
    if (this.characters.has(id)) return this.characters.get(id).ref;
    const c = this.db.getCharacter(id);
    this.learn('character', id);
    const nexus = parse(c.original, null)?.nexus;
    const entity = c.entity_id ? currentEntity(this.db, c.entity_id)?.id : null;
    if (entity) this.characterEntity.set(id, entity);
    const out = {
      ref: this.refs.characters(nexus?.ref, c.name),
      name: c.name,
      nickname: c.nickname || '',
      ...(entity ? { entity: this.entityRef(entity) } : {}),
      core: {
        identity: c.description || '', appearance: c.appearance || '', personality: c.personality || '',
        behavior: c.behavior || '', speechStyle: c.speech_style || '', speechExamples: c.example_dialogue || '',
        systemInstructions: c.system_prompt || '', postHistoryInstructions: c.post_history_instructions || '',
        depthPrompt: c.depthPrompt || null,
      },
      openings: { scenario: c.scenario || '', first: c.first_message || '', alternates: c.alternateGreetings || [] },
      creatorNotes: c.creator_notes || '',
      tags: c.tags || [],
      ...(nexus?.extensions ? { extensions: nexus.extensions } : {}),
    };
    this.characters.set(id, out);
    return out.ref;
  }

  addPersona(id) {
    const p = this.db.getPersona(id);
    if (!p) return null;
    this.learn('persona', id);
    const entity = p.entity_id ? currentEntity(this.db, p.entity_id)?.id : null;
    const out = {
      ref: this.refs.personas(this.hints.personas.get(id), p.name),
      name: p.name,
      ...(entity ? { entity: this.entityRef(entity) } : {}),
      core: { identity: p.description || '', appearance: p.appearance || '', personality: p.personality || '', behavior: p.behavior || '', speechStyle: p.speech_style || '' },
    };
    this.personas.set(id, out);
    return out.ref;
  }

  addSource(lorebookId, { storyId }) {
    const db = this.db;
    const book = db.raw.prepare('SELECT * FROM lorebooks WHERE id=?').get(lorebookId);
    if (!book) return;
    this.learn('lorebook', lorebookId);
    const role = db.raw.prepare('SELECT * FROM source_semantics WHERE lorebook_id=?').get(lorebookId);
    if (!role || role.status !== 'approved') {
      this.blocked.push(`"${book.name}" has no approved package role yet`);
      return;
    }
    const original = parse(book.original, {});
    const owner = role.owner_story_id || original?.generatedFor || null;
    if (owner && owner !== storyId) {
      this.blocked.push(`"${book.name}" is another story's own material`);
      return;
    }
    const ref = this.refs.sources(original?.nexus?.ref, book.name);
    this.sourceRef.set(lorebookId, ref);

    for (const d of db.raw.prepare(`SELECT entity_id, local_ref FROM source_entities WHERE lorebook_id=? AND status='approved' ORDER BY created_at, local_ref`).all(lorebookId)) {
      const id = currentEntity(db, d.entity_id)?.id;
      if (id && !this.preferredEntityRef.has(id)) this.preferredEntityRef.set(id, d.local_ref);
    }
    const approvedDecl = new Set(db.raw.prepare(`SELECT entity_id FROM source_entities WHERE lorebook_id=? AND status='approved'`).all(lorebookId).map((r) => r.entity_id));

    const allocate = refAllocator();
    const entries = db.listEntries(lorebookId).map((e) => {
      const row = db.raw.prepare('SELECT * FROM lore_entries WHERE id=?').get(e.id);
      const nexus = parse(row.original, null)?.nexus;
      const entryRef = allocate(nexus?.ref, e.title || 'entry');
      this.entryLocation.set(e.id, { source: ref, entry: entryRef });
      return {
        ref: entryRef,
        title: e.title || '',
        content: e.content,
        enabled: e.enabled,
        summary: e.summary || '',
        activation: this.activationOf(e, lorebookId),
        ...this.semanticsOf(e, approvedDecl, `${book.name} › ${e.title || 'untitled'}`),
        ...(nexus?.extensions ? { extensions: nexus.extensions } : {}),
      };
    });

    const subject = role.subject_entity_id ? currentEntity(db, role.subject_entity_id)?.id : null;
    this.sources.push({
      ownerStoryId: owner,
      out: {
        ref,
        name: book.name,
        description: book.description || '',
        role: role.package_role,
        domains: parse(role.domains, []),
        ...(subject ? { subject: this.entityRef(subject) } : {}),
        settings: { scanDepth: book.scan_depth ?? null, tokenBudget: book.token_budget ?? null, recursive: !!book.recursive },
        entries,
        ...(original?.nexus?.extensions ? { extensions: original.nexus.extensions } : {}),
      },
    });
  }

  activationOf(e, lorebookId) {
    const stored = this.db.raw.prepare('SELECT activation_policy FROM entry_semantics WHERE entry_id=?').get(e.id)?.activation_policy;
    const hasKeys = e.keys.some((k) => String(k).trim());
    // The stored policy only where it still describes the entry; otherwise read it off the fields.
    let policy = stored;
    if (policy === 'always' && !e.constant) policy = null;
    if (policy === 'keywords' && (e.constant || !hasKeys)) policy = null;
    if (!policy) policy = e.constant ? 'always' : hasKeys ? 'keywords' : 'advanced';
    const a = {
      policy,
      keys: e.keys, secondaryKeys: e.secondaryKeys, selective: e.selective, selectiveLogic: e.selectiveLogic,
      caseSensitive: e.caseSensitive, matchWholeWords: e.matchWholeWords, useRegex: e.useRegex,
      probability: e.probability, useProbability: e.useProbability, order: e.order, position: e.position, depth: e.depth, role: e.role,
      scanDepth: e.scanDepth ?? null, excludeRecursion: e.excludeRecursion, preventRecursion: e.preventRecursion,
      delayUntilRecursion: e.delayUntilRecursion, group: e.group, groupOverride: e.groupOverride, groupWeight: e.groupWeight,
      useGroupScoring: e.useGroupScoring, sticky: e.sticky ?? null, cooldown: e.cooldown ?? null, delay: e.delay ?? null,
      ignoreBudget: e.ignoreBudget, vectorized: e.vectorized, decorators: e.decorators,
    };
    if (policy === 'advanced') a.constant = e.constant;
    return a;
  }

  semanticsOf(e, approvedDecl, where) {
    const db = this.db;
    const row = db.raw.prepare('SELECT * FROM entry_semantics WHERE entry_id=?').get(e.id);
    if (!row) return {};
    if (row.status !== 'approved') { this.warn(where, 'left unorganised: its semantics are only proposed.'); return {}; }
    if (row.content_hash && row.content_hash !== entryHash(e)) { this.warn(where, 'left unorganised: it changed after it was approved and needs a recheck.'); return {}; }
    const rels = db.raw.prepare('SELECT * FROM entry_relations WHERE entry_id=?').all(e.id);
    const dropped = rels.filter((r) => r.status !== 'approved').length;
    if (dropped) this.warn(where, `${dropped} proposed relation${dropped > 1 ? 's' : ''} left out.`);
    const declared = (id) => approvedDecl.has(id);
    const approved = rels.filter((r) => r.status === 'approved');
    const subject = approved.find((r) => r.relation === 'subject');
    const ids = [row.defines_entity_id, subject?.entity_id, ...approved.filter((r) => r.relation === 'related').map((r) => r.entity_id)].filter(Boolean);
    if (ids.some((id) => !declared(id))) { this.warn(where, 'left unorganised: it refers to someone its source has not approved declaring.'); return {}; }
    if (row.scope === 'entity' && !row.defines_entity_id && !subject) { this.warn(where, 'left unorganised: it is an entity entry with no approved subject.'); return {}; }
    const cur = (id) => currentEntity(db, id)?.id;
    return {
      semantics: {
        scope: row.scope,
        category: row.category,
        ...(subject ? { subject: this.entityRef(cur(subject.entity_id)) } : {}),
        ...(row.defines_entity_id ? { defines: this.entityRef(cur(row.defines_entity_id)) } : {}),
        related: approved.filter((r) => r.relation === 'related').map((r) => this.entityRef(cur(r.entity_id))),
        ...(row.display_path ? { displayPath: parse(row.display_path, null) } : {}),
      },
    };
  }

  failIfBlocked() {
    if (this.blocked.length) {
      throw new PackageError(`This cannot be exported as a Nexus package yet: ${this.blocked.join('; ')}.`,
        this.blocked.map((message) => ({ path: 'sources', message })));
    }
  }

  wantedEntityRef(id) { return this.preferredEntityRef.get(id) || this.hints.entities.get(id) || null; }

  collections() {
    // Refs for entities are handed out last, once every use is known, so the
    // same library always gives the same names.
    const ordered = [...this.entities.values()].sort((a, b) => {
      const ka = this.wantedEntityRef(a.row.id) || a.row.canonical_name;
      const kb = this.wantedEntityRef(b.row.id) || b.row.canonical_name;
      return ka < kb ? -1 : ka > kb ? 1 : a.row.id < b.row.id ? -1 : 1;
    });
    for (const e of ordered) e.ref = this.refs.entities(this.wantedEntityRef(e.row.id), e.row.canonical_name);
    return {
      entities: ordered.map((e) => ({ ref: e.ref, type: e.row.type, name: e.row.canonical_name, aliases: e.row.aliases || [] })),
      characters: [...this.characters.values()],
      personas: [...this.personas.values()],
      sources: this.sources.map((s) => s.out),
    };
  }

  finish(pkg) {
    // Resolve every entity placeholder to its final ref.
    const resolve = (v) => {
      if (v instanceof EntityRef) return this.entities.get(v.id).ref;
      if (Array.isArray(v)) return v.map(resolve);
      if (v && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, resolve(val)]));
      }
      return v;
    };
    const resolved = resolve(pkg);
    const check = validatePackage(resolved);
    if (!check.ok) throw new PackageError('The export did not produce a valid package.', check.errors);
    return { package: canonicalPackage(resolved), warnings: this.warnings };
  }
}
