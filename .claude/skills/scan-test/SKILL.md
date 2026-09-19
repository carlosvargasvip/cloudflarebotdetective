---
name: scan-test
description: Run a real AI-crawler scan against a domain via the local dev server or the deployed Worker and summarize the result. Use to verify changes to scanning, scoring, or the CRAWLERS registry (the repo has no test suite).
---

Target domain: `$ARGUMENTS` (default `example.com`). Optional second word is the intent: `funnel | content | ecommerce | mixed` (default `mixed`).

1. Pick the base URL:
   - If the user said "prod"/"live", use `https://ai-crawler-audit.carlosvargas.workers.dev` (or the custom domain in `wrangler.toml`).
   - Otherwise use local dev: if nothing answers on `http://localhost:8787/api/health`, start `npx wrangler dev` in the background and wait for it to respond.
2. `curl -s -X POST <base>/api/scan -H 'content-type: application/json' -d '{"domain":"<domain>","intent":"<intent>"}'`
   - Scans make ~16 live probes with a 9s timeout each; allow up to ~60s.
   - A 429 is the KV rate limit (12 scans/IP/10 min), not a bug.
   - The response is a teaser (one finding). Fetch the full result with `curl -s <base>/api/report?id=<scanId>`.
3. Summarize from the full result: score, posture, `counts` (critical/warning/good), the `summary` block (training/agent/AI-search/classic-search stopped vs tested), and each critical/warning finding's title in one line.
4. If verifying a code change, compare against the behavior the change was supposed to produce and say plainly whether it did. Stop any dev server you started.
