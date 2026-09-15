# Nexus — handover

Written 15 September 2026, for an agent with this repository and none of the
conversation that produced it. Everything below was verified against the code
and the live database on that date. Verify again before you rely on it.

**Updated later the same day** after §17 Story Composition Review was built on
branch `feature/story-composition-review` (not merged to `main`). Sections 2,
8–11, 14, 16 and 17 describe that branch. Section 19 is the short version.

---

## 1. What this is for

A personal, phone-first roleplay writing app for one person. One user, one
laptop, her own data. Node 24, `node:sqlite`, no dependencies, no build step —
that is a choice, so the app still runs in five years without a toolchain
rotting under it. Do not add a framework.

The guiding line: **simple on the surface because the complicated intelligence
is underneath.** She should be able to build a deep world without ever learning
what a lorebook, a recursion budget or a prompt cache is.

**The playable root is a STORY, not a Character.** Chatting with one person is
simply the smallest possible story. There must never be two architectures, one
for "simple chat" and one for "advanced story."

Where this is going: as easy to start as Tipsy, AI-assisted story creation like
FictionLab, and SillyTavern's depth of world and context underneath.

---

## 2. What actually exists

Everything in this section is implemented and working. Nothing here is a plan.

**Story and cast.** `stories` (with `persona_id`, `head_id`, `settings` JSON,
`framework_id`, `scenario_id`). `story_characters(story_id, character_id, role)`
where role is `lead`, `cast`, or (from a reviewed composition) `main` /
`supporting` / `background`; the read query is
`ORDER BY (sc.role = 'lead') DESC, c.name COLLATE NOCASE`, so the lead is
explicitly first and `characters[0]` in the prompt builder is the lead by
construction. One lead is enforced by `setStoryCharacterRole` (naming a new lead
demotes the old), by `setStoryCharacters` (keeps the existing lead) and by
composition apply (refuses two). Nothing reads `main`/`supporting`/`background`
for prompt weighting.

**Lore.** `lorebooks` and `lore_entries`, faithful to the SillyTavern model:
keys, secondary keys, selective logic, `constant`, ord, position, depth,
probability, groups, sticky, cooldown, delay, regex, recursion flags. Entries
also carry `kind` (character, place, faction, premise, rule, direction, event,
item, note), `summary`, `image`, `playable`, `traits`. `kind` is populated —
about 1,100 typed entries in her library.

`story_lorebooks(story_id, lorebook_id, recursion)` — see §6.

**Activation.** `src/engine/lorebook.js`. Keyword matching over a scan window,
recursion with a separate 25% allowance, key-specificity measured inside each
book, budget, author priority, timers. Do not replace it.

**Prompt.** `src/engine/prompt.js`. The order is not cosmetic: providers bill
the unchanged prefix at about a tenth, so everything stable is at the front and
never moves, and everything per-turn goes after the conversation. Breaking that
is the difference between a few dollars a month and a few hundred.

**Memory.** `src/memory/` — sequential extraction per exchange, state folded
from deltas along the message path (which is what makes branching free),
episodes, snapshots, overrides, threads, secrets gating, the slow-burn ladder
in `arc.js`, and `reconcile.js` for current-scene reconciliation.

**Import.** `src/import/` — character cards V1/V2/V3/Pygmalion, lorebooks,
SillyTavern presets, script presets, chat exports. Plus a semantic classifier
(`semantics.js`) that decides what a file is FOR, and `plan.js` which turns
that into resources. `imports`, `import_resources`, `characters.import_id`,
`lorebooks.import_id`, `lorebooks.from_character`, `resource_lorebooks`.

**Frameworks and scenarios.** `frameworks`, `scenarios`, `starting_points`.
Frameworks reach the prompt (world, narrator rules, ensemble examples, closing
instructions); their lore is read live rather than copied.

**Composition.** `story_npcs`, `entry_character_links`, `entry_entry_links`,
`story_entry_exclusions`, `src/import/compose.js` (the analyser, pure),
`src/import/compose-apply.js` (plan, atomic apply, removal), the Review UI in
`public/app.js` (`beginReview` and the functions after it). See §8.

---

## 3. Decisions that cost real work to reach

**Provenance ≠ semantic relation ≠ story membership.** Three independent axes.
`lorebooks.from_character` says which file a book arrived in. It does NOT say
what its entries are about: in her Patrick package, 143 of 256 entries never
mention Patrick at all. Do not populate semantic links from provenance. This
mistake was proposed once and caught by measurement.

**Connected ≠ active ≠ included.** Attaching fifty entries to a story does not
mean fifty entries are sent. Connection is eligibility; the activation engine
decides inclusion; the budget decides survival. Never label something
"included" because it fired.

**The story is the composition root.** Characters, lorebooks, frameworks and
scenarios are reusable resources; a story composes them.

**A lorebook is becoming a "Source Package" to the user.** The engine underneath
is unchanged and must stay reachable.

**Story-specific configuration belongs on the relationship**, not on the shared
resource. The same book may behave differently in two stories.

**Never flatten conditional lore into a character description.** It would be
sent every message and would lose its activation behaviour.

---

## 4. The Saint — the reference story

**There are three stories whose title matches "Saint". Only one is real.**

| id | messages | what it is |
| --- | --- | --- |
| `83d52b5a` | **255** | **the real one** |
| `ea7a4db3` | 1 | made during a screen recording |
| `471bdf0c` | 1 | made during a screen recording |

The two one-message stories have `f12d142b` as lead and the **198-entry**
package attached with default recursion. They are demonstrations of a UX
failure, not decisions. Do not treat them as canonical, and do not let the
198-entry package become a canonical world source because they exist.

Verified state of `83d52b5a` on 15 Sep 2026:

```
persona   Reiko
lead      Patrick Moretti [8a2be6d9]
messages  255
scene     Patrick's penthouse, the kitchen · Weeks later, early morning
lore      Phase Engine Lore (32)          recursion = block
          The Saint / Embedded Lore (23)  recursion = block
npcs      0
```

Not connected, deliberately: **First Meeting World Info (24)** — mostly exact
copies of the 32-entry book — and **Phase Engine Lore (198)**, which is 112
writing directions rather than a world.

Observed lore behaviour at last check: 50 eligible, 14 included, 816
conditional tokens, 0 recursive activations. These are observations of one
scene and will move as the story moves.

**The lead was chosen on provenance, not on names.** The story's first
canonical message is byte-identical to `8a2be6d9.first_mes`. The other three
Patrick cards do not match, in their greeting or their alternates.

**Do not replace the lead with `f12d142b`.** It is a newer card she wrote
herself after the 255 messages existed. Its identity and personality sections
are genuinely expanded (58% and 38% overlap, two and four times the text) but
its scenario, examples, greeting and closing instructions share barely 10% with
what that story has been reading. Mining it for improvements later is fine;
swapping it in mid-story is not.

---

## 5. Memory, already repaired

A stale scene said "bathroom, in the bathtub" for 226 messages. Diagnosed and
fixed; the derived layer was rebuilt once from the canonical messages. Along
the way:

- **The persona was linked** to the 255-message story. Historical records still
  say `user`; nothing was rewritten. `renderState` and `stateSummaryForUi` take
  a `playerName` and resolve generic ids at read time.
- **Thread lifecycle is normalised** to `open` / `resolved` / `retired`. The
  model's own wording is kept in `note`. `isOpen()` reads through legacy
  free-text statuses so old rows count correctly without being rewritten.
- **Thread identity no longer includes message depth.** That one bug turned one
  question into eight rows. Identity is now content-word overlap plus the same
  debtor; resolved threads do not reopen when mentioned.
- **Current Scene Reconciliation** (`src/memory/reconcile.js`) reads the last
  ~8 messages together, because an exchange-by-exchange extractor cannot see a
  move nobody narrated. It declines rather than guesses.
- **Re-read current scene**: `POST /api/stories/:id/scene/reread`, one call, not
  a rebuild. Stored as a normal manual correction.
- **Background model**: `deepseek-v4-flash` on OpenRouter, with the measured
  preferred/blocked provider lists in `extract.js`. Local Ollama was
  benchmarked (`npm run bg:check`): qwen3:8b scored 7/12 and llama3.1:8b 6/12
  against deepseek's 12/12, and both failed the location-change case — the
  exact bug just fixed. A full 128-exchange rebuild costs about $0.065.

Do not redesign any of this without a demonstrated new bug. Two agents in a row
reasoned their way to the wrong component here; measurement settled it both
times.

---

## 6. Book-level recursion

`lorebooks.recursive` exists, is written on import from the file's
`recursive_scanning` field, and **is never read at runtime. Leave it that way.**
Fifteen of her twenty-two books carry `0`; honouring it now would silently
change retrieval for two stories she never asked about.

The override lives on the relationship:

```
story_lorebooks.recursion   NULL (default) | 'block'
```

`block` means, for this story only: entries from that book cannot be surfaced
by recursion, and their text cannot feed it. Direct, recent-window and
always-on activation are unaffected. It is the story-level equivalent of
`excludeRecursion` + `preventRecursion` without touching either entry flag.
Entry flags still apply normally. NULL preserves behaviour exactly.

Why it was needed: her Patrick books are written as dense cross-referenced
graphs. With recursion on, 72–89% of the book fired in every scene type,
identically, with 16–18 entries arriving purely on hearsay. With `block`, the
same five scenes fired 16–21 entries and the selection visibly changed with the
scene.

---

## 7. Story-first UX — what is built

Implemented and browser-validated:

- **Navigation**: `Stories · Library · Create · Settings`. Lore is no longer a
  destination; its books live in the Library as a **Sources** shelf and its
  editor is reached from inside one. No routes were deleted.
- **Library**: one surface, four shelves (People, Scenarios, Worlds, Sources),
  shared search, tag chips and sorting.
- **Create**: a sheet with four ways in — a story, from a file, from a link,
  write a character.
- **Story Bible**: read-only, `GET /api/stories/:id/bible`. Who is in it, its
  world by section, where its material came from (connected vs related but
  unused), where the story is now, and what it can see. Sections start folded.
  Composes existing data; stores nothing.

**Unfinished:** Home is still the old story list, not a visual grid — there is
no `stories.cover` and none of her stories have art, so a grid would be a grid
of initials.

---

## 8. Story Composition — built

**Source Package → Composition Draft → Review → Apply.** All four exist.

- `composeSource(entries, ctx)` in `src/import/compose.js` reads books into a
  draft. Pure, writes nothing, `invented: 0`.
- `POST /api/compose` `{lorebookIds, characterIds?, premise?, storyId?}` returns
  the draft. Without `storyId` it is a new-story draft.
- `POST /api/stories` with `composition: {casting, links, recursion, exclude,
  include}` creates the story, card parts, sources, reviewed cast, exclusions,
  links and greeting **in one transaction**.
- `POST /api/stories/:id/compose` applies a reviewed draft to an existing story,
  one transaction. Cards already in the story are never recast here.
- `GET` / `DELETE /api/stories/:id/sources/:bookId` — removal preview / removal.
- Every write is re-validated server-side in `planComposition`: only people can
  be cast, a lore-backed person cannot lead, at most one lead, everything must
  come from a book the story reads.

**UI.** Create: *What it is → Who leads → Sources → Review story → Start*.
Existing story (story settings → This story): *Review cast and material* reopens
the review over its current books; *+ Add a source* reviews additions; *Remove*
shows what the story loses first. Saving the story sheet no longer touches
sources. Review root: You (persona) · Sources · Casting · Locations · Factions ·
Background & Premise · Rules · Directions · Events · Items · Other. Opening an
entry fetches the live entry with its engine settings; nothing is copied.

**Persona in creation.** Optional, visible on Review, defaults to nobody. An
explicit `personaId: null` is respected; only a caller that omits the key gets
the old "exactly one persona" default.

**Removing a source** deletes the story's `story_lorebooks` row (and its
recursion setting), the `story_npcs` rows standing on that book's entries, and
the story's exclusions of that book's entries. It keeps the book, entries,
cards, messages and all semantic links. Limitation: there is no lineage to tell
a manually added cast row from a reviewed one; all current rows come from review.

**Fixed along the way.** `db.setStoryLorebooks` and `db.setStoryCharacters`
used to delete and re-insert every row: saving the story sheet wiped per-story
recursion (`block` on The Saint would have been lost) and could hand the lead
to whichever card came first. Both now write only the difference.

---

## 9. Analyser semantics

**A person** (`personFromEntry`) must be typed `character`, have a name for a
title — aliases after `:` ` / ` ` — ` `(` stripped — and be what its text is
about: the name opens the content or leads the keys. Rejected, and left in their
sections: headings about someone ("Abandonment Wound"), families, places, events,
`WORLD —` / `CORE —` / `Event:` labels, the user persona, and mis-titled
entries (real MHA packages have "Mitsuki Bakugo" holding Katsuki's profile —
those go to Other with a note). Duplicate entries for one person become one row
with several `entryIds`.

**Links** (`entry_character_links` to a card, `entry_entry_links` to a
lore-backed person): high = name in title or first sentence, medium = in keys,
low = only near the start. Low is shown unticked. Rules/directions/notes never
get low links. People are not linked to each other. Never from provenance.
Links describe material, not a story, so they are global.

**Correction to the original §9:** "Don Raffaele Costa named 70 times" was the old
first-word, case-insensitive count matching **don't**. He is named 0 times in
The Saint. Real counts: Salvatore 107, Carlo 14, Marco 4.

**Patrick, Phase Engine Lore (32), new story with lead 8a2be6d9:** Carlo Vancetti
Supporting (Patrick's card names him; 4 other entries), Marco Supporting (in the
opening; card names him), Salvatore Known, Don Raffaele Costa Known. Locations 5,
Factions 2, Background & Premise 10, Rules 1, Directions 8, Items 1, Other 1.
As the existing Saint: Salvatore and Carlo Main, Marco Background, Costa Known.

---

## 10. New stories versus existing ones

Evidence for a new story comes from the source: named in the opening or premise
(+2), the lead's card names them (+2), their entry names the lead (+1), always-on
(+2), referenced by other entries (+1 at 2, +2 at 4), a library card with that
name (+1), unusually long entry (+1). Existing stories add conversation mentions
(+1 / +2 at 5 / +4 at 40). Score ≥6 Main, ≥4 Supporting, ≥2 Background, else
**Known** — conservative on purpose. Shared first names or surnames (a family)
are not counted as anyone. Someone already cast through another source's entry
is suggested Known with that reason, so a second package cannot double-cast them.

**MHA validation** (My Hero Academia World, 172 entries, Bakugo lead de8ed7a7):
105 people; all 19 Class 1-A students in Casting; nobody suggested Main
(Izuku Supporting, 10 Background, 93 Known). Reviewed cast of 12 persisted, no
cards created. Adding MHA RP Optimized (142) to that story kept lead, cast and
each book's recursion choice.

---

## 11. Cast model and exclusions

Draft states: **Lead · Main · Supporting · Background · Known / Available ·
Excluded** (`out` from old drafts = Excluded).

| State | Stored as | Eligible for the prompt |
| --- | --- | --- |
| Lead | `story_characters.role = 'lead'` (card only) | yes |
| Main / Supporting / Background | card: `story_characters.role`; lore person: `story_npcs.role` | yes |
| Known / Available | nothing | yes, activates normally |
| Excluded | `story_entry_exclusions(story_id, entry_id)` | **no**, in this story only |

`story_entry_exclusions` is generic: any entry kind can be excluded
(`composition.exclude` / `include`), not only people. Excluding a person
excludes every entry of that person (`entryIds`) and removes their cast row.
The entry stays enabled in its source; other stories are unaffected.

**Filtering point:** `db.entriesForStory` (SQL `NOT IN` the story's exclusions)
and the framework merge in `assemble()` in `server.js`, i.e. before
`activate()`. An excluded entry cannot fire, be recursed into, or feed recursion,
and does not appear in `/api/stories/:id/prompt` trace or messages.

**Limitation, deliberately:** exclusion removes the excluded entries, not the
entity. Other entries that mention the person (The Black Lotus mentions
Salvatore) still activate, and the model may still use the name from them, from
chat history, or from memory. Links are not used to suppress related material:
coverage is partial, global and review-approved only, so they cannot promise
entity-wide exclusion.

Cast role and context depth are different concepts. **Roles do not change prompt
weighting yet** — that changes how established stories compile and must be
tested on a new story first. Never auto-create a global card for a lore-backed
person; promotion should use `characters.from_entry` (column not yet added).

---

## 12. Library and lore direction

One library. A lorebook is presented as a **Source Package** with its contents
summarised by type. Opening one still exposes every engine capability —
keywords, triggers, constant, recursion, probability, groups, priority,
provenance, enabled state. None of it may be removed; it moves closer to where
the information makes sense.

---

## 13. Create direction

Four entry points, all converging on the same Composition Draft: start with an
idea · import a file · add from Library · build manually.

AI generation is **not** the next task. When it comes, three behaviours:
**Organize Only** (invent nothing), **Fill the Gaps**, **Build It Out**. All
three produce a draft that must be reviewed before anything becomes canon.

---

## 14. Legacy migration — done

`scripts/migrate-legacy-people.js` (dry run by default, `--apply` to write, one
transaction, idempotent). Applied to the real database on 15 Sep 2026 after a
backup: `C:\Users\gabri\tipsy-backups\tipsy-20260915-052900-before-legacy-people.db`.

It moved only high-confidence Scenario/World cards used by no story, merged exact
duplicates by SHA-256 of the stored file, re-attached the existing embedded book
(detaching `from_character` first — that FK is `ON DELETE CASCADE`), kept
pictures, and invented no import provenance.

- Scenarios (4): Actuate MHA classroom (×2 merged), MHA || SLEEPOVER (×3),
  MHA || Sticky Situations, MHA || Class With The Bakusquad.
- World (1): MHA RPG Bot # Infinity (×2 merged); one identical, unused 21-entry
  book copy removed; 1,108 → 1,087 entries.
- People now (9): Katsuki Bakugo ×3, Patrick Moretti ×2, Patrick Moretti 'The
  Saint', Patrick Moretti — First Meeting, [🅰️] Kirishima, Midnight Munchies.
- Left for manual review: Kirishima (medium World), the 67k-greeting Bakugo (low),
  Midnight Munchies (medium Scenario). Second run: nothing to move.

---

## 15. Do not touch without evidence

Prose prompts · the roleplay model · the background model · slow burn ·
secrets · the memory engine · story state · the thread engine · lore ranking ·
the recursion budget · The Saint's canonical messages.

Each of these was diagnosed at length, and several were changed only after a
measurement contradicted the obvious explanation. If something looks wrong,
measure it before changing it, and check your test before blaming the app —
that error was made repeatedly and cost real time.

---

## 16. Tests

`npm run` scripts:

```
import:check  semantics:check  library:check  plan:check  context:check
threads:check bg:check         reconcile:check recursion:check compose:check
```

Plus `scripts/smoke.js <port>`, `scripts/check-scene-state.js`,
`scripts/replay-state.js`, `scripts/check-legacy-threads.js`.

Last passing on the feature branch: compose 138 · smoke 92 · context 64 ·
semantics 61 · library 58 · plan 57 · threads 19 · reconcile 16 · recursion 13 ·
import 19 files, 0 failed. `bg:check` and `check-scene-state` call live models
and were not re-run.

`compose:check` needs no setup: it builds its own throwaway database and server,
and checks the compiled request through `/api/stories/:id/prompt`.

`library:check`, `context:check` and `smoke.js` need a throwaway server:
`PORT=8xxx DB_PATH=<temp> node server.js`. Never point a test at
`data/tipsy.db`. For real-data checks, snapshot it (`VACUUM INTO`) and, since
it is password-locked, remove the `auth` setting **in the copy only**.

---

## 17. Next task

§17 Story Composition Review is implemented on `feature/story-composition-review`
and validated on real data (disposable stories on snapshots) and in headless
Chrome at 390px and 320px. It still needs **her own visual approval on the
phone** before merging to `main`.

Intentionally NOT implemented:

- AI Story Builder (Build It Out / Fill the Gaps / freeform generation)
- context-depth weighting from cast roles
- NPC promotion to a card (`characters.from_entry`)
- Home redesign / story covers
- a UI to exclude non-person material (the API supports it)

---

## 18. What she is actually asking for

When she adds a JSON or a source package, the feeling should be:

> "Nexus understood my story."

Not:

> "Nexus attached a database file."

The source should visibly unfold into casting, locations, factions, backstory,
rules, directions, events, items and the rest — while every piece of activation
metadata stays exactly as it was underneath.

---

## 19. Where things stand (short)

- Branch `feature/story-composition-review`; `git log main..HEAD` lists its commits.
  Not merged. `backup/pre-email-rewrite` is a private local branch — never push it.
- Commits use the GitHub noreply address, configured for this repository only.
- The Saint (`83d52b5a`) is unchanged by all of this: no cast from sources, no
  exclusions, both books still `block`, 255 messages.
- The running server must be restarted to pick up new code; `start.bat` does it.
- The real database gains the empty `story_entry_exclusions` table the first time
  this branch's server starts (schema.sql runs `CREATE TABLE IF NOT EXISTS`).

---

## NEXT AGENT INSTRUCTIONS

1. Read this file.
2. Inspect the repository.
3. Verify anything material against the code and the database before changing
   it. This document was accurate on 15 September 2026 and no later.
4. Do not repeat completed audits unless evidence contradicts what is here.
5. Continue from §17.
6. Preserve The Saint (`83d52b5a`, 255 messages). The other two "Saint" stories
   are recording artefacts.
7. Back up `data/tipsy.db` before any migration that touches real data. Backups
   live in `C:\Users\gabri\tipsy-backups\`.

Two more things worth saying plainly. Her OpenRouter key is in `.env` and must
never be printed. `samples/` holds her own files and is gitignored — it is not
test data, and it never leaves the machine.
