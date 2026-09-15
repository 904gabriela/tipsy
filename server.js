// The server. Serves the app and answers its requests.
//
// Runs on your own machine for now. Nothing here depends on that: the same
// routes move to a hosting service later so your phone can reach it from
// anywhere.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { networkInterfaces } from 'node:os';
import { createHash } from 'node:crypto';

import { open } from './src/db/index.js';
import { importFile, ImportError } from './src/import/index.js';
import { normalizeCard } from './src/import/card.js';
import { classifyCard, CHOOSABLE_ROLES, ROLES } from './src/import/semantics.js';
import { planFor, applyPlan, startFromScenario } from './src/import/plan.js';
import { composeSource, nameFromTitle, personFromEntry, normalizeRole, CAST_ROLES } from './src/import/compose.js';
import { fromComposition, checkDraft, HARD as BUILDER_HARD, MODES as BUILDER_MODES, DEPTHS as BUILDER_DEPTHS } from './src/builder/contract.js';
import { buildDraft, regenerate } from './src/builder/index.js';
import { planGenerated, writeGenerated, createLeadCard, storyPackage } from './src/builder/apply.js';
import { isDirection, semanticSection } from './src/semantics/authority.js';
import { semanticViews, sourceOrganization } from './src/semantics/store.js';
import {
  planComposition, writeComposition, applyToStory, sourceRemovalPreview, removeSource,
} from './src/import/compose-apply.js';
import { buildPrompt, estimateTokens, substitute } from './src/engine/prompt.js';
import { stream, completeJson, listModels, credits, ModelError } from './src/llm/openrouter.js';
import { KINDS, WEIGHTS, classifyEntry, parsePasted } from './src/engine/classify.js';
import { defaultValues, costOf, driftFrom, parseScript } from './src/engine/script.js';
import { createAuth, readCookie, sessionCookie } from './src/auth.js';
import * as memory from './src/memory/index.js';

const PORT = Number(process.env.PORT || 8787);
const db = open(process.env.DB_PATH || 'data/tipsy.db');

const auth = createAuth(db);

// Routes anyone may reach: the ones that exist to let you in, and the small
// static shell that draws the lock screen. Everything else is behind it.
const OPEN_ROUTES = new Set(['/api/gate', '/api/gate/open', '/api/gate/set']);
const OPEN_FILES = new Set(['/', '/index.html', '/app.css', '/app.js', '/guide.js', '/manifest.webmanifest', '/icon.png', '/apple-touch-icon.png']);

// The same name-to-id rule the memory engine uses, so a dial set here lands
// on the same person the extractor is writing about.
const slugOf = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

// The key lives in .env on disk and never goes to the browser.
function apiKey() {
  // Keys get pasted with quotes around them, and Notepad likes to save a
  // byte-order mark at the top of the file. Neither should break anything.
  const clean = (s) => String(s || '').trim().replace(/^["']|["']$/g, '').trim();
  const fromEnv = process.env.OPENROUTER_API_KEY;
  if (fromEnv && clean(fromEnv)) return clean(fromEnv);
  if (existsSync('.env')) {
    const text = readFileSync('.env', 'utf8').replace(/^﻿/, '');
    const m = text.match(/^\s*OPENROUTER_API_KEY\s*=\s*(.+)$/m);
    if (m && clean(m[1])) return clean(m[1]);
  }
  return clean(db.getSetting('openrouter_key', '')) || '';
}

const DEFAULTS = {
  model: 'x-ai/grok-4.20',
  temperature: 0.95,
  topP: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
  maxTokens: 1200,
  historyLimit: 60,
  loreBudget: 6000,
  scanDepth: 3,
  recursive: true,
  includeNames: false,
  directions: '',
  authorNote: '',
  // What your punctuation means. Written down so the model reads yours the
  // way you meant it, and writes back in the same marks.
  notation: {
    on: true,
    marks: [
      { mark: '**', means: 'narration: what happens, what is seen' },
      { mark: '""', means: 'dialogue, spoken aloud' },
      { mark: "''", means: 'inner thought, not said out loud and not heard by anyone' },
      { mark: '(( ))', means: 'me talking to you, out of the story. Never write this back, never treat it as something a character said.' },
    ],
  },
  // How it looks. Nothing here reaches the model.
  look: {
    layout: 'prose',       // prose | bubbles | portraits
    background: null,      // asset id
    dim: 62,               // how far the picture is pushed behind the words
    ambient: 'none',       // none | rain | snow | dust | embers
    fontSize: 100,
  },
};

/** Dials that belong to a preset. The cast and the lore belong to a story. */
const PRESET_KEYS = [
  'model', 'temperature', 'topP', 'frequencyPenalty', 'presencePenalty',
  'maxTokens', 'historyLimit', 'loreBudget', 'scanDepth', 'recursive',
  'includeNames', 'directions',
  // Samplers other apps carry. Whether a given model honours them is up to
  // the provider; sending them costs nothing either way.
  'topK', 'minP', 'topA', 'repetitionPenalty',
  // Words put in the model's mouth so it continues rather than starts.
  'prefill', 'impersonation',
  // A script preset carries the prompt itself and the controls that fill it.
  // The chosen values ride along so that loading one gives you a story that
  // reads the way its author meant, before you touch anything.
  'script', 'dials', 'bundle',
];

const BUILTIN_PRESETS = [
  {
    // Named for the prose, not the pacing. It used to be called "Slow burn"
    // and asked the model not to rush a relationship, which is the same job
    // the ladder in arc.js now does properly — and two things with the same
    // name doing overlapping jobs is how you end up unable to say which one
    // is in charge. The ladder paces relationships. This paces sentences.
    id: 'builtin-slow-burn',
    name: 'Unhurried prose',
    settings: {
      temperature: 0.92, maxTokens: 1400, historyLimit: 80, loreBudget: 6000,
      frequencyPenalty: 0.25, presencePenalty: 0.1,
      directions: 'Take your time. A scene may end without resolving. Let silences sit, and let a question go unanswered if that is what would really happen. Do not have anyone say the thing they are avoiding unless the moment genuinely forces it out of them.',
    },
  },
  {
    id: 'builtin-long-prose',
    name: 'Long prose',
    settings: {
      temperature: 0.95, maxTokens: 2200, historyLimit: 60, loreBudget: 6000,
      frequencyPenalty: 0.3,
      directions: 'Write at length, three or four full paragraphs. Ground every scene in physical detail: what the light is doing, what the room sounds like, what people do with their hands. Dialogue carries its weight but never arrives unattended.',
    },
  },
  {
    id: 'builtin-fast',
    name: 'Quick and cheap',
    settings: {
      model: 'deepseek/deepseek-v4-flash',
      temperature: 0.9, maxTokens: 600, historyLimit: 30, loreBudget: 2500,
      directions: 'Keep replies short and quick, a paragraph or two.',
    },
  },
];

// ---------------------------------------------------------------- plumbing

const json = (res, code, body) => {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (c) => {
    if (tooBig) return;
    size += c.length;
    if (size > 64 * 1024 * 1024) {
      // Stop keeping bytes but keep draining, so the reply can still be
      // delivered. Destroying the socket here would only show the browser a
      // dropped connection with no explanation.
      tooBig = true;
      chunks.length = 0;
      reject(new HttpError(413, 'That file is too large. The limit is 64 MB.'));
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const readJson = async (req) => {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw new HttpError(400, 'The request was not valid JSON.'); }
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res, pathname) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(process.cwd(), 'public', rel);
  if (!file.startsWith(join(process.cwd(), 'public'))) { res.writeHead(403); res.end(); return true; }
  try {
    const s = await stat(file);
    if (!s.isFile()) return false;
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
    return true;
  } catch { return false; }
}

// ------------------------------------------------------------------ routes

const routes = [];
const route = (method, pattern, handler) => {
  const names = [];
  const rx = new RegExp('^' + pattern.replace(/:([a-z]+)/gi, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, names, handler });
};

// --- library

// --- the door
//
// Three routes, and they are the only ones reachable without a password.

/** What the lock screen needs to know before it draws itself. */
route('GET', '/api/gate', async (req) => ({
  needsPassword: auth.isSet(),
  inside: auth.allows(req),
  // Your own network may set the first password: your phone on your own wifi
  // is as much yours as the keyboard is. Anything arriving from outside, or
  // through a tunnel, may not — otherwise whoever found the address first
  // could claim the app.
  canSetFirst: !auth.isSet() && auth.isLocal(req),
  zone: auth.zone(req),
  local: auth.isLocal(req),
  waitSeconds: Math.ceil(auth.lockedFor(req) / 1000),
  sessions: auth.allows(req) ? auth.listSessions().length : 0,
}));

route('POST', '/api/gate/open', async (req, res) => {
  const wait = auth.lockedFor(req);
  if (wait > 0) {
    throw new HttpError(429, `Too many wrong tries. Wait ${Math.ceil(wait / 60000)} minutes.`);
  }
  if (!auth.isSet()) throw new HttpError(400, 'No password has been set yet.');

  const { password, remember = true } = await readJson(req);
  if (!auth.check(password)) {
    const f = auth.noteFailure(req);
    const left = Math.max(0, 8 - f.count);
    throw new HttpError(401, left > 0
      ? `That is not it. ${left} ${left === 1 ? 'try' : 'tries'} before this address has to wait.`
      : 'That is not it. This address has to wait fifteen minutes now.');
  }
  auth.forgive(req);

  const token = auth.newSession(String(req.headers['user-agent'] || '').slice(0, 60));
  res.setHeader('Set-Cookie', sessionCookie(token, req, { clear: !remember }));
  return { ok: true };
});

/** The first password, and later changes. */
route('POST', '/api/gate/set', async (req, res) => {
  const { password, current } = await readJson(req);

  if (auth.isSet()) {
    // Changing it needs the old one, so a session left open on a borrowed
    // phone cannot be used to lock you out of your own app.
    if (!auth.allows(req)) throw new HttpError(401, 'Sign in first.');
    if (!auth.check(current)) throw new HttpError(401, 'That is not your current password.');
  } else if (!auth.isLocal(req)) {
    throw new HttpError(403, 'The first password has to be set from your own network: the computer it runs on, or a device on the same wifi.');
  }

  auth.setPassword(password);
  const token = auth.newSession('this device');
  res.setHeader('Set-Cookie', sessionCookie(token, req));
  return { ok: true, endedOthers: true };
});

route('POST', '/api/gate/close', async (req, res) => {
  auth.endSession(readCookie(req, 'tipsy'));
  res.setHeader('Set-Cookie', sessionCookie('', req, { clear: true }));
  return { ok: true };
});

route('GET', '/api/gate/sessions', async () => ({ sessions: auth.listSessions() }));

route('POST', '/api/gate/sessions/end-all', async (req, res) => {
  auth.endAllSessions();
  res.setHeader('Set-Cookie', sessionCookie('', req, { clear: true }));
  return { ok: true };
});

route('GET', '/api/library', async () => ({
  characters: db.listCharacters(),
  lorebooks: db.listLorebooks(),
  personas: db.listPersonas(),
  stories: db.listStories(),
  // Added, not substituted: anything reading this payload before these
  // existed carries on reading exactly what it read.
  frameworks: db.listFrameworks(),
  scenarios: db.listScenarios(),
  stats: db.stats(),
}));

route('POST', '/api/import', async (req) => {
  const ct = req.headers['content-type'] || '';
  const name = decodeURIComponent(req.headers['x-filename'] || 'upload');
  if (!ct.includes('octet-stream')) throw new HttpError(400, 'Send the file itself, not a form.');
  const bytes = new Uint8Array(await readBody(req));

  let result;
  try {
    result = importFile(name, bytes);
  } catch (e) {
    if (e instanceof ImportError) throw new HttpError(422, e.message);
    throw e;
  }

  if (result.kind === 'character') {
    // The format said "character card", and it was right about that. What the
    // thing inside is FOR is a second question, and it is asked here.
    const card = result.data;
    const keep = /(\?|&)keep=1/.test(req.url || '');
    const read = readCard(card, { filename: name, source: 'file', keep });

    // Already here, byte for byte. Said, not silently skipped, and never
    // refused outright: sending it again with keep=1 brings in a second copy.
    if (read.duplicate) {
      const d = read.duplicate;
      return {
        kind: 'duplicate', name: result.name,
        already: { importId: d.id, role: d.chosen_role, filename: d.filename, resources: d.resources },
        detail: `Already in your library as ${ROLES[d.chosen_role]?.label?.toLowerCase() || d.chosen_role}.`,
      };
    }
    const { importId, plan } = read;

    // Anything that is not plainly a character stops and waits to be looked
    // at. Nothing has been created yet; the file itself is already safe.
    if (!plan.fastPath) {
      return {
        kind: 'review', needsReview: true, importId,
        name: result.name, detail: result.detail, notes: result.notes,
        plan: forTheScreen(plan),
      };
    }

    const id = db.saveCharacter(card);
    if (plan.starts.length) db.setStartingPoints('character', id, plan.starts);
    db.settleImport(importId, 'character', [
      { kind: 'character', id, part: 'primary' },
      ...db.listLorebooks().filter((x) => x.from_character === id).map((b) => ({ kind: 'lorebook', id: b.id })),
    ]);
    // A card that came as a picture IS the picture. Keep it as the portrait.
    // The picture is kept whole only when it is small enough to be worth
    // keeping whole. Anything bigger is resized by the browser and sent back
    // separately, because there is no image library on this side and a
    // silently missing face is worse than a second request.
    const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    let picture = false;
    if (isPng) {
      const b64 = Buffer.from(bytes).toString('base64');
      if (b64.length <= 900_000) { db.setAvatar('characters', id, `data:image/png;base64,${b64}`); picture = true; }
    }
    // A JSON card keeps its art on the site's image server rather than in the
    // file. Nothing was reading that, so those cards arrived faceless.
    const notes = [...(result.notes || [])];
    if (!picture && result.data.avatar) {
      const got = await fetchCardPicture(id, result.data.avatar);
      if (got) picture = true;
      else notes.push({ level: 'info', text: 'Its picture is a link this app could not fetch. You can add one by tapping the circle.' });
    }

    // The book that came inside the card gets its entries typed, like any other.
    for (const b of db.listLorebooks().filter((x) => x.from_character === id)) classifyBook(b.id);
    return {
      kind: 'character', id, name: result.name, detail: result.detail, notes, picture,
      // Said out loud, but nothing stopped for it: this is the fast path.
      role: 'character', confidence: plan.confidence, importId,
      starts: plan.starts.length,
    };
  }
  if (result.kind === 'lorebook') {
    const id = db.saveLorebook(result.data);
    classifyBook(id);
    return { kind: 'lorebook', id, name: result.name, detail: result.detail, notes: result.notes, audit: summarizeAudit(result.audit) };
  }
  if (result.kind === 'preset') {
    // Stored inside the preset's settings, which means loading it into a
    // story is the same code path as loading any other preset. The controls
    // start wherever their author left them.
    const script = result.data;
    const id = db.savePreset({
      name: result.name,
      settings: {
        script, dials: defaultValues(script), bundle: null,
        // A preset from another app brings its sampler numbers and, sometimes,
        // words to put in the model's mouth. Both ride with it.
        ...(result.settings || {}),
        ...(result.extras?.prefill ? { prefill: result.extras.prefill } : {}),
        ...(result.extras?.impersonation ? { impersonation: result.extras.impersonation } : {}),
      },
    });
    return { kind: 'preset', id, name: result.name, detail: result.detail, notes: result.notes };
  }

  // A saved conversation is kept as a story you can read and carry on from,
  // along with the character you played in it and the scenario it was set in.
  const chat = result.data;
  const sid = db.transaction(() => {
    let personaId = null;
    if (chat.persona && (chat.persona.displayName || chat.persona.name)) {
      personaId = db.savePersona({
        name: chat.persona.displayName || chat.persona.name,
        description: chat.persona.description || '',
      });
    }
    const settings = { ...DEFAULTS };
    if (chat.scenario && chat.scenario.description) settings.directions = String(chat.scenario.description).trim();
    const storyId = db.createStory({ title: result.name || 'Imported story', personaId, settings });
    let parent = null;
    for (const m of chat.messages) {
      if (!m.content.trim()) continue;
      parent = db.addMessage({ storyId, parentId: parent, role: m.role, content: m.content });
    }
    return storyId;
  });
  return { kind: 'chat', id: sid, name: result.name, detail: result.detail, notes: [] };
});

/**
 * Read a card semantically and write down that it arrived.
 *
 * The import record is created BEFORE anything is decided, so the original
 * outlives the decision: a verdict can be overruled, and a file can be looked
 * at again in a year, without asking for it to be uploaded twice.
 */
function readCard(card, { filename, source = 'file', sourceUrl = '', keep = false }) {
  const original = JSON.stringify(card._original ?? null);
  const hash = createHash('sha256').update(original).digest('hex');

  // The same download twice is the same download. Only an exact match counts,
  // and only against something that actually became part of the library:
  // two cards of the same person from different sites are two cards, and
  // deciding otherwise is guesswork this does not do.
  if (!keep) {
    const already = db.importByHash(hash);
    if (already) return { duplicate: already, hash };
  }

  const verdict = classifyCard(card, { format: card.spec });
  const plan = planFor(card, verdict);
  const importId = db.recordImport({
    hash,
    filename,
    source,
    sourceUrl,
    format: card.spec ? `chara_card_${card.spec}` : 'chara_card',
    spec: card.spec,
    detectedRole: verdict.role,
    confidence: verdict.confidence,
    analysis: verdict,
    original: JSON.stringify(card._original ?? null),
  });
  return { importId, plan, verdict };
}

/**
 * The plan, minus the workings.
 *
 * The signal counts are honest and occasionally interesting, but they are
 * not an explanation. What goes to the screen is what it thinks, how sure it
 * is, what else it might be, what is inside, and what it would make.
 */
function forTheScreen(plan) {
  return {
    role: plan.role,
    roleLabel: ROLES[plan.role]?.label || plan.role,
    confidence: plan.confidence,
    because: plan.because,
    alternatives: plan.alternatives.map((a) => ({
      role: a.role, label: ROLES[a.role]?.label || a.role, because: a.because,
    })),
    components: plan.components.map((c) => ({
      role: c.role, label: ROLES[c.role]?.label || c.role, because: c.because,
    })),
    parts: plan.parts.map((p) => ({ id: p.id, label: p.label, detail: p.detail })),
    resources: plan.resources,
    cast: plan.cast,
    starts: plan.starts.map((s) => ({ label: s.label, words: s.words })),
    format: plan.format,
    // Only the roles the classifier actually weighs and can defend. A role it
    // cannot judge must never appear as something to choose.
    choices: CHOOSABLE_ROLES.map((r) => ({ role: r, label: ROLES[r].label, hint: ROLES[r].hint })),
  };
}

/** Give every entry in a book a type, so the card view can group it. */
/**
 * A card whose picture is a link, not a file.
 *
 * Every card downloaded as JSON rather than as a PNG carries its art this
 * way: `avatar` is a URL on the site's image server. The importer read every
 * other field and skipped this one, so a card would arrive complete and
 * faceless, with nothing said about why.
 *
 * Fetched once and kept, rather than pointed at forever: the site may be
 * unreachable later, or from where you are, and a library that needs someone
 * else's server to draw itself is not a library. It goes in the picture
 * store rather than into the character row so that listing your characters
 * does not drag a megabyte of image along with it.
 */
async function fetchCardPicture(characterId, avatar, table = 'characters') {
  const url = String(avatar || '').trim();
  if (!url || url === 'none') return false;

  if (url.startsWith('data:image/')) {
    if (url.length <= 900_000) { db.setAvatar(table, characterId, url); return true; }
    return false;
  }
  if (!/^https?:\/\//i.test(url)) return false;

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return false;
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^image\//.test(mime)) return false;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length || bytes.length > 6_000_000) return false;

    const assetId = db.saveAsset({ storyId: null, kind: 'portrait', name: 'from the card', mime, bytes });
    db.setAvatar(table, characterId, `/api/assets/${assetId}`);
    return true;
  } catch {
    // A picture that cannot be fetched is worth a note, never a failed import.
    return false;
  }
}

function classifyBook(lorebookId) {
  for (const e of db.listEntries(lorebookId)) {
    if (e.kind && e.kind !== 'note') continue;
    const g = classifyEntry(e);
    db.setEntryKind(e.id, g.kind);
    // An entry that calls itself "User Persona" is you. Marking it here saves
    // finding it among hundreds and ticking the box by hand.
    if (g.playable && !e.playable) db.saveEntry(lorebookId, { id: e.id, playable: true });
  }
}

const summarizeAudit = (a) => a && ({
  total: a.total, enabled: a.enabled, disabled: a.disabled,
  duplicates: a.duplicates.length, unreachable: a.unreachable.length,
  alwaysOnCount: a.alwaysOnCount, alwaysOnTokens: a.alwaysOnTokens,
  alwaysOnTokensDeduped: a.alwaysOnTokensDeduped, totalTokens: a.totalTokens,
});

route('GET', '/api/characters/:id', async (req, res, { id }) => {
  const c = db.getCharacter(id);
  if (!c) throw new HttpError(404, 'No such character.');
  return c;
});
route('DELETE', '/api/characters/:id', async (req, res, { id }) => { db.deleteCharacter(id); return { ok: true }; });

/**
 * Write a character by hand.
 *
 * Until now the only way in was a file, which meant a character who only
 * exists in your head had to be laundered through some other app first.
 */
route('POST', '/api/characters', async (req) => {
  const c = await readJson(req);
  if (!String(c.name || '').trim()) throw new HttpError(400, 'Give them a name.');
  const id = db.writeCharacter({ ...c, name: c.name.trim() });
  if (c.avatar) db.setAvatar('characters', id, c.avatar);
  return { id };
});

// --- lorebooks

route('GET', '/api/lorebooks/:id', async (req, res, { id }) => {
  const b = db.getLorebook(id);
  if (!b) throw new HttpError(404, 'No such lorebook.');
  return b;
});
route('POST', '/api/lorebooks', async (req) => {
  const { name, description } = await readJson(req);
  if (!String(name || '').trim()) throw new HttpError(400, 'Give the lorebook a name.');
  return { id: db.createLorebook(name.trim(), description || '') };
});
route('DELETE', '/api/lorebooks/:id', async (req, res, { id }) => { db.deleteLorebook(id); return { ok: true }; });
route('POST', '/api/lorebooks/:id/entries', async (req, res, { id }) => {
  const entry = await readJson(req);
  return { id: db.saveEntry(id, entry) };
});
route('DELETE', '/api/entries/:id', async (req, res, { id }) => { db.deleteEntry(id); return { ok: true }; });

/**
 * How organised a source is: unorganized, partial, organized, and whether any
 * approved entry has changed since review (needs_recheck, shown over the rest).
 * Computed from what is stored every time; there is no flag to go stale.
 */
route('GET', '/api/lorebooks/:id/organization', async (req, res, { id }) => {
  if (!db.getLorebook(id)) throw new HttpError(404, 'No such lorebook.');
  return sourceOrganization(db, id);
});

/** A lorebook as the card view wants it: grouped, counted, costed. */
route('GET', '/api/lorebooks/:id/cards', async (req, res, { id }) => {
  const b = db.getLorebook(id);
  if (!b) throw new HttpError(404, 'No such lorebook.');

  const groups = {};
  let pinnedTokens = 0;
  let pinnedCount = 0;
  for (const e of b.entries) {
    (groups[e.kind] ||= []).push(cardOf(e));
    if (e.constant && e.enabled) { pinnedCount++; pinnedTokens += estimateTokens(e.content); }
  }
  return {
    id: b.id,
    name: b.name,
    description: b.description,
    kinds: KINDS,
    weights: WEIGHTS,
    groups,
    counts: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])),
    total: b.entries.length,
    pinned: { count: pinnedCount, tokens: pinnedTokens, limit: PIN_LIMIT },
  };
});

const PIN_LIMIT = 10;

const cardOf = (e) => ({
  id: e.id, kind: e.kind, title: e.title || e.keys[0] || 'Untitled',
  summary: e.summary || e.content.slice(0, 150),
  keys: e.keys, enabled: e.enabled, constant: e.constant,
  playable: e.playable, order: e.order, traits: e.traits,
  linked: e.linked, image: e.image,
  tokens: estimateTokens(e.content),
});

route('GET', '/api/entries/:id', async (req, res, { id }) => {
  const row = db.raw.prepare('SELECT lorebook_id FROM lore_entries WHERE id=?').get(id);
  if (!row) throw new HttpError(404, 'No such entry.');
  const e = db.listEntries(row.lorebook_id).find((x) => x.id === id);
  return { ...e, lorebookId: row.lorebook_id, tokens: estimateTokens(e.content) };
});

/** Read a pasted block and fill in what can be worked out from it. */
route('POST', '/api/lore/parse', async (req) => {
  const { text } = await readJson(req);
  const parsed = parsePasted(text);
  if (!parsed) throw new HttpError(400, 'Nothing to read there.');
  return { ...parsed, tokens: estimateTokens(parsed.content) };
});

/** Re-guess what an entry is, when you have rewritten it. */
route('POST', '/api/lore/classify', async (req) => {
  const entry = await readJson(req);
  return classifyEntry(entry);
});

/**
 * Move entries that are really instructions out of the lorebook and into the
 * story's standing instructions, where they are cached and stop competing
 * with the world for room.
 */
route('POST', '/api/stories/:id/absorb-directions', async (req, res, { id }) => {
  const { entryIds = [] } = await readJson(req);
  const story = db.getStory(id);
  if (!story) throw new HttpError(404, 'No such story.');

  const settings = { ...DEFAULTS, ...story.settings };
  const norm = (t) => String(t).replace(/\s+/g, ' ').trim().toLowerCase();

  // Anything already in the instructions counts as seen, so moving the same
  // entries twice, or tapping the button twice, cannot double the text.
  const seen = new Set();
  const existing = String(settings.directions || '');
  for (const block of existing.split(/\n{2,}/)) if (block.trim()) seen.add(norm(block));

  const texts = [];
  let moved = 0;
  for (const eid of entryIds) {
    const row = db.raw.prepare('SELECT lorebook_id, content FROM lore_entries WHERE id=?').get(eid);
    if (!row) continue;
    const key = norm(row.content);
    if (!seen.has(key)) { seen.add(key); texts.push(row.content.trim()); }
    db.saveEntry(row.lorebook_id, { id: eid, enabled: false });
    moved++;
  }

  settings.directions = [existing, ...texts].filter(Boolean).join('\n\n').trim();
  db.updateStory(id, { settings });

  return {
    moved,
    kept: texts.length,
    duplicatesSkipped: moved - texts.length,
    tokens: estimateTokens(settings.directions),
  };
});

/**
 * Instructions sitting in the lorebook that would be better off in the
 * story's standing instructions.
 *
 * Only ALWAYS-ON ones. A keyword-triggered instruction — guidance for how to
 * write a particular kind of scene — is exactly right where it is: it loads
 * when that scene happens and costs nothing the rest of the time. Moving
 * those into the standing instructions would send all of them, always.
 */
route('GET', '/api/stories/:id/directions', async (req, res, { id }) => {
  const entries = db.entriesForStory(id);
  // Approved semantics decide what counts as an instruction; kind only for
  // entries nobody has organised. Absorbing still waits for the person.
  const views = semanticViews(db, entries);
  const directions = entries.filter((e) => isDirection(e, views.get(e.id)));
  const found = directions
    .filter((e) => e.constant)
    .map((e) => ({
      id: e.id, title: e.title || e.keys[0] || 'Untitled',
      tokens: estimateTokens(e.content), constant: true,
      summary: e.content.slice(0, 160),
    }))
    .sort((a, b) => b.tokens - a.tokens);
  const seen = new Set();
  let duplicated = 0;
  for (const f of found) { if (seen.has(f.title)) duplicated++; else seen.add(f.title); }
  return {
    entries: found,
    totalTokens: found.reduce((a, f) => a + f.tokens, 0),
    alwaysOnTokens: found.reduce((a, f) => a + f.tokens, 0),
    duplicated,
    // Left alone on purpose, and worth saying so.
    triggeredCount: directions.length - found.length,
  };
});

/** Re-read every entry in a book and re-file it by type. */
route('POST', '/api/lorebooks/:id/reclassify', async (req, res, { id }) => {
  const { onlyUntouched = true } = await readJson(req);
  const book = db.getLorebook(id);
  if (!book) throw new HttpError(404, 'No such lorebook.');
  const changes = [];
  db.transaction(() => {
    for (const e of book.entries) {
      // A type you set by hand is never overwritten unless you ask.
      if (onlyUntouched && e.kind && e.kind !== 'note') continue;
      const g = classifyEntry(e);
      if (g.playable && !e.playable) db.saveEntry(id, { id: e.id, playable: true });
      if (g.kind === e.kind) continue;
      db.setEntryKind(e.id, g.kind);
      changes.push({ id: e.id, title: e.title || e.keys[0] || 'Untitled', from: e.kind, to: g.kind, because: g.because });
    }
  });
  return { changed: changes.length, of: book.entries.length, changes: changes.slice(0, 200) };
});

/** Do the same thing to a lot of entries at once. */
route('POST', '/api/lorebooks/:id/bulk', async (req, res, { id }) => {
  const { entryIds = [], action, kind, target, newName } = await readJson(req);
  if (!Array.isArray(entryIds) || !entryIds.length) throw new HttpError(400, 'Nothing selected.');
  const book = db.getLorebook(id);
  if (!book) throw new HttpError(404, 'No such lorebook.');

  const mine = new Set(book.entries.map((e) => e.id));
  const ids = entryIds.filter((x) => mine.has(x));
  let done = 0;

  // Copying is its own thing: it writes to a different book, and it can make
  // that book on the spot, so it does not belong in the per-entry loop below.
  if (action === 'copy') {
    let toId = target;
    let made = null;
    if (!toId) {
      const name = String(newName || '').trim();
      if (!name) throw new HttpError(400, 'Say which lorebook to copy into, or name a new one.');
      toId = db.createLorebook(name, `Built from ${book.name}.`);
      made = { id: toId, name };
    }
    const to = db.getLorebook(toId);
    if (!to) throw new HttpError(404, 'No such lorebook to copy into.');
    if (toId === id) throw new HttpError(400, 'That is the book they are already in.');
    const r = db.copyEntries(id, toId, ids);
    return { ...r, done: r.copied, into: { id: toId, name: to.name }, made };
  }

  db.transaction(() => {
    for (const eid of ids) {
      if (action === 'delete') { db.deleteEntry(eid); done++; continue; }
      if (action === 'disable' || action === 'enable') {
        db.saveEntry(id, { id: eid, enabled: action === 'enable' });
        done++; continue;
      }
      if (action === 'pin' || action === 'unpin') {
        db.saveEntry(id, { id: eid, constant: action === 'pin' });
        done++; continue;
      }
      if (action === 'retype') {
        if (!KINDS[kind]) throw new HttpError(400, 'Unknown type.');
        db.setEntryKind(eid, kind);
        done++; continue;
      }
      throw new HttpError(400, 'Unknown action.');
    }
  });
  return { done, skipped: entryIds.length - ids.length };
});

/** Try an entry against some text without saving anything. */
route('POST', '/api/lore/test', async (req) => {
  const { entries = [], text = '', settings = {} } = await readJson(req);
  const { activate } = await import('./src/engine/lorebook.js');
  const res = activate(entries, [{ role: 'user', name: 'You', content: text }], {
    budget: settings.loreBudget ?? DEFAULTS.loreBudget,
    scanDepth: settings.scanDepth ?? DEFAULTS.scanDepth,
    recursive: settings.recursive ?? true,
    messageCount: 20,
    countTokens: estimateTokens,
  });
  return {
    fired: res.entries.map((e) => ({ id: e.id, title: e.title, tokens: estimateTokens(e.content) })),
    trace: res.trace,
    tokens: res.tokens,
    overflowed: res.overflowed,
  };
});

// --- stories

route('POST', '/api/stories', async (req) => {
  const b = await readJson(req);

  // A reviewed composition says exactly who is in the story and in what part.
  // Without one, the first card given leads, as it always has.
  const composition = b.composition && typeof b.composition === 'object' ? b.composition : null;
  const generated = composition?.generated && typeof composition.generated === 'object' ? composition.generated : null;
  let characterIds = b.characterIds || [];
  let cardRoles = null;
  // A generated lead with no card, whose card the person asked to be made.
  const generatedLead = (generated?.items || []).find((i) => i && i.type === 'person' && i.role === 'lead');
  if (composition) {
    const cards = (composition.casting || []).filter((c) => c.characterId)
      .map((c) => ({ characterId: c.characterId, role: normalizeRole(c.role) }))
      .filter((c) => CAST_ROLES.includes(c.role));
    const leads = cards.filter((c) => c.role === 'lead');
    if (leads.length + (generatedLead ? 1 : 0) > 1) throw new HttpError(400, 'A story has one lead. Choose which of them it is.');
    if (!leads.length && !generatedLead) throw new HttpError(400, 'Choose who leads the story. The lead needs a character card.');
    characterIds = [...leads.map((c) => c.characterId), ...cards.filter((c) => c.role !== 'lead').map((c) => c.characterId)];
    cardRoles = cards;
  }
  if (!characterIds.length && !generatedLead) throw new HttpError(400, 'Pick at least one character.');
  const cardLead = generatedLead ? null : db.getCharacter(characterIds[0]);
  if (!generatedLead && !cardLead) throw new HttpError(404, 'That character is no longer in the library.');

  // Who you play. Said outright when the person was asked, including "nobody";
  // only a caller that never asked gets the old convenience of the one persona.
  let personaId = b.personaId || null;
  if (!('personaId' in b)) {
    const personas = db.listPersonas();
    if (personas.length === 1) personaId = personas[0].id;
  }
  if (personaId && !db.getPersona(personaId)) throw new HttpError(404, 'That persona is no longer saved.');
  const persona = personaId ? db.getPersona(personaId) : null;

  // Checked before anything is written, then written as one.
  const plan = composition
    ? planComposition(db, {
      lorebookIds: b.lorebookIds || [],
      casting: composition.casting || [],
      links: composition.links || [],
      recursion: composition.recursion || {},
      exclude: composition.exclude || [],
      include: composition.include || [],
    })
    : null;
  const pool = new Map((b.lorebookIds || []).flatMap((bid) => db.listEntries(bid)).map((e) => [e.id, e]));
  const genPlan = generated
    ? planGenerated(db, {
      items: generated.items || [],
      links: generated.links || [],
      poolIds: new Set(pool.keys()),
      castNames: namesInPlay(characterIds, pool),
      allowLead: true,
    })
    : null;

  // Open on the reviewed opening if there is one; otherwise on the lead's
  // greeting, so there is something to answer. The greeting is stored as it
  // will be read, names filled in, because history is sent to the model
  // verbatim and shown to you verbatim.
  const reviewedOpening = typeof composition?.opening?.text === 'string' ? composition.opening.text.trim() : '';
  if (reviewedOpening.length > BUILDER_HARD.openingChars) throw new HttpError(400, 'That opening is too long.');
  const chosen = b.startingPointId && cardLead
    ? db.startingPoints('character', cardLead.id).find((p) => p.id === b.startingPointId)
    : null;
  const opening = reviewedOpening || chosen?.content || cardLead?.first_message || '';
  const reviewedPremise = typeof composition?.story?.premise === 'string' ? composition.story.premise.trim().slice(0, BUILDER_HARD.premiseChars) : '';

  // The story, its cast, its sources, its generated material, its links and
  // its first message are one write. If any of it fails, none of it happened.
  const id = db.transaction(() => {
    const leadCardId = genPlan?.lead ? createLeadCard(db, genPlan.lead) : null;
    const ids = leadCardId ? [leadCardId, ...characterIds] : characterIds;
    const lead = leadCardId ? db.getCharacter(leadCardId) : cardLead;
    const title = b.title?.trim() || (typeof composition?.story?.title === 'string' && composition.story.title.trim().slice(0, BUILDER_HARD.storyTitleChars)) || lead.name;
    const storyId = db.createStory({
      title,
      characterIds: ids,
      lorebookIds: plan ? [] : (b.lorebookIds || []),
      personaId,
      // A new story starts with the ladder in place. Stories that existed
      // before it did are left alone: their closeness was scored under the old
      // rules, so switching it on for them is a decision, not a default.
      settings: {
        ...DEFAULTS,
        arc: { ...memory.ARC_DEFAULTS, ladder: memory.DEFAULT_LADDER },
        secrets: { ...memory.SECRET_DEFAULTS },
        // What you set once in the app's own settings, so a new story starts
        // the way you like rather than the way it shipped.
        ...db.getSetting('story_defaults', {}),
        ...(reviewedPremise ? { premise: reviewedPremise } : {}),
        ...(b.settings || {}),
      },
    });
    if (cardRoles) {
      for (const c of cardRoles.filter((x) => x.role !== 'lead')) db.setStoryCharacterRole(storyId, c.characterId, c.role);
    }
    if (plan) writeComposition(db, storyId, plan);
    if (genPlan) writeGenerated(db, storyId, genPlan, { title, builder: composition.builder || {}, leadCardId });
    if (opening) {
      const greeting = substitute(opening, {
        char: lead.nickname || lead.name,
        user: persona ? persona.name : 'You',
      });
      db.addMessage({ storyId, role: 'assistant', content: greeting });
    }
    return storyId;
  });
  return { id };
});

/** Every name already in a story's cast or material, so nobody is made twice. */
function namesInPlay(characterIds, pool) {
  const names = characterIds.map((cid) => db.getCharacter(cid)?.name).filter(Boolean);
  for (const e of pool.values()) {
    const v = personFromEntry(e);
    if (v.person) names.push(v.name);
  }
  return names;
}

route('GET', '/api/stories/:id', async (req, res, { id }) => {
  const s = db.getStory(id);
  if (!s) throw new HttpError(404, 'No such story.');
  const path = db.pathTo(s.head_id);
  return {
    ...s,
    settings: { ...DEFAULTS, ...s.settings },
    messages: path.map((m) => ({
      id: m.id, role: m.role, content: m.content, model: m.model,
      createdAt: m.created_at, editedAt: m.edited_at,
      siblings: db.siblingsOf(m.id).length,
    })),
  };
});

route('PATCH', '/api/stories/:id', async (req, res, { id }) => {
  const patch = await readJson(req);
  db.updateStory(id, patch);
  if (patch.lorebookIds) db.setStoryLorebooks(id, patch.lorebookIds);
  // The cast can change mid-story: someone arrives, someone is written out.
  if (Array.isArray(patch.characterIds)) db.setStoryCharacters(id, patch.characterIds);
  return { ok: true };
});
route('DELETE', '/api/stories/:id', async (req, res, { id }) => { db.deleteStory(id); return { ok: true }; });

route('POST', '/api/messages/:id/edit', async (req, res, { id }) => {
  const { content } = await readJson(req);
  db.editMessage(id, String(content ?? ''));
  return { ok: true };
});
route('DELETE', '/api/messages/:id', async (req, res, { id }) => { db.deleteMessage(id); return { ok: true }; });

/** Move to a different version of a message, which is how you change branch. */
route('GET', '/api/messages/:id/siblings', async (req, res, { id }) => db.siblingsOf(id));

route('POST', '/api/messages/:id/use', async (req, res, { id }) => {
  const m = db.getMessage(id);
  if (!m) throw new HttpError(404, 'No such message.');
  // Pick a version and you get back everything you had already written past
  // it, not just that one message. Follow the most recent child at each step
  // down to the end of that branch.
  let head = id;
  for (;;) {
    const child = db.raw.prepare(
      `SELECT id FROM messages WHERE parent_id=? ORDER BY created_at DESC LIMIT 1`
    ).get(head);
    if (!child) break;
    head = child.id;
  }
  db.updateStory(m.story_id, { headId: head });
  return { ok: true, headId: head };
});

// --- what would be sent, without sending it

route('GET', '/api/stories/:id/prompt', async (req, res, { id }) => {
  const built = assemble(id);
  const story = built.story;

  // Which lore entries belong to the world rather than to the story. Read
  // here rather than tracked through the engine, because the engine should
  // not care where an entry came from — only whether it fired.
  const fromWorld = new Set(
    story.framework_id ? db.entriesForFramework(story.framework_id).map((e) => e.id) : []
  );

  // The stable block is written as one string joined by rules. Splitting it
  // back apart is how this reports what is actually in the request rather
  // than what the code believes it put there.
  const stableMsg = built.messages.find((m) => m.role === 'system' && m._cache);
  const sections = String(stableMsg?.content || '').split('\n\n---\n\n').map((chunk) => {
    const head = chunk.startsWith('#') ? chunk.split('\n')[0].replace(/^#+\s*/, '') : 'Opening instructions';
    return { label: head, tokens: estimateTokens(chunk), chars: chunk.length };
  });

  const historyMsgs = built.messages.filter((m) => m.role !== 'system' || (!m._cache && !m._volatile && !m._episodes));
  const volatileMsg = built.messages.find((m) => m._volatile);

  return {
    report: built.report,
    // Where every part of the request came from, and what it cost.
    sources: {
      stable: sections,
      episodes: {
        count: built.report.episodes,
        tokens: built.report.episodeTokens,
      },
      history: {
        sent: built.report.messagesSent,
        dropped: built.report.messagesDropped,
        tokens: built.report.history,
        unremembered: built.report.unremembered,
      },
      volatile: {
        tokens: estimateTokens(volatileMsg?.content || ''),
        present: Boolean(volatileMsg),
      },
      lore: {
        fired: built.lore.entries.length,
        tokens: built.lore.tokens,
        budget: built.lore.budget,
        overflowed: built.lore.overflowed,
        fromWorld: built.lore.entries.filter((e) => fromWorld.has(e.id)).length,
        fromStory: built.lore.entries.filter((e) => !fromWorld.has(e.id)).length,
        available: { world: fromWorld.size, total: built.loreById.size },
      },
      framework: built.report.framework,
      messages: historyMsgs.length,
    },
    trace: built.lore.trace.map((t) => {
      const e = built.loreById.get(t.id);
      return { ...t, title: e?.title || '', keys: e?.keys || [], world: fromWorld.has(t.id) };
    }),
    messages: built.messages.map((m) => ({ role: m.role, content: m.content, volatile: !!m._volatile })),
  };
});

function assemble(storyId, extraUser = null, { openSecrets = null, mode = null } = {}) {
  const story = db.getStory(storyId);
  if (!story) throw new HttpError(404, 'No such story.');
  const settings = { ...DEFAULTS, ...story.settings };

  // The whole path, not the default 400. A story runs for thousands of
  // messages; the window is trimmed later, but the gap check needs to see
  // everything, and it needs each message's id to do it.
  const history = db.pathTo(story.head_id, 50000).map((m) => ({ id: m.id, role: m.role, content: m.content }));
  if (extraUser) history.push({ role: 'user', content: extraUser });

  // The entry your persona was built from is already sent as "who you play".
  // Leaving it in the lore as well would send the same text twice.
  const personaEntry = story.persona && story.persona.from_entry;

  // A story's own lore, plus the lore of the world it stands in.
  //
  // Read live rather than copied at creation, so improving a world reaches
  // the next message of every story using it. Merged by id, then handed to
  // the same activation engine as everything else: a world's book is not
  // injected, it becomes available to be retrieved, and a 300-entry campaign
  // costs nothing until something in the scene actually calls for it.
  const framework = story.framework_id ? db.getFramework(story.framework_id) : null;
  //
  // What this story has excluded is left out here, before activation, from
  // the story's books (inside entriesForStory) and from its world's alike.
  const excluded = db.storyExclusionIds(storyId);
  const byId = new Map();
  for (const e of db.entriesForStory(storyId)) byId.set(e.id, e);
  if (framework) for (const e of db.entriesForFramework(framework.id)) if (!byId.has(e.id) && !excluded.has(e.id)) byId.set(e.id, e);
  const loreEntries = [...byId.values()].filter((e) => e.id !== personaEntry);

  // What the story remembers: the world state, folded scenes, and any thread
  // that is due to resurface. Without this the memory engine writes
  // everything down and none of it ever reaches the model.
  const mem = memory.memoryFor(db, storyId, story.head_id, {
    cast: story.characters.map((c) => c.name),
    settings,
    openSecrets,
  });

  const built = buildPrompt({
    story, characters: story.characters, persona: story.persona,
    history, loreEntries, settings,
    timers: db.getSetting(`timers:${storyId}`, { sticky: {}, cooldown: {} }),
    authorNote: settings.authorNote || '',
    memory: mem,
    mode,
    framework: framework ? {
      name: framework.name,
      world: framework.world,
      narrator: framework.narrator,
      closing: framework.closing,
      depthNote: framework.depthNote,
      ensemble: framework.ensemble,
      loreCount: db.entriesForFramework(framework.id).length,
    } : null,
  });
  built.loreById = new Map(loreEntries.map((e) => [e.id, e]));
  built.story = story;
  built.settings = settings;
  built.memory = mem;
  return built;
}

// --- generating

route('POST', '/api/stories/:id/send', async (req, res, { id }) => {
  const { text = '', regenerateFrom = null } = await readJson(req);
  const key = apiKey();
  if (!key) throw new HttpError(400, 'No OpenRouter key set. Put it in the .env file and restart.');

  const story = db.getStory(id);
  if (!story) throw new HttpError(404, 'No such story.');

  // A regenerate starts from the same parent, so the old version is kept.
  // The head it had is remembered, so a failed attempt can put it back.
  const previousHead = story.head_id;
  let parentId = story.head_id;
  if (regenerateFrom) {
    const m = db.getMessage(regenerateFrom);
    if (!m || m.story_id !== id) throw new HttpError(404, 'No such message in this story.');
    parentId = m.parent_id;
    db.updateStory(id, { headId: parentId });
  } else if (text.trim()) {
    parentId = db.addMessage({ storyId: id, parentId, role: 'user', content: text.trim() });
  }

  let built;
  try {
    built = assemble(id);
  } catch (e) {
    if (regenerateFrom) db.updateStory(id, { headId: previousHead });
    throw e;
  }
  const settings = built.settings;
  const cast = story.characters.map((c) => c.name);
  const persona = story.persona ? story.persona.name : null;

  // ---- the gate ------------------------------------------------------------
  // Before anything is written, decide which hidden things this turn is
  // allowed to touch. Whatever does not open is not in the prompt at all, so
  // it cannot be said by accident. Costs one short call, and only when there
  // is something hidden with its holder in the scene.
  let secretsNote = null;
  const secretCfg = { ...memory.SECRET_DEFAULTS, ...(settings.secrets || {}) };
  if (secretCfg.on && built.memory?.state) {
    const hot = memory.hotSecrets(built.memory.state, {
      present: built.memory.present || [],
      from: secretCfg.from,
    });
    // Nothing hot in the scene still means the gate is running: a hidden
    // fact whose holder is elsewhere has no mouth to come out of, but it
    // would still be sitting in the text for the narrator to reach for.
    if (!hot.length) {
      try { built = assemble(id, null, { openSecrets: [] }); } catch { /* keep */ }
    } else {
      const scene = built.messages.filter((m) => m.role !== 'system').slice(-3);
      if (process.env.GATE_DEBUG) {
        console.error('[gate] secrets=', hot.map((h) => h.text.slice(0, 60)));
        console.error('[gate] scene=', scene.map((m) => `${m.role}: ${String(m.content).slice(0, 90)}`));
      }
      const g = await memory.gate({
        apiKey: key,
        model: secretCfg.model || settings.memory?.model || 'deepseek/deepseek-v4-flash',
        secrets: hot,
        exchange: scene,
        persona,
      });
      if (process.env.GATE_DEBUG) console.error('[gate] verdict=', JSON.stringify(g.open), g.why);
      secretsNote = {
        held: hot.length - g.open.length,
        opened: g.open.length,
        why: g.why,
        openText: g.open.map((id) => hot.find((h) => h.id === id)?.text).filter(Boolean),
      };
      // Rebuild with the verdict. No model call: this is folding and string
      // building, so it costs a millisecond and keeps one path through the
      // prompt builder rather than two.
      try {
        built = assemble(id, null, { openSecrets: g.open });
      } catch { /* keep the ungated build rather than fail the turn */ }
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

  send('start', {
    userMessageId: text.trim() && !regenerateFrom ? parentId : null,
    report: built.report,
    fired: built.lore.entries.map((e) => ({ id: e.id, title: e.title })),
    secrets: secretsNote,
  });

  // Stop and disconnect both arrive as the response closing, not the request:
  // the request's own 'close' has already fired by the time its body was read.
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });

  const keep = (content, result, stopped) => {
    const msgId = db.addMessage({
      storyId: id, parentId, role: 'assistant', content,
      model: result?.model || settings.model,
      meta: { usage: result?.usage, provider: result?.provider, finish: stopped ? 'stopped' : result?.finishReason },
    });
    db.setSetting(`timers:${id}`, built.lore.timers);
    return msgId;
  };

  try {
    const result = await stream({
      apiKey: key,
      model: settings.model,
      messages: built.messages,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      topP: settings.topP ?? 1,
      frequencyPenalty: settings.frequencyPenalty || 0,
      presencePenalty: settings.presencePenalty || 0,
      topK: settings.topK || 0,
      minP: settings.minP || 0,
      topA: settings.topA || 0,
      repetitionPenalty: settings.repetitionPenalty || 0,
      onDelta: (piece) => send('delta', piece),
      signal: controller.signal,
    });

    if (!result.text.trim()) {
      if (regenerateFrom) db.updateStory(id, { headId: previousHead });
      send('error', { message: 'The model returned nothing at all. Try again, or switch model.' });
      res.end();
      return null;
    }

    const msgId = keep(result.text, result, false);
    send('done', {
      id: msgId,
      model: result.model,
      provider: result.provider,
      finish: result.finishReason,
      usage: result.usage,
      cost: result.usage?.cost ?? null,
    });

    // The memory pass runs after the reply is already on screen, so it never
    // makes you wait for it. Whatever it finds lands before your next message.
    runMemory(id, msgId, settings, cast, persona)
      .then((r) => { if (r) send('remembered', r); })
      .catch((e) => send('memory-error', { message: e.message }))
      .finally(() => res.end());
    return null;
  } catch (e) {
    if (e.name === 'AbortError') {
      // Stopped mid-reply. What arrived is kept as a reply of its own.
      const partial = String(e.partial || '').trim();
      if (partial) keep(partial, null, true);
      else if (regenerateFrom) db.updateStory(id, { headId: previousHead });
      res.end();
      return null;
    }
    if (regenerateFrom) db.updateStory(id, { headId: previousHead });
    send('error', {
      message: e instanceof ModelError ? e.message : 'Something went wrong while writing the reply.',
      retryable: e.retryable ?? false,
    });
    res.end();
  }
  return null; // response already written
});

/**
 * Two ways to move the story without typing.
 *
 * "Write my turn" hands you words for your own character, into the box, NOT
 * onto the page. You read them, change them, and send them yourself, so the
 * rule that this app never writes for you survives: it offers, you decide.
 *
 * "Carry on" extends the last reply. What comes back is glued onto the end of
 * that message rather than becoming a new one, which is what makes it a
 * continuation and not a second paragraph that repeats the first.
 */
for (const mode of ['impersonate', 'continue']) {
  route('POST', `/api/stories/:id/${mode}`, async (req, res, { id }) => {
    const key = apiKey();
    if (!key) throw new HttpError(400, 'No OpenRouter key set.');
    const story = db.getStory(id);
    if (!story) throw new HttpError(404, 'No such story.');

    const head = story.head_id ? db.getMessage(story.head_id) : null;
    if (mode === 'continue' && (!head || head.role !== 'assistant')) {
      throw new HttpError(400, 'There is no reply to carry on from. The last thing on the page is yours.');
    }

    const built = assemble(id, null, { mode });
    const settings = built.settings;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    try {
      const result = await stream({
        apiKey: key,
        model: settings.model,
        messages: built.messages,
        temperature: settings.temperature,
        // Your own line is a line, not a scene. Asking for a thousand tokens
        // of it gets you a monologue you then have to cut down.
        maxTokens: mode === 'impersonate' ? Math.min(400, settings.maxTokens) : settings.maxTokens,
        topP: settings.topP ?? 1,
        frequencyPenalty: settings.frequencyPenalty || 0,
        presencePenalty: settings.presencePenalty || 0,
        onDelta: (piece) => send('delta', piece),
        signal: controller.signal,
      });

      const text = result.text.trim();
      if (!text) { send('error', { message: 'Nothing came back. Try again.' }); res.end(); return null; }

      if (mode === 'continue') {
        // Glued on, with a space only where one is actually needed.
        const joiner = /[\s]$/.test(head.content) || /^[\s,.;:!?)]/.test(text) ? '' : ' ';
        db.editMessage(head.id, head.content + joiner + text);
        send('done', { id: head.id, appended: text, usage: result.usage, cost: result.usage?.cost ?? null });
      } else {
        // Not stored. It goes into the box for you to change or throw away.
        send('done', { text, usage: result.usage, cost: result.usage?.cost ?? null });
      }
      res.end();
      return null;
    } catch (e) {
      if (e.name === 'AbortError') { res.end(); return null; }
      send('error', { message: e instanceof ModelError ? e.message : 'Something went wrong.' });
      res.end();
      return null;
    }
  });
}

/**
 * Read the newest exchange, and fold older scenes once they pile up.
 * A failure is remembered so the memory screen can say so, rather than
 * silently producing no memory at all.
 */
async function runMemory(storyId, messageId, settings, cast, persona) {
  const key = apiKey();
  try {
    const out = await memory.remember(db, { storyId, messageId, apiKey: key, settings, cast, persona });
    const folded = await memory
      .fold(db, { storyId, headId: messageId, apiKey: key, settings, persona })
      .catch((e) => ({ folded: 0, failed: 0, error: e.message }));
    db.setSetting(`memory_error:${storyId}`, null);
    if (folded.error) db.setSetting(`memory_error:${storyId}`, { message: `Folding scenes failed: ${folded.error}`, at: Date.now() });
    if (!out) return folded.folded ? { folded: folded.folded } : null;
    return {
      summary: out.delta.summary,
      facts: (out.delta.facts || []).length,
      threads: (out.delta.threads || []).length,
      newNames: (out.newNames || []).map((n) => n.name),
      folded: folded.folded,
    };
  } catch (e) {
    db.setSetting(`memory_error:${storyId}`, { message: e.message, at: Date.now() });
    throw e;
  }
}

// --- personas

route('POST', '/api/personas', async (req) => {
  const { id, name, description, avatar } = await readJson(req);
  if (!String(name || '').trim()) throw new HttpError(400, 'Give your character a name.');
  return { id: db.savePersona({ id, name: name.trim(), description, avatar }) };
});
route('GET', '/api/personas/:id', async (req, res, { id }) => {
  const p = db.getPersona(id);
  if (!p) throw new HttpError(404, 'No such persona.');
  return p;
});

/**
 * Everyone you could play in this story: the characters you have written,
 * plus any lore entry you marked "this is me".
 */
route('GET', '/api/stories/:id/playable', async (req, res, { id }) => {
  const story = db.getStory(id);
  if (!story) throw new HttpError(404, 'No such story.');

  const saved = db.listPersonas().map((p) => ({
    id: p.id, name: p.name, description: p.description, avatar: p.avatar,
    fromEntry: p.from_entry || null, missingEntry: !!p.missingEntry,
  }));
  const linked = new Set(saved.map((p) => p.fromEntry).filter(Boolean));

  // Marked in the lore but not yet turned into a persona.
  const offered = db.playableForStory(id)
    .filter((e) => !linked.has(e.id))
    .map((e) => ({
      entryId: e.id,
      name: e.title || (e.keys[0] || 'Unnamed'),
      description: e.content,
      tokens: estimateTokens(e.content),
    }));

  return { personas: saved, offered, current: story.persona_id || null };
});

/** Turn a lore entry marked "this is me" into the character you play. */
route('POST', '/api/stories/:id/playable/:entryId', async (req, res, { id, entryId }) => {
  const story = db.getStory(id);
  if (!story) throw new HttpError(404, 'No such story.');
  const entry = db.playableForStory(id).find((e) => e.id === entryId);
  if (!entry) throw new HttpError(404, 'That entry is not marked as you, or its book is not in this story.');

  const existing = db.personaForEntry(entryId);
  const personaId = existing
    ? existing.id
    : db.savePersona({ name: entry.title || 'You', description: entry.content, fromEntry: entryId });

  db.updateStory(id, { personaId });
  return { id: personaId, persona: db.getPersona(personaId) };
});
route('DELETE', '/api/personas/:id', async (req, res, { id }) => { db.deletePersona(id); return { ok: true }; });

// --- portraits

route('POST', '/api/avatar/:kind/:id', async (req, res, { kind, id }) => {
  const { dataUri } = await readJson(req);
  const table = kind === 'character' ? 'characters' : kind === 'persona' ? 'personas' : null;
  if (!table) throw new HttpError(400, 'Unknown kind.');
  if (dataUri && !/^data:image\/(png|jpeg|webp);base64,/.test(dataUri)) {
    throw new HttpError(400, 'That does not look like an image.');
  }
  if (dataUri && dataUri.length > 900_000) {
    throw new HttpError(413, 'That picture is too big even after shrinking. Try a smaller one.');
  }
  db.setAvatar(table, id, dataUri || null);
  return { ok: true };
});

// --- pictures for a story

/** Served as a real image so the page can use it as a background. */
route('GET', '/api/assets/:id', async (req, res, { id }) => {
  const a = db.getAsset(id);
  if (!a) throw new HttpError(404, 'No such picture.');
  res.writeHead(200, {
    'Content-Type': a.mime,
    'Content-Length': a.bytes.length,
    // Ids never change once written, so this can be cached hard.
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  res.end(Buffer.from(a.bytes));
  return null;
});

route('POST', '/api/stories/:id/assets', async (req, res, { id }) => {
  const story = db.getStory(id);
  if (!story) throw new HttpError(404, 'No such story.');
  const ct = String(req.headers['content-type'] || '');
  if (!/^image\/(png|jpeg|webp)$/.test(ct)) throw new HttpError(400, 'Send a PNG, JPEG or WebP image.');
  const bytes = await readBody(req);
  if (!bytes.length) throw new HttpError(400, 'That picture was empty.');
  if (bytes.length > 6 * 1024 * 1024) throw new HttpError(413, 'That picture is too big. Six megabytes is the limit.');
  const assetId = db.saveAsset({
    storyId: id,
    kind: String(req.headers['x-kind'] || 'background'),
    name: decodeURIComponent(String(req.headers['x-filename'] || '')),
    mime: ct,
    bytes,
  });
  return { id: assetId, url: `/api/assets/${assetId}`, size: bytes.length };
});

route('GET', '/api/stories/:id/assets', async (req, res, { id }) => ({
  assets: db.listAssets(id).map((a) => ({ ...a, url: `/api/assets/${a.id}` })),
}));

route('DELETE', '/api/assets/:id', async (req, res, { id }) => { db.deleteAsset(id); return { ok: true }; });

// --- presets

route('GET', '/api/presets', async () => {
  const saved = db.listPresets();
  const have = new Set(saved.map((p) => p.id));
  const builtin = BUILTIN_PRESETS.filter((b) => !have.has(b.id))
    .map((b) => ({ ...b, builtin: 1 }));
  return { presets: [...builtin, ...saved], keys: PRESET_KEYS };
});

route('POST', '/api/presets', async (req) => {
  const { id, name, settings } = await readJson(req);
  if (!String(name || '').trim()) throw new HttpError(400, 'Give the preset a name.');
  const clean = {};
  for (const k of PRESET_KEYS) if (settings && settings[k] !== undefined) clean[k] = settings[k];
  return { id: db.savePreset({ id, name: name.trim(), settings: clean }) };
});
route('DELETE', '/api/presets/:id', async (req, res, { id }) => { db.deletePreset(id); return { ok: true }; });

/** One preset in full, for the editor. */
route('GET', '/api/presets/:id', async (req, res, { id }) => {
  const saved = db.listPresets().find((p) => p.id === id);
  const preset = saved || BUILTIN_PRESETS.find((b) => b.id === id);
  if (!preset) throw new HttpError(404, 'No such preset.');
  const script = preset.settings?.script || null;
  return {
    id: preset.id,
    name: preset.name,
    builtin: !saved,
    settings: preset.settings,
    script: script ? { ...script, controls: script.controls, items: script.items } : null,
    values: script ? { ...defaultValues(script), ...(preset.settings.dials || {}) } : {},
    cost: script ? costOf(script, { ...defaultValues(script), ...(preset.settings.dials || {}) }) : null,
  };
});

/**
 * Write a preset's prompt and controls back.
 *
 * Editing never touches a story that is already using it: a story carries its
 * own copy, taken when the preset was applied. That is on purpose. A preset
 * you tweak at two in the morning should not silently rewrite how a hundred
 * messages of an in-flight story were being told.
 */
route('POST', '/api/presets/:id/script', async (req, res, { id }) => {
  const body = await readJson(req);
  const parsed = parseScript(body.script || {});
  if (!parsed.ok) throw new HttpError(400, parsed.notes[0] || 'That preset could not be read.');

  const saved = db.listPresets().find((p) => p.id === id);
  const builtin = !saved && BUILTIN_PRESETS.find((b) => b.id === id);
  if (!saved && !builtin) throw new HttpError(404, 'No such preset.');

  const base = saved ? saved.settings : { ...builtin.settings };
  const values = { ...defaultValues(parsed.script), ...(body.values || base.dials || {}) };
  const newId = db.savePreset({
    id: saved ? id : undefined,          // editing a built-in makes your own copy
    name: parsed.script.name || (saved ? saved.name : builtin.name),
    settings: { ...base, script: parsed.script, dials: values, bundle: base.bundle ?? null },
  });
  return { ok: true, id: newId, forked: !saved, notes: parsed.notes, cost: costOf(parsed.script, values) };
});

route('POST', '/api/presets/:id/duplicate', async (req, res, { id }) => {
  const saved = db.listPresets().find((p) => p.id === id);
  const preset = saved || BUILTIN_PRESETS.find((b) => b.id === id);
  if (!preset) throw new HttpError(404, 'No such preset.');
  const { name } = await readJson(req);
  return { id: db.savePreset({ name: String(name || `${preset.name} copy`).trim(), settings: preset.settings }) };
});

/** The vocabulary a preset can write, for the reference panel in the editor. */
route('GET', '/api/macros', async () => ({
  groups: [
    {
      title: 'Names', hint: 'inline name references', macros: [
        { name: 'user', about: 'Your character\'s name.' },
        { name: 'char', about: 'The character\'s name.' },
      ],
    },
    {
      title: 'Story and context', hint: 'profiles, world info, history, memory', macros: [
        { name: 'persona', about: 'Your character\'s description.' },
        { name: 'character', about: 'The whole cast as sheets.' },
        { name: 'lorebook', about: 'Lore that fired this turn, plus everything always-on.' },
        { name: 'memory', about: 'Folded scenes from earlier in the story.' },
        { name: 'chatHistory', about: 'Every turn, as real messages. Put it exactly once.', structural: true },
        { name: 'chatHistoryLastN', about: 'Only the newest N turns, as plain text. Write the number: {{chatHistoryLast20}}.' },
        { name: 'lastMessage', about: 'The newest turn, as text.', volatile: true },
        { name: 'lastUserMessage', about: 'Your newest turn, as text.', volatile: true },
        { name: 'lastCharMessage', about: 'Their newest turn, as text.', volatile: true },
      ],
    },
    {
      title: 'Date and time', hint: 'read from your clock as the prompt is built', macros: [
        { name: 'time', about: 'e.g. 6:02 PM', volatile: true },
        { name: 'date', about: 'e.g. August 22, 2026', volatile: true },
        { name: 'weekday', about: 'e.g. Saturday', volatile: true },
        { name: 'isotime', about: '24-hour HH:MM', volatile: true },
        { name: 'isodate', about: 'YYYY-MM-DD', volatile: true },
      ],
    },
    {
      title: 'Character fields', hint: 'one card field at a time', macros: [
        { name: 'description', about: 'The description field on its own.' },
        { name: 'personality', about: 'The personality field on its own.' },
        { name: 'scenario', about: 'The setting field.' },
        { name: 'charFirstMessage', about: 'Their opening message.' },
        { name: 'mesExamples', about: 'Example dialogue, with <START> replaced by your separator.' },
        { name: 'mesExamplesRaw', about: 'Example dialogue exactly as the card wrote it.' },
        { name: 'charPrompt', about: "The card's own system prompt." },
        { name: 'charInstruction', about: "The card's post-history instructions." },
        { name: 'charVersion', about: "The card's version tag." },
        { name: 'charCreatorNotes', about: "The card's creator notes." },
        { name: 'charCreator', about: 'Who made the card.' },
      ],
    },
  ],
  volatileNote: 'A block holding one of these is sent after the conversation instead of in the cached part, because its value changes every turn. It costs a little more; putting it above would re-charge the whole prompt each time it moves.',
}));

/**
 * Worked examples you can download, read and take apart.
 *
 * Served rather than described, because the fastest way to understand a
 * format is to import one that works and open it in the editor.
 */
route('GET', '/api/templates', async () => {
  const files = [
    { file: 'example-character.json', name: 'A character, with every field explained', about: 'Import it, then open it and read the creator notes: they say what each field is for and which ones quietly override your settings.' },
    { file: 'example-lorebook.json', name: 'A lorebook, one entry per idea', about: 'Ten entries, each demonstrating a different kind of thing you might want to write, and when it fires.' },
  ];
  return {
    templates: files.filter((t) => existsSync(join('templates', t.file))).map((t) => ({
      ...t,
      url: `/api/templates/${t.file}`,
      bytes: readFileSync(join('templates', t.file)).length,
    })),
  };
});

route('GET', '/api/templates/:file', async (req, res, { file }) => {
  // Name only, resolved inside the folder, so a path cannot climb out of it.
  const safe = String(file).replace(/[^\w.-]/g, '');
  const path = join(process.cwd(), 'templates', safe);
  if (!path.startsWith(join(process.cwd(), 'templates')) || !existsSync(path)) throw new HttpError(404, 'No such example.');
  const body = readFileSync(path);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${safe}"`,
    'Content-Length': body.length,
  });
  res.end(body);
  return null;
});

/**
 * Commit a file that was held back for a look.
 *
 * The role may be whatever you say it is. The classifier's reading is kept on
 * the import record either way, so overruling it is recorded rather than
 * erased, and the file can be read again later under a different reading.
 */
route('POST', '/api/import/commit', async (req) => {
  const { importId, role = null } = await readJson(req);
  const rec = db.getImport(String(importId || ''));
  if (!rec) throw new HttpError(404, 'That import is not on record.');
  if (rec.committed_at) throw new HttpError(409, 'That file has already been brought in.');
  if (role && !CHOOSABLE_ROLES.includes(role)) throw new HttpError(400, 'That is not something a file can be brought in as.');

  let original;
  try { original = JSON.parse(rec.original); } catch { original = null; }
  if (!original) throw new HttpError(422, 'The original file could not be read back.');

  const card = normalizeCard(original, rec.filename);
  const verdict = classifyCard(card, { format: card.spec });
  const plan = planFor(card, verdict, role);
  const { created, primary } = applyPlan(db, { card, plan, importId: rec.id });

  // Whatever lore came along gets its entries typed, exactly as a lorebook
  // imported on its own would.
  for (const c of created.filter((x) => x.kind === 'lorebook')) classifyBook(c.id);

  // A card whose art is a link still gets its picture, whatever it turned out
  // to be. A campaign module has a cover as surely as a person has a face,
  // and dropping it because the file was not a person would be losing
  // something the file plainly had.
  const TABLE = { character: 'characters', framework: 'frameworks', scenario: 'scenarios' };
  let picture = false;
  if (card.avatar && TABLE[primary.kind]) {
    picture = await fetchCardPicture(primary.id, card.avatar, TABLE[primary.kind]);
  }

  return {
    kind: primary.kind, id: primary.id, importId: rec.id,
    name: card.name,
    role: plan.role,
    overridden: plan.overridden,
    picture,
    created,
    detail: plan.resources.map((r) => `${r.label} — ${r.detail}`).join('; '),
  };
});

/** What one file turned into, and what it said before it turned into it. */
route('GET', '/api/imports/:id', async (req, res, { id }) => {
  const rec = db.getImport(id);
  if (!rec) throw new HttpError(404, 'No such import.');
  return {
    id: rec.id, filename: rec.filename, source: rec.source, format: rec.format,
    detectedRole: rec.detected_role, chosenRole: rec.chosen_role,
    confidence: rec.confidence, analysis: rec.analysis,
    committedAt: rec.committed_at, createdAt: rec.created_at,
    resources: rec.resources,
  };
});

// ------------------------------------------------------- frameworks & scenarios

route('GET', '/api/frameworks', async () => ({ frameworks: db.listFrameworks() }));

route('GET', '/api/frameworks/:id', async (req, res, { id }) => {
  const f = db.getFramework(id);
  if (!f) throw new HttpError(404, 'No such framework.');
  return {
    ...f,
    lorebooks: f.lorebookIds.map((bid) => db.getLorebook(bid)).filter(Boolean)
      .map((b) => ({ id: b.id, name: b.name, entries: b.entries.length })),
    // Every story built on this world. They share it; they share nothing else.
    stories: db.listStories().filter((s) => s.framework_id === id)
      .map((s) => ({ id: s.id, title: s.title })),
  };
});

route('DELETE', '/api/frameworks/:id', async (req, res, { id }) => {
  db.deleteFramework(id);
  return { ok: true };
});

route('GET', '/api/scenarios', async () => ({ scenarios: db.listScenarios() }));

route('GET', '/api/scenarios/:id', async (req, res, { id }) => {
  const s = db.getScenario(id);
  if (!s) throw new HttpError(404, 'No such scenario.');
  return {
    ...s,
    framework: s.framework_id ? db.getFramework(s.framework_id) : null,
    lorebooks: s.lorebookIds.map((bid) => db.getLorebook(bid)).filter(Boolean)
      .map((b) => ({ id: b.id, name: b.name, entries: b.entries.length })),
  };
});

route('DELETE', '/api/scenarios/:id', async (req, res, { id }) => {
  db.deleteScenario(id);
  return { ok: true };
});

/**
 * Begin a story from a scenario.
 *
 * A copy, not a link. What the scenario knows is carried across once; what
 * happens afterwards belongs to the story alone, and two stories started from
 * the same scenario have nothing to do with each other.
 */
route('POST', '/api/scenarios/:id/start', async (req, res, { id }) => {
  const { title = null, personaId = null, startingPointId = null } = await readJson(req);
  const out = startFromScenario(db, id, {
    title, personaId, startingPointId, settings: { ...DEFAULTS },
  });
  return { ok: true, storyId: out.storyId, cast: out.cast, usedStartingPoint: out.usedStartingPoint };
});

/**
 * Begin a story in a framework's world.
 *
 * The world is used, not copied: the story points at it and keeps its own
 * continuity. Which is the whole difference between a campaign and a
 * playthrough of one.
 */
route('POST', '/api/frameworks/:id/start', async (req, res, { id }) => {
  const f = db.getFramework(id);
  if (!f) throw new HttpError(404, 'No such framework.');
  const { title = null, personaId = null, startingPointId = null, characterIds = [] } = await readJson(req);

  let chosenPersona = personaId;
  if (!chosenPersona) {
    const personas = db.listPersonas();
    if (personas.length === 1) chosenPersona = personas[0].id;
  }

  const storyId = db.createStory({
    title: title || f.name,
    characterIds,
    lorebookIds: f.lorebookIds,
    personaId: chosenPersona,
    settings: {
      ...DEFAULTS,
      arc: { ...memory.ARC_DEFAULTS, ladder: memory.DEFAULT_LADDER },
      secrets: { ...memory.SECRET_DEFAULTS },
      ...db.getSetting('story_defaults', {}),
    },
    frameworkId: f.id,
  });

  const points = f.startingPoints || [];
  const chosen = points.find((p) => p.id === startingPointId) || points[0] || null;
  if (chosen?.content) db.addMessage({ storyId, role: 'assistant', content: chosen.content });

  return { ok: true, storyId, usedStartingPoint: chosen?.id || null };
});

/**
 * The whole story, composed.
 *
 * A view over what already exists, never a copy of it. Nothing here is
 * stored: the cast comes from story_characters, the sections from the type
 * each lore entry was already given, the sources from story_lorebooks, and
 * what the model can see right now from the same compiler the reply uses.
 *
 * The one rule it keeps: it never infers membership. Sixty-one people are
 * written about in this story's books and twenty-two are never named in it,
 * so "people the story knows about" and "the cast" are different counts and
 * are reported as different things.
 */
route('GET', '/api/stories/:id/bible', async (req, res, { id }) => {
  const story = db.getStory(id);
  if (!story) throw new HttpError(404, 'No such story.');
  const settings = { ...DEFAULTS, ...story.settings };

  const entries = db.entriesForStory(id);
  const framework = story.framework_id ? db.getFramework(story.framework_id) : null;
  const excludedIds = db.storyExclusionIds(id);
  const worldEntries = framework ? db.entriesForFramework(framework.id).filter((w) => !excludedIds.has(w.id)) : [];
  const pool = [...entries, ...worldEntries.filter((w) => !entries.some((e) => e.id === w.id))];

  // The headings people use are not the nine types the engine stores. This
  // is the mapping, and it lives here rather than in the database, because a
  // heading is a way of reading and a type is what a thing is.
  const SECTIONS = [
    { id: 'places', label: 'Locations', kinds: ['place'] },
    { id: 'factions', label: 'Factions', kinds: ['faction'] },
    { id: 'backstory', label: 'Backstory', kinds: ['premise'] },
    { id: 'rules', label: 'Rules', kinds: ['rule'] },
    { id: 'events', label: 'Events', kinds: ['event'] },
    { id: 'items', label: 'Things', kinds: ['item'] },
    { id: 'directions', label: 'Directions', kinds: ['direction'] },
    { id: 'other', label: 'Other', kinds: ['note'] },
  ];
  const brief = (e) => ({
    id: e.id, title: e.title || '(untitled)', kind: e.kind,
    summary: e.summary || '', always: !!e.constant,
    keys: (e.keys || []).slice(0, 4), tokens: estimateTokens(e.content),
  });
  // Approved semantics place an entry; kind places the rest, as before.
  const views = semanticViews(db, pool);
  const sectionOf = (e) => {
    const v = views.get(e.id);
    if (v?.authoritative) return semanticSection(v);
    return SECTIONS.find((s) => s.kinds.includes(e.kind))?.id || null;
  };
  const sections = SECTIONS.map((s) => {
    const list = pool.filter((e) => sectionOf(e) === s.id);
    return {
      ...s,
      count: list.length,
      always: list.filter((e) => e.constant).length,
      tokens: list.reduce((n, e) => n + estimateTokens(e.content), 0),
      items: list.slice(0, 60).map(brief),
    };
  }).filter((s) => s.count);

  // Everyone with a card and a part. Not everyone the books mention.
  const cast = story.characters.map((c) => ({
    id: c.id, name: c.name, role: c.story_role || 'cast', avatar: c.avatar,
    tokens: estimateTokens(`${c.description}${c.personality}${c.scenario}`),
  }));
  const knownPeople = pool.filter((e) => (views.get(e.id)?.authoritative ? sectionOf(e) === 'casting' : e.kind === 'character'));
  // People in the cast who have no card: chosen in review, standing on an entry.
  const npcs = db.storyNpcs(id).map((n) => ({
    entryId: n.entry_id, name: nameFromTitle(n.title).name || n.title, role: n.role, lorebookId: n.lorebook_id,
    tokens: Math.ceil((n.chars || 0) / 4),
  }));

  // Books this story uses, and books related to it that it does not.
  const connected = story.lorebookIds.map((bid) => {
    const b = db.getLorebook(bid);
    const pol = db.storyLorebookSettings(id).find((r) => r.lorebook_id === bid);
    return b && {
      id: b.id, name: b.name, entries: b.entries.length,
      recursion: pol?.recursion || 'default',
      from: b.from_character ? (db.getCharacter(b.from_character)?.name || null) : null,
      // This story's own package from the Story Builder, shown as such rather than by its book name.
      madeForThisStory: storyPackage(db, id)?.id === b.id,
    };
  }).filter(Boolean);
  // Books the story does NOT use but that plainly belong to the same material:
  // they came from a card of somebody in the cast, or they are named after
  // them. Offered, never connected — provenance suggests, it does not decide.
  const castNames = story.characters.map((c) => String(c.name).toLowerCase());
  const cardsByName = new Set(db.listCharacters()
    .filter((c) => castNames.some((n) => n.includes(String(c.name).toLowerCase())
      || String(c.name).toLowerCase().includes(n)))
    .map((c) => c.id));
  const related = db.listLorebooks()
    .filter((b) => !story.lorebookIds.includes(b.id) && (
      (b.from_character && cardsByName.has(b.from_character))
      || castNames.some((n) => n.length > 4 && String(b.name).toLowerCase().includes(n))
    ))
    .map((b) => ({
      id: b.id, name: b.name, entries: b.entry_count,
      why: b.from_character ? 'came in with a card of theirs' : 'named after them',
    }));

  // What it is now, from the memory the story already keeps.
  const state = memory.stateAt(db, story.head_id);
  const ui = memory.stateSummaryForUi(state, { playerName: story.persona ? story.persona.name : '' });

  return {
    id: story.id,
    title: story.title,
    premise: settings.premise || '',
    cover: story.art || null,
    persona: story.persona ? { id: story.persona.id, name: story.persona.name, avatar: story.persona.avatar } : null,
    cast,
    npcs,
    // Material this story ignores. Still in its source, not in this story.
    excluded: db.storyExclusions(id).map((x) => ({
      entryId: x.entry_id, title: nameFromTitle(x.title).name || x.title, kind: x.kind, lorebookId: x.lorebook_id,
    })),
    lead: cast.find((c) => c.role === 'lead') || null,
    knownPeople: { count: knownPeople.length, sample: knownPeople.slice(0, 12).map(brief) },
    sections,
    sources: { connected, related },
    framework: framework ? { id: framework.id, name: framework.name } : null,
    live: {
      where: state.scene.where || '',
      when: state.clock.display || '',
      who: (state.scene.who || []).map((w) => ui.characters.find((c) => c.id === w)?.name || w),
      facts: ui.counts.facts,
      threads: ui.counts.threads,
      messages: db.pathTo(story.head_id, 100000).length,
    },
    totals: {
      eligible: pool.length,
      alwaysOn: pool.filter((e) => e.constant).length,
    },
  };
});

/**
 * Read a source package into a story draft.
 *
 * Writes nothing. Adding a source used to mean one row and everything inside
 * it stayed invisible; this says who and what is in there, in the sections a
 * person thinks in, so the next screen can show it and be argued with.
 *
 * `storyId` is optional: during creation there is no story yet, and the draft
 * is built without a transcript to weigh names against.
 */
route('POST', '/api/compose', async (req) => {
  const {
    lorebookIds = [], storyId = null, mode = 'organize',
    characterIds = [], premise = '', startingPointId = null,
  } = await readJson(req);

  const story = storyId ? db.getStory(storyId) : null;
  if (storyId && !story) throw new HttpError(404, 'No such story.');
  const books = lorebookIds.map((id) => db.getLorebook(id)).filter(Boolean);
  if (books.length !== lorebookIds.length) throw new HttpError(404, 'One of those sources is no longer in the library.');
  const entries = books.flatMap((b) => b.entries);

  // A new story's evidence is what it will open on and what it says it is.
  // An existing story's is also what has been written in it.
  const leadCards = story ? [] : characterIds.map((id) => db.getCharacter(id)).filter(Boolean);
  const chosen = !story && startingPointId && leadCards[0]
    ? db.startingPoints('character', leadCards[0].id).find((p) => p.id === startingPointId)
    : null;

  const draft = composeSource(entries, {
    characters: db.listCharacters(),
    storyCards: story ? story.characters : [],
    leadCards,
    transcript: story ? db.pathTo(story.head_id, 100000).map((m) => m.content).join('\n') : '',
    premise: story ? (story.settings?.premise || '') : premise,
    opening: story ? '' : (chosen?.content || leadCards[0]?.first_message || ''),
    storyNpcs: story ? db.storyNpcs(story.id) : [],
    storyExclusions: story ? db.storyExclusionIds(story.id) : new Set(),
    semantics: semanticViews(db, entries),
    mode,
  });

  return {
    ...draft,
    sources: books.map((b) => ({ id: b.id, name: b.name, entries: b.entries.length })),
  };
});

/**
 * Make a reviewed draft real, for a story that already exists.
 *
 * Connects the sources, records who is in the story and what each piece of
 * material is about, in one transaction. It copies no entry and edits none,
 * and the cards already in the story are left as they are.
 */
route('POST', '/api/stories/:id/compose', async (req, res, { id }) => {
  const body = await readJson(req);
  const generated = body.generated && typeof body.generated === 'object' ? body.generated : null;
  if (body.opening) throw new HttpError(400, 'An existing story already began. Its opening is part of the story and is not replaced.');
  if (!generated) return { ok: true, ...applyToStory(db, id, body) };

  // Source changes and accepted generated material, as one write.
  const out = db.transaction(() => {
    const result = applyToStory(db, id, body);
    const story = db.getStory(id);
    const pool = new Map(story.lorebookIds.flatMap((bid) => db.listEntries(bid)).map((e) => [e.id, e]));
    const genPlan = planGenerated(db, {
      items: generated.items || [],
      links: generated.links || [],
      poolIds: new Set(pool.keys()),
      castNames: namesInPlay(story.characters.map((c) => c.id), pool),
      allowLead: false,
    });
    const written = writeGenerated(db, id, genPlan, { title: story.title, builder: body.builder || {} });
    return { ...result, generatedBook: written.bookId, generatedEntries: Object.keys(written.entryIds).length, npcs: db.storyNpcs(id).length };
  });
  return { ok: true, ...out };
});

// ============================================================ story builder
//
// Drafts only. Nothing on these routes writes to the database: a draft goes
// back to the client, is reviewed there, and becomes real through
// POST /api/stories or POST /api/stories/:id/compose like any other draft.

/** Which model plans stories. Its own setting; the roleplay and memory models are untouched. */
function builderSettings() {
  const saved = db.getSetting('builder', {});
  const storyDefaults = db.getSetting('story_defaults', {});
  return {
    model: saved.model || storyDefaults.model || DEFAULTS.model,
    temperature: Number.isFinite(saved.temperature) ? saved.temperature : 0.7,
    provider: saved.provider || null,
    configured: !!saved.model,
  };
}

route('GET', '/api/builder/settings', async () => builderSettings());

route('PUT', '/api/builder/settings', async (req) => {
  const b = await readJson(req);
  const next = { ...db.getSetting('builder', {}) };
  if (b.model !== undefined) {
    if (b.model !== null && (typeof b.model !== 'string' || !/^[\w.-]+\/[\w.:-]+$/.test(b.model))) throw new HttpError(400, 'That is not a model id.');
    next.model = b.model || undefined;
  }
  if (b.temperature !== undefined) {
    const t = Number(b.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) throw new HttpError(400, 'Temperature is between 0 and 2.');
    next.temperature = t;
  }
  if (b.provider !== undefined) {
    if (b.provider !== null && (typeof b.provider !== 'object' || Array.isArray(b.provider))) throw new HttpError(400, 'Provider routing must be an object.');
    next.provider = b.provider || undefined;
  }
  db.setSetting('builder', next);
  return builderSettings();
});

/** The model, as the builder sees it: messages in, parsed object out. */
function builderModel() {
  const key = apiKey();
  if (!key) throw new HttpError(400, 'Add your OpenRouter key in Settings to use the Story Builder.');
  const s = builderSettings();
  return async ({ messages, schema, maxTokens, signal }) => completeJson({
    apiKey: key, model: s.model, messages, schema, maxTokens, signal,
    temperature: s.temperature, provider: s.provider, title: 'Tipsy story builder',
  });
}

/**
 * The deterministic draft every mode starts from.
 *
 * New story: the chosen cards and sources. Existing story: its own cast and
 * books, and whatever it has already decided about them.
 */
function baseDraft({ storyId = null, lorebookIds = [], characterIds = [], premise = '', title = '', mode }) {
  const story = storyId ? db.getStory(storyId) : null;
  if (storyId && !story) throw new HttpError(404, 'No such story.');
  const bookIds = lorebookIds.length ? lorebookIds : (story ? story.lorebookIds : []);
  const books = bookIds.map((bid) => db.getLorebook(bid)).filter(Boolean);
  if (books.length !== bookIds.length) throw new HttpError(404, 'One of those sources is no longer in the library.');
  const leadCards = story ? [] : characterIds.map((cid) => db.getCharacter(cid)).filter(Boolean);
  if (leadCards.length !== (story ? 0 : characterIds.length)) throw new HttpError(404, 'One of those characters is no longer in the library.');

  const pooled = books.flatMap((bk) => bk.entries);
  const draft = composeSource(pooled, {
    characters: db.listCharacters(),
    storyCards: story ? story.characters : [],
    leadCards,
    transcript: story ? db.pathTo(story.head_id, 100000).map((m) => m.content).join('\n') : '',
    premise: story ? (story.settings?.premise || '') : premise,
    opening: story ? '' : (leadCards[0]?.first_message || ''),
    storyNpcs: story ? db.storyNpcs(story.id) : [],
    storyExclusions: story ? db.storyExclusionIds(story.id) : new Set(),
    semantics: semanticViews(db, pooled),
  });
  // A story with no sources and no transcript still has its cards: the
  // composer only knows it is "existing" from those.
  if (story) draft.context = 'existing';
  const base = fromComposition(draft, {
    mode,
    story: story
      ? { title: story.title, premise: story.settings?.premise || '', opening: null }
      : { title, premise, opening: leadCards[0]?.first_message || '' },
  });
  base.sources = books.map((bk) => ({ id: bk.id, name: bk.name, entries: bk.entries.length }));
  return base;
}

/**
 * The last word on a draft before it leaves the server.
 *
 * No draft the builder hands out ever carries a promotion: whatever a model
 * said, and whatever a client sent back in, `promote` is false here and only
 * a person's explicit choice at Apply can make a card. People the builder
 * proposed who share a name with a card in the library are noted, never
 * swapped in.
 */
function noteLibraryCards(draft) {
  const cards = db.listCharacters();
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  for (const r of draft.casting) {
    if ('promote' in r) r.promote = false;
    if (r.origin !== 'generated') continue;
    const card = cards.find((c) => norm(c.name) === norm(r.name));
    if (card) {
      r.libraryCardId = card.id;
      r.why = [...(r.why || []), 'a card with this name is in your library'];
    }
  }
  return draft;
}

/**
 * Build a draft.
 *
 * { mode: organize | fill | build, depth?, idea?, tone?, pointOfView?, instruction?,
 *   lorebookIds?, characterIds?, premise?, title?, storyId? }
 */
route('POST', '/api/builder/draft', async (req) => {
  const b = await readJson(req);
  const mode = b.mode || 'organize';
  if (!BUILDER_MODES.includes(mode)) throw new HttpError(400, `"${mode}" is not a Story Builder mode.`);
  if (b.depth !== undefined && !BUILDER_DEPTHS.includes(b.depth)) throw new HttpError(400, 'Depth is light, standard or deep.');
  const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const base = baseDraft({
    storyId: b.storyId || null,
    lorebookIds: Array.isArray(b.lorebookIds) ? b.lorebookIds : [],
    characterIds: Array.isArray(b.characterIds) ? b.characterIds : [],
    premise: text(b.premise, BUILDER_HARD.premiseChars),
    title: text(b.title, BUILDER_HARD.storyTitleChars),
    mode,
  });
  const draft = await buildDraft({
    mode, depth: b.depth, base,
    idea: text(b.idea, 4000), tone: text(b.tone, 200), pointOfView: text(b.pointOfView, 200), instruction: text(b.instruction, 1000),
    callModel: mode === 'organize' ? null : builderModel(),
  });
  return noteLibraryCards(draft);
});

/**
 * Help fill the gaps in a draft that is already being reviewed.
 *
 * Works on the draft as the person has it, edits and removals included, and
 * asks only for what that draft is missing. Nothing is written.
 *
 * { draft, depth?, instruction? }
 */
route('POST', '/api/builder/fill', async (req) => {
  const b = await readJson(req);
  const draft = checkDraft(b.draft);
  if (b.depth !== undefined && !BUILDER_DEPTHS.includes(b.depth)) throw new HttpError(400, 'Depth is light, standard or deep.');
  const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const out = await buildDraft({
    mode: 'fill', depth: b.depth || draft.generation?.depth, base: draft,
    instruction: text(b.instruction, 1000), callModel: builderModel(),
  });
  // Filling in keeps the draft what it was: an idea stays an idea.
  return noteLibraryCards({ ...out, mode: draft.mode || out.mode });
});

/**
 * Generate one part of a draft again.
 *
 * { draft, scope: { part } | { item: draftId } | { expand: draftId | { entryId } | { characterId } },
 *   depth?, instruction?, idea? }
 */
route('POST', '/api/builder/regenerate', async (req) => {
  const b = await readJson(req);
  const draft = checkDraft(b.draft);
  const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const out = await regenerate({
    draft, scope: b.scope, depth: b.depth,
    instruction: text(b.instruction, 1000), idea: text(b.idea, 4000),
    callModel: builderModel(),
  });
  return noteLibraryCards(out);
});

/** What taking a source out of a story would cost it, before it happens. */
route('GET', '/api/stories/:id/sources/:bookId', async (req, res, { id, bookId }) => {
  return sourceRemovalPreview(db, id, bookId, composeSource);
});

/**
 * Take a source out of a story.
 *
 * The book stays in the Library with every entry unchanged, and so does every
 * card and message. What goes is this story's connection to it, and the cast
 * memberships that stood on its entries.
 */
route('DELETE', '/api/stories/:id/sources/:bookId', async (req, res, { id, bookId }) => {
  return { ok: true, ...removeSource(db, id, bookId) };
});

/** Every way a character, scenario or framework can begin. */
route('GET', '/api/starts/:kind/:id', async (req, res, { kind, id }) => {
  if (!['character', 'scenario', 'framework'].includes(kind)) throw new HttpError(400, 'Not something with openings.');
  return { starts: db.startingPoints(kind, id) };
});

/** Put one straight into the library, without a round trip through Downloads. */
route('POST', '/api/templates/:file/use', async (req, res, { file }) => {
  const safe = String(file).replace(/[^\w.-]/g, '');
  const path = join(process.cwd(), 'templates', safe);
  if (!existsSync(path)) throw new HttpError(404, 'No such example.');
  const result = importFile(safe, readFileSync(path));
  if (result.kind === 'character') {
    const id = db.saveCharacter(result.data);
    for (const b of db.listLorebooks().filter((x) => x.from_character === id)) classifyBook(b.id);
    return { kind: 'character', id, name: result.name, detail: result.detail };
  }
  if (result.kind === 'lorebook') {
    const id = db.saveLorebook(result.data);
    classifyBook(id);
    return { kind: 'lorebook', id, name: result.name, detail: result.detail };
  }
  throw new HttpError(400, 'That example is not something the library holds.');
});

/**
 * Fetch a card or lorebook from a link.
 *
 * For anything reachable: a raw file on GitHub, a paste host, a direct image
 * link. Some sites refuse requests from outside a browser, or from certain
 * countries, and there is nothing this end can do about that except say so.
 */
route('POST', '/api/import/url', async (req) => {
  const { url } = await readJson(req);
  let target;
  try { target = new URL(String(url || '').trim()); } catch { throw new HttpError(400, 'That is not a link.'); }
  if (!/^https?:$/.test(target.protocol)) throw new HttpError(400, 'Only web links.');

  let res;
  try {
    res = await fetch(target, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json, image/png, */*' },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new HttpError(502, `Could not reach that link. ${e.message}`);
  }
  if (!res.ok) {
    throw new HttpError(502, res.status === 403
      ? 'That site refused the request. Some of them block anything that is not a browser, and a few block whole countries. Download the file yourself and drop it in instead.'
      : `That link came back ${res.status}.`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > 12_000_000) throw new HttpError(413, 'That file is too big.');
  const name = decodeURIComponent(target.pathname.split('/').pop() || 'downloaded');

  let result;
  try { result = importFile(name, bytes); } catch (e) {
    if (e instanceof ImportError) throw new HttpError(422, e.message);
    throw e;
  }
  if (result.kind === 'character') {
    const id = db.saveCharacter(result.data);
    const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50;
    if (isPng) {
      const b64 = Buffer.from(bytes).toString('base64');
      if (b64.length <= 900_000) db.setAvatar('characters', id, `data:image/png;base64,${b64}`);
    }
    for (const b of db.listLorebooks().filter((x) => x.from_character === id)) classifyBook(b.id);
    return { kind: 'character', id, name: result.name, detail: result.detail, notes: result.notes };
  }
  if (result.kind === 'lorebook') {
    const id = db.saveLorebook(result.data);
    classifyBook(id);
    return { kind: 'lorebook', id, name: result.name, detail: result.detail, notes: result.notes };
  }
  if (result.kind === 'preset') {
    const id = db.savePreset({ name: result.name, settings: { script: result.data, dials: defaultValues(result.data), bundle: null } });
    return { kind: 'preset', id, name: result.name, detail: result.detail, notes: result.notes };
  }
  throw new HttpError(422, 'That link is not a character, a lorebook or a preset.');
});

/** What a new story starts as. */
route('GET', '/api/defaults', async () => ({
  defaults: { ...DEFAULTS, ...db.getSetting('story_defaults', {}) },
  shipped: DEFAULTS,
}));
route('POST', '/api/defaults', async (req) => {
  const body = await readJson(req);
  const keep = {};
  for (const k of [...PRESET_KEYS, 'authorNote', 'arc', 'secrets', 'memory']) {
    if (body[k] !== undefined) keep[k] = body[k];
  }
  db.setSetting('story_defaults', keep);
  return { ok: true, defaults: { ...DEFAULTS, ...keep } };
});

// ------------------------------------------------------------------ memory

route('GET', '/api/stories/:id/memory', async (req, res, { id }) => {
  const story = db.getStory(id);
  if (!story) throw new HttpError(404, 'No such story.');
  const settings = { ...DEFAULTS, ...story.settings };
  const state = memory.stateAt(db, story.head_id);
  const path = db.pathTo(story.head_id);
  const now = path.length;

  const present = [
    ...(state.scene.who || []),
    ...Object.entries(state.characters).filter(([, c]) => c.present).map(([cid]) => cid),
  ];
  const recentText = path.slice(-4).map((m) => m.content).join('\n');

  const ui = memory.stateSummaryForUi(state, { playerName: story.persona ? story.persona.name : "" });
  ui.threads = ui.threads.map((t) => ({
    ...t,
    ...memory.explainThread(t, state, { now, present, recentText, where: state.scene.where }),
  }));

  return {
    ...ui,
    stats: db.memoryStats(id),
    gaps: memory.gaps(db, story.head_id, settings.historyLimit),
    episodes: db.episodesOnPath(story.head_id).map((e) => ({
      id: e.id, content: e.content, covers: e.covers.length, keys: e.keys, layer: e.layer,
    })),
    proposals: memory.loreProposals(db, id, story.head_id),
    corrections: db.overridesFor(id),
    tidyable: memory.tidyable(db, story.head_id).length,
    lastError: db.getSetting(`memory_error:${id}`, null),
    settings: { ...memory.MEMORY_DEFAULTS, ...(settings.memory || {}) },
  };
});

/** Catch up a story that was played before memory existed. Streams progress. */
route('POST', '/api/stories/:id/memory/backfill', async (req, res, { id }) => {
  const story = db.getStory(id);
  if (!story) throw new HttpError(404, 'No such story.');
  const key = apiKey();
  if (!key) throw new HttpError(400, 'No API key set.');
  const settings = { ...DEFAULTS, ...story.settings };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const todo = db.unreadOnPath(story.head_id);
  send('start', { total: todo.length });

  try {
    const r = await memory.backfill(db, {
      storyId: id, headId: story.head_id, apiKey: key, settings,
      cast: story.characters.map((c) => c.name),
      persona: story.persona ? story.persona.name : null,
      onProgress: (done, total) => send('progress', { done, total }),
    });
    if (r.stoppedEarly) db.setSetting(`memory_error:${id}`, { message: r.lastError, at: Date.now() });
    send('done', r);
  } catch (e) {
    send('error', { message: e.message });
  }
  res.end();
  return null;
});

/**
 * Read the last few messages and settle where the scene actually is.
 *
 * Cheap on purpose: one call over a short window, not a rebuild. The
 * sequential extractor reconstructs a story's history one exchange at a time
 * and is blind to a move nobody narrated; this reads several messages
 * together, which is the only way that kind of move is visible. It corrects
 * the current scene and nothing else, and it declines rather than guesses.
 */
route('POST', '/api/stories/:id/scene/reread', async (req, res, { id }) => {
  const story = db.getStory(id);
  if (!story) throw new HttpError(404, 'No such story.');
  const key = apiKey();
  if (!key) throw new HttpError(400, 'No API key set.');
  const { turns = 8 } = await readJson(req).catch(() => ({}));

  const settings = { ...DEFAULTS, ...story.settings };
  const cfg = { ...memory.MEMORY_DEFAULTS, ...(settings.memory || {}) };
  const path = db.pathTo(story.head_id, 100000);
  const state = memory.stateAt(db, story.head_id);

  const out = await memory.reconcileScene({
    apiKey: key,
    model: cfg.model,
    window: memory.sceneWindow(path, { turns: Math.max(4, Math.min(20, Number(turns) || 8)) }),
    state,
    persona: story.persona ? story.persona.name : null,
    providers: cfg.providers,
  });

  // A correction, stored the way every other hand correction is, so undoing
  // it undoes it and a later rebuild does not quietly overwrite it.
  if (out.applied) {
    db.addOverride(id, { afterId: story.head_id, path: 'scene/where', value: out.after, note: 'read back from the recent scene' });
  }
  return {
    applied: out.applied,
    before: out.before,
    after: out.after,
    reason: out.reason,
    confidence: out.confidence || null,
    present: out.who || state.scene.who,
    read: Math.min(path.length, Number(turns) || 8),
  };
});

/** Correct something memory got wrong. Corrections always win over extraction. */
route('POST', '/api/stories/:id/memory/correct', async (req, res, { id }) => {
  const body = await readJson(req);
  if (!body.path) throw new HttpError(400, 'Say what to correct.');
  const story = db.getStory(id);
  if (!story) throw new HttpError(404, 'No such story.');
  // Anchored to the message BEFORE the current reply. A correction is about
  // the state the reply was written against, so regenerating that reply
  // must not throw the correction away.
  const head = story.head_id ? db.getMessage(story.head_id) : null;
  const afterId = head ? (head.parent_id || head.id) : null;
  db.addOverride(id, { afterId, path: body.path, value: body.value, note: body.note });
  return { ok: true };
});

/** Threads that were only the scene moving, offered for closing. */
route('GET', '/api/stories/:id/memory/tidy', async (req, res, { id }) => {
  const story = db.getStory(id);
  if (!story) throw new HttpError(404, 'No such story.');
  return { threads: memory.tidyable(db, story.head_id) };
});

route('POST', '/api/stories/:id/memory/tidy', async (req, res, { id }) => {
  const { threadIds = [] } = await readJson(req);
  const story = db.getStory(id);
  if (!story) throw new HttpError(404, 'No such story.');
  const head = story.head_id ? db.getMessage(story.head_id) : null;
  const afterId = head ? (head.parent_id || head.id) : null;
  db.transaction(() => {
    for (const tid of threadIds) {
      db.addOverride(id, { afterId, path: `threads/${tid}/status`, value: 'faded', note: 'tidied away' });
    }
  });
  return { closed: threadIds.length };
});

route('DELETE', '/api/memory/overrides/:oid', async (req, res, { oid }) => {
  db.deleteOverride(oid);
  return { ok: true };
});

route('DELETE', '/api/memory/episodes/:eid', async (req, res, { eid }) => {
  db.deleteEpisode(eid);
  return { ok: true };
});

/** Turn a name the story invented into a real lore entry. */
route('POST', '/api/stories/:id/memory/accept-name', async (req, res, { id }) => {
  const { name, about, lorebookId } = await readJson(req);
  if (!String(name || '').trim()) throw new HttpError(400, 'No name given.');
  const story = db.getStory(id);
  if (!story) throw new HttpError(404, 'No such story.');
  // Only a book this story actually reads from, or the entry would never load.
  let book = lorebookId && story.lorebookIds.includes(lorebookId) ? lorebookId : story.lorebookIds[0];
  if (!book) {
    book = db.createLorebook(`${story.title} — discovered`, 'People and places the story invented as it went.');
    db.setStoryLorebooks(id, [...new Set([...story.lorebookIds, book])]);
  }
  const clean = String(name).trim();
  // Trigger on the whole name and each part of it, in any script; a
  // one-character Japanese name part is still a name part.
  const parts = clean.split(/\s+/).filter((w) => w.length >= 2 || /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(w));
  const entryId = db.saveEntry(book, {
    kind: 'character',
    title: clean,
    content: about || `${clean} appears in this story.`,
    summary: about || '',
    keys: [...new Set([clean, ...parts])],
    order: 100, constant: false, enabled: true,
  });
  return { id: entryId, lorebookId: book };
});

/** Switch memory on or off, and choose which model does the reading. */
// --- the dials a preset puts in front of you

/**
 * Everything the dials screen needs, in one request.
 *
 * Deliberately one: the screen opens over the story rather than replacing it,
 * so it has to be ready before the sheet finishes sliding up.
 */
route('GET', '/api/stories/:id/dials', async (req, res, { id }) => {
  const story = db.getStory(id);
  if (!story) throw new HttpError(404, 'No such story.');
  const settings = { ...DEFAULTS, ...story.settings };
  const script = settings.script && Array.isArray(settings.script.items) ? settings.script : null;
  if (!script) return { script: null, presets: db.listPresets().filter((p) => p.settings?.script).map((p) => ({ id: p.id, name: p.name })) };

  const values = { ...defaultValues(script), ...(settings.dials || {}) };
  const cost = costOf(script, values);
  return {
    script: {
      name: script.name,
      meta: script.meta,
      sections: script.sections,
      bundles: script.bundles,
      controls: script.controls,
    },
    values,
    bundle: settings.bundle || null,
    cost: cost.perControl,
    total: cost.total,
    changed: driftFrom(script, values, settings.bundle),
  };
});

route('POST', '/api/stories/:id/dials', async (req, res, { id }) => {
  const story = db.getStory(id);
  if (!story) throw new HttpError(404, 'No such story.');
  const settings = { ...story.settings };
  const script = settings.script && Array.isArray(settings.script.items) ? settings.script : null;
  if (!script) throw new HttpError(400, 'This story has no preset with controls in it.');

  const body = await readJson(req);
  let values = { ...defaultValues(script), ...(settings.dials || {}) };

  // Applying a ready-made setup is not the same as setting one control: it
  // replaces every value the setup names and leaves the rest at the author's
  // default, so "Slow burn" means the same thing however you got here.
  if (body.bundle !== undefined) {
    const b = (script.bundles || []).find((x) => x.id === body.bundle);
    if (body.bundle !== null && !b) throw new HttpError(400, 'No such setup in this preset.');
    values = b ? { ...defaultValues(script), ...b.values } : defaultValues(script);
    settings.bundle = b ? b.id : null;
  }
  if (body.values && typeof body.values === 'object') {
    const known = new Set(script.controls.map((c) => c.macro).filter(Boolean));
    for (const [k, v] of Object.entries(body.values)) if (known.has(k)) values[k] = v;
  }
  if (body.reset) {
    const base = settings.bundle
      ? { ...defaultValues(script), ...((script.bundles || []).find((x) => x.id === settings.bundle)?.values || {}) }
      : defaultValues(script);
    for (const macro of (Array.isArray(body.reset) ? body.reset : Object.keys(base))) {
      if (macro in base) values[macro] = base[macro];
    }
  }

  settings.dials = values;
  db.updateStory(id, { settings });
  const cost = costOf(script, values);
  return { ok: true, values, total: cost.total, cost: cost.perControl, changed: driftFrom(script, values, settings.bundle), bundle: settings.bundle || null };
});

/** Put a preset's prompt and controls onto this story. */
route('POST', '/api/stories/:id/use-preset', async (req, res, { id }) => {
  const story = db.getStory(id);
  if (!story) throw new HttpError(404, 'No such story.');
  const { presetId } = await readJson(req);
  const preset = db.listPresets().find((p) => p.id === presetId);
  if (!preset) throw new HttpError(404, 'No such preset.');
  const settings = { ...story.settings };
  for (const k of PRESET_KEYS) if (preset.settings[k] !== undefined) settings[k] = preset.settings[k];
  db.updateStory(id, { settings });
  return { ok: true, name: preset.name };
});

// --- the slow burn

route('GET', '/api/stories/:id/arc', async (req, res, { id }) => {
  const story = db.getStory(id);
  if (!story) throw new HttpError(404, 'No such story.');
  const settings = { ...DEFAULTS, ...story.settings };
  const stored = settings.arc || null;
  // A story that predates the ladder has none, and saying "on" for it would
  // be a lie: its closeness was scored under the old rules and nothing is
  // gating anything. Off until it is switched on deliberately.
  const arc = { ...memory.ARC_DEFAULTS, ...(stored || {}), on: stored ? stored.on !== false : false };
  arc.ladder = memory.ladderOf(arc);

  const state = memory.stateAt(db, story.head_id, { arc });
  const now = db.pathTo(story.head_id, 50000).length;

  // Everyone who could have a dial: the cast, the persona, and anyone the
  // story has actually put on the page.
  const people = new Map();
  const add = (name) => {
    const s = slugOf(name);
    if (s && !people.has(s)) people.set(s, { id: s, name });
  };
  for (const c of story.characters) add(c.name);
  if (story.persona) add(story.persona.name);
  for (const [sid, c] of Object.entries(state.characters)) {
    if (people.has(sid)) continue;
    // A story played without a persona set has the record calling you "user",
    // which is not a name and reads like a bug on a screen full of people.
    const isYou = sid === 'user' || sid === 'you';
    people.set(sid, {
      id: sid,
      name: isYou ? (story.persona ? story.persona.name : 'You') : (c.name || sid.replace(/-/g, ' ')),
    });
  }

  return {
    arc,
    secrets: { ...memory.SECRET_DEFAULTS, ...(settings.secrets || {}) },
    people: [...people.values()].map((p) => ({
      ...p,
      reluctance: Number(arc.reluctance?.[p.id]) || 0,
    })),
    standing: memory.standingSummary(state, arc, now),
    defaults: memory.DEFAULT_LADDER,
    messages: now,
    // Switching it on part-way through means recomputing every relationship
    // from the start under the new rules. Worth saying out loud first.
    fresh: !stored,
  };
});

route('POST', '/api/stories/:id/arc', async (req, res, { id }) => {
  const story = db.getStory(id);
  if (!story) throw new HttpError(404, 'No such story.');
  const body = await readJson(req);
  const settings = { ...story.settings };

  if (body.arc !== undefined) {
    const arc = { ...memory.ARC_DEFAULTS, ...(settings.arc || {}), ...body.arc };
    // Thresholds and waiting times are spread across however many stages
    // there are, so adding one never means working out a number by hand.
    arc.ladder = memory.respace(memory.ladderOf({ ...arc, ladder: arc.ladder }));
    arc.reluctance = Object.fromEntries(
      Object.entries(arc.reluctance || {})
        .map(([k, v]) => [slugOf(k), Math.max(0, Math.min(1, Number(v) || 0))])
        .filter(([k, v]) => k && v > 0),
    );
    settings.arc = arc;
  }
  if (body.secrets !== undefined) {
    settings.secrets = { ...memory.SECRET_DEFAULTS, ...(settings.secrets || {}), ...body.secrets };
  }

  db.updateStory(id, { settings });

  // A snapshot is the old pacing rules already applied and frozen. Leaving
  // them in place would mean a story that has already run keeps the standing
  // the old rules gave it, whatever ladder you write now.
  let rebuilt = null;
  if (body.arc !== undefined) {
    db.clearSnapshots(id);
    const story2 = db.getStory(id);
    const state = memory.stateAt(db, story2.head_id, { arc: settings.arc });
    const now = db.pathTo(story2.head_id, 50000).length;
    rebuilt = memory.standingSummary(state, settings.arc, now);
  }

  return { ok: true, arc: settings.arc, secrets: settings.secrets, standing: rebuilt };
});

/**
 * Put a pair on a rung by hand.
 *
 * For a story that was already running before any of this existed, or for
 * two people whose history happened off the page. Written as a correction,
 * which means it survives folding, applies from here forward, and can be
 * taken back later without leaving a mark.
 */
route('POST', '/api/stories/:id/arc/place', async (req, res, { id }) => {
  const story = db.getStory(id);
  if (!story) throw new HttpError(404, 'No such story.');
  const { a, b, stage } = await readJson(req);
  const settings = { ...DEFAULTS, ...story.settings };
  const arc = { ...memory.ARC_DEFAULTS, ...(settings.arc || {}) };
  const ladder = memory.ladderOf(arc);

  const from = slugOf(a);
  const to = slugOf(b);
  if (!from || !to) throw new HttpError(400, 'Name both people.');
  const rung = ladder.find((r) => r.name === stage);
  if (!rung) throw new HttpError(400, `There is no stage called "${stage}".`);

  // Stored as where this pair BEGINS, not as a correction pinning them
  // there. A correction would be re-applied on every fold and they could
  // never move again; a starting point is a floor they climb from.
  arc.start = { ...(arc.start || {}) };
  arc.start[[from, to].sort().join('|')] = rung.at;
  const settings2 = { ...story.settings, arc };
  db.updateStory(id, { settings: settings2 });
  db.clearSnapshots(id);

  const state = memory.stateAt(db, story.head_id, { arc });
  const now = db.pathTo(story.head_id, 50000).length;
  return {
    ok: true, stage: rung.name, score: rung.at,
    standing: memory.standingSummary(state, arc, now),
  };
});

route('POST', '/api/stories/:id/memory/settings', async (req, res, { id }) => {
  const body = await readJson(req);
  const story = db.getStory(id);
  if (!story) throw new HttpError(404, 'No such story.');
  const settings = { ...DEFAULTS, ...story.settings };
  const current = { ...memory.MEMORY_DEFAULTS, ...(settings.memory || {}) };
  // Only the fields that exist, only in the shapes they take. An empty model
  // name or a stray string where a switch should be must not turn memory off.
  const next = { ...current };
  if (typeof body.on === 'boolean') next.on = body.on;
  if (typeof body.proposeLore === 'boolean') next.proposeLore = body.proposeLore;
  if (typeof body.model === 'string' && body.model.trim()) next.model = body.model.trim();
  for (const k of ['snapshotEvery', 'foldAfter', 'foldSize', 'verbatimFloor']) {
    const v = Number(body[k]);
    if (Number.isFinite(v) && v > 0) next[k] = Math.round(v);
  }
  settings.memory = next;
  db.updateStory(id, { settings });
  return { ok: true, memory: settings.memory };
});

// --- settings and account

route('GET', '/api/settings', async () => ({
  defaults: DEFAULTS,
  hasKey: !!apiKey(),
  favouriteModels: db.getSetting('favourite_models', [
    'x-ai/grok-4.20',
    'deepseek/deepseek-v4-flash',
    'mistralai/mistral-large-2512',
    'xiaomi/mimo-v2.5-pro',
  ]),
}));

route('GET', '/api/models', async () => {
  const key = apiKey();
  const models = await listModels(key);
  return { models: models.filter((m) => !m.moderated && m.context >= 32000) };
});

route('GET', '/api/credits', async () => {
  const key = apiKey();
  if (!key) throw new HttpError(400, 'No API key set.');
  return credits(key);
});

// ------------------------------------------------------------------ server

const server = createServer(async (req, res) => {
  // A malformed Host header or a bad percent-escape in the path used to throw
  // here, outside any handler, and take the whole process down with it.
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    json(res, 400, { error: 'That address could not be read.' });
    return;
  }

  // ---- the door ------------------------------------------------------------
  // Checked once, here, before anything is dispatched. A gate applied route by
  // route is a gate with a hole in it the day somebody adds a route and
  // forgets.
  const open = OPEN_ROUTES.has(url.pathname)
    || (!url.pathname.startsWith('/api/') && OPEN_FILES.has(url.pathname));
  if (!open && !auth.allows(req)) {
    if (url.pathname.startsWith('/api/')) {
      json(res, 401, {
        error: auth.isSet()
          ? 'Locked. Reload the page and enter your password.'
          : 'This app has no password yet, so it only answers to your own network. Open it at home and set one.',
        locked: true,
      });
      return;
    }
    // Anything else gets the shell, which will draw the lock screen for itself.
    if (await serveStatic(req, res, '/index.html')) return;
    res.writeHead(401); res.end('Locked');
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.rx.exec(url.pathname);
      if (!m) continue;
      let params;
      try {
        params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      } catch {
        json(res, 400, { error: 'That address could not be read.' });
        return;
      }
      try {
        const out = await r.handler(req, res, params, url);
        if (out !== null && !res.headersSent) json(res, 200, out);
        else if (out !== null) res.end();
      } catch (e) {
        if (res.headersSent) { res.end(); return; }
        const status = e.status || (e instanceof ModelError ? 502 : 500);
        if (!e.status && !(e instanceof ModelError)) console.error(e);
        json(res, status, { error: e.message || 'Something went wrong.' });
      }
      return;
    }
    json(res, 404, { error: 'No such endpoint.' });
    return;
  }

  if (await serveStatic(req, res, url.pathname)) return;
  // Anything else is a page the app handles itself.
  if (await serveStatic(req, res, '/index.html')) return;
  res.writeHead(404); res.end('Not found');
});

/**
 * Which address your phone should actually use.
 *
 * A Windows PC usually reports several. Most of them are not real networks:
 * VPN meshes, virtual machine adapters and container bridges all show up here
 * and none are reachable from a phone on your wifi. Listing those beside the
 * real one just sends you down a dead end.
 */
function phoneAddresses() {
  const fake = /zerotier|virtualbox|vmware|hyper-v|wsl|docker|tailscale|loopback|tap-|npcap|bluetooth/i;
  const found = [];
  for (const [adapter, list] of Object.entries(networkInterfaces())) {
    for (const n of list || []) {
      if (!n || n.family !== 'IPv4' || n.internal) continue;
      if (n.address.startsWith('169.254.')) continue;   // no address was assigned
      found.push({ adapter, address: n.address, likely: !fake.test(adapter) });
    }
  }
  const home = (a) => /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(a);
  return found.sort((a, b) =>
    (b.likely - a.likely) || (home(b.address) - home(a.address)));
}

server.listen(PORT, '0.0.0.0', () => {
  const addrs = phoneAddresses();
  const s = db.stats();
  console.log(`\n  Tipsy is running. Leave this window open.\n`);
  console.log(`  On this computer   http://localhost:${PORT}`);

  const best = addrs.find((a) => a.likely);
  if (best) {
    console.log(`  On your phone      http://${best.address}:${PORT}`);
    console.log(`                     phone must be on the same wifi as this computer`);
  } else {
    console.log(`  On your phone      no ordinary network found - is this computer online?`);
  }

  const others = addrs.filter((a) => a !== best);
  if (others.length) {
    console.log(`\n  Not real networks, ignore these:`);
    for (const a of others) console.log(`    ${a.address}  (${a.adapter})`);
  }

  console.log(`\n  ${s.characters} characters, ${s.lorebooks} lorebooks, ${s.entries} lore entries, ${s.stories} stories`);
  console.log(`  ${apiKey() ? 'API key found.' : 'NO API KEY - put one in .env'}\n`);
});
