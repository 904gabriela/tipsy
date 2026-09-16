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

## 20. Story Builder (branch `feature/ai-story-builder`)

**Depends on `feature/story-composition-review`** (branched from it; merge that
first). Engine, contract and a first UI. Not merged; awaiting her visual approval.

**One draft, one Review.** `src/builder/contract.js` documents the Story
Composition Draft v1: composeSource's draft plus `story {title, premise, opening}`,
`origin` on every person/item/link (`source` · `generated` · `inferred` ·
`manual`), `reused[]`, `generation`, `invented`. Every UI path now gets its draft
from `POST /api/builder/draft` — imports and additions with `mode: organize`, an
idea with `mode: build` — and opens the same Review (`openReview` in
`public/app.js`), which Starts or Applies through the same routes.

**Modes** (`src/builder/index.js`, model injected, no DB access): organize =
composer only, never calls a model · fill = `gapsOf()` decides what is asked
for · build = idea → the whole story around any canon. `regenerate()` scopes:
`{part}`, `{item}` (generated only), `{expand}` (adds, never rewrites). Asking
for a whole part again replaces only *unedited* suggestions; asking for one
item replaces it. Source and manual material is never replaced.
`POST /api/builder/fill` fills the gaps of a draft already in review.

**Prompt** `src/builder/prompt.js` — its own; the roleplay prompt never sees it.

**Validation.** Contract breaches refuse the whole reply (not JSON, unknown
section/role, bad or duplicate ids, two leads, a lead when one exists);
overreach is trimmed with warnings (depth counts, lengths, unknown refs,
not-asked-for parts). **Reuse rule:** a proposal is an existing thing only if it
says so by reference (`same: "S4"`, and the ref is the same kind) or has the
same kind AND the same normalised name. A person "Black Lotus" is never merged
into a place "Black Lotus"; a mismatched reference stays a reviewable proposal.

**Promotion rule.** The model can never make a character card. A model-authored
`promote` is ignored and reported; `promotionSuggested` is advice shown in
Review. The server clears `promote` on every draft it returns, and
`acceptedFromDraft` never reads it from a draft. Only the person's switch
("Make this a full character", OFF by default) sends `promote: true` for a
generated lead, which creates exactly one card. Without it Start is blocked and
says why. Generated non-leads are lore-backed people, never cards.

**One package per story.** Accepted generated or hand-written material goes
into the story's single Story Builder book, marked
`lorebooks.original = {"generatedFor": storyId}` (`storyPackage()` in
`src/builder/apply.js`). Created once, appended to afterwards, reconnected if it
was removed from the story. An entry with the same kind and name as one already
in it is skipped, never overwritten. Each generation still gets its own
`imports` record (`source='builder'`) listing the package in `import_resources`;
entries keep `lore_entries.original = {origin, draftId, edited, builder}`.
Library rows carry `generated_for`; the Story Bible and story sheet show it as
"Nexus Story Builder · Made for this story", never as import internals.

**UI (first version).** Create → **Start with an idea**: one idea field; tone,
point of view, depth (Light/Standard/Deep) folded away; optional characters and
sources to build around. Building shows plain progress words; failure or
timeout keeps the idea with **Try again**. Review adds Story (title, premise)
and Opening (edit, remove, suggest another; written only at Start). Suggestions
say "Suggested by Nexus" (· edited) and have Edit / Remove / move-to-section;
source entries keep the read-only engine view. "Suggest … again" per section,
for people and for one item (inside its editor). "Help me fill the gaps" sits on
the Review root. No technical vocabulary in the flow.

**Tests.** `npm run builder:check` — 145 deterministic checks with a mocked
model and a fake provider (promotion, type-safe reuse, one package, repeated
apply, edit provenance, removal, fill over a reviewed draft, one review
contract, opening once, rollback). Headless Chrome with a fake provider at 390px
(library lead, forced failure → Try again) and 320px (generated lead, explicit
promotion) passed; so did the §17 composition regression. One live UI run
(synthetic idea, light depth, grok-4.20): Review in 15.6s, nothing written.

**Not built:** AI classification of ambiguous source material, UI to exclude
non-person material, depth weighting, NPC promotion outside a lead, covers and
images, per-item "expand" in the UI (engine supports it).

---

## 21. Pending visual/product decisions

Open questions, deliberately **not decided**. The Story Builder branch is a test
candidate awaiting her manual review on the phone. Do not resolve these, and do
not add Builder functionality, until she has looked at the product herself.

1. **Package label.** Story-specific generated and hand-written material share
   one stable package per story. It is shown as "Nexus Story Builder · Made for
   this story". Consider whether the user-facing label should be broader,
   because accepted hand-written material may live there too.

2. **Generated lead and promotion.** A generated lead currently blocks Start
   until the person turns on "Make this a full character". Evaluate whether this
   is intuitive, or whether accepting a generated lead should make promotion
   feel automatic and non-technical while still requiring explicit approval.

3. **Control density in Review.** Review can now show many Edit / Remove /
   Suggest again controls. Real mobile visual approval is needed before adding
   more controls or functionality.

---

## 22. Preset ownership (branch `fix/preset-directions-safety`)

A safety patch, not the Preset redesign. Applying a preset used to overwrite a
story's `settings.directions` (the built-ins all carried `directions`; one real
story has 34,671 characters of them).

- **Preset owns** model, samplers, context settings, script/dials/bundle, and
  `presetInstructions` (its writing style). **Story owns** `directions`.
- Every apply goes through `POST /api/stories/:id/use-preset` (`applyPreset` in
  server.js), for saved and built-in presets; the Writing preset panel no longer
  merges `p.settings` in the browser.
- Apply never touches `directions`, and always sets `presetInstructions`
  (cleared when the new preset has none). Presets saved before the split keep
  their stored `directions`; applying reads it as `presetInstructions`.
- Saving a preset from a story captures `presetInstructions`, never `directions`.
- Prompt: `# Writing style` sits immediately before `# How this story is
  written`, **only when no script** is active.
- Tests: `scripts/check-preset-safety.js` (A–G), The Saint byte-identical on a
  snapshot, headless panel check at 390/320.

**Known issues — recorded, deliberately not fixed:**
1. A script preset and story directions are both injected (the comment in
   prompt.js says the script replaces directions; it does not).
2. With a script, AT_DEPTH and author's-note lore can appear twice alongside
   `{{lorebook}}`.
3. WHERE THINGS STAND is `unshift`ed to the start of the volatile block; the
   comment says it goes last.
4. The prompt trace attributes lore only — no "What Nexus sees" per layer.
5. Impersonate/continue do not pass topK, minP, topA, repetitionPenalty.
6. Switching presets still leaves other stale keys (e.g. a previous script).
   Only `presetInstructions` is guaranteed not to leak.
7. Framework migration candidates, not migrated: MLRPE 23.0; the Standard
   Chungus "Direction" item; continuity sections of Direct API Preset,
   Storytelling Immersion RP and Ye; the continuity rules in Bakugo's directions.

Target model for the redesign: Generation Preset (one per story) · Story
Directions · Narrative Frameworks · Reference Packs · Lore/Memory/State — kept
as separate layers.

---

## 23. Semantic model and Nexus Package v1 (branch `feature/semantic-model`)

Not merged, not in production. `data/tipsy.db` has none of this schema.

**P1 — semantic core** (`src/semantics/`). The entity is the person, owned by
no source and no card (`lore_entities`). Sources declare entities
(`source_entities`); entries say what they are (`entry_semantics`: scope,
singular category, `defines`) and who they are about (`entry_relations`:
one approved subject, any related). Precedence for organising: approved >
approved-but-changed (NEEDS RECHECK, still used) > proposed > legacy `kind` >
old links (evidence only, `legacy_entry_links`, no FKs). Activation and prompt
compilation never read semantics. The 136 old links were copied as evidence,
never approved.

**Deep characters and personas (approved architecture).**
- Core lives on the resource: card columns plus nullable `appearance`,
  `behavior`, `speech_style`; personas `description` plus `personality`,
  `appearance`, `behavior`, `speech_style`. Kept compact on purpose.
- Knowledge is entries with semantics (`subject → person`), conditional as
  their activation says. Visible under a person ≠ sent to the model.
- `characters.entity_id` / `personas.entity_id`: which person a resource is.
  Never guessed; native packages bind their own; legacy gets proposals (P3).
- `source_semantics.subject_entity_id`: reusable material that travels with a
  person. Does not make every entry about them.
- `source_semantics.owner_story_id`: Story Material, that story only.
  (Builder packages still use `lorebooks.original.generatedFor`; export reads both.)
- `entry_semantics.display_path`: the person's own groups, e.g.
  `["Quirk","Fluid Domain"]` with category `ability`. Presentation only.
- Knowledge visibility (true about Reiko ≠ known by Patrick) is NOT built.
  Keep knowledge as separate entries so it can be filtered later
  (`entry_semantics.visibility`, `entry_knowers` — future).

**P2 — Nexus Package v1** (`src/package/`): format and validator (`format.js`),
trusted import (`import.js`), export (`export.js`). Routes: `POST /api/packages/inspect`,
`POST /api/packages/import`, `GET /api/stories/:id/package`, `POST /api/packages/export`.
No UI yet.
- **Contract frozen:** `"format": "nexus-package"`, `"version": 1`. Do not rename.
  The authoritative spec is **`docs/NEXUS_PACKAGE_V1.md`**; the test suite checks
  that it agrees with the validator. Examples: `examples/nexus-package-v1.example.json`
  (Patrick + Reiko + story) and `examples/nexus-package-v1.frameworks-and-reference.example.json`.
- **Roles (frozen):** `entity-material`, `world`, `scenario`, `story-package`,
  `narrative-framework`, `reference-pack`, `mixed`. `entity-material` is
  resource-neutral: reusable knowledge that travels with the source's subject
  entity, shown in context as Character / Persona / Location Knowledge. There is
  no `character-material` or `persona-material`.
- Domains must already be lower-case hyphenated tags, so a round trip cannot change them.
- Core slots reach every prompt path once: the plain cast block, script
  `{{character}}` / `{{persona}}` (all 14 real presets), and the field macros
  (`{{description}}` carries appearance; `{{personality}}` carries behaviour and voice).
- Native semantics import as approved, origin `native`. No classifier, composer,
  builder or model is used (checked statically and with a counting provider).
- Decisions at import: entities default new; a card/persona is created unless
  one with the same name exists (then proposed), and none for source-only packages.
- v1 refuses `visibility`/`knownBy`, `activation.policy: "auto"`, unknown fields,
  and universe words as categories.
- Export includes only approved, current semantics; proposed or NEEDS RECHECK
  entries go out unorganised with a warning. A source with no approved role
  blocks export — legacy stories (The Saint) are not exportable until organised.
- Export never drops the lore itself: an entry whose organisation is left off
  still carries its content, activation and source membership.
- Tests: `scripts/check-package.js` uses both examples (example → export is
  byte-identical to its canonical form; export → import → export is byte-identical).

---

## 24. Legacy semantic conversion, P3 (branch `feature/semantic-model`)

`src/conversion/` turns a legacy source into a **review draft** and stops there.
`analyzeSource(db, lorebookId, { compareWith })`, or `POST /api/lorebooks/:id/semantic-preview`.
There is no apply route, and there is no UI.

- **Read-only, physically:** the analyser switches the connection to
  `PRAGMA query_only` for the whole of its work and back afterwards. Tests
  fingerprint every table before and after.
- **No model, ever:** the module imports no provider and no classifier; a counting
  stand-in provider sees 0 requests.
- **Evidence, not scores:** every proposal carries readable evidence
  (`profile-pattern`, `possessive-title`, `first-sentence-subject`,
  `explicit-name-in-content`, `repeated-name`, `alias-in-keywords`,
  `entity-title-pattern`, `place-language`, `faction-language`, `person-language`,
  `relationship-language`, `instruction-language`, `narration-language`,
  `reference-language`, `category-language`, `source-context`, `legacy-kind`,
  `legacy-link-evidence`, `mentioned-only`, `variant-of-profile`, `no-signal`)
  and a confidence of high, medium or low.
- **Stored `kind` is evidence, never truth,** and is never rewritten. Disagreements
  are reported as warnings.
- **Subject vs related:** a person is a candidate wherever named; a place or group
  only when the title names it. Related needs a reason (title, twice, possessive,
  or relationship language), so a passing mention stays `mentioned-only`.
- **Honest uncertainty:** when two people could be meant, the subject stays null,
  both candidates are listed with their points, and confidence is low.
- **Legacy links** are weak historical evidence worth 0 points; they can never
  create a subject or a high confidence.
- **Variants are grouped, never merged**: same profile, same title, or the same
  keywords plus much of the same wording. Nothing is enabled, disabled, retitled,
  rewritten or chosen as canonical.
- **Cross-source matches** are candidates only; `entity_distinctions` suppresses a
  pair already decided to be different.
- **No real names in the engine.** `scripts/check-conversion.js` fails if a name
  from the real library appears in `src/conversion/`.
- Tests: `npm run conversion:check` (synthetic library, invented names). Real
  sources are only ever read, from snapshots.

---

## 25. Review and Apply, P4 (branch `feature/semantic-model`)

"Understand this source" on a lorebook opens the review: the P3 draft, said in
plain words, with an explicit Save. Nothing is written until you save, and
saving never touches the entries.

- **Screen** (`openSourceReview` in `public/app.js`): what the source is, with a
  role picker; counts; "Accept the clear ones"; then folded sections — **Needs
  your eye** first, then People / Places / Groups, what the source says about
  each person (grouped by display path or category), Directives, Reference, the
  world, variant groups, and possible matches elsewhere. Sections render only
  when opened, so a 197-entry source is not two hundred open cards.
- **Presentation follows the package role, not the scope.** A narrative
  framework's entries are Directives and a reference pack's are Reference,
  though both are `scope: world` underneath. `scope: world` only means "not
  about one particular entity".
- **Plain language throughout**: "About Patrick", "Nexus isn't sure", "Stored in
  the original file as". Evidence and stored activation live behind folds.
- **Apply** (`src/conversion/apply.js`, `POST /api/lorebooks/:id/semantic-apply`):
  one transaction; `status: approved`, `origin: converted`; the P3 evidence is
  stored as the reason. Refuses a stale review (409, listing what changed),
  refuses decisions that do not make sense (400, listing them), and rolls back
  whole. Entries left undecided stay unorganised, so organising can be partial.
  Re-applying the same decisions changes nothing; changing one replaces it
  without leaving duplicates.
- **Entities**: a draft ref that was applied before is recognised by its
  declaration, so entities are reused rather than multiplied. "Same one" reuses
  an existing entity; "Keep separate" writes an `entity_distinctions` row; the
  default is to decide later, which joins nothing.
- Tests: `npm run conversion:check` (74) and `npm run review-apply:check` (45),
  plus a headless pass over the real sources on a snapshot at 390px and 320px.

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
