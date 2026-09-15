# Uncensored long-form RP models — landscape, 11 September 2026

Prices, context lengths and flags pulled live from the OpenRouter models API (443 models) and
provider endpoint records. Behaviour scores from the UGI Leaderboard (1,309 rows, updated
2026-09-05) and EQ-Bench Creative Writing v3 (133 models).

**Gap to note:** Reddit was unreachable from the research crawler (all routes and 14 mirrors
blocked), so there are no r/SillyTavernAI megathread quotes here. Quantitative leaderboards were
substituted. Different evidence, arguably better for this question, but not what was asked for.

---

## 1. What the branded models actually are

### Tipsy Chat

| Tipsy brand | Almost certainly | Confidence |
|---|---|---|
| Top Pick V3 / V3.5 | Anthropic Claude, Sonnet class, resold via AWS Bedrock | High |
| Luxury Selection V5 / V4.5 | Anthropic Claude, Opus class | Medium-high |
| Prestige Selection | Top-end Opus with extended thinking | Medium |
| Sake family, Water | Google Gemini and/or xAI Grok. Definitively not Claude | Low-medium |

Evidence: Tipsy's FAQ says "Claude is currently the most cutting-edge and advanced model in the
world for role-playing." Their frontend has a reward endpoint namespaced `/user/claude/has_chatted`
whose UI copy reads "Chat once with any model from the Top Pick lineup." Their privacy policy
Annex A lists Google, Amazon Web Services and xAI for text generation, AWS being the standard
Bedrock resale path for Claude, with Anthropic absent as a direct vendor. Context lengths of
200,000 and exactly 1,000,000 are Anthropic signatures (Gemini reports 1,048,576, DeepSeek 163,840,
GLM 204,800). Luxury and Prestige pin temperature to exactly [1,1], which Anthropic's API requires
when extended thinking is on.

**Why this matters.** On the UGI willingness scale (`W/10`, 0-10), Claude Sonnet 5 scores **1.8**
and Claude Fable 5 scores **1.2**, the lowest of any frontier family, with average NSFW scores of
1.1-1.3. Grok 4.20 scores W/10 **7.5** with NSFW **9.9**. The user was paying Opus-tier prices for
a model architecturally committed to refusing them, then falling back to the cheap tier that worked.

### FictionLab

Published openly in their GitBook docs.

| FictionLab brand | Stated base model | Confidence |
|---|---|---|
| Paragon | DeepSeek V4 Pro (1.6T MoE), stated twice including a dated changelog entry | High |
| Lumina | Xiaomi MiMo V2.5 Pro, reasoning enabled | High |
| Oracle V3 | DeepSeek V3.2 | High |
| Chimera | GLM-4.6 | High |
| **Wayfare** | **Does not exist.** Zero matches across 12 doc pages incl. a 67 KB changelog | High (negative) |
| Eclipse, Glendora, Solara, Ophelia, Wraithmind, Quasar | No disclosed base | — |

FictionLab publicly rolled Chimera back from GLM-4.7, saying "the newer version seems to be a bit
weaker when it comes to creative writing." That matches the UGI numbers exactly.

Both identified engines are directly purchasable and cheap:

| Model | In $/M | Out $/M | Cache read $/M | Context | Moderated |
|---|---|---|---|---|---|
| `xiaomi/mimo-v2.5-pro` (= Lumina) | 0.435 | 0.870 | **0.004** | 1,050,000 | No |
| `deepseek/deepseek-v4-pro` (= Paragon) | 0.948 | 1.896 | 0.079 | 1,048,576 | No |
| `deepseek/deepseek-v4-pro-0813` | 0.580 | 1.738 | 0.019 | 1,048,576 | No |

**Honest caveat:** the base model is not the whole product. MiMo V2.5 Pro's own UGI scores are
dark 4.3 / nsfw 2.4 / W-10 1.8, i.e. mediocre willingness. Lumina's "visceral, graphic" character
comes substantially from FictionLab's system prompt and sampler tuning, not the weights. Buying the
base model gets the raw engine; the scaffolding is the real work.

---

## 2. OpenRouter free tier

### The models

19 models carry a `:free` suffix. Relevant ones:

| Model ID | Context | Max out | Structured outputs |
|---|---|---|---|
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1,000,000 | 65,536 | **No**, `tools` only |
| `nvidia/nemotron-3.5-lightning:free` | 1,000,000 | 65,536 | No |
| `nvidia/nemotron-3-super-120b-a12b:free` | 262,144 | 235,929 | Yes |
| `thinkingmachines/inkling:free` / `-small:free` | 1,048,576 | 262,144 | No |
| `dots-studio/dots-3-note-preview:free` | 512,000 | 460,800 | Yes, expires 2026-09-30 |
| `nex-agi/nex-n2.5-pro:free` / `-mini:free` | 262,144 | 235,929 | Yes |

`openrouter/free` picks a free model at random per request. Useless for roleplay, character voice
drifts between messages.

### Nemotron status

The old `llama-3.1-nemotron-ultra-253b-v1:free` is dead (zero providers). The current one is
**Nemotron 3 Ultra 550B-A55B**, hybrid Transformer-Mamba MoE, served by NVIDIA at 98.6% uptime.
The free variant advertises 1,000,000 context while the paid variant caps at 262,144 (untested
whether a 1M prompt actually succeeds).

EQ-Bench Creative Writing v3: Elo 1689.3, CW score 16.58, slop 18.42. Mid-tier prose, noticeably
sloppier than the leaders. But average output length is **10,536 tokens, the longest of any model
on the board**, which is almost certainly why it suits long-form play. **Not on the UGI leaderboard,
so no dark/NSFW/willingness score exists for it.** Siblings are not encouraging: Nemotron 3 Nano 30B
scores dark 3.4 / nsfw 3.4 / W-10 2.2.

### Rate limits

Live constants from the API reference:

```
FREE_MODEL_RATE_LIMIT_RPM     = 20
FREE_MODEL_NO_CREDITS_RPD     = 50
FREE_MODEL_HAS_CREDITS_RPD    = 1000
FREE_MODEL_CREDITS_THRESHOLD  = 10
```

| Lifetime credits purchased | Req/min | Req/day |
|---|---|---|
| Under $10 | 20 | 50 |
| $10 or more | 20 | 1000 |

The threshold is **lifetime, not balance**: "Even if your balance later dips below $10, you'll still
keep the higher limits." Failed attempts count against quota. At 100 messages/day the $10 purchase
is required. 20 RPM is not a constraint at human pace.

### Data retention — the disqualifier

Confirmed from OpenRouter's help-centre article dated 2026-06-14:

> "If either is off, free endpoints that train or publish get filtered out — and since that's how
> most free models are served, you can lose all of them at once. **To use free models, turn both on.**"
>
> "If you'd rather not allow training or publication, you'll need to use paid endpoints instead —
> free endpoints generally require these permissions."

The two toggles at `openrouter.ai/settings/privacy`:
1. Free endpoints that may train on request data
2. Free endpoints that may publish prompts — "some free providers publish prompts and completions to public datasets"

With them off, every free model returns `404 — No endpoints available matching your guardrail
restrictions and data policy`.

**Given the user's stated preference for providers that do not train on their chats, the free tier
is disqualified for the main story.** Not merely worse, directly contrary to the requirement.

### Paid-model privacy controls

Per request:

```json
{ "provider": { "data_collection": "deny", "zdr": true } }
```

`data_collection: "deny"` uses only providers that do not collect user data. `zdr: true` restricts
to Zero Data Retention endpoints. Account-wide equivalents exist, plus per-vendor guardrails
(`enforce_zdr_anthropic`, `enforce_zdr_openai`, `enforce_zdr_google`, `enforce_zdr_xai`,
`enforce_zdr_other`). Strictest of account / org / key wins. There are **no `X-OR-*` data-policy
headers**; guides saying otherwise are stale. Enforcing ZDR filters out many cheap endpoints, so
test with `data_collection: "deny"` first.

---

## 3. Paid models worth using

### The `is_moderated` flag

123 of 443 models carry `is_moderated: true`: every Anthropic model, every OpenAI model, all Amazon
Nova, all Cohere, Writer Palmyra. Nothing else.

Everything else is `is_moderated: false`, including all DeepSeek, Qwen, GLM/Z.ai, MiniMax,
Kimi/Moonshot, Mistral, Nemotron, Grok, Llama, Xiaomi — and, surprisingly, all Google Gemini.

Read the flag carefully. It means OpenRouter applies no moderation layer of its own. It says nothing
about the model's trained-in refusal behaviour. Gemini is unmoderated and still scores W/10 2.2.

### The metrics that predict experience

- **`W/10`** — how far a model can be pushed before it refuses or deviates. Split into `Direct`
  (outright refusal) and **`Adherence`** (deviates from instructions, a softer form of refusal).
  **Adherence is the "tries to lighten it up" metric.**
- **`avg_dark_score`** — tonal lean from lighthearted toward violent/tragic.
- **`avg_nsfw_score`** — tonal lean from SFW toward explicit.

### The table

| Model | In/Out/Cache $/M | Ctx | dark | nsfw | W/10 | Adher | UGI | EQ Elo | slop |
|---|---|---|---|---|---|---|---|---|---|
| **`x-ai/grok-4.20`** | **1.25 / 2.50 / 0.20** | 2,000,000 | 6.2 | **9.9** | **7.5** | 8.0 | 64.2 | 1571 | 15.9 |
| `x-ai/grok-4.20` non-reasoning | same | same | **8.2** | 8.5 | 6.2 | — | 51.8 | — | — |
| `x-ai/grok-4.5` | 2.00 / 6.00 / 0.30 | 500,000 | 4.9 | 8.5 | 5.8 | 4.5 | 62.3 | 1576 | 17.7 |
| `x-ai/grok-4.6` (avoid) | 2.00 / 6.00 / 0.50 | 500,000 | 3.6 | 5.5 | 3.0 | 3.0 | **19.8** | — | — |
| **`mistralai/mistral-large-2512`** | **0.50 / 1.50 / 0.05** | 262,144 | 6.3 | 6.7 | 6.8 | 6.8 | 58.5 | 1409 | 28.2 |
| **`deepseek/deepseek-v4-flash`** | **0.085 / 0.169 / 0.017** | 1,048,576 | 3.3 | 3.3 | 7.2 | **9.5** | 59.2 | 1556 | 20.9 |
| `deepseek/deepseek-v4-pro` (Paragon) | 0.948 / 1.896 / 0.079 | 1,048,576 | 3.6 | 2.0 | 3.0 | 4.5 | 48.5 | 1552 | 19.7 |
| `z-ai/glm-4.7` | 0.40 / 1.75 / 0.08 | 204,800 | 5.9 | 2.7 | 4.8 | — | 49.4 | 1411 | 26.4 |
| `z-ai/glm-5.3` | 1.40 / 4.40 / 0.26 | 1,310,720 | — | — | — | — | — | **2064** | **8.4** |
| `z-ai/glm-5.2` (avoid) | 0.60 / 2.00 / 0.15 | 1,048,576 | 3.7 | 2.0 | **0.5** | **0.0** | 29.4 | 1753 | 13.1 |
| `moonshotai/kimi-k3` | 1.796 / 9.006 / 0.205 | 1,048,576 | — | — | — | — | — | **2071** | 9.7 |
| `minimax/minimax-m2.5` (avoid) | 0.27 / 1.08 / 0.027 | 204,800 | 3.1 | **0.7** | 1.0 | 1.0 | 18.1 | 1358 | 26.8 |
| `google/gemini-3.8-flash` | 0.75 / 3.75 / 0.075 | 1,048,576 | **7.6** | 3.3 | 2.2 | 1.5 | 39.3 | 1750 | 22.6 |
| `xiaomi/mimo-v2.5-pro` (Lumina) | 0.435 / 0.870 / **0.004** | 1,050,000 | 4.3 | 2.4 | 1.8 | — | 42.6 | 1491 | 25.5 |
| `anthropic/claude-sonnet-5` (avoid) | 2.00 / 10.00 / 0.20 | 1,000,000 | 1.8 | 1.3 | 1.8 | 1.5 | 40.5 | 1791 | 11.6 |
| `openai/gpt-6-astra` (avoid) | 10.00 / 50.00 / 1.00 | 1,050,000 | 3.1 | **0.2** | 2.8 | 1.5 | 52.9 | **2164** | 8.4 |

### Reading the table

**Grok 4.20 is the standout.** The only model simultaneously smart (UGI 64.2), willing (W/10 7.5,
Adherence 8.0), genuinely dark (6.2-8.2), fully explicit (9.9), and cheap, on a 2M window. It also
has the highest positivity-bias-avoidance residual of any large model on EQ-Bench, meaning it
resists imposed optimism far more than its raw ability predicts. Non-reasoning mode trades some
intelligence for a higher dark score.

**Do not use Grok 4.6.** It regressed hard: UGI 64.2 to 19.8, W/10 7.5 to 3.0. Newer is worse.

**Mistral Large 3 is the best-balanced open model and the only one whose vendor policy permits this
use case.** Mistral's Usage Policy (effective 2026-06-11) prohibits only CSAM and non-consensual
intimate imagery. No clause against adult content, erotica or roleplay, uniquely among major
Western labs. Apache 2.0, structured outputs supported. Weakness is prose polish (Elo 1409, slop 28.2).

**DeepSeek V4 Flash is the willingness/price champion.** W/10 7.2 with **Adherence 9.5**, the
highest instruction-adherence in the table, meaning it will not quietly soften a scene. Its own
dark/nsfw lean is low (3.3/3.3), so it complies rather than volunteers, and needs driving.
Nearly free. **Turn reasoning off** — enabling it drops W/10 to 5.2 and Adherence to 6.5. Note
V4-Pro is *more* restrictive than V4-Flash despite being smarter.

**GLM has a split personality.** GLM-5.3 has the 4th-best prose in the world (Elo 2064) and
near-best slop, but GLM-5.2 scores W/10 0.5 with **Adherence 0.0**. This family refuses at the
front door then writes beautifully once inside a roleplay frame.

**Gemini is the odd one out.** Highest writing scores and a genuinely high dark lean (6.2-7.6), but
nsfw 1.5-3.3 and W/10 2.2. It will go to bleak places, not explicit ones. Worth knowing if the dark
material is not primarily sexual.

### Dedicated RP finetunes

On OpenRouter the selection is thin and mostly stale:

| Model | Price | Ctx | dark | nsfw | W/10 | Notes |
|---|---|---|---|---|---|---|
| `thedrummer/unslopnemo-12b` | 0.40/0.40 | 1,024,000 | 7.3 | 8.9 | 6.2 | v4.1, from 2024 |
| `thedrummer/cydonia-24b-v4.1` | 0.30/0.50 | 131,072 | — | — | — | last updated 2025-12 |
| `sao10k/l3.3-euryale-70b` | 0.65/0.75 | 131,072 | — | — | — | lineage abandoned |
| `anthracite-org/magnum-v4-72b` | 2.50/5.00 | 32,768 | — | — | — | Magnum dead, last release 2024-11 |
| `aion-labs/aion-2.0` | 0.80/1.60 | 131,072 | — | — | — | DeepSeek V3.2 variant, "strong at introducing tension, crises, conflict" |
| `minimax/minimax-m2-her` | 0.30/1.20 | 65,536 | — | — | — | **max output 2,048 tokens**, useless for long replies |

Lineage status from live HuggingFace timestamps:

- **TheDrummer** — healthiest, restructured. New lines Orion-26B-A4B-v1 (2026-09-06) and
  Artemis-31B-v1.1 (2026-08-06) on Gemma-4-31B; Behemoth-128B-v3 rebased on Mistral-Medium-3.5.
  **Cydonia untouched since 2025-12-17**; anyone still recommending it is working from stale info.
- **ArliAI** — pivoted from RPMax to "Derestricted". `GLM-4.6-Derestricted-v3` scores
  **UGI 65.9 / dark 7.1 / W-10 9.8**, arguably the best smart-and-willing open model measured.
- **sophosympatheia** (Midnight Miqu's author) — active but moved on. No Miqu-derived model is current.
- Active dark-RP builders: **Naphula** (shipping 2026-09-11), **DarkArtsForge**, **Vortex5**,
  **zerofata**, **SicariusSicariiStuff**, **ReadyArt**.
- **Dead:** Magnum (2024-11), EVA (Dec 2024), Sao10K/Euryale, NeverSleep/Lumimaid (2024-07).
  Steelskull dormant.

The highest-scoring finetunes are **not on OpenRouter** and need local hosting or a subscription:
- **ArliAI** — $30/mo Pro (256K ctx, up to 355B, unlimited requests, "Zero-Log"), $20 Plus (128K),
  $15 Core (32K). They also build the Derestricted models.
- **Featherless** — $25/mo Chat but only 32K context (too small), $50/mo Developer (256K).

**Warning on "decensored" models.** `p-e-w/heretic` automates refusal removal and heretic'd models
dominate the max-willingness bracket (W/10 9.5-10.0), but their **dark scores stay mediocre
(1.1-4.4) and intelligence drops sharply**. Removing refusals is not the same as producing dark
prose.

---

## 4. Refusal behaviour and background tasks

| Family | W/10 | Adherence | nsfw | Practical read |
|---|---|---|---|---|
| Claude (Fable 5 / Sonnet 5 / Opus 4.8) | 1.2-1.8 | 1.5 | 1.1-1.8 | Hard refusal. Best prose on the board, unusable here. |
| GPT-6 / GPT-5.6 | 2.2-2.8 | 1.5 | **0.2** | Hard refusal plus constant instruction drift. |
| Gemini 3.7/3.8 Flash | 2.2 | 1.5 | 1.5-3.3 | Refuses explicit, will go dark. |
| Grok 4.20 / 4.5 | 5.8-7.5 | 4.5-8.0 | 8.5-9.9 | The exception. |

### Policy, not just behaviour

- **Anthropic** — Usage Policy (effective 2025-09-15) has a "Do Not Generate Sexually Explicit
  Content" section: no depicting sex acts, no sexual fetishes or fantasies, no erotic chats. **No
  carve-outs** for adult platforms, age verification, or approved API customers. Repeated violations
  escalate to account suspension.
- **OpenAI** — adult mode announced, repeatedly delayed, indefinitely paused 2026-03-26.
- **Google** — prohibited, narrow educational/scientific exceptions.
- **DeepSeek's own first-party API** — prohibits pornographic/obscene/sexually explicit content.
  **This is why to use the open weights via third-party hosts** (DigitalOcean, DeepInfra, Parasail)
  rather than `api.deepseek.com`. Same weights, different terms.
- **Mistral** — the permissive outlier, as above.
- **xAI** — most permissive frontier vendor.

### Can Claude do the memory bookkeeping on explicit source text?

Partly, and Anthropic documents the limitation. From their content-moderation guide:

> "All Claude models are trained with built-in safety behaviors. This may result in Claude moderating
> content deemed particularly dangerous (in line with the Acceptable Use Policy), regardless of the
> prompt used. **For example, an adult website that wants to allow users to post explicit sexual
> content may find that Claude still flags explicit content as requiring moderation, even if they
> specify in their prompt not to moderate explicit sexual content.**"

That is exactly this scenario, named by the vendor. So:

1. Claude will process explicit input for narrow classification and high-level summarization.
2. It will apply its own judgment regardless of the system prompt. Expect sanitized summaries,
   flagged content, occasional refusals on the darkest material.
3. Adherence of 1.5 means it deviates from instructions often, which for a memory engine means
   silently dropping or euphemizing the plot-critical details that most need tracking.
4. **Routing a high volume of explicit content through the Anthropic API is against the Usage Policy
   and puts the key at risk**, even for read-only tasks.

**Conclusion: do not use Claude for the memory engine on this project.** Not because it cannot parse
the text, but because it is the wrong tool: unreliable on this content and a policy risk. Use an
uncensored JSON-capable model instead, at a fraction of the cost. SillyTavern's own docs reach the
same conclusion: "it is not recommended to use AI assistants to generate summaries if your chat
contains NSFW content."

Keep the Anthropic key for what it is genuinely best at, such as writing this app's code.

---

## 5. Prompt caching

### Provider matrix

| Provider | Auto or explicit | Write × | Read × | TTL | Min prefix |
|---|---|---|---|---|---|
| Anthropic | Both | 1.25× (5m) / 2× (1h) | 0.1× (0.025× on Fable 5.1) | 5 min / 1 h | 512-4,096 by model |
| OpenAI | Auto; explicit 5.6+ | 1.25× (5.6+) | 0.1× | ~30 min | 1,024 |
| **DeepSeek** | Automatic | 1.0× | **~0.02-0.03×** | hours-days, best effort | undocumented |
| Google Gemini | Implicit + explicit | 1.0× implicit | 0.1× | 60 min explicit | 2,048 / 4,096 |
| **xAI Grok** | Automatic | **free** | 0.15-0.25× | undocumented | undocumented |
| Mistral | Automatic | 1.0× | 0.1× | undocumented | **64 tokens** |
| Moonshot / Z.AI | Automatic | free | 0.1-0.2× | undocumented | 256 (Kimi) |

Anthropic's minimums are four tiers, not two: **512** (Opus 5, Fable 5/5.1), **1,024** (Sonnet 5,
Sonnet 4.5/4.6, Opus 4.8), **2,048** (Opus 4.7), **4,096** (Opus 4.5/4.6, **Haiku 4.5**). A
2,000-token card plus system prompt **silently will not cache at all on Haiku 4.5**, with no error.
Check `usage.cache_creation_input_tokens`.

### Through OpenRouter

Automatic passthrough on OpenAI, DeepSeek, Grok, Groq, Moonshot, Z.AI, Gemini. Explicit
`cache_control` needed for Anthropic and Qwen. No OpenRouter markup on upstream cache pricing.
Inspect via `prompt_tokens_details.cached_tokens`, `cache_write_tokens`, `cache_discount`.

**Provider routing is the hidden cache-killer.** Two fixes:

*Sticky routing* activates automatically after a cache hit and holds for 10 minutes of inactivity,
timer resetting per request. Force it early with a top-level `session_id` (≤256 chars) or
`x-session-id` header.

*Hard pin* (recommended for an RP app):
```json
{ "provider": { "order": ["deepinfra"], "allow_fallbacks": false } }
```
`allow_fallbacks: false` makes the request fail rather than silently route to a cold-cache provider.
Note `provider.order` **disables** sticky routing; that is choosing manual control.

One more reason to pin: **`structured_outputs` support varies by provider, not just by model.** On
`deepseek/deepseek-v4-flash`, DigitalOcean/DeepInfra/Alibaba support it while
GMICloud/SiliconFlow/Novita do not. Also `supports_implicit_caching` is `false` on nearly every
endpoint sampled, so send explicit breakpoints.

### What breaks a cache

Caching is strictly prefix-based, hierarchy `tools` → `system` → `messages`. A change at one level
invalidates that level and everything after.

| Change | Result |
|---|---|
| Edit any earlier message | Everything after it |
| Reorder messages | Gone |
| Insert retrieved text mid-prompt | Everything after the insertion point, **every turn, forever** |
| Change system prompt, even +1 sentence | System + messages |
| Change tool definitions, incl. **non-deterministic JSON key order** | **Entire** cache |
| Change model | Gone. Caches are per-model, per-workspace |
| Change provider | Gone |
| Add/remove an image anywhere | Messages cache |
| Thinking config / `output_config.effort` | Always messages; model-specific for tools/system |
| **`temperature`, `top_p`, `max_tokens`** | **Does not break the cache** |

On temperature: verified by absence from every provider's invalidation table plus the mechanism
(caches store K/V matrices; sampling happens after the forward pass). Strong inference rather than a
quoted fact.

**Landmine:** on Fable 5.1+ and accounts created on or after 2026-08-31, an edited history makes
preserved `thinking` blocks **return a 400 error**, not a cache miss:
`"Invalid signature in thinking block. The block is bound to a different conversation."` Escape
hatch: `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`.

### Prompt ordering

| # | Component | Where |
|---|---|---|
| 1 | Tool definitions | `tools`, frozen per app version |
| 2 | System prompt, style rules | `system`, frozen |
| 3 | Character card, persona, example dialogues | `system`, frozen per chat |
| 4 | Constant lorebook entries | end of `system` ← explicit breakpoint |
| 5 | Long-term memory summary | **head of `messages`**, never `system` |
| 6 | Chat history | `messages` ← automatic rolling breakpoint |
| 7 | Triggered lore, author's note, latest user message | tail, after the breakpoint |

**Three rules that matter most:**

**Never interpolate anything dynamic into `system`.** No `{{time}}`, no `{{random}}`, no usernames,
no conditional sections. Each variant is a distinct prefix. One measured case cost **$4.24/run
instead of $0.59** purely from a per-request timestamp ahead of the stable prefix.

**Summaries do not belong in the system prompt.** A rolling summary updating every 20 turns, sitting
in `system`, invalidates everything the turn it changes. At the head of `messages` only the messages
cache is lost.

**Make retrieval append-only.** Per SillyTavern issue #5852: "Even @Depth fails because as the
conversation moves forward, the injection point shifts relative to the tail, destroying the cached
prefix block." The fix is to **bake a triggered lore entry into the chat log as an immutable message
at its chronological position** rather than re-injecting it as a volatile modifier each turn. On
Anthropic there is a sanctioned primitive: turn-scoped system messages with
`clear_at: "next_user_message"`, which render only while no later user message exists, then stay in
the array rendering nothing at zero token cost.

General rule: **a breakpoint caches everything older than it. Set the breakpoint deeper than the
deepest volatile injection.**

### Caching versus trimming

In direct tension. OpenAI's cookbook: "When you drop, summarize or compact earlier turns in a
conversation, you'll break the cache."

**Naive rolling-window trimming is the worst possible strategy.** Once history exceeds the window
and you drop from the front every turn, the prefix changes every turn forever: a permanent 100% miss
rate at the 1.25× write premium. **Batched compaction at story beats is the fix.** Anthropic's
measurements: pruning at task boundaries yields 89% cache reads on the first request after a
boundary and 81% between them; context editing costs **+74% on short runs but −32% on long runs**.
Batch size decides the sign. Trimming from the front is legal; trimming from the middle is not.

Real SillyTavern measurements (Cache-Refresh extension, actual chats):

| | 12-message chat | 76-message chat |
|---|---|---|
| No caching | $0.0185 (100%) | $0.0477 (100%) |
| Depth-2 + system cache | $0.0100 (54%) | $0.0110 (**23%**) |
| + cache-refresh ping | $0.00257 (14%) | $0.00544 (**11%**) |

Caching gets *better* as chats grow, and keeping the cache warm roughly halves cost again. Idle
expiry, not prompt structure, is the bigger cost driver at human pacing. Counterpoint from ST issue
 #3848: pinging is itself billable (simulated: no caching $7.00, optimal $1.30, ping-50% $1.90,
ping-100% $2.50). Ping adaptively, or use `ttl: "1h"`; Anthropic's crossover is about one gap in 30
falling between 5 minutes and an hour.

---

## 6. Cost math

**Assumptions:** 100 messages/day × 30 days = 3,000 calls/month. Average reply 600 output tokens.
Steady-state prompt = the full window, which is what a month-long story looks like. With caching,
Δ = 750 new tokens per turn written fresh, the rest a cache read.

Raw volume: 96M input tokens/month at 32k, 192M at 64k, 1.8M output.

```
cost = (P − 750) × cache_read  +  750 × input  +  600 × output      [all ÷ 1e6]
```

### 32k context window

| Option | No cache | Cache 100% | Cache 70% |
|---|---|---|---|
| Nemotron 3 Ultra `:free` | **$0.00** | — | — |
| MiMo V2.5 | $13.94 | **$1.10** | $4.95 |
| DeepSeek V4 Flash | $8.43 | **$2.08** | $3.98 |
| DeepSeek V4 Flash @ DigitalOcean | $6.82 | **$2.04** | $3.47 |
| MiMo V2.5 Pro (Lumina) | $43.33 | **$2.92** | $15.04 |
| GLM-5.3-Flash | $15.30 | $4.05 | $7.42 |
| Mistral Large 3 | $50.70 | $8.51 | $21.17 |
| GLM-4.7 | $41.55 | $11.55 | $20.55 |
| DeepSeek V4 Pro (Paragon) | $94.40 | $12.95 | $37.39 |
| **Grok 4.20** | $124.50 | **$26.06** | $55.59 |
| GLM-5.3 | $122.10 | $35.16 | — |
| Claude Sonnet 5 | $210.00 | $42.38 | $107.06 |
| Claude Opus 5 | $525.00 | $105.94 | $267.66 |

### 64k context window

| Option | No cache | Cache 100% | Cache 70% |
|---|---|---|---|
| Nemotron 3 Ultra `:free` | **$0.00** | — | — |
| MiMo V2.5 | $27.74 | **$1.39** | $9.19 |
| DeepSeek V4 Flash @ DigitalOcean | $13.34 | **$3.66** | $6.57 |
| DeepSeek V4 Flash | $16.55 | $3.70 | $7.56 |
| MiMo V2.5 Pro (Lumina) | $86.09 | **$3.30** | $27.84 |
| GLM-5.3-Flash | $29.70 | $6.93 | $13.76 |
| Mistral Large 3 | $98.70 | $13.31 | $38.93 |
| GLM-4.7 | $79.95 | $19.23 | $37.45 |
| DeepSeek V4 Pro (Paragon) | $185.39 | $20.53 | $69.99 |
| **Grok 4.20** | $244.50 | **$45.26** | $105.03 |
| Claude Sonnet 5 | $402.00 | $61.58 | $192.50 |
| Claude Opus 5 | $1,005.00 | $153.94 | $481.26 |

Worked example, Grok 4.20 at 64k with full caching:

```
per turn:  (64,000 − 750) × $1.25/1e6  = $0.0791   cache read
         +        750     × $1.25/1e6  = $0.0009   new input
         +        600     × $2.50/1e6  = $0.0015   output
                                       = $0.0815 / turn
× 3,000 turns                          = $244.50   without caching
                                       = $45.26    with caching   (81% saving)
```

### Against what was being paid

Roughly $250/month on Tipsy. Tipsy charges **gems per 10,000 tokens of the entire Memory Usage, per
message** — "Model Rate: The Gem cost per 10,000 tokens used" — with Luxury/Prestige at **100 gems
per 10k tokens** versus Sake V2 at 3. The whole re-sent context was billed every turn, at Opus
rates, with none of the caching discount passed through. At 32k context that is 3.2× the headline
rate per message.

| Setup | Monthly | vs Tipsy |
|---|---|---|
| Free tier (Nemotron 3 Ultra) | **$0** + $10 one-off | −100% |
| DeepSeek V4 Flash, 64k, cached | **~$4-7** | −97% |
| MiMo V2.5 Pro (Lumina's engine), 64k, cached | ~$3-28 | −89% to −99% |
| Mistral Large 3, 64k, cached | ~$13-39 | −84% |
| **Grok 4.20, 64k, cached** | **~$45-105** | −58% to −82% |
| ArliAI Pro subscription (unlimited, 256K, zero-log) | $30 flat | −88% |

Even the most premium genuinely-uncensored option costs less than half what was being paid for a
model that refused.

---

## 7. Structured output and the memory engine

`structured_outputs` is supported on all DeepSeek V3.x/V4.x, all GLM 4.6-5.3, MiniMax M2.5/M3, Kimi
K2.5/K3, Mistral Large 3 and Small, all Qwen 3.5-3.8, Nemotron 3 paid variants, Grok 4.3/4.20,
Xiaomi MiMo V2.5/Pro, Llama 4 Maverick.

The RP finetunes are visibly weaker:

| Model | `structured_outputs` | `tools` |
|---|---|---|
| `thedrummer/unslopnemo-12b` | Yes | Yes |
| `thedrummer/cydonia-24b-v4.1` | Yes | **No** |
| `sao10k/l3.3-euryale-70b` | Yes | No |
| `anthracite-org/magnum-v4-72b` | Yes | No |
| `aion-labs/aion-rp-llama-3.1-8b` | **No** | No |
| `nousresearch/hermes-4-405b` | `response_format` only | No |

**The current free Nemotron 3 Ultra does NOT support structured outputs.** Its free endpoint exposes
only `tools`, `tool_choice`, `seed`, `temperature`, `top_p`. The paid variant supports the full set.
The free endpoint also lacks `repetition_penalty`, `top_k` and `min_p`, which matters for long
roleplay: no repetition penalty means slop loops over thousands of messages.

Two caveats from OpenRouter's docs:
1. "Some guarantee schema-conforming output, while others translate your schema into their own
   structured-output format or **treat it as a strong hint**, so exact compliance is not guaranteed
   on every endpoint." Always validate and retry.
2. Support is **per-endpoint, not per-model.** Set `"provider": {"require_parameters": true}` to
   route only to endpoints that honour it.

### Recommendation: split the two jobs

Use two different models, for three reasons pointing the same way:

1. **Prose and JSON want opposite settings.** Prose wants high temperature, repetition penalty, no
   reasoning. Extraction wants temperature 0, a strict schema, possibly reasoning on.
2. **Separate calls preserve the cache.** The memory engine reads the transcript and writes a state
   sheet; sharing the prose prompt would mutate the prefix. Keep it independent, cheap, uncached.
3. **Cost is negligible either way.** Summarizing a 64k window once every 20 turns on
   `deepseek/deepseek-v4-flash` is roughly **$0.80/month**.

| Job | Model | Why |
|---|---|---|
| **Prose** | `x-ai/grok-4.20` (premium) or `deepseek/deepseek-v4-flash` reasoning-off (budget) | Highest willingness + Adherence, will not soften |
| **Memory, facts, state sheet, promises** | `deepseek/deepseek-v4-flash` or `nvidia/nemotron-3-nano-30b-a3b`, temp 0, JSON schema, `require_parameters: true` | Reliable JSON, uncensored so it will not sanitize the plot, ~$1/month |
| **Never** | Claude, GPT | Will editorialize or refuse on the source text, policy risk |

---

## 8. Could not verify

- **Reddit, entirely.** No r/SillyTavernAI megathreads, no community quotes, no preset popularity
  rankings, no user-reported slop fingerprints. Blocked at the crawler level across every route and
  mirror. The single biggest gap versus the brief.
- **Nemotron 3 Ultra's dark/NSFW/willingness scores.** Not on the UGI leaderboard. EQ-Bench prose
  numbers only.
- Whether the free Nemotron endpoint really accepts a 1M-token prompt.
- Which specific Sake model maps to Gemini versus Grok. Grok is the stronger candidate given xAI is
  in Tipsy's Annex A and is the most permissive vendor, but there is no direct evidence.
- Tipsy's exact gem-to-dollar rate. The Model Reference Table renders only behind login.
- FictionLab's ToS and privacy policy. Hard Cloudflare challenge on every legal page.
- Whether FictionLab actually fine-tunes or just wraps stock endpoints with system prompts. Their
  phrasing ("received some FL magic") suggests the latter.
- Z.AI's cache-read discount. Docs say 0.5×, price list implies ~0.19×.
- TTLs for Mistral, Together, Fireworks, DeepInfra, Kimi, xAI. Not published.
- **Third-party review sites are actively wrong.** One claims FictionLab's Oracle V3 is "derived
  from modern Llama-based systems"; FictionLab's own docs say DeepSeek V3.2. Discard that class of
  source.

**On Tipsy's terms, worth recording.** Their privacy policy (updated 2026-09-05) says they use user
data "including to train our artificial intelligence/machine learning models," and their ToS grants
a **"perpetual, irrevocable"** sublicensable licence to user content, with rights that survive
account termination. A strong argument for owning your own transcripts.

---

## Bottom line

1. **Buy $10 of OpenRouter credit.** Unlocks 1000 free requests/day, and the credit works on paid
   models too.
2. **Do not build on the free tier.** It requires opting into training *and* prompt publication,
   which contradicts the stated requirement. The paid alternative is $2-7/month.
3. **Prose model: `x-ai/grok-4.20`** (~$45/mo at 64k cached) for the best, or
   **`deepseek/deepseek-v4-flash` reasoning off** (~$4/mo) for cheap. Grok volunteers darkness,
   DeepSeek complies with it. Also try `mistralai/mistral-large-2512`, the only one whose vendor
   policy permits this use case and the best-balanced open model.
4. **Lumina's engine is directly purchasable** as `xiaomi/mimo-v2.5-pro` at $0.435/M with a $0.004/M
   cache read. Budget real effort for the system prompt; the base model's raw willingness is low and
   FictionLab's scaffolding does most of the work.
5. **Architect for caching from day one.** Frozen `system`, append-only `messages`, volatile content
   in the tail, retrieval baked into history as immutable events, `provider.order` pinned with
   `allow_fallbacks: false`. Worth 80%+ of the bill and very hard to retrofit.
6. **Separate memory model, always JSON-schema'd, `require_parameters: true`.** About a dollar a month.
7. **Keep Claude for writing the app, not the story.**

Realistic landing zone: **$5 to $50 a month**, against $250/month for a service routing the darkest
scenes to the most refusal-prone model family on the market.
