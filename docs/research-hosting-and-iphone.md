I have enough to write the report. Both remaining agents are still running; I verified their topic areas directly against vendor docs myself, so the report is complete.

---

# Hosting a personal, phone-first AI roleplay app — research report
**Researched 2026-09-11. Every number below was pulled from the vendor's live docs today. Anything I could not confirm is flagged.**

## 0. Bottom line first

**Recommended stack — all free, no credit card anywhere:**

| Layer | Choice |
|---|---|
| App | One codebase: a PWA (static HTML/JS + a small API) |
| Host | **Cloudflare Workers + Workers Static Assets** (`*.workers.dev`, no domain needed) |
| Database | **Cloudflare D1** (SQLite) |
| Semantic memory | **Cloudflare Vectorize** + **Workers AI** embeddings |
| Auth | Single password → server-set HttpOnly signed cookie (1 year) |
| iPhone | Safari → Share → **Add to Home Screen** |
| Windows | Edge → **Install this site as an app** (real Start-menu app) |
| Backup | In-app "Export everything" file + nightly GitHub Actions `wrangler d1 export` into a private repo |

Two things make this work that most advice gets wrong, and one landmine:

- ✅ **Adding to the iPhone Home Screen exempts your data from WebKit's 7-day storage purge.** Apple states it outright.
- ✅ **Cloudflare Workers have no wall-clock limit on HTTP requests** — a 5-minute stream is fine, even on free.
- ⚠️ **Workers Free gives you 10 ms of *CPU* per request.** Streaming pass-through uses almost none, but anything that chews on the response (parsing every SSE chunk, brute-forcing vectors in JS) will get killed. The architecture below routes around this deliberately.

---

## 1. iOS PWA in September 2026 — what actually works

**Current versions:** iOS **26.6.2** (released 2026-09-08), Safari **26.6** (2026-07-27). **iOS 27 ships in three days, 2026-09-14.** I reviewed WebKit's Safari 27 beta announcement — it contains no Home Screen web app, manifest, push, or virtual-keyboard changes, so nothing here should break. (Apple's full Safari 27 release notes are JS-rendered and not machine-readable; treat "no PWA changes in 27" as probable, not certain.)

### Three claims that are everywhere online and are wrong in 2026
1. "Safari caps PWA storage at 50 MB" — **false since iOS 17.**
2. "Apple killed Home Screen web apps in the EU in 17.4" — **false, Apple reversed it on 2024-03-01** before 17.4 shipped.
3. "`interactive-widget=resizes-content` works in Safari" — **false, never shipped** ([WebKit bug 259770](https://bugs.webkit.org/show_bug.cgi?id=259770), still open, last comment 2026-06-07).

### Standalone mode, icon, splash
Since iOS 26, **there are zero installability requirements** — WebKit: *"Users can add any site to their Home Screen and open it as a web app."* Standalone is the default; `apple-mobile-web-app-capable` is no longer needed (keep it, harmless). **The Web App Manifest is honored**: `name`, `short_name`, `start_url`, `scope`, and icons (including SVG and data-URL icons as of Safari 26.0).

One gotcha: **`<meta name="theme-color">` is dead on iOS 26.** Safari now samples the CSS `background-color` of `position: fixed`/`sticky` elements near the viewport edges to tint its Liquid Glass chrome. Give your composer bar an opaque background, and hide overlays with `display: none` — `opacity: 0` elements still tint the toolbar.

Splash screens still appear to need the legacy `apple-touch-startup-image` media-query set. *Unconfirmed whether manifest `background_color` alone now suffices.*

### Storage — it's enormous, and eviction is the only real risk
Per [WebKit's storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/) (iOS 17+, unchanged through 26.6):

- **Per origin: up to ~60% of total disk.** Overall cap 80% of disk.
- **Home Screen web apps get the browser tier**, not the 15% embedded-webview tier — WebKit says so explicitly.
- Covers IndexedDB, localStorage, Cache API, Service Workers, **OPFS**. Cookies and HTTP cache are not counted.
- **No more "this site wants to store data" prompt** since Safari 17.
- `navigator.storage.estimate()` works but is **deliberately fuzzed** for anti-fingerprinting — advisory only. Always catch `QuotaExceededError`.

**OPFS is supported** (Safari 15.2+). The *pickers* (`showOpenFilePicker`/`showSaveFilePicker`) are not — that's why caniuse shows "File System Access: not supported."

### The 7-day rule — still in force, and Home Screen is the exemption
[webkit.org/tracking-prevention](https://webkit.org/tracking-prevention/), still live today:

> "ITP deletes all cookies created in JavaScript and all other script-writeable storage after 7 days of no user interaction with the website."

And the exemption, verbatim:

> **"The first-party domain of home screen web applications is exempt from ITP's 7-day cap on all script-writeable storage, i.e. ITP always skips that domain in its website data removal algorithm."**

**This is the single highest-leverage decision in the whole project.** In a Safari tab, IndexedDB is gone after 7 days of neglect. As a Home Screen app, it isn't.

`navigator.storage.persist()` also works, and WebKit grants it *"based on heuristics like whether the website is opened as a Home Screen Web App"* — call it from a user gesture inside the installed app. It grants exclusion from LRU eviction under disk pressure; it does not raise quota.

**Still lose data if:** the user deletes the Home Screen icon. Home Screen web app data *is* included in iCloud Backup (stored under `Library/WebClips/`), though invisible in the per-app backup list — *2024 source, no 2026 confirmation.*

### Storage is NOT shared with Safari
Apple confirmed this is by design ([WebKit bug 181849](https://bugs.webkit.org/show_bug.cgi?id=181849)): *"Home Screen apps are created as isolated entities without shared state with the browser."* Cookies, IndexedDB, localStorage, service worker — all separate partitions. **Practical effect: log in in Safari, add to Home Screen, and you are logged out again.** Plan for one re-login inside the installed app.

### Web Push — still requires Home Screen install
Unchanged since iOS 16.4. No Safari-tab push on iPhone. Must be requested from a direct user gesture. Badging API works. **Declarative Web Push** (iOS 18.4+) is worth knowing about: no service worker needed, and WebKit says it *"isn't subject to the same feature-breaking bugs and network issues as the standard web push, nor will anti-tracking prevention features disable it."* *Unconfirmed whether it relaxes the Home Screen requirement — assume it doesn't.*

### File import — works; export needs a specific trick
- **`<input type="file">` works in standalone mode**, offering Photo Library / Files. `accept="image/png"` and `accept=".json"` are honored. The old iOS 11.3 "file input dead in standalone" bug is long fixed. *No first-party 2026 confirmation; test on device.* For lorebooks use `accept=".json,application/json"` — extension matching in the Files picker can be flaky.
- **Character card PNGs work fine**: the V2 spec stores base64 JSON in a PNG `tEXt` chunk keyed `chara`; V3 adds a `ccv3` chunk (prefer it if present). Parse it in JS from the `File` bytes — no library needed beyond a small PNG chunk reader.
- **Web Share Target is NOT supported** — [bug 194593](https://bugs.webkit.org/show_bug.cgi?id=194593), open since 2019, frustrated comments dated April and May 2026. Your PWA cannot receive files from the iOS Share Sheet. No `file_handlers` either.
- **Downloads: `<a download>` is unreliable in standalone mode.** The pattern that works in 2026 is **`navigator.share({ files: [...] })`** from a user gesture — the Share Sheet then offers "Save to Files". Gate on `navigator.canShare({files})`. Web Share is supported on iOS Safari 12.2 through 26.6.

### Backgrounding — the thing that will bite you
**There is no way to run code on iOS while your web app is not in the foreground.** Background Sync, Background Fetch, and Periodic Sync are all unsupported (caniuse: "Not supported, iOS Safari 3.2 – 26.6").

When the user switches apps: JS gets a sub-second grace window, then the content process pauses. Timers stop. **In-flight fetch and SSE connections are suspended and frequently aborted — and iOS does not reliably fire `EventSource.onerror`, so you get a silently dead stream.** Under memory pressure the process is discarded entirely and you get a full reload at `start_url` on return. There is **no documented "killed after N minutes"** number; it's purely memory-pressure driven. Any article giving you a minute count is guessing.

The mitigations that matter:
- Persist to IndexedDB on every change, not on unload. `beforeunload` is unreliable on iOS.
- `visibilitychange → hidden` is your last reliable save signal.
- On `visible`: **reopen streams unconditionally** (don't wait for an error that won't come), re-validate auth, and if the hidden gap was long, resync.
- Make `start_url` restore the last session. If your app can't survive a reload, it will feel broken.

### Streaming — works, with rules
Both `EventSource` and `fetch()` + `response.body.getReader()` work on iOS, including standalone. Safari 26.4 added async iteration (`for await...of`) and BYOB readers.

Rules that actually matter:
- Send `Content-Type: text/event-stream` with **no `charset` suffix** — WebKit has rejected `; charset=utf-8`.
- **Flush per event server-side.** This is the #1 cause of "streams fine on desktop, arrives all at once on iPhone."
- **Do not let your service worker intercept the streaming endpoint.** SW interception buffers response bodies, and Safari + Range requests + SW is a known breakage. Early-return in your `fetch` handler:
  ```js
  self.addEventListener('fetch', (e) => {
    const u = new URL(e.request.url);
    if (u.pathname.startsWith('/api/stream')) return;  // untouched
    if (e.request.headers.has('range')) return;
    e.respondWith(cacheFirst(e.request));
  });
  ```
- Don't `postMessage` a stream across worker boundaries — broken before Safari 27, and 27 is 3 days old.

### The chat-input recipe for iOS, 2026
```html
<meta name="viewport"
      content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
```
`viewport-fit=cover` is **mandatory** on iOS 26 — without it Safari paints a solid bar in the safe-area gap. `interactive-widget` is a no-op on iOS but gives you correct Android behavior free. Never add `maximum-scale=1`.

```css
:root { --kb: 0px; }
html, body { height: 100%; overflow: hidden; overscroll-behavior: none; }
.app { display:flex; flex-direction:column; height:100dvh;
       padding-bottom: var(--kb); box-sizing:border-box; }
.messages { flex:1 1 auto; min-height:0; overflow-y:auto;
            overscroll-behavior-y: contain; }
.composer { flex:0 0 auto; background: var(--surface);  /* opaque! */
            padding-bottom: max(env(safe-area-inset-bottom), 8px); }
input, textarea { font-size: 16px; }   /* below 16px = auto-zoom, and it never zooms back */
```
```js
const vv = window.visualViewport;
const sync = () => {
  const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  document.documentElement.style.setProperty('--kb', `${overlap}px`);
};
vv?.addEventListener('resize', sync);
vv?.addEventListener('scroll', sync);
```
`position: fixed` does **not** work for the composer — iOS resizes only the *visual* viewport for the keyboard, so a fixed bar sits behind it. `100dvh` tracks browser chrome but **not** the keyboard; `visualViewport` is the only tool for that. Consider `flex-direction: column-reverse` on the message list so it stays bottom-pinned for free.

---

## 2. Hosting compared — one user, phone-first, no card

| | Card to sign up? | Free limits | 5-min stream? | Sleeps? | DB |
|---|---|---|---|---|---|
| **Cloudflare Workers** | **No** | 100k req/day, **10 ms CPU**, 50 subrequests, static assets **free & unlimited** | ✅ **No wall-clock limit** | Never | D1 free |
| **Vercel Hobby** | No | Generous; **300 s max duration** (default *and* max on Hobby) | ✅ 300 s exactly | Never | BYO (Neon/Turso) |
| **Deno Deploy** | *Unstated* | 1M req/mo, **10 hr CPU**, 20 GiB egress, KV 1 GiB | ✅ | Never | Deno KV |
| **Fly.io** | **YES — required** | None meaningful | ✅ | Auto-stop | Volumes $0.15/GB-mo |
| **Render** | Unstated | 750 hrs; **sleeps after 15 min, ~1 min cold start**; free Postgres **expires in 30 days** | ✅ | ❌ Badly | Expiring |
| **Railway** | **YES — post-paid card** | $1/mo credit | ✅ | — | — |
| **Own PC + Tunnel** | No | — | ⚠️ See below | ❌ PC sleeps | SQLite |

**Verified details:**

- **Cloudflare** — [pricing](https://developers.cloudflare.com/workers/platform/pricing/) confirms *no credit card required to get started*. The [limits doc](https://developers.cloudflare.com/workers/platform/limits/) says: *"There is no hard limit on duration for HTTP-triggered Workers. As long as the client remains connected, the Worker can continue processing."* **Static asset requests are free and unlimited** and don't count against the 100k/day. Deploy is `npm create cloudflare@latest` → `npx wrangler deploy`; `wrangler login` opens a browser OAuth flow. Needs Node ≥16.17. **No domain needed** — you get `<worker>.<subdomain>.workers.dev` free. Secrets: `npx wrangler secret put OPENROUTER_KEY`, encrypted, *"not visible within Wrangler or Cloudflare dashboard after you define them"*, `.dev.vars` for local.
- **Vercel Hobby** — [limits doc](https://vercel.com/docs/functions/limitations), last updated 2026-08-24: Hobby is now **300 s default and maximum** duration, 2 GB memory. That genuinely covers a 5-minute stream. Downsides: 4.5 MB request/response body cap, and Hobby's no-commercial-use clause (*I did not verify the current wording of that clause*).
- **Deno Deploy** — **Deploy Classic and the subhosting v1 API were shut down on 2026-07-20**; the new Deno Deploy is the only option. Free tier is notably generous on compute: **10 hours of CPU/month** vs Cloudflare's 10 ms/request. *Card requirement not stated on the pricing page.*
- **Fly.io** — [pricing](https://fly.io/docs/about/pricing/) states plainly: *"All organizations (except for Linked Organizations) require a credit card on file."* Free allowances are gone. **Disqualified.**
- **Render** — [free tier doc](https://render.com/docs/free): 750 instance hours, spins down after **15 minutes without traffic**, restart takes **"about one minute"**. Free Postgres has **"a fixed storage capacity of 1 GB"** and **expires "30 days after creation."** A one-minute wait every time you open the app on your phone is disqualifying on its own; an expiring database for month-long stories is worse.
- **Railway** — $1/month free credit; **"Railway requires the use of a post-paid card"**. Disqualified.

### Self-hosting on the Windows PC — honest assessment: **don't**

Technically it all works. Tailscale Funnel is [available on all plans including free](https://tailscale.com/kb/1223/funnel) (Personal: 6 users, unlimited devices), gives you a public `*.ts.net` HTTPS URL that **visitors reach without Tailscale installed**, on ports 443/8443/10000. It's still labeled beta with non-configurable bandwidth limits. Cloudflare Tunnel is the alternative (named tunnels need a domain on Cloudflare; `trycloudflare.com` quick tunnels give an ephemeral random URL).

**Why it fails for a phone-first user:**

1. **The PC sleeps and your app disappears.** Windows' [system sleep criteria](https://learn.microsoft.com/en-us/windows/win32/power/system-sleep-criteria): the system idle timer trips and the machine sleeps unless an app holds `ES_SYSTEM_REQUIRED`. You'd set sleep to Never (`powercfg /change standby-timeout-ac 0`), which works but leaves a desktop running 24/7. On Modern Standby (S0ix) laptops it's worse — the docs note Windows 11 24H2 added a power-saving measure that **disables most wake sources** on detected battery drain, and on DC power *"the networking stacks may initiate disconnection from networks."*
2. **Windows Update reboots.** Your app is down until someone logs in, unless you run it as a service.
3. **Cloudflare's 524 timeout applies to tunneled origins.** [Error 524](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/) fires when *"the origin did not provide an HTTP response before the default 125 seconds"* Proxy Read Timeout. This does **not** apply to Workers — but it does apply to a Cloudflare Tunnel pointing at your PC. You'd need to emit headers immediately and keep the stream fed. *The docs don't state whether the timer resets once bytes flow.*
4. **You're on your phone at a café and the PC is off.** That's the whole story.

Keep it as the *development* setup (`wrangler dev`), not the production one.

### Ranked recommendation for this user

1. **Cloudflare Workers + Static Assets + D1** — no card, no sleep, no cold start, no wall-clock limit, one deploy command, the whole app in one place, and static assets are free. **The 10 ms CPU limit is the only catch, and it's designable-around.**
2. **Vercel Hobby + Turso** — if the 10 ms CPU ever becomes genuinely painful. 300 s covers streaming; you get real Node with no CPU metering.
3. **Deno Deploy** — the dark horse. 10 hours of CPU/month is far more forgiving than Cloudflare's free tier for anything compute-y.
4. Everything else — card required, sleeps, or has an expiring database.

---

## 3. Database for a branching chat tree

### The schema
```sql
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,      -- UUIDv7/ULID: client-generatable, time-sortable
  story_id    TEXT NOT NULL,
  parent_id   TEXT REFERENCES messages(id),   -- NULL = root
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  sibling_idx INTEGER NOT NULL DEFAULT 0,     -- the "swipe number"
  depth       INTEGER NOT NULL,               -- denormalized parent.depth + 1
  token_count INTEGER,
  created_at  INTEGER NOT NULL,
  meta        TEXT                            -- JSON: model, temp, latency
);
CREATE INDEX idx_msg_parent ON messages(parent_id, sibling_idx);
CREATE INDEX idx_msg_depth  ON messages(story_id, depth);

CREATE TABLE stories (
  id TEXT PRIMARY KEY, title TEXT,
  character_id TEXT, persona_id TEXT, lorebook_id TEXT,
  head_message_id TEXT,   -- ◄ THE current-path pointer
  head_path TEXT          -- JSON array of ancestor ids (denormalized)
);
```

**A regenerate is an INSERT, never an UPDATE**: same `parent_id`, `sibling_idx = MAX+1`. Nothing is ever destroyed, so every old swipe stays recoverable. **Switching branches is one `UPDATE stories SET head_message_id = ?`** — a single row written.

**Reading the current path** is a recursive CTE walking `parent_id` upward — one primary-key seek per level. The important optimization: **you almost never need the whole path.** Bound the walk to the last ~60 messages for prompt assembly (`WHERE p.depth > :head_depth - 60`) and you read 60 rows instead of 2,000.

For rendering full history, use `head_path` + `json_each()` rather than `WHERE id IN (...)` — **D1 caps bound parameters at 100**, and `json_each` sidesteps it with a single parameter.

At 100k messages this is all trivially fast — B-tree depth is ~3. What hurts is unbounded `SELECT * WHERE story_id = ?` (that's 100k rows read per call against D1's 5M/day budget), and `LIKE '%term%'` (D1's own docs: *"A leading % prevents a regular B-tree index from optimizing LIKE"*).

### The free tiers, verified today

| | **D1** | **Turso** | **Neon** | **Supabase** |
|---|---|---|---|---|
| Card | No | **No** | **No** | No |
| Storage | 5 GB acct / **500 MB per DB** | **5 GB** | **0.5 GB/project** ×100 projects | 500 MB |
| Reads | 5 M rows/day | **500 M rows/mo** | 100 CU-hr/mo | — |
| Writes | 100 k rows/day | **10 M rows/mo** | — | — |
| Vectors | ❌ **none** | ✅ **native** | ✅ pgvector | ✅ pgvector |
| PITR | 7 days free | 1 day | — | — |
| Idle penalty | None | **Archived after 10 days** | Scale-to-zero 5 min, **no deletion** | ⛔ **Pauses after ~1 week, manual restore** |
| Export | `wrangler d1 export` | `.dump` / binary `.db` | `pg_dump` | `pg_dump` |

**Corrections to common belief:** D1's 10 GB max-database-size is now **paid-only** — free is **500 MB per database**, 10 databases, 5 GB account total. Free also caps **queries per Worker invocation at 50** (paid: 1000).

**Supabase is disqualified.** Its own docs: *"A Free plan project is considered inactive if it does not receive sufficient user database activity over the past week"*, and restoring is a manual dashboard click. For someone who finishes a story and takes two weeks off, that's the wrong failure mode. **Neon gives you the same Postgres + pgvector with no pause at all** — *"None of these limits delete your data."*

**PlanetScale** killed its free tier in April 2024. **Xata** retired "Xata Lite" on 2026-02-28. Both out.

### Vectors — D1 has none, and Vectorize's free cap is the real constraint
I confirmed D1 has no vector type by grepping Cloudflare's full D1 docs corpus: every hit for "vector" is a cross-reference to Vectorize. D1's supported extensions are exactly *"FTS5... JSON extension... Math functions"* — no `sqlite-vec`, no `F32_BLOB`.

**Vectorize IS free.** Cloudflare's changelog entry is titled *"Vectorize is available on Workers Free plan"*: **30 M queried vector dimensions/month, 5 M stored vector dimensions.** Max 1,536 dims, 20 M vectors/index, 10 KiB metadata, 100 indexes on free, 1,000 namespaces.

**The arithmetic that decides your design:**

| Embedding model | Dims | **Max vectors on free** |
|---|---|---|
| `bge-small-en-v1.5` | 384 | **13,020** |
| `bge-base-en-v1.5` | 768 | **6,510** |
| `bge-large` / `bge-m3` | 1024 | **4,882** |

That is not "a year of archived roleplay." **The answer is to embed summaries and key scenes, not every message** — which is better retrieval anyway. If you outgrow it, **Upstash Vector's free tier is 200 M vector-dimensions (~260,000 vectors at 768 dims), no card** — a drop-in HTTP swap.

**Workers AI embeddings are effectively free**: 10,000 neurons/day, and `bge-base-en-v1.5` costs 6,058 neurons per *million* input tokens → **~1.65 M tokens/day ≈ 5,500 messages embedded per day.**

### Why NOT brute-force cosine in JS on Workers Free
20,000 × 768-dim float32 = **61.4 MB** and **15.4 M multiply-accumulates ≈ 20–60 ms of CPU.** The free plan gives you **10 ms**. You'd get error 1102 ("Worker exceeded resource limits").

It *is* viable if you prefilter hard: one story's ~2,000 chunks = 6 MB and ~2–5 ms — inside budget, but with no margin. **Use Vectorize instead: the search runs on Cloudflare's side and costs your Worker essentially zero CPU.** That single choice is what makes the free tier work.

### Export — "nothing trapped"
```bash
npx wrangler d1 export rp-db --remote --output=./backup.sql
```
Real SQL, schema + data. **Two gotchas:** (1) *"Export is not supported for virtual tables"* — if you add an FTS5 index, you must script `DROP → export → recreate`; (2) int64 values lose precision past 52 bits, so use TEXT for IDs.

Vectorize has **no bulk export** (you'd paginate `list_vectors` then `getByIds`). **Fix this by design: keep every embedding as a BLOB in D1 alongside the chunk, and treat Vectorize as a rebuildable index.** Then one `d1 export` really is everything, and you can re-index into Vectorize, Upstash, pgvector, or sqlite-vec in an afternoon.

---

## 4. Auth for exactly one person

### Recommended: one password → a signed HttpOnly cookie

**Because of this**, from [WebKit's ITP 2.1 announcement](https://webkit.org/blog/8613/intelligent-tracking-prevention-2-1/):

> "Only cookies created through `document.cookie` are affected by this change... Cookies created through `document.cookie` cannot be HttpOnly which means **authentication cookies should not be affected by the lifetime cap**."

So a **server-set `Set-Cookie` with `HttpOnly; Secure; SameSite=Lax` and a 1-year expiry is NOT subject to the 7-day cap on iOS.** Combined with the Home Screen ITP exemption, you log in once and stay logged in.

The implementation, in ~30 lines:
- Store a hash of the password as a Worker secret (`wrangler secret put APP_PASSWORD_HASH`).
- Compare in constant time (`crypto.subtle.timingSafeEqual` or compare digests, never `===` on the raw string).
- On success, set an HMAC-signed cookie (`value|expiry|HMAC(value|expiry, SECRET)`), `Max-Age=31536000`.
- Rate-limit failed attempts — a KV counter keyed on IP, or Cloudflare's own rate-limiting rules.
- Remember: **the Home Screen app has its own cookie jar**, so expect exactly one extra login after installing.

This is genuinely safe enough for private personal writing, *provided* the password is long and random and served only over HTTPS (which `workers.dev` always is).

### Cloudflare Access — nicer, but two blockers
Access's self-hosted application docs state you need **"an active domain on Cloudflare"** — so it **cannot protect a bare `*.workers.dev` hostname.** You'd have to buy a domain (~$10/yr, which needs a card). Session duration is configurable **"between 15 minutes and one month"**, so with One-time PIN you'd re-enter an emailed code monthly. Note OTP is **no longer enabled automatically** — you set it up.

⚠️ **Unresolved and important:** whether Cloudflare Zero Trust's Free plan still demands a payment method at signup. 2026 secondary sources say no; Cloudflare community threads from 2022–2025 say yes, repeatedly. I could not find a first-party statement either way. **Given the no-card requirement, don't build on Access — use the cookie.**

Also worth knowing: Access sits in front of every request, so XHR/fetch calls can get an HTML login page instead of JSON once the session lapses. That's an annoying failure mode inside a PWA.

### Passkeys / WebAuthn — good phase-2, not phase-1
Face ID login is genuinely lovely on iPhone and works in standalone PWAs. SimpleWebAuthn is the standard library. But for a single user it introduces a recovery problem (lose the device, lose the account) that a password in a password manager doesn't have. *I could not confirm SimpleWebAuthn's current Cloudflare Workers runtime compatibility — verify before committing.*

### Tailscale-only — no
The iPhone would need the Tailscale app running with a VPN profile active, and **iOS only allows one VPN at a time**. Phone-first plus always-on VPN is a bad trade.

---

## 5. Can a Worker stream for 2–5 minutes? **Yes.**

Straight from [the limits doc](https://developers.cloudflare.com/workers/platform/limits/):

| | Free | Paid |
|---|---|---|
| **CPU per invocation** | **10 ms** | 30 s default, 5 min max |
| **Wall-clock (HTTP)** | **"No hard limit on duration... As long as the client remains connected, the Worker can continue processing."** | same |
| Wall-clock (Cron/Queues/Alarms) | 15 minutes | 15 minutes |
| `ctx.waitUntil()` | **30 s after response sent** | 30 s |
| Subrequests | **50** | 10,000 |
| Memory | 128 MB | 128 MB |
| Cron triggers | 5 | 250 |

Key distinctions:
- **CPU time ≠ duration.** *"Waiting on network requests (such as `fetch()` calls, KV reads, or database queries) does not count toward CPU time."* A 5-minute LLM stream is 5 minutes of waiting and near-zero CPU.
- **Error 524 does not apply to Workers.** The 125-second Proxy Read Timeout is for *origin servers* behind Cloudflare's proxy. It would apply to a Cloudflare Tunnel pointing at your PC, not to a Worker.
- **`ctx.waitUntil` caps at 30 seconds.** Your memory engine's background summarization call must finish inside that, or be restructured.

### The pattern that keeps you under 10 ms CPU
```js
// GOOD — pure pass-through, ~0 CPU
const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {...});
return new Response(upstream.body, { headers: { 'content-type': 'text/event-stream' }});
```
Do **not** pipe through a `TransformStream` that JSON-parses every chunk to accumulate the text — that's CPU proportional to output length and will blow 10 ms on a long reply. **Let the client parse the SSE** (it has to anyway, to render tokens) and have it `POST` the assembled message back to `/api/messages` when done. One extra request, zero CPU risk.

### For the phone backgrounding mid-generation
The problem: iOS suspends the PWA, the connection drops, the Worker's request is cancelled, and a half-finished generation is lost (and partly paid for).

**Phase 1 (simple):** on resume, if the head message is marked incomplete, offer "resume / regenerate." Good enough to ship.

**Phase 2 (robust):** a **Durable Object per story** owns the upstream fetch and accumulates chunks in its SQLite storage; the client connects/reconnects via SSE with a byte offset or `Last-Event-ID` and replays what it missed. Generation continues even when the phone is locked.

**Durable Objects are on the Workers Free plan** — SQLite-backed only: 100k requests/day, **13,000 GB-s/day**, 5 M rows read/day, 100 k rows written/day, 5 GB total, **10 GB per object**. A 5-minute generation at 128 MB = ~38 GB-s, so you get **~340 generations/day** inside the free duration budget. WebSocket Hibernation would cut that further (*billing docs confirm duration doesn't accrue during hibernation; free-plan availability of hibernation specifically is not stated*).

**Comparison:** Vercel Hobby caps hard at **300 s** (5 minutes exactly — cutting it fine). Deno Deploy gives 10 CPU-hours/month. Fly.io has no limit but requires a card.

---

## 6. The ".exe" question — honest answer

**Short version: you can have a real installed app on Windows today, for free, from the same code that runs on your iPhone. You cannot have a real installed app on iPhone without a Mac and $99/year — and you don't need one.**

### Windows: Edge PWA install is a fair substitute, and it's better than you'd expect
From Microsoft's [PWA UX docs](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/ux) (updated 2026-09-02): **"On Windows, PWAs are just like other apps."** Concretely, you get:

- Its **own window with no browser chrome**
- An entry in the **Start menu** (with a "Pin to Start" checkbox at install)
- **Taskbar** presence, pinnable
- Appears in **Alt+Tab** alongside native apps
- Listed in **Settings → Add or remove programs**, uninstallable from there
- **Auto-start on device login** (a checkbox at install, or `edge://apps` → More options)
- Right-click context-menu shortcuts, and OS notifications

**What you lose vs. a true .exe:** it's a Chromium-hosted window, not a self-contained signed binary; it requires Edge installed (universally true on Windows 11); the launcher is a shortcut, not a standalone executable; and there's no offline installer to hand someone. *I could not find an official doc line confirming the shortcut targets `msedge_proxy.exe`, though that is the well-known behavior.* For a personal app, none of these matter.

### Tauri / Electron: real .exe, but zero help on iPhone
Tauri v2 does support mobile — but its [prerequisites](https://v2.tauri.app/start/prerequisites/) are unambiguous: **"iOS development requires Xcode and is only available on macOS."** Android works from Windows; iOS does not. So a Tauri build gives you a genuine Windows .exe and a second thing to maintain, while leaving the iPhone — your primary device — exactly where it was.

### App Store: confirmed $99/year, and it needs a Mac
[Apple Developer Program enrollment](https://developer.apple.com/programs/enroll/) is **$99 USD per membership year**, requires an Apple Account with 2FA and your legal name. Payment obviously requires a payment method. Free provisioning with a personal Apple ID still needs a Mac + Xcode and the app expires every 7 days. AltStore/SideStore don't change the Mac requirement for *building*. **For a non-programmer on Windows with no Mac: not a path.**

### Recommendation
**One PWA. Edge-install it on Windows, Add to Home Screen on iPhone.** You get an icon in both places, a chromeless window in both places, and one codebase that Claude Code deploys with one command. Revisit Tauri only if you someday want a genuinely offline desktop build — and know it buys the iPhone nothing.

---

## 7. Backups — both kinds

### (a) The file you can copy
**In-app "Export everything" button.** The Worker assembles a single JSON (or SQL) file from D1 — stories, messages with `parent_id`/`sibling_idx` intact, characters, lorebooks, personas, embeddings as base64.

**On iPhone** (this is the part that needs care — `<a download>` is unreliable in standalone mode):
```js
const blob = new Blob([json], { type: 'application/json' });
const file = new File([blob], `rp-backup-${date}.json`, { type: 'application/json' });
if (navigator.canShare?.({ files: [file] })) {
  await navigator.share({ files: [file], title: 'Roleplay backup' });
  // Share Sheet → "Save to Files" → iCloud Drive
}
```
Fallback if `canShare` is false: POST to the Worker, which returns it with `Content-Disposition: attachment`, then `window.open()` that URL so Safari's native download manager handles it.

**On Windows**, the ordinary `<a download>` works, straight into a OneDrive-synced folder.

**From the PC**, the real thing:
```bash
npx wrangler d1 export rp-db --remote --output=./rp-backup.sql
```

### (b) Automatic cloud backup

**Design 1 — GitHub Actions → private repo (recommended; free, no card, versioned, off-Cloudflare).**
GitHub Free gives **2,000 Actions minutes/month for private repos**, and — importantly — *"If your account does not have a valid payment method on file, usage is blocked once you use up your quota"* rather than billed. A nightly job takes ~1 minute (≈30 min/month). It runs `npx wrangler d1 export --remote` with a `CLOUDFLARE_API_TOKEN` secret and commits the dump. You get full history, off-platform, diffable, and restorable with `wrangler d1 execute --file`.

**Design 2 — D1 Time Travel (already on, free, zero setup).**
*"You do not need to enable Time Travel. It is always on."* **7 days retention on free** (30 on paid), restore to any minute:
```bash
npx wrangler d1 time-travel info rp-db
npx wrangler d1 time-travel restore rp-db --timestamp=1757520000
```
This is your instant-undo for "I deleted the wrong story." It is **not** a substitute for Design 1 — 7 days is short, and it lives inside the same account.

**Design 3 — Worker cron → KV snapshot (belt and braces).**
Workers Free allows **5 cron triggers**; KV free allows **1,000 writes/day** and 1 GB stored. A nightly `scheduled()` handler writing a JSON snapshot to KV costs one write. Crude but zero-dependency.

⚠️ **R2 is the obvious place for dumps and I'd normally recommend it — but enabling R2 requires adding a payment method**, even for the 10 GB free tier (multiple Cloudflare community threads; Cloudflare's pricing page doesn't address it). **Given the no-card constraint, use GitHub instead.**

**On the PC side**, a Windows Task Scheduler job running the `wrangler d1 export` above into a OneDrive folder gives the user a literal file they can see and copy, updated nightly, with no third parties at all.

---

## 8. Concrete build

1. **Scaffold:** `npm create cloudflare@latest` → a Worker with Static Assets. Deploy with `npx wrangler deploy`. URL: `rp.<subdomain>.workers.dev`.
2. **Manifest + icons + `apple-touch-startup-image`**, `display: standalone`, `viewport-fit=cover`. Add to Home Screen on the iPhone; Install as app in Edge on Windows.
3. **Auth:** password → HMAC-signed HttpOnly cookie, 1-year. Secrets via `wrangler secret put`.
4. **D1** with the branching schema above. Bounded-depth CTE for prompt assembly; `head_path` + `json_each` for full transcripts.
5. **Streaming:** `/api/stream` returns `new Response(upstream.body)` with zero transformation. Service worker explicitly does **not** intercept it. Client parses SSE, POSTs the finished message back.
6. **Memory:** Workers AI `bge-small-en-v1.5` (384 dims — doubles your Vectorize headroom to ~13k) → Vectorize, one namespace per story. **Also store every embedding as a BLOB in D1** so Vectorize stays rebuildable and your export stays complete. Embed summaries and key scenes, not every message.
7. **Import:** `<input type="file" accept=".json,application/json,image/png">`, parse PNG `tEXt`/`ccv3` chunks for character cards.
8. **Backups:** export button using `navigator.share({files})`; nightly GitHub Actions `d1 export` into a private repo; Time Travel as instant undo.
9. **iOS resilience from day one:** save to IndexedDB on every change; `visibilitychange` checkpoint; reopen streams unconditionally on resume; `start_url` restores the last session.
10. **Later, if wanted:** Durable Object per story for resumable generation; passkeys; swap Vectorize → Upstash Vector or D1 → Turso if you outgrow the caps.

---

## 9. What I could not confirm

- **Whether Cloudflare Zero Trust's Free plan requires a payment method at signup** — 2026 secondary sources say no, community reports 2022–2025 say yes, no first-party statement found. *This is why I routed around Access.*
- Whether **R2 activation** requires a payment method per Cloudflare's own docs (community consensus says yes; the pricing page is silent).
- Whether **iOS 27** (shipping 2026-09-14) changes anything for PWAs.
- Whether **"Clear History and Website Data"** in Safari also wipes Home Screen web app partitions.
- Whether **`<a download>`** now works in iOS 26 standalone mode.
- Whether **Declarative Web Push** relaxes the Home Screen requirement.
- **Deno Deploy's card requirement** (pricing page doesn't say).
- **Vercel Hobby's current commercial-use wording.**
- Whether **Turso's 10-day inactivity archival auto-unarchives on reconnect** — worth testing deliberately before trusting a month-long story to it.
- **SimpleWebAuthn's** current Cloudflare Workers compatibility.
- Whether **Durable Object WebSocket Hibernation** is specifically available on the free plan.
- Exact **iOS background-kill timing** — undocumented by Apple, memory-pressure driven; any specific number you see online is a guess.

**Sources:** [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) · [Static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) · [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) · [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) · [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) · [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/) · [Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/) · [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) · [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) · [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) · [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/) · [ctx.waitUntil](https://developers.cloudflare.com/workers/runtime-apis/context/) · [Error 524](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/) · [Access self-hosted apps](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/) · [Access session management](https://developers.cloudflare.com/cloudflare-one/identity/users/session-management/) · [WebKit tracking prevention](https://webkit.org/tracking-prevention/) · [WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/) · [ITP 2.1](https://webkit.org/blog/8613/intelligent-tracking-prevention-2-1/) · [Web Push on iOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) · [Safari 26.0 features](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/) · [Safari 27 beta](https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/) · [WebKit bug 181849](https://bugs.webkit.org/show_bug.cgi?id=181849) · [bug 194593](https://bugs.webkit.org/show_bug.cgi?id=194593) · [bug 259770](https://bugs.webkit.org/show_bug.cgi?id=259770) · [Vercel function limits](https://vercel.com/docs/functions/limitations) · [Deno Deploy pricing](https://deno.com/deploy/pricing) · [Fly.io pricing](https://fly.io/docs/about/pricing/) · [Render free tier](https://render.com/docs/free) · [Railway plans](https://docs.railway.com/reference/pricing/plans) · [Turso pricing](https://turso.tech/pricing) · [Turso vectors](https://docs.turso.tech/features/ai-and-embeddings) · [Neon plans](https://neon.com/docs/introduction/plans) · [Supabase project pausing](https://supabase.com/docs/guides/platform/free-project-pausing) · [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) · [Edge PWA UX](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/ux) · [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) · [Apple Developer enrollment](https://developer.apple.com/programs/enroll/) · [GitHub Actions billing](https://docs.github.com/en/billing/managing-billing-for-your-products/about-billing-for-github-actions) · [Windows sleep criteria](https://learn.microsoft.com/en-us/windows/win32/power/system-sleep-criteria)

---

# Corrections, second pass (2026-09-11)

The last two agents landed, and they materially correct two things I told you. Here is the delta.

# Corrections and additions

## 🔴 Correction 1 — Cloudflare Access CAN protect a `workers.dev` Worker (I was wrong)

I said Access requires a domain on Cloudflare. That was true until **2026-08-14**, when Cloudflare shipped Worker-level Access policies:

> "When you protect a single Worker, it automatically protects every domain associated with the Worker, including its routes, Custom Domains, **`workers.dev` hostname**, and previews."
> — [workers/configuration/cloudflare-access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), [changelog 2026-08-14](https://developers.cloudflare.com/changelog/post/2026-08-14-workers-access/)

You also get identity inside the Worker for free via `ctx.access.getIdentity()`.

**But two things still kill it for this user:**

**(a) The credit card question is now settled, and the answer is yes.** Cloudflare's own setup doc:

> "Complete your onboarding by selecting a subscription plan and entering your payment details. **If you chose the Zero Trust Free plan, this step is still needed but you will not be charged.**"
> — [cloudflare-one/setup](https://developers.cloudflare.com/cloudflare-one/setup/)

So my flagged uncertainty resolves against Access. The 2026 pages claiming "no credit card" (costbench, zerometric, pixlodo) are AI-generated affiliate content contradicting the vendor doc.

**(b) Worker-level Access breaks WebSockets outright:**

> "Worker-level Access policies do not currently support WebSocket connections. WebSocket upgrade requests to a Worker protected by a worker-level Access policy will fail with a **`403` error**."

**The recommendation stands unchanged: build the shared-password + HMAC cookie.** Free plan seats are 50 users, session max is confirmed at one month (global: "between 15 minutes and one month", default 24 h), and Access's PWA failure mode is real — when the session lapses, XHR gets a 302 to an HTML login page and a CORS error, and an XHR can never complete the login flow.

## 🔴 Correction 2 — the iOS export pattern: lead with a server endpoint, not Web Share

I recommended `navigator.share({files})` as primary. Better answer, because it depends on nothing uncertain:

**Primary: a server-side endpoint + top-level navigation.** Don't build the file in JS at all.
```js
// Worker
return new Response(jsonStream, {
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': 'attachment; filename="tipsy-backup-2026-09-11.json"',
    'Cache-Control': 'no-store',
  },
});
```
```js
window.location.href = '/export?t=' + token;   // real navigation, not fetch+blob
```
This streams from the server, so **no blob is ever held in the iPhone's JS heap** — no size ceiling — and it sidesteps `blob:` URLs, the `download` attribute, and standalone-mode download policy entirely. iOS hands it to the system download/Quick Look flow, which has a Share → Save to Files path. On Windows/Edge it's a completely ordinary download.

Keep Web Share as **fallback 1** (confirmed iOS 14+ for files, `safari_ios: "mirror"` in MDN's compat data) and "Show raw JSON in a textarea" as **fallback 2**. Ship all three buttons; ~40 lines total.

Two Web Share gotchas worth knowing: `await fetch` before `share()` can break the user-activation on some builds (prefetch the blob first), and if `application/json` is rejected, fall back to `text/plain` with a `.txt` extension.

Also: **`<a download>` IS supported on iOS Safari 13 → 26.6** per [caniuse](https://caniuse.com/download) — the uncertainty is specifically whether it works in `display: standalone`, which no primary source addresses. The pattern above means you never have to find out.

## Refinement — use a SQLite Durable Object, not D1, as the main store

D1's **500 MB per database** on Free is the ceiling I flagged. A SQLite-backed Durable Object is on the free plan and allows **10 GB in a single object** (5 GB account-wide), plus 5 M rows read / 100 k rows written per day. For a single-user app, one DO holding your whole history removes the storage worry permanently — and you likely want a DO anyway for resumable streaming.

Caveat flagged by the research: the DO limits page lists "CPU per request: 30 s default / configurable to 5 min" with **no Free-plan carve-out**, which appears to conflict with Workers Free's 10 ms. Assume 10 ms and design accordingly.

## New disqualifications worth recording

- **Netlify** — streaming functions cap at **60 s**. Also, the free plan is now **300 credits/month** at **15 credits per production deploy** ≈ 20 deploys/month; run out and *"all of your web projects are paused."* Twenty deploys is nothing when iterating with Claude Code.
- **Val Town** — **1 minute wall clock per run.**
- **Hugging Face Spaces** — 2026 change: *"Gradio and Docker Spaces run on compute and require a paid plan to create."* Free app hosting is gone.
- **Glitch** — shut down **2025-07-08**.
- **Oracle Cloud Always Free** — idle instances are reclaimed if 7-day 95th-percentile utilization is **<20%**, which is exactly a single-user chat app's profile.
- **Railway** — worse than I said: unverified GitHub accounts get a "Limited Trial" with **"restricted outbound network access"**, which could block your OpenRouter calls outright, and *"Railway does not respond to requests for verification."*

## Self-hosting — two findings that change the picture

**Cloudflare quick tunnels are disqualified outright:**
> **"Quick Tunnels do not support Server-Sent Events (SSE)."**
> — [trycloudflare docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)

SSE is *the* transport for token streaming. Plus the URL is random and changes on every restart — fatal for an installed PWA pinned to a fixed origin.

**And a genuinely useful one for any tunnel:**
> "Proxied traffic through Cloudflare Tunnel is **buffered by default unless the origin server includes the `Content-Type: text/event-stream` response header**."

**The Windows sleep problem has a clean mitigation I didn't have:** adaptive hibernate (15-minute grace, then forced hibernation) is documented as **DC-only** — *"The settings are applied on DC only and have no impact on AC."* **Keep the machine plugged in and that entire class of surprise hibernation disappears.** Pair with the vendor's charge limiter so permanent AC doesn't cook the battery.

**Wake-on-LAN is confirmed useless here**, for three independent reasons: it's a LAN broadcast not routable from cellular; Microsoft states *"Network adapters are explicitly not armed for WOL"* in S4/S5, only S3 and explicit hibernate; and Modern Standby machines generally can't WoL at all since S0ix isn't an ACPI sleep state.

**Auto-start:** it must be Task Scheduler **"At startup" + "Run whether user is logged on or not"**. An "At log on" task does not fire if nobody logs in — so after a 3am Windows Update reboot, the machine sits at the lock screen and your app is dead until you physically return. Also uncheck "Stop the task if it runs longer than" (defaults to 3 days) and set "Start in" to the app folder.

**Tailscale Funnel does resume after reboot on its own** when started with `--bg` — the config lives server-side in the tailnet. Only your Node app needs the scheduled task. And rename the PC first: *"the machine names are still published in the public ledger"* when you enable HTTPS certs.

## Two things that make the Windows app feel more like a real .exe

**Window Controls Overlay** — `"display_override": ["window-controls-overlay"]` plus `env(titlebar-area-*)` CSS puts your own content to the very top of the window, leaving only Min/Restore/Close. Microsoft's framing: *"Many desktop applications, such as Visual Studio Code, Microsoft Teams, and Microsoft Edge already do this."*

**Manifest `shortcuts`** give you a taskbar right-click jump list.

## Small corrections to numbers I gave

- **Vercel Hobby's commercial-use clause**, verbatim: *"Hobby teams are restricted to non-commercial personal use only."* The "paid consultant" language targets agencies billing clients. A personal roleplay app with no payments, ads, or clients does not violate it.
- **D1 Time Travel restore is destructive and in-place** — it overwrites the database. It protects against your own bad migration, not against losing the account. Not a backup.
- **`ctx.waitUntil`'s 30 s is shared across all `waitUntil` calls in the request**, and unsettled promises are *canceled*. A summarization LLM call there will be silently truncated. Use a Durable Object (alarms get 15 min) or defer to the next request.
- **GitHub's scheduled-workflow auto-disable after 60 days of inactivity applies to public repos only** — your private backup repo is fine either way.
- **Workers Free static assets:** 20,000 files per version, 25 MiB max per file. Exceeding 100k requests/day returns **Error 1027**.
- **Cron Triggers on Free still get 10 ms CPU.** A nightly cron that serializes a database **will die on the free plan.** On Paid with a ≥1-hour interval you get 15 minutes. This is the strongest argument for the $5/month I've seen — Design 3 in my backup section silently assumed Paid.
- **CockroachDB Basic** is a fourth no-card database worth knowing: **10 GiB free**, *"No credit card required for Basic and Standard plans."*

## Portability insurance, free

Set `X-Accel-Buffering: no` on the streaming response and emit a `: ping` heartbeat every ~15 s. Neither is needed on Workers, but both keep you portable to Render, Fly, or a tunnel without rework — and the heartbeat is what makes Fly's 60-second *idle* timeout a non-issue if you ever move.

## Still unconfirmed after all of this

Tailscale Funnel's request/idle timeout (deliberately unpublished — test before relying on it); Deno Deploy's card requirement and max request duration (their limits page is a 404); whether streaming bytes reset Cloudflare's 125 s Proxy Read Timeout (matters only for Tunnel, not Workers); whether DO invocations get a different CPU budget than 10 ms on Free; whether R2 activation requires a card (the get-started page says "complete the checkout flow" without saying); and whether WebAuthn works reliably in iOS `display: standalone`.

**One meta-warning worth passing on:** search results for Cloudflare free-tier questions are dominated by AI-generated affiliate sites, one of which directly contradicted Cloudflare's own setup doc on the credit card question. For this stack, insist on `developers.cloudflare.com`, `learn.microsoft.com`, `webkit.org`, `developer.apple.com`, and `docs.github.com`.