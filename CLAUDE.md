# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

AI Crawler Gate Check: a lead-magnet Cloudflare Worker (`src/worker.js`) plus a single-file front end (`public/index.html`, served via the `ASSETS` binding). Plain JS ES modules, no build step. `package.json` exists only for Biome; run `wrangler` through `npx`.

- Dev: `npx wrangler dev`. Tests: `npm test` (node:test, `test/worker.test.js`, imports the pure functions exported at the bottom of `worker.js`). Lint: `npm run lint` (Biome, `src/` + `test/`; `public/index.html` is not linted — check its inline scripts by extracting them and running `node --check`).
- A PostToolUse hook runs `node --check` + Biome lint on edited `.js` files.
- Don't run `npm run format` across whole files in unrelated changes — existing code isn't Biome-formatted and it would bury the real diff.
- For live behavior, run a real scan (`/scan-test`).

## Deploying

- Claude may deploy freely with `npx wrangler deploy` (use `/deploy`). Live at `https://ai-crawler-audit.carlosvargas.workers.dev`. Keep the Worker name `ai-crawler-audit` — the ClickFunnels pages are registered against this URL.
- KV binding `KV` holds scan results (`scan:<uuid>`, 30-day TTL) and rate-limit counters (`rl:<ip>:<window>`, 12 scans/IP/10 min). No leads are stored in KV.

## Lead capture: ClickFunnels SDK

Workspace "Carlos Vargas" (`RvgMoJ`), funnel "AI Crawler Gate Check" (`NDKoWg`, **live mode**), two external steps: `/` (page `VVdagl`) → `/report` (page `bvRpGn`). SDK reference: https://accounts.myclickfunnels.com/.well-known/sdk/create-external-page/skill.md (or the ClickFunnels MCP `external_page_reference` action).

- One `index.html` serves both steps; the head script sets `<meta name="cf-page-token">` per path. Each step has its own token — never swap or reuse them.
- `/api/scan` returns only a teaser (`toTeaser()`: headline finding + `hiddenFindings` count) plus `scanId`; the full result comes from `GET /api/report?id=`. Never put gated findings back in the scan response.
- Gate form fields are identified only by `data-cf-element` (`first-name`, `email`, `custom-attribute:<key>`). An SDK form may contain only SDK fields; the SDK owns submit (real form navigation → redirect to `/report`), so don't `preventDefault` it.
- The redirect drops query strings: scan context (`scanId`, `api`, `cta`, `optedIn`) lives in `localStorage` key `acgc-last-scan`. The gate is browser-side only; `/api/report` is not tied to a verified contact.
- Demo mode (no backend) must never render SDK fields — no demo leads.
- The funnel is live, so submits only work at the registered URLs; `wrangler dev` loads the SDK dormant (`url_mismatch`). Changing the host means updating both pages' `external_url` (tokens stay the same).
- Submitting the opt-in creates a real ClickFunnels contact — don't submit it in automated checks.
- If a CSP is ever added, allow `https://sdk.myclickfunnels.com` in `script-src`, `connect-src`, and `form-action`.

## Gotchas

- Scoring lives in `analyze()`: additive points per check, capped at 40 if Googlebot/Bingbot is blocked, then −12 per critical and −4 per warning, clamped 0–100. Finding severity can depend on `intent`. Report copy is hard-coded English there.
- Add or change crawlers only in the `CRAWLERS` registry (`probe: false` = robots.txt token only); probe count follows automatically. The front end's `CHECK_LIST` labels must match `CRAWLERS` labels for the manifest animation. Probes time out at `PROBE_TIMEOUT_MS` (9s).
- SSRF guard is a hostname regex blocklist only — keep it in mind when touching `normalizeDomain`/fetch logic.
- `?api=` points the page at a Worker on another origin, `?cta=` sets the booking link. If `/api/health` fails, the page renders a labelled demo report — a "working" page may not be hitting the backend.

## Style & git

- 2-space indent, single quotes, semicolons; separate sections with the existing `/* ---- * Section * ---- */` banner comments.
- Commit directly to `main` and push to `origin`.
