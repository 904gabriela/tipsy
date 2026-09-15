// What everything in this app does, in the app.
//
// Written here rather than in a file beside the code, because a setting you
// cannot ask about while you are looking at it is a setting you leave alone.
// Two halves: what each thing is, and what to reach for when you want a
// particular kind of story.

export const RECIPES = [
  {
    id: 'enemies',
    name: 'Enemies to lovers',
    about: 'The whole point is the distance closing slowly, and something real being lost on the way.',
    dials: [
      ['Stages', 'On, pace <b>Very slow</b>', 'The engine holds them apart. Without it the first charged scene collapses the whole arc.'],
      ['Reluctance', '<b>0.6 to 0.9</b> on the harder one', 'It only slows getting closer. Being hurt still lands at full speed, which is what makes the fights matter.'],
      ['Stage names', 'Rewrite them', 'The shipped ladder starts at "strangers". Yours probably starts at something worse. Try: hostile, wary, useful to each other, unwilling respect, wanting, together.'],
      ['Secrets', 'On', 'Enemies have things they are not saying. Held back until the scene reaches them, they come out when it costs something.'],
      ['Pacing', '<b>Slow Burn</b>', 'In the preset. Keeps scenes from resolving in the message they start.'],
      ['Stakes', '<b>Grounded</b>', 'Forgiving takes the teeth out; lethal ends it before it arrives.'],
    ],
    watch: 'If they warm up faster than you want, it is almost always reluctance, not pace. Pace slows everyone; reluctance slows the one who should be hard to reach.',
  },
  {
    id: 'slowburn',
    name: 'A long slow burn',
    about: 'Months of story, thousands of messages, nothing arriving before it is earned.',
    dials: [
      ['Stages', 'On, pace <b>Slow burn</b> or <b>Very slow</b>', 'About 620 or 1,200 messages end to end. Measured, not guessed.'],
      ['Memory', 'On, and back-fill if the story predates it', 'Without it, anything past the recent window never happened.'],
      ['Messages kept word for word', '<b>60 to 80</b>', 'Higher costs more per message. Older ones survive as folded scenes anyway.'],
      ['Reply length', '<b>400 to 650</b>', 'Long enough for a scene to breathe.'],
      ['Prose style', '<b>Literary</b> on a strong model', 'On a weak one it goes purple. Invisible is the safe choice.'],
    ],
    watch: 'The single biggest lever is not a dial: it is whether the memory pass is actually recording. Open the brain and check "unremembered" is zero.',
  },
  {
    id: 'dark',
    name: 'Something dark, with no softening',
    about: 'The model keeps reaching for a hopeful note the scene has not earned.',
    dials: [
      ['Content rating', '<b>Explicit</b>', 'In the preset. Anything below it cuts away.'],
      ['Stakes', '<b>Lethal</b>', 'Nobody has plot armour, you included.'],
      ['Standing instructions', 'Say it plainly', 'e.g. "If a moment is ugly or unresolved, leave it that way. Never close a scene on reassurance."'],
      ['Memory model', 'Must be uncensored', 'A memory model that flinches quietly euphemises the details, and the story gets built on a softened record without anything going wrong on screen.'],
      ['Banned phrases', 'Add your own', 'The tells you keep seeing. They are the first thing to reach for when replies feel generic.'],
    ],
    watch: 'If it still softens, the card may be doing it. A character card can carry its own instructions, and they replace the app\'s general guidance.',
  },
  {
    id: 'multi',
    name: 'A big cast, one narrator',
    about: 'Several people in a scene, written by one voice, each knowing only what they could know.',
    dials: [
      ['Point of view', '<b>Third (Limited)</b> or <b>Omniscient</b>', 'Limited keeps mystery; omniscient handles a crowded room better.'],
      ['Secrets', 'On', 'This is what stops one character using something only another one knows.'],
      ['Lore budget', '<b>6,000</b> or more', 'A big cast pulls in more entries per turn.'],
      ['Living world', 'On', 'Side characters pursue their own business between your turns.'],
    ],
    watch: 'Who knows what is tracked from what happens on the page. If someone knows something they should not, correct it in the brain rather than arguing with the model.',
  },
  {
    id: 'cheap',
    name: 'Keeping the bill down',
    about: 'A long story that does not cost a fortune per message.',
    dials: [
      ['Messages kept word for word', 'Lower it', 'This is the biggest line on your bill. Folded scenes cover the rest.'],
      ['Always-on lore', 'Audit it', 'Every always-on entry is sent every single message. They do not come out of the lore budget, so they are easy to miss.'],
      ['Reply length', 'Lower the top end', 'You pay for what comes back too.'],
      ['Prose style', '<b>Dry &amp; Lean</b>', 'The cheapest in tokens and the quickest to read.'],
      ['Model', 'Try a cheaper one for a while', 'The memory pass already runs on a cheap model; the story model is the expensive half.'],
    ],
    watch: 'Open "What went into the last message". The cached number is billed at roughly a tenth. If it is a low share of the total, something volatile is sitting too early in the prompt.',
  },
];

export const TOPICS = [
  {
    id: 'start',
    title: 'Starting out',
    entries: [
      ['What a story is made of', 'A cast, optionally some lorebooks, a premise, and a preset that decides how it is written. None of them are permanent: you can change every one mid-story from <b>This story</b> and the dials.'],
      ['The premise', 'The frame everything stands in: where, when, what has already happened. It is sent every message, so a few concrete lines beat a page of atmosphere.'],
      ['Who you play', 'Your persona. The app never writes for them, ever, whatever a preset says. If a reply starts answering on your behalf, that is a card overriding the rule, not the app.'],
    ],
  },
  {
    id: 'presets',
    title: 'Presets and the dials',
    entries: [
      ['A plain preset', 'A saved set of the writing dials: model, temperature, length, window, lore budget, standing instructions. Reusable across stories. It touches nothing else.'],
      ['A preset with controls', 'Writes the whole prompt itself, with holes in it that named controls fill. This is the friendly kind: instead of "temperature 0.92" you pick "Literary — beautiful on a strong model, purple on a weak one."'],
      ['Ready-made setups', 'A named set of every control at once. One tap changes the whole feel, and the line underneath tells you how far you have since wandered from it.'],
      ['Which one wins', 'There is no second layer. Loading a preset sets those dials; whatever you change afterwards is simply the newer value. A preset never touches your stages, your secrets, your persona, your lore or your picture.'],
      ['The token count under each control', 'What that choice adds to every single message. Worth a glance when you are choosing between two you like equally.'],
    ],
  },
  {
    id: 'memory',
    title: 'Memory',
    entries: [
      ['What it actually does', 'After each reply a second, cheaper model reads the exchange and writes down what changed: facts, who learned what, what is still owed. That record is what survives past the recent window.'],
      ['Folded scenes', 'Once messages fall out of the window they are compressed into scenes. The rule that matters: every message must be covered by the window or by a scene. Never neither. The brain screen shows "unremembered" for exactly this.'],
      ['Unfinished business', 'A promise, a debt, a secret being kept. These get more insistent the longer they go unmentioned, which is the opposite of how search-based memory works, and it is why an old promise can come back on its own.'],
      ['Back-filling', 'A story played before memory existed can be read end to end in one pass. It costs a few cents and takes a while. Do it once.'],
      ['Corrections', 'Anything the record got wrong can be fixed by hand, and your correction always wins. Deleting it later really undoes it.'],
    ],
  },
  {
    id: 'stages',
    title: 'Stages and reluctance',
    entries: [
      ['Why it is not just an instruction', 'Telling a model to take it slow works for about twenty messages. Then a charged scene arrives and the relationship jumps four stages, because nothing in the prompt could stop it. Here the app decides the stage, not the model.'],
      ['The two gates', 'Closeness, which only moves a little per exchange, and time, which is messages that must pass at the current stage. While the time is unserved the score is held one point below the door. That second gate is the one that matters.'],
      ['Reluctance', 'Per person. It slows getting closer and leaves being hurt alone, because a guarded person does not take longer to be wounded. At the top of the dial, twice as long as anyone else.'],
      ['Turning it on late', 'A story that ran without stages gets recalculated from the beginning under the new rules. Nothing is lost, but the answer may not be where you thought. You can place any pair by hand afterwards.'],
    ],
  },
  {
    id: 'secrets',
    title: 'Secrets',
    entries: [
      ['The problem', 'Put a secret in the prompt with "he does not know this" beside it and sooner or later he references it. Not disobedience: the words were there and a plausible sentence used them.'],
      ['What happens instead', 'Each turn the app asks, separately for each hidden thing, whether this moment is actually about it. If not, the text never enters the prompt at all. What goes in is the shape: that someone is carrying something, and roughly what subject they avoid.'],
      ['What opens one', 'A direct question, evidence surfacing where it can be seen, the holder deciding to tell, or someone landing on it exactly. Not: the subject coming up in passing, the holder being tense, or the mood being right.'],
      ['It fails closed', 'Measured across twelve scenes: nine exactly right, three too cautious, none spilled. If the check cannot run at all, nothing opens.'],
      ['One limit', 'It protects the record, not the transcript. Something said out loud twenty messages ago is still in the recent messages, and it should be. This is for the old ones.'],
    ],
  },
  {
    id: 'lore',
    title: 'Lorebooks',
    entries: [
      ['How an entry fires', 'By its trigger words appearing in recent messages, or by being always-on. Everything that fires shares a budget; always-on entries do not come out of it.'],
      ['Always-on is expensive', 'It is sent with every single message, forever. Two thousand tokens of always-on lore on a thousand-message story is a real number. Audit it.'],
      ['Entries that are really instructions', 'A lot of imported books carry writing directions dressed as lore. They belong in standing instructions instead: cheaper, and they stop competing with your world for the budget.'],
      ['Building a small book from a big one', 'Select several entries and copy them into a new book. The originals stay, every setting comes with them, and copying twice makes no duplicates.'],
    ],
  },
  {
    id: 'cost',
    title: 'What things cost',
    entries: [
      ['The cached half', 'Providers bill the unchanged front of a prompt at roughly a tenth. Everything stable is kept at the front and never moved, which is why the bill on a long story stays sane.'],
      ['The per-turn half', 'The world as it stands, and anything with a clock in it, go after the conversation. Full price, but small.'],
      ['Where to look', 'Settings, under the hood, "What went into the last message". If the cached share is low, something that changes every turn is sitting too early.'],
      ['The memory pass', 'Roughly a fifth on top, on a cheap model. It is the reason anything survives, and it is the cheapest part of the bill.'],
    ],
  },
];
