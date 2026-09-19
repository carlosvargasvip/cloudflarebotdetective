# AI Crawler Gate Check

A lead-magnet scanner. Someone types their domain, the scan runs from the outside, they see a score and the worst finding, and the rest of the report unlocks after name and email.

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
npm install -g wrangler        # or use npx
cd ai-crawler-audit

npx wrangler login
npx wrangler kv namespace create LEADS
# paste the returned id into wrangler.toml under [[kv_namespaces]]

npx wrangler deploy
```

That gives you `https://ai-crawler-audit.<your-subdomain>.workers.dev`.

For a custom domain, uncomment the `[[routes]]` block in `wrangler.toml` and point it at a hostname on a zone in the same account.

### Wire lead capture

Set the webhook to anything that takes a JSON POST:

```bash
npx wrangler secret put LEAD_WEBHOOK_URL
```

The payload:

```json
{
  "name": "Ana",
  "email": "ana@example.com",
  "domain": "example-store.com",
  "intent": "ecommerce",
  "score": 48,
  "posture": "Partial",
  "criticals": 2,
  "country": "US",
  "createdAt": "2026-09-19T14:02:11.000Z"
}
```

Leads also land in KV regardless, so nothing is lost if the webhook is down. Pull them with:

```bash
npx wrangler kv key list --binding LEADS --prefix "lead:"
```

### Local dev

```bash
npx wrangler dev
```

---

## Files

| File | What it does |
|---|---|
| `src/worker.js` | Scan engine, scoring, lead capture, rate limiting, SSRF guards |
| `public/index.html` | The whole front end. One file, no dependencies beyond Google Fonts |
| `wrangler.toml` | Bindings and config |

### Front-end query params

- `?api=https://your-worker.workers.dev` points a copy of the HTML at a Worker on another origin. Useful for embedding the page inside ClickFunnels or any other host.
- `?cta=https://yourdomain.com/book` sets the destination of the "inside-the-dashboard review" button at the bottom of the report.

With no backend reachable, the page renders a clearly labelled demo report so it is never an empty shell.

---

## Embedding in ClickFunnels

Two options.

**Iframe.** Drop a custom HTML element on the page:

```html
<iframe src="https://crawlercheck.yourdomain.com/?cta=https://yourdomain.com/book"
        style="width:100%;border:0;height:1400px" title="AI Crawler Gate Check"></iframe>
```

Height is the annoyance. Add a `postMessage` resize handshake if it bothers you.

**Native form.** Skip the built-in gate, put a CF optin element on the page, and call the Worker's `/api/scan` from your own script. `access-control-allow-origin` is already `*`, so a browser on your funnel domain can call it directly. Gate the render behind your own form submit and let ClickFunnels own the contact record.

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

- Rate limited to 12 scans per IP per 10 minutes, backed by KV. Adjust in `rateLimit()`.
- Private ranges, localhost and `.internal` hosts are refused.
- Each probe times out at 9 seconds.
- The lead form has a honeypot field. Submissions that fill it get a `200` and are stored nowhere.
- Cloudflare's September 15, 2026 defaults apply to newly onboarded domains. Existing zones were left alone, which is exactly why so many of them score badly.
