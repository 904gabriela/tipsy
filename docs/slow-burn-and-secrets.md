# The slow burn, and secrets that hold

Two things the app does that no prompt can do on its own. Both are in
*Settings*: **How closeness moves** and **What stays hidden**.

---

## Why telling the AI to take it slow does not work

It works for about twenty messages. Then a charged scene arrives, the reply
leaps four stages, and nothing in the prompt was ever able to stop it. The
instruction was advice, and advice loses to momentum.

So the pacing here is not advice. It is a ladder the story climbs, and the
app decides which rung two people are on. The AI is told where they stand.
It never gets to decide.

### The ladder

Six stages by default, in order. You can rename them, rewrite what each one
means, add stages, or remove them. You never type a number: the thresholds
and the waiting times are spread across however many stages you have.

    strangers → circling → an understanding → close → wanting → together

Two gates guard every step up, and both have to open.

**Closeness.** A score from 0 to 100. After each reply the memory pass
reports how far that exchange moved two people, between -3 and +3. The app
shrinks that number heavily before it counts. One exchange, however good,
moves things a little.

**Time.** Messages that have to pass at the current rung before the next one
is even possible. While that time is unserved, the closeness score is simply
held one point below the door. This is the gate that matters most. Without
it, one intense night of writing can still run the whole ladder, because
closeness is the only thing the story is pushing on.

### How long it actually takes

Measured, not guessed. Fourteen real exchanges from a running story were
re-read to see how much closeness the memory pass really reports for writing
like yours. That rate gives:

| Pace       | Strangers to the last stage |
| ---------- | --------------------------- |
| Quicker    | about 320 messages          |
| Slow burn  | about 620 messages          |
| Very slow  | about 1,200 messages        |
| Glacial    | about 1,900 messages        |

Pushing as hard as the memory pass is allowed to, every single message,
still takes around 380 messages at the default pace. That is the floor.

### Reluctance

Per person, in the same screen. It slows getting closer and leaves pulling
away alone, because a guarded person does not take longer to be hurt. At the
top of the dial, twice as long as anyone else. The slower of the two sets the
pace for that pair.

### Turning it on for a story already running

New stories start with the ladder in place. A story that was played before it
existed does not, because its closeness was scored under the old rules.
Turning it on works out where everybody stands from the beginning, under the
new rules, and the answer may not be where you thought they were. Nothing is
lost and nothing is rewritten. You can put any pair exactly where you want
them afterwards, and they climb on from there.

---

## Secrets

### The problem

Put a secret in the prompt with "Patrick does not know this" beside it, and
sooner or later Patrick references it. Not because the AI disobeyed, but
because the words were sitting there and a plausible next sentence used them.
The instruction is a speed bump. The presence of the text is the problem.

### What happens instead

When somebody is actively hiding something, the app checks each turn whether
this moment is actually about it. One short, cheap call, asked separately for
each secret, before the reply is written.

If the answer is no, **the secret's text never enters the story prompt at
all**. What goes in instead is its shape: that this person is carrying
something, and roughly what subject they steer away from. Enough to write the
pause, the changed subject, the answer that is true and incomplete. Not enough
to say the thing.

If the answer is yes, the full text goes in, with who holds it.

### What opens a secret

- Somebody asked about it directly, or asked a question it is the answer to
- Evidence turned up where someone can see it
- The person holding it decided to tell, or started to
- Someone who does not know said something that lands on it exactly

### What does not

- The subject coming up in passing
- The holder being tense or evasive about it
- The mood being right for a confession
- It having been hidden a long time

### It fails closed

Measured across twelve scenes: nine judged exactly right, three judged too
cautiously, **none spilled**. That is the designed shape of the error. Being
wrong towards closed costs a delayed reveal. Being wrong towards open spills
something the story cannot take back. If the check cannot run at all — no
connection, no credit, a dead model — nothing opens.

### One limit worth knowing

The gate protects the *record*, not the transcript. If a secret was said out
loud twenty messages ago, it is still in the recent messages the AI can see,
and it should be — it happened on the page. The gate matters for the old
ones, the ones that have fallen out of the recent window and live only in
memory. Those are exactly the ones that used to leak.

---

## The thing that was quietly broken underneath both

Neither of these works if the memory pass is not actually reading your story.
It was not.

The same model name on OpenRouter is served by several different companies,
and a different one answers each request. They are not equivalent. Measured
on the same eight real exchanges, same model, same prompt:

| Serving it   | Recorded what happened | Recorded who stands where |
| ------------ | ---------------------- | ------------------------- |
| Baidu        | 8 of 8                 | 8 of 8                    |
| Wafer        | 8 of 8                 | 8 of 8                    |
| DeepInfra    | 8 of 8                 | 6 of 8                    |
| Venice       | 8 of 8                 | 6 of 8                    |
| DigitalOcean | 5 of 8                 | 8 of 8                    |
| StreamLake   | 3 of 8                 | 8 of 8                    |
| Alibaba      | 0 of 8                 | 0 of 8                    |
| AtlasCloud   | 0 of 8                 | 0 of 8                    |
| NextBit      | 0 of 6                 | 0 of 6                    |

Three of them return a record that finishes cleanly, parses cleanly, and is
empty. Nothing can tell that apart from "nothing happened in that scene", so
a quarter of a story goes unrecorded without a single error anywhere.

The app now asks for the good ones first and refuses the three empty ones.
Fallbacks stay on, so a bad day for one company is a slower reply rather than
a lost one.

To check it again later — these things change — run:

    node scripts/check-memory-model.js

It re-reads real exchanges from your longest story, one company at a time,
counts what each found, and tells you whether the app's current choice still
looks right. It never prints your writing. Costs a few cents.
