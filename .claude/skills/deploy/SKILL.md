---
name: deploy
description: Deploy the ai-crawler-audit Worker to Cloudflare and smoke-test it. Use when the user asks to deploy, ship, or push changes live.
---

Deploy the Worker (name `ai-crawler-audit`) and verify it. Stop and report at the first failing step.

1. **Pre-flight**
   - `node --check src/worker.js`, `npm test`, `npm run lint`.
   - Confirm `wrangler.toml` still has `name = "ai-crawler-audit"` (never rename it — ClickFunnels pages are registered against its URL).
   - If `npx wrangler whoami` shows no login, ask the user to run `! npx wrangler login`.
2. **Deploy**: `npx wrangler deploy`. Capture the deployed URL from the output (`https://ai-crawler-audit.carlosvargas.workers.dev`, or the custom domain if `[[routes]]` is set).
3. **Smoke test** against the deployed URL:
   - `curl -s <url>/api/health` → expect `{"ok":true,"crawlers":N}`.
   - `curl -s -X POST <url>/api/scan -H 'content-type: application/json' -d '{"domain":"example.com","intent":"mixed"}'` → expect a teaser: `score`, `posture`, `scanId`, exactly one finding, and `hiddenFindings`. Then `curl -s <url>/api/report?id=<scanId>` → expect the full `findings` list. A 429 means the rate limit (12/IP/10 min), not a broken deploy.
   - `curl -sI <url>/` → expect 200 (static assets served).
4. **ClickFunnels check**: `curl -s <url>/ | grep -c cf-page-token` → expect ≥1. If the deployed host changed, both registered pages (`VVdagl` → `/`, `bvRpGn` → `/report`, workspace `RvgMoJ`) need their `external_url` updated, or opt-ins are rejected (the funnel is live). Never submit the opt-in form as a test — it creates a real contact.
5. Report: deployed URL, version id from wrangler output, and smoke-test results.
