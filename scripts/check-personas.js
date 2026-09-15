// Which of your stories can offer you a character to play, and which cannot.
const B = `http://localhost:${process.argv[2] || 8787}`;
const G = (p) => fetch(B + p).then(async (r) => JSON.parse(await r.text()));

const lib = await G('/api/library');
const books = new Map(lib.lorebooks.map((b) => [b.id, b.name]));

console.log('YOUR STORIES\n');
for (const s of lib.stories) {
  const st = await G(`/api/stories/${s.id}`);
  const pl = await G(`/api/stories/${s.id}/playable`);
  console.log(s.title);
  console.log(`   lore attached : ${st.lorebookIds.length ? st.lorebookIds.map((id) => books.get(id)).join(', ') : 'none'}`);
  console.log(`   you play      : ${st.persona ? st.persona.name : 'nobody yet'}`);
  console.log(`   offered       : ${pl.offered.length ? pl.offered.map((o) => o.name).join(', ') : 'none'}`);
  console.log(`   your characters: ${pl.personas.length ? pl.personas.map((p) => p.name).join(', ') : 'none saved'}`);
  console.log('');
}

// Where the playable entries live, so it is obvious which book to attach.
console.log('LORE ENTRIES MARKED AS YOU');
for (const b of lib.lorebooks) {
  const cards = await G(`/api/lorebooks/${b.id}/cards`);
  for (const c of Object.values(cards.groups).flat()) {
    if (c.playable) console.log(`   "${c.title}"  in  ${b.name}`);
  }
}
