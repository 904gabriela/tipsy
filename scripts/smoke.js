// End-to-end smoke test against a throwaway server. Exercises every route the
// app uses, including the ones the review found could crash the process.
//   PORT=8791 DB_PATH=data/smoke.db node server.js &  then  node scripts/smoke.js 8791
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';

const PORT = Number(process.argv[2] || 8791);
const B = `http://localhost:${PORT}`;
const results = [];
const ok = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const G = (p) => fetch(B + p).then(async (r) => { const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null, headers: r.headers }; });
const J = (p, b, m = 'POST') => fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(async (r) => { const t = await r.text(); let body = null; try { body = t ? JSON.parse(t) : null; } catch { body = t; } return { status: r.status, body }; });
const D = (p) => fetch(B + p, { method: 'DELETE' }).then((r) => r.status);
const upload = (name) => fetch(B + '/api/import', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(name) }, body: readFileSync('samples/' + name) }).then(async (r) => ({ status: r.status, body: JSON.parse(await r.text()) }));

async function sse(path, body) {
  const t0 = Date.now();
  const res = await fetch(B + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (!res.ok) return { status: res.status, events: [], error: await res.text() };
  const rd = res.body.getReader(); const dec = new TextDecoder();
  let buf = ''; const events = []; let doneAt = null;
  for (;;) {
    const { done, value } = await rd.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const evs = buf.split('\n\n'); buf = evs.pop();
    for (const e of evs) {
      const type = /^event: (.+)$/m.exec(e)?.[1]; const data = /^data: (.*)$/m.exec(e)?.[1];
      if (!type || data === undefined) continue;
      let v; try { v = JSON.parse(data); } catch { continue; }
      events.push({ type, data: v });
      if (type === 'done') doneAt = Date.now();
    }
  }
  return { status: 200, events, closedAt: Date.now(), doneAt, t0 };
}

try {
  // 1. import
  const c1 = await upload('Katsuki Bakugo.json');
  const b1 = await upload('MHA - CANON (3).json');
  ok('import character', c1.status === 200 && c1.body.kind === 'character', c1.body.name);
  ok('import lorebook', b1.status === 200 && b1.body.kind === 'lorebook', b1.body.detail);

  // entries got typed on import
  const cards = await G(`/api/lorebooks/${b1.body.id}/cards`);
  const typed = Object.keys(cards.body.counts).filter((k) => k !== 'note').length > 0 || cards.body.total === 0;
  ok('imported entries classified', cards.status === 200 && typed, JSON.stringify(cards.body.counts));

  // 2. persona, story with greeting substitution + default persona
  const per = await J('/api/personas', { name: 'Reiko', description: 'Class 1-A. Quirk: Echo.' });
  ok('create persona', per.status === 200 && per.body.id);
  const st = await J('/api/stories', { characterIds: [c1.body.id], lorebookIds: [b1.body.id], title: 'smoke' });
  ok('create story', st.status === 200 && st.body.id);
  const s1 = await G(`/api/stories/${st.body.id}`);
  ok('story defaults to the only persona', s1.body.persona && s1.body.persona.name === 'Reiko');
  const greet = s1.body.messages[0]?.content || '';
  ok('greeting has names filled in', !/\{\{(user|char)\}\}/i.test(greet), greet.slice(0, 60).replace(/\n/g, ' '));

  // 3. prompt before any memory
  const p0 = await G(`/api/stories/${st.body.id}/prompt`);
  ok('prompt builds', p0.status === 200 && typeof p0.body.report.stateTokens === 'number' && p0.body.report.unremembered === 0,
    `unremembered=${p0.body.report.unremembered} constantLore=${p0.body.report.loreConstantTokens}`);

  // 4. send, streaming, memory pass
  const s = await sse(`/api/stories/${st.body.id}/send`, { text: 'Reiko sets her bag down. "You waited."' });
  const types = s.events.map((e) => e.type);
  ok('send streams start/delta/done', types.includes('start') && types.includes('delta') && types.includes('done'), types.filter((t, i, a) => a.indexOf(t) === i).join(','));
  const mem = s.events.find((e) => e.type === 'remembered' || e.type === 'memory-error');
  ok('memory pass reported', !!mem, mem ? `${mem.type}: ${JSON.stringify(mem.data).slice(0, 100)}` : 'no memory event');
  ok('stream closed after done', s.doneAt && s.closedAt >= s.doneAt, `closed ${s.closedAt - s.doneAt}ms after done`);

  // 5. prompt now carries memory, including facts
  const p1 = await G(`/api/stories/${st.body.id}/prompt`);
  const stateMsg = p1.body.messages.find((m) => m.content.includes('WHERE THINGS STAND'));
  ok('state block in prompt', !!stateMsg, stateMsg ? `${p1.body.report.stateTokens} tokens` : 'missing');
  ok('facts reach the prompt', !!stateMsg && /CAN DRAW ON|UNFINISHED/.test(stateMsg.content), stateMsg ? stateMsg.content.split('\n').filter((l) => /^[A-Z ]+$/.test(l.trim())).join(' | ') : '');

  // 6. regenerate keeps sibling, head moves
  const s2 = await G(`/api/stories/${st.body.id}`);
  const lastReply = s2.body.messages[s2.body.messages.length - 1];
  const r = await sse(`/api/stories/${st.body.id}/send`, { regenerateFrom: lastReply.id });
  const sib = await G(`/api/messages/${lastReply.id}/siblings`);
  const s3 = await G(`/api/stories/${st.body.id}`);
  ok('regenerate makes a sibling', r.events.some((e) => e.type === 'done') && sib.body.length === 2, `siblings=${sib.body.length}`);
  ok('head moved to new reply', s3.body.head_id !== lastReply.id);

  // 7. /use goes back and lands on the old branch
  const use = await J(`/api/messages/${lastReply.id}/use`);
  const s4 = await G(`/api/stories/${st.body.id}`);
  ok('use switches branch', use.status === 200 && s4.body.messages.some((m) => m.id === lastReply.id) && s4.body.head_id === lastReply.id, `head=${(s4.body.head_id || '').slice(0, 8)}`);

  // 8. delete a MIDDLE message: head must be repaired, no 500
  const userMsg = s4.body.messages.find((m) => m.role === 'user');
  const dstat = await D(`/api/messages/${userMsg.id}`);
  const s5 = await G(`/api/stories/${st.body.id}`);
  ok('delete middle message repairs head', dstat === 200 && s5.status === 200 && s5.body.head_id && s5.body.messages.length === 1,
    `status=${dstat} messages=${s5.body.messages.length} head=${(s5.body.head_id || 'NULL').slice(0, 8)}`);

  // 9. memory screen + correction
  const m1 = await G(`/api/stories/${st.body.id}/memory`);
  ok('memory endpoint', m1.status === 200 && m1.body.lastError === null, `facts=${m1.body.facts.length} threads=${m1.body.threads.length} err=${JSON.stringify(m1.body.lastError)}`);
  // memory rows were keyed to the reply we just deleted, so re-send one line to have something to correct
  await sse(`/api/stories/${st.body.id}/send`, { text: 'She sits down beside him.' });
  const m2 = await G(`/api/stories/${st.body.id}/memory`);
  if (m2.body.facts.length) {
    const f = m2.body.facts[0];
    await J(`/api/stories/${st.body.id}/memory/correct`, { path: `facts/${f.id}/text`, value: 'CORRECTED BY SMOKE', note: 'smoke' });
    const m3 = await G(`/api/stories/${st.body.id}/memory`);
    ok('correction applies', m3.body.facts.find((x) => x.id === f.id)?.text === 'CORRECTED BY SMOKE');
  } else {
    ok('correction applies', false, 'no facts to correct after two exchanges');
  }

  // 10. entry edit keeps untouched fields
  const anyEntry = (cards.body.groups[Object.keys(cards.body.groups)[0]] || [])[0];
  if (anyEntry) {
    const before = await G(`/api/entries/${anyEntry.id}`);
    await J(`/api/lorebooks/${b1.body.id}/entries`, { id: anyEntry.id, title: before.body.title + ' (edited)' });
    const after = await G(`/api/entries/${anyEntry.id}`);
    ok('partial entry edit keeps other fields', after.body.title.endsWith('(edited)') && after.body.probability === before.body.probability && JSON.stringify(after.body.keys) === JSON.stringify(before.body.keys) && after.body.order === before.body.order);
  }

  // 11. presets, icons
  const pre = await G('/api/presets');
  ok('presets', pre.status === 200 && pre.body.presets.length >= 3);
  for (const icon of ['/icon.png', '/apple-touch-icon.png']) {
    const res = await fetch(B + icon); const buf = new Uint8Array(await res.arrayBuffer());
    ok(`serves ${icon}`, res.status === 200 && res.headers.get('content-type') === 'image/png' && buf[0] === 0x89 && buf[1] === 0x50, `${buf.length} bytes`);
  }

  // 12. the two crash cases: raw requests with a bad Host header, and a bad escape in the path
  const rawStatus = (path, headers) => new Promise((resolve) => {
    const req = httpRequest({ host: 'localhost', port: PORT, path, method: 'GET', headers }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve('ERR')); req.end();
  });
  const badHost = await rawStatus('/api/library', { Host: 'bad host:with spaces:99999' });
  const badEsc = await rawStatus('/api/stories/%E0%A4%A', {});
  const alive = await G('/api/library');
  ok('bad Host header does not crash', badHost !== 'ERR' && alive.status === 200, `status=${badHost}`);
  ok('bad percent-escape does not crash', badEsc === 400 && alive.status === 200, `status=${badEsc}`);

  // 13. the slow burn: a ladder, a gate that holds, and dials that land
  const sid = st.body.id;
  const arc0 = await G(`/api/stories/${sid}/arc`);
  ok('arc reads', arc0.status === 200 && arc0.body.arc.ladder.length >= 2 && Array.isArray(arc0.body.people),
    `${arc0.body.arc.ladder.length} stages, ${arc0.body.people?.length} people`);

  const saved = await J(`/api/stories/${sid}/arc`, {
    arc: {
      on: true, pace: 2,
      ladder: [{ name: 'strangers' }, { name: 'wary' }, { name: 'trusted' }, { name: 'his' }],
      reluctance: { 'katsuki-bakugo': 0.8 },
    },
  });
  ok('arc saves and spaces itself', saved.status === 200
    && saved.body.arc.ladder.length === 4
    && saved.body.arc.ladder[0].at === 0
    && saved.body.arc.ladder[3].at === 80
    && saved.body.arc.ladder.every((r, i) => i === 0 || r.at > saved.body.arc.ladder[i - 1].at),
    saved.body.arc?.ladder?.map((r) => `${r.name}@${r.at}/${r.dwell}`).join(' '));

  const back = await G(`/api/stories/${sid}/arc`);
  ok('reluctance survives the round trip',
    Math.abs((back.body.people.find((p) => p.id === 'katsuki-bakugo')?.reluctance ?? 0) - 0.8) < 0.001);

  const badStage = await J(`/api/stories/${sid}/arc/place`, { a: 'Reiko', b: 'Bakugo', stage: 'nonsense' });
  ok('placing at a stage that does not exist is refused', badStage.status === 400);

  const placed = await J(`/api/stories/${sid}/arc/place`, { a: 'Reiko', b: 'Bakugo', stage: 'trusted' });
  ok('placing a pair by hand', placed.status === 200 && placed.body.score > 0, `score ${placed.body.score}`);

  // The ladder itself, tested where it actually matters: can a story that
  // pushes as hard as the extractor is allowed still skip a stage?
  const { applyDelta, emptyState } = await import('../src/memory/state.js');
  const { ladderOf, rungFor, DEFAULT_LADDER } = await import('../src/memory/arc.js');
  const L = ladderOf({ ladder: DEFAULT_LADDER });
  const arc = { on: true, ladder: DEFAULT_LADDER, pace: 1, reluctance: {} };
  const world = emptyState();
  let jumped = false;
  let last = 0;
  for (let at = 1; at <= 60; at++) {
    applyDelta(world, { characters: { A: { name: 'A', relations: { B: { delta: 3, confidence: 1 } } } } }, { at, arc });
    const r = rungFor(L, world.characters.a.relations.b.score);
    if (r > last + 1) jumped = true;
    last = r;
  }
  ok('60 maximum-push messages cannot skip a stage', !jumped && last <= 1,
    `reached "${L[last].name}" (${Math.round(world.characters.a.relations.b.score)} closeness)`);

  const reluctant = emptyState();
  const openA = emptyState();
  for (let at = 1; at <= 400; at++) {
    const d = { characters: { A: { name: 'A', relations: { B: { delta: 1, confidence: 0.7 } } } } };
    applyDelta(openA, d, { at, arc });
    applyDelta(reluctant, d, { at, arc: { ...arc, reluctance: { b: 1 } } });
  }
  const fast = openA.characters.a.relations.b.score;
  const slow = reluctant.characters.a.relations.b.score;
  ok('reluctance actually slows it', slow < fast * 0.6, `${Math.round(slow)} vs ${Math.round(fast)} closeness after 400 messages`);

  // 14. secrets: what the model is shown when the gate is shut
  const { renderState } = await import('../src/memory/state.js');
  const secretWorld = emptyState();
  applyDelta(secretWorld, {
    scene: { where: 'the bar', who: ['A', 'B'] },
    characters: { A: { name: 'A', present: true }, B: { name: 'B', present: true } },
    facts: [{ text: 'A killed a man at the docks in March', knownBy: ['A'], secrecy: 2, veil: 'will not talk about March' }],
  }, { at: 1, arc });
  const secretId = Object.keys(secretWorld.facts)[0];
  const shut = renderState(secretWorld, { openSecrets: [], cast: ['a', 'b'] });
  const open = renderState(secretWorld, { openSecrets: [secretId], cast: ['a', 'b'] });
  const ungated = renderState(secretWorld, { cast: ['a', 'b'] });
  ok('a shut gate keeps the secret out of the prompt entirely',
    !/killed a man|docks/i.test(shut) && /will not talk about March/.test(shut),
    shut.includes('CARRYING SOMETHING') ? 'only the shape is left' : 'no veil shown');
  ok('an open gate lets it through', /killed a man at the docks/.test(open));
  ok('with the gate off it behaves as before', /killed a man at the docks/.test(ungated));

  // 14b. building a small lorebook out of a big one
  const srcBook = await G(`/api/lorebooks/${b1.body.id}`);
  const three = srcBook.body.entries.slice(0, 3).map((e) => e.id);
  const copied = await J(`/api/lorebooks/${b1.body.id}/bulk`, { entryIds: three, action: 'copy', newName: 'Curated' });
  const newBook = await G(`/api/lorebooks/${copied.body.into.id}`);
  const from = srcBook.body.entries[0];
  const to = newBook.body.entries.find((e) => e.title === from.title);
  ok('copy selected entries into a new lorebook',
    copied.status === 200 && newBook.body.entries.length === 3
    && to && to.content === from.content && to.constant === from.constant
    && JSON.stringify(to.keys) === JSON.stringify(from.keys),
    `${copied.body.copied} copied, settings carried`);
  const srcAfter = await G(`/api/lorebooks/${b1.body.id}`);
  ok('copying leaves the originals alone', srcAfter.body.entries.length === srcBook.body.entries.length);
  const again = await J(`/api/lorebooks/${b1.body.id}/bulk`, { entryIds: three, action: 'copy', target: copied.body.into.id });
  ok('copying the same entries twice makes no duplicates',
    again.body.copied === 0 && again.body.already === 3);
  ok('copying into the same book is refused',
    (await J(`/api/lorebooks/${b1.body.id}/bulk`, { entryIds: three, action: 'copy', target: b1.body.id })).status === 400);
  ok('copying with nowhere to put them is refused',
    (await J(`/api/lorebooks/${b1.body.id}/bulk`, { entryIds: three, action: 'copy' })).status === 400);

  // 14c. a preset that writes the prompt and puts named controls in front of it
  const presetFile = readFileSync('samples/Standard_Chungus.json');
  const impPreset = await fetch(B + '/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'Standard_Chungus.json' },
    body: presetFile,
  }).then(async (r) => ({ status: r.status, body: JSON.parse(await r.text()) }));
  ok('a preset file imports as a preset', impPreset.status === 200 && impPreset.body.kind === 'preset', impPreset.body.detail);
  ok('and nothing in it was dropped', (impPreset.body.notes || []).length === 0,
    (impPreset.body.notes || []).map((n) => n.text).join(' | ') || 'read losslessly');

  await J(`/api/stories/${sid}/use-preset`, { presetId: impPreset.body.id });
  const dials = await G(`/api/stories/${sid}/dials`);
  ok('its controls reach the story', dials.body.script?.controls.length === 10 && dials.body.script.sections.length === 3,
    `${dials.body.script?.controls.length} controls, ${dials.body.total} tokens`);
  ok('nothing reads as changed on a fresh load', dials.body.changed.length === 0);

  const kit = await J(`/api/stories/${sid}/dials`, { bundle: 'kit_slow_burn' });
  ok('a ready-made setup moves every control it names',
    kit.body.values.voice === 'voice_literary' && kit.body.values.pacing === 'pacing_slow' && kit.body.changed.length === 0);

  const oneOff = await J(`/api/stories/${sid}/dials`, { values: { contentRating: 'rating_nsfw' } });
  ok('changing one control is reported as drift', oneOff.body.changed.length === 1);

  const scripted = await G(`/api/stories/${sid}/prompt`);
  const sysBlock = scripted.body.messages[0].content;
  const volBlocks = scripted.body.messages.filter((m) => m.volatile).map((m) => m.content).join('\n');
  ok('the preset writes the cached half', sysBlock.includes('You are the narrator'), scripted.body.report.script);
  ok('a control choice reaches the prompt', sysBlock.includes('no content ceiling'));
  ok('the hard rules are read last, not cached', volBlocks.includes('NEVER act for') && !sysBlock.includes('NEVER act for'));
  ok('the cast is sent once, not once per system', (sysBlock.match(/Katsuki Bakugo \(/g) || []).length <= 1);
  ok('an empty block prunes itself rather than shipping bare tags',
    !/<\w+>\s*<\/\w+>/.test(sysBlock + volBlocks));

  const resetAll = await J(`/api/stories/${sid}/dials`, { reset: true });
  ok('reset all puts every control back', resetAll.body.changed.length === 0);
  ok('an unknown setup is refused', (await J(`/api/stories/${sid}/dials`, { bundle: 'nope' })).status === 400);

  // 14d. the older kind of preset file, from SillyTavern and the sites around it
  const stFile = readFileSync('samples/DeepClean - A preset for Deepseek.json');
  const stImp = await fetch(B + '/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent('DeepClean - A preset for Deepseek.json') },
    body: stFile,
  }).then(async (r) => ({ status: r.status, body: JSON.parse(await r.text()) }));
  ok('a SillyTavern-style preset imports as a preset',
    stImp.status === 200 && stImp.body.kind === 'preset', stImp.body.name);

  await J(`/api/stories/${sid}/use-preset`, { presetId: stImp.body.id });
  const stStory = await G(`/api/stories/${sid}`);
  ok('its sampler numbers come with it',
    stStory.body.settings.temperature === 0.9 && stStory.body.settings.presencePenalty === 0.7,
    `temperature ${stStory.body.settings.temperature}, presence ${stStory.body.settings.presencePenalty}`);
  ok('a min_p of 1 is left off rather than sent', stStory.body.settings.minP === undefined);

  const stPrompt = await G(`/api/stories/${sid}/prompt`);
  const stSys = stPrompt.body.messages[0].content;
  const stVol = stPrompt.body.messages.filter((m) => m.volatile).map((m) => m.content).join('\n');
  ok('its main prompt is cached', stSys.includes('IMPORTANT ROLEPLAY GUIDELINE'));
  ok('its jailbreak block is read last, after the story',
    stVol.includes('POV Directive') && !stSys.includes('POV Directive'));
  ok('the cast and lore get placed for it', stSys.includes('<story_bible>') && stSys.includes('Katsuki Bakugo'));

  // 14e. moving the story without typing
  const beforeNudge = await G(`/api/stories/${sid}`);
  const lastBefore = beforeNudge.body.messages[beforeNudge.body.messages.length - 1];

  const imp = await sse(`/api/stories/${sid}/impersonate`);
  const impText = imp.events.filter((e) => e.type === 'delta').map((e) => e.data).join('');
  const afterImp = await G(`/api/stories/${sid}`);
  ok('write-my-turn returns words', impText.trim().length > 20, `${impText.trim().length} chars`);
  ok('and never puts them on the page itself',
    afterImp.body.messages.length === beforeNudge.body.messages.length,
    'it goes in the box for you to change');

  if (lastBefore.role === 'assistant') {
    const cont = await sse(`/api/stories/${sid}/continue`);
    const afterCont = await G(`/api/stories/${sid}`);
    const lastAfter = afterCont.body.messages[afterCont.body.messages.length - 1];
    ok('carry-on extends the last reply rather than adding one',
      lastAfter.id === lastBefore.id
      && lastAfter.content.length > lastBefore.content.length
      && afterCont.body.messages.length === beforeNudge.body.messages.length,
      `${lastAfter.content.length - lastBefore.content.length} chars added`);
    ok('and the continuation streamed', cont.events.some((e) => e.type === 'delta'));
  }

  // Continuing your own line is not a thing, and it says so instead of trying.
  // Deleting the last reply leaves your own message at the end, which is the
  // state that has to be refused.
  const nowMsgs = (await G(`/api/stories/${sid}`)).body.messages;
  const lastNow = nowMsgs[nowMsgs.length - 1];
  if (lastNow.role === 'assistant') await D(`/api/messages/${lastNow.id}`);
  const endsWithYou = (await G(`/api/stories/${sid}`)).body.messages.slice(-1)[0]?.role === 'user';
  const refusal = await fetch(`${B}/api/stories/${sid}/continue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  ok('carry-on is refused when the last word is yours',
    !endsWithYou || refusal.status === 400,
    endsWithYou ? `status ${refusal.status}` : 'could not arrange that state, skipped');

  // 15. the memory pass asks for what it needs, and only from providers that
  // answer. Both of these were silently missing and cost a whole story's
  // worth of relationship history before anyone noticed.
  const ex = await import('../src/memory/extract.js');
  const schemaSrc = readFileSync('src/memory/extract.js', 'utf8');
  ok('the record asks for relationships at the top level',
    /^\s{4}relations: \{/m.test(schemaSrc),
    'nested inside characters, a model fills it three times in a hundred');
  ok('known-empty providers are refused',
    ex.AVOID_PROVIDERS.length > 0 && ex.PREFERRED_PROVIDERS.length > 0
    && !ex.PREFERRED_PROVIDERS.some((p) => ex.AVOID_PROVIDERS.includes(p)),
    `prefer ${ex.PREFERRED_PROVIDERS.join(', ')} · refuse ${ex.AVOID_PROVIDERS.join(', ')}`);

  // 16. persona edit keeps its picture
  await J(`/api/avatar/persona/${per.body.id}`, { dataUri: 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==' });
  await J('/api/personas', { id: per.body.id, name: 'Reiko A.', description: 'renamed' });
  const p = await G(`/api/personas/${per.body.id}`);
  ok('renaming a persona keeps the picture', !!p.body.avatar && p.body.name === 'Reiko A.');

  // 14i. a card downloaded as JSON keeps its art on the site's image server,
  // and nothing was reading that field, so those cards arrived faceless.
  // This card is a campaign module wearing a character card's clothes, so it
  // is held for a look rather than filed as a person. That is the change; the
  // art and the lore still have to survive it.
  const chub = await upload('chub-0f88989e-main_mha-rpg-bot-infinity-033320803f78_spec_v2.json');
  ok('a world shipped as a character card is not filed as a person',
    chub.status === 200 && chub.body.needsReview === true && chub.body.plan?.role === 'framework',
    `${chub.body.kind}, read as ${chub.body.plan?.role} (${chub.body.plan?.confidence})`);
  ok('and nothing was created until it is confirmed',
    !(await G('/api/library')).body.characters.some((c) => /RPG Bot/i.test(c.name)));

  const kept = await J('/api/import/commit', { importId: chub.body.importId });
  ok('confirming it makes the framework', kept.status === 200 && kept.body.kind === 'framework', kept.body.kind);
  ok('a card whose picture is a link still gets one',
    kept.body.picture === true, kept.body.picture ? 'fetched and stored' : 'no picture');

  const fw = (await G('/api/library')).body.frameworks.find((f) => f.id === kept.body.id);
  ok('and the picture is a path, not a megabyte in the listing',
    (fw?.avatar || '').startsWith('/api/assets/'), fw?.avatar);
  const pic = await fetch(B + fw.avatar);
  ok('which actually serves an image',
    pic.status === 200 && (pic.headers.get('content-type') || '').startsWith('image/'),
    `${pic.headers.get('content-length')} bytes`);
  ok('its embedded lorebook came too',
    (await G('/api/library')).body.lorebooks.some((b) => b.entry_count === 21));
  ok('and the lorebook is tied to the framework, not left loose',
    (await G(`/api/frameworks/${kept.body.id}`)).body.lorebooks?.[0]?.entries === 21);
  ok('its three ways in survived',
    (await G(`/api/starts/framework/${kept.body.id}`)).body.starts.length === 3);

  // 14g. tags survive the import, which is what makes searching by them work
  const tagged = await J('/api/templates/example-character.json/use');
  const lib = await G('/api/library');
  const withTags = lib.body.characters.find((c) => c.id === tagged.body.id);
  ok('a card keeps its tags', (withTags?.tags || []).length >= 3, (withTags?.tags || []).join(', '));

  // 14h. what your marks mean reaches the prompt
  const marked = await G(`/api/stories/${sid}/prompt`);
  const markBlock = marked.body.messages.filter((m) => m.volatile)
    .map((m) => m.content).join('\n').split('\n\n').find((b) => b.includes('HOW THIS IS WRITTEN'));
  ok('your notation is sent to the model', !!markBlock && markBlock.includes('(( ))'),
    markBlock ? `${markBlock.split('\n').length - 2} marks` : 'missing');

  await J(`/api/stories/${sid}`, { settings: { ...(await G(`/api/stories/${sid}`)).body.settings, notation: { on: false } } }, 'PATCH');
  const unmarked = await G(`/api/stories/${sid}/prompt`);
  ok('and switching it off really removes it',
    !unmarked.body.messages.some((m) => (m.content || '').includes('HOW THIS IS WRITTEN')));

  // 14f. the door. Run last, because setting a password locks everything
  // above it and the rest of this script has no cookie.
  const gate0 = await G('/api/gate');
  ok('with no password, this machine is let in', gate0.body.inside && gate0.body.canSetFirst);

  // Three zones, not two. Getting this wrong once already locked the phone
  // out of an app that had been working fine from the sofa.
  const { createAuth } = await import('../src/auth.js');
  const z = createAuth({ getSetting: () => null, setSetting: () => {} });
  const zoneOf = (ip, headers = {}) => z.zone({ socket: { remoteAddress: ip }, headers });
  ok('the machine it runs on is "machine"',
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].every((ip) => zoneOf(ip) === 'machine'));
  ok('your own wifi is "home", so the phone still works',
    ['192.168.1.49', '10.0.0.7', '172.16.4.2', 'fd00::5'].every((ip) => zoneOf(ip) === 'home'));
  ok('the internet is "outside"',
    ['8.8.8.8', '172.32.0.1', '203.0.113.9'].every((ip) => zoneOf(ip) === 'outside'));
  ok('a request through a tunnel is outside however local it looks',
    ['x-forwarded-for', 'x-forwarded-proto', 'cf-connecting-ip', 'forwarded']
      .every((h) => zoneOf('127.0.0.1', { [h]: 'x' }) === 'outside'),
    'a tunnel runs on this machine, so without this every stranger arrives as 127.0.0.1');

  const proxied = await fetch(`${B}/api/library`, { headers: { 'X-Forwarded-For': '8.8.8.8' } });
  ok('and the server actually refuses it', proxied.status === 401);

  const tooShort = await J('/api/gate/set', { password: 'short' });
  ok('a short password is refused', tooShort.status === 400);

  const setPw = await fetch(`${B}/api/gate/set`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'a smoke test password' }),
  });
  const cookie = (setPw.headers.get('set-cookie') || '').split(';')[0];
  ok('setting one hands back a session', setPw.status === 200 && cookie.startsWith('tipsy='));

  const noCookie = await fetch(`${B}/api/library`);
  const withCookie = await fetch(`${B}/api/library`, { headers: { Cookie: cookie } });
  ok('everything is behind it now', noCookie.status === 401 && withCookie.status === 200);

  // Read the file itself rather than ask the app: the question is whether the
  // secret is on disk at all, and only the bytes can answer that.
  const raw = readFileSync('data/smoke.db').toString('latin1');
  ok('the password itself is nowhere on disk', !raw.includes('a smoke test password'));
  ok('nor is the session token', !raw.includes(decodeURIComponent(cookie.slice('tipsy='.length))));

  const wrong = await J('/api/gate/open', { password: 'not it' });
  ok('a wrong password is refused', wrong.status === 401);

  const changeNoCurrent = await fetch(`${B}/api/gate/set`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ password: 'another long password', current: 'wrong' }),
  });
  ok('changing it needs the current one', changeNoCurrent.status === 401);

} catch (e) {
  ok('smoke script itself', false, e.stack.split('\n').slice(0, 3).join(' | '));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? '\n\nFAILED:\n' + failed.map((f) => `  ${f.name}: ${f.detail}`).join('\n') : ''}`);
process.exit(failed.length ? 1 : 0);
