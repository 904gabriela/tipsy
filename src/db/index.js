// Everything is kept in one SQLite file. Node has SQLite built in now, so
// there is nothing to install and nothing to break.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));

/** Time-sortable ids, so rows come back in creation order without an index. */
export function newId() {
  const t = Date.now().toString(36).padStart(9, '0');
  return `${t}${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** Columns added after the first release. Adding one twice is not an error. */
const LATER_COLUMNS = [
  ['lore_entries', 'kind', "TEXT NOT NULL DEFAULT 'note'"],
  ['lore_entries', 'playable', 'INTEGER NOT NULL DEFAULT 0'],
  ['lore_entries', 'traits', "TEXT NOT NULL DEFAULT '[]'"],
  ['lore_entries', 'summary', "TEXT NOT NULL DEFAULT ''"],
  ['lore_entries', 'image', 'TEXT'],
  ['lore_entries', 'linked', "TEXT NOT NULL DEFAULT '[]'"],
  // A persona can be a lore entry you marked "this is me", in which case the
  // entry stays the single source of truth and the persona follows it.
  ['personas', 'from_entry', 'TEXT'],
  // A story may use a framework. Many stories may use the same one, and doing
  // so joins nothing else: history, memory and standing stay keyed to the
  // story, as they always were.
  ['stories', 'framework_id', 'TEXT'],
  // Which scenario it was started from, if any. Provenance, not a link:
  // editing the scenario afterwards never reaches back into the story.
  ['stories', 'scenario_id', 'TEXT'],
  // Where each of these came from, so a library can be traced back to its files.
  ['characters', 'import_id', 'TEXT'],
  ['lorebooks', 'import_id', 'TEXT'],
  // A fingerprint of the file exactly as it arrived, so the same download
  // twice is recognised as the same download.
  ['imports', 'hash', 'TEXT'],
  // How one story uses one lorebook. NULL means what it has always meant:
  // whatever the story's own `recursive` setting says. 'block' means this
  // book takes part in direct activation only, in THIS story — the same book
  // in another story is untouched, because the choice belongs to the pairing
  // rather than to the book.
  //
  // Deliberately NOT lorebooks.recursive, which carries `recursive_scanning`
  // from the imported file. Fifteen of the books already say 0 there, and
  // honouring it now would quietly change two stories nobody asked about.
  ['story_lorebooks', 'recursion', 'TEXT'],
];

export function open(path = 'data/tipsy.db') {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  for (const [table, column, type] of LATER_COLUMNS) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`); }
    catch (e) {
      // Only "already there" is fine. Anything else (a locked file, a full
      // disk) would leave a column missing and every later query failing.
      if (!/duplicate column/i.test(String(e.message))) throw e;
    }
  }
  return wrap(db);
}

const j = (v) => JSON.stringify(v ?? null);
const p = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const now = () => Date.now();

function wrap(db) {
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  let txDepth = 0;

  const api = {
    raw: db,
    close: () => db.close(),

    /** Several writes as one. Nested calls join the outer transaction. */
    transaction(fn) {
      if (txDepth > 0) return fn();
      txDepth++;
      db.exec('BEGIN');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw e;
      } finally {
        txDepth--;
      }
    },

    // ------------------------------------------------------------ characters

    /**
     * Write a character you typed rather than imported.
     *
     * Goes through the same columns an imported card does, so nothing later
     * can tell the difference: the prompt builder, the lorebook linking and
     * the export all see one kind of character.
     */
    writeCharacter({ id, ...c }) {
      const fields = {
        name: c.name, nickname: c.nickname || '', description: c.description || '',
        personality: c.personality || '', scenario: c.scenario || '',
        first_message: c.firstMessage || '', example_dialogue: c.exampleDialogue || '',
        system_prompt: c.systemPrompt || '', post_history_instructions: c.postHistoryInstructions || '',
        creator_notes: c.creatorNotes || '', tags: j(c.tags || []),
        linked_world: c.linkedWorld || '',
      };
      if (id && get(`SELECT id FROM characters WHERE id=?`, id)) {
        // Only what was sent. The editor shows a few fields at a time and an
        // omission must not wipe a field it never displayed.
        const given = Object.entries(fields).filter(([k]) => c[
          { first_message: 'firstMessage', example_dialogue: 'exampleDialogue',
            system_prompt: 'systemPrompt', post_history_instructions: 'postHistoryInstructions',
            creator_notes: 'creatorNotes', linked_world: 'linkedWorld' }[k] || k
        ] !== undefined);
        if (given.length) {
          run(`UPDATE characters SET ${given.map(([k]) => `${k}=?`).join(',')}, updated_at=? WHERE id=?`,
            ...given.map(([, v]) => v), now(), id);
        }
        return id;
      }
      const newid = id || newId();
      run(`INSERT INTO characters (id,${Object.keys(fields).join(',')},alternate_greetings,spec,original,created_at,updated_at)
           VALUES (?,${Object.keys(fields).map(() => '?').join(',')},?,?,?,?,?)`,
        newid, ...Object.values(fields), j([]), 'written-here', j(null), now(), now());
      return newid;
    },

    saveCharacter(card) {
      const id = newId();
      run(
        `INSERT INTO characters (id,name,nickname,description,personality,scenario,
           first_message,example_dialogue,alternate_greetings,system_prompt,
           post_history_instructions,depth_prompt,creator_notes,tags,linked_world,
           spec,original,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, card.name, card.nickname || '', card.description, card.personality,
        card.scenario, card.firstMessage, card.exampleDialogue,
        j(card.alternateGreetings), card.systemPrompt, card.postHistoryInstructions,
        card.depthPrompt ? j(card.depthPrompt) : null, card.creatorNotes,
        j(card.tags), card.linkedWorld || '', card.spec || '',
        j(card._original), now(), now()
      );
      // A book that arrived inside the card comes in with it.
      if (card.lorebook) api.saveLorebook(card.lorebook, id);
      return id;
    },

    listCharacters() {
      return all(`SELECT c.id,c.name,c.nickname,c.description,c.tags,c.avatar,c.created_at,
                    length(c.description)+length(c.personality)+length(c.scenario) AS prompt_chars,
                    -- When you last wrote with them, for sorting a shelf of a
                    -- hundred by what you actually use.
                    (SELECT MAX(s.updated_at) FROM story_characters sc
                       JOIN stories s ON s.id=sc.story_id
                      WHERE sc.character_id=c.id) AS last_used,
                    -- How many ways in the card offered. One is the ordinary
                    -- case and needs no chooser.
                    (SELECT COUNT(*) FROM starting_points sp
                      WHERE sp.owner_kind='character' AND sp.owner_id=c.id) AS starts
                  FROM characters c ORDER BY c.name COLLATE NOCASE`)
        .map((r) => ({ ...r, tags: p(r.tags, []) }));
    },

    // ------------------------------------------------------- what came in

    /**
     * Record a file at the moment it is READ, before anything is made from it.
     * Written first so the original survives whatever is decided afterwards,
     * and so the same file can be looked at again later without re-uploading.
     */
    recordImport(rec) {
      const id = newId();
      run(`INSERT INTO imports (id,filename,source,source_url,format,spec,
             detected_role,chosen_role,confidence,analysis,original,hash,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, rec.filename || '', rec.source || 'file', rec.sourceUrl || '',
        rec.format || '', rec.spec || '', rec.detectedRole || '', '',
        rec.confidence || '', j(rec.analysis || {}), rec.original || '',
        rec.hash || null, now());
      return id;
    },

    /**
     * Has this exact file already been brought in?
     *
     * Only an exact match counts, and only one that actually became
     * something: an analysis that was looked at and abandoned is not a
     * reason to refuse the same file later.
     */
    importByHash(hash) {
      if (!hash) return null;
      const r = get(`SELECT id,filename,chosen_role,committed_at FROM imports
                     WHERE hash=? AND committed_at IS NOT NULL
                     ORDER BY committed_at LIMIT 1`, hash);
      if (!r) return null;
      return {
        ...r,
        resources: all(`SELECT kind,resource_id,part FROM import_resources WHERE import_id=?`, r.id),
      };
    },

    getImport(id) {
      const r = get(`SELECT * FROM imports WHERE id=?`, id);
      if (!r) return null;
      return {
        ...r,
        analysis: p(r.analysis, {}),
        resources: all(`SELECT kind,resource_id,part FROM import_resources WHERE import_id=?`, id),
      };
    },

    /** Say what was decided, and what the decision produced. */
    settleImport(importId, chosenRole, resources = []) {
      run(`UPDATE imports SET chosen_role=?, committed_at=? WHERE id=?`, chosenRole, now(), importId);
      for (const r of resources) {
        run(`INSERT OR REPLACE INTO import_resources (import_id,kind,resource_id,part)
             VALUES (?,?,?,?)`, importId, r.kind, r.id, r.part || 'piece');
      }
    },

    /** Everything one file produced, whatever kind it ended up as. */
    resourcesOfImport(importId) {
      return all(`SELECT kind,resource_id,part FROM import_resources WHERE import_id=?`, importId);
    },

    /** And the other way: which file did this thing come from? */
    importOf(kind, resourceId) {
      const r = get(`SELECT import_id FROM import_resources WHERE kind=? AND resource_id=?`, kind, resourceId);
      return r ? r.import_id : null;
    },

    // ------------------------------------------------------ ways to begin

    /**
     * Store every opening a resource offers.
     *
     * Replaces whatever was there, because these are read off a card as a set
     * and editing one by hand is a separate path.
     */
    setStartingPoints(ownerKind, ownerId, points) {
      run(`DELETE FROM starting_points WHERE owner_kind=? AND owner_id=?`, ownerKind, ownerId);
      points.forEach((pt, i) => {
        run(`INSERT INTO starting_points (id,owner_kind,owner_id,label,content,source,ord)
             VALUES (?,?,?,?,?,?,?)`,
          newId(), ownerKind, ownerId, pt.label || `Opening ${i + 1}`, pt.content, pt.source || '', i);
      });
      return points.length;
    },

    startingPoints(ownerKind, ownerId) {
      return all(`SELECT id,label,content,source,ord FROM starting_points
                  WHERE owner_kind=? AND owner_id=? ORDER BY ord`, ownerKind, ownerId);
    },

    // ---------------------------------------------------------- frameworks

    saveFramework(f) {
      const id = f.id || newId();
      if (f.id && get(`SELECT id FROM frameworks WHERE id=?`, f.id)) {
        run(`UPDATE frameworks SET name=?,summary=?,world=?,narrator=?,closing=?,
               depth_note=?,ensemble=?,tags=?,updated_at=? WHERE id=?`,
          f.name, f.summary || '', f.world || '', f.narrator || '', f.closing || '',
          f.depthNote ? j(f.depthNote) : null, f.ensemble || '', j(f.tags || []), now(), f.id);
        return f.id;
      }
      run(`INSERT INTO frameworks (id,name,summary,world,narrator,closing,depth_note,
             ensemble,tags,avatar,import_id,original,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, f.name, f.summary || '', f.world || '', f.narrator || '', f.closing || '',
        f.depthNote ? j(f.depthNote) : null, f.ensemble || '', j(f.tags || []),
        f.avatar || null, f.importId || null, f.original || '', now(), now());
      return id;
    },

    listFrameworks() {
      return all(`SELECT f.id,f.name,f.summary,f.tags,f.avatar,f.created_at,
                    (SELECT COUNT(*) FROM resource_lorebooks rl
                      WHERE rl.owner_kind='framework' AND rl.owner_id=f.id) AS lorebooks,
                    (SELECT COUNT(*) FROM starting_points s
                      WHERE s.owner_kind='framework' AND s.owner_id=f.id) AS starts,
                    (SELECT COUNT(*) FROM stories st WHERE st.framework_id=f.id) AS stories
                  FROM frameworks f ORDER BY f.name COLLATE NOCASE`)
        .map((r) => ({ ...r, tags: p(r.tags, []) }));
    },

    getFramework(id) {
      const r = get(`SELECT * FROM frameworks WHERE id=?`, id);
      if (!r) return null;
      return {
        ...r,
        tags: p(r.tags, []),
        depthNote: p(r.depth_note, null),
        lorebookIds: all(`SELECT lorebook_id FROM resource_lorebooks
                          WHERE owner_kind='framework' AND owner_id=?`, id).map((x) => x.lorebook_id),
        startingPoints: api.startingPoints('framework', id),
      };
    },

    deleteFramework(id) {
      run(`DELETE FROM starting_points WHERE owner_kind='framework' AND owner_id=?`, id);
      run(`DELETE FROM resource_lorebooks WHERE owner_kind='framework' AND owner_id=?`, id);
      run(`DELETE FROM frameworks WHERE id=?`, id);
    },

    // ----------------------------------------------------------- scenarios

    saveScenario(s) {
      const id = s.id || newId();
      if (s.id && get(`SELECT id FROM scenarios WHERE id=?`, s.id)) {
        run(`UPDATE scenarios SET name=?,premise=?,directions=?,ensemble=?,cast=?,
               framework_id=?,tags=?,updated_at=? WHERE id=?`,
          s.name, s.premise || '', s.directions || '', s.ensemble || '',
          j(s.cast || []), s.frameworkId || null, j(s.tags || []), now(), s.id);
        return s.id;
      }
      run(`INSERT INTO scenarios (id,name,premise,directions,ensemble,cast,framework_id,
             tags,avatar,import_id,original,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, s.name, s.premise || '', s.directions || '', s.ensemble || '',
        j(s.cast || []), s.frameworkId || null, j(s.tags || []),
        s.avatar || null, s.importId || null, s.original || '', now(), now());
      return id;
    },

    listScenarios() {
      return all(`SELECT s.id,s.name,s.premise,s.tags,s.avatar,s.framework_id,s.created_at,
                    (SELECT COUNT(*) FROM starting_points sp
                      WHERE sp.owner_kind='scenario' AND sp.owner_id=s.id) AS starts
                  FROM scenarios s ORDER BY s.name COLLATE NOCASE`)
        .map((r) => ({ ...r, tags: p(r.tags, []) }));
    },

    getScenario(id) {
      const r = get(`SELECT * FROM scenarios WHERE id=?`, id);
      if (!r) return null;
      return {
        ...r,
        tags: p(r.tags, []),
        cast: p(r.cast, []),
        lorebookIds: all(`SELECT lorebook_id FROM resource_lorebooks
                          WHERE owner_kind='scenario' AND owner_id=?`, id).map((x) => x.lorebook_id),
        startingPoints: api.startingPoints('scenario', id),
      };
    },

    deleteScenario(id) {
      run(`DELETE FROM starting_points WHERE owner_kind='scenario' AND owner_id=?`, id);
      run(`DELETE FROM resource_lorebooks WHERE owner_kind='scenario' AND owner_id=?`, id);
      run(`DELETE FROM scenarios WHERE id=?`, id);
    },

    /** Lore belonging to a framework or a scenario. */
    linkLorebook(ownerKind, ownerId, lorebookId) {
      run(`INSERT OR IGNORE INTO resource_lorebooks (owner_kind,owner_id,lorebook_id)
           VALUES (?,?,?)`, ownerKind, ownerId, lorebookId);
    },

    /** Which character in the library, if any, already goes by this name. */
    findCharacterByName(name) {
      const n = String(name || '').trim();
      if (!n) return null;
      return get(`SELECT id,name FROM characters WHERE name=? COLLATE NOCASE`, n)
        || get(`SELECT id,name FROM characters WHERE nickname=? COLLATE NOCASE`, n)
        || null;
    },

    getCharacter(id) {
      const r = get(`SELECT * FROM characters WHERE id=?`, id);
      if (!r) return null;
      return {
        ...r,
        alternateGreetings: p(r.alternate_greetings, []),
        tags: p(r.tags, []),
        depthPrompt: p(r.depth_prompt, null),
      };
    },

    deleteCharacter(id) { run(`DELETE FROM characters WHERE id=?`, id); },

    // ------------------------------------------------------------- lorebooks

    saveLorebook(book, fromCharacter = null) {
      return api.transaction(() => api._saveLorebook(book, fromCharacter));
    },

    _saveLorebook(book, fromCharacter) {
      const id = newId();
      run(
        `INSERT INTO lorebooks (id,name,description,scan_depth,token_budget,
           recursive,from_character,original,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        id, book.name, book.description, book.scanDepth, book.tokenBudget,
        book.recursiveScanning ? 1 : 0, fromCharacter, j(book._original), now(), now()
      );
      const stmt = db.prepare(
        `INSERT INTO lore_entries (id,lorebook_id,title,content,keys,secondary_keys,
           enabled,constant,selective,selective_logic,ord,position,depth,role,
           probability,use_probability,case_sensitive,match_whole_words,use_regex,
           scan_depth,exclude_recursion,prevent_recursion,delay_until_recursion,
           grp,group_override,group_weight,use_group_scoring,sticky,cooldown,delay,
           ignore_budget,vectorized,decorators,original,display_index)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      book.entries.forEach((e, i) => {
        stmt.run(
          newId(), id, e.title || '', e.content, j(e.keys), j(e.secondaryKeys),
          e.enabled ? 1 : 0, e.constant ? 1 : 0, e.selective ? 1 : 0, e.selectiveLogic,
          e.order, e.position, e.depth, e.role,
          e.probability, e.useProbability ? 1 : 0, e.caseSensitive ? 1 : 0,
          e.matchWholeWords ? 1 : 0, e.useRegex ? 1 : 0,
          e.scanDepth, e.excludeRecursion ? 1 : 0, e.preventRecursion ? 1 : 0,
          Number(e.delayUntilRecursion) || 0,
          e.group, e.groupOverride ? 1 : 0, e.groupWeight, e.useGroupScoring ? 1 : 0,
          e.sticky, e.cooldown, e.delay,
          e.ignoreBudget ? 1 : 0, e.vectorized ? 1 : 0, j(e.decorators),
          j(e._original), i
        );
      });
      return id;
    },

    listLorebooks() {
      return all(`SELECT b.id, b.name, b.description, b.from_character, b.created_at,
                    c.name AS character_name,
                    (SELECT COUNT(*) FROM lore_entries e WHERE e.lorebook_id=b.id) AS entry_count,
                    (SELECT COUNT(*) FROM lore_entries e WHERE e.lorebook_id=b.id AND e.constant=1 AND e.enabled=1) AS always_on,
                    (SELECT COALESCE(SUM(length(e.content)),0) FROM lore_entries e WHERE e.lorebook_id=b.id AND e.constant=1 AND e.enabled=1) AS always_on_chars,
                    -- The story a book was made for, when it is a story's own Story Builder package.
                    CASE WHEN json_valid(b.original) THEN json_extract(b.original, '$.generatedFor') END AS generated_for
                  FROM lorebooks b LEFT JOIN characters c ON c.id=b.from_character
                  ORDER BY b.name COLLATE NOCASE`);
    },

    getLorebook(id) {
      const b = get(`SELECT * FROM lorebooks WHERE id=?`, id);
      if (!b) return null;
      return { ...b, entries: api.listEntries(id) };
    },

    listEntries(lorebookId) {
      return all(`SELECT * FROM lore_entries WHERE lorebook_id=? ORDER BY display_index`, lorebookId)
        .map(rowToEntry);
    },

    /**
     * Entries for every book switched on in a story, ready for the engine.
     *
     * This is where a story's eligible lore is decided, so it is also where
     * the story's exclusions apply: an excluded entry is not handed to the
     * activation engine at all, so it cannot fire, be pulled in by recursion,
     * or feed recursion for anything else.
     */
    entriesForStory(storyId) {
      // sl.recursion rides along so the activation engine can honour a
      // per-story choice without a second query and without the entry itself
      // being changed. An entry is still one row, used by many stories.
      return all(
        `SELECT e.*, sl.recursion AS book_recursion FROM lore_entries e
         JOIN story_lorebooks sl ON sl.lorebook_id = e.lorebook_id
         WHERE sl.story_id = ? AND e.enabled = 1
           AND e.id NOT IN (SELECT entry_id FROM story_entry_exclusions WHERE story_id = ?)`, storyId, storyId
      ).map((r) => ({ ...rowToEntry(r), bookRecursion: r.book_recursion || null }));
    },

    // ---------------------------------------------- what a story ignores

    /** Keep one entry out of one story. The entry itself is not touched. */
    excludeEntry(storyId, entryId) {
      run(`INSERT OR IGNORE INTO story_entry_exclusions (story_id,entry_id,created_at) VALUES (?,?,?)`, storyId, entryId, now());
    },
    /** Let it back in. */
    includeEntry(storyId, entryId) {
      run(`DELETE FROM story_entry_exclusions WHERE story_id=? AND entry_id=?`, storyId, entryId);
    },
    storyExclusions(storyId) {
      return all(`SELECT x.entry_id, e.title, e.kind, e.lorebook_id FROM story_entry_exclusions x
                  JOIN lore_entries e ON e.id = x.entry_id
                  WHERE x.story_id=? ORDER BY e.title COLLATE NOCASE`, storyId);
    },
    storyExclusionIds(storyId) {
      return new Set(all(`SELECT entry_id FROM story_entry_exclusions WHERE story_id=?`, storyId).map((r) => r.entry_id));
    },

    // ------------------------------------------------- who is in a story

    /** People in a story who have no card of their own. */
    setStoryNpcs(storyId, rows) {
      api.transaction(() => {
        run(`DELETE FROM story_npcs WHERE story_id=?`, storyId);
        rows.forEach((r, i) => {
          run(`INSERT OR REPLACE INTO story_npcs (story_id,entry_id,role,ord) VALUES (?,?,?,?)`,
            storyId, r.entryId, r.role || 'background', i);
        });
      });
      return rows.length;
    },

    /** One person's part, leaving everyone else where they were. */
    setStoryNpc(storyId, entryId, role) {
      const had = get(`SELECT ord FROM story_npcs WHERE story_id=? AND entry_id=?`, storyId, entryId);
      if (had) {
        run(`UPDATE story_npcs SET role=? WHERE story_id=? AND entry_id=?`, role, storyId, entryId);
        return;
      }
      const next = get(`SELECT COALESCE(MAX(ord),-1)+1 AS n FROM story_npcs WHERE story_id=?`, storyId).n;
      run(`INSERT INTO story_npcs (story_id,entry_id,role,ord) VALUES (?,?,?,?)`, storyId, entryId, role, next);
    },
    removeStoryNpc(storyId, entryId) {
      run(`DELETE FROM story_npcs WHERE story_id=? AND entry_id=?`, storyId, entryId);
    },

    storyNpcs(storyId) {
      return all(`SELECT n.entry_id, n.role, n.ord, e.title, e.summary, e.image,
                    e.lorebook_id, length(e.content) AS chars
                  FROM story_npcs n JOIN lore_entries e ON e.id = n.entry_id
                  WHERE n.story_id=? ORDER BY n.ord`, storyId);
    },

    /** What a piece of material is about. Never inferred from where it came from. */
    linkEntryToCharacter(entryId, characterId) {
      run(`INSERT OR IGNORE INTO entry_character_links (entry_id,character_id) VALUES (?,?)`, entryId, characterId);
    },
    linkEntryToEntry(entryId, aboutId) {
      if (entryId === aboutId) return;
      run(`INSERT OR IGNORE INTO entry_entry_links (entry_id,about_id) VALUES (?,?)`, entryId, aboutId);
    },
    loreAboutCharacter(characterId) {
      return all(`SELECT e.id,e.title,e.kind,e.summary,length(e.content) chars
                  FROM entry_character_links l JOIN lore_entries e ON e.id=l.entry_id
                  WHERE l.character_id=? ORDER BY e.kind, e.title`, characterId);
    },
    loreAboutEntry(aboutId) {
      return all(`SELECT e.id,e.title,e.kind,e.summary,length(e.content) chars
                  FROM entry_entry_links l JOIN lore_entries e ON e.id=l.entry_id
                  WHERE l.about_id=? ORDER BY e.kind, e.title`, aboutId);
    },

    /** How this story uses this book. Null is the default, and always was. */
    setStoryLorebookRecursion(storyId, lorebookId, policy) {
      const value = policy === 'block' ? 'block' : null;
      run(`UPDATE story_lorebooks SET recursion=? WHERE story_id=? AND lorebook_id=?`,
        value, storyId, lorebookId);
    },

    storyLorebookSettings(storyId) {
      return all(`SELECT lorebook_id, recursion FROM story_lorebooks WHERE story_id=?`, storyId);
    },

    /**
     * The lore of a world, read live.
     *
     * Not copied into the story when it began: a world is reusable
     * infrastructure, so improving its lore is meant to reach the stories
     * standing in it. What never travels this way is continuity — memory,
     * standing and history stay keyed to the story.
     */
    entriesForFramework(frameworkId) {
      return all(
        `SELECT e.* FROM lore_entries e
         JOIN resource_lorebooks rl ON rl.lorebook_id = e.lorebook_id
         WHERE rl.owner_kind = 'framework' AND rl.owner_id = ? AND e.enabled = 1`, frameworkId
      ).map(rowToEntry);
    },

    saveEntry(lorebookId, incoming) {
      const id = incoming.id || newId();
      const row = incoming.id ? get(`SELECT * FROM lore_entries WHERE id=?`, incoming.id) : null;
      const exists = !!row;
      // The editor sends only the fields it shows. Anything it does not
      // mention keeps its stored value rather than snapping back to a default,
      // so editing a title cannot quietly wipe an entry's timing rules.
      const e = exists ? { ...rowToEntry(row), ...incoming } : incoming;
      const num = (v, d) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
      const vals = [
        e.title || '', e.content || '', j(e.keys || []), j(e.secondaryKeys || []),
        e.enabled === false ? 0 : 1, e.constant ? 1 : 0, e.selective === false ? 0 : 1,
        num(e.selectiveLogic, 0), num(e.order, 100), num(e.position, 0),
        num(e.depth, 4), num(e.role, 0), num(e.probability, 100),
        e.useProbability === false ? 0 : 1, e.caseSensitive ? 1 : 0,
        e.matchWholeWords ? 1 : 0, e.useRegex ? 1 : 0,
        e.scanDepth ?? null, e.excludeRecursion ? 1 : 0, e.preventRecursion ? 1 : 0,
        num(e.delayUntilRecursion, 0), e.group || '', e.groupOverride ? 1 : 0,
        num(e.groupWeight, 100), e.useGroupScoring ? 1 : 0,
        e.sticky ?? null, e.cooldown ?? null, e.delay ?? null,
        e.ignoreBudget ? 1 : 0, e.vectorized ? 1 : 0, j(e.decorators || []),
        e.kind || 'note', e.playable ? 1 : 0, j(e.traits || []),
        e.summary || '', e.image ?? null, j(e.linked || []),
      ];
      if (exists) {
        run(`UPDATE lore_entries SET title=?,content=?,keys=?,secondary_keys=?,
              enabled=?,constant=?,selective=?,selective_logic=?,ord=?,position=?,
              depth=?,role=?,probability=?,use_probability=?,case_sensitive=?,
              match_whole_words=?,use_regex=?,scan_depth=?,exclude_recursion=?,
              prevent_recursion=?,delay_until_recursion=?,grp=?,group_override=?,
              group_weight=?,use_group_scoring=?,sticky=?,cooldown=?,delay=?,
              ignore_budget=?,vectorized=?,decorators=?,
              kind=?,playable=?,traits=?,summary=?,image=?,linked=? WHERE id=?`, ...vals, id);
      } else {
        const nextIdx = get(`SELECT COALESCE(MAX(display_index),-1)+1 AS n FROM lore_entries WHERE lorebook_id=?`, lorebookId).n;
        run(`INSERT INTO lore_entries (id,lorebook_id,title,content,keys,secondary_keys,
              enabled,constant,selective,selective_logic,ord,position,depth,role,
              probability,use_probability,case_sensitive,match_whole_words,use_regex,
              scan_depth,exclude_recursion,prevent_recursion,delay_until_recursion,
              grp,group_override,group_weight,use_group_scoring,sticky,cooldown,delay,
              ignore_budget,vectorized,decorators,
              kind,playable,traits,summary,image,linked,original,display_index)
             VALUES (?,?,${vals.map(() => '?').join(',')},?,?)`,
          // `original` is where an entry's origin is kept: the entry as it
          // arrived in a file, or as the Story Builder proposed it. Only set
          // when the entry is created; editing never rewrites where it came from.
          id, lorebookId, ...vals, j(incoming.original ?? null), nextIdx);
      }
      return id;
    },

    deleteEntry(id) { run(`DELETE FROM lore_entries WHERE id=?`, id); },

    /**
     * Copy entries into another book, keeping every setting they had.
     *
     * The originals are untouched: this is how you build a small book out of
     * a big one without either editing by hand or importing the whole thing
     * and deleting most of it.
     *
     * Anything already in the destination with the same title and the same
     * body is skipped, so copying the same selection twice does not leave you
     * with two of everything.
     */
    copyEntries(fromId, toId, entryIds) {
      if (fromId === toId) return { copied: 0, already: 0 };
      return api.transaction(() => {
        const wanted = new Set(entryIds);
        const source = api.listEntries(fromId).filter((e) => wanted.has(e.id));
        const seen = new Set(api.listEntries(toId)
          .map((e) => `${(e.title || '').trim()} ${(e.content || '').trim()}`));

        let copied = 0;
        let already = 0;
        for (const e of source) {
          const fingerprint = `${(e.title || '').trim()} ${(e.content || '').trim()}`;
          if (seen.has(fingerprint)) { already++; continue; }
          seen.add(fingerprint);
          // No id, so this inserts rather than overwrites the original.
          const { id, ...rest } = e;
          api.saveEntry(toId, rest);
          copied++;
        }
        return { copied, already };
      });
    },

    setEntryKind(id, kind) { run(`UPDATE lore_entries SET kind=? WHERE id=?`, kind, id); },

    /** Entries grouped for the card view, plus how many of each there are. */
    entriesByKind(lorebookId) {
      const list = api.listEntries(lorebookId);
      const groups = new Map();
      for (const e of list) {
        if (!groups.has(e.kind)) groups.set(e.kind, []);
        groups.get(e.kind).push(e);
      }
      return groups;
    },

    createLorebook(name, description = '') {
      const id = newId();
      run(`INSERT INTO lorebooks (id,name,description,recursive,original,created_at,updated_at)
           VALUES (?,?,?,1,?,?,?)`, id, name, description, j(null), now(), now());
      return id;
    },

    deleteLorebook(id) { run(`DELETE FROM lorebooks WHERE id=?`, id); },

    // -------------------------------------------------------------- personas

    savePersona({ id, name, description, avatar, fromEntry }) {
      // No default for avatar: "not mentioned" must stay distinct from "none",
      // or renaming someone quietly deletes their picture.
      if (id && get(`SELECT 1 FROM personas WHERE id=?`, id)) {
        const fields = ['name=?', 'description=?'];
        const vals = [name, description || ''];
        if (avatar !== undefined) { fields.push('avatar=?'); vals.push(avatar); }
        if (fromEntry !== undefined) { fields.push('from_entry=?'); vals.push(fromEntry); }
        run(`UPDATE personas SET ${fields.join(',')} WHERE id=?`, ...vals, id);
        return id;
      }
      const fresh = id || newId();
      run(`INSERT INTO personas (id,name,description,avatar,from_entry,created_at) VALUES (?,?,?,?,?,?)`,
        fresh, name, description || '', avatar ?? null, fromEntry ?? null, now());
      return fresh;
    },

    /**
     * A persona built from a lore entry follows that entry, so editing the
     * entry is the only place you have to change anything.
     */
    _syncPersona(p) {
      if (!p || !p.from_entry) return p;
      const row = get(`SELECT title, content FROM lore_entries WHERE id=?`, p.from_entry);
      if (!row) return { ...p, missingEntry: true };
      return { ...p, name: personaNameFrom(row) || p.name, description: row.content };
    },

    listPersonas() { return all(`SELECT * FROM personas ORDER BY created_at DESC`).map(api._syncPersona); },
    getPersona(id) { return api._syncPersona(get(`SELECT * FROM personas WHERE id=?`, id)); },
    deletePersona(id) { run(`DELETE FROM personas WHERE id=?`, id); },

    /** The persona already built from this entry, if there is one. */
    personaForEntry(entryId) {
      return api._syncPersona(get(`SELECT * FROM personas WHERE from_entry=?`, entryId));
    },

    /** Entries in a story's active books that are marked as the player. */
    playableForStory(storyId) {
      return all(
        `SELECT e.* FROM lore_entries e
         JOIN story_lorebooks sl ON sl.lorebook_id = e.lorebook_id
         WHERE sl.story_id = ? AND e.playable = 1`, storyId
      ).map(rowToEntry);
    },

    // ------------------------------------------------------------- portraits

    setAvatar(table, id, dataUri) {
      // Named explicitly rather than passed through: this string is spliced
      // into the statement, so it may only ever be one of these.
      if (!['characters', 'personas', 'frameworks', 'scenarios'].includes(table)) {
        throw new Error('Unknown kind.');
      }
      run(`UPDATE ${table} SET avatar=? WHERE id=?`, dataUri, id);
    },

    // ---------------------------------------------------------------- assets

    saveAsset({ storyId, kind = 'background', name = '', mime, bytes }) {
      const id = newId();
      run(`INSERT INTO assets (id,story_id,kind,name,mime,bytes,created_at) VALUES (?,?,?,?,?,?,?)`,
        id, storyId || null, kind, name, mime, bytes, now());
      return id;
    },
    getAsset(id) { return get(`SELECT * FROM assets WHERE id=?`, id); },
    listAssets(storyId, kind = null) {
      return all(
        kind
          ? `SELECT id,kind,name,mime,length(bytes) AS size,created_at FROM assets WHERE story_id=? AND kind=? ORDER BY created_at DESC`
          : `SELECT id,kind,name,mime,length(bytes) AS size,created_at FROM assets WHERE story_id=? ORDER BY created_at DESC`,
        ...(kind ? [storyId, kind] : [storyId])
      );
    },
    deleteAsset(id) { run(`DELETE FROM assets WHERE id=?`, id); },

    // --------------------------------------------------------------- presets

    listPresets() {
      return all(`SELECT * FROM presets ORDER BY builtin DESC, name COLLATE NOCASE`)
        .map((r) => ({ ...r, settings: p(r.settings, {}) }));
    },
    savePreset({ id, name, settings, builtin = 0 }) {
      const existing = id && get(`SELECT 1 FROM presets WHERE id=?`, id);
      if (existing) {
        run(`UPDATE presets SET name=?, settings=?, updated_at=? WHERE id=?`,
          name, j(settings), now(), id);
        return id;
      }
      const fresh = id || newId();
      run(`INSERT INTO presets (id,name,builtin,settings,created_at,updated_at)
           VALUES (?,?,?,?,?,?)`, fresh, name, builtin, j(settings), now(), now());
      return fresh;
    },
    deletePreset(id) { run(`DELETE FROM presets WHERE id=? AND builtin=0`, id); },

    // --------------------------------------------------------------- stories

    createStory({
      title, characterIds = [], lorebookIds = [], personaId = null, settings = {},
      // A story may be started from a scenario and may use a framework. Both
      // are recorded on the row and neither joins this story to any other:
      // history, memory and standing are keyed to the story, as before.
      frameworkId = null, scenarioId = null,
    }) {
      return api.transaction(() => {
        const id = newId();
        run(`INSERT INTO stories (id,title,persona_id,settings,framework_id,scenario_id,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?)`,
          id, title, personaId, j(settings), frameworkId, scenarioId, now(), now());
        characterIds.forEach((cid, i) => {
          run(`INSERT OR IGNORE INTO story_characters (story_id,character_id,role) VALUES (?,?,?)`,
            id, cid, i === 0 ? 'lead' : 'cast');
        });
        for (const bid of lorebookIds) {
          run(`INSERT OR IGNORE INTO story_lorebooks (story_id,lorebook_id) VALUES (?,?)`, id, bid);
        }
        return id;
      });
    },

    /**
     * The story list, with enough to draw a story rather than a row.
     *
     * The lead's portrait and the last line written are what make this a
     * shelf you recognise at a glance instead of a table of names. Both are
     * subqueries on a query that was already running, so the list costs the
     * same as it did.
     */
    listStories() {
      return all(`SELECT s.*,
                   (SELECT COUNT(*) FROM messages m WHERE m.story_id=s.id) AS message_count,
                   (SELECT GROUP_CONCAT(c.name, ', ') FROM story_characters sc
                      JOIN characters c ON c.id=sc.character_id WHERE sc.story_id=s.id) AS cast,
                   (SELECT c.avatar FROM story_characters sc
                      JOIN characters c ON c.id=sc.character_id
                      WHERE sc.story_id=s.id AND c.avatar IS NOT NULL
                      ORDER BY (sc.role = 'lead') DESC LIMIT 1) AS art,
                   (SELECT m.content FROM messages m
                      WHERE m.story_id=s.id ORDER BY m.depth DESC, m.created_at DESC LIMIT 1) AS last_line,
                   (SELECT m.role FROM messages m
                      WHERE m.story_id=s.id ORDER BY m.depth DESC, m.created_at DESC LIMIT 1) AS last_role
                  FROM stories s ORDER BY s.updated_at DESC`)
        .map((r) => ({
          ...r,
          settings: p(r.settings, {}),
          // Trimmed here rather than in the browser: a story's newest message
          // can be two thousand words, and the list only ever shows one line.
          last_line: String(r.last_line || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        }));
    },

    getStory(id) {
      const s = get(`SELECT * FROM stories WHERE id=?`, id);
      if (!s) return null;
      return {
        ...s,
        settings: p(s.settings, {}),
        // The lead must come first: the prompt builder treats characters[0]
        // as the one whose card instructions and greeting apply.
        characters: all(`SELECT c.*, sc.role AS story_role FROM story_characters sc
                         JOIN characters c ON c.id=sc.character_id WHERE sc.story_id=?
                         ORDER BY (sc.role = 'lead') DESC, c.name COLLATE NOCASE`, id)
          .map((c) => ({ ...c, alternateGreetings: p(c.alternate_greetings, []), depthPrompt: p(c.depth_prompt, null) })),
        lorebookIds: all(`SELECT lorebook_id FROM story_lorebooks WHERE story_id=?`, id).map((r) => r.lorebook_id),
        // Through getPersona, so one built from a lore entry follows that entry.
        persona: s.persona_id ? api.getPersona(s.persona_id) : null,
      };
    },

    /**
     * Just the pacing settings, without dragging the cast and the persona
     * along. The memory engine asks for this on every state fold, which on a
     * long story is thousands of times.
     */
    arcFor(storyId) {
      const s = get(`SELECT settings FROM stories WHERE id=?`, storyId);
      if (!s) return null;
      return p(s.settings, {}).arc || null;
    },

    updateStory(id, patch) {
      const fields = [];
      const vals = [];
      if (patch.title !== undefined) { fields.push('title=?'); vals.push(patch.title); }
      if (patch.headId !== undefined) { fields.push('head_id=?'); vals.push(patch.headId); }
      if (patch.personaId !== undefined) { fields.push('persona_id=?'); vals.push(patch.personaId); }
      if (patch.settings !== undefined) { fields.push('settings=?'); vals.push(j(patch.settings)); }
      if (!fields.length) return;
      fields.push('updated_at=?'); vals.push(now());
      run(`UPDATE stories SET ${fields.join(',')} WHERE id=?`, ...vals, id);
    },

    /**
     * Who has a card in this story.
     *
     * Only the difference is written. Somebody who stays keeps the part they
     * had, and the lead stays the lead unless they are the one leaving: this
     * used to delete every row and hand the lead to whichever id came first,
     * so saving the story sheet could quietly change whose story it was.
     * When there is no lead left, the first id given takes it.
     */
    setStoryCharacters(storyId, ids) {
      api.transaction(() => {
        const keep = new Set(ids);
        const rows = all(`SELECT character_id, role FROM story_characters WHERE story_id=?`, storyId);
        for (const r of rows) {
          if (!keep.has(r.character_id)) run(`DELETE FROM story_characters WHERE story_id=? AND character_id=?`, storyId, r.character_id);
        }
        const had = new Set(rows.map((r) => r.character_id));
        for (const cid of ids) {
          if (!had.has(cid)) run(`INSERT OR IGNORE INTO story_characters (story_id,character_id,role) VALUES (?,?,?)`, storyId, cid, 'cast');
        }
        const lead = get(`SELECT character_id FROM story_characters WHERE story_id=? AND role='lead'`, storyId);
        if (!lead && ids.length) run(`UPDATE story_characters SET role='lead' WHERE story_id=? AND character_id=?`, storyId, ids[0]);
      });
    },

    /** Which part a card plays. Exactly one lead: naming a new one demotes the old. */
    setStoryCharacterRole(storyId, characterId, role) {
      api.transaction(() => {
        if (role === 'lead') {
          run(`UPDATE story_characters SET role='cast' WHERE story_id=? AND role='lead' AND character_id<>?`, storyId, characterId);
        }
        run(`UPDATE story_characters SET role=? WHERE story_id=? AND character_id=?`, role, storyId, characterId);
      });
    },

    /**
     * Which books a story reads.
     *
     * Only the difference is written, so a book that stays keeps how this
     * story uses it. Deleting every row and adding them back used to throw
     * away each book's recursion setting on every save.
     */
    setStoryLorebooks(storyId, ids) {
      api.transaction(() => {
        const keep = new Set(ids);
        for (const r of all(`SELECT lorebook_id FROM story_lorebooks WHERE story_id=?`, storyId)) {
          if (!keep.has(r.lorebook_id)) run(`DELETE FROM story_lorebooks WHERE story_id=? AND lorebook_id=?`, storyId, r.lorebook_id);
        }
        for (const bid of ids) run(`INSERT OR IGNORE INTO story_lorebooks (story_id,lorebook_id) VALUES (?,?)`, storyId, bid);
      });
    },

    deleteStory(id) {
      api.transaction(() => {
        // Deepest messages first, so the self-referential cascade never has
        // to recurse. SQLite gives up after a thousand nested trigger frames,
        // and a month-long story is longer than that.
        let row;
        while ((row = get(`SELECT MAX(depth) AS d FROM messages WHERE story_id=?`, id)) && row.d !== null) {
          run(`DELETE FROM messages WHERE story_id=? AND depth=?`, id, row.d);
        }
        run(`DELETE FROM stories WHERE id=?`, id);
      });
    },

    // -------------------------------------------------------------- messages

    addMessage({ storyId, parentId = null, role, content, model = null, meta = {} }) {
      const parent = parentId ? get(`SELECT depth, chain_hash FROM messages WHERE id=?`, parentId) : null;
      const depth = parent ? parent.depth + 1 : 0;
      const siblings = get(
        `SELECT COALESCE(MAX(sibling_idx),-1)+1 AS n FROM messages
         WHERE story_id=? AND parent_id IS ?`, storyId, parentId
      ).n;
      const id = newId();
      const chain = hashChain(parent ? parent.chain_hash : '', role, content);
      run(`INSERT INTO messages (id,story_id,parent_id,role,content,sibling_idx,depth,
             token_count,chain_hash,model,meta,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, storyId, parentId, role, content, siblings, depth,
        Math.ceil(content.length / 4), chain, model, j(meta), now());
      run(`UPDATE stories SET head_id=?, updated_at=? WHERE id=?`, id, now(), storyId);
      return id;
    },

    /**
     * The messages from the start of the story down to a given point.
     * Bounded, because building a prompt never needs the whole thing.
     */
    pathTo(messageId, limit = 50000) {
      if (!messageId) return [];
      const rows = all(
        `WITH RECURSIVE up(id,story_id,parent_id,role,content,sibling_idx,depth,
                           chain_hash,model,meta,created_at,n) AS (
           SELECT id,story_id,parent_id,role,content,sibling_idx,depth,
                  chain_hash,model,meta,created_at,0 FROM messages WHERE id=?
           UNION ALL
           SELECT m.id,m.story_id,m.parent_id,m.role,m.content,m.sibling_idx,m.depth,
                  m.chain_hash,m.model,m.meta,m.created_at,up.n+1
           FROM messages m JOIN up ON m.id = up.parent_id WHERE up.n < ?
         )
         SELECT * FROM up ORDER BY depth ASC`, messageId, limit
      );
      return rows.map((r) => ({ ...r, meta: p(r.meta, {}) }));
    },

    /** Alternative versions of a message: the swipes under the same parent. */
    siblingsOf(messageId) {
      const m = get(`SELECT story_id, parent_id FROM messages WHERE id=?`, messageId);
      if (!m) return [];
      return all(
        `SELECT id, sibling_idx, content, model, created_at FROM messages
         WHERE story_id=? AND parent_id IS ? ORDER BY sibling_idx`, m.story_id, m.parent_id
      );
    },

    getMessage(id) {
      const r = get(`SELECT * FROM messages WHERE id=?`, id);
      return r ? { ...r, meta: p(r.meta, {}) } : null;
    },

    /**
     * Change what a message says. Everything memory worked out from the old
     * text is now wrong: this message's own record, any folded scene that
     * covered it, and every snapshot at or below it. The chain hashes that
     * key all of that are recomputed for the whole subtree.
     */
    editMessage(id, content) {
      const m = get(`SELECT story_id, parent_id FROM messages WHERE id=?`, id);
      if (!m) return;
      api.transaction(() => {
        run(`UPDATE messages SET content=?, edited_at=?, token_count=? WHERE id=?`,
          content, now(), Math.ceil(content.length / 4), id);
        run(`DELETE FROM message_memory WHERE message_id=?`, id);
        run(`DELETE FROM episodes WHERE story_id=? AND covers LIKE ?`, m.story_id, `%"${id}"%`);

        const parent = m.parent_id ? get(`SELECT chain_hash FROM messages WHERE id=?`, m.parent_id) : null;
        let level = [{ id, parentHash: parent ? parent.chain_hash : '' }];
        while (level.length) {
          const next = [];
          for (const { id: mid, parentHash } of level) {
            const row = get(`SELECT role, content FROM messages WHERE id=?`, mid);
            if (!row) continue;
            const h = hashChain(parentHash, row.role, row.content);
            run(`UPDATE messages SET chain_hash=? WHERE id=?`, h, mid);
            run(`DELETE FROM state_snapshots WHERE message_id=?`, mid);
            for (const c of all(`SELECT id FROM messages WHERE parent_id=?`, mid)) next.push({ id: c.id, parentHash: h });
          }
          level = next;
        }
      });
    },

    /** Removing a message takes its whole subtree with it. */
    deleteMessage(id) {
      const m = get(`SELECT story_id, parent_id FROM messages WHERE id=?`, id);
      if (!m) return;
      // If it sits anywhere on the current path, the head must step back to
      // its parent, or the story is left pointing at a row that is gone.
      const story = get(`SELECT head_id FROM stories WHERE id=?`, m.story_id);
      if (story && story.head_id && api.pathTo(story.head_id).some((x) => x.id === id)) {
        run(`UPDATE stories SET head_id=?, updated_at=? WHERE id=?`, m.parent_id, now(), m.story_id);
      }
      api.deleteSubtree(id);
    },

    /**
     * Delete a message and everything below it, one depth level at a time,
     * deepest first, so the self-referential cascade never recurses.
     */
    deleteSubtree(rootId) {
      const root = get(`SELECT depth FROM messages WHERE id=?`, rootId);
      if (!root) return;
      const byDepth = new Map([[root.depth, [rootId]]]);
      const queue = [rootId];
      while (queue.length) {
        const pid = queue.shift();
        for (const r of all(`SELECT id, depth FROM messages WHERE parent_id=?`, pid)) {
          if (!byDepth.has(r.depth)) byDepth.set(r.depth, []);
          byDepth.get(r.depth).push(r.id);
          queue.push(r.id);
        }
      }
      api.transaction(() => {
        for (const d of [...byDepth.keys()].sort((a, b) => b - a)) {
          const ids = byDepth.get(d);
          for (let i = 0; i < ids.length; i += 200) {
            const chunk = ids.slice(i, i + 200);
            run(`DELETE FROM messages WHERE id IN (${chunk.map(() => '?').join(',')})`, ...chunk);
          }
        }
      });
    },

    // ---------------------------------------------------------------- memory

    saveMessageMemory(messageId, storyId, { summary, delta, extracted, model }) {
      run(`INSERT INTO message_memory (message_id,story_id,summary,delta,extracted,model,created_at)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(message_id) DO UPDATE SET
             summary=excluded.summary, delta=excluded.delta,
             extracted=excluded.extracted, model=excluded.model`,
        messageId, storyId, summary || '', j(delta || {}), j(extracted || {}), model || null, now());
    },

    getMessageMemory(messageId) {
      const r = get(`SELECT * FROM message_memory WHERE message_id=?`, messageId);
      if (!r) return null;
      return { ...r, delta: p(r.delta, {}), extracted: p(r.extracted, {}) };
    },

    /** Messages on this path that have not been read by the memory pass yet. */
    unreadOnPath(messageId, limit = 50000) {
      const path = api.pathTo(messageId, limit);
      return path.filter((m) => m.role === 'assistant' && !get(`SELECT 1 FROM message_memory WHERE message_id=?`, m.id));
    },

    saveSnapshot(messageId, storyId, state) {
      run(`INSERT INTO state_snapshots (message_id,story_id,state,created_at) VALUES (?,?,?,?)
           ON CONFLICT(message_id) DO UPDATE SET state=excluded.state`,
        messageId, storyId, j(state), now());
    },
    /**
     * Throw away every snapshot for a story, so the state is rebuilt from the
     * deltas themselves.
     *
     * Needed whenever the rules that turn deltas into state change — the
     * pacing ladder, mainly. A snapshot is the old rules already applied and
     * frozen, so without this, changing the ladder would leave a story
     * standing exactly where the old one put it. Costs nothing but a re-fold:
     * no model calls, since the deltas are already on disk.
     */
    clearSnapshots(storyId) {
      run(`DELETE FROM state_snapshots WHERE story_id=?`, storyId);
    },

    getSnapshot(messageId) {
      const r = get(`SELECT state FROM state_snapshots WHERE message_id=?`, messageId);
      return r ? p(r.state, null) : null;
    },

    addOverride(storyId, { afterId, path, value, note }) {
      const id = newId();
      // SQL NULL means "remove this"; a JSON null would be stored as the
      // string "null" and read back as a value, which is not a removal.
      const stored = (value === undefined || value === null) ? null : j(value);
      run(`INSERT INTO state_overrides (id,story_id,after_id,path,value,note,created_at)
           VALUES (?,?,?,?,?,?,?)`,
        id, storyId, afterId || null, path, stored, note || '', now());
      return id;
    },
    overridesFor(storyId) {
      return all(`SELECT * FROM state_overrides WHERE story_id=? ORDER BY created_at`, storyId);
    },
    deleteOverride(id) { run(`DELETE FROM state_overrides WHERE id=?`, id); },

    saveEpisode(storyId, { layer = 0, chainHash, content, covers, anchorId, keys }) {
      const existing = get(`SELECT id FROM episodes WHERE chain_hash=? AND story_id=?`, chainHash, storyId);
      if (existing) return existing.id;
      const id = newId();
      run(`INSERT INTO episodes (id,story_id,layer,chain_hash,content,covers,anchor_id,keys,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        id, storyId, layer, chainHash, content, j(covers || []), anchorId || null, j(keys || []), now());
      return id;
    },

    /** Episodes that cover messages on this path, oldest first. */
    episodesOnPath(messageId, limit = 50000) {
      const path = api.pathTo(messageId, limit);
      const onPath = new Set(path.map((m) => m.id));
      if (!path.length) return [];
      const rows = all(`SELECT * FROM episodes WHERE story_id=? ORDER BY layer DESC, created_at`, path[0].story_id);
      const depth = new Map(path.map((m, i) => [m.id, i]));
      return rows
        .map((r) => ({ ...r, covers: p(r.covers, []), keys: p(r.keys, []) }))
        .filter((e) => e.covers.length && e.covers.every((id) => onPath.has(id)))
        .sort((a, b) => (depth.get(a.covers[0]) ?? 0) - (depth.get(b.covers[0]) ?? 0));
    },

    episodesFor(storyId) {
      return all(`SELECT * FROM episodes WHERE story_id=? ORDER BY created_at DESC`, storyId)
        .map((r) => ({ ...r, covers: p(r.covers, []), keys: p(r.keys, []) }));
    },
    deleteEpisode(id) { run(`DELETE FROM episodes WHERE id=?`, id); },

    memoryStats(storyId) {
      const read = get(`SELECT COUNT(*) n FROM message_memory WHERE story_id=?`, storyId).n;
      const total = get(`SELECT COUNT(*) n FROM messages WHERE story_id=? AND role='assistant'`, storyId).n;
      return {
        read, total,
        episodes: get(`SELECT COUNT(*) n FROM episodes WHERE story_id=?`, storyId).n,
        snapshots: get(`SELECT COUNT(*) n FROM state_snapshots WHERE story_id=?`, storyId).n,
        corrections: get(`SELECT COUNT(*) n FROM state_overrides WHERE story_id=?`, storyId).n,
      };
    },

    // -------------------------------------------------------------- settings

    setSetting(key, value) {
      run(`INSERT INTO settings (key,value) VALUES (?,?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, j(value));
    },
    getSetting(key, fallback = null) {
      const r = get(`SELECT value FROM settings WHERE key=?`, key);
      return r ? p(r.value, fallback) : fallback;
    },

    stats() {
      return {
        characters: get(`SELECT COUNT(*) n FROM characters`).n,
        lorebooks: get(`SELECT COUNT(*) n FROM lorebooks`).n,
        entries: get(`SELECT COUNT(*) n FROM lore_entries`).n,
        stories: get(`SELECT COUNT(*) n FROM stories`).n,
        messages: get(`SELECT COUNT(*) n FROM messages`).n,
      };
    },
  };

  return api;
}

/**
 * The name to call the player, from an entry they marked as themselves.
 * "User Persona — Reiko Ryuusui" is a label plus a name; the name is the half
 * that matters, and the text usually states it outright as well.
 */
function personaNameFrom(row) {
  const stated = /^\s*name\s*:\s*(.+)$/im.exec(String(row.content || ''));
  if (stated) return stated[1].trim().split(/\s{2,}|\s*\|\s*/)[0].trim();
  const title = String(row.title || '').trim();
  const stripped = title
    .replace(/^\s*(user\s+)?persona\s*[:—–-]\s*/i, '')
    .replace(/\s*[—–-]\s*(user\s+)?persona\s*$/i, '')
    .trim();
  return stripped || title;
}

function rowToEntry(r) {
  return {
    id: r.id,
    lorebookId: r.lorebook_id,
    title: r.title,
    content: r.content,
    keys: p(r.keys, []),
    secondaryKeys: p(r.secondary_keys, []),
    enabled: !!r.enabled,
    constant: !!r.constant,
    selective: !!r.selective,
    selectiveLogic: r.selective_logic,
    order: r.ord,
    position: r.position,
    depth: r.depth,
    role: r.role,
    probability: r.probability,
    useProbability: !!r.use_probability,
    caseSensitive: !!r.case_sensitive,
    matchWholeWords: !!r.match_whole_words,
    useRegex: !!r.use_regex,
    scanDepth: r.scan_depth,
    excludeRecursion: !!r.exclude_recursion,
    preventRecursion: !!r.prevent_recursion,
    delayUntilRecursion: r.delay_until_recursion,
    group: r.grp,
    groupOverride: !!r.group_override,
    groupWeight: r.group_weight,
    useGroupScoring: !!r.use_group_scoring,
    sticky: r.sticky,
    cooldown: r.cooldown,
    delay: r.delay,
    ignoreBudget: !!r.ignore_budget,
    vectorized: !!r.vectorized,
    decorators: p(r.decorators, []),
    outletName: '',
    kind: r.kind || 'note',
    playable: !!r.playable,
    traits: p(r.traits, []),
    summary: r.summary || '',
    image: r.image || null,
    linked: p(r.linked, []),
  };
}

/**
 * Each message's hash folds in its parent's. Two different branches therefore
 * produce different hashes from the fork onward, which means anything keyed on
 * the hash is automatically branch-aware, and editing a message invalidates
 * everything below it without any bookkeeping.
 */
function hashChain(parentHash, role, content) {
  let h = 0x811c9dc5;
  const s = `${parentHash} ${role} ${content}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + s.length.toString(36);
}
