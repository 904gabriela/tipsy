# Nexus Package v1

**Status: frozen.** `"format": "nexus-package"` with `"version": 1` is a stable interchange
identifier. Anything that changes the meaning of a v1 file needs a new version number.

This document is the authoritative description of the format. It is written so that a
person, or another AI, can take an old lorebook, an old character card or their own notes
and produce a valid package. The validator in Nexus (`src/package/format.js`) checks exactly
what is written here, and the test suite (`scripts/check-package.js`) checks that this
document and the validator agree.

Complete, valid examples:

- [`examples/nexus-package-v1.example.json`](../examples/nexus-package-v1.example.json): a deep
  Character (Patrick), a deep Persona (Reiko), reusable Knowledge for both, a narrative framework
  and a story with its own material.
- [`examples/nexus-package-v1.frameworks-and-reference.example.json`](../examples/nexus-package-v1.frameworks-and-reference.example.json):
  a narrative framework, a reference pack and reusable Knowledge about a place.

---

## 1. What a package is

One JSON file that carries **people and other entities, what is known about them, and the
stories they are in**, without flattening any of it into a card's description.

A package can be any of these: a character's material, a persona, a world, a scenario,
a narrative framework, a reference pack, a handful of sources, or a complete story.
`package.role` says which.

```text
{
  "format": "nexus-package",
  "version": 1,
  "package":    { id, title, role, domains?, extensions? },
  "entities":   [ { ref, type, name, aliases? } ],
  "characters": [ { ref, name, nickname?, entity?, core?, openings?, creatorNotes?, tags?, extensions? } ],
  "personas":   [ { ref, name, entity?, core? } ],
  "sources":    [ { ref, name, description?, role, domains?, subject?, story?, settings?, entries, extensions? } ],
  "stories":    [ { ref, title, persona?, cast, sources, exclusions?, npcs?, directions?, premise? } ],
  "extensions": { }
}
```

`entities`, `characters`, `personas`, `sources` and `stories` are all optional lists.

## 2. General rules

**Strict.** A field that is not in this document is an error, not silently ignored. That is
how nothing in a file can quietly fail to arrive. Vendor or tool data goes under `extensions`
where extensions are allowed (§12).

**Refs.** Everything that other parts of the package point at has a `ref`: letters, digits,
`.`, `_` or `-`, starting with a letter or digit, at most 100 characters. Refs are unique within
their list (entry refs are unique within their source).

**Refs are local to one package.** `"patrick"` in one package and `"patrick"` in another are
**not** the same person. Deciding that a package's person is someone already in your library is
a choice made when importing (§10).

**Text.** Every text field is a JSON string of at most 1,000,000 characters. A package holds at
most 20,000 entries.

**Order.** Entries keep their order. Other lists (entities, characters, personas, sources,
stories, a story's sources and exclusions, an entry's `related`) are unordered; Nexus writes them
sorted by ref. The cast is written lead first. `npcs` keep their order.

## 3. `package`

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | A stable identifier for this package, at most 200 characters. Nexus records it, warns when the same package is imported again, and writes it back on export. |
| `title` | yes | A human name. |
| `role` | yes | What the package as a whole is for (§4). |
| `domains` | no | Tags (§4). |
| `extensions` | no | Vendor data (§12). |

## 4. Roles and domains

A **role** says what a package, or one source in it, is **for**. It says nothing about what any
single entry means; entries carry their own `semantics` (§8).

<!-- check:roles -->
| Role | For |
|---|---|
| `entity-material` | Reusable knowledge that travels with one entity: a person used as a Character or a Persona, or a place, a faction, and so on. Which entity is the source's `subject`. Nexus shows it in context as *Character Knowledge*, *Persona Knowledge*, *Location Knowledge*… |
| `world` | A setting: places, factions, rules, history. |
| `scenario` | A situation ready to start. |
| `story-package` | A complete story: cast, world and opening together. |
| `narrative-framework` | **How** to narrate and behave: immersion, continuity and pacing rules for any story. |
| `reference-pack` | Specialised **knowledge** to draw on when a scene enters its domain (medicine, combat, etiquette…). Available to a story, reaching the model only when its entries activate. |
| `mixed` | More than one of these. |
<!-- /check -->

There are no other roles. A narrative framework or reference pack is never read for a cast or
locations.

**Domains** are tags for what a source or package covers, such as `"medical"` or `"first-aid"`.
They are metadata only. Each is lower-case letters and digits, words joined by `-`, listed once.

## 5. `entities`

An entity is a person, place or thing that knowledge can be about. It belongs to no source and
to no card.

| Field | Required | Meaning |
|---|---|---|
| `ref` | yes | |
| `type` | yes | One of the types below. |
| `name` | yes | |
| `aliases` | no | Other names, as a list of text. |

<!-- check:entity-types -->
Types: `person`, `place`, `faction`, `item`, `event`, `concept`.
<!-- /check -->

## 6. `characters`: Character Core

A character is a person the AI plays. Its **Core** is compact, stable information that is sent
whenever the character is in the story. Everything deeper is **Knowledge**: entries in a source
(§7, §8), sent only when they activate.

| Field | Required | Meaning |
|---|---|---|
| `ref` | yes | |
| `name` | yes | |
| `nickname` | no | What the story calls them. |
| `entity` | no | The `person` entity this character is. Import binds the new card to it. |
| `core` | no | Core slots, below. |
| `openings` | no | `scenario` (where you meet them), `first` (first message), `alternates` (list of other first messages). |
| `creatorNotes` | no | |
| `tags` | no | List of text. |
| `extensions` | no | |

<!-- check:character-core -->
| Core slot | Meaning |
|---|---|
| `identity` | Who they are. The general description. |
| `appearance` | What they look like. |
| `personality` | Temperament and traits. |
| `behavior` | How they act. |
| `speechStyle` | How they sound, described. |
| `speechExamples` | Example dialogue. `<START>` separates exchanges; `{{char}}` and `{{user}}` are names. |
| `systemInstructions` | The character's own instructions to the model. |
| `postHistoryInstructions` | Instructions placed after the conversation. |
| `depthPrompt` | An object carried as-is from cards that have one, or `null`. |
<!-- /check -->

Every text slot defaults to `""`. **Keep Core compact.** Childhood, trauma, powers, skills,
equipment, relationships and secrets belong in Knowledge, not in Core.

## 7. `personas`: Persona Core

A persona is a person **you** play. It can be exactly as deep as a character: its Knowledge
lives in sources just like a character's.

| Field | Required | Meaning |
|---|---|---|
| `ref` | yes | |
| `name` | yes | |
| `entity` | no | The `person` entity this persona is. |
| `core` | no | Core slots, below. |

<!-- check:persona-core -->
| Core slot | Meaning |
|---|---|
| `identity` | Who they are. The general description. |
| `appearance` | What they look like. |
| `personality` | Temperament and traits. |
| `behavior` | How they act. |
| `speechStyle` | How they sound. |
<!-- /check -->

## 8. `sources` and entries: Knowledge

A source is a collection of entries.

| Field | Required | Meaning |
|---|---|---|
| `ref` | yes | |
| `name` | yes | |
| `description` | no | |
| `role` | yes | §4. |
| `domains` | no | §4. |
| `subject` | no | An entity ref: this source is **reusable material that travels with that entity** (normally with role `entity-material`). |
| `story` | no | A story ref: this source is **that story's own material** and nothing else's. |
| `settings` | no | `scanDepth` (whole number or `null`), `tokenBudget` (whole number or `null`), `recursive` (`true` or `false`; default `true`): the book's own scanning settings. |
| `entries` | yes | A list, possibly empty. |
| `extensions` | no | |

A source has `subject` **or** `story` **or** neither, never both.

### Source `subject` vs entry `subject`

- **`source.subject`** answers *"which entity does this reusable material travel with?"*
  Patrick's Knowledge source has `"subject": "patrick"`, so it can be offered whenever Patrick is
  used in a new story.
- **An entry's `semantics.subject`** answers *"what is this one entry about?"*

A source's subject does **not** make every entry in it about that entity. Patrick's Knowledge can
contain an entry that `defines` Salvatore and is merely `related` to Patrick. Each entry says what
it is about on its own.

### Reusable Knowledge vs story-owned material

- A source with a `subject` (or with neither `subject` nor `story`) is reusable. Stories use it by
  attaching it (§9).
- A source with `story` belongs to that one story: Patrick and Reiko's history in *this* continuity,
  Reiko's injury in *this* continuity. The story must attach it, and no other story may. Another
  AU gets its own material with different entries about the same people.

### Entry fields

| Field | Required | Meaning |
|---|---|---|
| `ref` | yes | Unique within the source. |
| `title` | no | At most 2,000 characters. |
| `content` | yes | The knowledge itself. Must not be empty. |
| `enabled` | no | Default `true`. A disabled entry is kept but never used. |
| `summary` | no | A short summary. |
| `activation` | yes | When the entry reaches the model. |
| `semantics` | no | What the entry means. Leave it out when unsure (§11). |
| `extensions` | no | |

### Activation

**Visible under a Character or Persona does not mean always sent.** An entry about Patrick is
shown under Patrick, but it reaches the model only when its activation says so. Most Knowledge
should be `keywords`.

<!-- check:policies -->
| Policy | Meaning |
|---|---|
| `always` | Always included while it is enabled and its source is attached. |
| `keywords` | Included when one of `keys` appears in the recent conversation. Needs at least one key. |
| `advanced` | Every field below is taken exactly as given, including `constant`. Use when converting books with unusual settings. |
<!-- /check -->

`"auto"` is reserved and refused in v1. `constant` may only be given with `advanced`.

The remaining fields follow the SillyTavern World Info convention. All are optional; this is the
value an entry has when a field is left out:

<!-- check:activation -->
| Field | Default | Meaning |
|---|---|---|
| `keys` | `[]` | Primary keywords. |
| `secondaryKeys` | `[]` | Secondary keywords, combined by `selectiveLogic`. |
| `selective` | `true` | Whether secondary keywords apply. |
| `selectiveLogic` | `0` | 0 AND ANY · 1 NOT ALL · 2 NOT ANY · 3 AND ALL. |
| `caseSensitive` | `false` | |
| `matchWholeWords` | `false` | |
| `useRegex` | `false` | Keys are regular expressions. |
| `probability` | `100` | Chance to fire, in percent. |
| `useProbability` | `true` | |
| `order` | `100` | Insertion order. |
| `position` | `0` | 0 before character · 1 after character · 2 author's note top · 3 author's note bottom · 4 at depth · 5 example messages top · 6 example messages bottom · 7 outlet. |
| `depth` | `4` | Depth for position 4. |
| `role` | `0` | Message role for position 4: 0 system · 1 user · 2 assistant. |
| `scanDepth` | `null` | How many recent messages to scan; `null` uses the default. |
| `excludeRecursion` | `false` | Cannot be activated by other entries. |
| `preventRecursion` | `false` | Does not activate other entries. |
| `delayUntilRecursion` | `0` | |
| `group` | `""` | Inclusion group. |
| `groupOverride` | `false` | |
| `groupWeight` | `100` | |
| `useGroupScoring` | `false` | |
| `sticky` | `null` | Turns to stay active once fired. |
| `cooldown` | `null` | Turns before it can fire again. |
| `delay` | `null` | Turns before it can first fire. |
| `ignoreBudget` | `false` | |
| `vectorized` | `false` | |
| `decorators` | `[]` | List of text. |
<!-- /check -->

### Semantics

| Field | Meaning |
|---|---|
| `scope` | `entity` (about or defining an entity), `world` (about the setting or the telling), or `other`. |
| `category` | What kind of knowledge it is. The allowed values depend on `scope`, below. |
| `subject` | The entity this entry is **about**. At most one. |
| `defines` | The entity this entry **is the profile of**: the entry that says who Salvatore is. |
| `related` | Other entities the entry involves, as a list of refs. |
| `displayPath` | Where to show it, in your own words (below). |

Rules:

- `scope: "entity"` needs `subject` **or** `defines`, not both.
- `scope: "world"` and `scope: "other"` have neither.
- `related` lists each entity once and never repeats the `subject` or `defines`.
- Every ref must be an entity in the package.

<!-- check:entity-categories -->
Categories for entity scope: `identity`, `appearance`, `personality`, `speech`, `behavior`,
`backstory`, `psychology`, `relationship`, `secret`, `goal`, `skill`, `ability`, `equipment`,
`belief`, `habit`, `profile`, `other`.
<!-- /check -->

<!-- check:world-categories -->
Categories for world scope: `background`, `rule`, `event`, `item`, `direction`, `reference`, `other`.
<!-- /check -->

With `scope: "other"` the category is `other`.

`direction` is how to narrate (a framework's rules); `reference` is specialised knowledge to draw on.

### Category vs `displayPath`

- **`category`** is for the machine, and there are deliberately few. Nexus uses it to organise and
  to reason about entries.
- **`displayPath`** is for people. It is a list of one to eight group names, each 1–80 characters,
  in the universe's own words: `["Quirk", "Fluid Domain"]`, `["Magic", "Wards"]`, `["Cybernetics"]`.

A universe's words are never categories: `"category": "quirk"` is refused. Write
`"category": "ability"` with `"displayPath": ["Quirk", "Fluid Domain"]`.

`displayPath` is presentation only. It never changes activation, retrieval, ownership or
prompt order.

## 9. `stories`

| Field | Required | Meaning |
|---|---|---|
| `ref` | yes | |
| `title` | yes | |
| `persona` | no | A persona ref: who you play. |
| `cast` | yes | Characters in the story. Exactly one has `"role": "lead"`; the others `"cast"`. |
| `sources` | yes | Attached sources: `{ "source": ref, "recursion": null or "block" }`. |
| `exclusions` | no | Entries of attached sources this story does not use: `{ "source": ref, "entry": ref }`. |
| `npcs` | no | People without a card in the cast: `{ "source", "entry", "role", "entity"? }`, role `main`, `supporting` or `background`. `entity` names who they are; `source`/`entry` is the entry that introduced them. A reader that knows entities casts the entity; an older reader resolves the entry. |
| `directions` | no | The story's own instructions. |
| `premise` | no | What the story is about. |

**Cast.** `{ "character": ref, "role": "lead" | "cast", "entity"?: ref }`. `entity` states which
person the card plays in this story. Give it only when the character has no `entity` of its own;
it may not contradict one.

**Recursion.** `"block"` means entries of that source activate only directly in this story, never
through other entries. `null` uses the source's own `settings.recursive`.

A story's own material (a source with `"story"`) must be listed in that story's `sources`.

## 10. Importing

**Validation first.** An invalid package is refused as a whole, with every problem listed (§13).

**Native trust.** A valid package is taken at its word:

- Its semantics, subjects, relations and roles are stored as **approved**, origin `native`.
- Every entity a source mentions is recorded as declared by that source, under the package ref.
- A character or persona created from the package is bound to its own `entity`.
- Nothing is classified, guessed or sent to a model.

**Decisions.** Before importing, Nexus proposes how the package meets your library:

| Thing | Default |
|---|---|
| Entity | **New.** Using an entity you already have is always an explicit choice, and its type must match. |
| Character | **Create a new card**, unless a card with the same name exists, in which case using that card is proposed. In a package with no stories, **no card** is created unless asked for. |
| Persona | Same rule as characters. |

A name match is only a suggestion to confirm. Using an existing card never writes an entity into
that card. The story records which person the card is, for that story only. A card that already
represents a different person cannot be used for this one.

**All or nothing.** The whole import is one transaction: if any decision fails, nothing is written.

**Afterwards.**

- The package id is recorded.
- Importing the same package again warns, then makes new copies.
- A story imported through the app starts with its lead's `openings.first` as the opening message.
- Imported entries also get the legacy kind that older parts of Nexus display, read straight off
  their semantics.

## 11. Exporting

**Only what is decided goes out as decided.** Because an imported package is trusted, export
never turns a guess into an approval:

- Proposed semantics: the entry is exported **without** `semantics`, with a warning.
- Semantics approved and then edited since (needs recheck): the entry is exported **without**
  `semantics`, with a warning.
- Proposed relations are left out, with a warning.

In every case the entry itself (title, content, activation, enabled state and source membership) is
exported in full. Only the organisation that was not confirmed is left off.

**Roles.** A source with no approved role cannot be exported yet; v1 requires a role, and export
will not invent one. A story's own material exports only with its story.

**Canonical form.** Export writes every default out, keys in a fixed order, unordered lists sorted.
The same library exports the same bytes, and importing an export then exporting again gives the
identical file.

**When converting to v1 yourself:** if you are not sure what an entry means, **leave `semantics`
out**. The entry still works, since activation is enough, and it will show as unorganised so it can be
organised later. Writing a guess into `semantics` makes it an approved fact on import.

## 12. `extensions`

`extensions` is an object for data from other tools. It is allowed on the **root**, on
**`package`**, on **characters**, on **sources** and on **entries**, and nowhere else. Nexus keeps it
and writes it back on export. **Nexus never interprets it.** Anything inside `extensions` has no
effect, including anything that looks like a visibility or permission setting.

## 13. Errors

Nexus refuses an invalid package whole and lists every problem as `{ path, message }`. For
example, this entry says it is private:

<!-- check:error-example -->
```json
{
  "format": "nexus-package",
  "version": 1,
  "package": { "id": "example.error", "title": "Error example", "role": "entity-material" },
  "entities": [{ "ref": "reiko", "type": "person", "name": "Reiko" }],
  "sources": [{
    "ref": "reiko-knowledge", "name": "Reiko", "role": "entity-material", "subject": "reiko",
    "entries": [{
      "ref": "secret-history", "content": "Only Reiko knows this.", "visibility": "private",
      "activation": { "policy": "keywords", "keys": ["past"] },
      "semantics": { "scope": "entity", "category": "backstory", "subject": "reiko" }
    }]
  }]
}
```

```text
sources[0].entries[0].visibility: Knowledge visibility is reserved for a later package version. Nexus does not enforce who knows what yet, so v1 does not accept it.
```
<!-- /check -->

Through the app, `POST /api/packages/import` answers `400` with
`{ "error": "...", "errors": [ { "path", "message" } ] }`.

## 14. Not in v1

These are deliberately unsupported. A package cannot express them, and the validator refuses the
ones that look like fields:

- **Knowledge visibility.** `visibility`, `knownBy`, `knowers`, `hiddenFrom` and `private` are
  refused. *True about Reiko* is not the same as *known by Patrick*, but Nexus does not enforce
  that distinction yet. Accepting it would promise a privacy the prompt does not keep. Keep
  secrets as separate entries so they can be filtered once it exists.
- **`"auto"` activation.**
- **Proposed or unconfirmed semantics.** Everything in `semantics` is authoritative. Leave it out
  instead (§11).
- **Entity merges and "not the same" decisions.**
- **Avatars and images.**
- **Message history, memory and story state.** A story package is a beginning, not a transcript.
- **Generation presets, models and sampler settings.**
- **Worlds from the app's "World" screen** (campaign frameworks) as their own object.
- **`extensions` on entities, personas, stories and cast rows.**

## 15. Converting old files

### A character card (CharaCard V2/V3)

| Card field (`data.…`) | Package |
|---|---|
| `name` | `characters[].name`, plus a `person` entity |
| `nickname` | `nickname` |
| `description` | `core.identity` (move appearance to `core.appearance` if it is clearly separable) |
| `personality` | `core.personality` |
| `scenario` | `openings.scenario` |
| `first_mes` | `openings.first` |
| `alternate_greetings` | `openings.alternates` |
| `mes_example` | `core.speechExamples` |
| `system_prompt` | `core.systemInstructions` |
| `post_history_instructions` | `core.postHistoryInstructions` |
| `extensions.depth_prompt` | `core.depthPrompt` |
| `creator_notes` | `creatorNotes` |
| `tags` | `tags` |
| `character_book` | a source with role `entity-material` and `subject` = the character's entity |

Keep Core short. Backstory, psychology, relationships, skills, powers and secrets that were packed
into `description` are better as entries in the Knowledge source, each with its own keywords.

### A SillyTavern lorebook (World Info)

| Lorebook entry | Package entry |
|---|---|
| `comment` | `title` |
| `content` | `content` |
| `key` | `activation.keys` |
| `keysecondary` | `activation.secondaryKeys` |
| `constant: true` | `activation.policy: "always"` |
| otherwise, with keys | `activation.policy: "keywords"` |
| `disable: true` | `enabled: false` |
| `selective`, `selectiveLogic`, `order`, `position`, `depth`, `role`, `probability`, `useProbability`, `scanDepth`, `caseSensitive`, `matchWholeWords`, `excludeRecursion`, `preventRecursion`, `delayUntilRecursion`, `group`, `groupOverride`, `groupWeight`, `useGroupScoring`, `sticky`, `cooldown`, `delay`, `vectorized` | the activation field of the same name |

If an entry uses settings beyond keywords (probability, groups, timing, position), use
`"policy": "advanced"` and copy them.

### Checklist

1. `format`, `version`, `package.id`, `package.title`, `package.role`.
2. One entity per person, place or faction that knowledge is about.
3. Characters and personas with compact Core, each pointing at its entity.
4. Knowledge as entries, keyword-activated, in a source whose `subject` is the entity it travels with.
5. `semantics` only where you are sure; `displayPath` for the universe's own groups.
6. Stories: exactly one lead, the persona, attached sources, and story-only material with `story`.
7. Validate. Nexus lists every problem before anything is written.
