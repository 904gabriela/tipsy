# Writing lore that actually gets used

There is a working example beside this file at `templates/example-lorebook.json`.
Import it, read it, copy entries out of it. Every entry in it demonstrates one
idea, and the entry titles say which.

This page explains the ideas. The editor in the app will ask you these
questions in plain words, so you should never need to write JSON by hand
unless you want to.

---

## The one thing to understand

The AI is handed a block of text before every reply. Your lore entries are
candidates for that block. Most of them will not make it in, because the block
has a size limit and everything competes for it.

So every entry has two jobs:

1. **Get chosen** at the right moment, and stay out of the way otherwise.
2. **Say something useful** in as few words as possible once it is in.

Most lorebooks fail at the first job, not the second.

---

## Getting chosen

### Trigger words

Give an entry the words people would actually type when the thing is relevant.
Names, nicknames, the way characters address each other.

```
"key": ["Reiko", "Reiko Amano", "Amano"]
```

The app searches the last few messages for these. Any one of them hits and the
entry fires. Capitalisation is ignored unless you ask for it.

**Whole words matter for short names.** Turn on whole-word matching for
anything short, or "Ada" fires on "Canada".

### Needing two things at once

A relationship entry should only appear when both people are in the scene.
Put the first person in the trigger words and the second in the extra
conditions, and it fires only when both are present.

```
"key":          ["Reiko", "Amano"],
"keysecondary": ["Bakugo", "Katsuki", "Kacchan"]
```

### Always on

Mark an entry always-on and it goes in every single message, no trigger words
needed. **Use this sparingly.** It is the single biggest cost in a lorebook,
and it is the reason your MHA book has almost no room left for anything the
scene is actually about.

A good test: would this be equally true and equally relevant in every scene of
the story? Quirks existing, yes. A character's appearance, no, that only
matters when they are there.

### Priority

Every entry has a priority number. When space runs out, high numbers get in
first. It also decides where in the block an entry lands: lower numbers sit
further from the conversation, higher numbers sit closer, and closer is
weighted more heavily by the AI.

Rough scheme that works:

| Priority | For |
|---|---|
| 200+ | World rules that are always on |
| 100-150 | People, relationships, live secrets |
| 50-90 | Places, objects, background |
| under 50 | Flavour you would not miss |

---

## Three tricks worth knowing

**Make a scene linger.** Set "sticky" to a number and the entry stays loaded
for that many messages after it fires, even once nobody mentions it again.
Good for a location or a situation you have just moved into. The festival entry
in the example uses this.

**Stop something repeating.** Set "cooldown" and the entry cannot fire again
for that many messages. Good for anything that would get annoying said twice.

**Only one of these.** Give several entries the same group name and exactly one
of them will ever be used at a time, picked at random. The two weather entries
in the example do this. Useful for anything you want varied rather than
accumulated.

---

## Saying something useful

Entries are not prose. They are notes to a collaborator who has never read your
story. Write in short factual lines, not paragraphs.

**This works:**

```
Reiko Amano, 17, Class 1-A. Quirk: Echo, replays any sound heard in the last hour.
Looks: black hair cut blunt at the jaw, blazer a size too big, ink on her fingers.
Manner: answers late, as if she considered not answering. Never raises her voice.
```

**This works badly:**

```
Reiko is a really interesting character who has a lot of depth to her. She's
quite mysterious and has a complicated past that she doesn't like to talk
about, which makes her seem cold at first but she's actually very warm once
you get to know her.
```

The second one is twice as long and tells the AI nothing it can put on the
page. "Mysterious" is a description of an effect. "Answers late, as if she
considered not answering" is an instruction for how to produce it.

### Say what a thing does, not what it is like

- Not "he has a temper" but "raises his voice before he decides to"
- Not "they are close" but "she is the only person he lets interrupt him"
- Not "the roof is windy" but "wind constant enough that people lean into it
  without noticing"

### Never write what a character does not know

This is the counterintuitive one. Writing "Bakugo does not know about the
injury" makes the AI **more** likely to have him mention it. Telling a model
not to think about something reliably backfires.

Write only who does know:

```
Known to: Bakugo, Recovery Girl.
```

The app tracks the other side of that, and does it structurally rather than by
asking the AI nicely.

---

## Rules are not lore

If you find yourself writing an entry about how the AI should write, such as
formatting, pacing, how to render dialogue, or staying in character, that is
not lore. Put it in the story's instructions instead.

Two reasons. It stops competing with your actual world for space. And it gets
cached, so after the first message of a session you stop paying for it.

Four entries in your MHA book are this, and between them they take up more than
half your lore budget.
