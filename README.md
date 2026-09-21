# AI Crawler Gate Check

A lead-magnet scanner. Someone types their domain, the scan runs from the outside, they see a score and the worst finding, and the rest of the report unlocks after a ClickFunnels opt-in (name and email).

Runs entirely on Cloudflare Workers. No origin server, no framework, no build step.

---

## Why this works as a lead magnet

The scan produces a specific, verifiable claim about a site the prospect owns. Not a generic checklist. Three findings tend to do the converting:

1. **Stated policy is not enforced.** Their robots.txt says `ai-train=no` and GPTBot still gets a 200. They asked, nobody is checking.
2. **AI answer engines are blocked.** Somebody pasted a "block AI bots" rule and took the site out of ChatGPT, Perplexity and Claude citations along with it.
3. **Googlebot is caught in the same rule.** The expensive one. Rare, but when it shows up the call books itself.

The report ends with what the scan cannot see from outside, which is the natural handoff to a paid review inside their Cloudflare account.

---

## Deploy

```bash
npm install                    # Biome only; the Worker has no runtime dependencies
npx wrangler login
npx wrangler deploy
```

That serves `https://ai-crawler-audit.<your-subdomain>.workers.dev` (currently `https://ai-crawler-audit.carlosvargas.workers.dev`). The `KV` namespace id is already in `wrangler.toml`; on a fresh account create one with `npx wrangler kv namespace create ai-crawler-audit` and replace it.

For a custom domain, uncomment the `[[routes]]` block in `wrangler.toml`, then update both ClickFunnels pages' `external_url` to the new host (the page tokens stay the same).

### Local dev and checks

```bash
npx wrangler dev
npm test        # node:test unit tests for parsing, classification, scoring, teaser
npm run lint    # Biome
```

---

## Lead capture: ClickFunnels SDK

The page is two external (SDK) steps of the **AI Crawler Gate Check** funnel in ClickFunnels:

| Step | URL | Page token |
|---|---|---|
| 1. Scan + Opt-in | `/` | `cfp_Kx6WBDvZALsM87OEfw6FSOgr` |
| 2. Full Report | `/report` | `cfp_K432oeUKtS5mrEMcr5zybPOg` |

Both steps are served by the same `public/index.html`; a head script picks the token for the current path.

Flow:

1. `POST /api/scan` returns a **teaser** (score, posture, per-crawler verdicts, the headline finding) plus a `scanId`. The full result is held in KV for 30 days.
2. The gate form is an SDK opt-in: `first-name`, `email`, and hidden `custom-attribute:*` fields (`scanned_domain`, `site_type`, `crawler_score`, `crawler_posture`, `crawler_criticals`, `scan_id`) land on the ClickFunnels contact.
3. On submit the SDK records the opt-in and redirects to `/report`, which loads `GET /api/report?id=<scanId>` and renders the full report. The browser remembers the scan and the opt-in in `localStorage` (the redirect drops query strings).

The gate is enforced in the browser: `/report` only renders after this browser submitted the opt-in, but the report API itself is not tied to a verified contact. To make it strict, add a ClickFunnels webhook on opt-in that marks `scan:<id>` unlocked, and have `/api/report` check it.

The funnel is in **live mode**, so submissions only work at the registered URLs — `wrangler dev` / preview hosts load the SDK but it stays dormant (`url_mismatch`). Switch the funnel to test mode in ClickFunnels to exercise the flow locally without saving contacts.

---

## Files

| File | What it does |
|---|---|
| `src/worker.js` | Scan engine, scoring, teaser/report gating, rate limiting, SSRF guards |
| `public/index.html` | The whole front end (both funnel steps). One file, no dependencies beyond Google Fonts and the ClickFunnels SDK |
| `test/worker.test.js` | Unit tests (`npm test`) |
| `wrangler.toml` | Bindings and config |

### Front-end query params

- `?api=https://your-worker.workers.dev` points a copy of the HTML at a Worker on another origin.
- `?cta=https://yourdomain.com/book` sets the destination of the "inside-the-dashboard review" button at the bottom of the report.

Both are remembered for the `/report` step. With no backend reachable, the page renders a clearly labelled demo report (its gate unlocks locally and never sends a lead).

---

## What the scan actually does

Per domain, in parallel:

- `GET /robots.txt`, parsed for user-agent groups, full disallows, and a `Content-Signal:` line (`search`, `ai-input`, `ai-train`)
- `GET /llms.txt`
- 16 `GET /` requests to the homepage, each wearing a different real crawler user agent

Each response is classified from its status and Cloudflare headers:

| Signal | Meaning |
|---|---|
| `200` | Allowed |
| `403` / `401` | Blocked |
| `402` + `crawler-price` | Pay per crawl is charging for access |
| `cf-mitigated: challenge` | Challenged |
| `429` | Rate limited |
| `cf-ray` present | Cloudflare is in front of the zone |

Scoring is weighted across seven components: Cloudflare present, robots.txt present, Content Signals declared, training crawlers stopped, stated policy matching actual enforcement, AI answer engines reachable, and classic search crawlers unharmed. Blocking Googlebot or Bingbot caps the score at 40 regardless of everything else.

### The honest limitation

The probes identify themselves by user agent from an ordinary Cloudflare IP. Real crawlers are verified by network and signature. So a `403` means one of two things: the site's policy blocks that crawler, or the edge caught what it reasonably thinks is an impostor. Both are worth knowing, and neither can be separated from outside.

Say this in the report rather than hiding it. It is what makes the paid review worth buying, and it keeps you from telling a client something that turns out to be wrong.

---

## The dashboard checklist for the paid review

What to actually open in the client's Cloudflare account, in order:

1. **Security > Settings > Configure AI bot policies.** Three categories, each set to Block on all pages, Block on pages with ads, or Allow. Screenshot it. This is the single most load-bearing setting and most people have never seen it.
2. **Managed robots.txt toggle**, same screen. Tells you whether the Content Signals line is Cloudflare's or theirs.
3. **AI Crawl Control.** Real traffic history per crawler, plus whether crawlers are honoring robots.txt. This is the data no outside scan can produce.
4. **WAF > Custom rules.** Look for hand-rolled user-agent blocks. This is where Googlebot usually gets caught, and where rules contradict the category settings.
5. **Bot Fight Mode / Super Bot Fight Mode.** Often on from years ago and forgotten. Explains challenged generic scripts.
6. **Pay per crawl**, if they are eligible. Worth raising with content-heavy clients even if they do not enable it.

### What to recommend, by client type

**Funnels and lead gen.** Block Training. Block or allow Agent as they prefer. Allow Search. Their pages are not a content library, so the discovery upside is small and the downside of AI-summarized offer copy is real.

**Content and SEO.** Block Training, allow Search, and say so in Content Signals (`search=yes, ai-input=yes, ai-train=no`). Getting cited in AI answers is a growth channel. Add an `llms.txt`. The mistake here is blocking everything and disappearing.

**Ecommerce.** Block Training. Allow Search on product and category pages. Think carefully about Agent: assistant-driven shopping is growing, and blocking it on product pages while allowing it through checkout is usually the right shape. Watch for scrapers dressed as browsers, which this scan will not catch and Bot Management will.

---

## Notes

- Rate limited two ways: an atomic per-IP limiter binding (`SCAN_LIMITER`, 6 scans/60s) and a KV counter (12 per IP per 10 minutes, `rl:` keys). Repeat scans of the same domain within 10 minutes reuse a cached teaser (`cache:` keys) instead of re-probing the target.
- Private ranges, localhost, `.internal` hosts and IP literals are refused, including hex/octal forms (`0x7f.0.0.1`) that resolve to loopback.
- `?api=` is allowlisted to this origin or the canonical Worker; `?cta=` accepts only http(s) URLs.
- Each probe times out at 9 seconds.
- Cloudflare's September 15, 2026 defaults apply to newly onboarded domains. Existing zones were left alone, which is exactly why so many of them score badly.
