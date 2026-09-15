// The lock on the door.
//
// Until now this app listened on your own machine and that was the whole of
// its security. The moment it has an address anyone can type, three things
// are behind it: a month of your writing, the ability to spend your OpenRouter
// balance, and a key that is yours. So: one password, and nothing reaches any
// of it without one.
//
// Deliberately small. No accounts, no email, no reset flow, no third party.
// One person, one password, sessions you can end from any device.

import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const KEY = 'auth';
const SESSION_DAYS = 90;          // long, because retyping it on a phone is the thing that makes people turn it off
const MAX_SESSIONS = 12;
const LOCK_AFTER = 8;             // wrong guesses before that address has to wait
const LOCK_MS = 15 * 60 * 1000;

/** scrypt with per-password salt. Slow on purpose, so guessing is slow too. */
const derive = (password, salt) => scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

const sameString = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  // Compare in constant time even when the lengths differ, so the reply time
  // does not quietly tell anyone how much of a token they got right.
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createAuth(db) {
  const read = () => db.getSetting(KEY, null);
  const write = (v) => db.setSetting(KEY, v);

  // Failed attempts live in memory only. A restart forgives them, which is
  // fine: the point is to make a run of guesses slow, not to keep a ledger.
  const failures = new Map();

  const api = {
    /** Has a password been set at all? */
    isSet() {
      const a = read();
      return !!(a && a.hash && a.salt);
    },

    /**
     * Which side of the front door a request came from.
     *
     * Three answers, not two. The middle one is the whole point: your own
     * phone on your own wifi is not the machine the app runs on, and it is
     * not the internet either. Treating it as the internet locks you out of
     * your own app from the sofa; treating it as the machine would hand the
     * app to anyone who joins your wifi once a tunnel is up.
     *
     * A request that arrived through a proxy is ALWAYS the internet, whatever
     * its address says. A tunnel runs on this machine and connects to this
     * machine, so without this every stranger in the world would arrive
     * looking like 127.0.0.1.
     */
    zone(req) {
      const h = req.headers || {};
      if (h['x-forwarded-for'] || h['x-forwarded-proto'] || h['cf-connecting-ip'] || h['forwarded']) {
        return 'outside';
      }
      const ip = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
      if (ip === '::1' || /^127\./.test(ip)) return 'machine';
      if (/^10\./.test(ip)) return 'home';
      if (/^192\.168\./.test(ip)) return 'home';
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 'home';
      if (/^169\.254\./.test(ip)) return 'home';          // link-local
      if (/^f[cd]/i.test(ip)) return 'home';              // IPv6 unique local
      if (/^fe80:/i.test(ip)) return 'home';              // IPv6 link-local
      return 'outside';
    },

    /** The machine it runs on, or a device on your own network. */
    isLocal(req) {
      return api.zone(req) !== 'outside';
    },

    setPassword(password, { replaceSessions = true } = {}) {
      const pw = String(password || '');
      if (pw.length < 8) throw Object.assign(new Error('Use at least 8 characters.'), { status: 400 });
      const salt = randomBytes(16).toString('hex');
      const hash = derive(pw, salt).toString('hex');
      const old = read() || {};
      write({
        salt, hash,
        // Changing the password ends every session everywhere, which is the
        // only thing that makes changing it useful after a phone is lost.
        sessions: replaceSessions ? [] : (old.sessions || []),
        changedAt: Date.now(),
      });
    },

    check(password) {
      const a = read();
      if (!a || !a.hash) return false;
      const got = derive(String(password || ''), a.salt);
      const want = Buffer.from(a.hash, 'hex');
      return got.length === want.length && timingSafeEqual(got, want);
    },

    /** How long this address must wait, in milliseconds. Zero means go ahead. */
    lockedFor(req) {
      const f = failures.get(api.who(req));
      if (!f || f.count < LOCK_AFTER) return 0;
      return Math.max(0, f.until - Date.now());
    },

    who(req) {
      return req.socket?.remoteAddress || 'unknown';
    },

    noteFailure(req) {
      const k = api.who(req);
      const f = failures.get(k) || { count: 0, until: 0 };
      f.count++;
      if (f.count >= LOCK_AFTER) f.until = Date.now() + LOCK_MS;
      failures.set(k, f);
      return f;
    },

    forgive(req) { failures.delete(api.who(req)); },

    /**
     * Start a session. The token is returned once and never stored: only a
     * hash of it is kept, so the database on its own cannot let anyone in.
     */
    newSession(label = '') {
      const token = randomBytes(32).toString('base64url');
      const a = read() || {};
      const sessions = (a.sessions || []).filter((s) => s.until > Date.now());
      sessions.push({
        id: sha(token).slice(0, 12),
        token: sha(token),
        until: Date.now() + SESSION_DAYS * 86400_000,
        started: Date.now(),
        label: String(label).slice(0, 60),
      });
      write({ ...a, sessions: sessions.slice(-MAX_SESSIONS) });
      return token;
    },

    validSession(token) {
      if (!token) return false;
      const a = read();
      if (!a) return false;
      const want = sha(token);
      const hit = (a.sessions || []).find((s) => sameString(s.token, want));
      return !!(hit && hit.until > Date.now());
    },

    endSession(token) {
      const a = read();
      if (!a) return;
      const want = sha(token);
      write({ ...a, sessions: (a.sessions || []).filter((s) => !sameString(s.token, want)) });
    },

    endAllSessions() {
      const a = read();
      if (a) write({ ...a, sessions: [] });
    },

    listSessions() {
      const a = read() || {};
      return (a.sessions || [])
        .filter((s) => s.until > Date.now())
        .map((s) => ({ id: s.id, started: s.started, until: s.until, label: s.label }));
    },

    /** Whoever is asking: are they allowed in? */
    allows(req) {
      if (!api.isSet()) return api.isLocal(req);
      return api.validSession(readCookie(req, 'tipsy'));
    },
  };

  return api;
}

export function readCookie(req, name) {
  const raw = req.headers?.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * The cookie itself.
 *
 * HttpOnly so a stray script cannot read it. SameSite=Lax so another site
 * cannot make your browser act as you. Secure only when the request actually
 * arrived over HTTPS: setting it on plain localhost would make the browser
 * throw the cookie away and lock you out of your own machine.
 */
export function sessionCookie(token, req, { clear = false } = {}) {
  const https = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  const bits = [
    `tipsy=${clear ? '' : encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    clear ? 'Max-Age=0' : `Max-Age=${SESSION_DAYS * 86400}`,
  ];
  if (https) bits.push('Secure');
  return bits.join('; ');
}
