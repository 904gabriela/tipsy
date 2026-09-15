// Read a story's history into memory, showing progress.
const B = `http://localhost:${process.env.PORT || 8787}`;
const title = process.argv[2];

const lib = await fetch(`${B}/api/library`).then((r) => r.json());
const story = title
  ? lib.stories.find((s) => s.title.toLowerCase().includes(title.toLowerCase()))
  : lib.stories.sort((a, b) => b.message_count - a.message_count)[0];
if (!story) { console.error('No such story.'); process.exit(1); }

const before = await fetch(`${B}/api/stories/${story.id}/prompt`).then((r) => r.json());
console.log(`${story.title} — ${story.message_count} messages`);
console.log(`before: ${before.report.messagesDropped} outside the window, ${before.report.episodes} scenes, ${before.report.unremembered} remembered by nothing\n`);

const t0 = Date.now();
const res = await fetch(`${B}/api/stories/${story.id}/memory/backfill`, { method: 'POST' });
if (!res.ok) { console.error(await res.text()); process.exit(1); }

const rd = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let last = 0;
for (;;) {
  const { done, value } = await rd.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const evs = buf.split('\n\n');
  buf = evs.pop();
  for (const e of evs) {
    const type = /^event: (.+)$/m.exec(e)?.[1];
    const data = /^data: (.*)$/m.exec(e)?.[1];
    if (!type || data === undefined) continue;
    let d; try { d = JSON.parse(data); } catch { continue; }
    if (type === 'start') console.log(`reading ${d.total} exchanges…`);
    if (type === 'progress' && (d.done - last >= 10 || d.done === d.total)) {
      last = d.done;
      const mins = (Date.now() - t0) / 60000;
      console.log(`  ${d.done}/${d.total}   ${mins.toFixed(1)} min   about ${((d.total - d.done) * (mins / d.done)).toFixed(1)} min left`);
    }
    if (type === 'done') {
      console.log(`\nread ${d.read} of ${d.of}, folded ${d.folded} scenes${d.foldFailed ? `, ${d.foldFailed} failed to fold` : ''}`);
      if (d.stoppedEarly) console.log(`stopped early: ${d.lastError}`);
    }
    if (type === 'error') console.log(`error: ${d.message}`);
  }
}

const after = await fetch(`${B}/api/stories/${story.id}/prompt`).then((r) => r.json());
const mem = await fetch(`${B}/api/stories/${story.id}/memory`).then((r) => r.json());
console.log(`\nafter: ${after.report.messagesDropped} outside the window, ${after.report.episodes} scenes recalled, ${after.report.unremembered} remembered by nothing`);
console.log(`memory holds: ${mem.counts.characters} people, ${mem.counts.facts} facts, ${mem.counts.threads} unfinished`);
console.log(`took ${((Date.now() - t0) / 60000).toFixed(1)} minutes`);
