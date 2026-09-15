# Nexus — handover

Written 15 September 2026, for an agent with this repository and none of the
conversation that produced it. Everything below was verified against the code
and the live database on that date. Verify again before you rely on it.

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
where role is `lead` or `cast`; the read query is
`ORDER BY (sc.role = 'lead') DESC, c.name COLLATE NOCASE`, so the lead is
explicitly first and `characters[0]` in the prompt builder is the lead by
construction. Two leads would fall back to alphabetical silently — no
invariant enforces one lead yet.

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
`src/import/compose.js`, `POST /api/compose`, `POST /api/stories/:id/compose`.
All present and tested. See §8 — the review UI on top of it is NOT built.

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

## 8. Composition backend — built, unfinished on top

The gap a screen recording exposed: adding a source package wrote one row in
`story_lorebooks` and everything inside it stayed invisible. The story said
"world and lore: Phase Engine Lore" and that was all.

Built:

- `src/import/compose.js` — `composeSource(entries, ctx)`, exporting `SECTIONS`
  and `ROLES`. Mode `organize` invents nothing and returns `invented: 0` as a
  checkable promise.
- `POST /api/compose` `{lorebookIds, storyId?, mode, title?}` → a draft.
  **Writes nothing.**
- `POST /api/stories/:id/compose` `{lorebookIds, casting, links, recursion}` →
  applies a reviewed draft. Connects the source, records membership and
  semantic links. **Copies no entry and edits none.**
- `story_npcs(story_id, entry_id, role, ord)` — people with no card.
- `entry_character_links(entry_id, character_id)` and
  `entry_entry_links(entry_id, about_id)` — real foreign keys both sides, one
  table per target kind. No polymorphic ids.

The architecture is: **Source Package → Composition Draft → Review → Apply.**

**The review UI does not exist.** Until it does, the create flow still behaves
the way the recording showed, because the screen is the fix.

---

## 9. What the analyser currently finds

Against the real Phase Engine Lore (32), with the 255-message story as context:

```
27 active entries · 4 people · invented 0
Locations 5 · Factions 2 · Background 9 · Rules 1 · Directions 5 · Things 1

Salvatore            main        named 107 times in the story
Don Raffaele Costa   main        named 70 times
Carlo Vancetti       supporting  named 14 times
Marco                background  mentioned 4 times
```

**These are draft suggestions with their evidence attached, not decisions.**

A correction already applied and worth keeping: **only actual people may become
story NPCs.** "Vancetti Family", "How Patrick Communicates", "Abandonment",
"Established Devotion Regression" were appearing in Casting. A heading *about*
somebody is not somebody; those belong in Background. `looksLikeAName()` in
`compose.js` does this and will need more work as new packages arrive.

---

## 10. New stories versus existing ones

The current analyser leans on counting how often a name appears in the
conversation. **That only works for a story that already has one.** For a new
story it must fall back on the source's own structure — prominence, entry size,
always-on status, how many other entries reference a person. That fallback
exists but is weak and unverified. This needs finishing.

A trap worth knowing: the first test of this reported "Salvatore: not named in
the story" when he appears 107 times. The counting was fine; the test had
picked one of the one-message decoy stories. Check which story you are reading.

---

## 11. Cast model

Approved shape: **Lead · Main · Supporting · Background · Known/Available ·
Excluded.**

`story_characters` for reusable cards; `story_npcs` for lore-backed people.
Lead normally stays a reusable card. Never auto-create a global character card
for a discovered NPC — promotion is a deliberate act, and when it happens it
should use `characters.from_entry` (the column does not exist yet; the pattern
already exists as `personas.from_entry`).

**Cast role and context depth are different concepts.** Role says how important
somebody is; depth says how much fixed text about them is sent. Auto defaults
may derive depth from role, but do not hard-code it as semantics, and **do not
implement prompt weighting from roles yet** — that changes how established
stories compile and must be tested on a new story first.

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

## 14. Legacy migration, still pending

Her People library still contains scenario and world packages imported before
the semantic classifier existed, so they appear in the character picker.

The dry-run was verified repeatedly and was stable across code changes:

**→ Scenario, high confidence**: Actuate MHA classroom ×2 · MHA || SLEEPOVER ×3
· MHA || Sticky Situations · MHA || Class With The Bakusquad
**→ World, high confidence**: MHA RPG Bot # Infinity ×2 (21 embedded lore
entries, 3 starting points each)
**Stay Character, high confidence**: two Katsuki Bakugo, three Patrick Moretti
**Manual review only**: `[🅰️] Kirishima` · the Bakugo with a 67,125-character
greeting (a pasted previous story, not a malformed card) · Midnight Munchies

Exact duplicates exist and must be consolidated by content hash or provenance,
**never by title**: Infinity ×2 (each with its own copy of the same 21-entry
book), SLEEPOVER ×3, classroom ×2. The migration must be idempotent — run it
twice on a copy and the second run must create nothing.

Do not re-derive this. Re-run the classifier to confirm, then act.

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

`npm run` scripts, verified present:

```
import:check  semantics:check  library:check  plan:check  context:check
threads:check bg:check         reconcile:check recursion:check
```

Plus `scripts/smoke.js <port>`, `scripts/check-scene-state.js`,
`scripts/replay-state.js`, `scripts/check-legacy-threads.js`.

Last observed passing counts — **re-run rather than trusting these**:
semantics 61 · threads 19 · reconcile 16 · book-recursion 13 · context 64 ·
smoke 92 · scene-state 9.

Most suites need a throwaway server: `PORT=8xxx DB_PATH=<temp> node server.js`.
Never point a test at `data/tipsy.db`. Two memory-engine smoke checks are
non-deterministic because they depend on a live extraction; a single failure in
`correction applies` or `facts reach the prompt` is usually flakiness, not a
regression.

---

## 17. Next task

**Do not start by redesigning anything.** Finish the Story Composition review
experience. The backend exists.

1. **Analyser semantics** — only real people become NPCs; make new-story
   evidence work without a transcript; support Known/Available and Excluded in
   the draft.
2. **Review UI** — source → analysing → Review Story, between "add source" and
   "start".
3. **Casting review** — change any suggested role.
4. **Persona choice during story creation** — optional, but visible before
   starting. A new story currently gets none and says "Nobody yet" afterwards.
5. **Reviewable sections** — Casting, Locations, Factions, Background, Rules,
   Directions, Events, Items, Other.
6. **Safe transactional apply.**
7. **Safe source removal** — define it; removing a source must take nothing
   away from the reusable package.
8. **Legacy migration** (§14) so scenarios stop appearing as characters.
9. **Validate on real data** — a new disposable story with a real Patrick
   package, and an MHA package with many characters, checking that Class 1-A
   people appear in casting review without becoming global cards.
10. **Mobile/browser validation**, iPhone width and 320px.

Not yet: AI Build It Out · context-depth weighting · automatic NPC promotion ·
Home redesign.

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
