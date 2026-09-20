// Tipsy — the front end.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const state = { library: null, story: null, settings: null, streaming: null, models: null };

// Appearance belongs to this device, not to the story. It never reaches the
// model. "system" is the default, so the app follows the phone unless told not to.
let themeChoice = 'system';
try { themeChoice = localStorage.getItem('tipsy.theme') || 'system'; } catch { /* storage unavailable */ }
function setTheme(value) {
  themeChoice = ['light', 'dark', 'system'].includes(value) ? value : 'system';
  if (themeChoice === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = themeChoice;
  try { localStorage.setItem('tipsy.theme', themeChoice); } catch { /* keep it for this session */ }
}
setTheme(themeChoice);

// ------------------------------------------------------------------ server

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) {
    // A session that ran out mid-use should put the lock screen up rather than
    // scatter failures across whatever you were doing.
    if (res.status === 401 && body?.locked) { showGate(); throw new Error(body.error); }
    // The whole answer rides along: some failures say more than one sentence,
    // like a review that lists which entries changed underneath it.
    const err = new Error(body?.error || `Something went wrong (${res.status}).`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}
const get = (p) => api(p);
const post = (p, b) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}) });
const patch = (p, b) => api(p, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}) });
const del = (p) => api(p, { method: 'DELETE' });

// ------------------------------------------------------------------ toasts

function toast(message, { sub = '', kind = '', ms = 4200 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div>${esc(message)}</div>${sub ? `<div class="toast-sub">${esc(sub)}</div>` : ''}`;
  $('#toasts').append(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 250); }, ms);
}

// ------------------------------------------------------------------ sheets

let sheetOnClose = null;
function sheet(title, html, onMount) {
  $('#sheet-title').textContent = title;
  // A fresh body every time. Panels attach click handlers to the body, and
  // reusing it meant every reopen stacked another handler on top: open the
  // memory screen five times and one tap made five corrections.
  const old = $('#sheet-body');
  const body = old.cloneNode(false);
  old.replaceWith(body);
  body.innerHTML = html;
  $('#sheet-host').hidden = false;
  if (onMount) onMount(body);
}
function closeSheet() {
  $('#sheet-host').hidden = true;
  $('#sheet-body').innerHTML = '';
  if (sheetOnClose) { const f = sheetOnClose; sheetOnClose = null; f(); }
}
// On the host, which is never replaced, so it survives every sheet() call.
$('#sheet-host').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeSheet();
  else if (e.target.closest('[data-back]')) goBack();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet-host').hidden) closeSheet(); });

/**
 * Open and close a folded card by tapping its whole header.
 *
 * Aiming at a 20px chevron on a phone is a miss half the time, and growing
 * the chevron to fingertip size makes it the loudest thing on the row. The
 * row is the target; the chevron just says which way it will go. Anything
 * else in the header with its own job keeps it.
 */
function wireFolds(root) {
  root.addEventListener('click', (e) => {
    if (e.target.closest('button:not(.fold), a, input, select, textarea')) return;
    const head = e.target.closest('.edit-head');
    if (!head) return;
    const card = head.closest('.edit-card');
    const body = $('.edit-body', card);
    if (!body) return;
    body.hidden = !body.hidden;
    const chevron = $('.fold', head);
    if (chevron) chevron.setAttribute('aria-expanded', String(!body.hidden));
  });
}

/** A list of things you can tick. Used everywhere a choice is made. */
function picker(items, { multi = true, selected = new Set() } = {}) {
  return `<div class="pick" data-multi="${multi}">` + items.map((it) => `
    <button type="button" class="pick-opt" data-id="${esc(it.id)}" aria-pressed="${selected.has(it.id)}">
      <span class="pick-box">✓</span>
      <span class="pick-main">
        <span class="pick-title">${esc(it.title)}</span>
        ${it.sub ? `<span class="pick-sub">${esc(it.sub)}</span>` : ''}
      </span>
    </button>`).join('') + '</div>';
}
function wirePicker(root) {
  $$('.pick', root).forEach((pick) => {
    pick.addEventListener('click', (e) => {
      const opt = e.target.closest('.pick-opt');
      if (!opt) return;
      const multi = pick.dataset.multi === 'true';
      const on = opt.getAttribute('aria-pressed') === 'true';
      if (multi) {
        opt.setAttribute('aria-pressed', String(!on));
      } else {
        $$('.pick-opt', pick).forEach((o) => o.setAttribute('aria-pressed', 'false'));
        opt.setAttribute('aria-pressed', 'true');
      }
      pick.dispatchEvent(new CustomEvent('change', { bubbles: true }));
    });
  });
}
const picked = (root) => $$('.pick-opt[aria-pressed="true"]', root).map((o) => o.dataset.id);

// ----------------------------------------------------------------- screens

function show(name) {
  $$('.screen').forEach((s) => { s.hidden = s.dataset.screen !== name; });
}

// ----------------------------------------------------------------- library

async function loadLibrary() {
  state.library = await get('/api/library');
  renderLibrary();
}

function renderLibrary() {
  const L = state.library;

  renderStories();

  renderCharacters();

  renderLorebooks();
}

/**
 * Lorebooks, grouped by where they came from.
 *
 * A flat list of a dozen books with token counts on every row is the app
 * showing you its filing cabinet. Two groups answer the question you actually
 * have: which of these are mine, and which arrived attached to somebody.
 */
function renderLorebooks() {
  const books = state.library?.lorebooks || [];
  const host = $('#lore-list');

  if (!books.length) {
    host.innerHTML = `
      <div class="nothing">
        <span class="mark"><svg viewBox="0 0 24 24"><path d="M4 5a2 2 0 0 1 2-2h11a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a2 2 0 0 0-2 2Z"/><path d="M8 7h7M8 11h7"/></svg></span>
        <h3>No world yet</h3>
        <p>A lorebook feeds in facts about your world as they come up in the writing, instead of you having to repeat them.</p>
        <button class="btn primary" id="btn-new-lorebook">Write one</button>
      </div>`;
    return;
  }

  const card = (b) => {
    const alwaysTokens = Math.round(b.always_on_chars / 4);
    const heavy = alwaysTokens > 3000;
    return `
      <button class="book" data-lorebook="${esc(b.id)}">
        <span class="book-main">
          <span class="book-name">${esc(b.name)}</span>
          <span class="book-meta">
            <span>${num(b.entry_count)} ${b.entry_count === 1 ? 'entry' : 'entries'}</span>
            ${b.always_on ? `<span class="${heavy ? 'flag cost' : ''}">${num(b.always_on)} always on · ${num(alwaysTokens)} tokens every message</span>` : ''}
          </span>
        </span>
        <span class="book-go"><svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg></span>
      </button>`;
  };

  const mine = books.filter((b) => !b.character_name);
  const carried = books.filter((b) => b.character_name);

  host.innerHTML = `
    ${mine.length ? `
      <div class="band"><h2>Your world</h2><span class="count">${num(mine.length)}</span></div>
      <div class="shelf">${mine.map(card).join('')}</div>` : ''}
    ${carried.length ? `
      <div class="band"><h2>Came with someone</h2><span class="count">${num(carried.length)}</span></div>
      <div class="hint" style="margin:-4px 0 10px">These arrived inside a character card and belong to them.</div>
      <div class="shelf">
        ${carried.map((b) => `
          <button class="book" data-lorebook="${esc(b.id)}">
            <span class="book-main">
              <span class="book-name">${esc(b.name)}</span>
              <span class="book-meta"><span>with ${esc(b.character_name)}</span><span>${num(b.entry_count)} entries</span></span>
            </span>
            <span class="book-go"><svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg></span>
          </button>`).join('')}
      </div>` : ''}`;
}

// ----------------------------------------------------------------- the shelf
//
// The first thing you see, so it is the one screen that has to feel like a
// story rather than a table. The newest one gets its art at full width; the
// rest are rows, but rows with a face and the last line on them.

const face = (art, name, cls = 'round') => `
  <span class="pic ${cls}">
    ${art ? `<img src="${esc(art)}" alt="" loading="lazy">`
    : `<span class="letter">${esc(String(name || '?')[0].toUpperCase())}</span>`}
  </span>`;

/** The story's own name, and the cast only when it adds something. */
function taleWhere(s) {
  const cast = String(s.cast || '').trim();
  if (!cast) return '';
  // The title is usually the character's name, and printing both gave
  // "Katsuki Bakugo  Katsuki Bakugo" on every row.
  if (cast === s.title || s.title.startsWith(cast)) return '';
  return cast;
}

function taleLine(s) {
  if (!s.last_line) return '';
  const who = s.last_role === 'user' ? 'You' : (String(s.cast || '').split(',')[0] || '').trim();
  return who ? `${who}: ${s.last_line}` : s.last_line;
}

function renderStories() {
  const stories = state.library?.stories || [];
  const host = $('#story-list');

  if (!stories.length) {
    host.innerHTML = `
      <div class="nothing">
        <span class="mark"><svg viewBox="0 0 24 24"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5Z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5Z"/></svg></span>
        <h3>Nothing started yet</h3>
        <p>Pick who is in it and what it draws on, and the first line is already written for you.</p>
        <button class="btn primary" id="empty-begin">Begin a story</button>
      </div>`;
    return;
  }

  const [first, ...rest] = stories;
  host.innerHTML = `
    <div class="band"><h2>Carry on</h2></div>
    <div class="shelf">
      <button class="tale lead${first.art ? '' : ' bare'}" data-story="${esc(first.id)}">
        ${first.art ? `<span class="tale-art"><img src="${esc(first.art)}" alt="" loading="lazy"></span>` : ''}
        <span class="tale-body">
          <span class="tale-name">${esc(first.title)}</span>
          ${taleWhere(first) ? `<span class="tale-where">${esc(taleWhere(first))}</span>` : ''}
          ${taleLine(first) ? `<span class="tale-line">${esc(taleLine(first))}</span>` : ''}
        </span>
      </button>
    </div>

    ${rest.length ? `
      <div class="band"><h2>Earlier</h2><span class="count">${num(rest.length)}</span></div>
      <div class="shelf">
        ${rest.map((s) => `
          <button class="tale row" data-story="${esc(s.id)}">
            ${face(s.art, s.title, 'soft')}
            <span class="tale-body">
              <span class="tale-name">${esc(s.title)}</span>
              ${taleLine(s) ? `<span class="tale-line">${esc(taleLine(s))}</span>`
    : `<span class="tale-where">${esc(taleWhere(s) || 'not started')}</span>`}
            </span>
            <span class="tale-when">${esc(when(s.updated_at))}</span>
          </button>`).join('')}
      </div>` : ''}`;
}

// -------------------------------------------------------------- finding one
//
// A library of downloaded cards is a pile until you can ask it a question.
// Cards carry tags already; nothing was reading them.

const find = { text: '', tags: new Set(), shelf: 'people', sort: 'recent' };

// Tidying up. Selection belongs to one shelf: what you ticked among your people
// has nothing to do with your sources, and carrying it across would leave things
// chosen that are not on the screen. Searching and filtering keep it, because
// narrowing to find the fourth copy is exactly how somebody selects four copies.
const tidy = { on: false, shelf: null, picked: new Set(), deps: null };

/** What this shelf calls the things on it. */
const SHELF_KIND = { people: 'character', sources: 'source', scenarios: 'scenario', worlds: 'world' };

// What each shelf holds, and how a thing on it describes itself. One set of
// search, tags and sorting serves all three: they are one collection kept in
// three places, not three features.
const SHELF = {
  people: {
    title: 'People',
    items: () => state.library?.characters || [],
    empty: ['Nobody yet', 'Write one from scratch, or drop in a card you downloaded. Card images and files both work.'],
    hay: (c) => `${c.name} ${c.nickname || ''} ${c.description || ''}`,
    card: faceCard,
  },
  scenarios: {
    title: 'Scenarios',
    items: () => state.library?.scenarios || [],
    empty: ['No scenarios yet', 'A scenario is a situation you can start a story in. Drop in a pack you downloaded and it will land here.'],
    hay: (s) => `${s.name} ${s.premise || ''}`,
    card: sceneCard,
  },
  // A lorebook, said the way a person would say it: a package of material
  // that came from somewhere. The storage object is unchanged, and opening
  // one still leads to the same editor with all its triggers and priorities.
  sources: {
    title: 'Sources',
    items: () => (state.library?.lorebooks || []),
    empty: ['Nothing here yet', 'A source is a package of material — people, places, rules — that came in with a card or on its own.'],
    hay: (b) => `${b.name} ${b.description || ''}`,
    card: sourceCard,
  },
  worlds: {
    title: 'Worlds',
    items: () => state.library?.frameworks || [],
    empty: ['No worlds yet', 'A world is a setting and its rules, which any number of stories can use. Campaign files land here.'],
    hay: (f) => `${f.name} ${f.summary || ''}`,
    card: worldCard,
  },
};

function renderCharacters() {
  const shelf = SHELF[find.shelf] || SHELF.people;
  const all = shelf.items();

  // Every tag anybody carries, commonest first, so the row is useful rather
  // than alphabetical.
  const counts = new Map();
  for (const c of all) {
    for (const t of c.tags || []) {
      const k = String(t).trim().toLowerCase();
      if (k) counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  const tags = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40);
  $('#char-tags').innerHTML = tags.map(([t, n]) => `
    <button type="button" class="tagpill" data-tag="${esc(t)}" aria-pressed="${find.tags.has(t)}">
      ${esc(t)} <span style="opacity:.55">${n}</span>
    </button>`).join('');

  const words = find.text.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = all.filter((c) => {
    // Every chosen tag must be on the card: tags narrow, they do not widen.
    const mine = new Set((c.tags || []).map((t) => String(t).trim().toLowerCase()));
    for (const t of find.tags) if (!mine.has(t)) return false;
    if (!words.length) return true;
    const hay = `${shelf.hay(c)} ${[...mine].join(' ')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });

  // Recently added is the default because the thing you just imported is
  // usually the thing you are looking for.
  const by = {
    recent: (a, b) => (b.created_at || 0) - (a.created_at || 0),
    name: (a, b) => String(a.name).localeCompare(String(b.name)),
    used: (a, b) => (b.last_used || 0) - (a.last_used || 0) || (b.created_at || 0) - (a.created_at || 0),
  };
  shown.sort(by[find.sort] || by.recent);

  $('#shelf-count').textContent = shown.length === all.length
    ? `${num(all.length)}`
    : `${num(shown.length)} of ${num(all.length)}`;
  renderTidy(shown);

  const list = $('#character-list');
  if (!all.length) {
    list.innerHTML = `
      <div class="nothing" style="grid-column:1/-1">
        <span class="mark"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"/></svg></span>
        <h3>${esc(shelf.empty[0])}</h3>
        <p>${esc(shelf.empty[1])}</p>
        ${find.shelf === 'people' ? '<button class="btn primary" id="btn-new-character">Write one</button>' : ''}
      </div>`;
    return;
  }
  if (!shown.length) {
    list.innerHTML = `
      <div class="nothing" style="grid-column:1/-1">
        <h3>Nothing matches that</h3>
        <p>Try fewer words, or clear the tags you have on.</p>
        <button class="btn" id="find-clear">Clear it</button>
      </div>`;
    return;
  }

  // Art first. A card downloaded for its picture should look like the
  // picture, and a wall of them reads at a glance the way a list never does.
  // Without one, the initial becomes the artwork rather than a apology for
  // its absence: large, centred, on its own warm ground.
  list.innerHTML = shown.map(shelf.card).join('');
}

// ---------------------------------------------------------------- tidying up
//
// Choosing several things and asking what would happen if they went. The
// answer always comes from the server: this screen sends a list of what was
// ticked and shows what comes back, and never decides for itself that
// something is safe.

/** Turn choosing on or off, and put the shelf back the way it was. */
function setTidy(on) {
  tidy.on = on;
  tidy.shelf = on ? find.shelf : null;
  tidy.picked.clear();
  if (!on) tidy.deps = null;
  $('#shelf-select').textContent = on ? 'Done' : 'Select';
  $('#shelf-select').classList.toggle('is-on', on);
  renderCharacters();
}

/** The bar of actions, and the count at the foot. */
function renderTidy(shown) {
  const on = tidy.on && tidy.shelf === find.shelf;
  $('#shelf-pick').hidden = !on;
  const foot = $('#pick-foot');
  foot.hidden = !on;
  document.body.classList.toggle('shelf-tidying', on);
  if (!on) return;
  const n = tidy.picked.size;
  $('#pick-count').textContent = n
    ? `${num(n)} selected`
    : `Nothing selected · ${num(shown.length)} here`;
  $('#pick-review').disabled = !n;
  const unused = $('#pick-unused');
  const known = tidy.deps ? tidy.deps.filter((r) => r.kind === SHELF_KIND[find.shelf] && !r.used && !r.protected).length : null;
  unused.textContent = known === null ? 'Select unused' : `Select unused · ${num(known)}`;
}

/** Ask the server what is holding what up. One call, kept for this shelf. */
async function loadTidyDeps() {
  const kind = SHELF_KIND[find.shelf];
  const r = await get(`/api/library/dependencies?kind=${encodeURIComponent(kind)}`);
  tidy.deps = r.resources;
  return r.resources;
}

/** The art, the name, and one line under it. Same shape on every shelf. */
function artCard(o, { kind, sub, badge = '' }) {
  const initial = String(o.name || '?').trim()[0]?.toUpperCase() || '?';
  // While tidying, the same card is a checkbox. Nothing moves and nothing is
  // hidden: the tick simply appears on it, and tapping chooses instead of opens.
  const choosing = tidy.on && tidy.shelf === find.shelf;
  const picked = choosing && tidy.picked.has(o.id);
  return `
    <button class="face${o.avatar ? '' : ' blank'}${picked ? ' picked' : ''}"
      ${choosing ? `data-pick="${esc(o.id)}" aria-pressed="${picked}"` : `data-${kind}="${esc(o.id)}"`}>
      ${o.avatar
    ? `<img src="${esc(o.avatar)}" alt="" loading="lazy">`
    : `<span class="initial">${esc(initial)}</span>`}
      ${badge ? `<span class="face-badge">${esc(badge)}</span>` : ''}
      ${choosing ? '<span class="face-tick" aria-hidden="true">✓</span>' : ''}
      <span class="face-cap">
        <span class="face-name">${esc(o.name)}</span>
        <span class="face-sub">${esc(sub)}</span>
      </span>
    </button>`;
}

function faceCard(c) {
  const sub = (c.tags || []).length
    ? (c.tags || []).slice(0, 3).join(' · ')
    : `${num(c.prompt_chars / 4)} tokens a message`;
  return artCard(c, {
    kind: 'character',
    sub,
    // Only worth saying when there is a choice to make.
    badge: c.starts > 1 ? `${c.starts} ways in` : '',
  });
}

function sceneCard(s) {
  const line = String(s.premise || '').replace(/\s+/g, ' ').trim();
  return artCard(s, {
    kind: 'scenario',
    sub: line ? line.slice(0, 90) : 'a situation to start in',
    badge: s.starts > 1 ? `${s.starts} openings` : '',
  });
}

function sourceCard(b) {
  const from = b.from_character_name || '';
  return artCard({ ...b, avatar: null }, {
    kind: 'lorebook',
    sub: from ? `came in with ${from}` : `${num(b.entry_count || 0)} entries`,
    badge: b.entry_count ? `${num(b.entry_count)}` : '',
  });
}

function worldCard(f) {
  const bits = [];
  if (f.lorebooks) bits.push('lore');
  if (f.stories) bits.push(`${f.stories} ${f.stories === 1 ? 'story' : 'stories'}`);
  const line = String(f.summary || '').replace(/\s+/g, ' ').trim();
  return artCard(f, {
    kind: 'framework',
    sub: line ? line.slice(0, 90) : (bits.join(' · ') || 'a world to play in'),
    badge: f.starts > 1 ? `${f.starts} ways in` : '',
  });
}

$('#char-search').addEventListener('input', (e) => {
  find.text = e.target.value;
  renderCharacters();
});
$('#char-sort').addEventListener('change', (e) => {
  find.sort = e.target.value;
  renderCharacters();
});
$('#shelves').addEventListener('click', (e) => {
  const b = e.target.closest('[data-shelf]');
  if (!b || b.dataset.shelf === find.shelf) return;
  find.shelf = b.dataset.shelf;
  // Tags belong to the shelf you were on; carrying them across filters the
  // new one by words that are not on it and shows you nothing.
  find.tags.clear();
  $$('#shelves .shelf-btn').forEach((x) => {
    x.classList.toggle('is-on', x === b);
    x.setAttribute('aria-selected', String(x === b));
  });
  $('#library-title').textContent = SHELF[find.shelf].title;
  $('#char-search').placeholder = find.shelf === 'people'
    ? 'name, tag, or anything in them'
    : 'name, tag, or anything in it';
  $('#library-scroll').scrollTop = 0;
  renderCharacters();
});
$('#char-tags').addEventListener('click', (e) => {
  const pill = e.target.closest('[data-tag]');
  if (!pill) return;
  const t = pill.dataset.tag;
  if (find.tags.has(t)) find.tags.delete(t); else find.tags.add(t);
  renderCharacters();
});

const when = (ms) => {
  const d = Math.floor((Date.now() - ms) / 86400000);
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  return new Date(ms).toLocaleDateString();
};

// The library tab holds three shelves, so its title is whichever one you are
// standing on rather than a fixed word that contradicts the row above it.
const TAB_TITLES = { stories: 'Tipsy', characters: () => SHELF[find.shelf].title };
const TAB_ADD = {
  stories: { label: 'Begin a story', go: () => $('#btn-new-story').click() },
  // On the people shelf the "+" writes someone. On the other two there is
  // nothing to write from scratch yet, so it does the thing that fills them.
  characters: {
    label: 'Write a character',
    go: () => (find.shelf === 'people' ? characterBuilder(null) : $('#file-input').click()),
  },
};
let currentTab = 'stories';

$('#tabbar').addEventListener('click', (e) => {
  const tab = e.target.closest('.tabbtn');
  if (!tab || !tab.dataset.tab) return;                 // settings has its own
  currentTab = tab.dataset.tab;
  $$('.tabbtn').forEach((t) => t.classList.toggle('is-on', t === tab));
  $$('.tab-panel').forEach((p) => p.classList.toggle('is-on', p.dataset.panel === currentTab));
  const t = TAB_TITLES[currentTab];
  $('#library-title').textContent = (typeof t === 'function' ? t() : t) || 'Tipsy';
  const add = TAB_ADD[currentTab];
  $('#btn-add').setAttribute('aria-label', add.label);
  $('#btn-add').title = add.label;
  $('#library-scroll').scrollTop = 0;
});

$('#btn-add').addEventListener('click', () => TAB_ADD[currentTab].go());

/**
 * Four ways to begin, in one place.
 *
 * The plus that used to make whatever the current shelf held now asks what
 * you want to start, because what you start is a story — everything else is
 * something a story is made of.
 */
function createSomething() {
  sheet('Start something', `
    <div class="picks">
      <button class="pick" data-make="idea">
        <b>Start with an idea</b><span>Describe the story in a few lines. Nexus builds the people, places and opening for you to look over.</span>
      </button>
      <button class="pick" data-make="story">
        <b>A story</b><span>Pick who is in it and what it is made from, and begin.</span>
      </button>
      <button class="pick" data-make="file">
        <b>From a file</b><span>A card, a lorebook or a package you downloaded. It works out what it is.</span>
      </button>
      <button class="pick" data-make="link">
        <b>From a link</b><span>Straight off the web, if the site allows it.</span>
      </button>
      <button class="pick" data-make="character">
        <b>Write a character</b><span>Someone of your own, from scratch.</span>
      </button>
    </div>
    <div class="sheet-actions"><button class="btn quiet" data-close>Not now</button></div>
  `, (root) => {
    root.addEventListener('click', (e) => {
      const p = e.target.closest('[data-make]');
      if (!p) return;
      closeSheet();
      ({
        idea: async () => { if (!state.library) await loadLibrary(); ideaStart(); },
        story: () => $('#btn-new-story').click(),
        file: () => $('#file-input').click(),
        link: () => importFromUrl(),
        character: () => characterBuilder(null),
      })[p.dataset.make]();
    });
  });
}
$('#btn-create').addEventListener('click', createSomething);

$('#library-scroll').addEventListener('click', async (e) => {
  if (e.target.closest('#find-clear')) {
    find.text = '';
    find.tags.clear();
    $('#char-search').value = '';
    renderCharacters();
    return;
  }
  if (e.target.closest('#empty-begin')) { $('#btn-new-story').click(); return; }
  if (e.target.closest('#btn-new-character')) { characterBuilder(null); return; }
  if (e.target.closest('#btn-url-import') || e.target.closest('#btn-url-import-lore')) { importFromUrl(); return; }
  const imp = e.target.closest('[data-import]');
  if (imp) { $('#file-input').click(); return; }
  // While tidying, a card is a checkbox and nothing opens.
  const pick = e.target.closest('[data-pick]');
  if (pick) {
    const id = pick.dataset.pick;
    const now = !tidy.picked.has(id);
    if (now) tidy.picked.add(id); else tidy.picked.delete(id);
    // The card itself changes, and nothing else does. Redrawing the whole wall
    // to tick one box would throw away scroll position on a long shelf — and
    // would replace the very element the next tap is aiming at.
    pick.classList.toggle('picked', now);
    pick.setAttribute('aria-pressed', String(now));
    renderTidy(visibleOnShelf());
    return;
  }
  const s = e.target.closest('[data-story]');
  if (s) { openStory(s.dataset.story); return; }
  const c = e.target.closest('[data-character]');
  if (c) { showCharacter(c.dataset.character); return; }
  const sc = e.target.closest('[data-scenario]');
  if (sc) { showScenario(sc.dataset.scenario); return; }
  const fw = e.target.closest('[data-framework]');
  if (fw) { showFramework(fw.dataset.framework); return; }
  const b = e.target.closest('[data-lorebook]');
  if (b) { openLorebook(b.dataset.lorebook); return; }
});

$('#shelf-select').addEventListener('click', () => setTidy(!tidy.on));
$('#pick-all').addEventListener('click', () => {
  for (const o of visibleOnShelf()) tidy.picked.add(o.id);
  renderCharacters();
});
$('#pick-none').addEventListener('click', () => { tidy.picked.clear(); renderCharacters(); });
$('#pick-unused').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const rows = await loadTidyDeps();
    const free = new Set(rows.filter((r) => !r.used && !r.protected).map((r) => r.id));
    const here = visibleOnShelf().filter((o) => free.has(o.id));
    tidy.picked.clear();
    for (const o of here) tidy.picked.add(o.id);
    renderCharacters();
    toast(here.length
      ? `${num(here.length)} of ${num(visibleOnShelf().length)} here have nothing standing on them.`
      : 'Everything here is being used by something.', { kind: here.length ? 'good' : 'plain' });
  } catch (err) { toast(err.message); } finally { btn.disabled = false; }
});
$('#pick-tidy').addEventListener('click', () => showCopiesAndVersions());
$('#pick-review').addEventListener('click', () => reviewDeletion());

/** What is on the shelf right now, after search and tags. */
function visibleOnShelf() {
  const shelf = SHELF[find.shelf] || SHELF.people;
  const words = find.text.toLowerCase().split(/\s+/).filter(Boolean);
  return shelf.items().filter((c) => {
    const mine = new Set((c.tags || []).map((t) => String(t).trim().toLowerCase()));
    for (const t of find.tags) if (!mine.has(t)) return false;
    if (!words.length) return true;
    return words.every((w) => `${shelf.hay(c)} ${[...mine].join(' ')}`.toLowerCase().includes(w));
  });
}

/**
 * What would happen if these went.
 *
 * The server answers, in four parts a person can act on: what goes, what goes
 * with it, what stays whatever happens, and what is refused and why. Nothing is
 * written by opening this.
 */
async function reviewDeletion() {
  const kind = SHELF_KIND[find.shelf];
  const selection = [...tidy.picked].map((id) => ({ kind, id }));
  sheet('Review deletion', '<div class="empty">Working out what these are holding up…</div>');
  let p;
  try { p = await post('/api/library/delete-preview', { selection }); } catch (err) {
    sheet('Review deletion', `<div class="notice">${esc(err.message)}</div>
      <div class="sheet-actions"><button class="btn primary" data-close>Close</button></div>`);
    return;
  }
  const row = (r) => `<div class="del-row"><span class="del-name">${esc(r.name)}</span>
    ${r.reasons.length ? `<span class="del-why">${esc(r.reasons.join(' · '))}</span>` : ''}</div>`;
  sheet(p.safe.length ? `Delete ${num(p.safe.length)}?` : 'Nothing here can go yet', `
    ${p.safe.length ? `<p class="rv-lede">These would be deleted:</p>
      <div class="del-list">${p.safe.map(row).join('')}</div>` : ''}
    ${p.detaches.length ? `<p class="rv-hint">${esc(p.detaches.join(' · '))}</p>` : ''}
    ${p.remains.length ? `<div class="rv-keeps"><b>Stays either way</b>
      <span>${esc(p.remains.slice(0, 8).join(' · '))}</span></div>` : ''}
    ${p.blocked.length ? `<p class="rv-lede" style="margin-top:14px">Kept, because something is using ${p.blocked.length === 1 ? 'it' : 'them'}:</p>
      <div class="del-list blocked">${p.blocked.map(row).join('')}</div>
      <p class="rv-hint">Take ${p.blocked.length === 1 ? 'it' : 'them'} out of the story first, then delete ${p.blocked.length === 1 ? 'it' : 'them'} here.</p>` : ''}
    <div class="sheet-actions">
      <button class="btn quiet" data-close>Keep everything</button>
      ${p.safe.length ? `<button class="btn danger" id="del-go">Delete ${num(p.safe.length)}${p.blocked.length ? ' safe' : ''}</button>` : ''}
    </div>
  `, (root) => {
    const go = $('#del-go', root);
    if (!go) return;
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const r = await post('/api/library/delete-apply', { selection, token: p.token, safeOnly: true });
        await loadLibrary();
        setTidy(false);
        closeSheet();
        toast(`${num(r.deleted.length)} deleted.`, {
          kind: 'good',
          sub: r.skipped.length ? `${num(r.skipped.length)} kept, still in use` : '',
        });
      } catch (err) { go.disabled = false; toast(err.message); }
    });
  });
}

/**
 * Copies, and things that might be versions of each other.
 *
 * A copy is a copy: identical, to the letter, in everything it says and every
 * way it fires. A version is not, and nothing here ever decides which version
 * somebody wants.
 */
async function showCopiesAndVersions() {
  sheet('Copies and versions', '<div class="empty">Comparing everything in your library…</div>');
  let d;
  try { d = await get('/api/library/duplicates'); } catch (err) {
    sheet('Copies and versions', `<div class="notice">${esc(err.message)}</div>
      <div class="sheet-actions"><button class="btn primary" data-close>Close</button></div>`);
    return;
  }
  const kind = SHELF_KIND[find.shelf];
  const copies = d.copies.filter((g) => g.kind === kind);
  const versions = kind === 'source' ? d.versions : [];
  const tell = (i) => [
    i.entries !== undefined ? `${num(i.entries)} entries` : '',
    i.organised ? `${num(i.organised)} organised` : '',
    i.used ? (i.reasons[0] || 'in use') : '',
  ].filter(Boolean).join(' · ');
  sheet('Copies and versions', `
    ${copies.length ? `<div class="band">Exact copies</div>
      <div class="why" style="margin-bottom:8px">Identical, word for word and setting for setting. One of each group stays — choose which. Empty sources are not counted as copies of each other.</div>
      ${copies.map((g, gi) => {
    const held = g.items.filter((i) => i.used || i.protected);
    return `<div class="edit-card">
        <div class="edit-head"><b>${esc(g.items[0].name)}</b><span class="n">${num(g.items.length)} identical</span></div>
        <div class="edit-body" style="display:block">
          <div class="why">${held.length
      ? `A story is already using ${held.length === 1 ? 'one of these' : `${num(held.length)} of these`}, so ${num(g.items.length - held.length)} ${g.items.length - held.length === 1 ? 'is' : 'are'} spare.`
      : `Choose which one to keep; the other ${g.items.length === 2 ? 'one' : `${num(g.items.length - 1)}`} would go.`}</div>
          ${g.items.map((i, ii) => `<div class="del-row">
            <span class="del-name">${esc(i.name)}</span>
            ${/* "Spare" is only true once something else is definitely staying.
                 While the choice is still open, neither copy is the spare one. */''}
            <span class="del-why">${esc(tell(i))}${held.length && i.redundant ? ' · spare' : ''}</span>
            ${/* Where a story already keeps one, the choice is made: that row
                 says so, and the spares beside it are not offered a button that
                 would choose nothing. Where nothing is decided, every row
                 offers the same choice and none is called spare. */''}
            ${i.used || i.protected ? '<span class="del-why in-use">Keeping this one</span>'
      : held.length ? '' : `<button class="btn quiet" data-keep="${gi}:${ii}">Keep this one</button>`}
          </div>`).join('')}
        </div>
      </div>`;
  }).join('')}` : '<div class="band">Exact copies</div><div class="why">Nothing here is an exact copy of anything else.</div>'}

    ${versions.length ? `<div class="band">Possible versions</div>
      <div class="why" style="margin-bottom:8px">Related, but not the same. Compare them and decide — nothing here is merged, and neither one is picked for you.</div>
      ${versions.map((g, gi) => `<div class="edit-card">
        <div class="edit-body" style="display:block">
          <div class="del-row"><span class="del-name">${esc(g.items[0].name)}</span><span class="del-why">${esc(tell(g.items[0]))}</span></div>
          <div class="del-row"><span class="del-name">${esc(g.items[1].name)}</span><span class="del-why">${esc(tell(g.items[1]))}</span></div>
          <div class="why">${esc(g.why.join('; '))}</div>
          <div class="row-actions" style="margin-top:8px;margin-bottom:0">
            <button class="btn" data-compare="${gi}">Compare</button>
          </div>
        </div>
      </div>`).join('')}` : ''}
    <div class="sheet-actions"><button class="btn primary" data-close>Done</button></div>
  `, (root) => {
    root.addEventListener('click', async (e) => {
      const keep = e.target.closest('[data-keep]');
      if (keep) {
        const [gi, ii] = keep.dataset.keep.split(':').map(Number);
        const group = copies[gi];
        tidy.picked.clear();
        for (const [k, item] of group.items.entries()) if (k !== ii && !item.used) tidy.picked.add(item.id);
        renderCharacters();
        closeSheet();
        toast(`Keeping ${group.items[ii].name}.`, { sub: `${num(tidy.picked.size)} other ${tidy.picked.size === 1 ? 'copy' : 'copies'} selected` });
        return;
      }
      const cmp = e.target.closest('[data-compare]');
      if (cmp) {
        const g = versions[Number(cmp.dataset.compare)];
        compareTwo(g.items[0], g.items[1], () => showCopiesAndVersions());
      }
    });
  });
}

/** Two sources, side by side, in counts first and detail only if asked. */
async function compareTwo(a, b, back) {
  sheet('Compare', '<div class="empty">Reading both…</div>');
  let c;
  try { c = await get(`/api/library/compare/${a.id}/${b.id}`); } catch (err) {
    sheet('Compare', `<div class="notice">${esc(err.message)}</div>
      <div class="sheet-actions"><button class="btn primary" data-close>Close</button></div>`);
    return;
  }
  const list = (items, label) => (items.length ? `<details class="cmp-more"><summary>${esc(label)} · ${num(items.length)}</summary>
    <div class="del-list">${items.slice(0, 60).map((x) => `<div class="del-row"><span class="del-name">${esc(x.title)}</span>
      ${x.how ? `<span class="del-why">${esc(x.how.join(', '))}</span>` : ''}</div>`).join('')}
    ${items.length > 60 ? `<div class="why">and ${num(items.length - 60)} more</div>` : ''}</div></details>` : '');
  sheet('Compare', `
    <div class="rv-facts">
      <div class="stat-row"><span>${esc(c.a.name)}</span><span>${num(c.a.entries)} entries</span></div>
      <div class="stat-row"><span>${esc(c.b.name)}</span><span>${num(c.b.entries)} entries</span></div>
    </div>
    <div class="rv-facts" style="margin-top:12px">
      <div class="stat-row"><span>The same in both</span><span>${num(c.same)}</span></div>
      <div class="stat-row"><span>Only in the first</span><span>${num(c.removed)}</span></div>
      <div class="stat-row"><span>Only in the second</span><span>${num(c.added)}</span></div>
      <div class="stat-row"><span>Changed</span><span>${num(c.changed)}</span></div>
    </div>
    <p class="rv-hint">Nexus does not pick one. Keeping both is a perfectly good answer.</p>
    ${list(c.details.changed, 'What changed')}
    ${list(c.details.removed, 'Only in the first')}
    ${list(c.details.added, 'Only in the second')}
    <div class="sheet-actions"><button class="btn quiet" id="cmp-back">Back</button></div>
  `, (root) => $('#cmp-back', root).addEventListener('click', back));
}

// ------------------------------------------------------------------ import

$('#file-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;

  const done = [];
  const failed = [];
  // Files that are not plainly one person wait here. They do not hold up the
  // ones that are: twenty characters and one campaign module should be twenty
  // characters imported and one thing to look at, not twenty-one questions.
  const queue = [];
  const dupes = [];
  for (const f of files) {
    try {
      const r = await api('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name) },
        body: await f.arrayBuffer(),
      });

      // The picture, done here rather than on the server.
      //
      // A card IS its image, and the ones worth having are one to three
      // megabytes. The server used to keep the PNG whole and skip anything
      // over about 650kb — silently, so a card would simply arrive with no
      // face and nothing said. The browser can resize, so it does: the art
      // keeps its shape, comes down to a few tens of kilobytes, and no card
      // is too big any more.
      if (r.kind === 'duplicate') { dupes.push({ ...r, file: f }); continue; }
      if (r.needsReview) { queue.push({ ...r, file: f }); continue; }

      if (r.kind === 'character' && /^image\//.test(f.type)) {
        try {
          const dataUri = await shrinkFit(f, 512);
          await post(`/api/avatar/character/${r.id}`, { dataUri });
          r.gotPicture = true;
        } catch {
          r.notes = [...(r.notes || []), { level: 'info', text: 'The card came in, but its picture could not be read.' }];
        }
      }
      done.push(r);
    } catch (err) {
      failed.push({ name: f.name, message: err.message });
    }
  }
  await loadLibrary();
  showImportReport(done, failed, queue, dupes);
});

/**
 * Pull a card, lorebook or preset straight off a link.
 *
 * Anything reachable works: a raw file on GitHub, a paste host, a direct
 * image link. Some sites refuse anything that is not a browser, and a few
 * refuse whole countries; when that happens it says so rather than failing
 * quietly.
 */
function importFromUrl() {
  sheet('Add from a link', `
    <div class="why" style="margin-bottom:12px">
      Paste a link to a character card, a lorebook or a preset. A direct link to the file itself:
      the page it sits on is usually not the file.
    </div>
    <div class="field">
      <label for="url-in">Link</label>
      <input type="url" id="url-in" placeholder="https://…" enterkeyhint="go" autocapitalize="off" spellcheck="false">
    </div>
    <div class="notice">
      <b>If a site refuses.</b> Some of them block anything that is not a browser, and a few block whole countries.
      Chub is one of those from here. Download the file in your browser and use <b>From a file</b> instead; it is the same card either way.
    </div>
    <div class="sheet-actions">
      <button class="btn quiet" data-close>Cancel</button>
      <button class="btn primary" id="url-go">Fetch it</button>
    </div>`, (root) => {
    const go = async () => {
      const url = $('#url-in', root).value.trim();
      if (!url) { toast('Paste a link first.'); return; }
      const btn = $('#url-go', root);
      btn.disabled = true;
      btn.textContent = 'Fetching…';
      try {
        const r = await post('/api/import/url', { url });
        closeSheet();
        await loadLibrary();
        toast(`${r.name} added.`, { kind: 'good', sub: r.detail });
      } catch (err) {
        toast(err.message, { kind: 'bad', ms: 9000 });
        btn.disabled = false;
        btn.textContent = 'Fetch it';
      }
    };
    $('#url-go', root).addEventListener('click', go);
    $('#url-in', root).addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
}

/**
 * What just happened, at the size it deserves.
 *
 * Twenty cards is one sentence and a count, not twenty rows. Anything that
 * actually needs you gets its own screen, reached from here, and only then.
 */
/**
 * What arrived with a card, said in terms of the card.
 *
 * Not "Character card, version 2": which generation of which format a file
 * happened to use is a fact about the file, not about the person in it. It is
 * kept, and it is under "Where this came from" where it is worth having.
 */
function camein(d) {
  const bits = [];
  if (d.picture || d.gotPicture) bits.push('with artwork');
  const lore = (d.notes || []).find((n) => /lorebook of (\d+)/i.test(n.text));
  if (lore) bits.push(`${/lorebook of (\d+)/i.exec(lore.text)[1]} lore entries`);
  if (d.starts > 1) bits.push(`${d.starts} ways to begin`);
  return bits.length ? ` — ${esc(bits.join(', '))}` : '';
}

function showImportReport(done, failed, queue = [], dupes = []) {
  const notes = done.flatMap((d) => (d.notes || []).map((n) => ({ ...n, from: d.name })));
  const people = done.filter((d) => d.kind === 'character');
  const withArt = people.filter((d) => d.picture || d.gotPicture).length;
  const tags = new Set();
  for (const c of state.library?.characters || []) for (const t of c.tags || []) tags.add(String(t).toLowerCase());
  const books = done.filter((d) => (d.notes || []).some((n) => /lorebook of/i.test(n.text))).length;

  // A short list reads better as a list. A long one reads better as a number.
  const summary = done.length > 4
    ? `<div class="tally">
         <b>${num(done.length)}</b> brought in
         ${withArt ? `<span>${num(withArt)} with artwork</span>` : ''}
         ${tags.size ? `<span>${num(tags.size)} tags in your library</span>` : ''}
         ${books ? `<span>${num(books)} carried their own lore</span>` : ''}
       </div>`
    : (done.length ? `<p style="font-size:14.5px;color:var(--ink-soft);margin:0 0 14px">
        ${done.map((d) => `<b style="color:var(--ink);font-weight:500">${esc(d.name)}</b>${camein(d)}`).join('<br>')}
      </p>` : '');

  const body = `
    ${summary}
    ${queue.length ? `
      <div class="needs">
        <h3>${num(queue.length)} ${queue.length === 1 ? 'file needs a look' : 'files need a look'}</h3>
        <p>${queue.map((q) => esc(q.name)).join(', ')} ${queue.length === 1
    ? 'is not a person. It looks like something else.'
    : 'are not people. They look like something else.'}</p>
        <button class="btn primary" id="go-review">Have a look</button>
      </div>` : ''}
    ${dupes.length ? `<div class="why" style="margin-bottom:12px">
      ${num(dupes.length)} ${dupes.length === 1 ? 'file was' : 'files were'} already in your library, byte for byte, so ${dupes.length === 1 ? 'it was' : 'they were'} skipped: ${dupes.map((d) => esc(d.name)).join(', ')}.
    </div>` : ''}
    ${failed.length ? `<div class="notice" style="margin-bottom:14px">
      ${failed.map((f) => `<div><b>${esc(f.name)}</b><br>${esc(f.message)}</div>`).join('')}
    </div>` : ''}
    ${notes.length && done.length <= 4 ? `<h3 style="font-size:14px;margin:0 0 8px">Worth knowing</h3>
      <div class="fired">${notes.map((n) => `
        <div class="fired-row"><span class="t" style="white-space:normal">${esc(n.text)}</span></div>`).join('')}</div>` : ''}
    <div class="sheet-actions"><button class="btn ${queue.length ? 'quiet' : 'primary'}" data-close>Done</button></div>`;

  const title = failed.length ? 'Imported, with problems'
    : (queue.length && !done.length) ? 'Worth a look'
      : 'Imported';
  sheet(title, body, (root) => {
    root.addEventListener('click', (e) => {
      if (e.target.closest('#go-review')) reviewQueue(queue, 0);
    });
  });
}

// What each destination means, in the words you would use about it rather
// than the words the format uses.
const ROLE_WORDS = {
  character: ['Character', 'A person you can use in stories.'],
  scenario: ['Scenario', 'A ready-made situation you can start a new story from.'],
  framework: ['World', 'A reusable world and campaign setup that many stories can use.'],
};

/**
 * One file at a time, with what it is and the chance to say otherwise.
 *
 * It shows the whole package in one place because it IS one package: a world,
 * its lore, its openings and its narrator notes came out of a single file and
 * should not look like four unrelated things that turned up at once.
 */
function reviewQueue(queue, i) {
  const item = queue[i];
  if (!item) { loadLibrary().then(() => closeSheet()); return; }
  const p = item.plan;
  const [word, meaning] = ROLE_WORDS[p.role] || [p.role, ''];
  const sure = { high: '', medium: 'Not completely sure.', low: 'Really not sure about this one.' }[p.confidence] || '';

  sheet(queue.length > 1 ? `Have a look (${i + 1} of ${queue.length})` : 'Have a look', `
    <div class="review">
      <h3 class="review-name">${esc(item.name)}</h3>
      ${sure ? `<p class="review-hedge">${esc(sure)}</p>` : ''}
      <p class="review-verdict">This looks like a <b>${esc(word)}</b>.</p>
      <p class="review-why">${esc(meaning)}</p>
      ${p.because?.length ? `<p class="review-why dim">Because ${esc(p.because.slice(0, 2).join(', and '))}.</p>` : ''}

      ${p.alternatives?.length ? `<p class="review-why">It could also be a <b>${esc(ROLE_WORDS[p.alternatives[0].role]?.[0] || p.alternatives[0].role)}</b>.</p>` : ''}

      <h4>What is in it</h4>
      ${contents(p.parts.map((x) => [x.label, x.detail]))}

      <h4>What that makes</h4>
      <ul class="contents made">
        ${p.resources.map((r) => `<li><b>${esc(r.label)}</b><span>${esc(r.detail)}</span></li>`).join('')}
      </ul>
      <p class="review-why dim">All of it from the one file, and joined up.</p>

      <div class="field">
        <label for="role-pick">Bring it in as</label>
        <select id="role-pick">
          ${p.choices.map((c) => `<option value="${esc(c.role)}"${c.role === p.role ? ' selected' : ''}>${esc(ROLE_WORDS[c.role]?.[0] || c.label)}</option>`).join('')}
        </select>
        <p class="hint" id="role-hint">${esc(meaning)}</p>
      </div>
    </div>
    <div class="sheet-actions">
      <button class="btn" id="skip-one">Skip</button>
      <button class="btn primary" id="take-one">Bring it in</button>
    </div>
  `, (root) => {
    const pick = $('#role-pick', root);
    pick.addEventListener('change', () => {
      $('#role-hint', root).textContent = ROLE_WORDS[pick.value]?.[1] || '';
    });
    $('#skip-one', root).addEventListener('click', () => reviewQueue(queue, i + 1));
    $('#take-one', root).addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await post('/api/import/commit', { importId: item.importId, role: pick.value });
        toast(`${item.name} — brought in`);
      } catch (err) {
        toast(err.message || 'That could not be brought in.');
      }
      reviewQueue(queue, i + 1);
    });
  });
}

// --------------------------------------------------------------- new story

// ------------------------------------------------------------ a new story
//
// Three steps rather than one long form. You are setting up a story, which is
// a thing with a shape: what it is, who is in it, what it knows. None of the
// steps has to be filled in; you can walk straight through and start writing.

const draft = { title: '', premise: '', characterIds: [], lorebookIds: [] };

$('#btn-new-story').addEventListener('click', () => {
  draft.title = '';
  draft.premise = '';
  draft.characterIds = [];
  draft.lorebookIds = [];
  newStoryStep(1);
});

function stepBar(n) {
  const names = ['What it is', 'Who leads', 'Sources', 'Review'];
  return `<div class="steps">${names.map((t, i) => `
    <span class="step${i + 1 === n ? ' is-on' : ''}${i + 1 < n ? ' done' : ''}">
      <b>${i + 1}</b>${esc(t)}
    </span>`).join('')}</div>`;
}

function newStoryStep(n) {
  const L = state.library;

  if (n === 1) {
    sheet('Begin a story', `
      ${stepBar(1)}
      <div class="field">
        <label for="story-name">Call it</label>
        <input type="text" id="story-name" value="${esc(draft.title)}" placeholder="Left blank, it takes the character's name">
      </div>
      <div class="field">
        <label for="story-premise">What is this story?</label>
        <div class="why">
          The frame everything else stands in: where and when it happens, what has already happened, what it is about.
          A few lines is plenty, and you can leave it empty and find out as you go.
        </div>
        <textarea id="story-premise" rows="7" placeholder="Pre-canon UA, the year before Class 1-A. Reiko transferred in mid-term and nobody knows why…">${esc(draft.premise)}</textarea>
      </div>
      <div class="sheet-actions">
        <button class="btn quiet" data-close>Cancel</button>
        <button class="btn primary" id="next">Next</button>
      </div>`, (root) => {
      $('#next', root).addEventListener('click', () => {
        draft.title = $('#story-name', root).value.trim();
        draft.premise = $('#story-premise', root).value.trim();
        newStoryStep(2);
      });
    });
    return;
  }

  if (n === 2) {
    sheet('Begin a story', `
      ${stepBar(2)}
      <div class="field">
        <label>Who leads it?</label>
        <div class="why">The first one you pick leads, and their greeting opens the story. Anyone else you pick joins the cast, and you can change their part when you review it.</div>
        ${L.characters.length
        ? picker(L.characters.map((c) => ({ id: c.id, title: c.name, sub: (c.description || '').slice(0, 70) })),
          { selected: new Set(draft.characterIds) })
        : '<div class="empty">No characters yet.</div>'}
      </div>
      <button class="btn" id="make-char">+ Write a new character</button>
      <div class="sheet-actions">
        <button class="btn quiet" id="back1">Back</button>
        <button class="btn primary" id="next">Next</button>
      </div>`, (root) => {
      wirePicker(root);
      $('#back1', root).addEventListener('click', () => newStoryStep(1));
      $('#make-char', root).addEventListener('click', () => {
        draft.characterIds = picked(root);
        characterBuilder(null, async (id) => {
          await loadLibrary();
          draft.characterIds = [...new Set([...draft.characterIds, id])];
          newStoryStep(2);
        });
      });
      $('#next', root).addEventListener('click', () => {
        draft.characterIds = picked(root);
        if (!draft.characterIds.length) { toast('Pick at least one, or write one.'); return; }
        newStoryStep(3);
      });
    });
    return;
  }

  sheet('Begin a story', `
    ${stepBar(3)}
    <div class="field">
      <label>What is it made from?</label>
      <div class="why">A source is a package of material: its people, places, families and history. Nexus reads it and shows you what it found before anything is added. You do not need one to start.</div>
      ${sourcePicker(L.lorebooks, new Set(draft.lorebookIds))}
    </div>
    <div class="sheet-actions">
      <button class="btn quiet" id="back2">Back</button>
      <button class="btn primary" id="go">${draft.lorebookIds.length ? 'Read it' : 'Review'}</button>
    </div>`, (root) => {
    wirePicker(root);
    const go = $('#go', root);
    root.addEventListener('change', () => { go.textContent = picked(root).length ? 'Read it' : 'Review'; });
    $('#back2', root).addEventListener('click', () => { draft.lorebookIds = picked(root); newStoryStep(2); });
    go.addEventListener('click', () => {
      draft.lorebookIds = picked(root);
      beginReview({
        mode: 'new',
        title: draft.title,
        premise: draft.premise,
        characterIds: draft.characterIds,
        lorebookIds: draft.lorebookIds,
        back: () => newStoryStep(3),
      });
    });
  });
}

/** Source packages to choose from, largest-first within the list the library already sorts. */
function sourcePicker(books, selected) {
  if (!books.length) return '<div class="empty">No sources yet. Add one from a file any time.</div>';
  return picker(books.map((b) => ({
    id: b.id, title: b.name,
    sub: `${num(b.entry_count)} entries${b.always_on ? `, ${num(b.always_on)} always on` : ''}`,
  })), { selected });
}

// ================================================================ review
//
// Source → Composition Draft → Review → Story.
//
// Adding a package used to attach a file and say nothing about what was in
// it. This reads it first and shows the story it makes: who is in it, where it
// happens, what it remembers. Nothing is written until Start or Apply, and
// then all of it is written at once.
//
// Every item on these screens is a reference to an entry that already exists.
// Opening one shows that entry, not a copy of it.

const CAST_LABEL = {
  lead: 'Lead', main: 'Main', supporting: 'Supporting', background: 'Background',
  known: 'Known / Available', excluded: 'Excluded',
};
const CAST_ORDER = ['lead', 'main', 'supporting', 'background', 'known', 'excluded'];
// The two parts that are not the cast, said in terms of what they do.
const ROLE_MEANS = {
  known: 'Exists in this story and may appear when relevant.',
  excluded: 'Kept in the source, ignored by this story.',
};
const IN_CAST = new Set(['lead', 'main', 'supporting', 'background']);
/**
 * What a row's role means for this row.
 *
 * Leaving out somebody the material knows as a person is one decision about
 * that person — not a decision about each thing written about them — and it is
 * about this story only. Say so, and name nothing technical.
 */
const roleMeans = (role, r) => (role === 'excluded' && r.semantic?.entityId
  ? `${r.name} is left out of this story. Nothing is removed: they stay in your library with everything known about them, and you can bring them back here any time.`
  : ROLE_MEANS[role] || '');
const SECTION_HELP = {
  places: 'Where it happens.',
  factions: 'Families, crews and organisations.',
  backstory: 'What already happened, and what is true about the people in it.',
  rules: 'How this world works.',
  directions: 'How the story should be written.',
  events: 'Things that happen, or have happened.',
  items: 'Objects that matter.',
  other: 'Everything that does not fit a heading, and anything worth a second look.',
};

let rv = null;

// The draft sections, in the order a story is read.
const DRAFT_SECTIONS = ['places', 'factions', 'backstory', 'rules', 'directions', 'events', 'items', 'other'];
const SECTION_LABEL = {
  places: 'Locations', factions: 'Factions', backstory: 'Background & Premise', rules: 'Rules',
  directions: 'Directions', events: 'Events', items: 'Items', other: 'Other',
};

/** Where a person or entry came from, in a few quiet words. */
const originWords = (x) => {
  if (x.origin === 'generated') return x.edited ? 'Suggested by Nexus · edited' : 'Suggested by Nexus';
  if (x.origin === 'manual') return 'Written by you';
  if (x.backing === 'card') return 'From your library';
  return x.libraryCardId ? 'From a source · has a card too' : 'From a source';
};
const isSuggested = (x) => x.origin === 'generated' || x.origin === 'manual';

/** A link's identity, so removing an item never moves another link's tick. */
const linkKey = (l) => `${l.entryId || l.fromDraftId}>${l.characterId || l.aboutId || l.aboutDraftId}`;

/** POST with a signal, since generating can take a while and can be cancelled. */
async function postWith(path, body, signal) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const text = await res.text();
  let out = null;
  try { out = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) {
    if (res.status === 401 && out?.locked) { showGate(); throw new Error(out.error); }
    const err = new Error(out?.error || `Something went wrong (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return out;
}

/**
 * Read the chosen sources into a draft and open the review.
 *
 *   mode 'new'      — a story that does not exist yet
 *   mode 'existing' — sources being added to a story that does
 *
 * Every draft, however it starts, comes from the same place and is reviewed on
 * the same screens: sources are read by the composer, an idea is developed by
 * the Story Builder, and both arrive as one kind of draft.
 */
async function beginReview(opts) {
  sheet(opts.heading || (opts.mode === 'new' ? 'Begin a story' : 'Add a source'), `
    ${opts.mode === 'new' ? stepBar(4) : ''}
    <div class="rv-reading">
      <div class="rv-spinner" aria-hidden="true"></div>
      <p>${opts.lorebookIds.length ? 'Reading your source…' : 'Getting the story ready…'}</p>
    </div>`);

  if (!state.library) await loadLibrary();
  let draft;
  try {
    draft = await post('/api/builder/draft', opts.mode === 'new'
      ? { mode: 'organize', lorebookIds: opts.lorebookIds, characterIds: opts.characterIds, premise: opts.premise, title: opts.title, personaId: opts.personaId ?? null }
      : { mode: 'organize', lorebookIds: opts.lorebookIds, storyId: opts.storyId });
  } catch (err) {
    sheet('Something went wrong', `<div class="notice">${esc(err.message)}</div>
      <div class="sheet-actions"><button class="btn primary" id="rv-back">Back</button></div>`,
    (root) => $('#rv-back', root).addEventListener('click', () => opts.back()));
    return;
  }
  openReview(opts, draft);
}

/** Put a draft in front of the person. */
function openReview(opts, draft) {
  rv = {
    ...opts,
    personaId: opts.mode === 'new' ? (opts.personaId ?? null) : undefined,
    draft,
    roles: new Map(),
    links: new Map(),
    recursion: opts.recursion || {},
    promote: new Set(),
    castFilter: 'cast',
    castFind: '',
    // Answers to "is this invented thing somebody who already exists?".
    // Apply waits until every open question here has one.
    dupes: new Map(),
    // Whose knowledge this story should carry. Empty on purpose: having it in
    // the library is not asking for it in the story.
    reuse: new Set(),
  };
  for (const r of draft.casting) rv.roles.set(r.key, r.suggested);
  for (const l of draft.links) rv.links.set(linkKey(l), l.approved);
  reviewRoot();
}

const roleOf = (row) => rv.roles.get(row.key);
const leadRow = () => rv.draft.casting.find((r) => roleOf(r) === 'lead') || null;
const suggestedCount = (items) => items.filter(isSuggested).length;
/** Whether Nexus can be asked for more on this draft. */
const canSuggest = () => !!rv.builder || rv.draft.invented > 0 || rv.draft.mode !== 'organize';

/** The maybe-duplicates still waiting for an answer. */
const openDupes = () => (rv.draft.reconciliation?.items || [])
  .filter((x) => x.decision === 'possible' && !rv.dupes.has(x.draftId));

/**
 * Where something Nexus invented stands against who already exists: somebody
 * the story already has, somebody it might already have, or somebody new.
 * "New" is the ordinary case and says nothing; the other two say a little.
 */
const dupeOf = (draftId) => (rv.draft.reconciliation?.items || []).find((x) => x.draftId === draftId) || null;
function reuseFlag(draftId) {
  const x = dupeOf(draftId);
  if (!x) return '';
  const answer = rv.dupes.get(draftId);
  if (x.decision === 'reuse') return `<span class="rv-flag">already in this story</span>`;
  if (x.decision !== 'possible') return '';
  if (answer?.use === 'existing') return `<span class="rv-flag">using ${esc((x.candidates.find((c) => c.id === answer.id) || {}).name || 'the existing one')}</span>`;
  if (answer?.use === 'new') return '<span class="rv-flag">kept as new</span>';
  return '<span class="rv-flag warn">may already exist</span>';
}

/** What stops the story starting, said plainly, or nothing. */
function startBlocker() {
  const lead = leadRow();
  if (!lead) return `Choose a lead in Casting before ${rv.mode === 'new' ? 'starting' : 'applying'}.`;
  if (lead.origin === 'generated' && !rv.promote.has(lead.draftId)) {
    return `${lead.name} leads, but has no character card yet. In Casting, turn on “Make this a full character”, or choose a lead from your library.`;
  }
  const open = openDupes();
  if (open.length) {
    return `${open[0].name} may be ${open[0].candidates.map((c) => c.name).join(' or ')}, who already exists. Decide under “May already exist” before ${rv.mode === 'new' ? 'starting' : 'applying'}.`;
  }
  return '';
}

// How to name the thing in "this may be the same ___ as".
const SAME_AS = {
  person: 'person', place: 'place', faction: 'group', item: 'thing', event: 'event', concept: 'idea',
};

/**
 * The Builder said "Marco Rossi"; the story already knows Marco. Nobody merges
 * that but the reader, and nothing applies while the question stands.
 */
function dupeCards() {
  const items = (rv.draft.reconciliation?.items || []).filter((x) => x.decision === 'possible');
  if (!items.length) return '';
  return `
    <div class="band">May already exist</div>
    <div class="why" style="margin-bottom:10px">Nexus never merges these on its own. Say which each one is.</div>
    ${items.map((x) => {
    const chosen = rv.dupes.get(x.draftId) || null;
    return `
      <div class="edit-card rv-dupe">
        <div class="edit-head"><b>${esc(x.name)}</b><span class="n">${esc(x.type)}</span></div>
        <div class="edit-body" style="display:block">
          ${/* What the question is, then why it is being asked. Never a claim
                that two different names are the same words. */''}
          <div class="why">This may be the same ${esc(SAME_AS[x.type] || 'one')} as ${esc(x.candidates.map((c) => c.name).join(' or '))}.</div>
          <div class="why dim" style="margin-top:2px">${esc(x.candidates[0].why)}</div>
          <div class="row-actions" style="margin-top:8px">
            ${x.candidates.map((c) => `<button class="btn${chosen?.use === 'existing' && chosen.id === c.id ? ' primary' : ''}"
              data-dupe-use="${esc(x.draftId)}" data-dupe-id="${esc(c.id)}">Use ${esc(c.name)}</button>`).join('')}
            <button class="btn${chosen?.use === 'new' ? ' primary' : ''}" data-dupe-new="${esc(x.draftId)}">Keep as new</button>
          </div>
          ${chosen?.use === 'existing' ? `<div class="why" style="margin-top:6px">The existing one will be used; this copy will not be written.</div>`
    : chosen?.use === 'new' ? '<div class="why" style="margin-top:6px">Kept apart, and remembered as a separate one from now on.</div>' : ''}
        </div>
      </div>`;
  }).join('')}`;
}

/** The overview: a story, not a list of rows. */
function reviewRoot() {
  const d = rv.draft;
  const isNew = rv.mode === 'new';
  const inCast = d.casting.filter((r) => IN_CAST.has(roleOf(r)));
  const known = d.casting.filter((r) => roleOf(r) === 'known').length;
  const lead = leadRow();
  const personas = state.library?.personas || [];
  const other = d.sections.find((s) => s.id === 'other');
  const otherCount = (other?.count || 0) + (d.unclear?.length || 0);
  const title = rv.title || d.story?.title?.value || '';
  const premise = rv.premise || d.story?.premise?.value || '';
  const opening = d.story?.opening || null;
  const blocker = startBlocker();

  const row = (id, label, count, sub, { dim = false } = {}) => `
    <button class="rv-row${dim ? ' dim' : ''}" data-open="${esc(id)}">
      <span class="rv-row-main">
        <span class="rv-row-label">${esc(label)}</span>
        ${sub ? `<span class="rv-row-sub">${esc(sub)}</span>` : ''}
      </span>
      <span class="rv-count">${num(count)}</span>
      <span class="rv-chev" aria-hidden="true">›</span>
    </button>`;
  const sectionSub = (s) => (suggestedCount(s.items) ? `${num(suggestedCount(s.items))} suggested by Nexus` : '');

  const castSub = [
    lead ? `${lead.name} leads` : 'No lead chosen',
    inCast.length > 1 ? `${num(inCast.length - 1)} more in the cast` : '',
    known ? `${num(known)} known` : '',
  ].filter(Boolean).join(' · ');

  const openingSub = !opening ? (lead?.backing === 'card' ? 'Your lead’s greeting' : 'None yet')
    : opening.origin === 'source' ? 'Your lead’s greeting'
      : `${opening.origin === 'generated' ? 'Suggested by Nexus' : 'Written by you'} · not written until the story starts`;

  sheet(rv.heading || (isNew ? 'Review story' : 'Review additions'), `
    ${isNew && !rv.builder ? stepBar(4) : ''}

    ${isNew ? `
    <div class="rv-block">
      <div class="rv-label">Story</div>
      <button class="rv-row rv-story" data-open="story">
        <span class="rv-row-main">
          <span class="rv-row-label">${esc(title || 'Untitled story')}</span>
          <span class="rv-row-sub rv-premise">${esc(premise || 'No premise yet.')}</span>
        </span>
        <span class="rv-chev" aria-hidden="true">›</span>
      </button>
    </div>` : ''}

    <div class="rv-block">
      <div class="rv-label">You</div>
      ${isNew ? `
        <div class="field rv-you">
          <select id="rv-persona" aria-label="Who you play">
            <option value=""${!rv.personaId ? ' selected' : ''}>Nobody in particular</option>
            ${personas.map((p) => `<option value="${esc(p.id)}"${rv.personaId === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>
          <div class="why">Optional. Who you play in this story. You can set it later too.</div>
        </div>` : `
        <div class="rv-static">${esc(state.story?.persona?.name || 'Nobody in particular')}</div>`}
    </div>

    <div class="rv-block">
      <div class="rv-label">The story</div>
      <div class="rv-rows">
        ${row('casting', 'Casting', inCast.length, [castSub, suggestedCount(d.casting) ? `${num(suggestedCount(d.casting))} suggested by Nexus` : ''].filter(Boolean).join(' · '))}
        ${d.sections.filter((s) => s.id !== 'other').map((s) => row(s.id, s.label, s.count, sectionSub(s), { dim: !s.count })).join('')}
        ${row('other', 'Other', otherCount, other ? sectionSub(other) : '', { dim: !otherCount })}
        ${isNew ? `<button class="rv-row" data-open="opening">
          <span class="rv-row-main"><span class="rv-row-label">Opening</span><span class="rv-row-sub">${esc(openingSub)}</span></span>
          <span class="rv-chev" aria-hidden="true">›</span>
        </button>` : ''}
      </div>
    </div>

    <div class="rv-block">
      <div class="rv-label">Sources</div>
      ${d.sources?.length ? `<button class="rv-row" data-open="sources">
        <span class="rv-row-main">
          ${/* One line per source. Two sources can genuinely carry the same
                name — the same pack saved twice, at different sizes — and two
                identical lines say nothing, so those say how big each one is. */''}
          ${d.sources.map((s) => {
    const sameName = d.sources.filter((o) => o.name === s.name).length > 1;
    return `<span class="rv-row-label">${esc(s.name)}${sameName ? `<span class="rv-row-tell">${num(s.entries)} entries</span>` : ''}</span>`;
  }).join('')}
          <span class="rv-row-sub">${num(d.totals?.entries || 0)} entries, all of them still in their source</span>
        </span>
        <span class="rv-chev" aria-hidden="true">›</span>
      </button>` : `<div class="rv-static dim">${rv.builder ? 'None. Nexus built this from your idea.' : 'None. The story starts from its cast alone.'}</div>`}
    </div>

    ${dupeCards()}

    ${d.invented ? '<p class="rv-promise">Anything marked “Suggested by Nexus” is a proposal. Edit it, remove it, or keep it; only what is here when you start becomes part of the story.</p>'
    : d.sources?.length ? '<p class="rv-promise">Nothing here was invented. Every person, place and note is an entry from your source, and none of it is copied.</p>' : ''}

    ${(d.casting.length || d.sections.some((s) => s.count)) ? `
    <div class="rv-assist">
      <button class="btn" id="rv-fill">Help me fill the gaps</button>
      <span class="rv-hint">Nexus suggests only what this story is missing.</span>
    </div>` : ''}

    ${blocker ? `<div class="notice">${esc(blocker)}</div>` : ''}

    <div class="sheet-actions">
      <button class="btn quiet" id="rv-back">Back</button>
      <button class="btn primary" id="rv-go"${blocker ? ' disabled' : ''}>${isNew ? 'Start story' : 'Apply to story'}</button>
    </div>
  `, (root) => {
    const sel = $('#rv-persona', root);
    if (sel) sel.addEventListener('change', () => { rv.personaId = sel.value || null; });
    $('#rv-back', root).addEventListener('click', () => rv.back());
    $('#rv-go', root).addEventListener('click', (e) => (isNew ? startReviewed(e.currentTarget) : applyReviewed(e.currentTarget)));
    const fill = $('#rv-fill', root);
    if (fill) fill.addEventListener('click', () => suggest({ fill: true }, reviewRoot));
    root.addEventListener('click', (e) => {
      const use = e.target.closest('[data-dupe-use]');
      if (use) { rv.dupes.set(use.dataset.dupeUse, { use: 'existing', id: use.dataset.dupeId }); reviewRoot(); return; }
      const keep = e.target.closest('[data-dupe-new]');
      if (keep) { rv.dupes.set(keep.dataset.dupeNew, { use: 'new' }); reviewRoot(); return; }
      const o = e.target.closest('[data-open]');
      if (!o) return;
      const to = o.dataset.open;
      if (to === 'casting') reviewCasting();
      else if (to === 'sources') reviewSources();
      else if (to === 'story') reviewStory();
      else if (to === 'opening') reviewOpening();
      else reviewSection(to);
    });
  });
}

const reviewBack = () => `<button class="btn quiet rv-backrow" data-rv-root>&larr; Review</button>`;
function wireReviewBack(root) {
  root.addEventListener('click', (e) => { if (e.target.closest('[data-rv-root]')) reviewRoot(); });
}

/**
 * Ask Nexus for suggestions on the draft as it stands.
 *
 *   { part }  suggest one part again: only earlier suggestions there are replaced
 *   { item }  suggest one item again
 *   { fill }  suggest whatever the draft is missing
 *
 * Everything the person decided — parts, promotions, ticked links, edits,
 * removals — goes with the draft and comes back untouched.
 */
async function suggest(scope, back) {
  const busy = { part: scope.part, item: scope.item, fill: scope.fill };
  const words = busy.fill ? 'Looking for what is missing…'
    : busy.part === 'opening' ? 'Writing an opening…'
      : busy.part === 'people' ? 'Finding people for the story…'
        : busy.item ? 'Suggesting something else…'
          : `Suggesting ${String(SECTION_LABEL[busy.part] || 'more').toLowerCase()}…`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  sheet('Nexus is working', `
    <div class="rv-reading"><div class="rv-spinner" aria-hidden="true"></div><p>${esc(words)}</p></div>
    <div class="sheet-actions"><button class="btn quiet" id="sg-cancel">Cancel</button></div>`, (root) => {
    $('#sg-cancel', root).addEventListener('click', () => controller.abort());
  });

  // What goes to the server says what the person decided, so suggestions fit around it.
  const sent = structuredClone(rv.draft);
  for (const r of sent.casting) r.suggested = roleOf(r);
  const before = new Map(rv.draft.casting.map((r) => [r.key, r.suggested]));
  try {
    const next = await postWith(busy.fill ? '/api/builder/fill' : '/api/builder/regenerate',
      busy.fill ? { draft: sent } : { draft: sent, scope: busy.item ? { item: busy.item } : { part: busy.part } },
      controller.signal);
    // Rows that were already here keep what was originally suggested for them,
    // and the part the person gave them.
    for (const r of next.casting) {
      if (before.has(r.key)) r.suggested = before.get(r.key);
      if (!rv.roles.has(r.key)) rv.roles.set(r.key, r.suggested);
    }
    const alive = new Set(next.casting.map((r) => r.key));
    for (const k of [...rv.roles.keys()]) if (!alive.has(k)) rv.roles.delete(k);
    for (const l of next.links) if (!rv.links.has(linkKey(l))) rv.links.set(linkKey(l), l.approved);
    const draftIds = new Set(next.casting.filter((r) => r.draftId).map((r) => r.draftId));
    for (const id of [...rv.promote]) if (!draftIds.has(id)) rv.promote.delete(id);
    rv.draft = next;
    const warn = (next.generation?.warnings || []).length;
    if (next.generation?.called === false) toast('Nothing is missing, so there was nothing to suggest.');
    else toast('Nexus made suggestions.', { kind: 'good', sub: warn ? 'Some of what came back did not fit and was left out.' : '' });
  } catch (err) {
    toast(err.name === 'AbortError' ? 'Stopped. Nothing was changed.' : builderTrouble(err), { kind: 'bad', ms: 8000 });
  } finally {
    clearTimeout(timer);
  }
  back();
}

/** A failure, in words about the story rather than the machinery. */
function builderTrouble(err) {
  if (err.name === 'AbortError') return 'That took too long, so it was stopped. Nothing was lost; try again.';
  if (err.status === 422) return 'Nexus could not put together a usable draft that time. Nothing was lost; try again.';
  return err.message || 'Something went wrong. Nothing was lost; try again.';
}

/** The story's title and premise. */
function reviewStory() {
  const d = rv.draft;
  const title = rv.title || d.story?.title?.value || '';
  const premise = rv.premise || d.story?.premise?.value || '';
  const suggested = (f) => d.story?.[f]?.origin === 'generated' && !(f === 'title' ? rv.title : rv.premise);
  sheet('Story', `
    ${reviewBack()}
    <div class="field">
      <label for="st-title">Title</label>
      <input type="text" id="st-title" value="${esc(title)}" placeholder="Left blank, it takes the lead’s name">
      ${suggested('title') ? '<div class="why">Suggested by Nexus.</div>' : ''}
    </div>
    <div class="field">
      <label for="st-premise">Premise</label>
      <textarea id="st-premise" rows="6" placeholder="Where and when, what has already happened, what it is about.">${esc(premise)}</textarea>
      ${suggested('premise') ? '<div class="why">Suggested by Nexus.</div>' : ''}
    </div>
    <div class="sheet-actions">
      <button class="btn quiet" data-rv-root>Cancel</button>
      <button class="btn primary" id="st-save">Save</button>
    </div>
  `, (root) => {
    wireReviewBack(root);
    $('#st-save', root).addEventListener('click', () => {
      rv.title = $('#st-title', root).value.trim();
      rv.premise = $('#st-premise', root).value.trim();
      reviewRoot();
    });
  });
}

/** The first scene. Not part of the story until it starts. */
function reviewOpening() {
  const d = rv.draft;
  const o = d.story?.opening || null;
  const lead = leadRow();
  const fromCard = !o || o.origin === 'source';
  sheet('Opening', `
    ${reviewBack()}
    <p class="rv-lede">The first scene of the story. It is written into the story when you start, and not before.</p>
    ${o && o.origin === 'source' ? `
      <div class="rv-content">${esc(o.text)}</div>
      <p class="rv-hint">This is ${esc(lead?.name || 'the lead')}’s greeting from their card. To use something else, write your own below or ask Nexus for one.</p>` : ''}
    ${o && o.origin !== 'source' ? `
      <div class="field">
        <label for="op-text">${o.origin === 'generated' ? `Suggested by Nexus${o.edited ? ' · edited' : ''}` : 'Written by you'}</label>
        <textarea id="op-text" rows="10">${esc(o.text)}</textarea>
      </div>` : ''}
    ${!o ? `<div class="empty">${lead?.backing === 'card' ? 'The story will open on your lead’s greeting.' : 'No opening yet. The story will start with you.'}</div>` : ''}
    <div class="rv-actions">
      ${fromCard ? '<button class="btn" id="op-write">Write my own</button>' : '<button class="btn quiet" id="op-remove">Remove</button>'}
      <button class="btn" id="op-suggest">${o && o.origin !== 'source' ? 'Suggest another' : 'Suggest one'}</button>
    </div>
    <div class="sheet-actions">
      <button class="btn quiet" data-rv-root>Cancel</button>
      ${o && o.origin !== 'source' ? '<button class="btn primary" id="op-save">Save</button>' : '<button class="btn primary" data-rv-root>Done</button>'}
    </div>
  `, (root) => {
    wireReviewBack(root);
    const text = $('#op-text', root);
    const keep = () => {
      if (!text) return;
      const v = text.value.trim();
      if (!v) { d.story.opening = null; return; }
      if (v !== o.text) d.story.opening = { ...o, text: v, edited: o.origin === 'generated' ? true : o.edited };
    };
    $('#op-save', root)?.addEventListener('click', () => { keep(); reviewRoot(); });
    $('#op-remove', root)?.addEventListener('click', () => { d.story.opening = null; toast('Opening removed.'); reviewOpening(); });
    $('#op-write', root)?.addEventListener('click', () => { d.story.opening = { text: '', origin: 'manual' }; reviewOpening(); });
    $('#op-suggest', root).addEventListener('click', () => {
      keep();
      // Asking for another sets the current one aside in the draft. A card's
      // greeting stays on the card; only this story would open differently.
      if (d.story.opening && d.story.opening.origin !== 'generated') d.story.opening = null;
      suggest({ part: 'opening' }, reviewOpening);
    });
  });
}

// --------------------------------- knowledge a person brings to a new story
//
// Somebody being in the story does not hand the story everything ever written
// about them. So the review asks, once, per person, and the answer travels with
// the rest of the draft to Apply — where it becomes an ordinary attachment.

/**
 * What this person would bring, if they have anything and Nexus knows who they
 * are.
 *
 * A row is a card or somebody read out of a source, and either way the offer is
 * about the person behind it.
 */
const offerOf = (r) => (rv.draft.reuse || []).find((x) => (r.characterId && x.resourceId === r.characterId)
  || (r.semantic?.entityId && x.entityId === r.semantic.entityId)) || null;

/**
 * Their reusable knowledge, offered to this story.
 *
 * Knowledge ABOUT the person, which is not the same thing as knowledge the
 * person has: a childhood, a deepest fear and an abandonment wound are all true
 * of Patrick whether or not Patrick understands any of them. So this says whose
 * knowledge it is, never what they know — the difference is the room a future
 * layer needs to say who knows what.
 */
function reuseOfferLine(o) {
  const n = (k, one, many) => `${num(k)} ${k === 1 ? one : many}`;
  const first = String(o.name || '').split(' ')[0];
  const whose = `${esc(first)}${/s$/i.test(first) ? '’' : '’s'} reusable knowledge`;
  // Nothing to ask: the story already reads all of it.
  if (o.state === 'all') {
    return `<div class="reuse-line on">
      <span class="reuse-say"><b>${whose}</b><span>All ${n(o.entriesUsedHere, 'entry', 'entries')} already available here</span></span>
    </div>`;
  }
  const on = rv.reuse.has(o.entityId);
  const said = o.state === 'some'
    ? `${num(o.entriesUsedHere)} of ${n(o.entries, 'entry', 'entries')} available in this story`
    : `${n(o.entries, 'entry', 'entries')} available`;
  return `<div class="reuse-line${on ? ' on' : ''}">
      <span class="reuse-say"><b>Use ${whose}</b><span>${said}</span></span>
      <button class="switch" data-rv-reuse="${esc(o.entityId)}" aria-pressed="${on}"
        aria-label="Use ${esc(o.name)}’s reusable knowledge in this story"></button>
    </div>
    ${on && o.state === 'some' ? '<div class="why">The rest will be available here too.</div>' : ''}`;
}

/** Everyone the story has, with a part each, and the reasons for it. */
function reviewCasting() {
  const d = rv.draft;
  const rows = d.casting;
  const locked = rv.mode === 'existing';
  const counts = {
    cast: rows.filter((r) => IN_CAST.has(roleOf(r))).length,
    known: rows.filter((r) => roleOf(r) === 'known').length,
    excluded: rows.filter((r) => roleOf(r) === 'excluded').length,
  };
  const find = rv.castFind.trim().toLowerCase();
  const shown = rows
    .filter((r) => (rv.castFilter === 'all' ? true
      : rv.castFilter === 'cast' ? IN_CAST.has(roleOf(r)) : roleOf(r) === rv.castFilter))
    .filter((r) => !find || r.name.toLowerCase().includes(find))
    .sort((a, b) => CAST_ORDER.indexOf(roleOf(a)) - CAST_ORDER.indexOf(roleOf(b)) || a.name.localeCompare(b.name));

  const chip = (id, label, n) => `<button class="rv-chip" data-filter="${id}" aria-pressed="${rv.castFilter === id}">${esc(label)} <b>${num(n)}</b></button>`;

  const castRow = (r) => {
    const role = roleOf(r);
    const cardLocked = locked && r.backing === 'card';
    const changed = role !== r.suggested;
    const gen = isSuggested(r);
    const promoting = gen && role === 'lead';
    return `
    <div class="cast-row${role === 'known' ? ' is-known' : role === 'excluded' ? ' is-excluded' : ''}${gen ? ' is-suggested' : ''}" data-key="${esc(r.key)}">
      <div class="cast-top">
        <button class="cast-name" ${r.entryId ? `data-entry-open="${esc(r.entryId)}"` : gen ? `data-edit-person="${esc(r.draftId)}"` : 'tabindex="-1"'}>${esc(r.name)}</button>
        <select class="cast-role" data-role-for="${esc(r.key)}" aria-label="Part for ${esc(r.name)}"${cardLocked ? ' disabled' : ''}>
          ${CAST_ORDER.map((k) => {
    const blocked = k === 'lead' && !r.canLead;
    return `<option value="${k}"${k === role ? ' selected' : ''}${blocked ? ' disabled' : ''}>${esc(blocked ? 'Lead — needs a card' : CAST_LABEL[k])}</option>`;
  }).join('')}
        </select>
      </div>
      <div class="cast-meta">
        <span class="cast-suggest${changed ? ' changed' : ''}">Suggested ${esc(CAST_LABEL[r.suggested])}</span>
        <span class="cast-backing${gen ? ' by-nexus' : ''}">${esc(originWords(r))}</span>
        ${/* Where the row's identity comes from, said quietly: organised
             material is silent, the rest says what it is. */''}
        ${r.backing === 'lore' && !gen ? (r.semantic
    ? (r.semantic.stale ? '<span class="rv-flag warn">needs review</span>' : '')
    : '<span class="rv-flag">not organised yet</span>') : ''}
        ${gen ? reuseFlag(r.draftId) : ''}
      </div>
      ${r.semantic?.entityId ? `<div class="rv-item-actions" style="margin-top:2px">
        <button class="btn quiet" data-cast-profile="${esc(r.semantic.entityId)}">View profile</button>
      </div>` : ''}
      ${offerOf(r) ? reuseOfferLine(offerOf(r)) : ''}
      ${roleMeans(role, r) ? `<div class="cast-means ${esc(role)}">${esc(roleMeans(role, r))}</div>` : ''}
      ${gen && r.summary ? `<div class="cast-why">${esc(r.summary)}</div>` : ''}
      ${!gen && r.why?.length ? `<div class="cast-why">${esc(r.why.slice(0, 3).join(' · '))}</div>` : ''}
      ${gen && r.promotionSuggested && !promoting ? '<div class="cast-why">Nexus thinks they could be worth a full character.</div>' : ''}
      ${promoting ? `
        <div class="switch-row cast-promote">
          <div class="switch-main">
            <div class="switch-title">Make this a full character</div>
            <div class="switch-why">A lead needs a character card. On, ${esc(r.name)} is saved to your library as a character you can use in other stories. Off, choose a lead from your library instead.</div>
          </div>
          <button class="switch" data-promote="${esc(r.draftId)}" aria-label="Make ${esc(r.name)} a full character" aria-pressed="${rv.promote.has(r.draftId)}"></button>
        </div>` : ''}
      ${gen ? `<div class="rv-item-actions">
        <button class="btn quiet" data-edit-person="${esc(r.draftId)}">Edit</button>
        <button class="btn quiet" data-remove-person="${esc(r.draftId)}">Remove</button>
      </div>` : ''}
      ${cardLocked ? '<div class="cast-why">Character cards are changed from the story sheet.</div>' : ''}
    </div>`;
  };

  sheet('Casting', `
    ${reviewBack()}
    <p class="rv-lede">Who is in the story, and how much. Known people are not cast but may still turn up when a scene calls for them. Excluded people stay in the source and this story ignores them.</p>
    <div class="rv-chips">
      ${chip('cast', 'In the cast', counts.cast)}
      ${chip('known', 'Known', counts.known)}
      ${counts.excluded ? chip('excluded', 'Excluded', counts.excluded) : ''}
      ${chip('all', 'Everyone', rows.length)}
    </div>
    ${rows.length > 10 ? `<input type="search" class="rv-find" id="rv-find" placeholder="Find someone" value="${esc(rv.castFind)}" autocomplete="off" enterkeyhint="search">` : ''}
    <div class="cast-list" id="cast-list">
      ${shown.map(castRow).join('') || `<div class="empty">${rows.length ? 'Nobody here.' : 'Nobody yet.'}</div>`}
    </div>
    ${/* Someone you play is not cast, but they are in the story, and what they
         know travels the same way. Asked here so it is asked in one place. */''}
    ${(rv.draft.reuse || []).filter((o) => o.kind === 'persona').map((o) => `
      <div class="sec-head">Someone you play</div>
      <div class="cast-row">
        <div class="cast-top"><span class="cast-name" tabindex="-1">${esc(o.name)}</span></div>
        <div class="cast-meta"><span class="cast-backing">Played by you</span></div>
        ${reuseOfferLine(o)}
      </div>`).join('')}
    ${canSuggest() ? `<div class="rv-assist">
      <button class="btn" id="cast-suggest">Suggest people again</button>
      <span class="rv-hint">Replaces only the people Nexus suggested that you have not edited. Your characters and your sources stay.</span>
    </div>` : ''}
    <div class="sheet-actions"><button class="btn primary" data-rv-root>Done</button></div>
  `, (root) => {
    wireReviewBack(root);
    root.addEventListener('click', (e) => {
      const f = e.target.closest('[data-filter]');
      if (f) { rv.castFilter = f.dataset.filter; reviewCasting(); return; }
      // A tick, and nothing more: it is written when the story is.
      const ru = e.target.closest('[data-rv-reuse]');
      if (ru) {
        const key = ru.dataset.rvReuse;
        if (rv.reuse.has(key)) rv.reuse.delete(key); else rv.reuse.add(key);
        reviewCasting();
        return;
      }
      const p = e.target.closest('[data-promote]');
      if (p) {
        const id = p.dataset.promote;
        if (rv.promote.has(id)) rv.promote.delete(id); else rv.promote.add(id);
        reviewCasting();
        return;
      }
      const ed = e.target.closest('[data-edit-person]');
      if (ed) { editSuggestion({ person: ed.dataset.editPerson }, reviewCasting); return; }
      const rm = e.target.closest('[data-remove-person]');
      if (rm) { removeSuggestion(rm.dataset.removePerson); reviewCasting(); return; }
      const prof = e.target.closest('[data-cast-profile]');
      if (prof) { openEntityProfile(prof.dataset.castProfile, { back: reviewCasting, storyId: rv.storyId || null }); return; }
      const o = e.target.closest('[data-entry-open]');
      if (o) reviewEntry(o.dataset.entryOpen, reviewCasting);
    });
    root.addEventListener('change', (e) => {
      const s = e.target.closest('[data-role-for]');
      if (!s) return;
      setCastRole(s.dataset.roleFor, s.value);
    });
    $('#cast-suggest', root)?.addEventListener('click', () => suggest({ part: 'people' }, reviewCasting));
    const input = $('#rv-find', root);
    if (input) {
      input.addEventListener('input', () => {
        rv.castFind = input.value;
        const at = input.selectionStart;
        reviewCasting();
        const again = $('#rv-find');
        if (again) { again.focus(); again.setSelectionRange(at, at); }
      });
    }
  });
}

/**
 * Change one person's part.
 *
 * A story has one lead. Naming a new one moves the old one to Main and says
 * so, rather than asking a question the answer to which is almost always yes.
 */
function setCastRole(key, role) {
  const row = rv.draft.casting.find((r) => r.key === key);
  if (!row) return;
  if (role === 'lead' && !row.canLead) { toast(`${row.name} has no character card, so they cannot lead.`); reviewCasting(); return; }
  if (role === 'lead') {
    const prev = leadRow();
    if (prev && prev.key !== key) {
      rv.roles.set(prev.key, 'main');
      toast(`${row.name} now leads. ${prev.name} is Main.`);
    }
  }
  if (role !== 'lead' && row.draftId) rv.promote.delete(row.draftId);
  rv.roles.set(key, role);
  if (!leadRow()) toast('The story has no lead now. Choose one before starting.');
  reviewCasting();
}

/** Take a suggestion out of the draft. It never reaches the story. */
function removeSuggestion(draftId) {
  const d = rv.draft;
  const person = d.casting.find((r) => r.draftId === draftId && isSuggested(r));
  let name = person?.name;
  if (person) {
    d.casting = d.casting.filter((r) => r !== person);
    rv.roles.delete(person.key);
    rv.promote.delete(draftId);
  } else {
    for (const s of d.sections) {
      const i = s.items.find((x) => x.draftId === draftId && isSuggested(x));
      if (i) { name = i.title; s.items = s.items.filter((x) => x !== i); s.count = s.items.length; }
    }
  }
  d.links = d.links.filter((l) => l.fromDraftId !== draftId && l.aboutDraftId !== draftId);
  d.invented = d.casting.filter((r) => r.origin === 'generated').length + d.sections.reduce((n, s) => n + s.items.filter((i) => i.origin === 'generated').length, 0);
  if (name) toast(`${name} removed from the draft.`);
}

/**
 * Edit something Nexus suggested, before it is real.
 *
 * Only suggestions: material from a card or a source is the author's, and is
 * changed where it lives, not here.
 */
function editSuggestion({ person, item }, back) {
  const d = rv.draft;
  const row = person ? d.casting.find((r) => r.draftId === person) : null;
  let section = null;
  let entry = null;
  if (item) {
    for (const s of d.sections) {
      const i = s.items.find((x) => x.draftId === item);
      if (i) { section = s; entry = i; }
    }
  }
  const x = row || entry;
  if (!x || !isSuggested(x)) { back(); return; }

  sheet(row ? 'Edit person' : 'Edit suggestion', `
    <button class="btn quiet rv-backrow" id="es-back">&larr; Back</button>
    <p class="rv-hint">${esc(originWords(x))}. Nothing here is part of the story until it starts.</p>
    <div class="field">
      <label for="es-name">${row ? 'Name' : 'Title'}</label>
      <input type="text" id="es-name" value="${esc(row ? row.name : entry.title)}">
    </div>
    ${entry ? `<div class="field">
      <label for="es-section">Where it belongs</label>
      <select id="es-section">
        ${DRAFT_SECTIONS.map((id) => `<option value="${id}"${id === section.id ? ' selected' : ''}>${esc(SECTION_LABEL[id])}</option>`).join('')}
      </select>
    </div>` : ''}
    <div class="field">
      <label for="es-content">What the story knows</label>
      <textarea id="es-content" rows="8">${esc(x.content || '')}</textarea>
    </div>
    <div class="rv-actions">
      <button class="btn quiet" id="es-remove">Remove</button>
      ${x.origin === 'generated' ? '<button class="btn" id="es-again">Suggest something else</button>' : ''}
    </div>
    <div class="sheet-actions">
      <button class="btn quiet" id="es-cancel">Cancel</button>
      <button class="btn primary" id="es-save">Save</button>
    </div>
  `, (root) => {
    $('#es-back', root).addEventListener('click', back);
    $('#es-cancel', root).addEventListener('click', back);
    $('#es-remove', root).addEventListener('click', () => { removeSuggestion(x.draftId); back(); });
    $('#es-again', root)?.addEventListener('click', () => suggest({ item: x.draftId }, back));
    $('#es-save', root).addEventListener('click', () => {
      const name = $('#es-name', root).value.trim();
      const content = $('#es-content', root).value.trim();
      if (!name || !content) { toast('A name and a description are both needed.'); return; }
      const changed = (row ? name !== row.name : name !== entry.title) || content !== x.content;
      if (row) row.name = name; else entry.title = name;
      x.content = content;
      if (changed && x.origin === 'generated') x.edited = true;
      if (entry) {
        const to = $('#es-section', root).value;
        if (to !== section.id) {
          section.items = section.items.filter((i) => i !== entry);
          section.count = section.items.length;
          const dest = d.sections.find((s) => s.id === to);
          dest.items.push(entry);
          dest.count = dest.items.length;
          if (entry.origin === 'generated') entry.edited = true;
          toast(`Moved to ${SECTION_LABEL[to]}.`);
        }
      }
      back();
    });
  });
}

/** One section of the story: the entries in it, and who each is about. */
function reviewSection(id) {
  const d = rv.draft;
  const s = d.sections.find((x) => x.id === id);
  const items = id === 'other' ? [...(s?.items || []), ...(d.unclear || [])] : (s?.items || []);
  const label = s?.label || 'Other';

  const linksFor = new Map();
  for (const l of d.links) {
    const from = l.entryId || l.fromDraftId;
    if (!linksFor.has(from)) linksFor.set(from, []);
    linksFor.get(from).push(l);
  }

  const item = (e) => {
    const key = e.entryId || e.draftId;
    const ls = linksFor.get(key) || [];
    const gen = isSuggested(e);
    return `
    <div class="rv-entry${e.enabled === false ? ' off' : ''}${gen ? ' is-suggested' : ''}">
      <button class="rv-entry-open" ${gen ? `data-edit-item="${esc(e.draftId)}"` : `data-entry-open="${esc(e.entryId)}"`}>
        <span class="rv-entry-title">${esc(e.title)}</span>
        <span class="rv-entry-meta">
          ${gen ? `<span class="by-nexus">${esc(originWords(e))}</span>` : ''}
          ${gen ? reuseFlag(e.draftId) : ''}
          ${!gen && e.semantic?.state === 'recheck' ? '<span class="rv-flag warn">needs review</span>' : ''}
          ${!gen && !e.placedBy && e.entryId && (!e.semantic || e.semantic.state === 'none' || e.semantic.state === 'proposed') ? '<span class="rv-flag">not organised yet</span>' : ''}
          ${e.always ? '<b class="pin">always on</b>' : ''}
          ${e.enabled === false ? '<b class="off-tag">switched off</b>' : ''}
          ${gen ? '' : `<span>${esc((e.keys || []).slice(0, 3).join(', ') || 'no keys')}</span>`}
        </span>
        ${gen && e.content ? `<span class="rv-entry-preview">${esc(e.content)}</span>` : ''}
        ${e.note ? `<span class="rv-entry-note">${esc(e.note)}</span>` : ''}
      </button>
      ${ls.length ? `<div class="rv-about">
        <span class="rv-about-label">About</span>
        ${ls.map((l) => `<button class="rv-link ${esc(l.confidence)}" data-link="${esc(linkKey(l))}" aria-pressed="${rv.links.get(linkKey(l))}" title="${esc(l.why || '')}">${esc(l.targetName)}${l.confidence === 'low' ? '?' : ''}</button>`).join('')}
      </div>` : ''}
      ${gen ? `<div class="rv-item-actions">
        <button class="btn quiet" data-edit-item="${esc(e.draftId)}">Edit</button>
        <button class="btn quiet" data-remove-item="${esc(e.draftId)}">Remove</button>
      </div>` : ''}
    </div>`;
  };

  const anyLow = items.some((e) => (linksFor.get(e.entryId || e.draftId) || []).some((l) => l.confidence === 'low'));
  const hasSource = items.some((e) => !isSuggested(e));

  sheet(label, `
    ${reviewBack()}
    <p class="rv-lede">${esc(SECTION_HELP[id] || '')}</p>
    ${items.some((e) => linksFor.has(e.entryId || e.draftId)) ? `<p class="rv-hint">Tap a name to say whether an entry is about them. ${anyLow ? 'Names with a question mark are guesses and are left off unless you tick them.' : ''}</p>` : ''}
    <div class="rv-entries">
      ${items.map(item).join('') || '<div class="empty">Nothing here yet.</div>'}
    </div>
    ${canSuggest() && id !== 'other' ? `<div class="rv-assist">
      <button class="btn" id="sec-suggest">${suggestedCount(items) ? `Suggest ${esc(label.toLowerCase())} again` : `Suggest ${esc(label.toLowerCase())}`}</button>
      <span class="rv-hint">${hasSource ? 'Replaces only what Nexus suggested here and you have not edited. Material from your sources stays.' : 'Replaces only what Nexus suggested here and you have not edited.'}</span>
    </div>` : ''}
    <div class="sheet-actions"><button class="btn primary" data-rv-root>Done</button></div>
  `, (root) => {
    wireReviewBack(root);
    root.addEventListener('click', (e) => {
      const l = e.target.closest('[data-link]');
      if (l) {
        const k = l.dataset.link;
        const on = !rv.links.get(k);
        rv.links.set(k, on);
        l.setAttribute('aria-pressed', String(on));
        return;
      }
      const ed = e.target.closest('[data-edit-item]');
      if (ed) { editSuggestion({ item: ed.dataset.editItem }, () => reviewSection(id)); return; }
      const rm = e.target.closest('[data-remove-item]');
      if (rm) { removeSuggestion(rm.dataset.removeItem); reviewSection(id); return; }
      const o = e.target.closest('[data-entry-open]');
      if (o) reviewEntry(o.dataset.entryOpen, () => reviewSection(id));
    });
    $('#sec-suggest', root)?.addEventListener('click', () => suggest({ part: id }, () => reviewSection(id)));
  });
}

/**
 * One entry, as the engine holds it.
 *
 * Read straight from the source, every time: this is that entry, not a copy
 * taken when the review opened. Editing it happens in its source, where a
 * change reaches every story that uses it.
 */
async function reviewEntry(entryId, back) {
  sheet('Entry', `${reviewBack()}<div class="empty">Reading…</div>`, wireReviewBack);
  let e;
  try { e = await get(`/api/entries/${entryId}`); } catch (err) {
    sheet('Entry', `${reviewBack()}<div class="notice">${esc(err.message)}</div>`, wireReviewBack); return;
  }
  const src = (rv.draft.sources || []).find((s) => s.id === (e.lorebookId || e.lorebook_id));
  const yes = (v) => (v ? 'yes' : 'no');
  const facts = [
    ['Source', src ? src.name : '—'],
    ['Type', e.kind || '—'],
    ['Switched on', yes(e.enabled !== false && e.enabled !== 0)],
    ['Always on', yes(e.constant)],
    ['Keywords', (e.keys || []).join(', ') || '—'],
    ['Also needs', (e.secondaryKeys || []).join(', ') || '—'],
    ['Priority', e.order ?? '—'],
    ['Chance', e.useProbability === false ? '100%' : `${e.probability ?? 100}%`],
    ['Group', e.group || '—'],
    ['Can be pulled in by other entries', yes(!e.excludeRecursion)],
    ['Can pull in other entries', yes(!e.preventRecursion)],
    ['Sticky · cooldown · delay', [e.sticky, e.cooldown, e.delay].map((x) => x ?? '—').join(' · ')],
    ['Size', `~${num(Math.ceil(String(e.content || '').length / 4))} tokens`],
  ];
  sheet(e.title || 'Entry', `
    <button class="btn quiet rv-backrow" id="rv-entry-back">&larr; Back</button>
    <div class="rv-facts">${facts.map(([k, v]) => `<div class="stat-row"><span>${esc(k)}</span><span>${esc(String(v))}</span></div>`).join('')}</div>
    <div class="rv-content">${esc(e.content || '')}</div>
    <p class="rv-hint">To change this entry, open ${esc(src ? src.name : 'its source')} from Sources in your Library. A change there reaches every story that uses it.</p>
    <div class="sheet-actions"><button class="btn primary" id="rv-entry-done">Back</button></div>
  `, (root) => {
    $('#rv-entry-back', root).addEventListener('click', back);
    $('#rv-entry-done', root).addEventListener('click', back);
  });
}

/** The sources themselves, and how this story will use each one. */
function reviewSources() {
  const d = rv.draft;
  sheet('Sources', `
    ${reviewBack()}
    <p class="rv-lede">What the story is made from. Connecting a source copies nothing: the source stays in your Library exactly as it is.</p>
    ${(d.sources || []).map((s) => `
      <div class="switch-row">
        <div class="switch-main" style="min-width:0">
          <div class="switch-title">${esc(s.name)}</div>
          <div class="switch-why">${num(s.entries)} entries. Let entries pull in other entries they mention? Turn this off for densely cross-referenced sources, where one mention can pull in most of the book.</div>
        </div>
        <button class="switch" data-spread="${esc(s.id)}" aria-label="Let entries pull in others" aria-pressed="${rv.recursion[s.id] !== 'block'}"></button>
      </div>`).join('')}
    <div class="sheet-actions"><button class="btn primary" data-rv-root>Done</button></div>
  `, (root) => {
    wireReviewBack(root);
    root.addEventListener('click', (e) => {
      const c = e.target.closest('[data-spread]');
      if (!c) return;
      const on = c.getAttribute('aria-pressed') !== 'true';
      c.setAttribute('aria-pressed', String(on));
      rv.recursion[c.dataset.spread] = on ? null : 'block';
    });
  });
}

/** What the reviewed draft says, in the shape the server stores. */
function reviewedComposition() {
  const d = rv.draft;
  const existing = d.casting.filter((r) => !isSuggested(r));
  return {
    // Every entry that describes the person goes with them, so excluding
    // somebody written up twice excludes them once, completely.
    casting: existing.map((r) => ({
      ...(r.characterId ? { characterId: r.characterId } : { entryId: r.entryId }),
      entryIds: r.entryIds || [],
      role: roleOf(r),
    })),
    links: d.links.filter((l) => l.origin !== 'generated' && rv.links.get(linkKey(l))).map((l) => (l.characterId
      ? { entryId: l.entryId, characterId: l.characterId }
      : { entryId: l.entryId, aboutId: l.aboutId })),
    recursion: rv.recursion,
    generated: acceptedSuggestions(),
    // Only the people a person ticked. Nothing reusable travels because it
    // exists, and an empty list is a real answer, not a missing one.
    reuse: [...rv.reuse].map((entityId) => ({ entityId })),
  };
}

/**
 * Everything suggested that is still in the draft, as the person left it.
 *
 * Removed suggestions are simply not here. Promotion is the person's switch,
 * never anything the draft says.
 */
function acceptedSuggestions() {
  const d = rv.draft;
  const items = [];
  for (const r of d.casting) {
    if (!isSuggested(r) || roleOf(r) === 'excluded') continue;
    items.push({
      type: 'person', draftId: r.draftId, origin: r.origin, name: r.name, role: roleOf(r),
      content: r.content, summary: r.summary || '', keys: r.keys || [], edited: r.edited === true,
      promote: roleOf(r) === 'lead' && rv.promote.has(r.draftId),
    });
  }
  for (const s of d.sections) {
    for (const i of s.items) {
      if (!isSuggested(i)) continue;
      items.push({ type: 'entry', draftId: i.draftId, origin: i.origin, section: s.id, title: i.title, content: i.content, summary: i.summary || '', keys: i.keys || [], alwaysOn: i.always === true, edited: i.edited === true });
    }
  }
  const alive = new Set(items.map((i) => i.draftId));
  const links = d.links
    .filter((l) => l.origin === 'generated' && rv.links.get(linkKey(l)) && alive.has(l.fromDraftId) && (!l.aboutDraftId || alive.has(l.aboutDraftId)))
    .map((l) => ({ fromDraftId: l.fromDraftId, ...(l.aboutDraftId ? { aboutDraftId: l.aboutDraftId } : l.aboutId ? { aboutId: l.aboutId } : { characterId: l.characterId }) }));
  // What the reader answered about maybe-duplicates travels with the material,
  // and the server holds Apply to it: nothing unresolved gets through, and
  // "use existing" writes nothing new.
  return items.length ? { items, links, reconcile: Object.fromEntries(rv.dupes) } : undefined;
}

const builderMeta = () => ({ mode: rv.draft.mode, depth: rv.draft.generation?.depth || null, model: rv.draft.generation?.model || null });

async function startReviewed(btn) {
  const blocker = startBlocker();
  if (blocker) { toast(blocker); return; }
  const lead = leadRow();
  const d = rv.draft;
  btn.disabled = true;
  try {
    const opening = d.story?.opening && d.story.opening.origin !== 'source' && d.story.opening.text ? d.story.opening : null;
    // A card that offers several ways to meet someone asks which one — unless
    // the reviewed draft already has its own opening.
    const card = lead.backing === 'card' ? (state.library?.characters || []).find((c) => c.id === lead.characterId) : null;
    let startingPointId = null;
    if (card && card.starts > 1 && !opening && d.story?.opening !== null) {
      startingPointId = await chooseOpening('character', card.id);
      if (startingPointId === false) { reviewRoot(); return; }
    }
    const title = rv.title || d.story?.title?.value || '';
    const premise = rv.premise || d.story?.premise?.value || '';
    const { id } = await post('/api/stories', {
      title: title || undefined,
      personaId: rv.personaId || null,
      lorebookIds: rv.lorebookIds || [],
      startingPointId,
      settings: premise ? { premise } : undefined,
      composition: {
        ...reviewedComposition(),
        ...(opening ? { opening: { text: opening.text } } : {}),
        story: { title, premise },
        builder: builderMeta(),
      },
    });
    rv = null;
    closeSheet();
    await loadLibrary();
    openStory(id);
  } catch (err) {
    toast(err.message, { kind: 'bad', ms: 8000 });
    btn.disabled = false;
  }
}

async function applyReviewed(btn) {
  btn.disabled = true;
  const c = reviewedComposition();
  // Cards already in the story stay as they are, and anyone Known who was
  // never in the cast or excluded needs nothing written.
  const rows = rv.draft.casting.filter((r) => !isSuggested(r));
  const current = new Map(rows.map((r) => [r.key, r.current]));
  const casting = c.casting.filter((x, i) => {
    const r = rows[i];
    if (r.characterId) return false;
    return IN_CAST.has(x.role) || x.role === 'excluded' || current.get(r.key);
  });
  try {
    const storyId = rv.storyId;
    const out = await post(`/api/stories/${storyId}/compose`, {
      lorebookIds: rv.lorebookIds, casting, links: c.links, recursion: c.recursion, reuse: c.reuse,
      ...(c.generated ? { generated: c.generated, builder: builderMeta() } : {}),
    });
    rv = null;
    state.story = await get(`/api/stories/${storyId}`);
    await loadLibrary();
    toast('Saved to the story.', { kind: 'good', sub: `${num(out.npcs)} from sources in the cast · ${num(out.excluded || 0)} excluded` });
    closeSheet();
  } catch (err) {
    toast(err.message, { kind: 'bad', ms: 8000 });
    btn.disabled = false;
  }
}

// =========================================================== start with an idea
//
// Describe a story; Nexus builds a draft of it; the draft opens in the same
// review as everything else. Nothing is saved until the story starts.

const ideaForm = { idea: '', tone: '', pointOfView: '', depth: 'standard', characterIds: [], lorebookIds: [], advanced: false };

function ideaStart() {
  const L = state.library || { characters: [], lorebooks: [] };
  const f = ideaForm;
  sheet('Start with an idea', `
    <div class="field">
      <label for="bi-idea">What is your story idea?</label>
      <div class="why">A few lines is enough: who, where, what is at stake. Nexus builds the people, places and opening for you to look over.</div>
      <textarea id="bi-idea" rows="7" placeholder="A lighthouse keeper on a stormy coast finds a stranger washed ashore who claims their ship sank forty years ago…">${esc(f.idea)}</textarea>
    </div>

    <details class="bi-more"${f.tone || f.pointOfView || f.depth !== 'standard' ? ' open' : ''}>
      <summary>Tone, point of view and detail</summary>
      <div class="field">
        <label for="bi-tone">Tone</label>
        <input type="text" id="bi-tone" value="${esc(f.tone)}" placeholder="Dark, slow burn, hopeful…" autocomplete="off">
      </div>
      <div class="field">
        <label for="bi-pov">Point of view</label>
        <select id="bi-pov">
          ${[['', 'Let Nexus choose'], ['second person, addressing the player as you', 'You (second person)'], ['third person', 'Third person'], ['first person', 'First person']]
    .map(([v, t]) => `<option value="${esc(v)}"${f.pointOfView === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>How much to build</label>
        <div class="bi-depth" role="radiogroup" aria-label="How much to build">
          ${[['light', 'Light', 'Just enough to start'], ['standard', 'Standard', 'A full story'], ['deep', 'Deep', 'A richer world']]
    .map(([v, t, sub]) => `<button type="button" class="bi-depth-opt" role="radio" data-depth="${v}" aria-checked="${f.depth === v}"><b>${t}</b><span>${sub}</span></button>`).join('')}
        </div>
      </div>
    </details>

    <details class="bi-more"${f.advanced ? ' open' : ''}>
      <summary>Build around characters or sources you have</summary>
      <div class="why" style="margin:6px 0 10px">Nexus keeps them exactly as they are and builds only what is missing around them.</div>
      ${L.characters.length ? `<div class="field"><label>Characters</label>${picker(L.characters.map((c) => ({ id: c.id, title: c.name })), { selected: new Set(f.characterIds) })}</div>` : ''}
      ${L.lorebooks.length ? `<div class="field bi-books"><label>Sources</label>${sourcePicker(L.lorebooks, new Set(f.lorebookIds))}</div>` : ''}
    </details>

    <div class="sheet-actions">
      <button class="btn quiet" data-close>Cancel</button>
      <button class="btn primary" id="bi-go">Build my story</button>
    </div>
  `, (root) => {
    wirePicker(root);
    const read = () => {
      f.idea = $('#bi-idea', root).value.trim();
      f.tone = $('#bi-tone', root).value.trim();
      f.pointOfView = $('#bi-pov', root).value;
      const pickers = $$('.pick', root);
      f.characterIds = pickers[0] && !pickers[0].closest('.bi-books') ? picked(pickers[0]) : [];
      const books = $('.bi-books', root);
      f.lorebookIds = books ? picked(books) : [];
      f.advanced = !!(f.characterIds.length || f.lorebookIds.length);
    };
    root.addEventListener('click', (e) => {
      const dep = e.target.closest('[data-depth]');
      if (!dep) return;
      f.depth = dep.dataset.depth;
      $$('[data-depth]', root).forEach((b) => b.setAttribute('aria-checked', String(b === dep)));
    });
    $('#bi-go', root).addEventListener('click', () => {
      read();
      if (!f.idea) { toast('Write a line or two about the story first.'); $('#bi-idea', root).focus(); return; }
      buildFromIdea();
    });
  });
}

const BUILDING_WORDS = ['Understanding the premise', 'Finding the important people', 'Building the world', 'Preparing the opening'];

/** Send the idea off, and come back to the review or to the idea, never to nothing. */
async function buildFromIdea() {
  const f = ideaForm;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150000);
  let step = 0;
  let cancelled = false;
  sheet('Building your story', `
    <div class="bi-building">
      <div class="rv-spinner" aria-hidden="true"></div>
      <p class="bi-now" id="bi-now">${esc(BUILDING_WORDS[0])}…</p>
      <p class="rv-hint">This usually takes under a minute.</p>
    </div>
    <div class="sheet-actions"><button class="btn quiet" id="bi-cancel">Cancel</button></div>`, (root) => {
    $('#bi-cancel', root).addEventListener('click', () => { cancelled = true; controller.abort(); });
  });
  // Words that change while it works, not a progress bar the server cannot back up.
  const ticker = setInterval(() => {
    step = Math.min(step + 1, BUILDING_WORDS.length - 1);
    const el = $('#bi-now');
    if (el) el.textContent = `${BUILDING_WORDS[step]}…`;
  }, 6000);

  try {
    if (!state.library) await loadLibrary();
    const draft = await postWith('/api/builder/draft', {
      mode: 'build', idea: f.idea, tone: f.tone || undefined, pointOfView: f.pointOfView || undefined, depth: f.depth,
      characterIds: f.characterIds, lorebookIds: f.lorebookIds,
    }, controller.signal);
    openReview({
      mode: 'new', builder: { ...f }, characterIds: f.characterIds, lorebookIds: f.lorebookIds,
      title: '', premise: '', back: ideaStart,
    }, draft);
  } catch (err) {
    if (cancelled) { ideaStart(); return; }
    sheet('That did not work', `
      <div class="notice">${esc(builderTrouble(err))}</div>
      <p class="rv-hint">Your idea is kept exactly as you wrote it.</p>
      <div class="sheet-actions">
        <button class="btn quiet" id="bi-edit">Change the idea</button>
        <button class="btn primary" id="bi-retry">Try again</button>
      </div>`, (root) => {
      $('#bi-edit', root).addEventListener('click', ideaStart);
      $('#bi-retry', root).addEventListener('click', buildFromIdea);
    });
  } finally {
    clearTimeout(timer);
    clearInterval(ticker);
  }
}

/**
 * Before a source leaves a story, what the story would lose.
 *
 * Nothing leaves the Library. The preview names the people who stood on the
 * source's entries, because they are the part a person would miss.
 */
async function confirmSourceRemoval(storyId, bookId, after) {
  sheet('Remove source', '<div class="empty">Checking what it is used for…</div>');
  let p;
  try { p = await get(`/api/stories/${storyId}/sources/${bookId}`); } catch (err) {
    sheet('Remove source', `<div class="notice">${esc(err.message)}</div><div class="sheet-actions"><button class="btn primary" id="rm-back">Back</button></div>`,
      (root) => $('#rm-back', root).addEventListener('click', after));
    return;
  }
  const losing = p.loses.filter((l) => l.count);
  sheet(`Remove ${p.source.name}?`, `
    <p class="rv-lede">This story will lose access to:</p>
    <div class="rv-facts">
      ${losing.map((l) => `<div class="stat-row"><span>${esc(l.label)}</span><span>${num(l.count)}</span></div>`).join('') || '<div class="why">Nothing it was using.</div>'}
    </div>
    ${p.castLeaving.length ? `<p class="rv-lede" style="margin-top:14px">Leaving the cast:</p>
      <div class="rv-facts">${p.castLeaving.map((c) => `<div class="stat-row"><span>${esc(c.name)}</span><span>${esc(CAST_LABEL[c.role] || c.role)}</span></div>`).join('')}</div>` : ''}
    ${/* Who the story would stop knowing, and who it would still know from
          somewhere else. Neither sentence is about the Library: nobody is
          deleted, and their material stays where it is. */''}
    ${p.entitiesLeaving?.length ? `<p class="rv-lede" style="margin-top:14px">No longer available to this story:</p>
      <div class="rv-facts">${p.entitiesLeaving.map((x) => `<div class="stat-row"><span>${esc(x.name)}</span><span>${esc(x.type)}</span></div>`).join('')}</div>
      <p class="rv-hint">They stay in your library and in every other story that carries them.</p>` : ''}
    ${p.entitiesStaying?.length ? `<p class="rv-hint">${esc(p.entitiesStaying.map((x) => x.name).join(', '))} ${p.entitiesStaying.length === 1 ? 'is' : 'are'} still available to this story from another source.</p>` : ''}
    ${p.exclusionsForgotten?.length ? `<p class="rv-hint">This story ignores ${esc(p.exclusionsForgotten.map((x) => x.name).join(', '))} from this source. That choice goes with it, and nothing is removed from the source.</p>` : ''}
    ${p.recursion === 'block' ? '<p class="rv-hint">Its setting for this story, keeping entries from pulling in others, is forgotten with it.</p>' : ''}
    ${p.personaFrom ? `<p class="rv-hint">${esc(p.personaFrom)} was made from an entry in this source and stays as your persona.</p>` : ''}
    <div class="rv-keeps">
      <b>Unaffected</b>
      <span>${esc(p.keeps.join(' · '))}</span>
    </div>
    <div class="sheet-actions">
      <button class="btn quiet" id="rm-cancel">Keep it</button>
      <button class="btn danger" id="rm-go">Remove from story</button>
    </div>
  `, (root) => {
    $('#rm-cancel', root).addEventListener('click', after);
    $('#rm-go', root).addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        await del(`/api/stories/${storyId}/sources/${bookId}`);
        state.story = await get(`/api/stories/${storyId}`);
        toast(`${p.source.name} removed from this story.`, { sub: 'It is still in your Library.' });
        after();
      } catch (err) { toast(err.message, { kind: 'bad' }); e.currentTarget.disabled = false; }
    });
  });
}

// ------------------------------------------------------------ a story sheet
//
// The same three things the wizard asked for, editable at any point. Lore
// especially: choosing it before you know what the story is about is guessing,
// so the real place to pick it is here, once you do.

async function panelStorySheet() {
  const st = state.story;
  const L = state.library || (state.library = await get('/api/library'));
  const s = st.settings || {};
  const cast = new Set((st.characters || []).map((c) => c.id));

  subSheet('This story', `
    ${backRow()}
    <div class="field">
      <label for="ss-title">Called</label>
      <input type="text" id="ss-title" value="${esc(st.title || '')}">
    </div>
    <div class="field">
      <label for="ss-premise">What it is</label>
      <div class="why">Where and when, what has already happened, what it is about. Sent with every message, so a few lines beats a page.</div>
      <textarea id="ss-premise" rows="7">${esc(s.premise || '')}</textarea>
    </div>

    <div class="sec-head">Who is in it</div>
    ${picker((L.characters || []).map((c) => ({ id: c.id, title: c.name, sub: (c.description || '').slice(0, 70) })),
    { selected: cast })}
    <button class="btn" id="ss-newchar" style="margin-top:8px">+ Write a new character</button>

    <div class="sec-head">What it is made from</div>
    <div class="hint">Adding a source shows you what is in it before anything changes. Removing one keeps it in your Library.</div>
    <div class="list" id="ss-books">
      ${(L.lorebooks || []).filter((b) => (st.lorebookIds || []).includes(b.id)).map((b) => `
        <div class="item" style="align-items:center">
          <span class="item-main">
            ${/* The story's own material — what was written here by hand and
                 what the Builder added and somebody kept — is one thing, and
                 it is the story's. Its internal name is nobody's business. */''}
            <span class="item-title">${esc(b.generated_for === st.id ? 'Story material' : b.name)}</span>
            <span class="item-sub">${b.generated_for === st.id ? 'Written for this story · ' : ''}${num(b.entry_count)} entries${b.always_on ? `, ${num(b.always_on)} always on` : ''}</span>
          </span>
          <button class="btn quiet" data-editbook="${esc(b.id)}">Edit</button>
          <button class="btn quiet" data-removebook="${esc(b.id)}">Remove</button>
        </div>`).join('') || '<div class="empty">No sources yet.</div>'}
    </div>
    <div class="ss-source-actions">
      ${(st.lorebookIds || []).length ? '<button class="btn" id="ss-review">Review cast and material</button>' : ''}
      <button class="btn" id="ss-addsource">+ Add a source</button>
    </div>

    <div class="sheet-actions">
      <button class="btn quiet" data-back>Back</button>
      <button class="btn primary" id="ss-save">Save</button>
    </div>`, (root) => {
    wirePicker(root);

    // Coming back here from a source's own screens, Back still goes wherever
    // this sheet's Back went before.
    const parent = sheetStack[sheetStack.length - 1];
    const reopen = () => { sheetStack.pop(); pendingBack = parent; panelStorySheet(); };

    root.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-removebook]');
      if (rm) {
        confirmSourceRemoval(st.id, rm.dataset.removebook, reopen);
        return;
      }
      const edit = e.target.closest('[data-editbook]');
      if (edit) { closeSheet(); openLorebook(edit.dataset.editbook); }
    });

    // The same review, over everything the story already reads, showing what
    // was chosen last time: who is cast, who is Known, who is excluded.
    const review = $('#ss-review', root);
    if (review) {
      review.addEventListener('click', () => beginReview({
        mode: 'existing', heading: 'Review story', storyId: st.id, lorebookIds: [...st.lorebookIds], back: reopen,
      }));
    }

    $('#ss-addsource', root).addEventListener('click', () => {
      const back = reopen;
      const choices = (L.lorebooks || []).filter((b) => !(st.lorebookIds || []).includes(b.id));
      sheet('Add a source', `
        <div class="field">
          <label>Which source?</label>
          <div class="why">Nexus reads it and shows you who and what is in it. Nothing is added until you apply it.</div>
          ${sourcePicker(choices, new Set())}
        </div>
        <div class="sheet-actions">
          <button class="btn quiet" id="as-back">Back</button>
          <button class="btn primary" id="as-go">Read it</button>
        </div>`, (r2) => {
        wirePicker(r2);
        $('#as-back', r2).addEventListener('click', back);
        $('#as-go', r2).addEventListener('click', () => {
          const ids = picked(r2);
          if (!ids.length) { toast('Pick a source first.'); return; }
          beginReview({ mode: 'existing', storyId: st.id, lorebookIds: ids, back });
        });
      });
    });

    $('#ss-newchar', root).addEventListener('click', () => characterBuilder(null, async () => {
      state.library = await get('/api/library');
      panelStorySheet();
    }));

    $('#ss-save', root).addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      const characterIds = picked(root);
      if (!characterIds.length) { toast('A story needs at least one character.'); e.currentTarget.disabled = false; return; }
      try {
        // Sources are added and removed on their own, with a preview each
        // way, so saving the sheet never touches them.
        await patch(`/api/stories/${st.id}`, {
          title: $('#ss-title', root).value.trim() || st.title,
          settings: { ...s, premise: $('#ss-premise', root).value.trim() },
          characterIds,
        });
        state.story = await get(`/api/stories/${st.id}`);
        $('#story-title').textContent = state.story.title;
        refreshQuickbar();
        toast('Saved.', { kind: 'good' });
        goBack();
      } catch (err) { toast(err.message, { kind: 'bad' }); e.currentTarget.disabled = false; }
    });
  });
}

// --------------------------------------------------------- writing a person
//
// Until now the only way to add a character was a file, which meant someone
// who only exists in your head had to be laundered through another app first.

async function characterBuilder(id, onSaved) {
  const c = id ? await get(`/api/characters/${id}`) : {};
  sheet(id ? `Edit ${c.name}` : 'Write a character', `
    <div class="field">
      <label for="cb-name">Name</label>
      <input type="text" id="cb-name" value="${esc(c.name || '')}" placeholder="What everyone calls them">
    </div>
    <div class="field">
      <label for="cb-desc">Who they are</label>
      <div class="why">What they look like, where they come from, what they do. This is the bulk of them and it is sent every message, so it is worth being concrete and not long.</div>
      <textarea id="cb-desc" rows="7" placeholder="Eighteen, second year, built like someone who trains too much and sleeps too little…">${esc(c.description || '')}</textarea>
    </div>
    <div class="field">
      <label for="cb-pers">How they behave</label>
      <div class="why">Temper, habits, what they want, what they will not admit.</div>
      <textarea id="cb-pers" rows="4" placeholder="Abrasive on purpose. Hates being thanked…">${esc(c.personality || '')}</textarea>
    </div>
    <div class="field">
      <label for="cb-scen">Where you meet them</label>
      <div class="why">Only if this character comes with their own setting. Leave it empty and the story's own premise does the work.</div>
      <textarea id="cb-scen" rows="3">${esc(c.scenario || '')}</textarea>
    </div>
    <div class="field">
      <label for="cb-first">How they open</label>
      <div class="why">The first message, which starts the story. {{user}} is your name.</div>
      <textarea id="cb-first" rows="4">${esc(c.first_message || '')}</textarea>
    </div>
    <div class="field">
      <label for="cb-ex">How they talk</label>
      <div class="why">A couple of example lines. Separate exchanges with &lt;START&gt;.</div>
      <textarea id="cb-ex" rows="4">${esc(c.example_dialogue || '')}</textarea>
    </div>
    <div class="sheet-actions">
      <button class="btn quiet" data-close>Cancel</button>
      <button class="btn primary" id="cb-save">${id ? 'Save' : 'Create'}</button>
    </div>`, (root) => {
    $('#cb-save', root).addEventListener('click', async (e) => {
      const name = $('#cb-name', root).value.trim();
      if (!name) { toast('Give them a name.'); return; }
      e.currentTarget.disabled = true;
      try {
        const r = await post('/api/characters', {
          id: id || undefined,
          name,
          description: $('#cb-desc', root).value,
          personality: $('#cb-pers', root).value,
          scenario: $('#cb-scen', root).value,
          firstMessage: $('#cb-first', root).value,
          exampleDialogue: $('#cb-ex', root).value,
        });
        closeSheet();
        await loadLibrary();
        toast(id ? 'Saved.' : `${name} is in your library.`, { kind: 'good' });
        if (onSaved) onSaved(r.id);
      } catch (err) { toast(err.message, { kind: 'bad' }); e.currentTarget.disabled = false; }
    });
  });
}

// ------------------------------------------------------------------- story

async function openStory(id) {
  state.story = await get(`/api/stories/${id}`);
  $('#story-title').textContent = state.story.title;
  $('#btn-model').textContent = shortModel(state.story.settings.model);
  collapseTools();
  show('story');
  applyLook();
  renderMessages();
  scrollToEnd(false);
  refreshNow({ quiet: true });
  refreshQuickbar();
}

const shortModel = (m) => String(m || '').split('/').pop().replace(/:free$/, ' (free)');

// Every story opens with the tools put away, so the first thing you meet is
// the writing, not the controls.
function collapseTools() {
  $('#chat-extras').hidden = true;
  $('#composer-more').setAttribute('aria-expanded', 'false');
}
$('#composer-more').addEventListener('click', () => {
  const open = $('#composer-more').getAttribute('aria-expanded') !== 'true';
  $('#composer-more').setAttribute('aria-expanded', String(open));
  $('#chat-extras').hidden = !open;
  if (open) refreshQuickbar();
});

function renderMessages() {
  const msgs = state.story.messages;
  $('#messages').innerHTML = msgs.map((m, i) => messageHtml(m, i === msgs.length - 1)).join('');
  refreshNudges();
}

/** A small portrait and a name above each turn, so a scene has faces in it. */
function whoRow(role) {
  const st = state.story || {};
  const who = role === 'user'
    ? (st.persona || { name: 'You', avatar: null })
    : (st.characters && st.characters[0]) || { name: 'The story', avatar: null };
  const initial = esc(String(who.name || '?')[0].toUpperCase());
  const face = who.avatar
    ? `<img src="${esc(who.avatar)}" alt="">`
    : initial;
  return `<div class="msg-who"><span class="msg-face">${face}</span><span class="msg-name">${esc(who.name)}</span></div>`;
}

function messageHtml(m, isLast) {
  if (m.role === 'user') {
    return `<div class="msg user" data-id="${esc(m.id)}">${whoRow('user')}${prose(m.content)}
      <div class="msg-tools">
        <button class="msg-tool" data-act="edit">Edit</button>
        <button class="msg-tool" data-act="delete">Delete</button>
      </div></div>`;
  }
  return `<div class="msg${isLast ? ' is-last' : ''}" data-id="${esc(m.id)}">${whoRow('assistant')}${prose(m.content)}
    <div class="msg-tools">
      ${isLast ? '<button class="msg-tool" data-act="regen">Try again</button>' : ''}
      ${m.siblings > 1 ? `<span class="swipe-count">${m.siblings} versions</span>
        <button class="msg-tool" data-act="versions">See them</button>` : ''}
      <button class="msg-tool" data-act="edit">Edit</button>
      <button class="msg-tool" data-act="delete">Delete</button>
    </div></div>`;
}

/** Paragraphs, *emphasis* and "speech". Nothing else — it is prose, not a document. */
function prose(text) {
  return String(text).split(/\n{2,}/).map((para) => {
    const line = esc(para.trim())
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
    return `<p>${line}</p>`;
  }).join('');
}

function scrollToEnd(smooth = true) {
  const el = $('#story-scroll');
  requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }));
}

$('#btn-back').addEventListener('click', async () => {
  if (state.streaming) state.streaming.abort();
  await loadLibrary();
  show('library');
});

// ---------------------------------------------------------------- sending

const input = $('#input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px';
  refreshNudges();
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !isPhone()) { e.preventDefault(); send(); }
});
const isPhone = () => matchMedia('(pointer: coarse)').matches;

$('#btn-send').addEventListener('click', () => {
  if (state.streaming) { state.streaming.abort(); return; }
  send();
});

// ----------------------------------------------- moving without typing
//
// Two different things, deliberately. "Write my turn" puts words in the BOX,
// never on the page, so the rule that this app does not write for you holds:
// it offers, you decide. "Carry on" adds to the last reply, which is theirs
// to write anyway.

$('#btn-impersonate').addEventListener('click', () => nudge('impersonate'));
$('#btn-continue').addEventListener('click', () => nudge('continue'));
$('#btn-marks').addEventListener('click', () => panelMarks());

const DEFAULT_MARKS = [
  { mark: '**', means: 'narration: what happens, what is seen' },
  { mark: '""', means: 'dialogue, spoken aloud' },
  { mark: "''", means: 'inner thought, not said out loud and not heard by anyone' },
  { mark: '(( ))', means: 'me talking to you, out of the story. Never written back, never treated as something a character said.' },
];

/**
 * What your punctuation means, where you are using it.
 *
 * Both halves matter: it is a reminder for you while you write, and it is
 * sent to the model so it reads yours the way you meant and answers in the
 * same marks. A convention only one side knows is not a convention.
 */
async function panelMarks() {
  const s = state.story?.settings || {};
  const n = s.notation || {};
  const marks = (n.marks && n.marks.length ? n.marks : DEFAULT_MARKS);
  const on = n.on !== false;

  const row = (m, i) => `
    <div class="markrow" data-mark="${i}">
      <input type="text" class="mono" data-f="mark" value="${esc(m.mark)}" placeholder="**">
      <input type="text" data-f="means" value="${esc(m.means)}" placeholder="what it means">
      <button class="edit-del" data-mark-del title="Remove">×</button>
    </div>`;

  subSheet('What the marks mean', `
    ${backRow()}
    <div class="why" style="margin-bottom:14px">
      Your shorthand, written down. It is a reminder for you here, and it goes to the model too, so it reads
      yours the way you meant it and writes back in the same marks.
    </div>

    <div class="switch-row">
      <div class="switch-main">
        <div class="switch-title">Tell the model what they mean</div>
        <div class="switch-why">Off, this is only a note to yourself.</div>
      </div>
      <button class="switch" id="mk-on" aria-pressed="${on}"></button>
    </div>

    <div id="marks">${marks.map(row).join('')}</div>
    <button class="btn" id="mk-add" style="margin-top:6px">+ Add one</button>

    <div class="sheet-actions">
      <button class="btn quiet" id="mk-reset">Back to the defaults</button>
      <button class="btn primary" id="mk-save">Save</button>
    </div>`, (root) => {
    const sw = $('#mk-on', root);
    root.addEventListener('click', (e) => {
      if (e.target.closest('.switch')) {
        sw.setAttribute('aria-pressed', String(sw.getAttribute('aria-pressed') !== 'true'));
        return;
      }
      const del = e.target.closest('[data-mark-del]');
      if (del) { del.closest('.markrow').remove(); return; }
      if (e.target.closest('#mk-add')) {
        $('#marks', root).insertAdjacentHTML('beforeend', row({ mark: '', means: '' }, Date.now()));
      }
    });

    const save = async (list) => {
      await applySettings({ notation: { on: sw.getAttribute('aria-pressed') === 'true', marks: list } });
      toast('Saved.', { kind: 'good' });
      goBack();
    };

    $('#mk-save', root).addEventListener('click', () => save(
      $$('.markrow', root)
        .map((el) => ({ mark: $('[data-f="mark"]', el).value.trim(), means: $('[data-f="means"]', el).value.trim() }))
        .filter((m) => m.mark && m.means),
    ));
    $('#mk-reset', root).addEventListener('click', () => save(DEFAULT_MARKS));
  }, null);
}

async function nudge(mode) {
  if (state.streaming) return;
  const btn = $(mode === 'impersonate' ? '#btn-impersonate' : '#btn-continue');
  const other = $(mode === 'impersonate' ? '#btn-continue' : '#btn-impersonate');
  btn.classList.add('is-working');
  other.disabled = true;

  const controller = new AbortController();
  state.streaming = controller;

  // Continuing shows up live on the end of the message it extends; writing
  // your turn shows up live in the box, so you can stop it when it has said
  // enough.
  // The continuation is written into a span tacked onto the end of the last
  // paragraph, so it grows out of the sentence it belongs to rather than
  // appearing underneath as if it were a separate reply.
  let live = null;
  if (mode === 'continue') {
    const lastMsg = $('#messages').lastElementChild;
    const lastPara = lastMsg && [...lastMsg.querySelectorAll('p')].pop();
    if (lastPara) {
      live = document.createElement('span');
      live.className = 'growing';
      lastPara.append(live);
    }
  }
  let got = '';

  try {
    const res = await fetch(`/api/stories/${state.story.id}/${mode}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{}', signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || 'That did not work.');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let failure = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        const type = /^event: (.+)$/m.exec(part)?.[1];
        const raw = /^data: (.*)$/m.exec(part)?.[1];
        if (!type || raw === undefined) continue;
        let data; try { data = JSON.parse(raw); } catch { continue; }
        if (type === 'delta') {
          got += data;
          if (mode === 'impersonate') {
            input.value = got;
            input.style.height = 'auto';
            input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
            input.scrollTop = input.scrollHeight;
            refreshNudges();
          } else if (live) {
            live.textContent = ` ${got}`;
            scrollToEnd();
          }
        } else if (type === 'error') {
          failure = data.message;
        }
      }
    }
    if (failure) throw new Error(failure);

    if (mode === 'impersonate') {
      input.focus();
      toast('Yours to change before you send it.', { ms: 3500 });
    } else {
      state.story = await get(`/api/stories/${state.story.id}`);
      renderMessages();
      scrollToEnd();
    }
  } catch (err) {
    if (err.name !== 'AbortError') toast(err.message, { kind: 'bad' });
    if (live) live.remove();
  } finally {
    state.streaming = null;
    btn.classList.remove('is-working');
    other.disabled = false;
  }
}

/**
 * Only offer "carry on" when the last thing on the page is theirs, and only
 * offer either while the box is empty. Once you have started writing you have
 * already answered the question these two exist to answer, and the row is
 * just taking room away from the story.
 */
function refreshNudges() {
  const msgs = state.story?.messages || [];
  const last = msgs[msgs.length - 1];
  const typing = !!input.value.trim();
  $('#nudges').hidden = !msgs.length;
  // The two offers go away once you have started writing, because by then you
  // have answered the question they exist to ask. The marks stay: that is the
  // one you want open while your hands are on the keyboard.
  $('#btn-impersonate').hidden = typing;
  $('#btn-continue').hidden = typing;
  $('#btn-continue').disabled = !last || last.role !== 'assistant';
  $('#btn-impersonate').disabled = !msgs.length;
}

async function send(regenerateFrom = null) {
  if (state.streaming) return;
  const text = regenerateFrom ? '' : input.value.trim();
  if (!text && !regenerateFrom) return;

  if (text) {
    input.value = '';
    input.style.height = 'auto';
    state.story.messages.push({ id: 'pending-user', role: 'user', content: text, siblings: 1 });
    renderMessages();
  }
  if (regenerateFrom) {
    const i = state.story.messages.findIndex((m) => m.id === regenerateFrom);
    if (i >= 0) state.story.messages.splice(i, 1);
    renderMessages();
  }

  const holder = document.createElement('div');
  holder.className = 'msg pending';
  $('#messages').append(holder);
  scrollToEnd();

  const btn = $('#btn-send');
  btn.classList.add('stop');
  btn.setAttribute('aria-label', 'Stop');

  const controller = new AbortController();
  state.streaming = controller;
  let got = '';

  try {
    const res = await fetch(`/api/stories/${state.story.id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, regenerateFrom }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || 'The message could not be sent.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let failure = null;

    const settle = () => {
      state.streaming = null;
      btn.classList.remove('stop');
      btn.setAttribute('aria-label', 'Send');
      if ($('#messages').contains(holder)) holder.remove();
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const raw of events) {
        const type = /^event: (.+)$/m.exec(raw)?.[1];
        const dataLine = /^data: (.*)$/m.exec(raw)?.[1];
        if (!type || dataLine === undefined) continue;
        let data; try { data = JSON.parse(dataLine); } catch { continue; }

        if (type === 'delta') {
          got += data;
          holder.innerHTML = prose(got);
          const el = $('#story-scroll');
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 260) scrollToEnd(false);
        } else if (type === 'start') {
          state.lastReport = data.report;
          showBudgetWarning(data.report);
        } else if (type === 'done') {
          // The reply is complete: show it as saved right now. The server
          // keeps this stream open while its memory pass runs, and that can
          // take ten seconds; leaving the cursor blinking that long reads as
          // the app having hung.
          settle();
          state.story = await get(`/api/stories/${state.story.id}`);
          renderMessages();
          showTurnNote(data);
        } else if (type === 'remembered') {
          noteRemembered(data);
          refreshNow({ quiet: true });
        } else if (type === 'memory-error') {
          toast('Memory could not read that exchange.', { sub: data.message, kind: 'bad', ms: 7000 });
        } else if (type === 'error') {
          failure = data;
        }
      }
    }

    if (failure) throw new Error(failure.message);
  } catch (err) {
    const stopped = err.name === 'AbortError';
    if (!stopped) {
      holder.remove();
      toast(err.message, { kind: 'bad', ms: 7000 });
    }
    // Whatever happened, the server holds the truth: a stopped reply was
    // kept, a failed regenerate put the old reply back, a failed send may or
    // may not have saved your line. Show what is actually there, and only
    // hand your text back to the box if it was not saved.
    try {
      state.story = await get(`/api/stories/${state.story.id}`);
      renderMessages();
      const last = state.story.messages[state.story.messages.length - 1];
      const saved = last && last.role === 'user' && last.content === text;
      if (!stopped && !got && text && !saved) { input.value = text; input.dispatchEvent(new Event('input')); }
    } catch { /* offline; keep what is on screen */ }
  } finally {
    state.streaming = null;
    btn.classList.remove('stop');
    btn.setAttribute('aria-label', 'Send');
    if ($('#messages').contains(holder)) holder.remove();
  }
}

function showTurnNote(done) {
  const r = state.lastReport;
  if (!r) return;
  const bits = [];
  if (done.cost != null) bits.push(`<b>$${Number(done.cost).toFixed(4)}</b> this message`);
  bits.push(`${num(r.total)} tokens sent`);
  if (r.loreFired) bits.push(`${r.loreFired} lore entries`);
  if (r.episodes) bits.push(`${r.episodes} earlier scene${r.episodes === 1 ? '' : 's'} recalled`);
  if (r.unremembered) bits.push(`<b class="flag">${num(r.unremembered)} messages in neither window nor summary</b>`);
  else if (r.messagesDropped) bits.push(`${num(r.messagesDropped)} older messages folded away`);
  const el = document.createElement('div');
  el.className = 'turn-note';
  el.innerHTML = bits.map((b) => `<span>${b}</span>`).join('');
  $('#messages').append(el);
}

function showBudgetWarning(report) {
  if (!report?.loreOverflowed) return;
  const hint = $('#composer-hint');
  hint.hidden = false;
  hint.innerHTML = `Your lore budget is full — some entries that matched were left out. <button class="msg-tool" id="fix-lore" style="padding:0;text-decoration:underline">Look at it</button>`;
  $('#fix-lore', hint).onclick = showState;
}

// ------------------------------------------------------- message controls

$('#messages').addEventListener('click', async (e) => {
  const tool = e.target.closest('.msg-tool');

  // Tap a turn to see what you can do with it. Edit and Delete sitting under
  // every paragraph is three words of chrome per message, the whole way up a
  // month of writing.
  if (!tool) {
    const msg = e.target.closest('.msg');
    if (!msg || msg.classList.contains('is-last')) return;
    const wasOpen = msg.classList.contains('is-open');
    $$('.msg.is-open').forEach((m) => m.classList.remove('is-open'));
    if (!wasOpen) msg.classList.add('is-open');
    return;
  }
  const id = tool.closest('.msg')?.dataset.id;
  const act = tool.dataset.act;
  if (!id || id.startsWith('pending')) return;

  if (act === 'regen') { send(id); return; }

  if (act === 'delete') {
    if (!confirm('Delete this message and everything after it?')) return;
    await del(`/api/messages/${id}`);
    state.story = await get(`/api/stories/${state.story.id}`);
    renderMessages();
    return;
  }

  if (act === 'edit') {
    const m = state.story.messages.find((x) => x.id === id);
    sheet('Edit', `
      <div class="field">
        <textarea id="edit-text" style="min-height:40dvh">${esc(m.content)}</textarea>
        <div class="why">Editing changes what the AI sees from here on.</div>
      </div>
      <div class="sheet-actions">
        <button class="btn quiet" data-close>Cancel</button>
        <button class="btn primary" id="save-edit">Save</button>
      </div>`, (root) => {
      $('#save-edit', root).addEventListener('click', async () => {
        await post(`/api/messages/${id}/edit`, { content: $('#edit-text', root).value });
        closeSheet();
        state.story = await get(`/api/stories/${state.story.id}`);
        renderMessages();
      });
    });
    return;
  }

  if (act === 'versions') {
    const versions = await get(`/api/messages/${id}/siblings`).catch(() => null);
    sheet('Other versions', versions ? versions.map((v) => `
      <button class="item" data-use="${esc(v.id)}" style="margin-bottom:6px">
        <span class="item-main"><span class="item-sub">${esc(v.content.slice(0, 220))}…</span></span>
      </button>`).join('') : '<div class="empty">Could not load the other versions.</div>',
    (root) => {
      root.addEventListener('click', async (ev) => {
        const b = ev.target.closest('[data-use]');
        if (!b) return;
        await post(`/api/messages/${b.dataset.use}/use`);
        closeSheet();
        state.story = await get(`/api/stories/${state.story.id}`);
        renderMessages();
      });
    });
  }
});

// ------------------------------------------------------------ the story
//
// One screen that shows a story as a story: who is in it, where it happens,
// what it knows, and what the model can see right now. It composes what
// already exists — nothing here is stored, and nothing is copied.

async function storyBible() {
  sheet('The story', '<div class="empty">Reading…</div>');
  let b; let p = null;
  try {
    b = await get(`/api/stories/${state.story.id}/bible`);
    p = await get(`/api/stories/${state.story.id}/prompt`).catch(() => null);
  } catch (err) {
    sheet('The story', `<div class="notice">${esc(err.message)}</div>`); return;
  }

  const who = (c) => `
    <button class="whorow" data-character="${esc(c.id)}">
      <span class="whoface${c.avatar ? '' : ' blank'}">${c.avatar
    ? `<img src="${esc(c.avatar)}" alt="">` : esc(c.name[0].toUpperCase())}</span>
      <span class="whoname">${esc(c.name)}</span>
      <span class="whorole">${esc(c.role === 'lead' ? 'the one it is about' : c.role)}</span>
    </button>`;

  // A section is a count and a heading until you open it. Fifty entries on a
  // story's front page is a database, not a story.
  const fold = (label, count, sub, inner) => `
    <div class="edit-card">
      <div class="edit-head">
        <button class="fold" data-fold aria-expanded="false">›</button>
        <span class="edit-name">${esc(label)}</span>
        <span class="edit-tail">${esc(sub || String(count))}</span>
      </div>
      <div class="edit-body" hidden>${inner}</div>
    </div>`;

  const entryList = (items) => `<div class="fired">${items.map((e) => `
    <div class="fired-row">
      <span class="t">${esc(e.title)}${e.always ? ' <b class="pin">always</b>' : ''}</span>
      <span class="w">${esc((e.keys || []).slice(0, 3).join(', ') || '—')}</span>
    </div>`).join('')}</div>`;

  // What the model can see, taken from the request it would actually send.
  let seeing = '';
  if (p) {
    const fired = p.trace.filter((t) => t.fired);
    const held = p.trace.filter((t) => !t.fired);
    seeing = `
      <div class="seeing">
        <div class="seerow"><b>${num(p.sources.lore.available.total)}</b><span>the story could draw on</span></div>
        <div class="seerow on"><b>${num(p.sources.lore.fired)}</b><span>are in this message</span></div>
        <div class="seerow"><b>${num(p.sources.lore.available.total - p.sources.lore.fired)}</b><span>were not needed</span></div>
      </div>
      ${fired.length ? `<div class="why" style="margin-top:10px">In right now: ${fired.slice(0, 8).map((t) => esc(t.title || 'untitled')).join(' · ')}</div>` : ''}
      ${held.length ? `<div class="why dim">Held back: ${esc(held.slice(0, 5).map((t) => t.title || 'untitled').join(' · '))}${held.length > 5 ? ` and ${num(held.length - 5)} more` : ''}</div>` : ''}`;
  }

  sheet(b.title, `
    ${b.premise ? `<p class="bible-premise">${esc(b.premise.slice(0, 220))}</p>` : ''}

    <h4 class="bible-h">Who</h4>
    <div class="whos">
      ${b.persona ? who({ ...b.persona, role: 'you' }) : '<div class="why">Nobody is playing you in this story.</div>'}
      ${b.cast.map(who).join('')}
      ${(b.npcs || []).map((n) => `
        <div class="whorow">
          <span class="whoface blank">${esc(String(n.name || '?')[0].toUpperCase())}</span>
          <span class="whoname">${esc(n.name)}</span>
          <span class="whorole">${esc(n.role)} · from a source</span>
        </div>`).join('')}
    </div>
    ${b.knownPeople.count ? `<div class="why dim">${num(b.knownPeople.count)} more people are written about in this story's material. They are not cast — they appear when a scene calls for them.</div>` : ''}
    ${(b.excluded || []).length ? `<div class="why dim">Ignored in this story: ${esc(b.excluded.map((x) => x.title).join(', '))}. Still in their source.</div>` : ''}

    <h4 class="bible-h">Its world</h4>
    ${b.sections.map((s) => fold(s.label, s.count,
    `${num(s.count)}${s.always ? ` · ${s.always} always on` : ''}`, entryList(s.items))).join('')}

    <h4 class="bible-h">Where it comes from</h4>
    ${b.sources.connected.map((c) => `
      <div class="srcrow">
        <span class="t">${esc(c.madeForThisStory ? 'Story material' : c.name)}</span>
        <span class="w">${c.madeForThisStory ? 'written for this story · ' : ''}${num(c.entries)} entries${c.recursion === 'block' ? ' · kept from spreading' : ''}</span>
      </div>`).join('')}
    ${b.sources.related.length ? `
      <div class="why" style="margin-top:10px">Not being used, but related:</div>
      ${b.sources.related.map((r) => `
        <div class="srcrow dim"><span class="t">${esc(r.name)}</span><span class="w">${num(r.entries)} entries</span></div>`).join('')}` : ''}

    <h4 class="bible-h">Right now</h4>
    <div class="stat-row"><span>Where</span><span>${esc(b.live.where || 'not established')}</span></div>
    <div class="stat-row"><span>When</span><span>${esc(b.live.when || '—')}</span></div>
    <div class="stat-row"><span>Who is here</span><span>${esc(b.live.who.join(', ') || '—')}</span></div>
    <div class="stat-row"><span>Written so far</span><span>${num(b.live.messages)} messages</span></div>
    <div class="stat-row"><span>Still owed</span><span>${num(b.live.threads)}</span></div>

    <h4 class="bible-h">What it can see</h4>
    ${seeing || '<div class="why">Could not read the current request.</div>'}

    <div class="sheet-actions"><button class="btn primary" data-close>Close</button></div>
  `, (root) => {
    wireFolds(root);
    root.addEventListener('click', (e) => {
      const c = e.target.closest('[data-character]');
      if (c) { pendingBack = storyBible; showCharacter(c.dataset.character); }
    });
  });
}

// --------------------------------------------------------- what it knows

// Lives in Settings now, under "Under the hood". It is a thing you read when
// something looks wrong, not something you want in the corner of a scene.

async function showState() {
  // Reached from Settings, so it gets a way back there like every other panel.
  subSheet('What went into the last message', '<div class="empty">Working it out…</div>',
    null, openStorySettings);
  try {
    const p = await get(`/api/stories/${state.story.id}/prompt`);
    const r = p.report;
    const fired = p.trace.filter((t) => t.fired);
    const held = p.trace.filter((t) => !t.fired);
    const pct = Math.min(100, Math.round(r.loreTokens / r.loreBudget * 100));

    sheet('What went into the last message', `
      ${backRow()}
      <div class="stat-row"><span>Everything sent</span><span>${num(r.total)} tokens</span></div>
      <div class="stat-row"><span>The unchanging part</span><span>${num(r.stable)}</span></div>
      <div class="stat-row"><span>The conversation</span><span>${num(r.history)} (${r.messagesSent} messages)</span></div>
      <div class="stat-row"><span>This moment only</span><span>${num(r.volatile)}</span></div>
      ${r.messagesDropped ? `<div class="notice" style="margin-top:12px">${num(r.messagesDropped)} older messages did not fit and were left out. Memory will fix this properly; for now you can raise the limit in settings.</div>` : ''}

      <!-- Where every part of the unchanging half came from and what it cost.
           This is the thing to read when a reply goes wrong: it says whether
           the world crowded out the person, not just that both were sent. -->
      <h3 style="font-size:14px;margin:18px 0 4px">What made up the unchanging part</h3>
      <div class="fired">
        ${(p.sources?.stable || []).map((sec) => `
          <div class="fired-row"><span class="t">${esc(sec.label)}</span><span class="w">${num(sec.tokens)}</span></div>`).join('')}
      </div>

      ${r.framework ? `
        <h3 style="font-size:14px;margin:18px 0 4px">The world: ${esc(r.framework.name)}</h3>
        <div style="font-size:12.5px;color:var(--ink-soft);margin-bottom:10px">
          ${num(r.framework.tokens)} tokens — ${esc(r.framework.included.join(', ') || 'nothing went in')}.
          ${r.framework.loreEntries ? `Its lorebook of ${num(r.framework.loreEntries)} entries is available to be drawn on; ${num(p.sources.lore.fromWorld)} of them answered this scene.` : ''}
        </div>
        ${r.framework.trimmed.length ? `<div class="fired">${r.framework.trimmed.map((t) => `
          <div class="fired-row no"><span class="t">${esc(t.what)}</span><span class="w">trimmed ${num(t.from)} → ${num(t.to)}</span></div>`).join('')}</div>` : ''}
        ${r.framework.dropped.length ? `<div class="fired">${r.framework.dropped.map((d) => `
          <div class="fired-row no"><span class="t">${esc(d.what)}</span><span class="w">${esc(d.why)}</span></div>`).join('')}</div>` : ''}
      ` : ''}

      <h3 style="font-size:14px;margin:18px 0 4px">Lore</h3>
      <div class="meter-bar${pct >= 99 ? ' full' : ''}"><i style="width:${pct}%"></i></div>
      <div style="font-size:12.5px;color:var(--ink-soft);margin-bottom:10px">
        ${num(r.loreTokens)} of ${num(r.loreBudget)} tokens used${r.loreOverflowed ? ' — full, entries were turned away' : ''}
      </div>
      <div class="fired">
        ${fired.map((t) => `<div class="fired-row"><span class="t">${esc(t.title || t.keys?.[0] || 'untitled')}</span><span class="w">${esc(t.why)}</span></div>`).join('')}
        ${held.length ? `<div class="fired-row" style="border:0;padding-top:10px"><span class="t" style="color:var(--ink-faint)">Held back</span></div>` : ''}
        ${held.slice(0, 40).map((t) => `<div class="fired-row no"><span class="t">${esc(t.title || 'untitled')}</span><span class="w">${esc(t.why)}</span></div>`).join('')}
      </div>
      <div class="sheet-actions">
        <button class="btn quiet" data-back>Back</button>
        <button class="btn primary" data-close>Close</button>
      </div>`);
  } catch (err) {
    sheet('What went into the last message', `${backRow()}<div class="notice">${esc(err.message)}</div>`);
  }
}

// ------------------------------------------------------------ model picker

$('#btn-model').addEventListener('click', async () => {
  sheet('Which model writes', '<div class="empty">Loading…</div>');
  try {
    if (!state.models) state.models = (await get('/api/models')).models;
    if (!state.settings) state.settings = await get('/api/settings');
    const favs = state.settings.favouriteModels;
    const current = state.story.settings.model;
    const list = [...state.models].sort((a, b) => {
      const fa = favs.indexOf(a.id), fb = favs.indexOf(b.id);
      if (fa !== fb) return (fa < 0 ? 99 : fa) - (fb < 0 ? 99 : fb);
      return a.promptPrice - b.promptPrice;
    });
    sheet('Which model writes', `
      <div class="why" style="margin-bottom:10px">Prices are per million tokens. You can change this mid-story.</div>
      ${picker(list.slice(0, 60).map((m) => ({
        id: m.id,
        title: m.name,
        sub: m.free ? 'Free — but the provider may train on your story'
          : `in $${m.promptPrice.toFixed(2)} · out $${m.completionPrice.toFixed(2)}${m.cachePrice ? ` · cached $${m.cachePrice.toFixed(3)}` : ''} · ${num(m.context / 1000)}k context`,
      })), { multi: false, selected: new Set([current]) })}
      <div class="sheet-actions"><button class="btn quiet" data-close>Cancel</button><button class="btn primary" id="use-model">Use it</button></div>`,
    (root) => {
      wirePicker(root);
      $('#use-model', root).addEventListener('click', async () => {
        const id = picked(root)[0];
        if (!id) { toast('Pick one.'); return; }
        const settings = { ...state.story.settings, model: id };
        await patch(`/api/stories/${state.story.id}`, { settings });
        state.story.settings = settings;
        $('#btn-model').textContent = shortModel(id);
        closeSheet();
        toast(`Now writing with ${shortModel(id)}.`, { kind: 'good' });
      });
    });
  } catch (err) {
    sheet('Which model writes', `<div class="notice">${esc(err.message)}</div>`);
  }
});

// --------------------------------------------------------------- settings

// --------------------------------------------------- the app's own settings
//
// Everything heavy lives here, outside any story: writing the presets, and
// deciding what a new story starts as. Inside a story you only pick and
// nudge. Until this existed there was nothing to set before you were already
// in a scene, which is the wrong place to be reading about token budgets.

$('#btn-settings').addEventListener('click', openAppSettings);

async function openAppSettings() {
  let credit = null;
  try { credit = await get('/api/credits'); } catch { /* no key, or offline */ }
  const s = state.settings || (state.settings = await get('/api/settings'));
  const presets = (await get('/api/presets').catch(() => ({ presets: [] }))).presets;
  const scripted = presets.filter((p) => p.settings?.script);
  const gate = await get('/api/gate').catch(() => null);

  const row = (id, title, value) => `
    <button class="menu-row" data-app="${id}">
      <span class="menu-main">
        <span class="menu-title">${esc(title)}</span>
        <span class="menu-val">${esc(value)}</span>
      </span>
      <span class="menu-arrow"><svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg></span>
    </button>`;

  sheet('Settings', `
    <div class="sec-head" style="margin-top:0">Appearance</div>
    <div class="theme-options" role="group" aria-label="Theme">
      ${[['light', 'Light'], ['dark', 'Dark'], ['system', 'Follow my phone']]
        .map(([value, label]) => `<button class="theme-option" data-theme-choice="${value}"
          aria-pressed="${themeChoice === value}">${label}</button>`).join('')}
    </div>

    <div class="sec-head">Before you start</div>
    <div class="hint">Set once. Every new story begins here.</div>
    <div class="menu">
      ${row('presets', 'Presets', scripted.length
        ? `${num(scripted.length)} with controls, ${num(presets.length - scripted.length)} plain`
        : `${num(presets.length)}, none with controls yet`)}
      ${row('defaults', 'What a new story starts as', 'Model, length, memory, pacing')}
      ${row('guide', 'What everything here does', 'Every setting explained, and what to reach for')}
      ${row('examples', 'Worked examples', 'A character and a lorebook you can import and take apart')}
    </div>

    <div class="sec-head">Getting in</div>
    <div class="menu">
      ${row('lock', 'Password', gate?.needsPassword
        ? `Set${gate.sessions > 1 ? `, ${num(gate.sessions)} devices signed in` : ''}`
        : 'None yet — anyone who reaches this app is you')}
    </div>

    <div class="sec-head">This app</div>
    <div class="stat-row"><span>API key</span><span>${s.hasKey ? 'found' : 'missing — put one in .env'}</span></div>
    ${credit ? `<div class="stat-row"><span>OpenRouter balance</span><span>$${credit.remaining.toFixed(2)}</span></div>` : ''}
    <div class="stat-row"><span>Characters</span><span>${num(state.library.stats.characters)}</span></div>
    <div class="stat-row"><span>Lore entries</span><span>${num(state.library.stats.entries)}</span></div>
    <div class="stat-row"><span>Messages written</span><span>${num(state.library.stats.messages)}</span></div>

    <div class="sheet-actions"><button class="btn quiet" data-close>Close</button></div>`, (root) => {
    root.addEventListener('click', (e) => {
      const pick = e.target.closest('[data-theme-choice]');
      if (pick) {
        setTheme(pick.dataset.themeChoice);
        $$('[data-theme-choice]', root).forEach((b) => b.setAttribute('aria-pressed', String(b === pick)));
        return;
      }
      const go = e.target.closest('[data-app]');
      if (!go) return;
      pendingBack = openAppSettings;
      ({
        presets: panelPresetLibrary, defaults: panelStoryDefaults,
        guide: panelGuide, examples: panelExamples, lock: panelLock,
      })[go.dataset.app]();
    });
  });
}

/** Every preset you have, and the way into the editor. */
async function panelPresetLibrary() {
  const presets = (await get('/api/presets')).presets;
  subSheet('Presets', `
    ${backRow()}
    <div class="why" style="margin-bottom:12px">
      A preset with controls writes the whole prompt and puts named choices in front of you instead of numbers.
      A plain one is just the dials. Both live here; you choose one inside a story.
    </div>
    <div class="list">
      ${presets.map((p) => {
    const sc = p.settings?.script;
    return `
        <button class="item" data-preset="${esc(p.id)}">
          <span class="item-main">
            <span class="item-title">${esc(p.name)}</span>
            <span class="item-sub">${sc
      ? `${num(sc.controls.length)} controls · ${num(sc.items.length)} prompt blocks${sc.bundles?.length ? ` · ${num(sc.bundles.length)} setups` : ''}`
      : esc(describePreset(p.settings))}</span>
            ${p.builtin ? '<span class="item-meta">comes with the app</span>' : ''}
          </span>
          <span class="item-tail">${sc ? 'edit' : 'dials'}</span>
        </button>`;
  }).join('')}
    </div>
    <div class="row-actions" style="margin-top:14px">
      <button class="btn primary" id="preset-import">+ Add a preset file</button>
      <button class="btn" id="preset-url">From a link</button>
      <button class="btn" id="preset-blank">Write one</button>
    </div>
    <div class="hint" style="margin-top:8px">
      Two kinds of file work. One writes the prompt with named controls you can tap.
      The older kind is a couple of blocks of writing rules plus the dials, and it is converted into the
      first kind on the way in, so you can open it and add controls to it afterwards.
    </div>
    <div class="sheet-actions"><button class="btn quiet" data-back>Back</button></div>`, (root) => {
    root.addEventListener('click', (e) => {
      const p = e.target.closest('[data-preset]');
      if (p) panelPresetEditor(p.dataset.preset);
    });
    $('#preset-import', root).addEventListener('click', () => $('#file-input').click());
    $('#preset-url', root).addEventListener('click', () => importFromUrl());
    $('#preset-blank', root).addEventListener('click', async () => {
      const name = prompt('Call it what?');
      if (!name || !name.trim()) return;
      const { id } = await post('/api/presets', { name: name.trim(), settings: {} });
      await post(`/api/presets/${id}/script`, { script: blankScript(name.trim()) });
      panelPresetEditor(id);
    });
  }, openAppSettings);
}

/** The smallest preset that actually works, as a starting point. */
function blankScript(name) {
  return {
    name,
    meta: { description: 'Written here.' },
    items: [
      { name: 'Narrator', role: 'system', enabled: true, content: 'You are the narrator of an ongoing story. {{user}} plays their own character; you play everyone and everything else.\n\n{{character}}\n\n{{persona}}\n\n{{lorebook}}' },
      { name: 'Earlier', role: 'system', enabled: true, content: '<earlier>\n{{memory}}\n</earlier>' },
      { name: 'The story so far', role: 'system', enabled: true, content: '{{chatHistory}}' },
      { name: 'Style', role: 'system', enabled: true, content: '<style>\n{{pov}}\n</style>' },
    ],
    controls: [{
      id: 'ctrl_pov', macro: 'pov', label: 'Point of view', group: 'Narration',
      help: 'Whose eyes the scene is seen through.', advice: 'recommended', type: 'radio',
      defaultOptionId: 'pov_third',
      options: [
        { id: 'pov_first', label: 'First person', description: 'Closest to one head.', injectedText: 'Narrate in first person, as "I".' },
        { id: 'pov_third', label: 'Third person', description: 'The conventional choice.', injectedText: 'Narrate in third person limited.' },
      ],
    }],
    sections: [{ id: 'Narration', title: 'Narration', description: 'How the sentences sound.' }],
    bundles: [],
    pruneEmptyBlocks: true,
  };
}

// ------------------------------------------------------------- the password
//
// Set it here, change it here, and end every session from here. There is
// deliberately no reset by email or anything else: one person, one password,
// and if it is forgotten you clear it on the machine the app runs on.

async function panelLock() {
  const g = await get('/api/gate');
  const sessions = g.needsPassword
    ? (await get('/api/gate/sessions').catch(() => ({ sessions: [] }))).sessions
    : [];

  subSheet('Password', `
    ${backRow()}
    ${g.needsPassword ? `
      <div class="why" style="margin-bottom:14px">
        Set. Everything is behind it: your stories, your balance, and your key.
        A device stays signed in for three months.
      </div>
      <div class="field">
        <label for="lk-cur">Your current password</label>
        <input type="password" id="lk-cur" autocomplete="current-password">
      </div>
    ` : `
      <div class="notice" style="margin-bottom:14px">
        <b>No password yet.</b> That is fine while this only answers to your own computer.
        The moment it has an address you can reach from outside, anyone who finds that address has your
        stories and can spend your balance. Set one before you open that door, not after.
      </div>
    `}
    <div class="field">
      <label for="lk-new">${g.needsPassword ? 'A new password' : 'A password'}</label>
      <input type="password" id="lk-new" autocomplete="new-password" placeholder="at least 8 characters">
    </div>
    <div class="field">
      <label for="lk-new2">And again</label>
      <input type="password" id="lk-new2" autocomplete="new-password">
    </div>
    <button class="btn primary" id="lk-save" style="width:100%">${g.needsPassword ? 'Change it' : 'Set it'}</button>
    ${g.needsPassword ? '<div class="hint" style="margin-top:8px">Changing it signs out every device, including this one.</div>' : ''}

    ${sessions.length ? `
      <div class="sec-head">Signed in</div>
      <div class="list">
        ${sessions.map((s) => `
          <div class="item">
            <span class="item-main">
              <span class="item-title">${esc(shortAgent(s.label))}</span>
              <span class="item-meta">
                <span>since ${when(s.started)}</span>
                <span>expires ${new Date(s.until).toLocaleDateString()}</span>
              </span>
            </span>
          </div>`).join('')}
      </div>
      <div class="row-actions" style="margin-top:10px">
        <button class="btn" id="lk-endall">Sign out everywhere</button>
      </div>` : ''}

    <div class="sheet-actions"><button class="btn quiet" data-back>Back</button></div>`, (root) => {
    $('#lk-save', root).addEventListener('click', async (e) => {
      const a = $('#lk-new', root).value;
      const b = $('#lk-new2', root).value;
      if (a !== b) { toast('Those two do not match.', { kind: 'bad' }); return; }
      e.currentTarget.disabled = true;
      try {
        await post('/api/gate/set', {
          password: a,
          current: g.needsPassword ? $('#lk-cur', root).value : undefined,
        });
        toast('Saved. This device stays signed in; everything else was signed out.', { kind: 'good', ms: 6000 });
        panelLock();
      } catch (err) {
        toast(err.message, { kind: 'bad' });
        e.currentTarget.disabled = false;
      }
    });
    const endAll = $('#lk-endall', root);
    if (endAll) endAll.addEventListener('click', async () => {
      if (!confirm('Sign out every device, including this one?')) return;
      await post('/api/gate/sessions/end-all');
      location.reload();
    });
  }, openAppSettings);
}

/** A browser's user-agent string is not a device name, but it contains one. */
function shortAgent(ua) {
  const s = String(ua || '');
  if (!s) return 'a device';
  if (/iPhone/i.test(s)) return 'an iPhone';
  if (/iPad/i.test(s)) return 'an iPad';
  if (/Android/i.test(s)) return 'an Android phone';
  if (/Windows/i.test(s)) return 'a Windows computer';
  if (/Mac OS X|Macintosh/i.test(s)) return 'a Mac';
  if (s === 'this device') return 'this device';
  return 'a device';
}

// ---------------------------------------------------------- worked examples
//
// The fastest way to understand a format is to import one that works and open
// it. Both of these are ordinary files: they import here and anywhere else.

async function panelExamples() {
  const t = (await get('/api/templates')).templates;
  subSheet('Worked examples', `
    ${backRow()}
    <div class="why" style="margin-bottom:14px">
      Real files, not screenshots. Put one in your library and open it: the notes inside say what each field is for
      and which ones quietly override your settings. Then change it into your own, or delete it.
    </div>
    <div class="list">
      ${t.map((x) => `
        <div class="item">
          <span class="item-main">
            <span class="item-title">${esc(x.name)}</span>
            <span class="item-sub">${esc(x.about)}</span>
            <span class="item-meta"><span>${esc(x.file)}</span><span>${num(x.bytes / 1024)} KB</span></span>
          </span>
        </div>
        <div class="row-actions" style="margin:-1px 0 10px">
          <button class="btn primary" data-use="${esc(x.file)}">Put it in my library</button>
          <a class="btn" href="${esc(x.url)}" download>Download the file</a>
        </div>`).join('')}
    </div>
    <div class="sheet-actions"><button class="btn quiet" data-back>Back</button></div>`, (root) => {
    root.addEventListener('click', async (e) => {
      const use = e.target.closest('[data-use]');
      if (!use) return;
      use.disabled = true;
      try {
        const r = await post(`/api/templates/${use.dataset.use}/use`);
        await loadLibrary();
        toast(`${r.name} is in your library.`, { kind: 'good', sub: r.detail });
      } catch (err) { toast(err.message, { kind: 'bad' }); }
      use.disabled = false;
    });
  }, openAppSettings);
}

// ------------------------------------------------------------------- guide
//
// Every setting explained, plus what to reach for when you want a particular
// kind of story. Loaded only when opened, so it costs nothing the rest of the
// time.

async function panelGuide() {
  const G = await import('./guide.js');

  subSheet('What everything here does', `
    ${backRow()}
    <div class="why" style="margin-bottom:12px">
      Two halves. What to reach for when you want a certain kind of story, and what each thing actually is.
    </div>

    <div class="sec-head" style="margin-top:0">If you want…</div>
    <div class="list">
      ${G.RECIPES.map((r) => `
        <button class="item" data-recipe="${esc(r.id)}">
          <span class="item-main">
            <span class="item-title">${esc(r.name)}</span>
            <span class="item-sub">${esc(r.about)}</span>
          </span>
          <span class="item-tail">${num(r.dials.length)} dials</span>
        </button>`).join('')}
    </div>

    <div class="sec-head">Everything, explained</div>
    ${G.TOPICS.map((t) => `
      <div class="edit-card">
        <div class="edit-head">
          <button class="fold" data-fold aria-expanded="false">›</button>
          <span class="edit-name">${esc(t.title)}</span>
          <span class="edit-tail">${num(t.entries.length)}</span>
        </div>
        <div class="edit-body" hidden>
          ${t.entries.map(([h, body]) => `
            <div style="margin:10px 0">
              <div style="font-size:14.5px;font-weight:500">${esc(h)}</div>
              <div class="why" style="margin-top:3px">${body}</div>
            </div>`).join('')}
        </div>
      </div>`).join('')}

    <div class="sheet-actions"><button class="btn quiet" data-back>Back</button></div>`, (root) => {
    wireFolds(root);
    root.addEventListener('click', (e) => {
      const r = e.target.closest('[data-recipe]');
      if (r) showRecipe(G.RECIPES.find((x) => x.id === r.dataset.recipe));
    });
  }, openAppSettings);
}

function showRecipe(r) {
  subSheet(r.name, `
    ${backRow()}
    <div class="why" style="margin-bottom:14px">${esc(r.about)}</div>
    ${r.dials.map(([what, set, why]) => `
      <div class="ctrl">
        <div class="ctrl-top">
          <span class="ctrl-label">${esc(what)}</span>
          <span class="badge recommended" style="margin-left:auto">${set}</span>
        </div>
        <div class="ctrl-help" style="margin-bottom:0">${esc(why)}</div>
      </div>`).join('')}
    <div class="notice" style="margin-top:6px"><b>Watch for this.</b> ${esc(r.watch)}</div>
    <div class="sheet-actions"><button class="btn quiet" data-back>Back</button></div>`, null, panelGuide);
}

// ------------------------------------------------------------ preset editor
//
// The whole advanced half, and it lives out here rather than behind a story
// so that writing a preset and playing with one are two different activities
// in two different places.

const ADVICE_OPTS = ['recommended', 'optional', 'troubleshooting', 'advanced'];
const TYPE_OPTS = [
  ['radio', 'Buttons, pick one'],
  ['select', 'Dropdown, pick one'],
  ['range', 'A span between two numbers'],
  ['tags', 'Chips you switch on and off'],
  ['toggle', 'On or off'],
  ['textarea', 'A box you type in'],
];

async function panelPresetEditor(id) {
  const p = await get(`/api/presets/${id}`);
  if (!p.script) {
    // A plain preset has no prompt of its own to edit; it is just the dials.
    subSheet(p.name, `
      ${backRow()}
      <div class="why">This is a plain preset: a saved set of the writing dials, with no prompt of its own.
      There is nothing to write here. Load it inside a story from <b>Writing preset</b>.</div>
      <div class="sheet-actions"><button class="btn quiet" data-back>Back</button></div>`);
    return;
  }

  // Edited in memory and written when you save, so a half-finished rename
  // never reaches a story mid-scene.
  const S = JSON.parse(JSON.stringify(p.script));
  const macros = await get('/api/macros').catch(() => ({ groups: [] }));
  let dirty = false;

  const tokensOf = (t) => num(Math.ceil(String(t || '').length / 4));

  const itemCard = (it, i) => `
    <div class="edit-card" data-item="${i}">
      <div class="edit-head">
        <button class="fold" data-fold aria-expanded="false">›</button>
        <span class="edit-kind">${esc(it.role)}</span>
        <span class="edit-name">${esc(it.name)}</span>
        <span class="edit-tail">${tokensOf(it.content)}</span>
        <button class="switch sm" data-item-on aria-pressed="${it.enabled !== false}"></button>
        <button class="edit-del" data-item-del title="Remove">×</button>
      </div>
      <div class="edit-body" hidden>
        <div class="field"><label>Name</label><input type="text" data-f="name" value="${esc(it.name)}"></div>
        <div class="field"><label>Role</label>
          <select class="sel" data-f="role">
            ${['system', 'user', 'assistant'].map((r) => `<option ${r === it.role ? 'selected' : ''}>${r}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Prompt content</label>
          <textarea data-f="content" rows="9">${esc(it.content)}</textarea>
        </div>
        <div class="field"><label>Note to yourself <span class="hint" style="display:inline">never sent</span></label>
          <textarea data-f="note" rows="3">${esc(it.note || '')}</textarea>
        </div>
      </div>
    </div>`;

  const optRow = (o, j) => `
    <div class="opt-edit" data-opt="${j}">
      <input type="text" data-f="label" value="${esc(o.label)}" placeholder="what it is called">
      <input type="text" data-f="injectedText" value="${esc(o.injectedText)}" placeholder="the words it puts in the prompt">
      <input type="text" data-f="description" value="${esc(o.description || '')}" placeholder="what it does, in plain words">
      <button class="edit-del" data-opt-del title="Remove">×</button>
    </div>`;

  const ctrlCard = (c, i) => `
    <div class="edit-card" data-ctrl="${i}">
      <div class="edit-head">
        <button class="fold" data-fold aria-expanded="false">›</button>
        <span class="edit-kind">${esc(c.type)}</span>
        <span class="edit-name">${esc(c.label)}</span>
        <span class="edit-tail mono">{{${esc(c.macro)}}}</span>
        <button class="edit-del" data-ctrl-del title="Remove">×</button>
      </div>
      <div class="edit-body" hidden>
        <div class="two">
          <div class="field"><label>Label</label><input type="text" data-f="label" value="${esc(c.label)}"></div>
          <div class="field"><label>Macro</label><input type="text" class="mono" data-f="macro" value="${esc(c.macro)}"></div>
        </div>
        <div class="two">
          <div class="field"><label>Type</label>
            <select class="sel" data-f="type">${TYPE_OPTS.map(([v, l]) => `<option value="${v}" ${v === c.type ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
          </div>
          <div class="field"><label>Section</label><input type="text" data-f="group" value="${esc(c.group || '')}"></div>
        </div>
        <div class="field"><label>Help text</label><textarea data-f="help" rows="2">${esc(c.help || '')}</textarea></div>
        <div class="field"><label>Badge</label>
          <select class="sel" data-f="advice">${ADVICE_OPTS.map((a) => `<option value="${a}" ${a === c.advice ? 'selected' : ''}>${esc(ADVICE[a] || a)}</option>`).join('')}</select>
        </div>

        ${['radio', 'select', 'tags'].includes(c.type) ? `
          <div class="field"><label>Options</label>
            <div class="opts-edit">${(c.options || []).map(optRow).join('')}</div>
            <button class="btn" data-opt-add style="margin-top:6px">+ Add option</button>
          </div>` : ''}

        ${c.type === 'range' ? `
          <div class="two">
            <div class="field"><label>Lowest</label><input type="number" data-f="min" value="${c.min}"></div>
            <div class="field"><label>Highest</label><input type="number" data-f="max" value="${c.max}"></div>
          </div>
          <div class="two">
            <div class="field"><label>Steps of</label><input type="number" data-f="step" value="${c.step}"></div>
            <div class="field"><label>Starts at</label><input type="text" data-f="defaultRange" value="${(c.defaultRange || []).join(', ')}"></div>
          </div>
          <div class="field"><label>What it writes</label>
            <input type="text" data-f="rangeTemplate" value="${esc(c.rangeTemplate || '')}" placeholder="Aim for {{min}} to {{max}} words.">
            <div class="hint">Use {{min}} and {{max}} for the two ends.</div>
          </div>` : ''}

        ${c.type === 'toggle' ? `
          <div class="field"><label>What it writes when on</label><textarea data-f="onText" rows="2">${esc(c.onText || '')}</textarea></div>
          <div class="field"><label>…and when off</label><textarea data-f="offText" rows="2">${esc(c.offText || '')}</textarea></div>` : ''}

        ${c.type === 'textarea' ? `
          <div class="field"><label>Placeholder</label><input type="text" data-f="placeholder" value="${esc(c.placeholder || '')}"></div>
          <div class="field"><label>How your text is wrapped</label>
            <textarea data-f="textTemplate" rows="2">${esc(c.textTemplate || '{{value}}')}</textarea>
            <div class="hint">{{value}} is what you typed.</div>
          </div>` : ''}
      </div>
    </div>`;

  const render = () => subSheet(S.name, `
    ${backRow()}

    <div class="edit-card">
      <div class="edit-head">
        <button class="fold" data-fold aria-expanded="false">›</button>
        <span class="edit-name">${esc(S.name)}</span>
        <span class="edit-tail">${esc(S.meta.author ? `by ${S.meta.author}` : 'name, author, blurb')}</span>
      </div>
      <div class="edit-body" hidden>
        <div class="field"><label>Name</label><input type="text" id="p-name" value="${esc(S.name)}"></div>
        <div class="two">
          <div class="field"><label>Author</label><input type="text" id="p-author" value="${esc(S.meta.author || '')}"></div>
          <div class="field"><label>Version</label><input type="text" id="p-version" value="${esc(S.meta.version || '')}"></div>
        </div>
        <div class="field"><label>What it is</label><textarea id="p-desc" rows="4">${esc(S.meta.description || '')}</textarea></div>
      </div>
    </div>

    <div class="sec-head">Prompt blocks <span class="hint" style="display:inline">${tokensOf(S.items.map((i) => i.content).join(''))} tokens</span></div>
    <div class="hint">In order. Whatever sits above ${'{{chatHistory}}'} is the part that gets cached; below it is charged in full every message.</div>
    <div id="items">${S.items.map(itemCard).join('')}</div>
    <button class="btn" id="item-add" style="margin-top:6px">+ Add a block</button>

    <div class="sec-head">Controls</div>
    <div class="hint">Each one fills a ${'{{macro}}'} hole in the blocks above, and says in plain words what its choices do.</div>
    <div id="ctrls">${S.controls.map(ctrlCard).join('')}</div>
    <button class="btn" id="ctrl-add" style="margin-top:6px">+ Add a control</button>

    <div class="sec-head">Ready-made setups</div>
    <div class="hint">A named set of every control's value, so one tap changes the whole feel.</div>
    <div id="setups">${(S.bundles || []).map((b, i) => `
      <div class="edit-card" data-bundle="${i}">
        <div class="edit-head">
          <span class="edit-name">${esc(b.name)}</span>
          <span class="edit-tail">${num(Object.keys(b.values || {}).length)} values</span>
          <button class="edit-del" data-bundle-del title="Remove">×</button>
        </div>
      </div>`).join('')}</div>
    <button class="btn" id="setup-add" style="margin-top:6px">+ Capture the current values as a setup</button>

    <div class="sec-head">Options</div>
    <div class="switch-row">
      <div class="switch-main">
        <div class="switch-title">Drop empty blocks</div>
        <div class="switch-why">A tag whose macros all came back empty goes away instead of shipping bare tags.</div>
      </div>
      <button class="switch" id="p-prune" aria-pressed="${S.pruneEmptyBlocks !== false}"></button>
    </div>
    <div class="field"><label>Example separator</label>
      <input type="text" id="p-sep" value="${esc(S.exampleSeparator || '***')}">
      <div class="hint">Replaces &lt;START&gt; between example-dialogue blocks.</div>
    </div>

    <div class="sec-head">Macros you can write</div>
    <div class="hint">${esc(macros.volatileNote || '')}</div>
    ${(macros.groups || []).map((g) => `
      <div style="margin-top:10px">
        <div class="hint" style="text-transform:uppercase;letter-spacing:.05em">${esc(g.title)}</div>
        <div class="chips" style="margin-top:5px">
          ${g.macros.map((m) => `<button type="button" class="chip-tag" data-macro-copy="${esc(m.name)}" title="${esc(m.about)}${m.volatile ? ' — sent after the conversation' : ''}">{{${esc(m.name)}}}</button>`).join('')}
        </div>
      </div>`).join('')}

    <div class="sheet-actions">
      <button class="btn quiet" data-back>Back</button>
      <button class="btn primary" id="p-save">Save${p.builtin ? ' as my own' : ''}</button>
    </div>`, (root) => {
    // Reading the form back is one function used by save and by anything that
    // re-renders, so a field can never be written in one and forgotten in the
    // other.
    const collect = () => {
      S.name = $('#p-name', root).value.trim() || S.name;
      S.meta.author = $('#p-author', root).value.trim();
      S.meta.version = $('#p-version', root).value.trim();
      S.meta.description = $('#p-desc', root).value;
      S.pruneEmptyBlocks = $('#p-prune', root).getAttribute('aria-pressed') === 'true';
      S.exampleSeparator = $('#p-sep', root).value || '***';

      S.items = $$('[data-item]', root).map((el) => ({
        name: $('[data-f="name"]', el).value.trim() || 'Block',
        role: $('[data-f="role"]', el).value,
        content: $('[data-f="content"]', el).value,
        note: $('[data-f="note"]', el).value,
        enabled: $('[data-item-on]', el).getAttribute('aria-pressed') === 'true',
      }));

      S.controls = $$('[data-ctrl]', root).map((el, i) => {
        const old = S.controls[Number(el.dataset.ctrl)] || {};
        const get_ = (f) => $(`[data-f="${f}"]`, el)?.value;
        const c = {
          ...old,
          id: old.id || `ctrl_${i}`,
          label: get_('label') || old.label,
          macro: (get_('macro') || old.macro || '').trim(),
          type: get_('type') || old.type,
          group: get_('group') || '',
          help: get_('help') ?? old.help,
          advice: get_('advice') || old.advice,
        };
        const opts = $$('[data-opt]', el);
        if (opts.length) {
          c.options = opts.map((o, j) => ({
            id: old.options?.[j]?.id || `opt_${i}_${j}`,
            label: $('[data-f="label"]', o).value,
            injectedText: $('[data-f="injectedText"]', o).value,
            description: $('[data-f="description"]', o).value,
          }));
          if (!c.options.some((o) => o.id === c.defaultOptionId)) c.defaultOptionId = c.options[0]?.id || '';
        }
        for (const f of ['min', 'max', 'step']) if (get_(f) !== undefined) c[f] = Number(get_(f));
        if (get_('defaultRange') !== undefined) c.defaultRange = get_('defaultRange').split(/[,\s]+/).filter(Boolean).map(Number);
        for (const f of ['rangeTemplate', 'onText', 'offText', 'placeholder', 'textTemplate']) {
          if (get_(f) !== undefined) c[f] = get_(f);
        }
        return c;
      });

      // Sections are named by the controls themselves, so renaming a group on
      // a control cannot leave a section behind with nothing in it.
      const groups = [...new Set(S.controls.map((c) => c.group).filter(Boolean))];
      S.sections = groups.map((gname) => S.sections?.find((x) => x.id === gname) || { id: gname, title: gname, description: '' });
      return S;
    };

    wireFolds(root);
    root.addEventListener('click', async (e) => {
      const sw = e.target.closest('.switch');
      if (sw) { sw.setAttribute('aria-pressed', String(sw.getAttribute('aria-pressed') !== 'true')); dirty = true; return; }

      const copy = e.target.closest('[data-macro-copy]');
      if (copy) {
        const text = `{{${copy.dataset.macroCopy}}}`;
        navigator.clipboard?.writeText(text);
        toast(`${text} copied.`);
        return;
      }

      if (e.target.closest('[data-item-del]')) { collect(); S.items.splice(Number(e.target.closest('[data-item]').dataset.item), 1); render(); return; }
      if (e.target.closest('[data-ctrl-del]')) { collect(); S.controls.splice(Number(e.target.closest('[data-ctrl]').dataset.ctrl), 1); render(); return; }
      if (e.target.closest('[data-bundle-del]')) { collect(); S.bundles.splice(Number(e.target.closest('[data-bundle]').dataset.bundle), 1); render(); return; }
      if (e.target.closest('[data-opt-del]')) {
        collect();
        const cEl = e.target.closest('[data-ctrl]');
        S.controls[Number(cEl.dataset.ctrl)].options.splice(Number(e.target.closest('[data-opt]').dataset.opt), 1);
        render(); return;
      }
      if (e.target.closest('[data-opt-add]')) {
        collect();
        const i = Number(e.target.closest('[data-ctrl]').dataset.ctrl);
        (S.controls[i].options ||= []).push({ id: `opt_${i}_${Date.now()}`, label: 'New choice', injectedText: '', description: '' });
        render(); return;
      }
      if (e.target.closest('#item-add')) {
        collect();
        S.items.push({ name: 'New block', role: 'system', content: '', note: '', enabled: true });
        render(); return;
      }
      if (e.target.closest('#ctrl-add')) {
        collect();
        const n = S.controls.length;
        S.controls.push({
          id: `ctrl_${Date.now()}`, macro: `newControl${n}`, label: 'New control', type: 'radio',
          group: S.sections[0]?.id || 'Narration', help: '', advice: 'optional',
          options: [{ id: `opt_${n}_a`, label: 'One way', injectedText: '', description: '' }],
        });
        render(); return;
      }
      if (e.target.closest('#setup-add')) {
        collect();
        const name = prompt('Call this setup what?');
        if (!name || !name.trim()) return;
        const values = {};
        for (const c of S.controls) {
          if (!c.macro) continue;
          values[c.macro] = p.values[c.macro] ?? (c.type === 'radio' || c.type === 'select' ? c.defaultOptionId : undefined);
        }
        (S.bundles ||= []).push({ id: `kit_${Date.now()}`, name: name.trim(), description: '', values });
        render(); return;
      }

      if (e.target.closest('#p-save')) {
        collect();
        const r = await post(`/api/presets/${id}/script`, { script: S }).catch((err) => { toast(err.message, { kind: 'bad' }); return null; });
        if (!r) return;
        dirty = false;
        toast(r.forked ? 'Saved as your own copy.' : 'Saved.', {
          kind: 'good',
          sub: r.notes.length ? r.notes[0] : `${num(r.cost.total)} tokens of controls`,
        });
        panelPresetLibrary();
      }
    });

    root.addEventListener('input', () => { dirty = true; });
    root.addEventListener('change', (e) => {
      // Changing a control's type changes which fields it needs.
      if (e.target.matches('[data-f="type"]')) { collect(); render(); }
    });
  }, panelPresetLibrary);

  render();
}

/** What a new story starts as, set once. */
async function panelStoryDefaults() {
  const d = (await get('/api/defaults')).defaults;
  subSheet('What a new story starts as', `
    ${backRow()}
    <div class="why" style="margin-bottom:14px">
      These are the starting point for every story you begin from now on. Changing them never touches a story already running.
    </div>

    <div class="field">
      <label for="def-model">Who writes</label>
      <div class="why">The model, by its full name on OpenRouter.</div>
      <input type="text" id="def-model" value="${esc(d.model)}">
    </div>

    ${dial({ key: 'temperature', label: 'How loose it writes', min: 0.1, max: 2, step: 0.05, value: d.temperature,
    why: 'Low is careful and repetitive. High is surprising and less coherent.', ends: ['careful', 'wild'], format: FORMATS.temperature })}
    ${dial({ key: 'maxTokens', label: 'How long a reply runs', min: 200, max: 4000, step: 100, value: d.maxTokens,
    why: 'A ceiling, not a target.', ends: ['short', 'long'], format: FORMATS.maxTokens })}
    ${dial({ key: 'historyLimit', label: 'How many messages stay word for word', min: 10, max: 200, step: 5, value: d.historyLimit,
    why: 'Older ones survive as folded scenes instead.', ends: ['few', 'many'], format: FORMATS.historyLimit })}
    ${dial({ key: 'loreBudget', label: 'Room for lore each message', min: 500, max: 20000, step: 250, value: d.loreBudget,
    why: 'Always-on entries do not come out of this.', ends: ['tight', 'generous'], format: FORMATS.loreBudget })}

    <div class="switch-row">
      <div class="switch-main">
        <div class="switch-title">Start new stories with stages</div>
        <div class="switch-why">Relationships climb a ladder that cannot be skipped.</div>
      </div>
      <button class="switch" id="def-arc" aria-pressed="${(d.arc?.on ?? true) !== false}"></button>
    </div>
    <div class="switch-row">
      <div class="switch-main">
        <div class="switch-title">Hold secrets back</div>
        <div class="switch-why">Hidden things stay out of the prompt until the scene reaches them.</div>
      </div>
      <button class="switch" id="def-secrets" aria-pressed="${(d.secrets?.on ?? true) !== false}"></button>
    </div>

    <div class="sheet-actions">
      <button class="btn quiet" data-back>Back</button>
      <button class="btn primary" id="def-save">Save</button>
    </div>`, (root) => {
    wireDials(root);
    $$('.switch', root).forEach((sw) => sw.addEventListener('click', () => {
      sw.setAttribute('aria-pressed', String(sw.getAttribute('aria-pressed') !== 'true'));
    }));
    $('#def-save', root).addEventListener('click', async () => {
      await post('/api/defaults', {
        ...readDials(root),
        model: $('#def-model', root).value.trim() || d.model,
        arc: { ...(d.arc || {}), on: $('#def-arc', root).getAttribute('aria-pressed') === 'true' },
        secrets: { ...(d.secrets || {}), on: $('#def-secrets', root).getAttribute('aria-pressed') === 'true' },
      });
      toast('Saved. New stories start here.', { kind: 'good' });
      goBack();
    });
  }, openAppSettings);
}

// ----------------------------------------------------------- detail views

// ------------------------------------------------- scenarios and worlds
//
// A scenario is a situation you could start right now. A world is somewhere
// you could play. Neither is a database record, so neither opens as a list of
// fields: the art, what it is, what is in it, and one obvious thing to do.

const hero = (o, line) => `
  <div class="hero-card${o.avatar ? '' : ' blank'}">
    ${o.avatar ? `<img src="${esc(o.avatar)}" alt="">` : ''}
    <div class="hero-text">
      <h3>${esc(o.name)}</h3>
      ${line ? `<p>${esc(line)}</p>` : ''}
    </div>
  </div>`;

const contents = (rows) => `
  <ul class="contents">
    ${rows.filter(Boolean).map((r) => `<li><b>${esc(r[0])}</b><span>${esc(r[1])}</span></li>`).join('')}
  </ul>`;

/** Where a thing came from. Kept out of the way, available when wanted. */
function provenance(importId) {
  if (!importId) return '';
  return `
    <div class="edit-card">
      <div class="edit-head">
        <button class="fold" data-fold aria-expanded="false">›</button>
        <span class="edit-name">Where this came from</span>
      </div>
      <div class="edit-body" hidden><div class="why" id="prov-${esc(importId)}">Reading…</div></div>
    </div>`;
}

async function fillProvenance(root, importId) {
  if (!importId) return;
  const el = $(`#prov-${importId}`, root);
  if (!el) return;
  try {
    const rec = await get(`/api/imports/${importId}`);
    const kinds = { character: 'Character', lorebook: 'Lorebook', framework: 'World', scenario: 'Scenario' };
    const others = rec.resources.filter((r) => r.part !== 'primary');
    el.innerHTML = `
      Imported from a ${esc(String(rec.format || 'file').replace(/_/g, ' '))} file<br>
      <span style="opacity:.7">${esc(rec.filename)}</span>
      ${rec.detectedRole && rec.chosenRole !== rec.detectedRole
    ? `<br><br>Tipsy read this as a ${esc(kinds[rec.detectedRole] || rec.detectedRole)}; you brought it in as a ${esc(kinds[rec.chosenRole] || rec.chosenRole)}.`
    : ''}
      ${others.length ? `<br><br>The same file also brought in: ${esc(others.map((o) => kinds[o.kind] || o.kind).join(', '))}.` : ''}`;
  } catch {
    el.textContent = 'That record could not be read.';
  }
}

async function showScenario(id) {
  const s = await get(`/api/scenarios/${id}`);
  const starts = s.startingPoints || [];
  sheet('Scenario', `
    ${hero(s, String(s.premise || '').slice(0, 160))}
    ${contents([
    s.premise && ['The situation', `${num(s.premise.length / 4)} tokens`],
    starts.length && ['Ways to begin', starts.length === 1 ? 'one opening' : `${starts.length} to choose from`],
    s.lorebooks?.length && ['Lore', `${s.lorebooks[0].entries} entries`],
    s.cast?.length && ['People in it', s.cast.map((c) => c.name).join(', ')],
    s.framework && ['World', s.framework.name],
    s.ensemble && ['How the scene is written', 'an example of the whole room'],
  ])}
    <div class="sheet-actions">
      <button class="btn primary" data-start-scenario="${esc(s.id)}">Start a story</button>
      <button class="btn quiet" data-close>Close</button>
    </div>
    ${provenance(s.import_id)}
  `, (root) => {
    wireFolds(root);
    fillProvenance(root, s.import_id);
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-start-scenario]')) beginFrom('scenario', s, starts);
    });
  });
}

async function showFramework(id) {
  const f = await get(`/api/frameworks/${id}`);
  const starts = f.startingPoints || [];
  sheet('World', `
    ${hero(f, f.summary)}
    ${contents([
    f.world && ['The world', `${num(f.world.length / 4)} tokens of it`],
    f.narrator && ['How it is run', 'instructions for the narrator'],
    f.lorebooks?.length && ['Lore', `${f.lorebooks.reduce((n, b) => n + b.entries, 0)} entries`],
    starts.length && ['Ways in', starts.length === 1 ? 'one opening' : `${starts.length} to choose from`],
    f.ensemble && ['Ensemble guidance', 'how the cast behaves together'],
    f.stories?.length && ['In use by', `${f.stories.length} ${f.stories.length === 1 ? 'story' : 'stories'}`],
  ])}
    ${f.stories?.length ? `<div class="why">Stories in this world keep their own memory and their own continuity. They share the world, not each other.</div>` : ''}
    <div class="sheet-actions">
      <button class="btn primary" data-start-framework="${esc(f.id)}">Start a story here</button>
      <button class="btn quiet" data-close>Close</button>
    </div>
    ${provenance(f.import_id)}
  `, (root) => {
    wireFolds(root);
    fillProvenance(root, f.import_id);
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-start-framework]')) beginFrom('framework', f, starts);
    });
  });
}

/**
 * Begin, choosing where to begin if there is a choice.
 *
 * One opening is not a decision, so it is not offered as one. Several are,
 * and then the difference between them has to be readable — which means
 * showing the words, not the label.
 */
/**
 * Ask which opening, and wait for the answer.
 *
 * Resolves to an id, to null for "whichever", or to false if the sheet is
 * closed without choosing — which must not quietly start the story anyway.
 */
function chooseOpening(ownerKind, ownerId) {
  return new Promise(async (resolve) => {
    let starts = [];
    try { starts = (await get(`/api/starts/${ownerKind}/${ownerId}`)).starts; } catch { /* fall through */ }
    if (starts.length <= 1) { resolve(starts[0]?.id || null); return; }

    let answered = false;
    sheet('How do you want to begin?', `
      <div class="picks">
        ${starts.map((s) => `
          <button class="pick" data-start="${esc(s.id)}">
            <b>${esc(s.label)}</b>
            <span>${esc(String(s.content).replace(/\s+/g, ' ').slice(0, 220))}…</span>
          </button>`).join('')}
      </div>
      <div class="sheet-actions"><button class="btn quiet" id="cancel-open">Cancel</button></div>
    `, (root) => {
      root.addEventListener('click', (e) => {
        const p = e.target.closest('[data-start]');
        if (p) { answered = true; resolve(p.dataset.start); return; }
        if (e.target.closest('#cancel-open')) { answered = true; closeSheet(); resolve(false); }
      });
      // Closing it by any other route is also an answer, and the answer is no.
      const host = $('#sheet-host');
      const watch = new MutationObserver(() => {
        if (host.hidden && !answered) { answered = true; watch.disconnect(); resolve(false); }
      });
      watch.observe(host, { attributes: true, attributeFilter: ['hidden'] });
    });
  });
}

function beginFrom(kind, thing, starts) {
  const go = async (startingPointId) => {
    const r = await post(`/api/${kind === 'scenario' ? 'scenarios' : 'frameworks'}/${thing.id}/start`, { startingPointId });
    closeSheet();
    await loadLibrary();
    openStory(r.storyId);
  };
  if (starts.length <= 1) { go(starts[0]?.id || null); return; }

  sheet('How do you want to begin?', `
    <div class="picks">
      ${starts.map((s) => `
        <button class="pick" data-start="${esc(s.id)}">
          <b>${esc(s.label)}</b>
          <span>${esc(String(s.content).replace(/\s+/g, ' ').slice(0, 220))}…</span>
        </button>`).join('')}
    </div>
    <div class="sheet-actions"><button class="btn quiet" data-close>Not now</button></div>
  `, (root) => {
    root.addEventListener('click', (e) => {
      const p = e.target.closest('[data-start]');
      if (p) go(p.dataset.start);
    });
  });
}

async function showCharacter(id) {
  const c = await get(`/api/characters/${id}`);
  const est = (t) => num(String(t || '').length / 4);
  // Who they are first, what they cost last. The old version opened on five
  // rows of token counts, which is the app talking about itself.
  const fold = (title, body, sub = '') => (body ? `
    <div class="edit-card">
      <div class="edit-head">
        <button class="fold" data-fold aria-expanded="false">›</button>
        <span class="edit-name">${esc(title)}</span>
        <span class="edit-tail">${esc(sub)}</span>
      </div>
      <div class="edit-body" hidden>
        <p class="prose-plain">${esc(body)}</p>
      </div>
    </div>` : '');

  sheet(c.name, `
    <div class="hero">
      <span class="hero-art" id="char-face" title="Change picture">
        ${c.avatar ? `<img src="${esc(c.avatar)}" alt="">`
    : `<span class="letter">${esc(c.name[0].toUpperCase())}</span>`}
        <span class="hero-edit">Change picture</span>
      </span>
      <div class="hero-text">
        ${c.nickname ? `<div class="hero-alias">“${esc(c.nickname)}”</div>` : ''}
        ${(c.tags || []).length ? `<div class="chips">
          ${(c.tags || []).slice(0, 6).map((t) => `<span class="chip-tag">${esc(t)}</span>`).join('')}
        </div>` : ''}
        ${c.creator ? `<div class="hero-by">by ${esc(c.creator)}</div>` : ''}
      </div>
    </div>

    ${c.description ? `<p class="prose-plain lede">${esc(c.description)}</p>` : ''}

    <button class="btn primary big" id="start-here">Start a story with them</button>

    <div class="band"><h2>What the model is told</h2><span class="count">${est(c.prompt_chars || (c.description + c.personality + c.scenario).length * 1)} tokens a message</span></div>
    ${fold('Who they are', c.description, `${est(c.description)} tokens`)}
    ${fold('How they behave', c.personality, `${est(c.personality)} tokens`)}
    ${fold('Where you meet them', c.scenario, `${est(c.scenario)} tokens`)}
    ${fold('How they open', c.first_message, `${est(c.first_message)} tokens`)}
    ${fold('How they talk', c.example_dialogue, `${est(c.example_dialogue)} tokens`)}
    ${c.system_prompt ? fold('Their own instructions', c.system_prompt, 'replaces yours') : ''}
    ${c.linked_world ? `<div class="notice" style="margin-top:12px">Expects a lorebook called “${esc(c.linked_world)}”. Import that too, or its lore will be missing.</div>` : ''}

    ${/* A card is what the model is told. The profile is everything known about
         them, which is a larger thing and lives on its own page. */''}
    ${c.entity_id ? `
      <div class="row-actions" style="margin-top:var(--s5)">
        <button class="btn" id="deep-profile">Everything known about ${esc(c.name.split(' ')[0])}</button>
        <button class="btn quiet" id="id-review">Connected person</button>
      </div>`
    : `<div class="notice" style="margin-top:var(--s5)">Nexus has not been told which person this card is, so it can only show what the card says. Connect it and everything organised about them — including the knowledge about them that can travel between stories — shows up here.</div>
      <div class="row-actions" style="margin-top:8px">
        <button class="btn" id="id-connect">Connect knowledge</button>
      </div>`}

    <div class="row-actions" style="margin-top:var(--s5)">
      <button class="btn" id="edit-char">Edit</button>
      <button class="btn" id="copy-char">Make a copy</button>
      <button class="btn quiet" id="del-char">Delete</button>
    </div>
    <div class="sheet-actions">
      <button class="btn primary" data-close>Close</button>
    </div>`, (root) => {
    wireFolds(root);
    const deep = $('#deep-profile', root);
    if (deep) {
      deep.addEventListener('click', () => {
        // Inside a story they are part of, read them as that story sees them:
        // what it carries, and what belongs to it alone. Everywhere else, the
        // person as they travel.
        const here = state.story && (state.story.characters || []).some((x) => x.id === id) ? state.story.id : null;
        openEntityProfile(c.entity_id, { storyId: here, back: () => showCharacter(id), title: c.name });
      });
    }
    // Saying who they are, or reading back what was said. Both from the card
    // itself: there is nowhere else a person would look for it.
    $('#id-connect', root)?.addEventListener('click', () => connectKnowledge('character', id, { back: () => showCharacter(id) }));
    $('#id-review', root)?.addEventListener('click', () => reviewConnection('character', id, { back: () => showCharacter(id) }));
    $('#start-here', root).addEventListener('click', () => {
      closeSheet();
      draft.title = '';
      draft.premise = '';
      draft.characterIds = [id];
      draft.lorebookIds = [];
      newStoryStep(1);
    });
    $('#char-face', root).addEventListener('click', () => pickAvatar('character', id, async () => {
      await loadLibrary();
      closeSheet();
      showCharacter(id);
    }));
    $('#edit-char', root).addEventListener('click', () => characterBuilder(id, () => showCharacter(id)));
    // A copy you can take apart without losing the original. This is how you
    // get a version of a downloaded card that is yours.
    $('#copy-char', root).addEventListener('click', async () => {
      const r = await post('/api/characters', {
        name: `${c.name} (my version)`,
        description: c.description, personality: c.personality, scenario: c.scenario,
        firstMessage: c.first_message, exampleDialogue: c.example_dialogue,
        systemPrompt: c.system_prompt, postHistoryInstructions: c.post_history_instructions,
        creatorNotes: c.creator_notes,
      });
      await loadLibrary();
      toast('Copied. The original is untouched.', { kind: 'good' });
      characterBuilder(r.id, () => showCharacter(r.id));
    });
    $('#del-char', root).addEventListener('click', async () => {
      if (!confirm(`Delete ${c.name}? Stories using them stay, but lose the character.`)) return;
      await del(`/api/characters/${id}`);
      closeSheet(); await loadLibrary();
    });
  });
}

$('#btn-new-lorebook').addEventListener('click', () => {
  sheet('New lorebook', `
    <div class="field">
      <label for="lb-name">Name</label>
      <input type="text" id="lb-name" placeholder="My Hero Academia — my version">
    </div>
    <div class="field">
      <label for="lb-desc">What is it for?</label>
      <div class="why">Just for you. Never sent to the AI.</div>
      <input type="text" id="lb-desc" placeholder="Characters and places I actually use">
    </div>
    <div class="sheet-actions">
      <button class="btn quiet" data-close>Cancel</button>
      <button class="btn primary" id="make-book">Create</button>
    </div>`, (root) => {
    $('#make-book', root).addEventListener('click', async () => {
      const name = $('#lb-name', root).value.trim();
      if (!name) { toast('Give it a name.'); return; }
      await post('/api/lorebooks', { name, description: $('#lb-desc', root).value.trim() });
      closeSheet(); await loadLibrary();
      toast('Created. Open it to add entries.', { kind: 'good' });
    });
  });
});

// ------------------------------------------------- keyboard on the phone

const vv = window.visualViewport;
if (vv) {
  const sync = () => {
    const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb', `${overlap}px`);
    $('#composer').style.transform = overlap ? `translateY(-${overlap}px)` : '';
    $('#story-scroll').style.paddingBottom = overlap ? `${overlap}px` : '';
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
}

// iOS suspends the page when you switch away. Come back to a fresh view.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  if (state.story && !state.streaming) {
    try {
      state.story = await get(`/api/stories/${state.story.id}`);
      renderMessages();
    } catch { /* offline; keep what is on screen */ }
  }
});

// ------------------------------------------------------------------ start

// ------------------------------------------------------------------- the door
//
// One password, and everything is behind it: a month of writing, the ability
// to spend your balance, and a key that is yours. Drawn as a screen of its own
// rather than a dialog, because it is the whole app until you are through it.

async function showGate(force = false) {
  const g = await fetch('/api/gate').then((r) => r.json()).catch(() => null);
  if (!g) return;
  if (g.inside && !force) return;

  const first = g.canSetFirst;
  const waiting = g.waitSeconds > 0;

  $('#gate').hidden = false;
  $('#gate-body').innerHTML = first ? `
    <h2>Set a password</h2>
    <p class="why">
      Right now this app only answers to this computer. The moment it has an address you can reach from
      outside, anybody who finds that address is you: your stories, your balance, your key.
      One password, set once, and this device stays signed in for three months.
    </p>
    <div class="field">
      <label for="gate-new">A password</label>
      <input type="password" id="gate-new" autocomplete="new-password" placeholder="at least 8 characters">
    </div>
    <div class="field">
      <label for="gate-new2">And again</label>
      <input type="password" id="gate-new2" autocomplete="new-password" enterkeyhint="go">
    </div>
    <button class="btn primary" id="gate-go" style="width:100%">Set it</button>
    <p class="hint" style="margin-top:12px">
      There is no way to reset this from outside. If you forget it, you clear it on this computer.
    </p>`
    : !g.needsPassword ? `
    <h2>Locked</h2>
    <p class="why">
      No password has been set yet, so this app only answers to its own network.
      Open it at home, on the computer it runs on or on a phone using the same wifi, and set one there.
    </p>`
    : `
    <h2>Tipsy</h2>
    <p class="why">Your password.</p>
    <div class="field">
      <input type="password" id="gate-pw" autocomplete="current-password" enterkeyhint="go"
        placeholder="password" ${waiting ? 'disabled' : ''}>
    </div>
    ${waiting ? `<p class="notice">Too many wrong tries from here. Wait about ${Math.ceil(g.waitSeconds / 60)} minutes.</p>` : ''}
    <button class="btn primary" id="gate-go" style="width:100%" ${waiting ? 'disabled' : ''}>Come in</button>`;

  const say = (msg) => {
    let el = $('#gate-msg');
    if (!el) {
      el = document.createElement('p');
      el.id = 'gate-msg';
      el.className = 'notice';
      el.style.marginTop = '12px';
      $('#gate-body').append(el);
    }
    el.textContent = msg;
  };

  const go = async () => {
    const btn = $('#gate-go');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    try {
      if (first) {
        const a = $('#gate-new').value;
        const b = $('#gate-new2').value;
        if (a !== b) throw new Error('Those two do not match.');
        await post('/api/gate/set', { password: a });
      } else {
        await post('/api/gate/open', { password: $('#gate-pw').value });
      }
      $('#gate').hidden = true;
      await loadLibrary();
      toast(first ? 'Set. This device stays signed in.' : 'Welcome back.', { kind: 'good' });
    } catch (err) {
      say(err.message);
      btn.disabled = false;
      const pw = $('#gate-pw');
      if (pw) { pw.value = ''; pw.focus(); }
    }
  };

  const goBtn = $('#gate-go');
  if (goBtn) goBtn.addEventListener('click', go);
  for (const el of $$('#gate-body input')) {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }
  $('#gate-body input')?.focus();
}

(async () => {
  const g = await fetch('/api/gate').then((r) => r.json()).catch(() => null);
  if (g && !g.inside) { showGate(); return; }
  loadLibrary().catch((e) => toast(e.message, { kind: 'bad' }));
})();

// ========================================================================
// Settings, reachable from inside the story.
// Every dial says what it does, because a number with no explanation is
// exactly the thing that makes an app feel like software.
// ========================================================================

/** A labelled slider that shows its value in words, not just digits. */
function dial({ key, label, why, min, max, step = 1, value, ends = [], format }) {
  const shown = format ? format(value) : value;
  return `
    <div class="dial" data-dial="${key}">
      <div class="dial-top">
        <label for="d-${key}">${esc(label)}</label>
        <span class="dial-val" id="v-${key}">${esc(shown)}</span>
      </div>
      <div class="why">${why}</div>
      <input type="range" id="d-${key}" min="${min}" max="${max}" step="${step}" value="${value}">
      ${ends.length ? `<div class="dial-ends"><span>${esc(ends[0])}</span><span>${esc(ends[1])}</span></div>` : ''}
    </div>`;
}

const FORMATS = {
  temperature: (v) => {
    const n = Number(v);
    if (n <= 0.5) return `${n} — very steady`;
    if (n <= 0.8) return `${n} — steady`;
    if (n <= 1.05) return `${n} — balanced`;
    if (n <= 1.3) return `${n} — loose`;
    return `${n} — wild`;
  },
  maxTokens: (v) => `about ${num(Number(v) * 0.75)} words`,
  historyLimit: (v) => `last ${v} messages`,
  loreBudget: (v) => `${num(v)} tokens`,
  scanDepth: (v) => `${v} message${Number(v) === 1 ? '' : 's'}`,
  frequencyPenalty: (v) => (Number(v) === 0 ? 'off' : Number(v).toFixed(2)),
};

$('#btn-story-settings').addEventListener('click', openStorySettings);

// ------------------------------------------------------------- your person

function renderPersonaArea(root, data, currentId) {
  const area = $('#persona-area', root);
  if (!area) return;
  const personas = data.personas || [];
  const offered = data.offered || [];
  const current = personas.find((p) => p.id === currentId) || null;
  area.dataset.personaId = current ? current.id : '';
  const initial = esc((current && current.name ? current.name : '?')[0].toUpperCase());

  area.innerHTML = `
    <div class="why" style="margin-bottom:10px">The character you play. The AI is told never to write their words or actions.</div>
    <div class="portrait-row">
      <span class="portrait" id="persona-face" title="${current ? 'Change picture' : ''}">
        ${current && current.avatar ? `<img src="${esc(current.avatar)}" alt="">` : initial}
      </span>
      <div style="flex:1 1 auto;min-width:0">
        <div style="font-weight:500">${esc(current ? current.name : 'Nobody yet')}</div>
        <div style="font-size:13px;color:var(--ink-soft)">${current
          ? esc((current.description || 'No description').replace(/\s+/g, ' ').slice(0, 80)) + '…'
          : 'The AI will just call you "You".'}</div>
        ${current && current.fromEntry ? '<div class="why" style="margin-top:3px">Follows a lore entry. Edit the entry to change it.</div>' : ''}
      </div>
      <button class="btn" id="edit-persona">${current && !current.fromEntry ? 'Edit' : current ? 'Open' : 'Create'}</button>
    </div>
    ${/* Someone you play has as much to them as anyone the AI plays. */''}
    ${current && current.entityId ? `
      <div class="row-actions" style="margin-top:8px">
        <button class="btn quiet" data-persona-profile="${esc(current.entityId)}">Everything known about ${esc(current.name.split(' ')[0])}</button>
        <button class="btn quiet" data-persona-identity="${esc(current.id)}">Connected person</button>
      </div>`
    : current ? `
      <div class="why" style="margin-top:8px">Nexus has not been told which person this is, so what you know about them cannot travel here yet.</div>
      <div class="row-actions" style="margin-top:6px">
        <button class="btn quiet" data-persona-connect="${esc(current.id)}">Connect knowledge</button>
      </div>` : ''}

    ${personas.length ? `
      <div class="sec-head">Your characters</div>
      <div class="preset-row">${personas.map((p) => `
        <button class="preset-chip${p.id === currentId ? ' is-on' : ''}" data-use-persona="${esc(p.id)}">${esc(p.name)}${p.fromEntry ? ' ·' : ''}</button>`).join('')}
        <button class="preset-chip" id="new-persona">+ New</button>
      </div>` : ''}

    ${offered.length ? `
      <div class="sec-head">Marked as you in your lore</div>
      <div class="why" style="margin:-4px 0 8px">Entries you ticked "This is me". Pick one and it becomes the character you play, and stops being sent twice.</div>
      ${offered.map((o) => `
        <div class="mem-item">
          <div class="mem-body">
            <div class="mem-text">${esc(o.name)}</div>
            <div class="mem-meta"><span>${esc(o.description.replace(/\s+/g, ' ').slice(0, 90))}…</span><span>${num(o.tokens)} tokens</span></div>
          </div>
          <div class="mem-act"><button data-use-entry="${esc(o.entryId)}">Use this</button></div>
        </div>`).join('')}` : ''}

    ${!personas.length && !offered.length ? `
      <div class="empty" style="margin-top:12px">
        Nobody yet. Create a character above, or tick "This is me" on a lore entry.
      </div>` : ''}`;

  $('#edit-persona', area).addEventListener('click', () => {
    if (current && current.fromEntry) {
      toast('This character comes from a lore entry.', { sub: 'Open that lorebook and edit the entry.', ms: 6000 });
      return;
    }
    editPersona(current);
  });
  const newBtn = $('#new-persona', area);
  if (newBtn) newBtn.addEventListener('click', () => editPersona(null));
  if (current && !current.fromEntry) {
    $('#persona-face', area).addEventListener('click', () => pickAvatar('persona', current.id, async () => {
      renderPersonaArea(root, await get(`/api/stories/${state.story.id}/playable`), current.id);
    }));
  }

  // Once. This function re-renders itself on every choice, and attaching the
  // handler each time made each tap fire once more than the last.
  if (!area.dataset.wired) {
    area.dataset.wired = '1';
    area.addEventListener('click', async (e) => {
      const deep = e.target.closest('[data-persona-profile]');
      if (deep) {
        // In this story: their reusable knowledge that it carries, and its own.
        openEntityProfile(deep.dataset.personaProfile, { storyId: state.story?.id || null, back: panelPersona });
        return;
      }
      // The same question as on a card, asked the same way: someone you play is
      // a person, and the knowledge about them travels with them too.
      const connect = e.target.closest('[data-persona-connect]');
      if (connect) { connectKnowledge('persona', connect.dataset.personaConnect, { back: panelPersona }); return; }
      const ident = e.target.closest('[data-persona-identity]');
      if (ident) { reviewConnection('persona', ident.dataset.personaIdentity, { back: panelPersona }); return; }
      const pick = e.target.closest('[data-use-persona]');
      if (pick) {
        const fresh = await get(`/api/stories/${state.story.id}/playable`);
        renderPersonaArea(root, fresh, pick.dataset.usePersona);
        return;
      }
      const use = e.target.closest('[data-use-entry]');
      if (use) {
        const r = await post(`/api/stories/${state.story.id}/playable/${use.dataset.useEntry}`);
        state.story = await get(`/api/stories/${state.story.id}`);
        renderMessages();
        toast(`You are playing ${r.persona.name}.`, { kind: 'good' });
        renderPersonaArea(root, await get(`/api/stories/${state.story.id}/playable`), r.id);
      }
    });
  }
}

function editPersona(current) {
  const title = current ? 'Edit your character' : 'Who do you play?';
  sheet(title, `
    <div class="field">
      <label for="p-name">Name</label>
      <input type="text" id="p-name" value="${esc(current ? current.name : '')}" placeholder="Reiko Amano">
    </div>
    <div class="field">
      <label for="p-desc">About them</label>
      <div class="why">What the AI needs in order to write the world around you. Looks, manner, what they can do, how others treat them. Short factual lines work better than paragraphs.</div>
      <textarea id="p-desc" style="min-height:26dvh" placeholder="17, Class 1-A. Quirk: Echo, replays any sound heard in the last hour.&#10;Black hair cut blunt at the jaw. Blazer a size too big.&#10;Answers late, as if she considered not answering.">${esc(current ? current.description : '')}</textarea>
    </div>
    <div class="sheet-actions">
      ${current ? '<button class="btn quiet" id="p-del">Delete</button>' : ''}
      <button class="btn quiet" id="p-back">Back</button>
      <button class="btn primary" id="p-save">Save</button>
    </div>`, (root) => {
    $('#p-back', root).addEventListener('click', () => { closeSheet(); openStorySettings(); });
    $('#p-save', root).addEventListener('click', async () => {
      const name = $('#p-name', root).value.trim();
      if (!name) { toast('Give them a name.'); return; }
      const { id } = await post('/api/personas', {
        id: current ? current.id : undefined,
        name,
        description: $('#p-desc', root).value,
      });
      state.library = await get('/api/library');
      await patch(`/api/stories/${state.story.id}`, { personaId: id });
      state.story = await get(`/api/stories/${state.story.id}`);
      renderMessages();
      closeSheet();
      panelPersona();
      toast('Saved.', { kind: 'good' });
    });
    const delBtn = $('#p-del', root);
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!confirm(`Delete ${current.name}?`)) return;
        await del(`/api/personas/${current.id}`);
        state.library = await get('/api/library');
        state.story = await get(`/api/stories/${state.story.id}`);
        closeSheet();
        openStorySettings();
      });
    }
  });
}

// --------------------------------------------------------------- portraits

let avatarTarget = null;

/**
 * Shrink a card's art without squaring it off.
 *
 * The square version below is right for a face in a circle. Card art is a
 * composition, usually taller than it is wide, and cropping it to a square
 * throws away the half somebody drew on purpose. This keeps the shape and
 * only caps the size.
 */
function shrinkFit(file, max = 512) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      let out = c.toDataURL('image/webp', 0.85);
      if (!out.startsWith('data:image/webp')) out = c.toDataURL('image/jpeg', 0.85);
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image we can read.')); };
    img.src = url;
  });
}

/** Shrink before storing. A phone photo is several megabytes; this is about 40kb. */
function shrink(file, size = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(img.width, img.height);
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      let out = c.toDataURL('image/webp', 0.85);
      if (!out.startsWith('data:image/webp')) out = c.toDataURL('image/jpeg', 0.85);
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image we can read.')); };
    img.src = url;
  });
}

function pickAvatar(kind, id, after) {
  avatarTarget = { kind, id, after };
  $('#avatar-input').click();
}

$('#avatar-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file || !avatarTarget) return;
  const target = avatarTarget;
  avatarTarget = null;
  try {
    const dataUri = await shrink(file);
    await post(`/api/avatar/${target.kind}/${target.id}`, { dataUri });
    toast('Picture set.', { kind: 'good' });
    if (target.after) await target.after();
  } catch (err) {
    toast(err.message, { kind: 'bad' });
  }
});

// ========================================================================
// Settings, as a short menu rather than one long wall.
// Each row opens one focused thing, with a way back.
// ========================================================================

const sheetStack = [];

// Where Back should land, set by whoever opened the panel. Without this every
// panel had to remember to pass its own way home, most of them did not, and
// Back quietly threw you out of settings altogether instead of up one level.
let pendingBack = null;
function subSheet(title, html, onMount, back) {
  sheetStack.push(back || pendingBack);
  pendingBack = null;
  sheet(title, html, onMount);
}
function goBack() {
  const back = sheetStack.pop();
  if (back) back(); else closeSheet();
}
function backRow() {
  return `<button class="btn quiet" data-back style="margin-bottom:10px">&larr; Back</button>`;
}
const KIND_ICON = {
  character: '◗', place: '⌂', faction: '⌸', premise: '❧',
  item: '◆', event: '✦', rule: '§', direction: '➤', note: '·',
};

/** The top level. Short, so nothing is buried and nothing overwhelms. */
async function openStorySettings() {
  const st = state.story;
  const s = { ...st.settings };
  if (!state.library) state.library = await get('/api/library');

  let directions = null;
  try { directions = await get(`/api/stories/${st.id}/directions`); } catch { /* fine */ }

  const bookNames = (state.library.lorebooks || [])
    .filter((b) => (st.lorebookIds || []).includes(b.id)).map((b) => b.name);

  const row = (id, title, value) => `
    <button class="menu-row" data-go="${id}">
      <span class="menu-main">
        <span class="menu-title">${esc(title)}</span>
        <span class="menu-val">${esc(value)}</span>
      </span>
      <span class="menu-arrow"><svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg></span>
    </button>`;

  // Two groups, and the split is the answer to a real question: a preset sets
  // everything in the second group and nothing in the first. Seeing the
  // stages sit in "This story" and the preset sit at the head of "How it
  // writes" says that without a paragraph explaining it.
  sheet('Settings', `
    <div class="band"><h2>The story</h2></div>
    <div class="menu">
      ${row('sheet', 'Premise', s.premise ? `${num(estTokens(s.premise))} tokens` : 'Not written yet')}
      ${row('persona', 'Your character', st.persona ? st.persona.name : 'Not set')}
      ${row('lore', 'World and lore', bookNames.length ? bookNames.join(', ') : 'None')}
    </div>

    <div class="band"><h2>How it is told</h2></div>
    <div class="menu">
      ${row('dials', 'The telling', dialsSummary(s))}
      ${row('arc', 'How closeness moves', arcSummary(s))}
      ${row('secrets', 'What stays hidden', (s.secrets?.on ?? true) ? 'Held until the scene reaches it' : 'Always in the prompt')}
      ${row('directions', 'Standing instructions', s.directions ? `${num(estTokens(s.directions))} tokens` : 'None yet')}
    </div>

    <div class="band"><h2>Look</h2></div>
    <div class="menu">
      ${row('look', 'How it looks', lookSummary())}
    </div>

    <div class="band"><h2>The model</h2></div>
    <div class="menu">
      ${row('model', 'Who writes', shortModel(s.model))}
      ${row('writing', 'How it writes', `${FORMATS.temperature(s.temperature)}, ${FORMATS.maxTokens(s.maxTokens)}`)}
      ${row('preset', 'Writing preset', 'Save or load this group')}
    </div>

    <div class="band"><h2>Memory</h2></div>
    <div class="menu">
      ${row('memory', 'What it keeps', `${FORMATS.historyLimit(s.historyLimit)}, ${FORMATS.loreBudget(s.loreBudget)} of lore`)}
    </div>

    <div class="band"><h2>Advanced</h2></div>
    <div class="menu">
      ${row('state', 'What went into the last message', 'Every word sent, and what it cost')}
    </div>

    ${directions && directions.entries.length ? `
      <div class="notice" style="margin-top:16px">
        <b>${num(directions.entries.length)} of your lore entries are really instructions</b>, and ${num(directions.alwaysOnTokens)} tokens of them load with every message.
        Moving them into standing instructions frees that room for your world and makes them cheaper.
        <div style="margin-top:8px"><button class="btn" id="fix-directions">Look at them</button></div>
      </div>` : ''}

    <div class="sheet-actions"><button class="btn quiet" data-close>Close</button></div>`, (root) => {

    root.addEventListener('click', (e) => {
      const go = e.target.closest('[data-go]');
      if (!go) return;
      const panel = {
        preset: panelPreset, look: panelLook, model: panelModel, writing: panelWriting,
        memory: panelMemory, directions: panelDirections,
        persona: panelPersona, lore: panelLore,
        arc: panelSlowBurn, secrets: panelSecrets, state: showState,
        dials: panelDials, sheet: panelStorySheet,
      }[go.dataset.go];
      if (!panel) return;
      pendingBack = openStorySettings;   // Back from any of these returns here
      panel(s);
    });

    const fix = $('#fix-directions', root);
    if (fix) fix.addEventListener('click', () => panelMoveDirections(directions));
  });
}

const estTokens = (t) => Math.ceil(String(t || '').length / 4);

/** The one-line description of the look, for the settings menu. */
function lookSummary() {
  const L = look();
  const shape = { prose: 'Like a novel', portraits: 'Prose with faces', bubbles: 'Messages' }[L.layout] || L.layout;
  const bits = [shape];
  if (L.background) bits.push('a picture behind it');
  if (L.ambient && L.ambient !== 'none') bits.push(L.ambient);
  return bits.join(', ');
}

/** Write the changed dials back to the story and refresh what is on screen. */
async function applySettings(patchObj) {
  const st = state.story;
  const settings = { ...st.settings, ...patchObj };
  await patch(`/api/stories/${st.id}`, { settings });
  state.story = await get(`/api/stories/${st.id}`);
  $('#btn-model').textContent = shortModel(state.story.settings.model);
  refreshQuickbar();
}

// ------------------------------------------------------------------ panels

async function panelPreset(s) {
  let presets = [];
  try { presets = (await get('/api/presets')).presets; } catch { /* offline */ }
  subSheet('Preset', `
    ${backRow()}
    <div class="why" style="margin-bottom:12px">
      A saved set of the writing dials, so you can move a feel you like from one story to the next.
      <br><br>
      <b style="color:var(--ink);font-weight:500">It carries:</b> which model writes, how loose and how long the writing is,
      how much it keeps in view, and its own writing style.
      <br>
      <b style="color:var(--ink);font-weight:500">It does not touch:</b> this story's directions, the stages, who is hard to reach,
      what stays hidden, the picture behind the story, who you play, or the lore. Those belong to this story and stay put.
      <br><br>
      Loading one sets those dials and replaces the previous preset's writing style. Where that style and this story's
      directions disagree, the story's directions win.
    </div>
    <div class="menu">
      ${presets.map((p) => `
        <button class="menu-row" data-load="${esc(p.id)}">
          <span class="menu-main">
            <span class="menu-title">${esc(p.name)}</span>
            <span class="menu-val">${esc(describePreset(p.settings))}</span>
          </span>
          ${p.builtin ? '' : '<span class="menu-arrow" data-del="' + esc(p.id) + '" title="Delete">&times;</span>'}
        </button>`).join('')}
    </div>
    <div class="sheet-actions">
      <button class="btn" id="save-preset">Save current settings as a preset</button>
    </div>`, (root) => {
    root.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation();
        await api(`/api/presets/${del.dataset.del}`, { method: 'DELETE' });
        panelPreset(s);
        return;
      }
      const load = e.target.closest('[data-load]');
      if (!load) return;
      const p = presets.find((x) => x.id === load.dataset.load);
      if (!p) return;
      // Applied by the server, the one place that keeps this story's directions its own.
      await post(`/api/stories/${state.story.id}/use-preset`, { presetId: p.id });
      state.story = await get(`/api/stories/${state.story.id}`);
      $('#btn-model').textContent = shortModel(state.story.settings.model);
      refreshQuickbar();
      toast(`Now using "${p.name}".`, { kind: 'good' });
      closeSheet();
      openStorySettings();
    });
    $('#save-preset', root).addEventListener('click', async () => {
      const name = prompt('Call this preset what?');
      if (!name || !name.trim()) return;
      await post('/api/presets', { name: name.trim(), settings: state.story.settings });
      toast('Saved.', { kind: 'good' });
      panelPreset(s);
    });
  }, openStorySettings);
}

function describePreset(p) {
  const bits = [];
  if (p.model) bits.push(shortModel(p.model));
  if (p.temperature != null) bits.push(FORMATS.temperature(p.temperature));
  if (p.maxTokens != null) bits.push(FORMATS.maxTokens(p.maxTokens));
  return bits.join(' · ') || 'Settings bundle';
}

async function panelModel() {
  subSheet('Who writes', `${backRow()}<div class="empty">Loading…</div>`, null, openStorySettings);
  try {
    if (!state.models) state.models = (await get('/api/models')).models;
    if (!state.settings) state.settings = await get('/api/settings');
    const favs = state.settings.favouriteModels;
    const current = state.story.settings.model;
    const list = [...state.models].sort((a, b) => {
      const fa = favs.indexOf(a.id), fb = favs.indexOf(b.id);
      if (fa !== fb) return (fa < 0 ? 99 : fa) - (fb < 0 ? 99 : fb);
      return a.promptPrice - b.promptPrice;
    }).slice(0, 60);

    sheet('Who writes', `
      ${backRow()}
      <div class="why" style="margin-bottom:10px">Prices per million tokens. You can change this mid-story.</div>
      ${picker(list.map((m) => ({
        id: m.id, title: m.name,
        sub: m.free ? 'Free, but the provider may train on your story'
          : `in $${m.promptPrice.toFixed(2)} · out $${m.completionPrice.toFixed(2)}${m.cachePrice ? ` · cached $${m.cachePrice.toFixed(3)}` : ''} · ${num(m.context / 1000)}k context`,
      })), { multi: false, selected: new Set([current]) })}
      <div class="sheet-actions">
        <button class="btn quiet" data-back>Back</button>
        <button class="btn primary" id="use-model">Use it</button>
      </div>`, (root) => {
      wirePicker(root);
      $('#use-model', root).addEventListener('click', async () => {
        const id = picked(root)[0];
        if (!id) { toast('Pick one.'); return; }
        await applySettings({ model: id });
        toast(`Now writing with ${shortModel(id)}.`, { kind: 'good' });
        closeSheet(); openStorySettings();
      });
    });
  } catch (err) {
    sheet('Who writes', `${backRow()}<div class="notice">${esc(err.message)}</div>`);
  }
}

function panelWriting(s) {
  const cur = state.story.settings;
  subSheet('How it writes', `
    ${backRow()}
    ${dial({ key: 'temperature', label: 'Unpredictability', min: 0.1, max: 1.6, step: 0.05, value: cur.temperature,
      why: 'Low is consistent and a little flat. High is surprising and sometimes incoherent. Around 0.9 to 1.0 suits long prose.',
      ends: ['steady', 'wild'], format: FORMATS.temperature })}
    ${dial({ key: 'maxTokens', label: 'Reply length', min: 200, max: 4000, step: 100, value: cur.maxTokens,
      why: 'The most it may write in one go. It often writes less. Longer costs more.',
      ends: ['a paragraph', 'several pages'], format: FORMATS.maxTokens })}
    ${dial({ key: 'frequencyPenalty', label: 'Stop it repeating itself', min: 0, max: 1, step: 0.05, value: cur.frequencyPenalty ?? 0,
      why: 'Pushes it away from phrases it has already used. Models fall into the same rhythms over a long story. Too high and the writing gets strained.',
      ends: ['off', 'strong'], format: FORMATS.frequencyPenalty })}
    <div class="sheet-actions">
      <button class="btn quiet" data-back>Back</button>
      <button class="btn primary" id="apply">Save</button>
    </div>`, (root) => {
    wireDials(root);
    $('#apply', root).addEventListener('click', async () => {
      await applySettings(readDials(root));
      toast('Saved.', { kind: 'good' });
      closeSheet(); openStorySettings();
    });
  }, openStorySettings);
}

function panelMemory() {
  const cur = state.story.settings;
  subSheet('What it remembers', `
    ${backRow()}
    <div class="notice" style="margin-bottom:16px">
      These are ceilings, not memory. Anything older than the window below is currently forgotten outright. Real memory, where old scenes survive as summaries and facts, is the next thing being built.
    </div>
    ${dial({ key: 'historyLimit', label: 'Conversation it can see', min: 10, max: 300, step: 5, value: cur.historyLimit,
      why: 'How many recent messages go with every request. More means better continuity and a bigger bill.',
      ends: ['10', '300'], format: FORMATS.historyLimit })}
    ${dial({ key: 'loreBudget', label: 'Room for lore', min: 500, max: 30000, step: 500, value: cur.loreBudget,
      why: 'The ceiling for lorebook entries in one message. When it fills, entries that matched get turned away, lowest priority first.',
      ends: ['500', '30,000'], format: FORMATS.loreBudget })}
    ${dial({ key: 'scanDepth', label: 'How far back it looks for trigger words', min: 1, max: 12, step: 1, value: cur.scanDepth,
      why: 'Lore fires when its trigger words appear in this many recent messages.',
      ends: ['1', '12'], format: FORMATS.scanDepth })}
    <div class="sheet-actions">
      <button class="btn quiet" data-back>Back</button>
      <button class="btn primary" id="apply">Save</button>
    </div>`, (root) => {
    wireDials(root);
    $('#apply', root).addEventListener('click', async () => {
      await applySettings(readDials(root));
      toast('Saved.', { kind: 'good' });
      closeSheet(); openStorySettings();
    });
  }, openStorySettings);
}

function panelDirections() {
  const cur = state.story.settings;
  subSheet('Standing instructions', `
    ${backRow()}
    <div class="why" style="margin-bottom:10px">Sent before the story, every message. This is where rules about pacing, tone and formatting belong. Kept here they are cached, so after the first message of a session you stop paying for them.</div>
    <div class="field">
      <textarea id="dir-text" style="min-height:34dvh" placeholder="Write in third person past tense.&#10;Never resolve a scene in the same message it starts.&#10;Render Japanese dialogue in romaji with an italic translation underneath.">${esc(cur.directions || '')}</textarea>
      <div class="why" id="dir-count">${num(estTokens(cur.directions))} tokens</div>
    </div>
    <div class="sheet-actions">
      <button class="btn quiet" data-back>Back</button>
      <button class="btn primary" id="apply">Save</button>
    </div>`, (root) => {
    const ta = $('#dir-text', root);
    ta.addEventListener('input', () => { $('#dir-count', root).textContent = `${num(estTokens(ta.value))} tokens`; });
    $('#apply', root).addEventListener('click', async () => {
      await applySettings({ directions: ta.value });
      toast('Saved.', { kind: 'good' });
      closeSheet(); openStorySettings();
    });
  }, openStorySettings);
}

async function panelPersona() {
  const data = await get(`/api/stories/${state.story.id}/playable`);
  subSheet('Who you are', `
    ${backRow()}
    ${data.current ? '' : `
      <div class="notice" style="margin-bottom:12px">
        <b>Nobody is playing you in this story.</b><br>
        A story that arrived as an imported conversation has no one assigned, so
        everything the app has written down about you since calls you
        <b>user</b>. Pick someone here and it will read as her name instead —
        nothing already written is changed, only how it is read.
      </div>`}
    <div id="persona-area"></div>
    <div class="sheet-actions">
      <button class="btn quiet" data-back>Back</button>
      <button class="btn primary" id="apply">Save</button>
    </div>`, (root) => {
    renderPersonaArea(root, data, data.current);
    $('#apply', root).addEventListener('click', async () => {
      const personaId = $('#persona-area', root).dataset.personaId || null;
      await patch(`/api/stories/${state.story.id}`, { personaId });
      state.story = await get(`/api/stories/${state.story.id}`);
      renderMessages();
      toast('Saved.', { kind: 'good' });
      closeSheet(); openStorySettings();
    });
  }, openStorySettings);
}

async function panelLore() {
  if (!state.library) state.library = await get('/api/library');
  const st = state.story;
  subSheet('Lore in this story', `
    ${backRow()}
    <div class="why" style="margin-bottom:10px">Tick the books this story draws on. Tap a name to open and edit it.</div>
    ${picker((state.library.lorebooks || []).map((b) => ({
      id: b.id, title: b.name,
      sub: `${b.entry_count} entries${b.always_on ? `, ${b.always_on} always on` : ''}`,
    })), { selected: new Set(st.lorebookIds || []) })}
    <div class="sheet-actions">
      <button class="btn quiet" data-back>Back</button>
      <button class="btn primary" id="apply">Save</button>
    </div>`, (root) => {
    wirePicker(root);
    $('#apply', root).addEventListener('click', async () => {
      await patch(`/api/stories/${st.id}`, { lorebookIds: picked($$('.pick', root)[0]) });
      state.story = await get(`/api/stories/${st.id}`);
      toast('Saved.', { kind: 'good' });
      closeSheet(); openStorySettings();
    });
  }, openStorySettings);
}

/** The offer to move instruction-shaped lore into the instructions box. */
function panelMoveDirections(found) {
  subSheet('Instructions hiding in your lore', `
    ${backRow()}
    <div class="why" style="margin-bottom:12px">
      These entries tell the AI how to write rather than describing your world. Left in the lorebook they compete with your characters for room and get paid for in full every message. Moved, they are cached and cost almost nothing after the first message.
      ${found.duplicated ? `<br><br><b>${num(found.duplicated)} of them are duplicates</b> of each other — only one copy of each will be kept.` : ''}
    </div>
    ${picker(found.entries.map((e) => ({
      id: e.id, title: e.title,
      sub: `${num(e.tokens)} tokens${e.constant ? ', always on' : ''} — ${e.summary.slice(0, 80)}…`,
    })), { selected: new Set(found.entries.map((e) => e.id)) })}
    <div class="sheet-actions">
      <button class="btn quiet" data-back>Back</button>
      <button class="btn primary" id="do-move">Move the ticked ones</button>
    </div>`, (root) => {
    wirePicker(root);
    $('#do-move', root).addEventListener('click', async () => {
      const ids = picked($$('.pick', root)[0]);
      if (!ids.length) { toast('Nothing ticked.'); return; }
      const r = await post(`/api/stories/${state.story.id}/absorb-directions`, { entryIds: ids });
      state.story = await get(`/api/stories/${state.story.id}`);
      toast(`Moved ${r.kept}, skipped ${r.duplicatesSkipped} duplicate${r.duplicatesSkipped === 1 ? '' : 's'}.`, {
        sub: 'Those entries are switched off in the lorebook, not deleted.', kind: 'good', ms: 7000,
      });
      closeSheet(); openStorySettings();
    });
  }, openStorySettings);
}

// --------------------------------------------------------------- dial glue

function wireDials(root) {
  $$('.dial input', root).forEach((input) => {
    const key = input.closest('.dial').dataset.dial;
    input.addEventListener('input', () => {
      const f = FORMATS[key];
      $(`#v-${key}`, root).textContent = f ? f(input.value) : input.value;
    });
  });
}
function readDials(root) {
  const out = {};
  $$('.dial input', root).forEach((input) => {
    out[input.closest('.dial').dataset.dial] = Number(input.value);
  });
  return out;
}

// ========================================================================
// The lorebook, as cards rather than a list.
// ========================================================================

const lore = { book: null, filter: 'all', choosing: false, chosen: new Set() };

async function openLorebook(id, { keepPlace = false } = {}) {
  const where = keepPlace ? $('#lore-scroll').scrollTop : 0;
  lore.book = await get(`/api/lorebooks/${id}/cards`);
  // How organised this source is, computed from what is stored every time. It
  // decides what the action at the top of the screen says, so a source that has
  // been organised does not keep inviting you to organise it.
  try { lore.org = await get(`/api/lorebooks/${id}/organization`); } catch { lore.org = null; }
  if (!keepPlace) { lore.filter = 'all'; lore.choosing = false; lore.chosen.clear(); }
  // Anything that has since been deleted should not stay selected.
  const alive = new Set(Object.values(lore.book.groups).flat().map((c) => c.id));
  for (const cid of [...lore.chosen]) if (!alive.has(cid)) lore.chosen.delete(cid);
  $('#lore-name').textContent = lore.book.name;
  $('#lore-sub').textContent = `${num(lore.book.total)} entries`;
  show('lore');
  renderLore();
  // Put you back where you were, rather than at the top of 268 entries.
  requestAnimationFrame(() => { $('#lore-scroll').scrollTop = where; });
}

/**
 * Understanding a source is the main thing you can do with one, so it belongs
 * at the top of the screen rather than under its entries. A source of 158
 * entries used to hide this below all of them.
 *
 * What it says follows the stored state and nothing else: how much is organised
 * is counted from what is saved every time it is asked, so there is no flag
 * here to go stale.
 */
function organiseBanner(b) {
  const o = lore.org;
  if (!o) return '';
  const state = o.display;
  const said = {
    unorganized: {
      line: 'Nexus has not been told what anything in this source means yet.',
      action: 'Understand this source',
    },
    partial: {
      line: `${plural(o.approved, 'entry', 'entries')} of ${num(o.total)} organised. ${plural(o.unresolved, 'entry', 'entries')} still left.`,
      action: 'Carry on organising',
    },
    organized: {
      line: 'All of it is organised. Nexus knows what this source means.',
      action: 'Look at it again',
    },
    needs_recheck: {
      line: `${plural(o.recheck, 'entry', 'entries')} changed after being organised, so what was saved for ${o.recheck === 1 ? 'it' : 'them'} may no longer fit the words. Nothing saved has been altered.`,
      action: 'Read the changed entries again',
    },
  }[state] || null;
  if (!said) return '';
  const bar = state === 'unorganized' ? '' : `<div class="meter-bar"><i style="width:${Math.round((o.approved / Math.max(1, o.total)) * 100)}%"></i></div>`;
  return `
    <div class="organise-strip${state === 'needs_recheck' ? ' warn' : ''}">
      <div class="organise-said">${esc(said.line)}</div>
      ${bar}
      <button class="btn${state === 'unorganized' || state === 'needs_recheck' ? ' primary' : ''}" data-organize="${esc(b.id)}">${esc(said.action)}</button>
    </div>`;
}

function renderLore() {
  const b = lore.book;
  const K = b.kinds;

  // Always-on entries are the expensive ones, so the count is never hidden.
  const over = b.pinned.count > b.pinned.limit;
  const pct = Math.min(100, Math.round(b.pinned.count / b.pinned.limit * 100));
  $('#lore-pinned').innerHTML = organiseBanner(b) + (b.pinned.count ? `
    <div class="pin-meter${over ? ' over' : ''}">
      <div class="pin-meter-top">
        <span><b>${num(b.pinned.count)} always on</b> of ${b.pinned.limit} suggested</span>
        <span>${num(b.pinned.tokens)} tokens every message</span>
      </div>
      <div class="meter-bar${over ? ' full' : ''}"><i style="width:${pct}%"></i></div>
      ${over ? `<div class="why" style="margin-top:8px">Every one of these is sent with every single message, before anything the scene is about. Entries that only matter sometimes should use trigger words instead.</div>` : ''}
    </div>` : '');

  const order = ['character', 'place', 'faction', 'premise', 'item', 'event', 'rule', 'direction', 'note'];
  const kinds = order.filter((k) => b.counts[k]);

  $('#lore-filters').innerHTML = `
    <button class="filter${lore.filter === 'all' ? ' is-on' : ''}" data-filter="all">All<span class="n">${num(b.total)}</span></button>
    ${kinds.map((k) => `
      <button class="filter${lore.filter === k ? ' is-on' : ''}" data-filter="${k}">
        ${esc(K[k].label)}<span class="n">${num(b.counts[k])}</span>
      </button>`).join('')}`;

  const showing = lore.filter === 'all' ? kinds : [lore.filter];
  $('#lore-groups').innerHTML = (showing.map((k) => `
    <div class="group-head">
      <h3>${esc(K[k].label)}</h3>
      <span class="n">${num(b.counts[k])}</span>
      <button class="add" data-add-kind="${k}">+ Add</button>
    </div>
    <div class="cards${lore.choosing ? ' choosing' : ''}">
      ${(b.groups[k] || []).map(cardHtml).join('')}
    </div>`).join('') || `<div class="empty">Nothing here yet.</div>`)
    + `${/* Understanding this source is offered at the top of the screen, not
            here: it is the main thing you can do with a source, and after 158
            entries nobody finds it. */''}`
    + `${/* Sorting by type REWRITES each entry's stored kind. That is not what
            understanding a source does — understanding it leaves every entry
            exactly as it is — so it does not stand next to it looking like the
            same kind of act. */''}
       <details class="src-legacy">
         <summary>Older tools</summary>
         <div class="why">These change the entries themselves, and are nothing to do with understanding what a source means.</div>
         <div class="row-actions" style="margin-top:8px">
           <button class="btn quiet" data-reclassify="${esc(b.id)}">Sort entries by type again</button>
           <button class="btn quiet" data-delete-book="${esc(b.id)}">Delete this lorebook</button>
         </div>
         <div class="why dim" style="margin-top:6px">Sorting by type rewrites the kind stored on every entry in this source. Understanding a source never does.</div>
       </details>`;

  $('#lore-bulk').hidden = !lore.choosing;
  $('#lore-select').classList.toggle('is-on', lore.choosing);
  updateBulkCount();
}

function updateBulkCount() {
  const el = $('#bulk-count');
  if (el) el.textContent = `${num(lore.chosen.size)} chosen`;
}

function cardHtml(c) {
  const w = weightName(c.order);
  const on = lore.chosen.has(c.id);
  return `
    <button class="card${c.enabled ? '' : ' off'}${c.constant ? ' pinned' : ''}${on ? ' chosen' : ''}" data-entry="${esc(c.id)}">
      ${lore.choosing ? `<span class="card-tick">✓</span>` : ''}
      <span class="card-face">${c.image ? `<img src="${esc(c.image)}" alt="">` : esc(String(c.title)[0].toUpperCase())}</span>
      <span class="card-main">
        <span class="card-top">
          <span class="card-title">${esc(c.title)}</span>
          ${c.constant ? '<span class="card-badge pin">always on</span>' : ''}
          ${c.playable ? '<span class="card-badge play">you</span>' : ''}
          ${c.enabled ? '' : '<span class="card-badge">off</span>'}
        </span>
        <span class="card-sum">${esc(c.summary)}</span>
        <span class="card-keys">${w} · ${c.keys.length ? esc(c.keys.slice(0, 4).join(', ')) : 'no trigger words'} · ${num(c.tokens)} tok</span>
      </span>
    </button>`;
}

/** Every entry currently on screen, which is what "all shown" means. */
function shownIds() {
  const b = lore.book;
  const order = ['character', 'place', 'faction', 'premise', 'item', 'event', 'rule', 'direction', 'note'];
  const kinds = lore.filter === 'all' ? order.filter((k) => b.counts[k]) : [lore.filter];
  return kinds.flatMap((k) => (b.groups[k] || []).map((c) => c.id));
}

const WEIGHT_STEPS = [
  { name: 'Minor', order: 20 }, { name: 'Supplementary', order: 50 },
  { name: 'Standard', order: 100 }, { name: 'Important', order: 150 },
  { name: 'Critical', order: 200 },
];
const weightName = (order) => WEIGHT_STEPS.reduce(
  (best, w) => (Math.abs(w.order - order) < Math.abs(best.order - order) ? w : best), WEIGHT_STEPS[2]).name;

$('#lore-back').addEventListener('click', async () => {
  if (lore.choosing) { lore.choosing = false; lore.chosen.clear(); renderLore(); return; }
  await loadLibrary(); show('library');
});
$('#lore-add').addEventListener('click', () => editEntry(null));
$('#lore-select').addEventListener('click', () => {
  lore.choosing = !lore.choosing;
  if (!lore.choosing) lore.chosen.clear();
  renderLore();
});
$('#lore-filters').addEventListener('click', (e) => {
  const f = e.target.closest('[data-filter]');
  if (!f) return;
  lore.filter = f.dataset.filter;
  renderLore();
  $('#lore-scroll').scrollTop = 0;
});

// Understanding a source is offered at the top of the screen now, above the
// filters and the entries, which is outside the list's own delegated clicks.
$('#lore-pinned').addEventListener('click', (e) => {
  const organize = e.target.closest('[data-organize]');
  if (organize) openSourceReview(organize.dataset.organize);
});

$('#lore-groups').addEventListener('click', async (e) => {
  const add = e.target.closest('[data-add-kind]');
  if (add) { editEntry(null, add.dataset.addKind); return; }

  const card = e.target.closest('[data-entry]');
  if (card) {
    // In choosing mode a card is a tick box, not a way in.
    if (lore.choosing) {
      const id = card.dataset.entry;
      if (lore.chosen.has(id)) lore.chosen.delete(id); else lore.chosen.add(id);
      card.classList.toggle('chosen', lore.chosen.has(id));
      updateBulkCount();
      return;
    }
    editEntry(card.dataset.entry);
    return;
  }

  const organize = e.target.closest('[data-organize]');
  if (organize) { openSourceReview(organize.dataset.organize); return; }

  const again = e.target.closest('[data-reclassify]');
  if (again) { reclassify(again.dataset.reclassify); return; }

  const kill = e.target.closest('[data-delete-book]');
  if (kill) {
    const b = lore.book;
    if (!confirm(`Delete "${b.name}" and all ${num(b.total)} entries? Stories that used it keep their memories, but lose this lore.`)) return;
    await del(`/api/lorebooks/${kill.dataset.deleteBook}`);
    toast('Deleted.', { kind: 'good' });
    await loadLibrary();
    show('library');
  }
});

// ----------------------------------------------------- doing several at once

$('#lore-bulk').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-bulk]');
  if (!btn) return;
  const action = btn.dataset.bulk;
  const bookId = lore.book.id;

  if (action === 'all') {
    for (const id of shownIds()) lore.chosen.add(id);
    renderLore();
    return;
  }
  if (action === 'none') { lore.chosen.clear(); renderLore(); return; }

  const ids = [...lore.chosen];
  if (!ids.length) { toast('Nothing chosen yet. Tap the entries you want.'); return; }

  if (action === 'retype') {
    const K = lore.book.kinds;
    sheet(`Change ${num(ids.length)} to…`, `
      <div class="why" style="margin-bottom:10px">This only changes how they are filed. Nothing about when they load changes.</div>
      ${picker(Object.entries(K).map(([k, v]) => ({ id: k, title: v.label, sub: v.hint })), { multi: false })}
      <div class="sheet-actions">
        <button class="btn quiet" data-close>Cancel</button>
        <button class="btn primary" id="do-retype">Change them</button>
      </div>`, (root) => {
      wirePicker(root);
      $('#do-retype', root).addEventListener('click', async () => {
        const kind = picked(root)[0];
        if (!kind) { toast('Pick a type.'); return; }
        await post(`/api/lorebooks/${bookId}/bulk`, { entryIds: ids, action: 'retype', kind });
        closeSheet();
        lore.chosen.clear();
        await openLorebook(bookId, { keepPlace: true });
        toast(`${num(ids.length)} moved to ${K[kind].label}.`, { kind: 'good' });
      });
    });
    return;
  }

  if (action === 'copy') {
    const books = (await get('/api/library')).lorebooks.filter((b) => b.id !== bookId);
    sheet(`Copy ${num(ids.length)} into…`, `
      <div class="why" style="margin-bottom:14px">The originals stay where they are. Each entry brings all its settings with it.</div>

      <div class="field">
        <label for="copy-new">Into a new lorebook</label>
        <input type="text" id="copy-new" placeholder="Call it what?" enterkeyhint="done">
      </div>

      ${books.length ? `
        <div class="sec-head">Or into one you already have</div>
        ${picker(books.map((b) => ({ id: b.id, title: b.name, sub: `${num(b.entry_count ?? 0)} entries` })), { multi: false })}
      ` : ''}

      <div class="sheet-actions">
        <button class="btn quiet" data-close>Cancel</button>
        <button class="btn primary" id="do-copy">Copy them</button>
      </div>`, (root) => {
      wirePicker(root);
      // Typing a new name and having an existing book ticked is ambiguous, so
      // picking one clears the other rather than silently choosing for her.
      const nameBox = $('#copy-new', root);
      nameBox.addEventListener('input', () => {
        if (nameBox.value.trim()) $$('.pick-opt', root).forEach((o) => o.setAttribute('aria-pressed', 'false'));
      });
      root.addEventListener('click', (e) => {
        if (e.target.closest('.pick-opt')) nameBox.value = '';
      });

      $('#do-copy', root).addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const newName = nameBox.value.trim();
        const target = newName ? null : picked(root)[0];
        if (!newName && !target) { toast('Name a new lorebook, or pick one.'); return; }
        btn.disabled = true;
        try {
          const r = await post(`/api/lorebooks/${bookId}/bulk`, { entryIds: ids, action: 'copy', target, newName });
          closeSheet();
          lore.chosen.clear();
          await openLorebook(bookId, { keepPlace: true });
          toast(`${num(r.copied)} copied into "${r.into.name}".`, {
            kind: 'good',
            sub: r.already ? `${num(r.already)} were already there.` : '',
          });
        } catch (err) {
          toast(err.message, { kind: 'bad' });
          btn.disabled = false;
        }
      });
    });
    return;
  }

  if (action === 'delete' && !confirm(`Delete ${ids.length} entries? This cannot be undone.`)) return;

  const r = await post(`/api/lorebooks/${bookId}/bulk`, { entryIds: ids, action });
  lore.chosen.clear();
  await openLorebook(bookId, { keepPlace: true });
  const verb = { delete: 'Deleted', disable: 'Turned off', enable: 'Turned on' }[action] || 'Changed';
  toast(`${verb} ${num(r.done)}.`, { kind: 'good' });
});

/** Read every entry again and re-file it by what it says it is. */
async function reclassify(bookId) {
  sheet('Sort by type again', `
    <div class="why" style="margin-bottom:12px">
      Reads each entry and files it by what it says it is: a heading like "Event:" or "Location:", a character sheet, a passage written as guidance. Nothing else about the entries changes.
    </div>
    <div class="switch-row">
      <div class="switch-main">
        <div class="switch-title">Leave the ones I set by hand</div>
        <div class="switch-why">On, only entries still filed as "Note" are touched. Off, everything is re-read.</div>
      </div>
      <button class="switch" id="rc-safe" aria-pressed="true"></button>
    </div>
    <div class="sheet-actions">
      <button class="btn quiet" data-close>Cancel</button>
      <button class="btn primary" id="rc-go">Sort them</button>
    </div>`, (root) => {
    $('#rc-safe', root).addEventListener('click', (ev) => {
      const sw = ev.currentTarget;
      sw.setAttribute('aria-pressed', String(sw.getAttribute('aria-pressed') !== 'true'));
    });
    $('#rc-go', root).addEventListener('click', async () => {
      const onlyUntouched = $('#rc-safe', root).getAttribute('aria-pressed') === 'true';
      const r = await post(`/api/lorebooks/${bookId}/reclassify`, { onlyUntouched });
      closeSheet();
      await openLorebook(bookId, { keepPlace: true });
      if (!r.changed) { toast('Nothing needed moving.'); return; }
      sheet(`Moved ${num(r.changed)} of ${num(r.of)}`, `
        <div class="fired">
          ${r.changes.slice(0, 120).map((ch) => `
            <div class="fired-row">
              <span class="t">${esc(ch.title)}</span>
              <span class="w">${esc(ch.from)} → ${esc(ch.to)}</span>
            </div>`).join('')}
          ${r.changes.length > 120 ? `<div class="fired-row"><span class="t" style="color:var(--ink-faint)">…and ${num(r.changed - 120)} more</span></div>` : ''}
        </div>
        <div class="sheet-actions"><button class="btn primary" data-close>Done</button></div>`);
    });
  });
}

// ------------------------------------------------------------ the editor

async function editEntry(entryId, presetKind = 'note') {
  const isNew = !entryId;
  let e = isNew
    ? { kind: presetKind, title: '', summary: '', content: '', keys: [], secondaryKeys: [],
        enabled: true, constant: false, playable: false, order: 100, traits: [] }
    : await get(`/api/entries/${entryId}`);

  const K = lore.book.kinds;

  sheet(isNew ? 'New entry' : e.title || 'Entry', `
    ${isNew ? `
      <div class="field">
        <label for="paste">Paste anything here</label>
        <div class="why">Drop in a paragraph, a wiki entry, notes you already wrote. The fields below fill themselves in and you fix whatever it got wrong. Nothing is saved until you press Save.</div>
        <textarea id="paste" placeholder="Salvatore is an experienced, pragmatic man who has spent decades navigating the criminal underworld. He owns The Black Lotus…"></textarea>
        <div style="margin-top:8px"><button class="btn" id="do-parse">Fill it in</button></div>
      </div>
      <div style="height:1px;background:var(--line);margin:18px 0"></div>` : ''}

    <div class="field">
      <label for="e-kind">What is it?</label>
      <select id="e-kind">
        ${Object.entries(K).map(([k, v]) => `<option value="${k}"${k === e.kind ? ' selected' : ''}>${esc(v.label)} — ${esc(v.hint)}</option>`).join('')}
      </select>
    </div>

    <div class="field">
      <label for="e-title">Name</label>
      <input type="text" id="e-title" value="${esc(e.title)}" placeholder="Salvatore">
    </div>

    <div class="field">
      <label for="e-content">What the AI is told</label>
      <div class="why">Short factual lines beat paragraphs. Say what a thing <em>does</em>, not what it is like. Never write what a character does not know — that makes them more likely to mention it, not less.</div>
      <textarea id="e-content" style="min-height:28dvh" placeholder="Owns and runs The Black Lotus. Keeps it neutral ground.&#10;Speaks slowly. Never asks a question he does not know the answer to.">${esc(e.content)}</textarea>
      <div class="why" id="e-count">${num(estTokens(e.content))} tokens</div>
    </div>

    <div class="field">
      <label>Trigger words</label>
      <div class="why">The entry loads when any of these appears in recent messages. Names, nicknames, what people call it.</div>
      <div class="chipset" id="e-keys"></div>
    </div>

    <div class="sec-head">How it loads</div>

    <div class="field">
      <label>Priority</label>
      <div class="why" id="w-why">When room runs out, the low ones go first.</div>
      <div class="steps" id="e-weight">
        ${WEIGHT_STEPS.map((w) => `<button class="step${weightName(e.order) === w.name ? ' is-on' : ''}" data-order="${w.order}">${w.name}</button>`).join('')}
      </div>
    </div>

    <div class="switch-row">
      <div class="switch-main">
        <div class="switch-title">Always on</div>
        <div class="switch-why">Loads with every message, no trigger words needed. Costs its full size every single time, so keep these few.</div>
      </div>
      <button class="switch" id="e-constant" aria-pressed="${e.constant}" aria-label="Always on"></button>
    </div>

    <div class="switch-row">
      <div class="switch-main">
        <div class="switch-title">This is me</div>
        <div class="switch-why">Marks this as the character you play. The AI is told never to write their words or actions.</div>
      </div>
      <button class="switch" id="e-playable" aria-pressed="${e.playable}" aria-label="This is me"></button>
    </div>

    <div class="switch-row">
      <div class="switch-main">
        <div class="switch-title">In use</div>
        <div class="switch-why">Turn off to keep an entry without it ever loading.</div>
      </div>
      <button class="switch" id="e-enabled" aria-pressed="${e.enabled}" aria-label="In use"></button>
    </div>

    <div class="sheet-actions">
      ${isNew ? '' : '<button class="btn quiet" id="e-del">Delete</button>'}
      <button class="btn quiet" data-close>Cancel</button>
      <button class="btn primary" id="e-save">Save</button>
    </div>`, (root) => {

    let keys = [...(e.keys || [])];
    const drawKeys = () => {
      $('#e-keys', root).innerHTML = keys.map((k, i) => `
        <span class="chipx">${esc(k)}<button data-rm="${i}" aria-label="Remove ${esc(k)}">&times;</button></span>`).join('')
        + `<input type="text" id="key-add" placeholder="add a word…" enterkeyhint="done">`;
      $('#key-add', root).addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ',') return;
        ev.preventDefault();
        const v = ev.target.value.trim().replace(/,$/, '');
        if (v && !keys.some((k) => k.toLowerCase() === v.toLowerCase())) keys.push(v);
        drawKeys();
        $('#key-add', root).focus();
      });
    };
    drawKeys();
    $('#e-keys', root).addEventListener('click', (ev) => {
      const rm = ev.target.closest('[data-rm]');
      if (!rm) return;
      keys.splice(Number(rm.dataset.rm), 1);
      drawKeys();
    });

    const content = $('#e-content', root);
    content.addEventListener('input', () => {
      $('#e-count', root).textContent = `${num(estTokens(content.value))} tokens`;
    });

    let order = e.order;
    $('#e-weight', root).addEventListener('click', (ev) => {
      const step = ev.target.closest('[data-order]');
      if (!step) return;
      order = Number(step.dataset.order);
      $$('.step', root).forEach((s) => s.classList.toggle('is-on', s === step));
    });

    $$('.switch', root).forEach((sw) => sw.addEventListener('click', () => {
      sw.setAttribute('aria-pressed', String(sw.getAttribute('aria-pressed') !== 'true'));
    }));

    const parseBtn = $('#do-parse', root);
    if (parseBtn) {
      parseBtn.addEventListener('click', async () => {
        const text = $('#paste', root).value.trim();
        if (!text) { toast('Paste something first.'); return; }
        try {
          const r = await post('/api/lore/parse', { text });
          $('#e-title', root).value = r.title;
          content.value = r.content;
          content.dispatchEvent(new Event('input'));
          $('#e-kind', root).value = r.kind;
          keys = r.keys;
          drawKeys();
          toast('Filled in. Check it over.', { sub: r.notes.join(' '), kind: 'good', ms: 8000 });
        } catch (err) { toast(err.message, { kind: 'bad' }); }
      });
    }

    $('#e-save', root).addEventListener('click', async () => {
      const body = {
        id: isNew ? undefined : e.id,
        kind: $('#e-kind', root).value,
        title: $('#e-title', root).value.trim(),
        content: content.value,
        summary: content.value.split(/(?<=[.!?])\s/)[0].slice(0, 180),
        keys,
        order,
        constant: $('#e-constant', root).getAttribute('aria-pressed') === 'true',
        playable: $('#e-playable', root).getAttribute('aria-pressed') === 'true',
        enabled: $('#e-enabled', root).getAttribute('aria-pressed') === 'true',
        secondaryKeys: e.secondaryKeys || [],
        traits: e.traits || [],
      };
      if (!body.content.trim()) { toast('An entry with nothing in it will never do anything.'); return; }
      if (!body.constant && !keys.length) {
        if (!confirm('This has no trigger words and is not always on, so it can never load. Save it anyway?')) return;
      }
      await post(`/api/lorebooks/${lore.book.id}/entries`, body);
      closeSheet();
      await openLorebook(lore.book.id);
      toast('Saved.', { kind: 'good' });
    });

    const delBtn = $('#e-del', root);
    if (delBtn) delBtn.addEventListener('click', async () => {
      if (!confirm('Delete this entry?')) return;
      await api(`/api/entries/${e.id}`, { method: 'DELETE' });
      closeSheet();
      await openLorebook(lore.book.id);
    });
  });
}

// ========================================================================
// What the story remembers.
// Everything here is editable, because an extractor that gets something
// wrong and cannot be corrected is worse than no memory at all.
// ========================================================================

$('#btn-bible').addEventListener('click', () => { pendingBack = null; storyBible(); });
$('#btn-memory').addEventListener('click', openMemory);

async function openMemory() {
  sheet('What the story remembers', '<div class="empty">Reading…</div>');
  let m;
  try { m = await get(`/api/stories/${state.story.id}/memory`); }
  catch (err) { sheet('What the story remembers', `<div class="notice">${esc(err.message)}</div>`); return; }
  state.memory = m;
  drawMemory(m);
}

function drawMemory(m) {
  const c = m.counts;
  const behind = m.stats.total - m.stats.read;

  sheet('What the story remembers', `
    <div class="mem-top">
      <div class="mem-stat"><b>${num(c.characters)}</b><span>PEOPLE</span></div>
      <div class="mem-stat"><b>${num(c.facts)}</b><span>FACTS</span></div>
      <div class="mem-stat"><b>${num(c.threads)}</b><span>UNFINISHED</span></div>
      <div class="mem-stat"><b>${num(m.episodes.length)}</b><span>SCENES</span></div>
    </div>

    ${behind > 0 ? `
      <div class="notice" style="margin-bottom:14px">
        <b>${num(behind)} message${behind === 1 ? '' : 's'} not read yet.</b>
        Anything played before memory was switched on is still unknown to it.
        <div style="margin-top:8px"><button class="btn" id="mem-backfill">Read them now</button></div>
        <div class="why" style="margin-top:6px">About ${num(behind)} quick model calls. Roughly $${(behind * 0.0004).toFixed(2)}.</div>
      </div>` : ''}

    ${m.lastError ? `
      <div class="notice" style="margin-bottom:14px;border-color:var(--warn)">
        <b>The last memory pass failed.</b> ${esc(m.lastError.message || '')}
        <div class="why" style="margin-top:6px">Usually a model that does not exist, no credit left, or a provider that refused the text. Check the model under Memory settings.</div>
      </div>` : ''}

    ${m.gaps.missing > 0 ? `
      <div class="notice" style="margin-bottom:14px;border-color:var(--warn)">
        <b>${num(m.gaps.missing)} messages are in neither the recent window nor a folded scene.</b>
        That is the one state this is built to prevent, so it is worth telling me about.
      </div>` : ''}

    ${(m.clock.display || m.scene.where) ? `
      <div class="now-card">
        ${m.clock.display ? `<div class="when">${esc(m.clock.display)}</div>` : ''}
        ${m.scene.where ? `<div class="where">${esc(m.scene.where)}</div>` : ''}
        ${m.scene.who?.length ? `<div class="who">${m.scene.who.map((w) => `<span class="who-chip">${esc(pretty(w))}</span>`).join(' ')}</div>` : ''}
      </div>` : ''}

    ${m.proposals.length ? `
      <div class="sec-head">Names the story invented</div>
      <div class="why" style="margin:-4px 0 8px">Mentioned but not in your lore. Add one and it will load whenever they come up again.</div>
      ${m.proposals.slice(0, 8).map((p) => `
        <div class="mem-item">
          <div class="mem-body">
            <div class="mem-text">${esc(p.name)}</div>
            <div class="mem-meta"><span>${esc((p.about || '').slice(0, 90))}</span><span>mentioned ${p.times}&times;</span></div>
          </div>
          <div class="mem-act"><button data-accept="${esc(p.name)}" data-about="${esc(p.about || '')}">Add</button></div>
        </div>`).join('')}` : ''}

    <div class="sec-head">Unfinished business</div>
    ${m.tidyable > 8 ? `
      <div class="notice" style="margin-bottom:12px">
        <b>${num(m.tidyable)} of these are not really unfinished business.</b>
        They are questions the scene answered a moment later, like "what she says next", kept by an earlier version of the memory pass. They crowd out the promises that matter.
        <div style="margin-top:8px"><button class="btn" id="mem-tidy">Look at them</button></div>
      </div>` : ''}
    ${m.threads.length ? m.threads.map(threadRow).join('') : '<div class="empty">Nothing owed yet.</div>'}

    <div class="sec-head">People</div>
    ${m.characters.length ? m.characters.map(personRow).join('') : '<div class="empty">Nobody recorded yet.</div>'}

    <div class="sec-head">What is known</div>
    ${m.facts.length ? m.facts.filter((f) => !f.until).map(factRow).join('') : '<div class="empty">No facts recorded yet.</div>'}
    ${m.facts.some((f) => f.until) ? `
      <div class="why" style="margin-top:10px">${num(m.facts.filter((f) => f.until).length)} fact${m.facts.filter((f) => f.until).length === 1 ? ' is' : 's are'} no longer true and have been retired. They are kept but never sent.</div>` : ''}

    ${m.episodes.length ? `
      <div class="sec-head">Earlier scenes</div>
      <div class="why" style="margin:-4px 0 8px">Older messages folded down so they survive past the window.</div>
      ${m.episodes.map((e) => `
        <div class="mem-item">
          <div class="mem-body">
            <div class="mem-text" style="font-size:13.5px">${esc(e.content)}</div>
            <div class="mem-meta"><span>${num(e.covers)} messages</span>${e.keys.length ? `<span>${esc(e.keys.slice(0, 4).join(', '))}</span>` : ''}</div>
          </div>
          <div class="mem-act"><button data-drop-ep="${esc(e.id)}">Forget</button></div>
        </div>`).join('')}` : ''}

    <div class="sheet-actions">
      <button class="btn quiet" id="mem-settings">Memory settings</button>
      <button class="btn primary" data-close>Close</button>
    </div>`, wireMemory);
}

const pretty = (slug) => String(slug).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function threadRow(t) {
  return `
    <div class="mem-item">
      <div class="mem-body">
        <div class="mem-text">${esc(t.text)}</div>
        <div class="mem-meta">
          <span>${esc(t.kind)}</span>
          ${t.owedBy ? `<span>${esc(pretty(t.owedBy))}${t.owedTo ? ` to ${esc(pretty(t.owedTo))}` : ''}</span>` : ''}
          <span class="${t.ready ? 'ready' : ''}">
            <span class="gauge">pressing <i style="--w:${t.score}%"></i> ${t.score}%</span>
          </span>
          <span>${esc(t.why)}</span>
        </div>
      </div>
      <div class="mem-act">
        ${t.status === 'open' || t.status === 'in-progress'
          ? `<button data-close-thread="${esc(t.id)}">Done</button>`
          : `<span style="font-size:12px;color:var(--ink-faint);padding:4px 7px">${esc(t.status)}</span>`}
        <button data-edit-thread="${esc(t.id)}">Edit</button>
      </div>
    </div>`;
}

function personRow(c) {
  const bits = [c.location, c.mood, c.wants ? `wants ${c.wants}` : ''].filter(Boolean);
  const rel = Object.entries(c.relations || {}).filter(([, r]) => r.stage || r.score);
  return `
    <div class="mem-item">
      <div class="mem-body">
        <div class="mem-text">${esc(c.name || pretty(c.id))}${c.present ? ' <span class="who-chip">here</span>' : ''}</div>
        ${bits.length ? `<div class="mem-meta"><span>${esc(bits.join(' · '))}</span></div>` : ''}
        ${c.hurt?.length ? `<div class="mem-meta"><span style="color:var(--warn)">${esc(c.hurt.join(', '))}</span></div>` : ''}
        ${rel.length ? `<div class="mem-meta">${rel.map(([o, r]) =>
          `<span>${esc(pretty(o))}: ${esc(r.stage || 'known')}${r.score ? ` (${r.score})` : ''}</span>`).join('')}</div>` : ''}
      </div>
      <div class="mem-act"><button data-edit-person="${esc(c.id)}">Edit</button></div>
    </div>`;
}

function factRow(f) {
  return `
    <div class="mem-item">
      <div class="mem-body">
        <div class="mem-text">${esc(f.text)}</div>
        <div class="mem-meta">
          ${f.secrecy >= 1 ? '<span class="who-chip secret-chip">not common knowledge</span>' : ''}
          <span>known to ${f.knownBy.length ? f.knownBy.map(pretty).join(', ') : 'nobody yet'}</span>
        </div>
      </div>
      <div class="mem-act">
        <button data-edit-fact="${esc(f.id)}">Edit</button>
        <button data-retire="${esc(f.id)}" title="No longer true">Retire</button>
      </div>
    </div>`;
}

function wireMemory(root) {
  const sid = state.story.id;

  const backfill = $('#mem-backfill', root);
  if (backfill) backfill.addEventListener('click', () => runBackfill(sid));
  const tidy = $('#mem-tidy', root);
  if (tidy) tidy.addEventListener('click', () => showTidy(sid));

  root.addEventListener('click', async (e) => {
    const accept = e.target.closest('[data-accept]');
    if (accept) {
      await post(`/api/stories/${sid}/memory/accept-name`, {
        name: accept.dataset.accept, about: accept.dataset.about,
      });
      toast(`${accept.dataset.accept} added to your lore.`, { kind: 'good' });
      await loadLibrary();
      openMemory();
      return;
    }

    const done = e.target.closest('[data-close-thread]');
    if (done) {
      await post(`/api/stories/${sid}/memory/correct`, {
        path: `threads/${done.dataset.closeThread}/status`, value: 'kept',
        note: 'marked done by hand',
      });
      openMemory();
      return;
    }

    const retire = e.target.closest('[data-retire]');
    if (retire) {
      await post(`/api/stories/${sid}/memory/correct`, {
        path: `facts/${retire.dataset.retire}/until`, value: 9e9,
        note: 'retired by hand',
      });
      toast('Retired. It stays on record but is never sent again.', { kind: 'good' });
      openMemory();
      return;
    }

    const dropEp = e.target.closest('[data-drop-ep]');
    if (dropEp) {
      if (!confirm('Forget this scene? The messages it covers stay, but they will need folding again.')) return;
      await api(`/api/memory/episodes/${dropEp.dataset.dropEp}`, { method: 'DELETE' });
      openMemory();
      return;
    }

    const ef = e.target.closest('[data-edit-fact]');
    if (ef) { editMemoryText('facts', ef.dataset.editFact, 'text', 'Fact'); return; }
    const et = e.target.closest('[data-edit-thread]');
    if (et) { editMemoryText('threads', et.dataset.editThread, 'text', 'Unfinished business'); return; }
    const ep = e.target.closest('[data-edit-person]');
    if (ep) { editPerson(ep.dataset.editPerson); return; }
  });

  $('#mem-settings', root).addEventListener('click', memorySettings);
}

/** Close the threads that were only the scene moving along. Your call, always. */
async function showTidy(sid) {
  const { threads } = await get(`/api/stories/${sid}/memory/tidy`);
  if (!threads.length) { toast('Nothing to tidy.'); return; }
  sheet('Not really unfinished', `
    <div class="why" style="margin-bottom:12px">
      These read as questions the scene answered straight away, not as debts the story still owes. Closing them leaves promises, secrets and debts untouched, however old they are, and nothing is deleted: they stay on record marked as faded.
    </div>
    ${picker(threads.map((t) => ({
      id: t.id,
      title: t.text.slice(0, 90),
      sub: `${t.kind} · opened ${num(t.age)} messages ago, never once raised`,
    })), { selected: new Set(threads.map((t) => t.id)) })}
    <div class="sheet-actions">
      <button class="btn quiet" id="tidy-back">Back</button>
      <button class="btn primary" id="tidy-go">Close the ticked ones</button>
    </div>`, (root) => {
    wirePicker(root);
    $('#tidy-back', root).addEventListener('click', openMemory);
    $('#tidy-go', root).addEventListener('click', async () => {
      const ids = picked($$('.pick', root)[0]);
      if (!ids.length) { toast('Nothing ticked.'); return; }
      const r = await post(`/api/stories/${sid}/memory/tidy`, { threadIds: ids });
      toast(`Closed ${num(r.closed)}.`, { sub: 'They stay on record, marked faded.', kind: 'good' });
      openMemory();
    });
  });
}

/** Correcting anything is the same shape: change one line and it sticks. */
function editMemoryText(bucket, id, field, label) {
  const m = state.memory;
  const item = (bucket === 'facts' ? m.facts : m.threads).find((x) => x.id === id);
  if (!item) return;
  sheet(`Edit ${label.toLowerCase()}`, `
    <div class="field">
      <div class="why">Corrections always win over anything the memory pass works out later.</div>
      <textarea id="mem-edit" style="min-height:16dvh">${esc(item[field])}</textarea>
    </div>
    <div class="sheet-actions">
      <button class="btn quiet" id="mem-cancel">Back</button>
      <button class="btn primary" id="mem-save">Save</button>
    </div>`, (root) => {
    $('#mem-cancel', root).addEventListener('click', openMemory);
    $('#mem-save', root).addEventListener('click', async () => {
      await post(`/api/stories/${state.story.id}/memory/correct`, {
        path: `${bucket}/${id}/${field}`,
        value: $('#mem-edit', root).value,
        note: 'edited by hand',
      });
      toast('Corrected.', { kind: 'good' });
      openMemory();
    });
  });
}

function editPerson(id) {
  const c = state.memory.characters.find((x) => x.id === id);
  if (!c) return;
  const f = (k, label, why) => `
    <div class="field">
      <label for="p-${k}">${label}</label>
      ${why ? `<div class="why">${why}</div>` : ''}
      <input type="text" id="p-${k}" value="${esc(c[k] || '')}">
    </div>`;
  sheet(`Edit ${c.name || pretty(id)}`, `
    ${f('location', 'Where they are')}
    ${f('wearing', 'What they are wearing')}
    ${f('mood', 'How they are')}
    ${f('wants', 'What they want right now')}
    <div class="field">
      <label for="p-hurt">Injuries</label>
      <div class="why">Separate several with commas. Leave empty for none.</div>
      <input type="text" id="p-hurt" value="${esc((c.hurt || []).join(', '))}">
    </div>
    <div class="sheet-actions">
      <button class="btn quiet" id="mem-cancel">Back</button>
      <button class="btn primary" id="mem-save">Save</button>
    </div>`, (root) => {
    $('#mem-cancel', root).addEventListener('click', openMemory);
    $('#mem-save', root).addEventListener('click', async () => {
      const sid = state.story.id;
      for (const k of ['location', 'wearing', 'mood', 'wants']) {
        const v = $(`#p-${k}`, root).value;
        if (v !== (c[k] || '')) {
          await post(`/api/stories/${sid}/memory/correct`, { path: `characters/${id}/${k}`, value: v, note: 'edited by hand' });
        }
      }
      const hurt = $('#p-hurt', root).value.split(',').map((s) => s.trim()).filter(Boolean);
      if (JSON.stringify(hurt) !== JSON.stringify(c.hurt || [])) {
        await post(`/api/stories/${sid}/memory/correct`, { path: `characters/${id}/hurt`, value: hurt, note: 'edited by hand' });
      }
      toast('Corrected.', { kind: 'good' });
      openMemory();
    });
  });
}

async function memorySettings() {
  const m = state.memory;
  sheet('Memory settings', `
    <div class="switch-row">
      <div class="switch-main">
        <div class="switch-title">Keep a memory</div>
        <div class="switch-why">After each reply, a cheap second model reads what happened and writes down what changed. Adds roughly a fifth to the cost and is the reason anything survives past the window.</div>
      </div>
      <button class="switch" id="mem-on" aria-pressed="${m.settings.on}"></button>
    </div>
    <div class="switch-row">
      <div class="switch-main">
        <div class="switch-title">Offer new names as lore</div>
        <div class="switch-why">When the story invents someone, offer to add them so they stay consistent.</div>
      </div>
      <button class="switch" id="mem-lore" aria-pressed="${m.settings.proposeLore}"></button>
    </div>
    <div class="field" style="margin-top:16px">
      <label for="mem-model">Which model does the reading</label>
      <div class="why">It must be uncensored. A model that softens what it reads will quietly euphemise the details this exists to keep, and you will not find out until the story needs them.</div>
      <input type="text" id="mem-model" value="${esc(m.settings.model)}">
    </div>
    <div class="sheet-actions">
      <button class="btn quiet" id="mem-cancel">Back</button>
      <button class="btn primary" id="mem-save">Save</button>
    </div>`, (root) => {
    $$('.switch', root).forEach((sw) => sw.addEventListener('click', () => {
      sw.setAttribute('aria-pressed', String(sw.getAttribute('aria-pressed') !== 'true'));
    }));
    $('#mem-cancel', root).addEventListener('click', openMemory);
    $('#mem-save', root).addEventListener('click', async () => {
      await post(`/api/stories/${state.story.id}/memory/settings`, {
        on: $('#mem-on', root).getAttribute('aria-pressed') === 'true',
        proposeLore: $('#mem-lore', root).getAttribute('aria-pressed') === 'true',
        model: $('#mem-model', root).value.trim(),
      });
      toast('Saved.', { kind: 'good' });
      openMemory();
    });
  });
}

/** Read everything played before memory existed, showing progress as it goes. */
async function runBackfill(sid) {
  sheet('Catching up', `
    <div class="why">Reading every message this story has, one at a time. You can close this; it carries on.</div>
    <div class="meter-bar" style="margin:14px 0 8px"><i id="bf-bar" style="width:0%"></i></div>
    <div id="bf-text" style="font-size:14px;color:var(--ink-soft)">Starting…</div>`);

  try {
    const res = await fetch(`/api/stories/${sid}/memory/backfill`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || `Could not start (${res.status}).`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const raw of events) {
        const type = /^event: (.+)$/m.exec(raw)?.[1];
        const line = /^data: (.*)$/m.exec(raw)?.[1];
        if (!type || line === undefined) continue;
        let d; try { d = JSON.parse(line); } catch { continue; }
        const bar = $('#bf-bar'); const text = $('#bf-text');
        if (!bar) continue;
        if (type === 'progress') {
          bar.style.width = `${Math.round(d.done / d.total * 100)}%`;
          text.textContent = `${num(d.done)} of ${num(d.total)} read`;
        } else if (type === 'done') {
          bar.style.width = '100%';
          const bits = [`Read ${num(d.read)} of ${num(d.of)}`];
          if (d.folded) bits.push(`folded ${num(d.folded)} scene${d.folded === 1 ? '' : 's'}`);
          if (d.foldFailed) bits.push(`${num(d.foldFailed)} scene${d.foldFailed === 1 ? '' : 's'} could not be folded`);
          text.textContent = bits.join(', ') + '.';
          if (d.stoppedEarly) {
            text.textContent += ` Stopped early: ${d.lastError || 'the model kept failing'}.`;
          } else {
            setTimeout(openMemory, 900);
          }
        } else if (type === 'error') {
          text.textContent = d.message;
        }
      }
    }
  } catch (err) {
    toast(err.message, { kind: 'bad' });
  }
}


/** A quiet line under the reply saying what memory picked up. */
function noteRemembered(r) {
  const bits = [];
  if (r.facts) bits.push(`${r.facts} fact${r.facts === 1 ? '' : 's'}`);
  if (r.threads) bits.push(`${r.threads} thing${r.threads === 1 ? '' : 's'} left unfinished`);
  if (r.newNames?.length) bits.push(`met ${r.newNames.join(', ')}`);
  if (r.folded) bits.push(`folded ${r.folded} earlier scene${r.folded === 1 ? '' : 's'}`);
  if (!bits.length) return;
  const el = document.createElement('div');
  el.className = 'turn-note';
  el.innerHTML = `<span>remembered: ${bits.join(', ')}</span>`;
  $('#messages').append(el);
}

// ========================================================================
// How the story looks: a picture behind it, weather over it, and the shape
// the words take. None of this reaches the model. It is only for you.
// ========================================================================

const LOOK_DEFAULTS = { layout: 'prose', background: null, dim: 62, ambient: 'none', fontSize: 100 };
const look = () => ({ ...LOOK_DEFAULTS, ...((state.story && state.story.settings && state.story.settings.look) || {}) });

function applyLook() {
  const L = look();
  const app = $('#app');
  const scene = $('#scene-img');

  document.documentElement.style.setProperty('--dim', String(L.dim / 100));
  document.documentElement.style.setProperty('--story-size', String(L.fontSize));

  if (L.background) {
    scene.style.backgroundImage = `url(/api/assets/${L.background})`;
    app.classList.add('has-scene');
  } else {
    scene.style.backgroundImage = '';
    app.classList.remove('has-scene');
  }

  const msgs = $('#messages');
  msgs.classList.remove('layout-prose', 'layout-bubbles', 'layout-portraits');
  msgs.classList.add(`layout-${L.layout}`);

  ambient.start(L.ambient);
}

/**
 * Weather. A few hundred particles on a canvas, paused whenever the page is
 * not being looked at, and switched off entirely for anyone who has asked
 * their device to stop animating things.
 */
const ambient = {
  kind: 'none',
  raf: null,
  bits: [],

  start(kind) {
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (this.kind === kind && this.raf) return;
    this.stop();
    this.kind = kind;
    if (kind === 'none' || still) return;

    const c = $('#scene-fx');
    const ctx = c.getContext('2d');
    const dpr = Math.min(devicePixelRatio || 1, 2);

    const size = () => {
      c.width = Math.floor(c.clientWidth * dpr);
      c.height = Math.floor(c.clientHeight * dpr);
    };
    size();
    this.onResize = size;
    addEventListener('resize', size);

    // Fewer on a phone: it is a smaller screen and a smaller battery.
    const n = { rain: 140, snow: 90, dust: 60, embers: 45 }[kind] || 60;
    const count = innerWidth < 600 ? Math.round(n * 0.6) : n;
    this.bits = Array.from({ length: count }, () => this.spawn(c, kind, true));

    const step = () => {
      ctx.clearRect(0, 0, c.width, c.height);
      for (const b of this.bits) this.draw(ctx, c, b, kind);
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  },

  spawn(c, kind, anywhere) {
    const r = (a, b) => a + Math.random() * (b - a);
    return {
      x: r(0, c.width),
      y: anywhere ? r(0, c.height) : (kind === 'embers' ? c.height + 10 : -10),
      z: r(0.4, 1),
      vx: kind === 'rain' ? r(-0.6, -0.1) : r(-0.25, 0.25),
      vy: kind === 'rain' ? r(9, 15) : kind === 'snow' ? r(0.7, 1.8) : kind === 'embers' ? r(-1.6, -0.6) : r(0.15, 0.5),
      len: r(8, 22),
      life: r(0, 1),
    };
  },

  draw(ctx, c, b, kind) {
    b.x += b.vx * b.z;
    b.y += b.vy * b.z;
    if (kind === 'snow' || kind === 'dust') b.x += Math.sin((b.y + b.life * 200) / 90) * 0.4;

    const gone = kind === 'embers' ? b.y < -20 : b.y > c.height + 20;
    if (gone || b.x < -40 || b.x > c.width + 40) Object.assign(b, this.spawn(c, kind, false));

    ctx.beginPath();
    if (kind === 'rain') {
      ctx.strokeStyle = `rgba(200,215,235,${0.10 + b.z * 0.16})`;
      ctx.lineWidth = b.z * 1.1;
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x + b.vx * 2.5, b.y + b.len * b.z);
      ctx.stroke();
      return;
    }
    const colour = kind === 'embers'
      ? `rgba(255,${150 + Math.floor(b.z * 60)},90,${0.18 + b.z * 0.4})`
      : kind === 'snow'
        ? `rgba(255,255,255,${0.14 + b.z * 0.4})`
        : `rgba(230,220,205,${0.06 + b.z * 0.14})`;
    ctx.fillStyle = colour;
    ctx.arc(b.x, b.y, (kind === 'dust' ? 1.1 : 1.7) * b.z * (devicePixelRatio > 1 ? 1.6 : 1), 0, Math.PI * 2);
    ctx.fill();
  },

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    if (this.onResize) removeEventListener('resize', this.onResize);
    const c = $('#scene-fx');
    const ctx = c && c.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, c.width, c.height);
  },
};

// Stop drawing weather nobody is watching.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') ambient.stop();
  else if (state.story) applyLook();
});

// ------------------------------------------------------------- the now bar

/** A quiet line saying when and where you are, tappable for the rest. */
async function refreshNow({ quiet = false } = {}) {
  const strip = $('#now-strip');
  if (!state.story) { strip.hidden = true; return; }
  try {
    const m = await get(`/api/stories/${state.story.id}/memory`);
    state.memory = m;
    const here = (m.scene.who || []).map(pretty);
    const present = m.characters.filter((c) => c.present).map((c) => c.name || pretty(c.id));
    const who = [...new Set([...here, ...present])];
    if (!m.clock.display && !m.scene.where && !who.length) { strip.hidden = true; return; }
    $('#now-when').textContent = m.clock.display || '';
    $('#now-where').textContent = m.scene.where || '';
    $('#now-who').textContent = who.slice(0, 4).join(' · ');
    strip.hidden = false;
  } catch {
    if (!quiet) strip.hidden = true;
  }
}

$('#now-strip').addEventListener('click', showNowPanel);

/** The glanceable version: where things stand, without the full audit. */
function showNowPanel() {
  const m = state.memory;
  if (!m) { openMemory(); return; }
  const present = m.characters.filter((c) => c.present || (m.scene.who || []).includes(c.id));
  const cast = present.length ? present : m.characters.slice(0, 4);
  const open = m.threads.filter((t) => t.status === 'open' || t.status === 'in-progress');

  sheet('Where things stand', `
    ${(m.clock.display || m.scene.where) ? `
      <div class="now-card">
        ${m.clock.display ? `<div class="when">${esc(m.clock.display)}</div>` : ''}
        ${m.scene.where ? `<div class="where">${esc(m.scene.where)}</div>` : ''}
      </div>` : ''}

    ${cast.length ? `
      <div class="sec-head">Here</div>
      ${cast.map((c) => {
        const rel = Object.entries(c.relations || {}).filter(([, r]) => r.stage);
        return `
        <div class="mem-item">
          <div class="mem-body">
            <div class="mem-text">${esc(c.name || pretty(c.id))}</div>
            ${c.mood || c.wants ? `<div class="mem-meta"><span>${esc([c.mood, c.wants && `wants ${c.wants}`].filter(Boolean).join(' · '))}</span></div>` : ''}
            ${c.hurt && c.hurt.length ? `<div class="mem-meta"><span style="color:var(--warn)">${esc(c.hurt.join(', '))}</span></div>` : ''}
            ${rel.length ? `<div class="mem-meta">${rel.map(([o, r]) => `<span>${esc(pretty(o))}: ${esc(r.stage)}</span>`).join('')}</div>` : ''}
          </div>
        </div>`;
      }).join('')}` : ''}

    ${open.length ? `
      <div class="sec-head">Still owed</div>
      ${open.slice(0, 6).map((t) => `
        <div class="mem-item">
          <div class="mem-body">
            <div class="mem-text">${esc(t.text)}</div>
            <div class="mem-meta"><span class="${t.ready ? 'ready' : ''}">${t.ready ? 'could come up now' : `pressing ${t.score}%`}</span></div>
          </div>
        </div>`).join('')}` : ''}

    <div class="sheet-actions">
      <button class="btn quiet" id="now-full">Everything it remembers</button>
      <button class="btn primary" data-close>Close</button>
    </div>`, (root) => {
    $('#now-full', root).addEventListener('click', openMemory);
  });
}

// ------------------------------------------------- how it is being told
//
// The controls a preset puts in front of you, over the story rather than in a
// screen of their own. Every choice says in plain words what it does, and
// what it costs, so none of it has to be guessed at.

const ADVICE = {
  recommended: 'recommended',
  optional: 'optional',
  troubleshooting: 'if trouble',
  advanced: 'advanced',
};

function optionRow(macro, o, on) {
  return `
    <button type="button" class="opt" data-macro="${esc(macro)}" data-opt="${esc(o.id)}" aria-pressed="${on}">
      <span class="opt-name">${esc(o.label)}</span>
      ${o.description ? `<span class="opt-why">${esc(o.description)}</span>` : ''}
    </button>`;
}

function controlBody(c, value) {
  switch (c.type) {
    case 'radio':
      return `<div class="opts">${c.options.map((o) => optionRow(c.macro, o, o.id === value)).join('')}</div>`;

    case 'select':
      return `
        <select class="sel" data-macro="${esc(c.macro)}">
          ${c.options.map((o) => `<option value="${esc(o.id)}" ${o.id === value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>
        <div class="ctrl-help" style="margin:7px 0 0" data-desc="${esc(c.macro)}">
          ${esc(c.options.find((o) => o.id === value)?.description || '')}
        </div>`;

    case 'range': {
      const [lo, hi] = Array.isArray(value) && value.length === 2 ? value : [c.min, c.max];
      const pct = (v) => ((v - c.min) / Math.max(1, c.max - c.min)) * 100;
      return `
        <div class="range2" data-macro="${esc(c.macro)}">
          <div class="range-track"><i style="left:${pct(lo)}%;right:${100 - pct(hi)}%"></i></div>
          <input type="range" min="${c.min}" max="${c.max}" step="${c.step}" value="${lo}" data-end="lo" aria-label="shortest">
          <input type="range" min="${c.min}" max="${c.max}" step="${c.step}" value="${hi}" data-end="hi" aria-label="longest">
          <span class="range-val">${lo} to ${hi}</span>
        </div>`;
    }

    case 'tags': {
      const on = new Set(Array.isArray(value) ? value : []);
      // Anything chosen that the preset never listed was typed in by hand, so
      // it has to be drawn from the value rather than from the options.
      const custom = [...on].filter((id) => !c.options.some((o) => o.id === id));
      return `
        <div class="chips" data-macro="${esc(c.macro)}">
          ${c.options.map((o) => `<button type="button" class="chip-tag" data-tag="${esc(o.id)}" aria-pressed="${on.has(o.id)}">${esc(o.label)}</button>`).join('')}
          ${custom.map((t) => `<button type="button" class="chip-tag" data-tag="${esc(t)}" aria-pressed="true">${esc(t)}</button>`).join('')}
        </div>
        ${c.allowCustom ? `<input type="text" class="tag-add" data-macro="${esc(c.macro)}" placeholder="${esc(c.customPlaceholder || 'Add one…')}" enterkeyhint="done" style="margin-top:8px">` : ''}`;
    }

    case 'toggle':
      return `
        <div class="switch-row" style="border:0;padding:0">
          <div class="switch-main"><div class="switch-why">${esc(value === false ? (c.offText || 'Off') : (c.onText || 'On'))}</div></div>
          <button class="switch" data-macro="${esc(c.macro)}" aria-pressed="${value !== false}"></button>
        </div>`;

    default:
      return `<textarea data-macro="${esc(c.macro)}" rows="4" placeholder="${esc(c.placeholder || '')}">${esc(value || '')}</textarea>`;
  }
}

async function panelDials() {
  const sid = state.story.id;
  const d = await get(`/api/stories/${sid}/dials`);

  if (!d.script) {
    subSheet('How it is being told', `
      ${backRow()}
      <div class="why" style="margin-bottom:14px">
        This story is using the plain dials rather than a preset with controls.
        A preset writes the whole prompt and puts named choices in front of you instead of numbers.
      </div>
      ${d.presets.length ? `
        <div class="sec-head">Presets you have</div>
        ${picker(d.presets.map((p) => ({ id: p.id, title: p.name, sub: 'Use this preset in this story' })), { multi: false })}
        <div class="sheet-actions">
          <button class="btn quiet" data-back>Back</button>
          <button class="btn primary" id="use-preset">Use it</button>
        </div>`
      : `<div class="empty">You have not imported one yet. Drop a preset file in from the Lore tab and it will show up here.</div>
         <div class="sheet-actions"><button class="btn quiet" data-back>Back</button></div>`}`, (root) => {
      wirePicker(root);
      const use = $('#use-preset', root);
      if (use) use.addEventListener('click', async () => {
        const presetId = picked(root)[0];
        if (!presetId) { toast('Pick one first.'); return; }
        await post(`/api/stories/${sid}/use-preset`, { presetId });
        state.story = await get(`/api/stories/${sid}`);
        panelDials();
      });
    });
    return;
  }

  const S = d.script;
  const changed = new Set(d.changed);
  const byId = new Map(S.controls.map((c) => [c.id, c]));
  const bundleName = (id) => S.bundles.find((b) => b.id === id)?.name || 'the defaults';

  const section = (sec) => {
    const mine = S.controls.filter((c) => c.group === sec.id);
    if (!mine.length) return '';
    return `
      <div class="sec-head">${esc(sec.title)}</div>
      ${sec.description ? `<div class="hint">${esc(sec.description)}</div>` : ''}
      ${mine.map((c) => `
        <div class="ctrl${changed.has(c.id) ? ' is-changed' : ''}" data-ctrl="${esc(c.id)}">
          <div class="ctrl-top">
            <span class="ctrl-label">${esc(c.label)}</span>
            ${c.advice && ADVICE[c.advice] ? `<span class="badge ${esc(c.advice)}">${esc(ADVICE[c.advice])}</span>` : ''}
            ${changed.has(c.id) ? `<button class="ctrl-reset" data-reset="${esc(c.macro)}">Reset</button>` : ''}
          </div>
          ${c.help ? `<div class="ctrl-help">${esc(c.help)}</div>` : ''}
          ${controlBody(c, d.values[c.macro])}
          <div class="ctrl-cost" data-cost="${esc(c.id)}">${num(d.cost[c.id] || 0)} tokens</div>
        </div>`).join('')}`;
  };

  subSheet('How it is being told', `
    ${backRow()}

    <div class="blurb" id="blurb" style="margin-bottom:14px">
      <span class="name">${esc(S.name)}</span>${S.meta.version ? ` v${esc(S.meta.version)}` : ''}${S.meta.author ? ` by ${esc(S.meta.author)}` : ''}
      ${S.meta.description ? `<p>${esc(S.meta.description)}</p><button type="button" id="blurb-more">Read more</button>` : ''}
      ${S.meta.writtenFor ? `<p class="hint" style="margin-top:8px">${esc(S.meta.writtenFor)}</p>` : ''}
    </div>

    ${S.bundles.length ? `
      <div class="sec-head" style="margin-top:0">Ready-made setups</div>
      <div class="setups">
        <button type="button" class="setup" data-bundle="" aria-pressed="${!d.bundle}">
          <span class="tick">✓</span>
          <span><span class="setup-name">Defaults</span><span class="setup-why">Every control exactly as the author made it.</span></span>
        </button>
        ${S.bundles.map((b) => `
          <button type="button" class="setup" data-bundle="${esc(b.id)}" aria-pressed="${d.bundle === b.id}">
            <span class="tick">✓</span>
            <span><span class="setup-name">${esc(b.name)}</span><span class="setup-why">${esc(b.description)}</span></span>
          </button>`).join('')}
      </div>` : ''}

    <div class="drift" id="drift">
      <span id="drift-text">${d.changed.length
        ? `<b>${num(d.changed.length)} changed</b> from ${esc(bundleName(d.bundle))}`
        : 'Exactly as set'}</span>
      ${d.changed.length ? '<button class="ctrl-reset" id="reset-all">Reset all</button>' : ''}
      <span class="spend" id="drift-cost">${num(d.total)} tokens a message</span>
    </div>

    ${S.sections.map(section).join('')}

    <div class="sheet-actions">
      <button class="btn quiet" data-back>Back</button>
      <button class="btn primary" data-close>Done</button>
    </div>`, (root) => {
    // Every change saves immediately. There is no Save button on purpose:
    // this opens over a scene you are in the middle of, and a panel you have
    // to remember to confirm is a panel that loses your change.
    let saving = null;
    const save = (body) => {
      saving = (saving || Promise.resolve()).then(async () => {
        const r = await post(`/api/stories/${sid}/dials`, body).catch((e) => { toast(e.message, { kind: 'bad' }); return null; });
        if (!r) return;
        $('#drift-cost', root).textContent = `${num(r.total)} tokens a message`;
        for (const [cid, n] of Object.entries(r.cost)) {
          const el = $(`[data-cost="${CSS.escape(cid)}"]`, root);
          if (el) el.textContent = `${num(n)} tokens`;
        }
        const t = $('#drift-text', root);
        if (t) {
          t.innerHTML = r.changed.length
            ? `<b>${num(r.changed.length)} changed</b> from ${esc(bundleName(r.bundle))}`
            : 'Exactly as set';
        }
        state.story = await get(`/api/stories/${sid}`);
        refreshQuickbar();
      });
      return saving;
    };

    root.addEventListener('click', async (e) => {
      if (e.target.closest('#blurb-more')) {
        const b = $('#blurb', root);
        b.classList.toggle('open');
        e.target.textContent = b.classList.contains('open') ? 'Less' : 'Read more';
        return;
      }
      const setup = e.target.closest('[data-bundle]');
      if (setup) {
        await save({ bundle: setup.dataset.bundle || null });
        panelDials();                                  // every control moved
        return;
      }
      const reset = e.target.closest('[data-reset]');
      if (reset) { await save({ reset: [reset.dataset.reset] }); panelDials(); return; }
      if (e.target.closest('#reset-all')) { await save({ reset: true }); panelDials(); return; }

      const opt = e.target.closest('.opt');
      if (opt) {
        const macro = opt.dataset.macro;
        for (const sib of $$(`.opt[data-macro="${CSS.escape(macro)}"]`, root)) sib.setAttribute('aria-pressed', 'false');
        opt.setAttribute('aria-pressed', 'true');
        save({ values: { [macro]: opt.dataset.opt } });
        return;
      }

      const tag = e.target.closest('[data-tag]');
      if (tag) {
        tag.setAttribute('aria-pressed', String(tag.getAttribute('aria-pressed') !== 'true'));
        const wrap = tag.closest('.chips');
        const on = $$('[data-tag]', wrap).filter((t) => t.getAttribute('aria-pressed') === 'true').map((t) => t.dataset.tag);
        save({ values: { [wrap.dataset.macro]: on } });
        return;
      }

      const sw = e.target.closest('.switch[data-macro]');
      if (sw) {
        const next = sw.getAttribute('aria-pressed') !== 'true';
        sw.setAttribute('aria-pressed', String(next));
        const c = S.controls.find((x) => x.macro === sw.dataset.macro);
        const why = sw.closest('.switch-row').querySelector('.switch-why');
        if (why && c) why.textContent = next ? (c.onText || 'On') : (c.offText || 'Off');
        save({ values: { [sw.dataset.macro]: next } });
      }
    });

    root.addEventListener('change', (e) => {
      const sel = e.target.closest('.sel');
      if (sel) {
        const c = S.controls.find((x) => x.macro === sel.dataset.macro);
        const desc = $(`[data-desc="${CSS.escape(sel.dataset.macro)}"]`, root);
        if (desc && c) desc.textContent = c.options.find((o) => o.id === sel.value)?.description || '';
        save({ values: { [sel.dataset.macro]: sel.value } });
      }
    });

    root.addEventListener('input', (e) => {
      const range = e.target.closest('.range2 input');
      if (range) {
        const wrap = range.closest('.range2');
        const lo = $('[data-end="lo"]', wrap);
        const hi = $('[data-end="hi"]', wrap);
        // Dragging one handle past the other would send a backwards span, so
        // the one being dragged pushes the other rather than crossing it.
        if (Number(lo.value) > Number(hi.value)) {
          if (range.dataset.end === 'lo') hi.value = lo.value; else lo.value = hi.value;
        }
        $('.range-val', wrap).textContent = `${lo.value} to ${hi.value}`;
        const min = Number(lo.min);
        const span = Math.max(1, Number(lo.max) - min);
        const fill = $('.range-track i', wrap);
        if (fill) {
          fill.style.left = `${((Number(lo.value) - min) / span) * 100}%`;
          fill.style.right = `${100 - ((Number(hi.value) - min) / span) * 100}%`;
        }
        clearTimeout(wrap._t);
        wrap._t = setTimeout(() => save({ values: { [wrap.dataset.macro]: [Number(lo.value), Number(hi.value)] } }), 350);
      }
    });

    // Typed additions: a phrase you never want to read again, added by hand.
    root.addEventListener('keydown', (e) => {
      const add = e.target.closest('.tag-add');
      if (!add || e.key !== 'Enter') return;
      e.preventDefault();
      const text = add.value.trim();
      if (!text) return;
      add.value = '';
      const chips = $(`.chips[data-macro="${CSS.escape(add.dataset.macro)}"]`, root);
      chips.insertAdjacentHTML('beforeend',
        `<button type="button" class="chip-tag" data-tag="${esc(text)}" aria-pressed="true">${esc(text)}</button>`);
      const on = $$('[data-tag]', chips).filter((t) => t.getAttribute('aria-pressed') === 'true').map((t) => t.dataset.tag);
      save({ values: { [add.dataset.macro]: on } });
    });

    // House rules and anything else free-text: saved when you leave the box.
    root.addEventListener('focusout', (e) => {
      const ta = e.target.closest('textarea[data-macro]');
      if (ta) save({ values: { [ta.dataset.macro]: ta.value } });
    });
  });
}

/** The three chips above the composer, showing where things stand. */
function refreshQuickbar() {
  const st = state.story;
  if (!st) return;
  const s = st.settings || {};

  const dials = $('#quick-dials-label');
  const dialsBtn = $('#quick-dials');
  if (dials) {
    const script = s.script && Array.isArray(s.script.items) ? s.script : null;
    const setup = script && s.bundle ? (script.bundles || []).find((b) => b.id === s.bundle) : null;
    dials.textContent = setup ? setup.name : (script ? script.name : 'Telling');
    dialsBtn.classList.toggle('is-set', !!script);
  }

  const you = $('#quick-persona-label');
  if (you) {
    // An imported conversation arrives with nobody playing you, and "You" is
    // indistinguishable from a persona actually called You. Saying it plainly
    // is the difference between a setting you never noticed and one you fix.
    you.textContent = st.persona ? st.persona.name : 'No persona';
    $('#quick-persona').classList.toggle('is-set', !!st.persona);
    $('#quick-persona').classList.toggle('is-missing', !st.persona);
  }

  const arc = $('#quick-arc-label');
  if (arc) {
    const on = s.arc && s.arc.on !== false;
    arc.textContent = on ? arcSummary(s).replace(/,.*$/, '') : 'Stages';
    $('#quick-arc').classList.toggle('is-set', !!on);
  }
}

$('#quick-dials').addEventListener('click', () => { pendingBack = null; panelDials(); });
$('#quick-persona').addEventListener('click', () => { pendingBack = null; panelPersona(state.story.settings || {}); });
$('#quick-arc').addEventListener('click', () => { pendingBack = null; panelSlowBurn(); });

// -------------------------------------------------------------- slow burn

// The message counts are measured, not guessed: they come from re-reading
// fourteen real exchanges and seeing how much closeness the memory pass
// actually reports for writing like yours.
const PACE = [
  { id: '0.5', title: 'Quicker', sub: 'Strangers to the last stage in around 320 messages. For a story you want to see through.' },
  { id: '1', title: 'Slow burn', sub: 'Around 620 messages end to end. The default.' },
  { id: '2', title: 'Very slow', sub: 'Around 1,200. Nothing arrives before you have lived with it.' },
  { id: '3', title: 'Glacial', sub: 'Around 1,900. Most stories will not finish the ladder, and that is the point.' },
];

function dialsSummary(s) {
  const script = s.script && Array.isArray(s.script.items) ? s.script : null;
  if (!script) return 'Plain dials — no preset with controls yet';
  const setup = s.bundle ? (script.bundles || []).find((b) => b.id === s.bundle) : null;
  return `${script.name}${setup ? ` · ${setup.name}` : ''}`;
}

function arcSummary(s) {
  const a = s.arc || {};
  if (a.on === false) return 'Off — the AI decides the pace';
  const p = PACE.find((x) => Number(x.id) === (Number(a.pace) || 1));
  const stages = (a.ladder || []).length || 6;
  return `${p ? p.title.toLowerCase() : 'slow burn'}, ${stages} stages`;
}

/** How reluctant somebody is, said the way a person would say it. */
const RELUCTANCE_WORDS = (v) => {
  if (v >= 0.85) return 'Will not be hurried. Twice as long as anyone else';
  if (v >= 0.6) return 'Hard to reach. Around half again as long';
  if (v >= 0.35) return 'Guarded. Needs a reason first';
  if (v > 0) return 'Slightly careful';
  return 'Open. Moves at the story\'s pace';
};

async function panelSlowBurn() {
  const sid = state.story.id;
  const d = await get(`/api/stories/${sid}/arc`);
  const on = d.arc.on !== false;

  const stageRow = (r, i) => `
    <div class="stage" data-stage="${i}">
      <div class="stage-num">${i + 1}</div>
      <div class="stage-body">
        <input class="stage-name" type="text" value="${esc(r.name)}" placeholder="what to call this stage">
        <textarea class="stage-note" rows="2" placeholder="what this stage is like">${esc(r.note || '')}</textarea>
      </div>
      <button class="stage-drop" type="button" title="Remove this stage">×</button>
    </div>`;

  const standingRow = (s) => {
    const who = `${titleCase(s.a)} and ${titleCase(s.b)}`;
    if (!s.next) return `<div class="stand"><b>${esc(who)}</b> — ${esc(s.stage)}. The top of the ladder.</div>`;
    const bar = Math.round((s.rung / (s.of - 1)) * 100);
    return `
      <div class="stand">
        <div class="stand-top"><b>${esc(who)}</b><span>${esc(s.stage)}</span></div>
        <div class="stand-bar"><i style="width:${bar}%"></i></div>
        <div class="why">${s.held
          ? `Held here. <b>${num(s.messagesLeft)} more messages</b> before "${esc(s.next)}" is even possible.`
          : `"${esc(s.next)}" is open to them now, once the story earns it.`}</div>
      </div>`;
  };

  subSheet('How closeness moves', `
    ${backRow()}

    <div class="why" style="margin-bottom:14px">
      Relationships climb these stages in order. The app decides which stage two people are on, not the AI.
      A single charged scene can push. It cannot skip ahead.
    </div>

    <div class="switch-row">
      <div class="switch-main">
        <div class="switch-title">Use stages in this story</div>
        <div class="switch-why">Off, and the AI paces it however it likes.</div>
      </div>
      <button class="switch" id="arc-on" aria-pressed="${on}"></button>
    </div>

    ${d.fresh && d.messages > 20 ? `
      <div class="notice" style="margin-top:12px">
        This story has already run <b>${num(d.messages)} messages</b> without stages.
        Switching them on works out where everyone stands from the beginning, under these rules.
        Nothing is lost and nothing is rewritten, but the answer may not be where you thought they were.
        You can put any pair where you want them afterwards.
      </div>` : ''}

    <div id="arc-rest" ${on ? '' : 'hidden'}>
      <div class="sec-head">How long the whole climb takes</div>
      ${picker(PACE, { multi: false, selected: new Set([String(Number(d.arc.pace) || 1)]) })}

      <div class="sec-head">The stages</div>
      <div class="why" style="margin:-4px 0 8px">In order, from strangers to whatever the end is. Rewrite them however your story works.</div>
      <div id="stages">${d.arc.ladder.map(stageRow).join('')}</div>
      <button class="btn" id="stage-add" style="margin-top:8px">+ Add a stage</button>

      <div class="sec-head">Who is hard to reach</div>
      <div class="why" style="margin:-4px 0 8px">Per person. Only slows getting closer — nobody takes longer to be hurt.</div>
      ${d.people.map((p) => `
        <div class="dial" data-rel="${esc(p.id)}">
          <div class="dial-top">
            <label>${esc(p.name)}</label>
            <span class="dial-val" data-relval="${esc(p.id)}">${esc(RELUCTANCE_WORDS(p.reluctance))}</span>
          </div>
          <input type="range" min="0" max="100" step="5" value="${Math.round(p.reluctance * 100)}">
        </div>`).join('')}

      ${d.standing.length ? `
        <div class="sec-head">Where they stand right now</div>
        ${d.standing.map(standingRow).join('')}
        <div class="why" style="margin-top:8px">Measured from ${num(d.messages)} messages of this story.</div>
      ` : `
        <div class="sec-head">Where they stand right now</div>
        <div class="why">Nothing recorded yet. This fills in as the story runs.</div>`}
    </div>

    <div class="sheet-actions">
      <button class="btn quiet" data-back>Back</button>
      <button class="btn primary" id="arc-save">Save</button>
    </div>`, (root) => {
    wirePicker(root);

    const arcOn = $('#arc-on', root);
    arcOn.addEventListener('click', () => {
      const next = arcOn.getAttribute('aria-pressed') !== 'true';
      arcOn.setAttribute('aria-pressed', String(next));
      $('#arc-rest', root).hidden = !next;
    });

    $('#stages', root).addEventListener('click', (e) => {
      const drop = e.target.closest('.stage-drop');
      if (!drop) return;
      if ($$('.stage', root).length <= 2) { toast('A ladder needs at least two stages.'); return; }
      drop.closest('.stage').remove();
      renumber(root);
    });

    $('#stage-add', root).addEventListener('click', () => {
      const n = $$('.stage', root).length;
      $('#stages', root).insertAdjacentHTML('beforeend', stageRow({ name: '', note: '' }, n));
    });

    root.addEventListener('input', (e) => {
      const dialEl = e.target.closest('[data-rel]');
      if (!dialEl) return;
      const v = Number(e.target.value) / 100;
      $(`[data-relval="${CSS.escape(dialEl.dataset.rel)}"]`, root).textContent = RELUCTANCE_WORDS(v);
    });

    $('#arc-save', root).addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        // Names and descriptions only. The thresholds and waiting times are
        // worked out from how many stages there are, so nobody types a number.
        const ladder = $$('.stage', root)
          .map((el) => ({
            name: $('.stage-name', el).value.trim(),
            note: $('.stage-note', el).value.trim(),
          }))
          .filter((r) => r.name);
        const reluctance = {};
        for (const el of $$('[data-rel]', root)) {
          const v = Number($('input', el).value) / 100;
          if (v > 0) reluctance[el.dataset.rel] = v;
        }
        const pace = Number($('.pick-opt[aria-pressed="true"]', root)?.dataset.id || 1);
        const r = await post(`/api/stories/${sid}/arc`, {
          arc: { on: arcOn.getAttribute('aria-pressed') === 'true', pace, ladder, reluctance },
        });
        state.story = await get(`/api/stories/${sid}`);
        const moved = (r.standing || []).filter((s) => s.rung > 0);
        toast('Saved.', {
          kind: 'good',
          sub: moved.length ? `${titleCase(moved[0].a)} and ${titleCase(moved[0].b)} are at "${moved[0].stage}".` : '',
        });
        goBack();
      } catch (err) {
        toast(err.message, { kind: 'bad' });
      } finally { btn.disabled = false; }
    });
  });
}

function renumber(root) {
  $$('.stage', root).forEach((el, i) => { $('.stage-num', el).textContent = String(i + 1); });
}
const titleCase = (s) => {
  const t = String(s || '');
  if (t === 'user' || t === 'you') return 'You';
  return t.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
};

// ----------------------------------------------------------------- secrets

async function panelSecrets() {
  const sid = state.story.id;
  const d = await get(`/api/stories/${sid}/arc`);
  const on = d.secrets.on !== false;

  subSheet('What stays hidden', `
    ${backRow()}

    <div class="why" style="margin-bottom:12px">
      When somebody is actively hiding something, writing it into every prompt is how it slips out.
      Instead the app checks each turn whether the scene has actually reached it. If not, the AI is told only
      that the person is carrying something, never what.
    </div>

    <div class="switch-row">
      <div class="switch-main">
        <div class="switch-title">Hold secrets back until the scene reaches them</div>
        <div class="switch-why">Costs one short extra check before each reply. It fails closed: if the check cannot run, nothing opens.</div>
      </div>
      <button class="switch" id="sec-on" aria-pressed="${on}"></button>
    </div>

    <div class="sec-head">What opens a secret</div>
    <div class="why">
      Someone asks directly. Evidence turns up where it can be seen. The person holding it decides to tell.
      Someone who does not know says something that lands on it exactly.<br><br>
      What does <b>not</b> open it: the subject coming up in passing, the holder being tense about it,
      the mood being right for a confession, or it having been hidden a long time.
    </div>

    <div class="sheet-actions">
      <button class="btn quiet" data-back>Back</button>
      <button class="btn primary" id="sec-save">Save</button>
    </div>`, (root) => {
    const secOn = $('#sec-on', root);
    secOn.addEventListener('click', () => {
      secOn.setAttribute('aria-pressed', String(secOn.getAttribute('aria-pressed') !== 'true'));
    });
    $('#sec-save', root).addEventListener('click', async () => {
      await post(`/api/stories/${sid}/arc`, { secrets: { on: secOn.getAttribute('aria-pressed') === 'true' } });
      await refreshStory();
      toast('Saved.', { kind: 'good' });
      goBack();
    });
  });
}

// ------------------------------------------------------------- appearance

async function panelLook() {
  const L = look();
  const assets = (await get(`/api/stories/${state.story.id}/assets`).catch(() => ({ assets: [] }))).assets
    .filter((a) => a.kind === 'background');

  const LAYOUTS = [
    { id: 'prose', title: 'A novel', sub: 'Nothing but the writing. Your lines set apart in italics.' },
    { id: 'portraits', title: 'Prose with faces', sub: 'The same, with a portrait beside whoever is speaking.' },
    { id: 'bubbles', title: 'Messages', sub: 'Chat bubbles, yours on the right.' },
  ];
  const WEATHER = [
    { id: 'none', title: 'Still' }, { id: 'rain', title: 'Rain' },
    { id: 'snow', title: 'Snow' }, { id: 'dust', title: 'Dust in the light' },
    { id: 'embers', title: 'Embers' },
  ];

  subSheet('How it looks', `
    ${backRow()}

    <div class="sec-head">Shape of the page</div>
    ${picker(LAYOUTS, { multi: false, selected: new Set([L.layout]) })}

    <div class="sec-head">Behind the story</div>
    <div class="why" style="margin:-4px 0 8px">A picture for this story. It is never sent to the AI and never leaves your computer.</div>
    <div class="swatches" id="bg-swatches">
      <button class="swatch${L.background ? '' : ' is-on'}" data-bg="">None</button>
      ${assets.map((a) => `
        <button class="swatch${L.background === a.id ? ' is-on' : ''}" data-bg="${esc(a.id)}"
          style="background-image:url(${esc(a.url)})" title="${esc(a.name || 'background')}"></button>`).join('')}
      <button class="swatch add" id="bg-add">+ Add</button>
    </div>

    ${dial({ key: 'dim', label: 'How far back the picture sits', min: 0, max: 95, step: 5, value: L.dim,
      why: 'All the way up and the picture is a hint. All the way down and it fights the words.',
      ends: ['bold', 'barely there'], format: (v) => `${v}%` })}

    ${dial({ key: 'fontSize', label: 'Text size', min: 80, max: 150, step: 5, value: L.fontSize,
      why: 'Only the story. Everything else stays put.', ends: ['small', 'large'], format: (v) => `${v}%` })}

    <div class="sec-head">Weather</div>
    <div class="why" style="margin:-4px 0 8px">Drifts over the picture. Stops on its own when you switch away, and never runs if your phone is set to reduce motion.</div>
    ${picker(WEATHER, { multi: false, selected: new Set([L.ambient]) })}

    <div class="sheet-actions">
      <button class="btn quiet" data-back>Back</button>
      <button class="btn primary" id="apply">Save</button>
    </div>`, (root) => {
    wirePicker(root);
    wireDials(root);

    let background = L.background;
    const swatches = $('#bg-swatches', root);

    // Everything previews live, because you cannot judge a background from
    // a description of it.
    const preview = () => {
      const picks = $$('.pick', root);
      const layout = picked(picks[0])[0] || L.layout;
      const weather = picked(picks[1])[0] || L.ambient;
      const dials = readDials(root);
      state.story.settings.look = { ...L, layout, ambient: weather, background, ...dials };
      applyLook();
    };
    root.addEventListener('change', preview);
    $$('.dial input', root).forEach((i) => i.addEventListener('input', preview));

    swatches.addEventListener('click', async (e) => {
      const add = e.target.closest('#bg-add');
      if (add) { pickBackground(); return; }
      const sw = e.target.closest('[data-bg]');
      if (!sw) return;
      background = sw.dataset.bg || null;
      $$('.swatch', swatches).forEach((s) => s.classList.toggle('is-on', s === sw));
      preview();
    });

    $('#apply', root).addEventListener('click', async () => {
      const picks = $$('.pick', root);
      const next = {
        ...L,
        layout: picked(picks[0])[0] || L.layout,
        ambient: picked(picks[1])[0] || L.ambient,
        background,
        ...readDials(root),
      };
      await applySettings({ look: next });
      applyLook();
      toast('Saved.', { kind: 'good' });
      closeSheet(); openStorySettings();
    });
  }, openStorySettings);
}

/** Take a picture from the phone, shrink it, keep it with the story. */
function pickBackground() {
  bgTarget = true;
  $('#bg-input').click();
}
let bgTarget = false;

$('#bg-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file || !bgTarget) return;
  bgTarget = false;
  try {
    const blob = await shrinkToBlob(file, 1600);
    const r = await fetch(`/api/stories/${state.story.id}/assets`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type, 'X-Kind': 'background', 'X-Filename': encodeURIComponent(file.name) },
      body: blob,
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'That picture could not be saved.');
    const saved = await r.json();
    await applySettings({ look: { ...look(), background: saved.id } });
    applyLook();
    toast('Background set.', { sub: `${Math.round(saved.size / 1024)} kB`, kind: 'good' });
    closeSheet();
    panelLook();
  } catch (err) {
    toast(err.message, { kind: 'bad' });
  }
});

/** A phone photo is several megabytes. This is a couple of hundred kilobytes. */
function shrinkToBlob(file, maxWide = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxWide / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => {
        if (b) resolve(b);
        else c.toBlob((j) => (j ? resolve(j) : reject(new Error('That picture could not be read.'))), 'image/jpeg', 0.86);
      }, 'image/webp', 0.86);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image we can read.')); };
    img.src = url;
  });
}

// ========================================================================
// Understanding a source: read what Nexus worked out, then save what you agree
// with. Nothing here decides anything on its own, and saving never changes the
// entries themselves — only what they are understood to mean.
// ========================================================================

const review = {
  bookId: null, draft: null, entries: new Map(), entities: new Map(), role: null, matches: new Map(),
  // What needs attention is open on arrival, because it is the reason to read
  // the rest slowly.
  open: new Set(['attention', 'decision']), saving: false, changingRole: false,
  // A closer look lives here and nowhere else: suggestions belong to this draft,
  // are never semantics, and go when the review is closed.
  suggestions: new Map(), looking: new Set(), trouble: new Map(), spent: [],
  // Which entry cards are open. Held here rather than in the DOM alone, so a
  // card you opened is still open after the screen redraws under you.
  opened: new Set(),
  // What is leaning on a saved reading somebody is about to change, read once
  // per entry when they ask to change it.
  impact: new Map(),
  // Which model answered a closer look, so a reading taken from it says so.
  model: null,
};

const CATEGORY_LABEL = {
  identity: 'Identity', appearance: 'Appearance', personality: 'Personality', speech: 'Speech',
  behavior: 'Behaviour', backstory: 'Backstory', psychology: 'Psychology', relationship: 'Relationships',
  secret: 'Secrets', goal: 'Goals', skill: 'Skills', ability: 'Abilities', equipment: 'Equipment',
  belief: 'Beliefs', habit: 'Habits', profile: 'Profile', background: 'Background', rule: 'Rules',
  event: 'Events', item: 'Items', direction: 'Directives', reference: 'Reference', other: 'Other',
};
const PERSON_CATEGORY = ['identity', 'appearance', 'personality', 'speech', 'behavior', 'backstory', 'psychology',
  'relationship', 'secret', 'goal', 'skill', 'ability', 'equipment', 'belief', 'habit', 'profile'];
const ROLE_LABEL = {
  'entity-material': 'Mostly about one person or place',
  world: 'World information',
  scenario: 'A scenario or starting situation',
  'story-package': 'A complete story setup',
  'narrative-framework': 'Rules for how the story should be narrated',
  'reference-pack': 'Reference knowledge, used when it comes up',
  mixed: 'A mixture of different material',
};

/**
 * How strong a reading is, in four steps. These are the analyser's own terms
 * and no longer appear on the screen: what a reader sees is what is left for
 * them to do. This still decides that, and nothing about it has changed.
 */
const bucketOf = (d) => {
  if (!isSettled(d)) return d.candidates?.length >= 2 ? 'decision' : 'unsorted';
  if (d.confidence === 'high') return 'clear';
  if (d.confidence === 'medium') return 'likely';
  return d.candidates?.length >= 2 ? 'decision' : 'unsorted';
};
/**
 * The screen is organised by what is left for you to do, not by how sure the
 * analyser is. Those are different questions, and only the first one is yours.
 *
 * Nothing here decides anything. Every entry lands in one of three places by
 * reading what the analyser already said about it — its confidence, whether it
 * settled on a subject, whether it names somebody this source never describes.
 * The confidence system underneath is untouched; it is the input to this, and
 * HIGH/MEDIUM/LOW are not words a reader should need.
 */
const GROUP = {
  sorted: {
    title: 'Sorted',
    why: 'Nexus decided these, and they will be saved. Open any one to look at it, or take it out.',
  },
  needs: {
    title: 'Needs you',
    why: 'Nexus will not decide these for you. Leaving any of them for later is a real answer.',
  },
  optional: {
    title: 'Optional',
    why: 'Weaker suggestions. Use the ones you like; skipping them is fine.',
  },
};

/** Which of the three an entry belongs to. */
const groupOf = (d) => {
  if (d.current === 'approved' || d.approve) return 'sorted';
  const b = bucketOf(d);
  if (b === 'decision' || b === 'unsorted') return 'needs';
  // Strong evidence about somebody that Nexus deliberately would not act on by
  // itself: it says something about a person rather than introducing them, and
  // which part of them it belongs to is a judgement. A strong reading of
  // material that is nobody's asks no such question — it is simply a suggestion
  // nothing can accept on your behalf, so it waits with the others.
  if (d.confidence === 'high' && d.scope === 'entity') return 'needs';
  // An entry naming somebody this source never describes is a real question
  // however sure the rest of the reading is — and the answer is not always the
  // same one, so it is never answered here.
  if ((d.namedButUnknown || []).length) return 'needs';
  return 'optional';
};

/**
 * What a "needs you" entry is actually asking, which is the thing to put on the
 * card. Three questions cover every one of them, and each maps to an operation
 * the semantic model already has — except the third, which is honest about not
 * being expressible yet rather than offering a near-miss in its place.
 */
const askOf = (d) => {
  if ((d.namedButUnknown || []).length) return 'named';
  if (d.confidence === 'high') return 'confirm';
  return 'about';
};
const ASK = {
  about: {
    title: 'About a person, or general material?',
    why: 'Often the answer is that they are not about anybody in particular.',
  },
  named: {
    title: 'Names somebody this source never describes',
    why: 'Each mentions a name this source never establishes. What that means differs every time, so Nexus does not suggest an answer.',
  },
  confirm: {
    title: 'Confirm one reading',
    why: 'Read clearly, and still not accepted on your behalf.',
  },
};

/** Where an optional suggestion goes, so 109 of them are three groups and not one list. */
const optionalGroupOf = (d) => (d.category === 'direction' ? 'told' : d.subject ? 'people' : 'world');
const OPTIONAL_GROUP = {
  told: 'How the story is told',
  people: 'About named people',
  world: 'The world and events',
};

/**
 * Saying that an entry is what introduces something.
 *
 * Only ever a person's own decision. Nothing proposes it, nothing derives it
 * from a name the source failed to establish, and nothing about the entry's
 * shape brings it about — two real entries carry the same unresolved name and
 * need opposite answers, so the only safe author of this is somebody who read
 * the entry.
 *
 * Defining something IS its profile, so the category follows rather than being
 * left to drift: an entry cannot both introduce somebody and be a note about
 * their personality. Apply refuses an entry that both defines something and is
 * about something, so the subject goes with it.
 */
function setDefines(d, ref) {
  if (d.category !== 'profile') d.categoryWas = d.category;
  d.scope = 'entity';
  d.defines = ref;
  d.subject = null;
  d.category = 'profile';
  d.related = d.related.filter((r) => r !== ref);
  d.proposedBy = 'manual';
  d.editedContent = true;
  d.approve = true;
}

/** The same name, written the same way. Nothing fuzzier: two spellings are two things. */
const sameEntityName = (a, b) => String(a || '').trim().toLowerCase().replace(/\s+/g, ' ')
  === String(b || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * A ref for something made here, in the form the rest of Nexus uses, unique
 * against everything this review can see — what the analyser proposed and what
 * the source declared before. A ref is how Apply recognises something it has
 * already made, so two of them colliding would quietly become one thing.
 */
const refFor = (name) => {
  const base = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'thing';
  let ref = base;
  for (let n = 2; review.entities.has(ref); n++) ref = `${base}-${n}`;
  return ref;
};

/**
 * Where a decision was made, so the card does not simply vanish from under the
 * finger that made it.
 *
 * Deciding moves an entry into Sorted, and Sorted is shut, so the thing being
 * worked on disappeared with no word about what had been understood. Nothing
 * about the decision changes here: this remembers only which entry it was and
 * which group it was standing in, so the same decision can be drawn for a
 * moment where it was made. One decision, one entry, two views of it.
 *
 * Taken before the reading changes, because afterwards it belongs elsewhere.
 */
function pinDecision(d) {
  const group = groupOf(d);
  if (group !== 'needs' && group !== 'optional') { review.justDecided = null; return; }
  review.justDecided = {
    ref: d.ref,
    group,
    key: group === 'needs' ? askOf(d) : optionalGroupOf(d),
    editing: false,
  };
}

/** Something of this name and kind this review already has, if there is one. */
const entityLike = (name, type) => [...review.entities.values()]
  .find((x) => x.type === type && sameEntityName(x.name, name)) || null;

/**
 * The reading itself, in a reader's words, as it stands right now.
 *
 * This is what makes a decision visible the moment it is made: choose general
 * world material and the line says so, including the category it was recorded
 * under, because that choice can change it.
 */
const readingLabel = (d) => {
  if (!isSettled(d)) return '';
  const cat = CATEGORY_LABEL[d.category] || d.category;
  if (d.defines) return `Describes ${entityName(d.defines)}`;
  if (d.scope !== 'entity') return `World information · ${cat}`;
  return `About ${entityName(d.subject)} · ${cat}`;
};

const TYPE_LABEL = { person: 'Person', place: 'Place', faction: 'Group', item: 'Thing', event: 'Event', concept: 'Idea' };
const TYPE_SECTION = { person: 'People', place: 'Places', faction: 'Groups', item: 'Things', event: 'Events', concept: 'Ideas' };

/**
 * What Nexus noticed and could not settle, in a reader's words.
 *
 * The analyser says a great deal to itself. Most of it is already the shape of
 * this screen — an entry it cannot read is in "Need your decision", versions of
 * one thing have their own section. What is left is the part a person would want
 * told: a word doing two jobs, an old link the text does not support, several
 * profiles that may not be one person, a stored kind that contradicts the
 * reading, a subject nothing settles.
 *
 * Variant groups are deliberately left out. They have a section of their own,
 * and counting 22 of them here would make the number mean nothing.
 */
const ATTENTION = {
  'name-collision': 'One name, two different things',
  'possibly-separate': 'May not be the same one',
  'legacy-link-unsupported': 'An old link the text does not support',
  'kind-disagrees': 'Stored as one kind of thing, reads as another',
  'subject-unresolved': 'Who this is about is unsettled',
  'subject-unknown-name': 'Names somebody this source does not describe',
};

function attentionItems() {
  const seen = new Set();
  const out = [];
  for (const w of review.draft?.warnings || []) {
    const title = ATTENTION[w.code];
    if (!title) continue;
    // One line per thing, not per warning: the same entry flagged twice is
    // still one thing to look at.
    const key = `${w.code}:${(w.entries || w.entities || []).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ code: w.code, title, message: w.message, entries: w.entries || [], entities: w.entities || [] });
  }
  return out;
}
/** What a warning says about one entry, so its own card can say it too. */
const attentionFor = (ref) => attentionItems().filter((a) => a.entries.includes(ref));

const entityName = (ref) => review.entities.get(ref)?.name || ref;
const isSettled = (d) => d.scope !== 'entity' || !!d.subject || !!d.defines;
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

/**
 * One candidate you can choose.
 *
 * A tick means this reading will be saved, and it means that nowhere else and
 * nothing else. What the analyser proposed is a different fact: it is shown,
 * because hiding it would be worse, but it is shown as a reading Nexus arrived
 * at and not as an answer somebody gave. A proposal wearing a tick is a
 * proposal claiming to be a decision, and on a card that says "nothing to save
 * yet" the two cannot both be true.
 */
const choiceChip = (entryRef, entityRef, label, selected, suggested = false) => `<button class="chip-tag rv-choice${suggested && !selected ? ' rv-suggested' : ''}" data-subject="${esc(entryRef)}" data-entity="${esc(entityRef)}" aria-pressed="${!!selected}">${selected ? '<span class="rv-check" aria-hidden="true">✓</span>' : ''}${esc(label)}${suggested && !selected ? ' <span class="rv-sug">Nexus’s reading</span>' : ''}</button>`;

/**
 * There is no action anywhere that accepts a group of suggestions at once.
 *
 * What Nexus is willing to decide is already ticked when the screen opens, so
 * any such button could only ever sweep up readings it deliberately withheld —
 * and sharing a category is not evidence that a hundred of them are right. A
 * weaker suggestion is used one at a time, on its own card, by somebody who
 * looked at it.
 */

/** How many entries one press of "Help with these" may ask about. */
const HELP_AT_ONCE = 12;
/**
 * A section of unresolved material may be handed to the model together, in one
 * deliberate press. Nothing here happens on its own.
 */
const sectionHelp = (s) => {
  if (!s.help?.length) return '';
  const n = Math.min(s.help.length, HELP_AT_ONCE);
  return `<div class="rv-look" style="margin-top:10px">
    <button class="btn quiet" data-help="${esc(s.id)}">Help with ${n === s.help.length ? 'these' : `${num(n)} of these`} ${n === 1 ? 'entry' : 'entries'}</button>
    <span class="rv-hint-inline">Asks your AI provider to read ${n === 1 ? 'it' : 'them'} again.</span>
  </div>`;
};

/** Open the review for one source. Reading it writes nothing. */
async function openSourceReview(bookId) {
  review.bookId = bookId;
  subSheet('Understanding this source', `${backRow()}<div class="empty">Reading this source…</div>`, null, () => openLorebook(bookId));
  let draft;
  try {
    draft = await post(`/api/lorebooks/${bookId}/semantic-preview`, {});
  } catch (err) {
    sheet('Understanding this source', `${backRow()}<div class="empty">${esc(err.message || 'That source could not be read.')}</div>`);
    return;
  }
  review.draft = draft;
  // The entries' own words, so a decision can be made by reading the thing
  // rather than by reading what Nexus thinks of it. The source screen already
  // has them; if the review was reached some other way, they are fetched once.
  // Without them the cards simply show no excerpt.
  let cards = lore.book?.id === bookId ? lore.book : null;
  if (!cards) { try { cards = await get(`/api/lorebooks/${bookId}/cards`); } catch { cards = null; } }
  review.excerpt = new Map(Object.values(cards?.groups || {}).flat().map((c) => [c.id, c.summary || '']));
  // Read-only, and nothing to do with the analysis: who this source has said
  // it is about before. Without it a person made here could only ever be used
  // once, because reading the source again will not rediscover them.
  let declarations = [];
  try { declarations = await get(`/api/lorebooks/${bookId}/declarations`); } catch { declarations = []; }
  // Nothing about a new entity is being drafted when the screen opens, and no
  // decision is waiting to be acknowledged from a previous visit.
  review.definingNew = new Set();
  review.justDecided = null;
  // What needs deciding is the one thing open when the screen arrives.
  review.open = new Set(['needs']);
  review.changingRole = false;
  // The deterministic pass named these people. Retyping a name, changing a type,
  // or saying somebody is one Nexus already knows makes the declaration a
  // person's, and it is stored as one.
  review.entities = new Map(draft.entities.map((x) => [x.ref, { ...x, decision: 'new', proposedBy: 'deterministic-conversion' }]));
  // What this source has already declared, whether or not reading it again
  // would suggest the same. Somebody said so once; that is a fact of its own,
  // and it must not have to be said twice. These are not readings, so they are
  // never shown as something Nexus thinks — they are simply available.
  for (const dec of declarations) {
    if (review.entities.has(dec.ref)) continue;
    if (entityLike(dec.name, dec.type)) continue;
    review.entities.set(dec.ref, {
      ref: dec.ref, type: dec.type, name: dec.name, aliases: dec.aliases || [],
      decision: 'existing', entityId: dec.entityId, declared: true,
      proposedBy: 'manual', evidence: [], profileEntries: [], mentionedIn: 0, subjectOf: 0,
      confidence: null, nameSharedWith: [], mayBeSeveral: false,
    });
  }
  // Which entries the original file called one kind of thing and Nexus reads as
  // another. Only a real disagreement counts: a "character" entry that turns out
  // to be a faction, or a note that is really a place. A "character" entry that
  // holds someone's backstory is not a disagreement, and flagging it is noise.
  const KIND_TYPE = { character: 'person', place: 'place', faction: 'faction', item: 'item', event: 'event' };
  const typeOfEntity = (ref) => draft.entities.find((x) => x.ref === ref)?.type;
  const disagrees = (e) => {
    const stored = KIND_TYPE[e.storedKind];
    if (e.proposal.defines) return stored !== typeOfEntity(e.proposal.defines);
    return !!stored && e.proposal.scope !== 'entity';
  };
  const reclassified = new Set(draft.entries.filter((e) => e.proposal && disagrees(e)).map((e) => e.ref));
  review.entries = new Map(draft.entries.filter((e) => e.proposal).map((e) => [e.ref, {
    ...e.proposal,
    ref: e.ref, entryId: e.entryId, hash: e.hash, title: e.title, confidence: e.confidence,
    storedKind: e.storedKind, activation: e.activation, evidence: e.evidence, unresolved: e.unresolved,
    // Somebody the entry names where its subject goes, whom this source never
    // describes. Display only: it changes nothing about the proposal, and the
    // candidate Nexus could name stays exactly where it was.
    namedButUnknown: e.namedButUnknown || [],
    current: e.current, phase: e.phase, reclassified: reclassified.has(e.ref),
    // The people Nexus actually weighed for this entry, best first: those are the
    // choices that go in front of you. Everyone else is a deliberate search away.
    candidates: (e.subjectCandidates || []).map((c) => c.entity),
    suggested: e.proposal.subject || null,
    // Why this reading is worth your eye even though the evidence is strong.
    // Being sure of a reading and being willing to accept it for you are two
    // different things, and this is the second one.
    reviewRisk: e.reviewRisk || null,
    // Only what Nexus is sure of — and willing to decide for you — starts
    // ticked. Everything else waits, which is not the same as being wrong.
    // The rule itself lives with the reading that produced it.
    approve: !!e.autoSelect,
    // How this reading was arrived at. It changes when a person edits it, and
    // when they take a model's suggestion, and it is stored either way — the
    // approval is always theirs, but what they approved has a history.
    proposedBy: 'deterministic-conversion',
    // What the person did here, which is a different question from who produced
    // the reading. Both are recorded because neither implies the other: a
    // deterministic reading can be one somebody sought out, and a model's
    // suggestion can be one they took without changing a word.
    //
    // Only these two facts are tracked, and only when they happen. Everything
    // else is derived at save time, because a final tick cannot tell you whether
    // it was ever unticked.
    reselected: false,   // they changed this entry's own selection
    editedContent: false, // they changed what the reading says
  }]));
  // Nothing is asked of any model by opening this screen.
  review.suggestions = new Map();
  review.looking = new Set();
  review.trouble = new Map();
  review.spent = [];
  review.opened = new Set();
  review.role = {
    role: draft.source.proposedRole.role,
    subject: draft.source.proposedRole.subject,
    proposedBy: 'deterministic-conversion',
  };
  review.matches = new Map(draft.matches.map((m, i) => [`${m.entity}:${i}`, { ...m, decision: 'later' }]));
  renderReview();
}

function reviewCounts() {
  const list = [...review.entries.values()];
  const of = (name) => list.filter((d) => groupOf(d) === name).length;
  return {
    total: review.draft.entries.length,
    sorted: of('sorted'),
    needs: of('needs'),
    optional: of('optional'),
    // What Save would write, which is not the same as what Nexus sorted: an
    // entry already saved is not written again.
    ready: list.filter((d) => d.approve && d.current !== 'approved').length,
    already: list.filter((d) => d.current === 'approved').length,
  };
}

/**
 * The people and places Save would record, counted from what is actually
 * ticked. Only entities a ticked entry leans on are ever created.
 */
function reviewEntityCount() {
  const used = new Set();
  for (const d of review.entries.values()) {
    if (!d.approve || d.current === 'approved') continue;
    for (const ref of [d.defines, d.subject, ...(d.related || [])].filter(Boolean)) used.add(ref);
  }
  const byType = new Map();
  for (const ref of used) {
    const t = review.entities.get(ref)?.type;
    if (t) byType.set(t, (byType.get(t) || 0) + 1);
  }
  return { total: used.size, byType };
}

/**
 * What the source is mostly made of, said in words. The counting behind it is
 * unchanged and still on show under "Why Nexus says this"; percentages are
 * evidence, not the thing you read first.
 */
function roleSummary() {
  const counts = new Map();
  for (const d of review.entries.values()) {
    if (!isSettled(d)) continue;
    const who = d.defines || d.subject;
    if (who) counts.set(`information about ${entityName(who)}`, (counts.get(`information about ${entityName(who)}`) || 0) + 1);
    else {
      const label = d.category === 'direction' ? 'instructions for how the story is told'
        : d.category === 'reference' ? 'reference knowledge' : 'world information';
      counts.set(label, (counts.get(label) || 0) + 1);
    }
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (!total) return 'Nexus could not tell what most of it is for.';
  // Only the parts big enough to be worth naming, and never more than three.
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).filter(([, n]) => n / total >= 0.08).slice(0, 3);
  const names = top.map(([label]) => label);
  if (names.length === 1) return `Mostly ${names[0]}.`;
  const last = names.pop();
  return `Mostly ${names.join(', ')}, and some ${last}.`;
}

function renderReview() {
  const d = review.draft;
  const c = reviewCounts();
  const role = review.role;
  const sections = [];
  // What a closer look could still be asked about here.
  const unasked = (rows) => rows.filter((x) => !review.suggestions.has(x.ref) && !review.looking.has(x.ref)).map((x) => x.ref);

  // Three groups, by what is left for you to do. What the analyser could not
  // settle is no longer a feed of its own: each warning is said on the card of
  // the entry it is about, under "Why Nexus is asking", where it can be acted
  // on instead of read twice.
  const all = [...review.entries.values()];
  const inGroup = (name) => all.filter((x) => groupOf(x) === name);
  const pin = review.justDecided;
  // While a decision is being shown where it was made, it is not also drawn as
  // a row in Sorted. One entry, one place on the screen.
  const sorted = inGroup('sorted').filter((x) => !pin || x.ref !== pin.ref);
  const needs = inGroup('needs');
  const optional = inGroup('optional');

  if (sorted.length) {
    const already = sorted.filter((x) => x.current === 'approved').length;
    sections.push({
      id: 'sorted',
      title: GROUP.sorted.title,
      n: sorted.length,
      why: already === sorted.length ? 'Already saved. Nothing here is waiting on you.'
        : already ? `${plural(already, 'of these was', 'of these were')} already saved; the rest will be saved when you do.`
          : GROUP.sorted.why,
      // One line each, collapsed. Twenty full cards is not a summary of
      // twenty things Nexus got right.
      rows: sorted.map((x) => entryCard(x, { compact: true })),
    });
  }

  const pinnedIn = (group, key) => (pin && pin.group === group && pin.key === key ? decidedCard() : '');
  if (needs.length || (pin && pin.group === 'needs')) {
    const asks = new Map();
    for (const x of needs) asks.set(askOf(x), [...(asks.get(askOf(x)) || []), x]);
    // The question a decision was made under stays on screen for it, even when
    // it was the last one left there.
    if (pin && pin.group === 'needs' && !asks.has(pin.key)) asks.set(pin.key, []);
    sections.push({
      id: 'needs',
      title: GROUP.needs.title,
      n: needs.length,
      why: GROUP.needs.why,
      rows: [...asks.entries()].map(([ask, rows]) => `
        <div class="rv-ask" data-ask="${esc(ask)}">
          <div class="rv-ask-head"><b>${esc(ASK[ask].title)}</b><span class="n">${num(rows.length)}</span></div>
          <div class="why">${esc(ASK[ask].why)}</div>
          ${sectionHelp({ id: `ask-${ask}`, help: unasked(rows) })}
          ${rows.map((x) => entryCard(x, { choose: true, ask })).join('')}
          ${pinnedIn('needs', ask)}
        </div>`),
    });
  }

  if (optional.length || (pin && pin.group === 'optional')) {
    const groups = new Map();
    for (const x of optional) groups.set(optionalGroupOf(x), [...(groups.get(optionalGroupOf(x)) || []), x]);
    if (pin && pin.group === 'optional' && !groups.has(pin.key)) groups.set(pin.key, []);
    sections.push({
      id: 'optional',
      title: GROUP.optional.title,
      n: optional.length,
      why: GROUP.optional.why,
      // Deliberately no action that accepts a whole group. Sharing a category
      // is not evidence that a hundred readings are right, and a button that
      // said otherwise would undo the care taken over what arrives ticked.
      // Each shut until it is asked for. Opening Optional should show you what
      // is in it, not a hundred and nine cards.
      rows: [...groups.entries()].map(([key, rows]) => {
        const id = `opt-${key}`;
        // A group holding a decision waiting to be acknowledged stays open for
        // it, however it was left.
        const open = review.open.has(id) || !!(pin && pin.group === 'optional' && pin.key === key);
        return `
        <div class="edit-card" data-section="${esc(id)}" data-optional="${esc(key)}">
          <div class="edit-head"><b>${esc(OPTIONAL_GROUP[key])}</b><span class="n">${num(rows.length)}</span>
            <button class="fold" aria-expanded="${open}">▾</button></div>
          <div class="edit-body"${open ? '' : ' hidden'}>${open
    ? rows.map((x) => entryCard(x, { compact: true })).join('') : ''}${pinnedIn('optional', key)}</div>
        </div>`;
      }),
    });
  }

  // Everything else Nexus worked out, kept but out of the way: who it found,
  // what it thinks may be two copies of one thing, and what may already exist
  // elsewhere. None of it is a decision waiting on you.
  const extra = [];
  for (const type of ['person', 'place', 'faction', 'item', 'event', 'concept']) {
    const found = d.entities.filter((x) => review.entities.get(x.ref).type === type);
    if (found.length) extra.push(`<div class="sec-head">${esc(TYPE_SECTION[type])} · ${num(found.length)}</div>${found.map(entityCard).join('')}`);
  }
  if (d.variantGroups.length) extra.push(`<div class="sec-head">Versions of the same thing · ${num(d.variantGroups.length)}</div>${d.variantGroups.map(variantCard).join('')}`);
  const matches = [...review.matches.entries()];
  if (matches.length) extra.push(`<div class="sec-head">Possibly the same elsewhere · ${num(matches.length)}</div>${matches.map(([key, m]) => matchCard(key, m)).join('')}`);
  if (extra.length) {
    sections.push({
      id: 'found',
      title: 'People and places in this source',
      n: d.entities.length,
      why: 'Who and what Nexus recognised while reading. Change a name or what something is here, or say it is somebody you already have.',
      rows: extra,
    });
  }

  const html = `
    ${backRow()}
    <div class="rv-summary">
      <div class="rv-source">${esc(d.source.name)} · ${num(c.total)} entries</div>
      <div class="rv-said">Nexus thinks this is:</div>
      <div class="rv-role"><b>${esc(ROLE_LABEL[role.role])}</b>${role.role === 'entity-material' && role.subject ? `, mostly ${esc(review.entities.get(role.subject).name)}` : ''}</div>
      <div class="why">${esc(roleSummary())}</div>
      ${/* The scoring that produced this is evidence, not the headline. */''}
      <div class="rv-verdict-row">
        <details class="rv-why"><summary>Why Nexus says this</summary>
          ${d.source.proposedRole.evidence.map((v) => `<div class="fired-row"><span class="t">${esc(v.detail)}</span></div>`).join('')}
        </details>
        <button class="btn quiet" id="rv-change-role">${review.changingRole ? 'Keep this' : 'Change'}</button>
      </div>
      ${review.changingRole ? `
        <div class="field" style="margin-top:10px">
          <label>This source contains</label>
          <select id="rv-role">${Object.entries(ROLE_LABEL).map(([k, label]) => `<option value="${k}"${role.role === k ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>
        </div>
        ${role.role === 'entity-material' ? `
          <div class="field">
            <label>Mostly about</label>
            <select id="rv-role-subject">
              <option value="">Choose someone</option>
              ${d.entities.map((x) => `<option value="${esc(x.ref)}"${role.subject === x.ref ? ' selected' : ''}>${esc(review.entities.get(x.ref).name)}</option>`).join('')}
            </select>
          </div>` : ''}` : ''}
      ${/* Three numbers, and each is a kind of work rather than a degree of
           certainty. Nobody should need to know what "medium" means. */''}
      <div class="rv-tally">
        ${[['sorted', c.sorted], ['needs', c.needs], ['optional', c.optional]]
    .filter(([, n]) => n).map(([k, n]) => `<span class="rv-pip rv-${k}">${num(n)} ${esc(GROUP[k].title.toLowerCase())}</span>`).join('')}
      </div>
      <div class="why">You can save what is ready and come back to the rest. Nothing you leave is lost or changed.</div>
    </div>
    ${/* There is no "accept everything Nexus is sure of" button. What Nexus is
         sure of, and willing to decide for you, is already ticked when this
         screen opens. The strong readings it left unticked are the ones it
         deliberately would not decide — a button that swept them up would be a
         way around the asking, so the asking happens on the card instead. */''}
    ${sections.map((s) => `
      <div class="edit-card" data-section="${esc(s.id)}">
        <div class="edit-head"><b>${esc(s.title)}</b><span class="n">${num(s.n)}</span>
          <button class="fold" aria-expanded="${review.open.has(s.id)}">▾</button></div>
        <div class="edit-body"${review.open.has(s.id) ? '' : ' hidden'}>${review.open.has(s.id)
    ? `${s.why ? `<div class="why">${esc(s.why)}</div>` : ''}${s.rows.join('')}` : ''}</div>
      </div>`).join('')}
    <div class="sheet-actions">
      <button class="btn quiet" data-back>Not now</button>
      ${/* What the button does, with how much it covers beside it: the exact
           breakdown belongs on the confirmation, not on a pinned bar. */''}
      <button class="btn primary" id="rv-save"${c.ready ? '' : ' disabled'}>${c.ready ? `Save ${num(c.ready)}` : 'Nothing to save yet'}</button>
    </div>`;

  sheet('Understanding this source', html, (root) => {
    root.addEventListener('click', onReviewClick);
    root.addEventListener('change', onReviewChange);
  });
}

/**
 * The parts a closer look says it could not settle.
 *
 * It names them itself. If it only said "not all of it", the empty parts are
 * the open ones — which is safe to read that way only because it said so;
 * for a settled reading, an empty subject means "nobody in particular".
 */
function openParts(s) {
  if (s.unresolvedFields?.length) return new Set(s.unresolvedFields);
  if (!s.unresolved) return new Set();
  const open = new Set();
  if (!s.subject && !s.defines) open.add('subject');
  if (!s.category) open.add('category');
  return open;
}

/** The open parts, said as a sentence a person would say. */
function stillOpen(open) {
  const bits = [];
  if (open.has('subject') || open.has('defines')) bits.push('who it is mainly about');
  if (open.has('category')) bits.push('what kind of information it is');
  if (open.has('related')) bits.push('who else is involved');
  if (open.has('displayPath')) bits.push('where it belongs');
  if (!bits.length) return '';
  const last = bits.pop();
  return `Nexus still can’t tell ${bits.length ? `${bits.join(', ')}, or ${last}` : last}.`;
}

/**
 * A closer look at one entry: the offer, the waiting, or what came back.
 *
 * Nothing here is a decision. A suggestion is drawn as something said about the
 * entry, next to the ordinary choice rather than in place of it, and the entry
 * is only ticked when a person accepts it.
 */
function closerLook(d, bucket) {
  const unsettled = bucket === 'decision' || bucket === 'unsorted';
  // Unresolved material is what this is for; a likely reading can be questioned
  // on purpose. Anything Nexus is sure of, or you have already saved, is not offered.
  if (!unsettled && !(bucket === 'likely' && !d.approve)) return '';
  if (d.current === 'approved') return '';

  if (review.looking.has(d.ref)) return '<div class="rv-second waiting"><span class="rv-dot"></span>Looking closer at this…</div>';
  const s = review.suggestions.get(d.ref);
  const trouble = review.trouble.get(d.ref);
  if (!s) {
    return `
      <div class="rv-look">
        <button class="btn quiet" data-look="${esc(d.ref)}">Look closer</button>
        <span class="rv-hint-inline">${trouble ? esc(trouble) : 'Asks your AI provider to read this one entry again.'}</span>
      </div>`;
  }

  const name = (ref) => review.entities.get(ref)?.name || ref;
  const quotes = s.evidence.filter((v) => v.type === 'quote');
  // What it settled, and what it says it could not. A reading is rarely all or
  // nothing, and a part it could not settle must never read as solved.
  const open = openParts(s);
  const kindOf = s.category ? (CATEGORY_LABEL[s.category] || s.category) : '';
  const whose = s.defines ? `${name(s.defines)}’s own entry`
    : s.subject ? `about ${name(s.subject)}`
      : (!s.unresolved && !open.size) ? 'about nobody in particular' : '';
  const settled = kindOf && whose ? `This appears to be <b>${esc(kindOf)}</b>, ${esc(whose)}.`
    : kindOf ? `This appears to be <b>${esc(kindOf)}</b>.`
      : whose ? `This appears to be <b>${esc(whose)}</b>.` : '';
  return `
    <div class="rv-second${s.accepted ? ' taken' : ''}">
      <div class="rv-second-head">A closer look${s.accepted ? ' — you used this' : ''}</div>
      ${settled ? `<div class="rv-second-said">${settled}</div>` : ''}
      ${open.size ? `<div class="rv-second-open">${esc(stillOpen(open))}</div>`
    : s.unresolved ? '<div class="rv-second-open">It could not settle every part of this.</div>' : ''}
      <div class="why">${esc(s.explanation)}</div>
      ${s.related.length ? `<div class="why">Also connected to: ${esc(s.related.map(name).join(', '))}.</div>` : ''}
      ${/* It can say who it thinks is missing, and this screen cannot add them:
           a review decides about the people the source itself named. Said as
           what it is, rather than as an offer that leads nowhere. */''}
      ${s.proposedEntities.length ? `<div class="why">It thinks this source is missing ${esc(s.proposedEntities.map((p) => `${p.name} (${TYPE_LABEL[p.type]?.toLowerCase() || p.type})`).join(', '))}. Nobody new can be added here — organise a source that describes them, and they will exist.</div>` : ''}
      ${quotes.length ? `<details><summary>The words it went on</summary>
        ${quotes.map((v) => `<div class="fired-row"><span class="t">“${esc(v.quote)}”</span></div>`).join('')}
      </details>` : ''}
      ${s.accepted ? '' : `
        <div class="row-actions" style="margin-top:8px">
          ${s.subject || s.defines ? `<button class="btn" data-take="${esc(d.ref)}">Use ${esc(name(s.subject || s.defines))}</button>`
    : s.category ? `<button class="btn" data-take="${esc(d.ref)}">Use what it found</button>`
      : s.related.length ? `<button class="btn" data-take="${esc(d.ref)}">Connect ${esc(name(s.related[0]))}</button>` : ''}
          <button class="btn quiet" data-else="${esc(d.ref)}">${s.subject || s.defines ? 'Choose someone else' : 'Decide it yourself'}</button>
          <button class="btn quiet" data-drop="${esc(d.ref)}">Leave undecided</button>
        </div>`}
    </div>`;
}

/** One entry, said plainly, with everything technical folded away. */
/**
 * Changing a reading you already saved.
 *
 * The entry itself is never at risk — its words, its keywords and when it fires
 * are not part of this screen and are not part of the correction. What can
 * change is who it is about, and that is what this says: what else in this
 * source says the same thing, and who is reading the answer today.
 */
function correctionNote(d) {
  const i = review.impact.get(d.ref);
  const say = [];
  if (i) {
    if (i.person) say.push(`Saved as being about ${i.person.name}.`);
    if (i.depends.lastTie && i.person) say.push(`This is the only entry in this source that says so, so changing it stops this source being about ${i.person.name}.`);
    else if (i.depends.alsoAboutThem) say.push(`${num(i.depends.alsoAboutThem)} other ${i.depends.alsoAboutThem === 1 ? 'entry' : 'entries'} here also say so, so this source stays about them either way.`);
    for (const c of i.depends.cards) say.push(`${c.kind === 'persona' ? 'Someone you play' : 'The character card'} “${c.name}” is them.`);
    if (i.depends.stories.length) say.push(`${i.depends.stories.length === 1 ? 'One story reads' : `${num(i.depends.stories.length)} stories read`} their reusable knowledge: ${i.depends.stories.map((s) => s.title).join(', ')}.`);
    if (i.depends.sources.length) say.push(`${num(i.depends.sources.length)} other ${i.depends.sources.length === 1 ? 'source says' : 'sources say'} they are about them too.`);
  }
  return `<div class="rv-keeps">
    <b>Changing a saved reading</b>
    <span>The entry keeps its words, its keywords and when it fires. Only what it means changes.${say.length ? ` ${esc(say.join(' '))}` : ''}</span>
  </div>`;
}

/**
 * What was just decided, said back where it was decided, and small.
 *
 * Only what somebody needs to check that Nexus understood them: the reading,
 * what kind of thing it is about where that is worth saying, and whose decision
 * it was. No evidence, no scores, no alternatives — those belong to deciding,
 * and this is after. It says "decided", never "saved", because nothing has been
 * written yet.
 */
function decidedCard() {
  const pin = review.justDecided;
  const d = pin && review.entries.get(pin.ref);
  if (!d) return '';
  // Asked to change it: the whole card comes back, in the same place, with
  // every control it had. Nothing is undecided by looking, and there is still
  // a way to say you are finished.
  if (pin.editing) {
    return `${entryCard(d, { choose: true })}
      <div class="row-actions rv-decided-out"><button class="btn" data-done="${esc(d.ref)}">Done</button></div>`;
  }
  const type = d.defines ? review.entities.get(d.defines)?.type : null;
  return `
    <div class="edit-card rv-decided" data-decided="${esc(d.ref)}">
      <div class="rv-said-back">✓ ${esc(readingLabel(d))}<span class="rv-by">Decided by you</span></div>
      ${type ? `<div class="rv-decided-meta">${esc(TYPE_LABEL[type] || type)} · ${esc(CATEGORY_LABEL[d.category] || d.category)}</div>` : ''}
      <div class="row-actions">
        <button class="btn quiet" data-reopen="${esc(d.ref)}">Change this reading</button>
        <button class="btn" data-done="${esc(d.ref)}">Done</button>
      </div>
    </div>`;
}

function entryCard(d, { choose = false, hideCategory = false, hideSubject = false, compact = false, ask = null }) {
  const kind = CATEGORY_LABEL[d.category] || d.category;
  // Inside "What this says about Patrick", every row saying "about Patrick" is
  // the same three words forty times. Only what the section does not already
  // say gets repeated here, which also leaves the meta column room to breathe.
  // Somebody the entry names where its subject goes, whom this source never
  // describes. Nexus has a candidate it can name, and saying "about them" would
  // put a certainty on the screen that its own evidence does not have.
  const unknown = d.namedButUnknown || [];
  const said = d.subject ? [hideCategory ? '' : kind, hideSubject ? '' : `about ${entityName(d.subject)}`].filter(Boolean).join(' · ') : '';
  // What the head says is the reading, never what the analyser could not do:
  // "who it is about is unsettled" is a note to itself, and the question on the
  // card already says what is being asked.
  const about = d.defines ? `Describes ${entityName(d.defines)}`
    : d.subject && !unknown.length ? said.charAt(0).toUpperCase() + said.slice(1)
      : hideCategory ? '' : kind;
  const bucket = bucketOf(d);
  // Whose reading this now is. Once somebody has answered, their answer is the
  // state of the card and what Nexus thought before it is history — kept, and
  // kept underneath. The provenance this reads was already recorded; it is only
  // being shown.
  const decided = isSettled(d) && (d.proposedBy === 'manual' || d.proposedBy === 'model-assist');
  // Whether this reading is actually going to be written. Only then does a
  // choice show as chosen; until then what Nexus read is labelled as its
  // reading, so nothing on an unticked card looks like somebody's answer.
  const accepted = d.approve || d.current === 'approved';
  const isWorld = !d.subject && !d.defines && isSettled(d);
  // Choosing general material can move a person-shaped category to background.
  // Only say so when it actually happened.
  const movedCategory = !!d.categoryWas && d.categoryWas !== d.category;
  // The people Nexus weighed, in its own order, then everyone else behind a choice.
  const likelyPeople = (d.candidates || []).map((ref) => review.entities.get(ref)).filter(Boolean);
  const others = [...review.entities.values()].filter((x) => x.type === 'person' && !likelyPeople.includes(x));
  const connectable = [...review.entities.values()].filter((x) => x.ref !== d.subject && x.ref !== d.defines && !d.related.includes(x.ref));
  // Everything this review can point at: what the analyser proposed, and what
  // the source declared before. A declaration is not a reading and is not
  // labelled as one; it is simply there to be used again.
  const definable = [...review.entities.values()].filter((x) => x.decision !== 'skip');
  // A settled reading says what it is; a card in a group of twenty says it in
  // one line and nothing else, because twenty full cards is not a summary.
  const line = compact ? readingLabel(d) : about;
  // The entry's own words. Deciding what something means while looking only at
  // what Nexus thinks it means is the one thing this screen used to ask for.
  const excerpt = review.excerpt?.get(d.entryId) || '';
  return `
    <div class="edit-card${compact ? ' compact' : ''}" data-entry-ref="${esc(d.ref)}">
      <div class="edit-head">
        ${d.current === 'approved' && !d.correcting ? `<button class="card-badge as-btn" data-correct="${esc(d.ref)}" title="Change this">saved</button>`
    : d.current === 'approved' ? `<button class="rv-tick" data-tick="${esc(d.ref)}" aria-pressed="${d.approve}" aria-label="${d.approve ? 'Correction ready to save' : 'Save this correction'}"></button>`
    // Accepting a reading is not switching a Lore entry on: the control is a tick,
    // deliberately unlike the enable/disable switch the rest of the app uses.
    : `<button class="rv-tick" data-tick="${esc(d.ref)}" aria-pressed="${d.approve}" aria-label="${d.approve ? 'Accepted' : 'Accept this reading'}"></button>`}
        <b>${esc(d.title || 'Untitled')}</b>
        ${/* With nothing left to say, the column goes too, instead of holding a
             blank line open beside the title. */''}
        ${line || d.reclassified ? `<span class="n">${esc(line)}${d.reclassified && !compact ? ` <i class="rv-flag">changed from ${esc(d.storedKind)}</i>` : ''}</span>` : ''}
        ${/* So a closer look asked for by the section is not lost inside a closed card. */''}
        ${review.suggestions.has(d.ref) && !review.suggestions.get(d.ref).accepted ? '<span class="card-badge look">a closer look</span>' : ''}
        <button class="fold" aria-expanded="${review.opened.has(d.ref)}">▾</button>
      </div>
      <div class="edit-body"${review.opened.has(d.ref) ? '' : ' hidden'}>
        ${/* A reading you saved is not replaced by anything on this screen —
             not by Nexus reading again, and not by a closer look. */''}
        ${d.current === 'recheck' ? '<div class="why"><b>You saved a reading for this before.</b> The entry has changed since, so Nexus is reading it again. What you saved stays exactly as it is until you save a replacement.</div>' : ''}
        ${/* The entry's own words, first, before anything Nexus thinks of them.
             Deciding what something means from a summary of what it might mean
             is what this screen used to ask of you. */''}
        ${excerpt ? `<div class="rv-excerpt">${esc(excerpt)}…
          <button class="btn quiet" data-entry-open="${esc(d.entryId)}">Open the entry</button>
        </div>` : ''}
        ${/* Once a person has decided, their decision is the state of the card.
             What Nexus was unsure of before is history, and history belongs
             under the disclosure, not above the answer. */''}
        ${decided ? `<div class="rv-said-back">✓ ${esc(readingLabel(d))}${movedCategory
    ? ` — Nexus had read it as ${esc((CATEGORY_LABEL[d.categoryWas] || d.categoryWas).toLowerCase())}, and recorded it as ${esc((CATEGORY_LABEL[d.category] || d.category).toLowerCase())}` : ''}.<span class="rv-by">${d.proposedBy === 'manual' ? 'Decided by you' : 'You used a closer look'}</span></div>` : ''}
        ${!decided && d.approve && d.current !== 'approved' ? '<div class="rv-by-line">Decided by Nexus</div>' : ''}
        ${/* The question, in the words of the decision rather than of the thing
             the analyser could not do. No evidence, no scores: those are real
             and they are one tap away. */''}
        ${/* Only what the flag actually means: a name is here, and this source
             has not established who that is. It does NOT mean the entry
             introduces them, describes them, is about them, or that they
             should be made. Two real entries prove why saying more would be
             wrong — one is the named person's own profile, the other is
             guidance about somebody else entirely, and nothing on this screen
             can tell them apart. */''}
        ${!decided && ask === 'named' ? `<div class="rv-question">This entry mentions ${esc(unknown.join(' and '))}, ${unknown.length === 1 ? 'a name' : 'names'} Nexus hasn’t established in this source yet.</div>` : ''}
        ${!decided && ask === 'confirm' ? `<div class="rv-question">${d.reviewRisk ? `${esc(d.reviewRisk)}. Tick it if you are happy with it.`
    : `This says something about ${esc(entityName(d.subject) || 'somebody')} rather than introducing them. Save it as being about them?`}</div>` : ''}
        ${!decided && ask === 'about' ? '<div class="rv-question">What is this about?</div>' : ''}
        ${bucket === 'likely' && !d.approve && !ask ? `
          <div class="rv-suggest">
            <div>Nexus suggests: <b>${esc(unknown.length ? kind : (about || kind))}</b>${unknown.length && d.subject
    ? `, about ${esc(entityName(d.subject))} — unconfirmed` : ''}</div>
            <button class="btn" data-use="${esc(d.ref)}">Use this suggestion</button>
          </div>` : ''}
        ${d.correcting ? correctionNote(d) : ''}
        ${/* The choices, and only the ones worth putting in front of somebody.
             Where the entry names a person this source never introduces, the
             people the analyser guessed at are not offered here: they are
             usually wrong, and one of them being right is not worth the other
             two looking like answers. They are still under "other readings". */''}
        ${/* An unknown name offers no reading up front at all. Every answer
             available here is a fallback — the operation that would actually
             settle such an entry does not exist yet — and a fallback put where
             the recommended answer goes reads as the recommended answer. They
             are all still there, one tap down, for somebody who has decided
             they want one. */''}
        ${!decided && ask !== 'named' && (choose || d.pick || d.correcting || !isSettled(d)) ? `
          <div class="chips rv-choices">
            ${choiceChip(d.ref, '', 'General world material', accepted && isWorld, !accepted && isWorld)}
            ${likelyPeople.map((p) => choiceChip(d.ref, p.ref, p.name, accepted && d.subject === p.ref, !accepted && d.subject === p.ref)).join('')}
          </div>` : ''}
        ${/* Leaving it is a real answer and must cost nothing: it ticks
             nothing, writes nothing, and changes no count. Asking a model is
             offered beside it only where no manual way to answer exists. */''}
        ${ask && !decided ? `<div class="row-actions" style="margin-top:9px">
          <button class="btn quiet" data-later="${esc(d.ref)}">Leave for later</button>
          ${ask === 'named' && !review.suggestions.has(d.ref) && !review.looking.has(d.ref)
    ? `<button class="btn quiet" data-look="${esc(d.ref)}">Ask Nexus to look closer</button>` : ''}
        </div>` : ''}
        ${/* Only what a closer look came back with. The offer itself is the
             quiet button above, not a second one with a paragraph beside it. */''}
        ${ask === 'named' && (review.suggestions.has(d.ref) || review.looking.has(d.ref)) ? closerLook(d, bucket) : ''}
        ${/* Everything the analyser knows, one level down. None of it is
             deleted; it is simply not the first thing between you and a
             decision. The warnings that used to have a feed of their own are
             here, on the entry each was about, and so are the scores. */''}
        <details><summary>${ask && !decided ? 'Why Nexus is asking' : 'Why Nexus said this'}</summary>
          ${attentionFor(d.ref).map((a) => `<div class="fired-row"><span class="t"><b>${esc(a.title)}</b> — ${esc(a.message)}</span></div>`).join('')}
          ${d.unresolved.length ? `<div class="fired-row"><span class="t">${esc(d.unresolved.join('. '))}</span></div>` : ''}
          ${d.evidence.map((v) => `<div class="fired-row"><span class="t">${esc(v.detail)}</span></div>`).join('')}
          <div class="fired-row"><span class="t">How sure Nexus is</span><span class="w">${esc(d.confidence)}</span></div>
          <div class="fired-row"><span class="t">Read as</span><span class="w">${esc(d.scope)} · ${esc(kind)}</span></div>
          ${d.defines ? `<div class="fired-row"><span class="t">Introduces</span><span class="w">${esc(entityName(d.defines))}</span></div>` : ''}
          ${d.subject ? `<div class="fired-row"><span class="t">About</span><span class="w">${esc(entityName(d.subject))}</span></div>` : ''}
          ${d.related.length ? `<div class="fired-row"><span class="t">Also connected to</span><span class="w">${esc(d.related.map(entityName).join(', '))}</span></div>` : ''}
          ${d.reclassified ? `<div class="fired-row"><span class="t">Stored as one kind, reads as another</span><span class="w">${esc(d.storedKind)}</span></div>` : `${''}`}
          ${d.reclassified ? `<div class="why">The original file called this “${esc(d.storedKind)}”. The original file is not changed.</div>` : ''}
          ${ask !== 'named' ? closerLook(d, bucket) : ''}
        </details>
        ${/* Every semantic control there has ever been, still here and still
             yours, one tap down rather than all open at once. */''}
        <details><summary>${decided ? 'Change this reading' : 'Other readings, and the fine detail'}</summary>
          ${decided || ask === 'named' ? `
            <div class="field">
              <label>What is this about?</label>
              <div class="chips">
                ${choiceChip(d.ref, '', 'General world material', accepted && isWorld, !accepted && isWorld)}
                ${likelyPeople.map((p) => choiceChip(d.ref, p.ref, p.name, accepted && d.subject === p.ref, !accepted && d.subject === p.ref)).join('')}
              </div>
            </div>` : ''}
          ${others.length ? `
            <div class="field">
              <label>Somebody else</label>
              <select data-subject-other="${esc(d.ref)}">
                <option value="">Choose somebody else…</option>
                ${others.map((p) => `<option value="${esc(p.ref)}"${d.subject === p.ref ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
              </select>
            </div>` : ''}
          ${/* Saying an entry is what introduces something. Offered here and
               only here, never suggested, and never filled in from a name the
               source did not establish — the flag says a name is present, not
               what the entry is. */''}
          <div class="field">
            <label>This entry defines something</label>
            <div class="rv-hint">What does this entry define?</div>
            <select data-defines="${esc(d.ref)}">
              <option value="">Choose existing…</option>
              ${definable.map((x) => `<option value="${esc(x.ref)}"${d.defines === x.ref ? ' selected' : ''}>${esc(x.name)} — ${esc(TYPE_LABEL[x.type] || x.type)}</option>`).join('')}
            </select>
            ${review.definingNew.has(d.ref) ? `
              <div class="rv-newent">
                <div class="field"><label>Name</label>
                  <input type="text" data-new-name="${esc(d.ref)}" value="" autocomplete="off" spellcheck="false"></div>
                <div class="field"><label>Type</label>
                  <select data-new-type="${esc(d.ref)}">
                    <option value="">Choose type…</option>
                    ${Object.entries(TYPE_LABEL).map(([k, label]) => `<option value="${esc(k)}">${esc(label)}</option>`).join('')}
                  </select>
                </div>
                <div class="row-actions">
                  <button class="btn" data-define-create="${esc(d.ref)}">Use this</button>
                  <button class="btn quiet" data-define-cancel="${esc(d.ref)}">Cancel</button>
                </div>
                <div class="why" data-new-trouble="${esc(d.ref)}"></div>
              </div>`
    : `<div class="row-actions" style="margin-top:6px">
                <button class="btn quiet" data-define-new="${esc(d.ref)}">+ Add something not listed</button>
              </div>`}
          </div>
          ${hideCategory && isSettled(d) ? '' : `
            <div class="field">
              <label>Type of information</label>
              <select data-category="${esc(d.ref)}">
                ${Object.entries(CATEGORY_LABEL).map(([k, label]) => `<option value="${k}"${d.category === k ? ' selected' : ''}>${esc(label)}</option>`).join('')}
              </select>
            </div>`}
          <div class="field">
            <label>Also connected to</label>
            ${d.related.length ? `<div class="chips">
              ${d.related.map((r) => `<button class="chip-tag" data-unrelate="${esc(d.ref)}" data-entity="${esc(r)}" aria-pressed="true">${esc(entityName(r))} ✕</button>`).join('')}
            </div>` : ''}
            ${connectable.length ? `<select data-relate="${esc(d.ref)}">
              <option value="">+ Add connection…</option>
              ${connectable.map((x) => `<option value="${esc(x.ref)}">${esc(x.name)}</option>`).join('')}
            </select>` : ''}
          </div>
        </details>
        <details><summary>The entry as it is stored</summary>
          <div class="fired-row"><span class="t">Stored in the original file as</span><span class="w">${esc(d.storedKind)}</span></div>
          <div class="fired-row"><span class="t">Trigger words</span><span class="w">${d.activation.keys.length ? esc(d.activation.keys.slice(0, 6).join(', ')) : 'none'}</span></div>
          <div class="fired-row"><span class="t">Always on</span><span class="w">${d.activation.constant ? 'yes' : 'no'}</span></div>
          <div class="fired-row"><span class="t">Switched on</span><span class="w">${d.activation.enabled ? 'yes' : 'no'}${d.phase ? ` · ${esc(String(d.phase).slice(0, 30))}` : ''}</span></div>
          <div class="why" style="margin-top:6px">Organising never changes any of this.</div>
        </details>
        ${compact ? '' : ''}
      </div>
    </div>`;
}

/**
 * A person, place or group as a summary rather than a form: what it is, what it
 * rests on, and the entries that describe it — including their own tick, so no
 * decision is counted in Save that cannot be looked at here.
 */
/**
 * Who this is, when Nexus already knows somebody it could be.
 *
 * Three answers, and only the ones that mean something here are offered. Making
 * them anew is the default. Where an organised source already has somebody of
 * this name and kind, saying "this is them" reuses that person instead of making
 * a second — and that is the same decision the "possibly the same elsewhere"
 * section asks, so it is wired to it rather than to a second mechanism. Leaving
 * them out is offered only while nothing ticked is about them, because an entry
 * about somebody who was left out cannot be saved.
 */
function entityChoice(x, state) {
  const mine = [...review.matches.entries()].filter(([, m]) => m.entity === x.ref && m.kind === 'existing-entity' && m.candidate?.entityId);
  const usedByTicked = [...review.entries.values()].some((d) => d.approve && (d.subject === x.ref || d.defines === x.ref || (d.related || []).includes(x.ref)));
  const same = mine.find(([, m]) => m.decision === 'same');
  return `
    <div class="rv-hint">Who is this?</div>
    <div class="row-actions" style="margin-bottom:8px">
      <button class="btn${!same && state.decision !== 'skip' ? ' primary' : ''}" data-ent-new="${esc(x.ref)}">New to Nexus</button>
      ${mine.map(([key, m]) => `<button class="btn${m.decision === 'same' ? ' primary' : ''}" data-ent-same="${esc(key)}">Already have them</button>`).join('')}
      ${!usedByTicked ? `<button class="btn${state.decision === 'skip' ? ' primary' : ''}" data-ent-skip="${esc(x.ref)}">Leave out</button>` : ''}
    </div>
    ${same ? `<div class="why">The ${esc(TYPE_LABEL[state.type].toLowerCase())} already in your library will be used; this source will say it is about them too.</div>` : ''}
    ${state.decision === 'skip' ? '<div class="why">Left out. Nothing in this source will be recorded as being about them.</div>' : ''}
    ${/* Why the third option is not here: an entry you have accepted is about
         them, so leaving them out would make that entry unsavable. */''}
    ${usedByTicked ? '<div class="why dim">To leave them out, first untick the entries about them below.</div>' : ''}`;
}

function entityCard(x) {
  const state = review.entities.get(x.ref);
  const profiles = x.profileEntries.map((ref) => review.entries.get(ref)).filter(Boolean);
  const editing = review.editingEntity === x.ref;
  return `
    <div class="edit-card">
      <div class="edit-head"><b>${esc(state.name)}</b>
        <span class="n">${esc(TYPE_LABEL[state.type])} · ${profiles.length ? `${plural(profiles.length, 'profile entry', 'profile entries')} · ` : ''}${esc(plural(x.mentionedIn, 'entry', 'entries'))}</span>
        <button class="fold" aria-expanded="false">▾</button></div>
      <div class="edit-body" hidden>
        ${profiles.length ? `
          <div class="rv-hint">${profiles.length > 1 ? 'Based on these entries, which stay separate' : 'Based on this entry'}</div>
          ${profiles.map((p) => entryCard(p, { compact: true, hideCategory: true })).join('')}`
    : '<div class="why">No entry in this source describes them directly; they are only mentioned.</div>'}
        ${state.aliases.length ? `<div class="why">Also called ${esc(state.aliases.join(', '))}.</div>` : ''}
        ${/* A word doing two jobs in one source. Kept apart, and said so, because
             the alternative is one entity of the wrong kind. */''}
        ${(x.nameSharedWith || []).length ? `<div class="why dim">“${esc(state.name)}” is also the name of ${esc((x.nameSharedWith || []).map((t) => `a ${(TYPE_LABEL[t] || t).toLowerCase()}`).join(' and '))} in this source. Nexus keeps them separate — they are different kinds of thing. If one of them was read as the wrong kind, change its kind below.</div>` : ''}
        ${x.mayBeSeveral ? '<div class="why dim">The entries describing them have little in common. They may be one written twice, or they may not be the same at all.</div>' : ''}
        ${entityChoice(x, state)}
        <details${editing ? ' open' : ''}><summary>Change the name or what they are</summary>
          <div class="field"><label>Name</label><input data-entity-name="${esc(x.ref)}" value="${esc(state.name)}"></div>
          <div class="field">
            <label>What they are</label>
            <select data-entity-type="${esc(x.ref)}">
              ${Object.entries(TYPE_LABEL).map(([k, label]) => `<option value="${k}"${state.type === k ? ' selected' : ''}>${esc(label)}</option>`).join('')}
            </select>
          </div>
        </details>
        <details><summary>Why Nexus says this</summary>
          ${x.evidence.map((v) => `<div class="fired-row"><span class="t">${esc(v.detail)}</span></div>`).join('')}
        </details>
      </div>
    </div>`;
}

function variantCard(g) {
  const titleOf = (ref) => review.draft.entries.find((e) => e.ref === ref)?.title || ref;
  return `
    <div class="edit-card">
      <div class="edit-head"><b>${esc(titleOf(g.entries[0].entry))}</b><span class="n">${g.entries.length} versions</span>
        <button class="fold" aria-expanded="false">▾</button></div>
      <div class="edit-body" hidden>
        <div class="why">${esc(g.note)}</div>
        ${g.entries.map((x) => `<div class="fired-row"><span class="t">${esc(titleOf(x.entry))}</span><span class="w">${x.enabled ? 'on' : 'off'}${x.phase ? ` · ${esc(String(x.phase).slice(0, 24))}` : ''}</span></div>`).join('')}
      </div>
    </div>`;
}

function matchCard(key, m) {
  return `
    <div class="edit-card">
      <div class="edit-head"><b>${esc(entityName(m.entity))}</b><span class="n">${esc(m.candidate.sourceName || 'another source')}</span>
        <button class="fold" aria-expanded="false">▾</button></div>
      <div class="edit-body" hidden>
        <div class="why">Nexus thinks this may be the same ${esc(TYPE_LABEL[m.candidate.type] || 'thing')} as “${esc(m.candidate.name)}”. A shared name can also belong to another version of a world, so nothing is joined unless you say so.</div>
        ${m.evidence.map((v) => `<div class="fired-row"><span class="t">${esc(v.detail)}</span></div>`).join('')}
        ${m.candidate.entityId ? `
          <div class="row-actions" style="margin-top:10px">
            <button class="btn${m.decision === 'same' ? ' primary' : ' quiet'}" data-match="${esc(key)}" data-decision="same">Same one</button>
            <button class="btn${m.decision === 'separate' ? ' primary' : ' quiet'}" data-match="${esc(key)}" data-decision="separate">Keep separate</button>
            <button class="btn${m.decision === 'later' ? ' primary' : ' quiet'}" data-match="${esc(key)}" data-decision="later">Decide later</button>
          </div>`
    : '<div class="why">That source has not been organised yet, so there is nothing to join it to.</div>'}
      </div>
    </div>`;
}

function onReviewClick(e) {
  const tick = e.target.closest('[data-tick]');
  if (tick) {
    const d = review.entries.get(tick.dataset.tick);
    if (!d.approve && !isSettled(d)) { toast('Say who this is about first.'); return; }
    d.approve = !d.approve;
    // Touching the tick at all is the person deciding, whichever way it lands.
    // Unticking and ticking again leaves no trace in the tick itself, so it is
    // recorded here instead of guessed from the end state.
    d.reselected = true;
    renderReview();
    return;
  }
  const subject = e.target.closest('[data-subject]');
  if (subject) {
    const d = review.entries.get(subject.dataset.subject);
    pinDecision(d);
    const ref = subject.dataset.entity;
    if (ref) {
      d.scope = 'entity';
      d.subject = ref;
      d.defines = null;
      d.related = d.related.filter((r) => r !== ref);
    } else {
      d.scope = 'world';
      d.subject = null;
      // World material introduces nothing, and Apply refuses an entry that is
      // not about an entity yet claims to define one.
      d.defines = null;
      // Unchanged: a category that only means anything about a person cannot
      // survive the entry becoming nobody's. What is new is that the card can
      // now say it happened, rather than the category quietly reading
      // differently the next time it is looked at.
      if (PERSON_CATEGORY.includes(d.category)) { d.categoryWas = d.category; d.category = 'background'; }
    }
    d.proposedBy = 'manual';
    d.editedContent = true;
    d.approve = true;
    renderReview();
    return;
  }
  const unrelate = e.target.closest('[data-unrelate]');
  if (unrelate) {
    const d = review.entries.get(unrelate.dataset.unrelate);
    d.related = d.related.filter((r) => r !== unrelate.dataset.entity);
    d.proposedBy = 'manual';
    d.editedContent = true;
    renderReview();
    return;
  }
  // ---- who an entity is: new to Nexus, one it already has, or left out
  const entNew = e.target.closest('[data-ent-new]');
  if (entNew) {
    const ref = entNew.dataset.entNew;
    review.entities.get(ref).decision = 'new';
    review.entities.get(ref).proposedBy = 'manual';
    for (const [, m] of review.matches) if (m.entity === ref && m.decision === 'same') m.decision = 'separate';
    renderReview();
    return;
  }
  const entSame = e.target.closest('[data-ent-same]');
  if (entSame) {
    const m = review.matches.get(entSame.dataset.entSame);
    m.decision = 'same';
    review.entities.get(m.entity).decision = 'existing';
    review.entities.get(m.entity).entityId = m.candidate.entityId;
    review.entities.get(m.entity).proposedBy = 'manual';
    renderReview();
    return;
  }
  const entSkip = e.target.closest('[data-ent-skip]');
  if (entSkip) {
    const state = review.entities.get(entSkip.dataset.entSkip);
    state.decision = state.decision === 'skip' ? 'new' : 'skip';
    state.proposedBy = 'manual';
    renderReview();
    return;
  }

  const match = e.target.closest('[data-match]');
  if (match) {
    review.matches.get(match.dataset.match).decision = match.dataset.decision;
    review.open.add('matches');
    renderReview();
    return;
  }
  const use = e.target.closest('[data-use]');
  if (use) {
    const d = review.entries.get(use.dataset.use);
    pinDecision(d);
    d.approve = true;
    d.reselected = true;   // taking a suggestion is choosing it, not editing it
    renderReview();
    return;
  }

  // ---- changing a reading that was already saved
  const correct = e.target.closest('[data-correct]');
  if (correct) {
    const ref = correct.dataset.correct;
    const d = review.entries.get(ref);
    d.correcting = true;
    d.proposedBy = 'manual';
    review.opened.add(ref);
    renderReview();
    // What is leaning on it, said before anything is changed rather than after.
    (async () => {
      try {
        review.impact.set(ref, await get(`/api/lorebooks/${review.bookId}/semantic-impact?entryId=${encodeURIComponent(d.entryId)}`));
      } catch { /* the note simply says less */ }
      renderReview();
    })();
    return;
  }

  // ---- a closer look, and what is done with what comes back
  const look = e.target.closest('[data-look]');
  if (look) {
    const d = review.entries.get(look.dataset.look);
    lookCloser([look.dataset.look], { force: bucketOf(d) === 'likely' });
    return;
  }
  const help = e.target.closest('[data-help]');
  if (help) {
    const id = help.dataset.help;
    review.open.add(id);
    const rows = [...review.entries.values()].filter((d) => d.current !== 'approved' && bucketOf(d) === id);
    lookCloser(rows.filter((d) => !review.suggestions.has(d.ref)).map((d) => d.ref).slice(0, HELP_AT_ONCE));
    return;
  }
  const take = e.target.closest('[data-take]');
  if (take) { takeSuggestion(take.dataset.take); renderReview(); return; }
  const chooseElse = e.target.closest('[data-else]');
  if (chooseElse) {
    // Put the ordinary chooser in front of them, and take the suggestion away.
    review.suggestions.delete(chooseElse.dataset.else);
    review.entries.get(chooseElse.dataset.else).pick = true;
    renderReview();
    return;
  }
  const drop = e.target.closest('[data-drop]');
  if (drop) { review.suggestions.delete(drop.dataset.drop); renderReview(); return; }

  // ---- a decision just made, still on screen where it was made
  const reopen = e.target.closest('[data-reopen]');
  if (reopen) { review.justDecided.editing = true; review.opened.add(reopen.dataset.reopen); renderReview(); return; }
  const done = e.target.closest('[data-done]');
  if (done) { review.justDecided = null; renderReview(); return; }

  // ---- saying an entry is what introduces something
  const defineNew = e.target.closest('[data-define-new]');
  if (defineNew) {
    // Opening the form decides nothing: no entity, no tick, no change to what
    // Save would write. It is a form, and it is empty.
    review.definingNew.add(defineNew.dataset.defineNew);
    renderReview();
    return;
  }
  const defineCancel = e.target.closest('[data-define-cancel]');
  if (defineCancel) { review.definingNew.delete(defineCancel.dataset.defineCancel); renderReview(); return; }

  const defineCreate = e.target.closest('[data-define-create]');
  if (defineCreate) {
    const ref = defineCreate.dataset.defineCreate;
    const d = review.entries.get(ref);
    const name = ($(`[data-new-name="${ref}"]`)?.value || '').trim();
    const type = $(`[data-new-type="${ref}"]`)?.value || '';
    const trouble = $(`[data-new-trouble="${ref}"]`);
    // Said in place rather than by redrawing, so what has been typed survives
    // being told it is not enough yet.
    if (!name) { if (trouble) trouble.textContent = 'Give it a name first.'; return; }
    if (!type) { if (trouble) trouble.textContent = 'Say what kind of thing it is.'; return; }
    // Something of this name and kind already here is that thing, not a second
    // one. Only a name nothing answers to is made.
    const already = entityLike(name, type);
    const target = already ? already.ref : refFor(name);
    if (!already) {
      review.entities.set(target, {
        ref: target, type, name, aliases: [], decision: 'new', proposedBy: 'manual',
        madeHere: true, evidence: [], profileEntries: [], mentionedIn: 0, subjectOf: 0,
        confidence: null, nameSharedWith: [], mayBeSeveral: false,
      });
    }
    pinDecision(d);
    setDefines(d, target);
    review.definingNew.delete(ref);
    renderReview();
    return;
  }

  // Leaving something for later is a real answer, and it must cost nothing:
  // no tick, no reading changed, no entity made, and no effect on what Save
  // would write. It closes the card and that is all.
  const later = e.target.closest('[data-later]');
  if (later) { review.opened.delete(later.dataset.later); renderReview(); return; }

  if (e.target.closest('#rv-change-role')) { review.changingRole = !review.changingRole; renderReview(); return; }

  if (e.target.closest('#rv-save')) { confirmSave(); return; }

  // Anywhere else on a card's header opens or closes it: the row is the target,
  // the chevron only says which way it will go.
  if (e.target.closest('button:not(.fold), select, input, textarea, summary, a')) return;
  const head = e.target.closest('.edit-head');
  const card = head && head.closest('.edit-card');
  if (!card) return;
  // The card this header belongs to, never the section it sits inside: opening
  // one entry must not fold away everything around it.
  if (card.dataset.section) {
    const id = card.dataset.section;
    if (review.open.has(id)) review.open.delete(id); else review.open.add(id);
    renderReview();
    return;
  }
  const body = $('.edit-body', card);
  if (body) {
    // Toggled in place rather than by redrawing, so a source of two hundred
    // entries opens one card as fast as it opens one of six. The set below is
    // what a later redraw reads to leave it where it was.
    body.hidden = !body.hidden;
    const chevron = $('.fold', head);
    if (chevron) chevron.setAttribute('aria-expanded', String(!body.hidden));
    const ref = card.dataset.entryRef;
    if (ref) { if (body.hidden) review.opened.delete(ref); else review.opened.add(ref); }
  }
}

/**
 * Ask the model to read some entries again.
 *
 * The only thing in this screen that reaches a provider, and only from a press.
 * What comes back is put beside the entry; nothing is ticked, and nothing is
 * saved, until someone accepts it.
 */
async function lookCloser(refs, { force = false } = {}) {
  const todo = [...new Set(refs)].filter((r) => !review.looking.has(r));
  if (!todo.length) return;
  for (const r of todo) { review.looking.add(r); review.trouble.delete(r); }
  renderReview();
  try {
    const out = await post(`/api/lorebooks/${review.bookId}/semantic-assist`, { refs: todo, force });
    // Which model answered, so a reading taken from it can say so afterwards.
    if (out.model) review.model = out.model;
    for (const s of out.suggestions || []) review.suggestions.set(s.entryRef, s);
    for (const p of out.problems || []) {
      if (p.entryRef && !review.suggestions.has(p.entryRef)) review.trouble.set(p.entryRef, saidPlainly(p));
    }
    review.spent.push(...(out.usage || []));
    const got = todo.filter((r) => review.suggestions.has(r)).length;
    if (!got) toast(review.trouble.get(todo[0]) || 'Nothing usable came back.', { kind: 'bad' });
    else if (todo.length > 1) toast(`Read ${num(got)} of ${num(todo.length)} again.`, { kind: 'good' });
  } catch (err) {
    for (const r of todo) review.trouble.set(r, err.message || 'That could not be done.');
    toast(err.message || 'That could not be done.', { kind: 'bad' });
  } finally {
    for (const r of todo) review.looking.delete(r);
    renderReview();
  }
}

/** Why a closer look came back with nothing, in words worth reading. */
const saidPlainly = (p) => ({
  skipped: p.reason,
  failed: `That did not come back: ${p.reason}`,
  missing: 'It did not answer for this one.',
  rejected: `Nexus could not use that answer: ${p.reason}`,
  dropped: p.reason,
  unreadable: 'The answer did not make sense.',
}[p.kind] || p.reason);

/**
 * Accept a suggestion. This is the moment it becomes a decision — because a
 * person made it, not because a model said it.
 */
function takeSuggestion(ref) {
  const d = review.entries.get(ref);
  const s = review.suggestions.get(ref);
  if (!d || !s) return;
  // Whatever it settled is taken; whatever it left open stays open, and the
  // parts it never answered are not filled in on its behalf.
  if (s.defines) {
    // A profile is about the one it introduces, so an entry that does both is
    // stored the one way that says it: as that entity's own entry.
    d.scope = 'entity'; d.defines = s.defines; d.subject = null; d.category = s.category || 'profile';
  } else if (s.subject) {
    d.scope = 'entity'; d.subject = s.subject; d.defines = null;
    if (s.category) d.category = s.category;
  } else if (s.category) {
    d.category = s.category;
    // "This is world material, about nobody in particular" is a whole reading,
    // and only then does the entry settle. A subject it could not settle leaves
    // the entry open, however sure it was of the category.
    if (!openParts(s).has('subject') && !PERSON_CATEGORY.includes(s.category)) { d.scope = 'world'; d.subject = null; }
  }
  if (s.related?.length) d.related = [...new Set([...d.related, ...s.related])];
  d.related = d.related.filter((r) => r !== d.subject && r !== d.defines);
  if (s.displayPath) d.displayPath = s.displayPath;
  s.accepted = true;
  // A model proposed this and a person took it. Both halves are recorded: the
  // approval is theirs, and the suggestion was not Nexus reading the text.
  d.proposedBy = 'model-assist';
  if (review.model) d.model = review.model;
  // Taking a suggestion whole is choosing it, not editing it. What the reading
  // now says came from the model, and `proposedBy` already says so; this records
  // only that a person reached for it.
  d.reselected = true;
  // Only a settled reading can be saved; a category on its own does not settle
  // an entry that is still about nobody in particular.
  if (isSettled(d)) d.approve = true;
}

function onReviewChange(e) {
  const other = e.target.closest('[data-subject-other]');
  if (other) {
    const d = review.entries.get(other.dataset.subjectOther);
    pinDecision(d);
    if (other.value) {
      d.scope = 'entity';
      d.subject = other.value;
      d.defines = null;
      d.related = d.related.filter((r) => r !== other.value);
      d.proposedBy = 'manual';
      d.editedContent = true;
      d.approve = true;
    }
    renderReview();
    return;
  }
  const relate = e.target.closest('[data-relate]');
  if (relate) {
    const d = review.entries.get(relate.dataset.relate);
    if (relate.value && !d.related.includes(relate.value)) {
      d.related = [...d.related, relate.value];
      d.proposedBy = 'manual';
      d.editedContent = true;
    }
    renderReview();
    return;
  }
  const defines = e.target.closest('[data-defines]');
  if (defines) {
    const d = review.entries.get(defines.dataset.defines);
    if (defines.value) pinDecision(d);
    if (defines.value) setDefines(d, defines.value);
    else { d.defines = null; d.proposedBy = 'manual'; d.editedContent = true; }
    renderReview();
    return;
  }
  const cat = e.target.closest('[data-category]');
  if (cat) {
    const d = review.entries.get(cat.dataset.category);
    d.category = cat.value;
    d.proposedBy = 'manual';
    d.editedContent = true;
    return;
  }
  const type = e.target.closest('[data-entity-type]');
  if (type) {
    const state = review.entities.get(type.dataset.entityType);
    state.type = type.value;
    state.proposedBy = 'manual';
    renderReview();
    return;
  }
  const name = e.target.closest('[data-entity-name]');
  if (name) {
    const state = review.entities.get(name.dataset.entityName);
    const typed = name.value.trim();
    if (typed && typed !== state.name) state.proposedBy = 'manual';
    state.name = typed || state.name;
    renderReview();
    return;
  }
  if (e.target.id === 'rv-role') {
    review.role.role = e.target.value;
    review.role.proposedBy = 'manual';
    if (review.role.role === 'entity-material') {
      // Choosing it again asks the question again, rather than reviving whoever
      // was named before.
      if (!review.role.subject) review.role.subject = [...review.entities.values()].find((x) => x.type === 'person')?.ref || null;
    } else {
      // Only material that travels with somebody names somebody. Saying this
      // source is something else takes that claim away with it.
      review.role.subject = null;
    }
    renderReview();
    return;
  }
  if (e.target.id === 'rv-role-subject') {
    review.role.subject = e.target.value || null;
    review.role.proposedBy = 'manual';
    renderReview();
  }
}

/** What "Save 61 decisions" actually means, before it happens. */
function confirmSave() {
  const ticked = [...review.entries.values()].filter((d) => d.approve && d.current !== 'approved');
  const yours = ticked.filter((d) => d.proposedBy === 'manual' || d.reselected).length;
  const left = [...review.entries.values()].filter((d) => !d.approve && d.current !== 'approved').length;
  const ents = reviewEntityCount();
  // What "recognised" means, exactly: a person Nexus can match across sources
  // and stories. Not a character card, not anything on the People shelf — Apply
  // writes neither, and wording that suggested otherwise would be a lie about
  // what is about to happen.
  const said = [...ents.byType.entries()]
    .map(([type, n]) => `${num(n)} ${(n === 1 ? TYPE_LABEL[type] || type : TYPE_SECTION[type] || `${type}s`).toLowerCase()}`)
    .join(', ');
  subSheet('Save these decisions', `
    <div class="fired">
      <div class="fired-row"><span class="t">Readings Nexus decided</span><span class="w">${num(ticked.length - yours)}</span></div>
      ${yours ? `<div class="fired-row"><span class="t">Readings you decided</span><span class="w">${num(yours)}</span></div>` : ''}
      <div class="fired-row"><span class="t"><b>Saved in total</b></span><span class="w"><b>${num(ticked.length)}</b></span></div>
      ${ents.total ? `<div class="fired-row"><span class="t">People and places recognised in this source</span><span class="w">${num(ents.total)}</span></div>` : ''}
    </div>
    ${ents.total ? `<div class="why" style="margin-top:10px">${esc(said.charAt(0).toUpperCase() + said.slice(1))} become people and places Nexus can recognise in this source and match to others. <b>No character cards are made</b>, and nothing is added to your People shelf.</div>` : ''}
    <div class="why" style="margin-top:10px">The entries themselves are not touched: their words, their trigger words and when they fire all stay exactly as they are.</div>
    ${left ? `<div class="why" style="margin-top:10px"><b>${plural(left, 'entry', 'entries')} left for later.</b> Nothing about ${left === 1 ? 'it' : 'them'} is lost or changed, and you can come back whenever you like.</div>` : ''}
    <div class="sheet-actions">
      <button class="btn quiet" data-back>Back</button>
      <button class="btn primary" id="rv-confirm">Save ${num(ticked.length)}</button>
    </div>`, (root) => {
    $('#rv-confirm', root).addEventListener('click', saveReview);
  }, renderReview);
}

/** Send only what was decided. Everything left undecided stays as it was. */
async function saveReview() {
  if (review.saving) return;
  review.saving = true;
  const decisions = {
    role: review.role.role === 'entity-material' && !review.role.subject ? null : review.role,
    entities: [...review.entities.values()].map((x) => ({
      ref: x.ref, type: x.type, name: x.name, aliases: x.aliases, decision: x.decision, entityId: x.entityId,
      proposedBy: x.proposedBy,
    })),
    entries: [...review.entries.values()].filter((d) => d.approve).map((d) => ({
      ref: d.ref, entryId: d.entryId, hash: d.hash, approve: true, confidence: d.confidence,
      scope: d.scope, category: d.category, defines: d.defines, subject: d.subject, related: d.related, displayPath: d.displayPath,
      proposedBy: d.proposedBy, ...(d.proposedBy === 'model-assist' && d.model ? { model: d.model } : {}),
      // What the person did, from what they actually did — never from how the
      // tick ended up. An entry nobody touched arrived ticked, or it would not
      // be in this list at all.
      reviewAction: d.editedContent ? 'edited' : d.reselected ? 'selected' : 'preselected',
    })),
    // A match against a source nobody has organised yet has nothing to point at.
    matches: [...review.matches.values()].filter((m) => m.decision !== 'later' && m.candidate.entityId)
      .map((m) => ({ entity: m.entity, entityId: m.candidate.entityId, decision: m.decision })),
    evidence: Object.fromEntries([...review.entries.values()].map((d) => [d.ref, d.evidence])),
  };
  try {
    const result = await post(`/api/lorebooks/${review.bookId}/semantic-apply`, decisions);
    const said = { organized: 'All of it is organised.', partial: 'Part of it is organised.', unorganized: 'Nothing is organised yet.' }[result.organization.coverage];
    toast(`Saved ${num(result.entries.length)}. ${said}`, { kind: 'good' });
    closeSheet();
    await openLorebook(review.bookId, { keepPlace: true });
  } catch (err) {
    const stale = err.body?.stale || [];
    if (stale.length) {
      sheet('This source changed', `
        <div class="why">Some entries changed while this review was open, so the proposals no longer match what is there. Nothing was saved.</div>
        ${stale.slice(0, 8).map((s) => `<div class="fired-row"><span class="t">${esc(s.title || s.ref)}</span><span class="w">${esc(s.reason)}</span></div>`).join('')}
        <div class="sheet-actions"><button class="btn quiet" data-close>Close</button><button class="btn primary" id="rv-again">Look again</button></div>`,
      (root) => { $('#rv-again', root).addEventListener('click', () => openSourceReview(review.bookId)); });
    } else {
      toast(err.message || 'That could not be saved.', { kind: 'bad' });
    }
  } finally {
    review.saving = false;
  }
}

// ========================================================================
// A PERSON, IN FULL
//
// Three things that are not the same thing: the card or persona a story uses,
// the person themselves, and everything that is known about them. This screen
// shows all three without pretending they are one — and shows nothing else.
//
// Read-only. Nothing here organises material, edits it, or decides what a model
// is told: being on someone's page is not being in the prompt.
// ========================================================================

const CATEGORY_PILL = {
  identity: 'Identity', appearance: 'Appearance', personality: 'Personality', speech: 'Speech',
  behavior: 'Behaviour', backstory: 'Backstory', psychology: 'Psychology', relationship: 'Relationship',
  secret: 'Secret', goal: 'Goal', skill: 'Skill', ability: 'Ability', equipment: 'Equipment',
  belief: 'Belief', habit: 'Habit', profile: 'Profile', background: 'Background', rule: 'Rule',
  event: 'Event', item: 'Thing', direction: 'Directive', reference: 'Reference', other: 'Other',
};
const ENTITY_WORD = { person: 'Person', place: 'Place', faction: 'Group', item: 'Thing', event: 'Event', concept: 'Idea' };
const CORE_SLOTS = [
  ['identity', 'Who they are'], ['appearance', 'How they look'], ['personality', 'What they are like'],
  ['behavior', 'How they act'], ['speechStyle', 'How they talk'],
];

/**
 * Open someone's page. `back` says where the arrow goes, so this can be reached
 * from a card, from a story, or from another person's page without losing the
 * way home.
 */
async function openEntityProfile(entityId, { storyId = null, back = null, title = 'Profile' } = {}) {
  subSheet(title, `${backRow()}<div class="empty">Reading everything known…</div>`, null, back);
  let p;
  try {
    p = await get(`/api/entities/${entityId}/profile${storyId ? `?storyId=${encodeURIComponent(storyId)}` : ''}`);
  } catch (err) {
    sheet(title, `${backRow()}<div class="empty">${esc(err.message || 'That could not be read.')}</div>`);
    return;
  }
  renderEntityProfile(p, { storyId, back });
}

/**
 * One thing known about them, closed until asked for.
 *
 * `as` renames the row for display only, where an entry's own title would
 * repeat the group it sits in — "Fluid Domain / Fluid Domain". The entry keeps
 * its title, which is shown with the rest of its provenance.
 */
function knowledgeItem(x, { as = null, hideKind = false } = {}) {
  const flags = [
    x.needsRecheck ? '<span class="ent-flag warn">needs review</span>' : '',
    !x.activation.enabled ? '<span class="ent-flag">switched off</span>' : '',
  ].filter(Boolean).join('');
  return `
    <div class="edit-card">
      <div class="edit-head">
        <b>${esc(as || x.title)}</b>
        <span class="n">${hideKind ? '' : esc(CATEGORY_PILL[x.category] || x.category)}${flags}</span>
        <button class="fold" aria-expanded="false">▾</button>
      </div>
      <div class="edit-body" hidden>
        ${x.needsRecheck ? '<div class="why">The source text changed after this reading was saved. What you approved is still what stands.</div>' : ''}
        ${/* Long entries used to flood the screen. The whole text is stored and
             one tap away; what is shown first is enough to know it again. */''}
        ${x.text.length > 420 ? `
          <p class="prose-plain">${esc(x.text.slice(0, 420).replace(/\s+\S*$/, ''))}…</p>
          <details><summary>Read it all</summary><p class="prose-plain">${esc(x.text)}</p></details>`
    : `<p class="prose-plain">${esc(x.text)}</p>`}
        ${/* What you wrote yourself, you can change here. What arrived from a
             source is managed where it came from. */''}
        <div class="row-actions" style="margin-top:8px">
          ${x.written
    ? `<button class="btn quiet" data-edit-knowledge="${esc(x.entryId)}">Edit this</button>`
    : `<button class="btn quiet" data-open-source="${esc(x.provenance.sourceId)}">Open in ${esc(x.provenance.sourceName)}</button>`}
          ${/* Something written for one story that turns out to be true of them
                generally. A copy, so this story keeps its own version. */''}
          ${x.written === 'story-material' ? `<button class="btn quiet" data-reuse-across="${esc(x.entryId)}">Use across stories</button>` : ''}
        </div>
        ${x.related.length ? `<div class="chips" style="margin-top:8px">
          ${x.related.map((r) => `<button class="chip-tag" data-go-entity="${esc(r.id)}">${esc(r.name)}</button>`).join('')}
        </div>` : ''}
        <details><summary>Where this comes from</summary>
          ${as ? `<div class="fired-row"><span class="t">Its own title</span><span class="w">${esc(x.title)}</span></div>` : ''}
          <div class="fired-row"><span class="t">From</span><span class="w">${esc(x.provenance.sourceName)}</span></div>
          <div class="fired-row"><span class="t">Originally stored as</span><span class="w">${esc(x.provenance.storedKind)}</span></div>
          <div class="fired-row"><span class="t">Reaches the story</span><span class="w">${x.activation.constant ? 'always' : x.activation.keys.length ? 'when it comes up' : 'not on its own'}</span></div>
          ${x.activation.keys.length ? `<div class="fired-row"><span class="t">Trigger words</span><span class="w">${esc(x.activation.keys.slice(0, 8).join(', '))}</span></div>` : ''}
          <div class="fired-row"><span class="t">Switched on</span><span class="w">${x.activation.enabled ? 'yes' : 'no'}</span></div>
          <div class="why" style="margin-top:6px">Being on this page does not put it in the story. Each entry still decides that for itself.</div>
        </details>
      </div>
    </div>`;
}

/**
 * One core slot: enough to know them at a glance, and the rest a tap away.
 *
 * Cards carry whole essays in a single field. Printing one in full turns the
 * top of the page into a wall, which is the opposite of what a profile is for.
 */
function coreSlot(label, value) {
  const text = String(value || '').trim();
  // Short enough that two or three slots still fit a phone screen together.
  const cut = text.length > 220 ? text.slice(0, 220).replace(/\s+\S*$/, '') : text;
  return `
    <div class="ent-slot">
      <div class="ent-slot-label">${esc(label)}</div>
      <p class="prose-plain">${esc(cut)}${cut.length < text.length ? '…' : ''}</p>
      ${cut.length < text.length ? `<details class="ent-more"><summary>The rest of it</summary><p class="prose-plain">${esc(text)}</p></details>` : ''}
    </div>`;
}

/** Two names that would read as a repetition if stacked. */
const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * A display group, with whatever it nests inside it, and a way to add to it.
 *
 * Add inherits where it was pressed: the kind of information the group holds,
 * and the group itself when it is one of your own words.
 */
function knowledgeGroup(g) {
  const from = (items) => {
    const first = items.find(Boolean);
    return { category: first?.category || 'other', displayPath: first?.displayPath || null };
  };
  const add = (label, items) => {
    const at = from(items);
    return `<div class="row-actions" style="margin-top:8px"><button class="btn quiet"
      data-add-knowledge="${esc(at.category)}"
      data-add-path="${esc((at.displayPath || []).join('›'))}">+ Add${label ? ` to ${esc(label)}` : ''}</button></div>`;
  };
  // Inside a group named for a kind of information, naming the kind on every row
  // is the same word twice. It stays where a group of your own makes it useful.
  const hideKind = Object.values(CATEGORY_PILL).some((v) => sameName(v, g.name));
  return `
    <div class="edit-card ent-group">
      <div class="edit-head"><b>${esc(g.name)}</b><span class="n">${num(g.count)}</span>
        <button class="fold" aria-expanded="false">▾</button></div>
      <div class="edit-body" hidden>
        ${g.items.map((x) => knowledgeItem(x, { as: sameName(x.title, g.name) ? 'Overview' : null, hideKind })).join('')}
        ${g.sub.map((s) => `<div class="sec-head">${esc(s.name)}</div>${s.items.map((x) => knowledgeItem(x, { as: sameName(x.title, s.name) ? 'Overview' : null, hideKind })).join('')}${add(s.name, s.items)}`).join('')}
        ${add(g.sub.length ? g.name : '', g.items.length ? g.items : g.sub.flatMap((s) => s.items))}
      </div>
    </div>`;
}

/**
 * Whether this story is reading somebody's reusable knowledge, and how to
 * change it.
 *
 * Knowledge ABOUT them, not knowledge they hold: a deepest fear is true of
 * Patrick whether or not Patrick has ever faced it. Saying "what they know"
 * would spend a distinction a later layer needs.
 *
 * The person is the subject, never the file: "used in this story", not the name
 * of a container. Several containers are still several, because an old
 * character book and what somebody wrote by hand are not the same thing — but
 * they are counted together, and "use all" is one tap.
 */
function reuseHere(p) {
  const r = p.reuse;
  if (!r || !r.total) return '';
  const n = (k, one, many) => `${num(k)} ${k === 1 ? one : many}`;
  // A set is what a reader has: something they wrote, or a file they brought.
  // The container's own name is Nexus's business and stays in the details.
  const setName = (s) => (s.managed ? 'Written by you' : s.name);
  const many = r.total > 1;
  const detail = many
    ? `<details class="reuse-more"><summary>${n(r.total, 'knowledge set', 'knowledge sets')}</summary>
        <div class="del-list">${r.sources.map((s) => `<div class="del-row">
          <span class="del-name">${esc(setName(s))}</span>
          <span class="del-why">${n(s.entries, 'entry', 'entries')}</span>
          ${s.attached
    ? `<button class="btn quiet" data-reuse-off="${esc(s.id)}">Stop using</button>`
    : `<button class="btn quiet" data-reuse-on="${esc(s.id)}">Use here</button>`}
        </div>`).join('')}</div></details>`
    : '';
  if (r.state === 'all') {
    return `<div class="reuse-line on">
      <span>${n(r.entriesUsedHere, 'entry', 'entries')} available in this story.</span>
      <button class="btn quiet" data-reuse-off>${many ? 'Stop using all' : 'Stop using'}</button>
    </div>${detail}`;
  }
  if (r.state === 'some') {
    // Some of it, said as some of it: never a switch that looks either-way.
    return `<div class="reuse-line on">
      <span>${num(r.entriesUsedHere)} of ${n(r.entries, 'entry', 'entries')} available in this story.</span>
      <button class="btn quiet" data-reuse-on>Use all</button>
    </div>${detail}`;
  }
  return `<div class="reuse-line">
    <span>${n(r.entries, 'entry', 'entries')} in your library. Not used in this story.</span>
    <button class="btn" data-reuse-on>Use in this story</button>
  </div>${detail}
  <div class="why">This makes the knowledge available to this story. Each entry still decides when it becomes relevant.</div>`;
}

/**
 * Keeping one story's fact for the rest of them.
 *
 * Said before it happens, because the thing people fear here is that the story
 * they are telling will change. It will not: this makes a copy, and where the
 * story is already reading their knowledge the copy is kept out of this one so
 * the same thing is never said twice.
 */
async function offerAcrossStories(entryId, { profile, storyId, back }) {
  let pv;
  try { pv = await get(`/api/knowledge/${entryId}/reusable`); } catch (err) { toast(err.message); return; }
  const reopen = () => openEntityProfile(profile.entity.id, { storyId, back });
  if (pv.already) {
    sheet('Already kept', `<p class="rv-lede">“${esc(pv.title)}” is already part of what you know about ${esc(pv.about)}.</p>
      <div class="sheet-actions"><button class="btn primary" id="ok">Close</button></div>`,
    (root) => $('#ok', root).addEventListener('click', reopen));
    return;
  }
  sheet('Use across stories', `
    <p class="rv-lede">Keep “${esc(pv.title)}” with ${esc(pv.about)}, so other stories can use it too.</p>
    <div class="rv-keeps">
      <b>This story keeps its own version</b>
      <span>Nothing here changes. A copy goes to what you know about ${esc(pv.about)}, and the two are separate from then on — editing one never edits the other.</span>
    </div>
    ${pv.willExcludeHere ? `<p class="why" style="margin-top:10px">This story already reads what you know about ${esc(pv.about)}, so the copy is left out of this one. The fact is said once, the way it is now.</p>` : ''}
    <div class="sheet-actions">
      <button class="btn quiet" data-close>Not now</button>
      <button class="btn primary" id="across-go">Keep it</button>
    </div>
  `, (root) => {
    $('#across-go', root).addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        const r = await post(`/api/knowledge/${entryId}/reusable`, {});
        closeSheet();
        toast(`Kept with ${r.about}.`, {
          kind: 'good',
          sub: r.excludedHere ? 'This story still uses its own version.' : 'Other stories can use it once they carry their knowledge.',
        });
        reopen();
      } catch (err) { e.currentTarget.disabled = false; toast(err.message); }
    });
  });
}

// ------------------------------------ which person a card or a persona is
//
// Until Nexus is told, it can only show what the card itself says. It will not
// work this out from a name: one story's Patrick Moretti must never inherit
// another's. So it shows what it actually knows, says how it knows it, and
// waits to be told — including being told that this is somebody new.

const knownOf = (c) => [
  c.entries ? `${num(c.entries)} ${c.entries === 1 ? 'entry' : 'entries'}` : '',
  c.stories ? `in ${num(c.stories)} ${c.stories === 1 ? 'story' : 'stories'}` : '',
].filter(Boolean).join(' · ');

// Said without repeating a name that is already on the screen: with two cards
// of one name, "already the character Patrick Moretti" reads like a bug.
const alsoPlayedBy = (x, selfName) => {
  const who = x.kind === 'persona' ? 'Someone you play' : 'A character card';
  return x.name && x.name !== selfName ? `${who}, “${x.name}”, is already them` : `${who} is already them`;
};

const candidateCard = (c, selfName = '') => `
  <div class="edit-card">
    <div class="edit-head"><b>${esc(c.name)}</b>${knownOf(c) ? `<span class="n">${esc(knownOf(c))}</span>` : ''}</div>
    <div class="edit-body" style="display:block">
      <div class="why">${esc(c.why[0])}.</div>
      ${c.why.length > 1 ? `<div class="why dim" style="margin-top:2px">${esc(c.why.slice(1).join(' · '))}</div>` : ''}
      ${c.nameOnly ? '<div class="why dim" style="margin-top:2px">Only the name matches, so this is a guess and nothing more.</div>' : ''}
      ${c.alreadyRepresented.length ? `<div class="why dim" style="margin-top:2px">${esc(c.alreadyRepresented
    .map((x) => alsoPlayedBy(x, selfName)).join(' · '))}.</div>` : ''}
      <div class="row-actions" style="margin-top:8px">
        <button class="btn${c.prominent ? ' primary' : ''}" data-id-use="${esc(c.entityId)}">This is them</button>
      </div>
    </div>
  </div>`;

/** Ask who somebody is, and take the answer. */
async function connectKnowledge(kind, resourceId, { back = null } = {}) {
  let s;
  try { s = await get(`/api/identity/${kind}/${resourceId}`); } catch (err) { toast(err.message); return; }
  if (s.bound) { reviewConnection(kind, resourceId, { back }); return; }
  const mine = kind === 'persona' ? 'the character you play' : 'this card';
  const done = (msg) => { toast(msg, { kind: 'good' }); closeSheet(); if (back) back(); };

  sheet('Connect knowledge', `
    <p class="rv-lede">Nexus has not been told who ${esc(s.name)} is. Once it knows, everything organised about that person shows up here, and the knowledge about them can travel to your other stories.</p>
    ${s.candidates.length
    ? `<div class="why" style="margin-bottom:10px">Nexus never decides this on its own. Say who they are.</div>
        ${s.candidates.map((c) => candidateCard(c, s.name)).join('')}`
    : `<div class="notice">Nobody in your organised sources looks like ${esc(s.name)}. You can still say they are someone new, and organise a source about them whenever you like.</div>`}
    <div class="edit-card">
      <div class="edit-head"><b>Someone new</b></div>
      <div class="edit-body" style="display:block">
        <div class="why">A person of their own${s.sameName.length
    ? `, kept apart from the ${s.sameName.length === 1 ? 'one' : num(s.sameName.length)} of the same name above, on purpose and for good`
    : ''}. Use this when ${esc(mine)} is not the ${esc(s.name)} your sources already know.</div>
        <div class="row-actions" style="margin-top:8px"><button class="btn" id="id-new">They are someone new</button></div>
      </div>
    </div>
    <div class="sheet-actions"><button class="btn quiet" data-close>Not now</button></div>
  `, (root) => {
    const send = async (body, btn) => {
      btn.disabled = true;
      try {
        const r = await post(`/api/identity/${kind}/${resourceId}`, body);
        await loadLibrary();
        done(r.created
          ? `${r.name} is their own person now.${r.keptApartFrom ? ' Kept apart from the same name.' : ''}`
          : `${r.name} is ${r.entity.name}.`);
      } catch (err) { btn.disabled = false; toast(err.message, { kind: 'bad' }); }
    };
    root.addEventListener('click', (e) => {
      const use = e.target.closest('[data-id-use]');
      if (use) { send({ entityId: use.dataset.idUse }, use); return; }
      const fresh = e.target.closest('#id-new');
      if (fresh) send({ newPerson: true }, fresh);
    });
  });
}

/** Who a card is connected to, and how to change it. */
async function reviewConnection(kind, resourceId, { back = null } = {}) {
  let s;
  try { s = await get(`/api/identity/${kind}/${resourceId}`); } catch (err) { toast(err.message); return; }
  if (!s.bound) { connectKnowledge(kind, resourceId, { back }); return; }
  const d = s.disconnect;
  const lines = [
    d.depends.reading.length ? `${d.depends.reading.length === 1 ? 'One story reads' : `${num(d.depends.reading.length)} stories read`} their reusable knowledge: ${d.depends.reading.map((x) => x.title).join(', ')}.` : '',
    d.depends.writing.length ? `${d.depends.writing.length === 1 ? 'One story has' : `${num(d.depends.writing.length)} stories have`} facts about them of their own.` : '',
    d.depends.parts ? `This card plays them in ${d.depends.parts === 1 ? 'one story' : `${num(d.depends.parts)} stories`}.` : '',
  ].filter(Boolean);

  sheet('Connected person', `
    <p class="rv-lede">${esc(s.name)} is ${esc(s.entity.name)}${s.entity.aliases.length ? `, also called ${esc(s.entity.aliases.slice(0, 3).join(', '))}` : ''}.</p>
    <div class="reuse-line on"><span>${d.depends.knowledge
    ? `${num(d.depends.knowledge)} ${d.depends.knowledge === 1 ? 'entry' : 'entries'} in ${d.depends.sets === 1 ? 'one knowledge set' : `${num(d.depends.sets)} knowledge sets`}`
    : 'Nothing written about them yet'}</span></div>
    ${lines.length ? `<div class="why" style="margin-top:10px">${lines.map(esc).join('<br>')}</div>` : ''}
    <div class="rv-keeps" style="margin-top:12px">
      <b>Disconnecting deletes nothing</b>
      <span>${esc(s.entity.name)} stays, everything written about them stays, and every story keeps what it is carrying. Nexus just stops putting this ${kind === 'persona' ? 'persona' : 'card'} and that person together.</span>
    </div>
    <div class="sheet-actions">
      <button class="btn quiet" data-close>Close</button>
      <button class="btn" id="id-off">Disconnect</button>
    </div>
  `, (root) => {
    $('#id-off', root).addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        const r = await del(`/api/identity/${kind}/${resourceId}?token=${encodeURIComponent(d.token)}`);
        await loadLibrary();
        closeSheet();
        toast(`No longer connected to ${r.was}.`, { kind: 'good', sub: 'Nothing was deleted.' });
        if (back) back();
      } catch (err) { e.currentTarget.disabled = false; toast(err.message, { kind: 'bad' }); }
    });
  });
}

function renderEntityProfile(p, { storyId = null, back = null } = {}) {
  const card = p.resources.character;
  const persona = p.resources.persona;
  // What they are here: a card a story plays, someone you play, or someone who
  // exists only in what has been written about them.
  // What they are here, in the words a reader uses. The semantic type is only
  // worth saying when no resource stands behind them and it is not a person.
  const standing = card ? 'Character'
    : persona ? 'Played by you'
      : p.entity.type === 'person' ? 'Lore-backed person' : `${ENTITY_WORD[p.entity.type] || 'Person'} in your lore`;
  const face = card?.avatar || persona?.avatar || null;
  const core = p.core ? CORE_SLOTS.filter(([k]) => String(p.core[k] || '').trim()) : [];
  // An older card keeps who they are, how they look and how they talk in one
  // field. Calling that "Who they are" would claim a tidiness it does not have,
  // so it is shown as what it is: the original profile, whole and unsplit.
  const structured = ['appearance', 'behavior', 'speechStyle'].some((k) => String(p.core?.[k] || '').trim());
  const labelFor = (k, label) => (k === 'identity' && !structured ? 'Overview' : label);

  const html = `
    ${backRow()}
    ${/* The name is already the sheet's title. This row says what they are and
         where you are reading them from, and then gets out of the way. */''}
    <div class="ent-hero">
      <span class="ent-face">${face ? `<img src="${esc(face)}" alt="">` : `<span class="letter">${esc(p.entity.name[0].toUpperCase())}</span>`}</span>
      <div class="ent-head-text">
        <div class="ent-kind">${esc(standing)}</div>
        ${p.entity.aliases.length ? `<div class="ent-alias">Also called ${esc(p.entity.aliases.slice(0, 4).join(', '))}</div>` : ''}
        ${p.story ? `<div class="ent-where">In ${esc(p.story.title)}</div>` : ''}
      </div>
    </div>

    ${/* The card's own fields, and only that card's: one person may be written
         more than once, and this page shows the representation in hand. */''}
    ${core.length ? `
      <div class="band">Core profile<button class="btn quiet band-act" id="ent-edit-core">Edit</button></div>
      <div class="ent-core">
        ${core.map(([k, label]) => coreSlot(labelFor(k, label), p.core[k])).join('')}
      </div>` : ''}

    ${/* "Reusable" is the promise: it can be used again, not that it follows them
         everywhere. A story reads only the sources it carries. */''}
    ${/* Two shelves, and each says where writing on it would go. Inside a story,
         the story's own shelf is the one Add belongs to. */''}
    ${p.knowledge.reusable.length || (p.story && p.reuse?.total) ? `
      <div class="band">Reusable knowledge${p.story ? '' : '<button class="btn quiet band-act" data-add-reusable>+ Add</button>'}</div>
      <div class="why" style="margin-bottom:10px">Knowledge that can be used across stories.</div>
      ${p.story ? reuseHere(p) : ''}
      ${p.knowledge.reusable.map(knowledgeGroup).join('')}` : ''}

    ${p.story ? `
      <div class="band">In ${esc(p.story.title)}<button class="btn quiet band-act" data-add-story>+ Add</button></div>
      <div class="why" style="margin-bottom:10px">Only true in this story.</div>
      ${p.knowledge.story.length ? p.knowledge.story.map(knowledgeGroup).join('')
    : `<div class="empty">Nothing is true of ${esc(p.entity.name.split(' ')[0])} in this story alone yet.</div>`}` : ''}

    ${!p.knowledge.reusable.length && !p.story ? `
      <div class="empty">Nothing has been written about ${esc(p.entity.name)} yet.${core.length ? ' Their core profile is above.' : ''}
        <div class="row-actions" style="margin-top:12px;justify-content:center"><button class="btn" data-add-reusable>Add what you know</button></div>
      </div>` : ''}

    ${p.related.length ? `
      <div class="band">People and places around them</div>
      <div class="ent-near">
        ${p.related.map((r) => `
          <button class="ent-near-row" data-go-entity="${esc(r.id)}">
            <span class="ent-near-name">${esc(r.name)}</span>
            <span class="ent-near-why">${esc(ENTITY_WORD[r.type] || 'Person')} · ${esc(plural(r.entries.length, 'entry', 'entries'))}</span>
          </button>`).join('')}
      </div>` : ''}

    <details class="ent-details">
      <summary>Details</summary>
      <div class="fired-row"><span class="t">Knowledge shown</span><span class="w">${num(p.counts.total)}</span></div>
      ${p.story ? `<div class="fired-row"><span class="t">Of that, this story's own</span><span class="w">${num(p.counts.story)}</span></div>` : ''}
      ${p.counts.hidden ? `<div class="fired-row"><span class="t">Not shown here</span><span class="w">${num(p.counts.hidden)} from sources this view does not carry</span></div>` : ''}
      ${p.attention.recheck ? `<div class="fired-row"><span class="t">Changed since you approved them</span><span class="w">${num(p.attention.recheck)}</span></div>` : ''}
      ${p.attention.disabled ? `<div class="fired-row"><span class="t">Switched off</span><span class="w">${num(p.attention.disabled)}</span></div>` : ''}
      ${card ? `<div class="fired-row"><span class="t">Character</span><span class="w">${esc(card.name)}</span></div>` : ''}
      ${persona ? `<div class="fired-row"><span class="t">Persona</span><span class="w">${esc(persona.name)}</span></div>` : ''}
      ${p.attention.unorganisedSources.length ? `
        <div class="why" style="margin-top:8px">Some of their material has not been organised yet:</div>
        ${p.attention.unorganisedSources.map((s) => `
          <div class="row-actions" style="margin-top:6px">
            <button class="btn quiet" data-organise-source="${esc(s.sourceId)}">Review ${esc(s.name)}</button>
            <span class="rv-hint-inline">${num(s.organised)} of ${num(s.entries)} organised</span>
          </div>`).join('')}` : ''}
    </details>

    <div class="sheet-actions"><button class="btn primary" data-close>Close</button></div>`;

  sheet(p.entity.name, html, (root) => {
    wireFolds(root);
    const here = { profile: p, storyId, back };
    root.addEventListener('click', (e) => {
      // ---- writing
      const add = e.target.closest('[data-add-knowledge]');
      if (add) {
        openKnowledgeForm({
          ...here,
          preset: { category: add.dataset.addKnowledge, displayPath: add.dataset.addPath ? add.dataset.addPath.split('›') : null },
        });
        return;
      }
      if (e.target.closest('[data-add-story]')) { openKnowledgeForm({ ...here }); return; }
      if (e.target.closest('[data-add-reusable]')) { openKnowledgeForm({ ...here, storyId: null }); return; }
      const edit = e.target.closest('[data-edit-knowledge]');
      if (edit) {
        const all = [...p.knowledge.reusable, ...p.knowledge.story].flatMap((g) => [...g.items, ...g.sub.flatMap((s) => s.items)]);
        const item = all.find((x) => x.entryId === edit.dataset.editKnowledge);
        if (item) openKnowledgeForm({ ...here, entry: item, storyId: item.written === 'story-material' ? storyId : null });
        return;
      }
      if (e.target.closest('#ent-edit-core')) { openCoreForm(here); return; }
      const source = e.target.closest('[data-open-source]');
      if (source) { closeSheet(); openLorebook(source.dataset.openSource); return; }

      // ---- which of their reusable knowledge this story reads
      const on = e.target.closest('[data-reuse-on]');
      const off = e.target.closest('[data-reuse-off]');
      if ((on || off) && storyId) {
        const btn = on || off;
        const only = btn.dataset.reuseOn || btn.dataset.reuseOff || '';
        btn.disabled = true;
        (async () => {
          try {
            const r = on
              ? await post(`/api/stories/${storyId}/reuse/${p.entity.id}`, only ? { sourceIds: [only] } : {})
              : await del(`/api/stories/${storyId}/reuse/${p.entity.id}${only ? `?sourceId=${encodeURIComponent(only)}` : ''}`);
            const moved = on ? r.attached.reduce((n, s) => n + s.entries, 0) : r.detached.reduce((n, s) => n + s.entries, 0);
            // Stopping one set of several is not stopping all of them, and the
            // message says which it was.
            toast(on
              ? `${num(moved)} ${moved === 1 ? 'entry' : 'entries'} about ${r.name} now available here.`
              : r.remaining
                ? `${num(moved)} ${moved === 1 ? 'entry' : 'entries'} no longer read here. ${num(r.entriesRemaining)} still available.`
                : `This story no longer uses what you know about ${r.name}.`, { kind: 'good' });
            openEntityProfile(p.entity.id, { storyId, back });
          } catch (err) { btn.disabled = false; toast(err.message); }
        })();
        return;
      }

      // ---- one story's fact, kept for the rest
      const across = e.target.closest('[data-reuse-across]');
      if (across) { offerAcrossStories(across.dataset.reuseAcross, here); return; }

      const go = e.target.closest('[data-go-entity]');
      if (go) {
        // Walking from one person to another keeps the way back through them.
        openEntityProfile(go.dataset.goEntity, { storyId, back: () => renderEntityProfile(p, { storyId, back }) });
        return;
      }
      const organise = e.target.closest('[data-organise-source]');
      if (organise) { openSourceReview(organise.dataset.organiseSource); return; }
    });
  });
}

// ------------------------------------------------------------- writing it down
//
// Adding to someone's profile is writing a sentence about them, not filing a
// lore entry. The form asks what it says, what kind of thing it is, and when it
// should come up; where it is kept, what it is about and how that is recorded
// are Nexus's business. Inside a story, what you write belongs to that story
// unless you say otherwise — the one default that must never drift.

/** The categories a person may pick, in the order a profile reads. */
const AUTHOR_CATEGORIES = [
  ['identity', 'Identity'], ['appearance', 'Appearance'], ['personality', 'Personality'],
  ['behavior', 'Behaviour'], ['speech', 'Speech'], ['backstory', 'Backstory'],
  ['psychology', 'Psychology'], ['relationship', 'Relationship'], ['goal', 'Goal'],
  ['belief', 'Belief'], ['habit', 'Habit'], ['skill', 'Skill'], ['ability', 'Ability'],
  ['equipment', 'Equipment'], ['secret', 'Secret'], ['event', 'Event'], ['item', 'Thing'],
  ['background', 'Background'], ['other', 'Other'],
];
const CAT_LABEL = Object.fromEntries(AUTHOR_CATEGORIES);

/** Words worth offering as triggers, from the title, never from their name. */
function suggestTriggers(title, avoidNames = []) {
  const stop = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'his', 'her', 'their', 'with', 'for', 'to']);
  const away = new Set(avoidNames.flatMap((n) => String(n).toLowerCase().split(/\s+/)).filter(Boolean));
  const whole = String(title || '').trim().toLowerCase();
  const words = whole.split(/[^a-z0-9']+/i).filter((w) => w.length > 2 && !stop.has(w) && !away.has(w));
  const out = [];
  if (whole.length > 2 && !away.has(whole)) out.push(whole);
  for (const w of words) if (!out.includes(w)) out.push(w);
  return out.slice(0, 5);
}

/** Every display group already in use on this profile, to offer as a home. */
function groupsInUse(p) {
  const paths = new Map();
  for (const side of [p.knowledge.reusable, p.knowledge.story]) {
    for (const g of side) {
      for (const item of g.items) if (item.displayPath) paths.set(item.displayPath.join(' › '), item.displayPath);
      for (const s of g.sub) for (const item of s.items) if (item.displayPath) paths.set(item.displayPath.join(' › '), item.displayPath);
    }
  }
  return [...paths.entries()].map(([label, path]) => ({ label, path }));
}

/**
 * The form. Small on purpose: a title, what it says, what kind of thing it is,
 * and when Nexus should use it. Everything else is behind "More".
 */
function openKnowledgeForm({ profile, storyId = null, preset = {}, entry = null, back }) {
  const p = profile;
  const isStory = !!storyId;
  const editing = !!entry;
  const cat = entry?.category || preset.category || 'backstory';
  const path = entry?.displayPath || preset.displayPath || null;
  const groups = groupsInUse(p);
  const known = (p.related || []).map((r) => ({ id: r.id, name: r.name }));
  const chosenRelated = new Set((entry?.related || []).map((r) => r.id));
  const mode = entry ? (entry.activation.constant ? 'always' : 'keywords') : 'keywords';
  const keys = entry ? entry.activation.keys : [];

  const html = `
    ${backRow()}
    <div class="why" style="margin-bottom:12px" id="kn-scope">${editing ? 'Written by you' : 'About'} <b>${esc(p.entity.name)}</b>.
      ${isStory ? `It belongs to <b>${esc(p.story.title)}</b> and stays there.` : 'It can be used across stories.'}</div>

    <div class="field">
      <label for="kn-title">Title</label>
      <input type="text" id="kn-title" value="${esc(entry?.title || '')}" placeholder="Deepest fear" autocomplete="off">
    </div>
    <div class="field">
      <label for="kn-text">What it says</label>
      <textarea id="kn-text" rows="7" placeholder="Write it the way you would tell someone.">${esc(entry?.text || '')}</textarea>
    </div>
    <div class="field">
      <label for="kn-cat">Type of information</label>
      <select id="kn-cat">
        ${AUTHOR_CATEGORIES.map(([k, label]) => `<option value="${k}"${k === cat ? ' selected' : ''}>${esc(label)}</option>`).join('')}
      </select>
    </div>
    ${/* Where it appears on their page. Said as placement, because that is all
         it is — a person filling this in never needs the word displayPath. */''}
    <div class="field">
      <label for="kn-group">Show under</label>
      <select id="kn-group">
        <option value="">Directly under ${esc(CAT_LABEL[cat] || 'its type')}</option>
        ${groups.map((g) => `<option value="${esc(g.path.join('›'))}"${path && path.join('›') === g.path.join('›') ? ' selected' : ''}>${esc(g.label)}</option>`).join('')}
        ${path && !groups.some((g) => g.path.join('›') === path.join('›')) ? `<option value="${esc(path.join('›'))}" selected>${esc(path.join(' › '))}</option>` : ''}
        <option value="__new">A heading of your own…</option>
      </select>
      <input type="text" id="kn-new-group" placeholder="Quirk, Magic, Clan…" hidden autocomplete="off">
      <div class="why">Only where it sits on their page. It changes nothing about what it means.</div>
    </div>
    <div id="kn-rel-main"${cat === 'relationship' ? '' : ' hidden'}></div>

    <div class="field">
      <label>When should Nexus use this?</label>
      <div class="opts">
        <button type="button" class="opt" data-when="keywords" aria-pressed="${mode === 'keywords'}">
          <span class="opt-name">When it comes up</span>
          <span class="opt-why">Brought in when the scene mentions one of these words.</span>
        </button>
        <button type="button" class="opt" data-when="always" aria-pressed="${mode === 'always'}">
          <span class="opt-name">Always available</span>
          <span class="opt-why">In every message of every scene that uses this material.</span>
        </button>
      </div>
      <div id="kn-keys-row"${mode === 'always' ? ' hidden' : ''} style="margin-top:10px">
        <label for="kn-keys">Words that bring it up</label>
        <input type="text" id="kn-keys" value="${esc(keys.join(', '))}" placeholder="deepest fear, fear" autocomplete="off">
        <div class="why">Separated by commas. Nexus suggests these from the title — ${esc(p.entity.name.split(' ')[0])}'s name is deliberately not one of them, or everything about them would arrive at once.</div>
      </div>
    </div>

    <details class="kn-more">
      <summary>More</summary>
      ${/* Story writing stays in the story unless someone says otherwise here,
           deliberately one level down and never the default. */''}
      ${isStory && !editing ? `
        <div class="field" style="margin-top:10px">
          <button type="button" class="opt" id="kn-reusable" aria-pressed="false">
            <span class="opt-name">Use across stories instead</span>
            <span class="opt-why">Adds it to ${esc(p.entity.name.split(' ')[0])}'s reusable knowledge. Stories still use reusable material only when it is attached to them.</span>
          </button>
        </div>` : ''}
      ${/* One block, and it moves: a relationship's first question is who it is
           with, so for that type this stands in the form itself. */''}
      <div id="kn-rel-home"><div class="field" id="kn-rel-block" style="margin-top:10px">
        <label id="kn-rel-label">Connected to</label>
        ${known.length ? `<div class="chips" id="kn-related">
          ${known.map((k) => `<button type="button" class="chip-tag" data-relate-entity="${esc(k.id)}" aria-pressed="${chosenRelated.has(k.id)}">${esc(k.name)}</button>`).join('')}
        </div>` : '<div class="why">Nobody else is on this profile yet.</div>'}
        <div class="why" id="kn-rel-why">Someone else who is involved, without this being about them.</div>
      </div></div>
      <div class="field">
        <label for="kn-prob">How often it is used, when it is triggered</label>
        <input type="number" id="kn-prob" min="1" max="100" value="${entry?.activation?.probability ?? 100}">
        <div class="why">100 means every time. The rest of the timing controls stay with the entry itself.</div>
      </div>
    </details>

    <div class="sheet-actions">
      ${editing && entry.written ? '<button class="btn quiet" id="kn-del">Delete</button>' : ''}
      <button class="btn quiet" data-back>Cancel</button>
      <button class="btn primary" id="kn-save">${editing ? 'Save changes' : 'Add it'}</button>
    </div>`;

  subSheet(editing ? 'Edit this' : `Add to ${p.entity.name.split(' ')[0]}`, html, (root) => {
    const title = $('#kn-title', root);
    const keysBox = $('#kn-keys', root);
    let when = mode;
    let touchedKeys = editing;

    // A suggestion, until someone types their own.
    const suggest = () => {
      if (touchedKeys || when !== 'keywords') return;
      keysBox.value = suggestTriggers(title.value, [p.entity.name, ...(p.entity.aliases || [])]).join(', ');
    };
    title.addEventListener('input', suggest);
    keysBox.addEventListener('input', () => { touchedKeys = true; });

    root.addEventListener('click', (e) => {
      const opt = e.target.closest('[data-when]');
      if (opt) {
        when = opt.dataset.when;
        for (const b of $$('[data-when]', root)) b.setAttribute('aria-pressed', String(b.dataset.when === when));
        $('#kn-keys-row', root).hidden = when === 'always';
        suggest();
        return;
      }
      const rel = e.target.closest('[data-relate-entity]');
      if (rel) { rel.setAttribute('aria-pressed', rel.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); return; }
      const reuse = e.target.closest('#kn-reusable');
      if (reuse) {
        // The sentence at the top is the scope. It moves the moment the choice
        // does, so what Save will do is never a surprise — and it does not
        // promise attachment, because reusable material is not attached to
        // anything by being written.
        const on = reuse.getAttribute('aria-pressed') !== 'true';
        reuse.setAttribute('aria-pressed', String(on));
        $('#kn-scope', root).innerHTML = on
          ? `About <b>${esc(p.entity.name)}</b>. Saved to their reusable knowledge, for use across stories. A story uses it only when that knowledge is attached.`
          : `About <b>${esc(p.entity.name)}</b>. It belongs to <b>${esc(p.story.title)}</b> and stays there.`;
      }
    });

    const groupSel = $('#kn-group', root);
    const newGroup = $('#kn-new-group', root);
    groupSel.addEventListener('change', () => {
      newGroup.hidden = groupSel.value !== '__new';
      if (!newGroup.hidden) newGroup.focus();
    });

    // The type steers two things beside itself: what "directly under" means,
    // and whether the who-is-it-with question belongs in the form proper.
    const catSel = $('#kn-cat', root);
    const relBlock = $('#kn-rel-block', root);
    const relMain = $('#kn-rel-main', root);
    const relHome = $('#kn-rel-home', root);
    const placeRel = () => {
      const isRel = catSel.value === 'relationship';
      $('#kn-rel-label', root).textContent = isRel ? 'Who is this relationship with?' : 'Connected to';
      $('#kn-rel-why', root).textContent = isRel
        ? 'Optional. A relationship can be written before the other person has a page.'
        : 'Someone else who is involved, without this being about them.';
      (isRel ? relMain : relHome).appendChild(relBlock);
      relMain.hidden = !isRel;
      groupSel.options[0].textContent = `Directly under ${CAT_LABEL[catSel.value] || 'its type'}`;
    };
    catSel.addEventListener('change', placeRel);
    placeRel();

    // Named apart from the fetch helper it calls, which a shadow would silently break.
    const delBtn = $('#kn-del', root);
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!confirm('Delete this? What it says goes with it.')) return;
        try {
          const out = await del(`/api/entities/${p.entity.id}/knowledge/${entry.entryId}${storyId ? `?storyId=${encodeURIComponent(storyId)}` : ''}`);
          toast('Deleted.', { kind: 'good' });
          renderEntityProfile(out.profile, { storyId, back });
        } catch (err) { toast(err.message || 'That could not be deleted.', { kind: 'bad' }); }
      });
    }

    $('#kn-save', root).addEventListener('click', async () => {
      const chosenPath = groupSel.value === '__new'
        ? (newGroup.value.trim() ? [newGroup.value.trim()] : null)
        : groupSel.value ? groupSel.value.split('›') : null;
      const asReusable = $('#kn-reusable', root)?.getAttribute('aria-pressed') === 'true';
      const body = {
        storyId: asReusable ? null : (storyId || null),
        title: title.value.trim(),
        content: $('#kn-text', root).value.trim(),
        category: $('#kn-cat', root).value,
        displayPath: chosenPath,
        activation: {
          mode: when,
          keys: keysBox.value.split(',').map((s) => s.trim()).filter(Boolean),
          advanced: { probability: Number($('#kn-prob', root).value) || 100 },
        },
        relatedEntityIds: $$('[data-relate-entity][aria-pressed="true"]', root).map((b) => b.dataset.relateEntity),
      };
      if (!body.title) { toast('Give it a title.', { kind: 'bad' }); return; }
      if (!body.content) { toast('Write what it says.', { kind: 'bad' }); return; }
      try {
        const out = editing
          ? await patch(`/api/entities/${p.entity.id}/knowledge/${entry.entryId}`, body)
          : await post(`/api/entities/${p.entity.id}/knowledge`, body);
        // The toast repeats the scope, so where it went is confirmed rather
        // than assumed: this story's own material, or their reusable knowledge.
        const first = p.entity.name.split(' ')[0];
        toast(editing ? 'Saved.'
          : body.storyId ? `Added to ${first} in ${p.story.title}.`
            : `Added to ${first}'s reusable knowledge.`, { kind: 'good' });
        renderEntityProfile(out.profile, { storyId, back });
      } catch (err) { toast(err.message || 'That could not be saved.', { kind: 'bad' }); }
    });
  }, () => renderEntityProfile(p, { storyId, back }));
}

/**
 * The core slots of whichever resource stands behind this person.
 *
 * A card's own fields, edited as themselves. An older card keeps everything in
 * one description; that stays one description until someone chooses otherwise.
 */
function openCoreForm({ profile, storyId = null, back }) {
  const p = profile;
  const isPersona = !p.resources.character && !!p.resources.persona;
  const res = p.resources.character || p.resources.persona;
  if (!res) return;
  const structured = ['appearance', 'behavior', 'speechStyle'].some((k) => String(p.core?.[k] || '').trim());
  const field = (id, label, value, rows, why = '') => `
    <div class="field">
      <label for="${id}">${esc(label)}</label>
      <textarea id="${id}" rows="${rows}">${esc(value || '')}</textarea>
      ${why ? `<div class="why">${esc(why)}</div>` : ''}
    </div>`;

  subSheet('Core profile', `
    ${backRow()}
    <div class="why" style="margin-bottom:12px">What ${esc(p.entity.name)}'s ${isPersona ? 'persona' : 'card'} says. This is the profile itself, not knowledge about them.</div>
    ${field('core-identity', structured ? 'Who they are' : 'Overview', p.core?.identity, structured ? 4 : 8,
    structured ? '' : 'This card keeps everything in one description. Nexus leaves it whole; fill the fields below when you want them apart.')}
    ${field('core-appearance', 'How they look', p.core?.appearance, 3)}
    ${field('core-personality', 'What they are like', p.core?.personality, 3)}
    ${field('core-behavior', 'How they act', p.core?.behavior, 3)}
    ${field('core-speech', 'How they talk', p.core?.speechStyle, 3)}
    <div class="sheet-actions">
      <button class="btn quiet" data-back>Cancel</button>
      <button class="btn primary" id="core-save">Save</button>
    </div>`, (root) => {
    $('#core-save', root).addEventListener('click', async () => {
      const body = {
        id: res.id,
        name: res.name,
        description: $('#core-identity', root).value.trim(),
        appearance: $('#core-appearance', root).value.trim(),
        personality: $('#core-personality', root).value.trim(),
        behavior: $('#core-behavior', root).value.trim(),
        speechStyle: $('#core-speech', root).value.trim(),
      };
      try {
        await post(isPersona ? '/api/personas' : '/api/characters', body);
        toast('Saved.', { kind: 'good' });
        openEntityProfile(p.entity.id, { storyId, back, title: p.entity.name });
      } catch (err) { toast(err.message || 'That could not be saved.', { kind: 'bad' }); }
    });
  }, () => renderEntityProfile(p, { storyId, back }));
}
