-- Everything lives in one file on disk. Copy it and you have copied your
-- whole world: characters, lore, and every version of every story.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- characters

CREATE TABLE IF NOT EXISTS characters (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  nickname      TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  personality   TEXT NOT NULL DEFAULT '',
  scenario      TEXT NOT NULL DEFAULT '',
  first_message TEXT NOT NULL DEFAULT '',
  example_dialogue TEXT NOT NULL DEFAULT '',
  alternate_greetings TEXT NOT NULL DEFAULT '[]',   -- json array
  system_prompt TEXT NOT NULL DEFAULT '',
  post_history_instructions TEXT NOT NULL DEFAULT '',
  depth_prompt  TEXT,                                -- json or null
  creator_notes TEXT NOT NULL DEFAULT '',
  tags          TEXT NOT NULL DEFAULT '[]',
  avatar        TEXT,                                -- data uri or asset id
  linked_world  TEXT NOT NULL DEFAULT '',
  spec          TEXT NOT NULL DEFAULT '',
  original      TEXT NOT NULL,                       -- the file exactly as imported
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- ----------------------------------------------------------------- lorebooks

CREATE TABLE IF NOT EXISTS lorebooks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  scan_depth  INTEGER,
  token_budget INTEGER,
  recursive   INTEGER NOT NULL DEFAULT 0,
  -- when a book arrived inside a character card, remember whose it was
  from_character TEXT REFERENCES characters(id) ON DELETE CASCADE,
  original    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lore_entries (
  id            TEXT PRIMARY KEY,
  lorebook_id   TEXT NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
  title         TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL,
  keys          TEXT NOT NULL DEFAULT '[]',          -- json array
  secondary_keys TEXT NOT NULL DEFAULT '[]',
  enabled       INTEGER NOT NULL DEFAULT 1,
  constant      INTEGER NOT NULL DEFAULT 0,
  selective     INTEGER NOT NULL DEFAULT 1,
  selective_logic INTEGER NOT NULL DEFAULT 0,
  ord           INTEGER NOT NULL DEFAULT 100,
  position      INTEGER NOT NULL DEFAULT 0,
  depth         INTEGER NOT NULL DEFAULT 4,
  role          INTEGER NOT NULL DEFAULT 0,
  probability   INTEGER NOT NULL DEFAULT 100,
  use_probability INTEGER NOT NULL DEFAULT 1,
  case_sensitive INTEGER NOT NULL DEFAULT 0,
  match_whole_words INTEGER NOT NULL DEFAULT 0,
  use_regex     INTEGER NOT NULL DEFAULT 0,
  scan_depth    INTEGER,
  exclude_recursion INTEGER NOT NULL DEFAULT 0,
  prevent_recursion INTEGER NOT NULL DEFAULT 0,
  delay_until_recursion INTEGER NOT NULL DEFAULT 0,
  grp           TEXT NOT NULL DEFAULT '',
  group_override INTEGER NOT NULL DEFAULT 0,
  group_weight  INTEGER NOT NULL DEFAULT 100,
  use_group_scoring INTEGER NOT NULL DEFAULT 0,
  sticky        INTEGER,
  cooldown      INTEGER,
  delay         INTEGER,
  ignore_budget INTEGER NOT NULL DEFAULT 0,
  vectorized    INTEGER NOT NULL DEFAULT 0,
  decorators    TEXT NOT NULL DEFAULT '[]',
  original      TEXT NOT NULL,
  display_index INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lore_book ON lore_entries(lorebook_id, enabled);

-- ------------------------------------------------------------------ personas

CREATE TABLE IF NOT EXISTS personas (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  avatar      TEXT,
  created_at  INTEGER NOT NULL
);

-- ------------------------------------------------------------------- stories

CREATE TABLE IF NOT EXISTS stories (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  persona_id  TEXT REFERENCES personas(id) ON DELETE SET NULL,
  -- which message we are currently standing on. Changing this is how you
  -- move between branches, and it is a single row write.
  head_id     TEXT,
  settings    TEXT NOT NULL DEFAULT '{}',            -- json: model, window, temperature
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- which characters are in a story, and which lorebooks are switched on
CREATE TABLE IF NOT EXISTS story_characters (
  story_id     TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'cast',         -- 'lead' | 'cast'
  PRIMARY KEY (story_id, character_id)
);

CREATE TABLE IF NOT EXISTS story_lorebooks (
  story_id    TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  lorebook_id TEXT NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
  PRIMARY KEY (story_id, lorebook_id)
);

-- ------------------------------------------------------------------ messages
--
-- A tree, not a list. Regenerating never overwrites: it adds a sibling under
-- the same parent. Every version you have ever seen stays reachable.

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  story_id    TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  parent_id   TEXT REFERENCES messages(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,                          -- 'user' | 'assistant' | 'system'
  content     TEXT NOT NULL,
  sibling_idx INTEGER NOT NULL DEFAULT 0,             -- which swipe this is
  depth       INTEGER NOT NULL,
  token_count INTEGER,
  -- a content hash chained to the parent's. Two different paths get different
  -- hashes, so anything keyed on it is branch-aware without extra logic.
  chain_hash  TEXT NOT NULL,
  model       TEXT,
  meta        TEXT NOT NULL DEFAULT '{}',
  edited_at   INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_parent ON messages(parent_id, sibling_idx);
CREATE INDEX IF NOT EXISTS idx_msg_story  ON messages(story_id, depth);

-- ------------------------------------------------------------------ settings

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ------------------------------------------------------------------ presets
-- A named bundle of how-it-writes settings. Not the cast, not the lore:
-- those belong to a story. This is the dial settings you want to reuse.

CREATE TABLE IF NOT EXISTS presets (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  builtin    INTEGER NOT NULL DEFAULT 0,
  settings   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Entries gained a kind, a playable flag and traits after the first release.
-- SQLite has no "add column if missing", so these are wrapped by the caller.

-- ======================================================================
--                              memory
-- ======================================================================
--
-- Everything here is keyed to a message, never to a story. That one choice
-- makes the whole thing branch-safe for nothing: two different paths through
-- the tree naturally fold to two different states, with no bookkeeping.

-- What one message changed. Written once, in the background, after the reply.
CREATE TABLE IF NOT EXISTS message_memory (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  story_id   TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  summary    TEXT NOT NULL DEFAULT '',
  delta      TEXT NOT NULL DEFAULT '{}',   -- what changed in the world
  extracted  TEXT NOT NULL DEFAULT '{}',   -- facts, threads, lore candidates
  model      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_story ON message_memory(story_id);

-- Scenes, folded down. Keyed by a hash of the messages they cover, so a
-- branch that shares a past shares its episodes, and an edit invalidates
-- exactly what it should.
CREATE TABLE IF NOT EXISTS episodes (
  id         TEXT PRIMARY KEY,
  story_id   TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  layer      INTEGER NOT NULL DEFAULT 0,
  chain_hash TEXT NOT NULL,
  content    TEXT NOT NULL,
  covers     TEXT NOT NULL DEFAULT '[]',
  anchor_id  TEXT,
  keys       TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episode_story ON episodes(story_id, layer);
CREATE INDEX IF NOT EXISTS idx_episode_hash  ON episodes(chain_hash);

-- The whole world state, written down every so often so that jumping to a
-- branch is a short walk rather than replaying thousands of messages.
CREATE TABLE IF NOT EXISTS state_snapshots (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  story_id   TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  state      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Things you corrected by hand. These always win over anything extracted.
CREATE TABLE IF NOT EXISTS state_overrides (
  id         TEXT PRIMARY KEY,
  story_id   TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  after_id   TEXT,                          -- applies from this message onward
  path       TEXT NOT NULL,                 -- e.g. threads/T007/status
  value      TEXT,                          -- json, or null to remove
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_override_story ON state_overrides(story_id);

-- ======================================================================
--                        imported resources
-- ======================================================================
--
-- The format a file arrives in and what the thing inside it is FOR are two
-- different questions. A scenario posted as a character card is still a
-- character card; it is just not a character. These tables hold the second
-- answer without disturbing the first.
--
-- Four concepts, kept apart on purpose:
--
--   character   a reusable individual
--   scenario    a concrete situation, ready to start a story
--   framework   a world and how to run it, reusable by many stories
--   story       one actual continuity
--
-- A scenario is nearly a story. A framework is not a story at all, and
-- folding it into one would mean every campaign became a playthrough of
-- itself.

-- One row per file that came in. Written when the file is ANALYSED, before
-- anything is created from it, so the original survives whatever is decided
-- and can be read again later.
CREATE TABLE IF NOT EXISTS imports (
  id             TEXT PRIMARY KEY,
  filename       TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL DEFAULT 'file',   -- file | url | disk
  source_url     TEXT NOT NULL DEFAULT '',
  format         TEXT NOT NULL DEFAULT '',       -- the technical format, never overwritten
  spec           TEXT NOT NULL DEFAULT '',       -- v1 | v2 | v3 | pygmalion, where it applies
  detected_role  TEXT NOT NULL DEFAULT '',       -- what the classifier said
  chosen_role    TEXT NOT NULL DEFAULT '',       -- what was actually committed, if anything
  confidence     TEXT NOT NULL DEFAULT '',
  analysis       TEXT NOT NULL DEFAULT '{}',     -- the whole verdict: reasons, alternatives, components, parts, signals
  original       TEXT NOT NULL,                  -- the file exactly as it arrived
  committed_at   INTEGER,
  created_at     INTEGER NOT NULL
);

-- What one import produced. A single file can make several linked things.
CREATE TABLE IF NOT EXISTS import_resources (
  import_id   TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                     -- character | lorebook | scenario | framework | story | preset
  resource_id TEXT NOT NULL,
  part        TEXT NOT NULL DEFAULT 'primary',   -- primary | piece
  PRIMARY KEY (import_id, kind, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_import_res ON import_resources(kind, resource_id);

-- Reusable world and campaign infrastructure. Many stories may use one of
-- these; using it never joins their continuities.
CREATE TABLE IF NOT EXISTS frameworks (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  world        TEXT NOT NULL DEFAULT '',      -- what the place is: goes in the cached half
  narrator     TEXT NOT NULL DEFAULT '',      -- how to run it: also cached
  closing      TEXT NOT NULL DEFAULT '',      -- post-history instructions: the volatile tail
  depth_note   TEXT,                          -- json {text,depth,role}, injected mid-history
  ensemble     TEXT NOT NULL DEFAULT '',      -- example dialogue that belongs to the room, not to a person
  tags         TEXT NOT NULL DEFAULT '[]',
  avatar       TEXT,
  import_id    TEXT REFERENCES imports(id) ON DELETE SET NULL,
  original     TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- A concrete situation, ready to become a story.
CREATE TABLE IF NOT EXISTS scenarios (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  premise      TEXT NOT NULL DEFAULT '',
  directions   TEXT NOT NULL DEFAULT '',
  ensemble     TEXT NOT NULL DEFAULT '',
  -- Who is in it. Names discovered in the text, each with the library
  -- character it matched IF one already existed. Never a fabricated card.
  cast         TEXT NOT NULL DEFAULT '[]',
  framework_id TEXT REFERENCES frameworks(id) ON DELETE SET NULL,
  tags         TEXT NOT NULL DEFAULT '[]',
  avatar       TEXT,
  import_id    TEXT REFERENCES imports(id) ON DELETE SET NULL,
  original     TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Lore belonging to a framework or a scenario. One table rather than two,
-- because the relationship is the same shape either way.
CREATE TABLE IF NOT EXISTS resource_lorebooks (
  owner_kind  TEXT NOT NULL,                  -- framework | scenario
  owner_id    TEXT NOT NULL,
  lorebook_id TEXT NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
  PRIMARY KEY (owner_kind, owner_id, lorebook_id)
);

-- Every way a resource can begin.
--
-- first_mes, alternate_greetings and group_only_greetings were all read on
-- import and then only the first was ever used. A card offering three ways in
-- arrived as one opening and two dead fields. They live here now, for
-- characters as much as for scenarios and frameworks.
CREATE TABLE IF NOT EXISTS starting_points (
  id         TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,                   -- character | scenario | framework
  owner_id   TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT '',        -- which field of the card it came from
  ord        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_starts ON starting_points(owner_kind, owner_id, ord);

-- ======================================================================
--                      composing a story
-- ======================================================================
--
-- A source package is not a story. It is material a story is made of, and
-- the same package can furnish two stories differently. These tables hold
-- the composition — who is in THIS story and what a piece of material is
-- ABOUT — without copying a single entry or touching the package.

-- People who are in a story but have no card of their own. Salvatore is a
-- lore entry; he does not need to become a reusable Character just to be in
-- the room. Full cards stay in story_characters, which is unchanged.
CREATE TABLE IF NOT EXISTS story_npcs (
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL REFERENCES lore_entries(id) ON DELETE CASCADE,
  role     TEXT NOT NULL DEFAULT 'background',   -- main | supporting | background
  ord      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (story_id, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_npc_story ON story_npcs(story_id, role);

-- DEPRECATED (P1 of the semantic model). Kept intact and no longer written.
-- These recorded "about" guesses with no origin, story or confirmation, so
-- they are not semantic truth. Their rows are copied into legacy_entry_links
-- as evidence; the tables themselves are removed only in a later, approved
-- cleanup. Read them for nothing new.
--
-- What a piece of material is about. Real foreign keys in both directions,
-- one table per target kind, because a polymorphic id column cannot cascade
-- and a dangling link is worse than no link.
--
-- Never filled from lorebooks.from_character: a book that arrived with
-- Patrick's card contains the Vancetti family and half a city. Where a thing
-- CAME FROM and what it is ABOUT are different questions.
CREATE TABLE IF NOT EXISTS entry_character_links (
  entry_id     TEXT NOT NULL REFERENCES lore_entries(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(id)   ON DELETE CASCADE,
  PRIMARY KEY (entry_id, character_id)
);
CREATE INDEX IF NOT EXISTS idx_ecl_char ON entry_character_links(character_id);

-- The same, between two pieces of material: the Black Lotus is Salvatore's,
-- and Salvatore has no card.
CREATE TABLE IF NOT EXISTS entry_entry_links (
  entry_id  TEXT NOT NULL REFERENCES lore_entries(id) ON DELETE CASCADE,
  about_id  TEXT NOT NULL REFERENCES lore_entries(id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, about_id)
);
CREATE INDEX IF NOT EXISTS idx_eel_about ON entry_entry_links(about_id);

-- Material one story has decided to ignore. The entry stays exactly as it is
-- in its package, enabled, and every other story still reads it; this story
-- simply never counts it as eligible. Any kind of entry — a person left out of
-- an AU, an event that never happened here, a rule that does not apply.
--
-- Its own table rather than a role in story_npcs (being ignored is not a part
-- in the cast) or a list in stories.settings (a list of ids cannot cascade,
-- and the eligibility query could not see it).
CREATE TABLE IF NOT EXISTS story_entry_exclusions (
  story_id   TEXT NOT NULL REFERENCES stories(id)      ON DELETE CASCADE,
  entry_id   TEXT NOT NULL REFERENCES lore_entries(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (story_id, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_exclusion_entry ON story_entry_exclusions(entry_id);

-- ======================================================================
--                      the semantic model (P1)
-- ======================================================================
--
-- Four separate things, deliberately kept apart:
--
--   an ENTITY            who or what something is: Patrick Moretti, the Black Lotus
--   a SOURCE DECLARATION a source saying it describes that entity
--   a CHARACTER CARD     a reusable character resource (characters)
--   a STORY BINDING      which card represents the entity in one story
--
-- An entity belongs to no lorebook and holds no card, so deleting one source
-- never destroys an identity another source or a story still uses.
--
-- Nothing here changes what the engine activates or sends. `lore_entries.kind`
-- is left exactly as imported; approved semantics outrank it only for
-- organisation (casting, sections, the Directions tool, later the Builder).

CREATE TABLE IF NOT EXISTS lore_entities (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL CHECK (type IN ('person','place','faction','item','event','concept')),
  canonical_name TEXT NOT NULL,
  aliases        TEXT NOT NULL DEFAULT '[]',
  -- An entity approved as the same as another keeps pointing at it, so old
  -- references and re-imports still resolve.
  merged_into_id TEXT REFERENCES lore_entities(id) ON DELETE RESTRICT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- A source declares an entity. Several sources may declare the same one, but
-- only after explicit approval; by default each source's Patrick is its own.
CREATE TABLE IF NOT EXISTS source_entities (
  lorebook_id   TEXT NOT NULL REFERENCES lorebooks(id)     ON DELETE CASCADE,
  entity_id     TEXT NOT NULL REFERENCES lore_entities(id) ON DELETE RESTRICT,
  local_ref     TEXT NOT NULL,
  local_name    TEXT NOT NULL DEFAULT '',
  local_aliases TEXT NOT NULL DEFAULT '[]',
  origin        TEXT NOT NULL CHECK (origin IN ('native','converted','manual','generated')),
  status        TEXT NOT NULL CHECK (status IN ('proposed','approved')),
  evidence      TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (lorebook_id, entity_id),
  UNIQUE (lorebook_id, local_ref)
);
CREATE INDEX IF NOT EXISTS idx_source_entities_entity ON source_entities(entity_id);

-- What an entry is, as organised: its scope, its category, and whether it is
-- the profile of an entity. One row per entry, or none (not organised yet).
-- Categories are singular; headings in the UI may be plural.
CREATE TABLE IF NOT EXISTS entry_semantics (
  entry_id          TEXT PRIMARY KEY REFERENCES lore_entries(id) ON DELETE CASCADE,
  scope             TEXT NOT NULL CHECK (scope IN ('entity','world','other')),
  category          TEXT NOT NULL CHECK (category IN (
                      'identity','appearance','personality','speech','behavior','backstory',
                      'psychology','relationship','secret','goal',
                      'background','rule','event','item','direction','reference',
                      'profile','other')),
  defines_entity_id TEXT REFERENCES lore_entities(id) ON DELETE RESTRICT,
  origin            TEXT NOT NULL CHECK (origin IN ('native','converted','manual','generated','inferred')),
  status            TEXT NOT NULL CHECK (status IN ('proposed','approved')),
  confidence        TEXT CHECK (confidence IN ('high','medium','low')),
  evidence          TEXT NOT NULL DEFAULT '{}',
  -- Title, content and keys when approved. A different hash now means the
  -- entry changed after review: NEEDS RECHECK.
  content_hash      TEXT,
  -- An authoring hint only; the engine reads the entry's own activation fields.
  -- 'auto' is reserved and not used until it is designed.
  activation_policy TEXT CHECK (activation_policy IN ('auto','always','keywords','advanced')),
  reviewed_at       INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entry_semantics_defines ON entry_semantics(defines_entity_id);

-- Who or what an entry is about. At most one APPROVED subject per entry;
-- any number of related entities; proposals are never canon.
CREATE TABLE IF NOT EXISTS entry_relations (
  entry_id   TEXT NOT NULL REFERENCES lore_entries(id)  ON DELETE CASCADE,
  entity_id  TEXT NOT NULL REFERENCES lore_entities(id) ON DELETE RESTRICT,
  relation   TEXT NOT NULL CHECK (relation IN ('subject','related')),
  origin     TEXT NOT NULL CHECK (origin IN ('native','converted','manual','generated','inferred')),
  status     TEXT NOT NULL CHECK (status IN ('proposed','approved')),
  confidence TEXT CHECK (confidence IN ('high','medium','low')),
  evidence   TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entry_id, entity_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_approved_subject
  ON entry_relations(entry_id) WHERE relation = 'subject' AND status = 'approved';
CREATE INDEX IF NOT EXISTS idx_entry_relations_entity ON entry_relations(entity_id);

-- Which card represents an entity in one story. Never on the entity itself:
-- Patrick is card 8a2be6d9 in one story, 6fcedc7a in another, and no card at all
-- in a third.
CREATE TABLE IF NOT EXISTS story_entity_cards (
  story_id     TEXT NOT NULL REFERENCES stories(id)       ON DELETE CASCADE,
  entity_id    TEXT NOT NULL REFERENCES lore_entities(id) ON DELETE RESTRICT,
  character_id TEXT NOT NULL REFERENCES characters(id)    ON DELETE RESTRICT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (story_id, entity_id)
);

-- "These two are NOT the same", decided once. Stored with the smaller id first,
-- so A≠B and B≠A are one decision.
CREATE TABLE IF NOT EXISTS entity_distinctions (
  entity_a   TEXT NOT NULL REFERENCES lore_entities(id) ON DELETE CASCADE,
  entity_b   TEXT NOT NULL REFERENCES lore_entities(id) ON DELETE CASCADE,
  decided_at INTEGER NOT NULL,
  PRIMARY KEY (entity_a, entity_b),
  CHECK (entity_a < entity_b)
);

-- What a source as a whole is FOR, as opposed to what its entries mean.
--
--   character-material  material about people (a card's lore, a person's history)
--   world               a setting: places, factions, rules, history
--   scenario            a situation ready to start
--   story-package       a complete story: cast, world and opening together
--   narrative-framework HOW to narrate and behave: immersion, continuity, pacing
--                       directives that apply to any story ("Living Scene")
--   reference-pack      specialised KNOWLEDGE to draw on when a scene enters its
--                       domain (medical, combat, etiquette, …); available to a
--                       story, reaching a request only when its entries activate
--   mixed               more than one of these
--
-- `domains` is plain tagging (["medical"], ["combat","survival"]), not
-- structure. No row means nobody has said. Not the same thing as the
-- `frameworks` table, which holds campaign worlds shown as "World". Neither a
-- narrative framework nor a reference pack goes through casting or world
-- extraction.
CREATE TABLE IF NOT EXISTS source_semantics (
  lorebook_id  TEXT PRIMARY KEY REFERENCES lorebooks(id) ON DELETE CASCADE,
  package_role TEXT NOT NULL CHECK (package_role IN
                 ('character-material','world','scenario','story-package','narrative-framework','reference-pack','mixed')),
  domains      TEXT NOT NULL DEFAULT '[]',
  origin       TEXT NOT NULL CHECK (origin IN ('native','converted','manual','inferred')),
  status       TEXT NOT NULL CHECK (status IN ('proposed','approved')),
  confidence   TEXT CHECK (confidence IN ('high','medium','low')),
  evidence     TEXT NOT NULL DEFAULT '{}',
  reviewed_at  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Links recorded before the semantic model, and link suggestions accepted in
-- review since: evidence of what someone once connected, never canon.
--
-- No foreign keys, on purpose. Evidence must never stop a card, an entry or a
-- source being deleted, and it should still read sensibly after they are:
-- titles and names are kept as they were when the link was recorded.
CREATE TABLE IF NOT EXISTS legacy_entry_links (
  source         TEXT NOT NULL CHECK (source IN ('entry_character_links','entry_entry_links','composition-review','builder-review')),
  entry_id       TEXT NOT NULL,
  target_kind    TEXT NOT NULL CHECK (target_kind IN ('character','entry')),
  target_id      TEXT NOT NULL,
  entry_title    TEXT NOT NULL DEFAULT '',
  entry_book_id  TEXT,
  entry_origin   TEXT,
  target_name    TEXT NOT NULL DEFAULT '',
  derived_origin TEXT NOT NULL CHECK (derived_origin IN ('composer-inferred','builder-accepted')),
  status         TEXT NOT NULL DEFAULT 'legacy' CHECK (status = 'legacy'),
  recorded_at    INTEGER NOT NULL,
  UNIQUE (source, entry_id, target_kind, target_id)
);
CREATE INDEX IF NOT EXISTS idx_legacy_links_entry ON legacy_entry_links(entry_id);

-- ------------------------------------------------------------------ assets
-- Pictures that belong to a story: backgrounds, scene art. Kept out of the
-- story row so that reading a story every message does not drag a megabyte
-- of image along with it.

CREATE TABLE IF NOT EXISTS assets (
  id         TEXT PRIMARY KEY,
  story_id   TEXT REFERENCES stories(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'background',
  name       TEXT NOT NULL DEFAULT '',
  mime       TEXT NOT NULL,
  bytes      BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asset_story ON assets(story_id, kind);
