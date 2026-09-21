/**
 * AI Crawler Audit — scan engine
 * Cloudflare Worker. Deploy with: npx wrangler deploy
 *
 * Routes
 *   POST /api/scan          { domain, intent } -> teaser + scanId (full result held in KV)
 *   GET  /api/report?id=…   -> full result for a scanId (shown after the ClickFunnels opt-in)
 *   GET  /api/health
 * Everything else is served from the static assets binding (public/).
 * Leads are captured by the ClickFunnels SDK on the page, not by this Worker.
 */

/* ------------------------------------------------------------------ *
 * Crawler registry
 * ------------------------------------------------------------------ */

// behavior: 'training' | 'agent' | 'search'
// probe: true  -> we send a live request wearing this User-Agent
// probe: false -> robots.txt-only token (these tokens never fetch anything)
const CRAWLERS = [
  // --- Control / reference ---
  { id: 'browser',   label: 'Real browser (control)', vendor: 'Baseline', behavior: 'control', probe: true,
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' },
  { id: 'genericbot', label: 'Generic script (curl)', vendor: 'Baseline', behavior: 'control', probe: true,
    ua: 'curl/8.7.1' },
  { id: 'googlebot', label: 'Googlebot', vendor: 'Google', behavior: 'search', probe: true, seoCritical: true,
    ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
  { id: 'bingbot',   label: 'Bingbot', vendor: 'Microsoft', behavior: 'search', probe: true, seoCritical: true,
    ua: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)' },

  // --- Training crawlers ---
  { id: 'gptbot',    label: 'GPTBot', vendor: 'OpenAI', behavior: 'training', probe: true, token: 'GPTBot',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot' },
  { id: 'claudebot', label: 'ClaudeBot', vendor: 'Anthropic', behavior: 'training', probe: true, token: 'ClaudeBot',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ClaudeBot/1.0; +claudebot@anthropic.com' },
  { id: 'ccbot',     label: 'CCBot', vendor: 'Common Crawl', behavior: 'training', probe: true, token: 'CCBot',
    ua: 'CCBot/2.0 (https://commoncrawl.org/faq/)' },
  { id: 'bytespider', label: 'Bytespider', vendor: 'ByteDance', behavior: 'training', probe: true, token: 'Bytespider',
    ua: 'Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)' },
  { id: 'metabot',   label: 'meta-externalagent', vendor: 'Meta', behavior: 'training', probe: true, token: 'meta-externalagent',
    ua: 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)' },
  { id: 'amazonbot', label: 'Amazonbot', vendor: 'Amazon', behavior: 'training', probe: true, token: 'Amazonbot',
    ua: 'Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)' },

  // --- Agent / user-triggered fetches ---
  { id: 'chatgptuser', label: 'ChatGPT-User', vendor: 'OpenAI', behavior: 'agent', probe: true, token: 'ChatGPT-User',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot' },
  { id: 'claudeuser', label: 'Claude-User', vendor: 'Anthropic', behavior: 'agent', probe: true, token: 'Claude-User',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-User/1.0; +Claude-User@anthropic.com' },
  { id: 'perplexityuser', label: 'Perplexity-User', vendor: 'Perplexity', behavior: 'agent', probe: true, token: 'Perplexity-User',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user' },

  // --- AI search / answer engines (these send traffic back) ---
  { id: 'oaisearch', label: 'OAI-SearchBot', vendor: 'OpenAI', behavior: 'search', probe: true, token: 'OAI-SearchBot',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot' },
  { id: 'perplexitybot', label: 'PerplexityBot', vendor: 'Perplexity', behavior: 'search', probe: true, token: 'PerplexityBot',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot' },
  { id: 'claudesearch', label: 'Claude-SearchBot', vendor: 'Anthropic', behavior: 'search', probe: true, token: 'Claude-SearchBot',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com' },

  // --- robots.txt-only opt-out tokens (no live probe possible) ---
  { id: 'google-extended', label: 'Google-Extended', vendor: 'Google', behavior: 'training', probe: false, token: 'Google-Extended' },
  { id: 'applebot-extended', label: 'Applebot-Extended', vendor: 'Apple', behavior: 'training', probe: false, token: 'Applebot-Extended' },
];

const PROBES = CRAWLERS.filter((c) => c.probe);

/* ------------------------------------------------------------------ *
 * Input handling / SSRF guards
 * ------------------------------------------------------------------ */

const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i, /^127\./, /^0\./, /^10\./, /^192\.168\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^\[?::1\]?$/, /\.local$/i, /\.internal$/i,
  /^metadata\./i,
];

function normalizeDomain(raw) {
  if (typeof raw !== 'string') throw new Error('Enter a domain.');
  let v = raw.trim().toLowerCase();
  if (!v) throw new Error('Enter a domain.');
  v = v.replace(/^https?:\/\//, '').replace(/^www\./, '');
  v = v.split('/')[0].split('?')[0].split('#')[0].split('@').pop();
  v = v.split(':')[0];
  if (v.length > 253) throw new Error('That domain is too long.');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(v)) {
    throw new Error('That does not look like a valid domain.');
  }

  // Re-read the host the way fetch() will: `0x7f.0.0.1` and `0177.0.0.1` are 127.0.0.1
  // to the URL parser but sail past a regex written for dotted-decimal.
  let host;
  try { host = new URL(`https://${v}/`).hostname; } catch { throw new Error('That does not look like a valid domain.'); }
  if (host !== v) throw new Error('That host cannot be scanned.');
  // A scanner only ever needs real domain names, so refuse IP literals of any shape.
  if (/^\d+(\.\d+)*$/.test(host) || host.startsWith('[')) throw new Error('That host cannot be scanned.');
  if (BLOCKED_HOST_PATTERNS.some((re) => re.test(host))) {
    throw new Error('That host cannot be scanned.');
  }
  return host;
}

/* ------------------------------------------------------------------ *
 * Probing
 * ------------------------------------------------------------------ */

const PROBE_TIMEOUT_MS = 9000;

async function probeOnce(url, ua) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    try { await res.body?.cancel(); } catch { /* already consumed */ }

    const h = res.headers;
    return {
      status: res.status,
      finalUrl: res.url || url,
      server: h.get('server') || null,
      cfRay: h.get('cf-ray') || null,
      cfMitigated: h.get('cf-mitigated') || null,
      cfCache: h.get('cf-cache-status') || null,
      crawlerPrice: h.get('crawler-price') || h.get('crawler-exact-price') || null,
      retryAfter: h.get('retry-after') || null,
      error: null,
    };
  } catch (e) {
    return { status: 0, finalUrl: url, error: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, maxBytes = 120000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AI-Crawler-Audit/1.0)' },
      cf: { cacheTtl: 0 },
    });
    if (!res.ok) { try { await res.body?.cancel(); } catch {} return { status: res.status, text: '' }; }
    if (!res.body) return { status: res.status, text: '' };

    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    try { await reader.cancel(); } catch { /* already done */ }

    const buf = new Uint8Array(Math.min(size, maxBytes));
    let at = 0;
    for (const c of chunks) {
      if (at >= buf.length) break;
      buf.set(c.subarray(0, buf.length - at), at);
      at += c.length;
    }
    return { status: res.status, text: new TextDecoder().decode(buf) };
  } catch {
    return { status: 0, text: '' };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * robots.txt + Content Signals parsing
 * ------------------------------------------------------------------ */

function parseRobots(text) {
  const out = {
    present: Boolean(text?.trim()),
    raw: text || '',
    groups: [],              // [{ agents:[], disallowAll:bool, disallows:[], signals:{} }]
    contentSignals: null,    // { search, 'ai-input', 'ai-train' }
    cloudflareManaged: false,
    blockedTokens: new Set(),
    llmsTxtReferenced: /llms\.txt/i.test(text || ''),
  };
  if (!out.present) return out;

  if (/cloudflare/i.test(text) && /(managed|content signals|contentsignals\.org)/i.test(text)) {
    out.cloudflareManaged = true;
  }

  let current = null;
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.replace(/^﻿/, '').trim();
    if (!line) { continue; }

    // Content-Signal can appear as a comment line or a directive line.
    const sigMatch = line.match(/^#?\s*content-signals?\s*:\s*(.+)$/i);
    if (sigMatch) {
      const parsed = {};
      for (const part of sigMatch[1].split(',')) {
        const [k, v] = part.split('=').map((s) => (s || '').trim().toLowerCase());
        if (k) parsed[k] = v || '';
      }
      if (!out.contentSignals) out.contentSignals = parsed;
      if (current) current.signals = parsed;
      continue;
    }

    if (line.startsWith('#')) continue;

    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();

    if (field === 'user-agent') {
      if (!current || current.hasRules) {
        current = { agents: [], disallows: [], allows: [], disallowAll: false, hasRules: false, signals: null };
        out.groups.push(current);
      }
      current.agents.push(value);
    } else if (current && (field === 'disallow' || field === 'allow')) {
      current.hasRules = true;
      if (field === 'disallow') {
        current.disallows.push(value);
        if (value === '/') current.disallowAll = true;
      } else {
        current.allows.push(value);
      }
    }
  }

  for (const g of out.groups) {
    if (!g.disallowAll) continue;
    for (const a of g.agents) out.blockedTokens.add(a.toLowerCase());
  }
  return out;
}

function robotsVerdictFor(crawler, robots) {
  if (!robots.present) return 'no-robots';
  const token = (crawler.token || '').toLowerCase();
  if (token && robots.blockedTokens.has(token)) return 'disallowed';
  if (robots.blockedTokens.has('*')) return 'disallowed-wildcard';
  return 'allowed';
}

/* ------------------------------------------------------------------ *
 * Classification of a probe result
 * ------------------------------------------------------------------ */

function classify(r) {
  if (!r || r.error) return r?.error === 'timeout' ? 'timeout' : 'error';
  if (r.status === 402) return 'priced';                 // pay per crawl
  if (r.status === 403 || r.status === 401) return 'blocked';
  if (r.status === 429) return 'rate-limited';
  if (r.status === 503 && r.cfMitigated) return 'challenged';
  if (r.cfMitigated === 'challenge') return 'challenged';
  if (r.status >= 200 && r.status < 400) return 'allowed';
  if (r.status >= 500) return 'origin-error';
  return 'other';
}

const VERDICT_LABEL = {
  allowed: 'Allowed', blocked: 'Blocked', challenged: 'Challenged', priced: 'Charged (pay per crawl)',
  'rate-limited': 'Rate limited', timeout: 'No response', error: 'Unreachable',
  'origin-error': 'Origin error', other: 'Unclear',
};

/* ------------------------------------------------------------------ *
 * Scan
 * ------------------------------------------------------------------ */

async function runScan(domain, intent) {
  const origin = `https://${domain}`;
  const startedAt = Date.now();

  const [robotsRes, llmsRes, ...probeResults] = await Promise.all([
    fetchText(`${origin}/robots.txt`),
    fetchText(`${origin}/llms.txt`, 4000),
    ...PROBES.map((c) => probeOnce(`${origin}/`, c.ua)),
  ]);

  const robots = parseRobots(robotsRes.text);
  robots.llmsTxtPresent = llmsRes.status === 200 && llmsRes.text.trim().length > 0;

  const byId = {};
  PROBES.forEach((c, i) => { byId[c.id] = probeResults[i]; });

  const control = byId.browser;
  const onCloudflare = Boolean(
    control?.cfRay || /cloudflare/i.test(control?.server || '') ||
    PROBES.some((c) => byId[c.id]?.cfRay)
  );
  const siteReachable = classify(control) === 'allowed';

  const results = CRAWLERS.map((c) => {
    const raw = c.probe ? byId[c.id] : null;
    const verdict = c.probe ? classify(raw) : 'not-probed';
    return {
      id: c.id,
      label: c.label,
      vendor: c.vendor,
      behavior: c.behavior,
      probed: Boolean(c.probe),
      verdict,
      verdictLabel: c.probe ? (VERDICT_LABEL[verdict] || verdict) : 'robots.txt only',
      status: raw?.status ?? null,
      cfMitigated: raw?.cfMitigated ?? null,
      crawlerPrice: raw?.crawlerPrice ?? null,
      robots: robotsVerdictFor(c, robots),
      token: c.token || null,
    };
  });

  const analysis = analyze({ domain, intent, results, robots, onCloudflare, siteReachable, control });

  return {
    domain,
    intent: intent || 'mixed',
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    onCloudflare,
    siteReachable,
    robots: {
      present: robots.present,
      cloudflareManaged: robots.cloudflareManaged,
      contentSignals: robots.contentSignals,
      blockedTokens: Array.from(robots.blockedTokens),
      llmsTxtPresent: robots.llmsTxtPresent,
      lineCount: robots.raw ? robots.raw.split('\n').length : 0,
    },
    results,
    ...analysis,
  };
}

/* ------------------------------------------------------------------ *
 * Analysis / scoring
 * ------------------------------------------------------------------ */

const INTENT_COPY = {
  funnel: {
    name: 'Funnels / lead gen',
    priority: 'Protecting offer copy and keeping paid traffic clean matters more than AI discovery.',
  },
  content: {
    name: 'Content / SEO',
    priority: 'Getting cited by AI answer engines is a growth channel. Blocking the wrong bot costs visibility.',
  },
  ecommerce: {
    name: 'Ecommerce',
    priority: 'Product data is the asset. Scraping and price harvesting are the real risk, not training crawlers alone.',
  },
  mixed: {
    name: 'Mixed',
    priority: 'Balance discovery against content protection.',
  },
};

function analyze({ domain, intent, results, robots, onCloudflare, siteReachable }) {
  const findings = [];
  const get = (id) => results.find((r) => r.id === id);
  const group = (behavior) => results.filter((r) => r.behavior === behavior && r.probed && r.id !== 'browser' && r.id !== 'genericbot');

  const training = group('training');
  const agent = group('agent');
  const search = group('search').filter((r) => r.id !== 'googlebot' && r.id !== 'bingbot');
  const classicSearch = results.filter((r) => r.seoCritical || r.id === 'googlebot' || r.id === 'bingbot');

  const stopped = (r) => ['blocked', 'challenged', 'priced', 'rate-limited'].includes(r.verdict);
  const trainingBlocked = training.filter(stopped);
  const agentBlocked = agent.filter(stopped);
  const searchBlocked = search.filter(stopped);
  const classicBlocked = classicSearch.filter(stopped);

  let score = 0;
  let capped = false;

  if (!siteReachable) {
    findings.push({
      severity: 'critical',
      title: 'The site did not answer a normal browser request',
      detail: `A request to https://${domain}/ from a standard Chrome user agent did not return a page. Every other result below is unreliable until that is resolved.`,
      fix: 'Confirm the domain resolves, the origin is up, and no firewall rule is blocking datacenter IP ranges outright.',
    });
  }

  // --- Cloudflare presence ---
  if (onCloudflare) {
    score += 15;
    findings.push({
      severity: 'good',
      title: 'Cloudflare is in front of this site',
      detail: 'Responses carry Cloudflare edge headers, so the AI bot controls, managed robots.txt, and pay per crawl are all available on this zone.',
      fix: null,
    });
  } else {
    findings.push({
      severity: 'warning',
      title: 'No Cloudflare edge detected',
      detail: 'Responses show no Cloudflare edge headers. Whatever robots.txt says is a request, not a rule: nothing at the network layer is enforcing it.',
      fix: 'Move DNS to Cloudflare (the free plan includes the AI bot categories) or apply equivalent rules at the current CDN or WAF.',
    });
  }

  // --- robots.txt ---
  if (robots.present) {
    score += 10;
  } else {
    findings.push({
      severity: 'warning',
      title: 'No robots.txt found',
      detail: 'Crawlers that do honor stated preferences have nothing to read. This is the cheapest control available and it is missing.',
      fix: 'Turn on Cloudflare managed robots.txt, or publish a robots.txt with an explicit Content-Signal line.',
    });
  }

  // --- Content Signals ---
  const cs = robots.contentSignals;
  if (cs) {
    score += 15;
    const pretty = Object.entries(cs).map(([k, v]) => `${k}=${v}`).join(', ');
    findings.push({
      severity: 'good',
      title: 'Content Signals policy is declared',
      detail: `robots.txt states: ${pretty}. This is the machine-readable statement of how the content may be used, and it now carries weight with the major crawler operators.`,
      fix: null,
    });
    if (String(cs.search || '').startsWith('n')) {
      findings.push({
        severity: 'critical',
        title: 'Content Signals says search=no',
        detail: 'The policy asks search engines not to index this site. That is almost never intended and it applies to classic search, not just AI.',
        fix: 'Set search=yes unless the site is deliberately private.',
      });
    }
  } else {
    findings.push({
      severity: 'warning',
      title: 'No Content Signals policy declared',
      detail: 'robots.txt does not say how the content may be used. Search, ai-input, and ai-train are three separate permissions and right now none of them is stated.',
      fix: 'Add a Content-Signal line, or enable Cloudflare managed robots.txt which writes one for you.',
    });
  }

  // --- Classic search collateral damage (the expensive mistake) ---
  if (classicBlocked.length) {
    capped = true;
    findings.push({
      severity: 'critical',
      title: `Classic search crawlers are being stopped: ${classicBlocked.map((r) => r.label).join(', ')}`,
      detail: 'These are the crawlers behind Google and Bing organic results. A rule meant for AI bots is catching them too, which removes the site from search over time.',
      fix: 'Narrow the blocking rule so it targets AI bot categories only, and add a skip rule for verified search engine bots.',
    });
  } else {
    score += 10;
    findings.push({
      severity: 'good',
      title: 'Google and Bing crawlers are getting through',
      detail: 'Classic search indexing is unaffected by whatever AI rules are in place.',
      fix: null,
    });
  }

  // --- Training crawlers ---
  if (trainingBlocked.length >= Math.ceil(training.length * 0.6)) {
    score += 20;
    findings.push({
      severity: 'good',
      title: `Training crawlers are being stopped (${trainingBlocked.length} of ${training.length} tested)`,
      detail: `Stopped: ${trainingBlocked.map((r) => r.label).join(', ') || 'none'}. Content is not being collected freely for model training.`,
      fix: null,
    });
  } else {
    findings.push({
      severity: trainingBlocked.length ? 'warning' : 'critical',
      title: `Training crawlers are getting through (${training.length - trainingBlocked.length} of ${training.length} tested)`,
      detail: `Reached the site: ${training.filter((r) => !stopped(r)).map((r) => r.label).join(', ')}. These crawlers collect content to train or fine-tune models and send no traffic back.`,
      fix: 'In Cloudflare, go to Security Settings and set the Training category to Block. It applies across the zone on every plan.',
    });
  }

  // --- The consistency check: stated policy vs actual enforcement ---
  const statedNoTrain = cs && String(cs['ai-train'] || '').startsWith('n');
  const leaking = training.filter((r) => !stopped(r) && (statedNoTrain || r.robots === 'disallowed'));
  if (leaking.length) {
    findings.push({
      severity: 'critical',
      title: 'Stated policy is not enforced at the edge',
      detail: `robots.txt asks training crawlers to stay out, but ${leaking.map((r) => r.label).join(', ')} still received a 200 response. robots.txt is a sign on the door; nothing is checking it.`,
      fix: 'Back the stated policy with an actual block: Cloudflare AI bot categories, or a WAF custom rule on the verified bot category.',
    });
  } else if (statedNoTrain && training.length && trainingBlocked.length) {
    score += 20;
    findings.push({
      severity: 'good',
      title: 'Stated policy matches what the edge actually does',
      detail: 'robots.txt declares no training use and the edge enforces it. The policy is backed by a control rather than a request.',
      fix: null,
    });
  } else if (trainingBlocked.length && !cs) {
    score += 10;
    findings.push({
      severity: 'warning',
      title: 'Enforced at the edge, but not declared',
      detail: 'Training crawlers are being stopped, but robots.txt does not state the policy. Operators who do honor stated preferences have nothing to read, and there is no public record of intent.',
      fix: 'Add a matching Content-Signal line so the policy is stated as well as enforced.',
    });
  }

  // --- AI answer engines: the visibility trade ---
  if (searchBlocked.length === search.length && search.length) {
    const sev = intent === 'content' || intent === 'ecommerce' ? 'critical' : 'warning';
    findings.push({
      severity: sev,
      title: 'AI answer engines are blocked too',
      detail: `${searchBlocked.map((r) => r.label).join(', ')} cannot reach the site. These are the crawlers that put citations and links in AI answers. Blocking them is the AI equivalent of deindexing.`,
      fix: 'Separate the categories: block Training, allow Search. Cloudflare treats them as distinct settings.',
    });
  } else if (searchBlocked.length) {
    score += 5;
    findings.push({
      severity: 'warning',
      title: 'AI answer engines are treated inconsistently',
      detail: `Reaching the site: ${search.filter((r) => !stopped(r)).map((r) => r.label).join(', ') || 'none'}. Stopped: ${searchBlocked.map((r) => r.label).join(', ')}. Visibility in AI answers is partial and probably not deliberate.`,
      fix: 'Decide the policy once at the category level instead of per-bot, so it stays consistent as new crawlers appear.',
    });
  } else if (search.length) {
    score += 10;
    findings.push({
      severity: 'good',
      title: 'AI answer engines can reach the site',
      detail: `${search.map((r) => r.label).join(', ')} all returned a page. The site is eligible to be cited and linked in AI answers.`,
      fix: null,
    });
  }

  // --- Agent traffic ---
  if (agentBlocked.length === agent.length && agent.length) {
    findings.push({
      severity: intent === 'ecommerce' ? 'warning' : 'info',
      title: 'Agent traffic is blocked',
      detail: `${agentBlocked.map((r) => r.label).join(', ')} are stopped. These are fetches made when a real person asks an assistant to open or check this page.`,
      fix: intent === 'ecommerce'
        ? 'Agent-driven shopping is growing. Consider allowing agents on product pages and blocking on checkout.'
        : 'Reasonable if the goal is to keep humans on the page. Worth revisiting as assistant-driven browsing grows.',
    });
  } else if (agent.length && !agentBlocked.length) {
    score += 5;
    findings.push({
      severity: 'info',
      title: 'Agent traffic is allowed',
      detail: 'Assistants fetching this page on a person\'s behalf get through. Fine for discovery; worth watching if it distorts analytics or hits form endpoints.',
      fix: null,
    });
  }

  // --- Pay per crawl ---
  const priced = results.filter((r) => r.verdict === 'priced');
  if (priced.length) {
    score = Math.min(100, score + 10);
    findings.push({
      severity: 'good',
      title: 'Pay per crawl is active',
      detail: `${priced.map((r) => `${r.label}${r.crawlerPrice ? ` at ${r.crawlerPrice}` : ''}`).join(', ')} received a 402 Payment Required. Crawler access is being charged rather than given away.`,
      fix: null,
    });
  }

  // --- Blunt UA blocking ---
  const generic = get('genericbot');
  if (generic && stopped(generic) && !classicBlocked.length) {
    findings.push({
      severity: 'info',
      title: 'Generic scripts are challenged or blocked',
      detail: 'A plain script user agent was stopped, which suggests Bot Fight Mode or a broad automation rule is on. That catches unsophisticated scrapers but not crawlers that present a proper identity.',
      fix: 'Useful as a floor, but it is not an AI policy. The named crawlers identify themselves honestly and need category rules.',
    });
  }

  if (capped) score = Math.min(score, 40);
  // Every unresolved critical costs real money or real traffic. Make the number say so.
  score -= 12 * findings.filter((f) => f.severity === 'critical').length;
  score -= 4 * findings.filter((f) => f.severity === 'warning').length;
  score = Math.max(0, Math.min(100, score));

  let posture, postureLine;
  if (!onCloudflare && !robots.present) {
    posture = 'Wide open';
    postureLine = 'No edge controls and no stated policy. Anything that asks, gets.';
  } else if (capped) {
    posture = 'Over-blocking';
    postureLine = 'Rules are in place but they are catching crawlers that bring traffic in.';
  } else if (score >= 80) {
    posture = 'Deliberate';
    postureLine = 'Policy is stated, enforced, and separates the crawlers that take from the ones that send traffic back.';
  } else if (score >= 55) {
    posture = 'Partial';
    postureLine = 'Some controls are on, but the policy and the enforcement do not fully line up.';
  } else {
    posture = 'Unmanaged';
    postureLine = 'AI crawler access is mostly happening by default rather than by decision.';
  }

  const criticals = findings.filter((f) => f.severity === 'critical').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;

  const order = { critical: 0, warning: 1, good: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    score,
    posture,
    postureLine,
    counts: { critical: criticals, warning: warnings, good: findings.filter((f) => f.severity === 'good').length },
    intentNote: (INTENT_COPY[intent] || INTENT_COPY.mixed).priority,
    intentName: (INTENT_COPY[intent] || INTENT_COPY.mixed).name,
    findings,
    summary: {
      trainingStopped: trainingBlocked.length, trainingTested: training.length,
      agentStopped: agentBlocked.length, agentTested: agent.length,
      aiSearchStopped: searchBlocked.length, aiSearchTested: search.length,
      classicSearchStopped: classicBlocked.length, classicSearchTested: classicSearch.length,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Rate limiting
 * ------------------------------------------------------------------ */

async function rateLimit(env, ip, limit = 12, windowSec = 600) {
  // Atomic, per-colo burst guard. Stops the concurrent flood the KV counter below cannot see.
  if (env.SCAN_LIMITER) {
    const { success } = await env.SCAN_LIMITER.limit({ key: ip });
    if (!success) return false;
  }
  if (!env.KV) return true; // KV not bound: skip rather than fail
  const key = `rl:${ip}:${Math.floor(Date.now() / (windowSec * 1000))}`;
  const n = parseInt((await env.KV.get(key)) || '0', 10);
  if (n >= limit) return false;
  await env.KV.put(key, String(n + 1), { expirationTtl: windowSec + 60 });
  return true;
}

/* ------------------------------------------------------------------ *
 * Gating: the scan response is a teaser; the full result stays in KV
 * until the report page asks for it after the ClickFunnels opt-in.
 * ------------------------------------------------------------------ */

const SCAN_TTL_SEC = 60 * 60 * 24 * 7;
// Repeat scans of the same domain reuse a recent result instead of re-probing it.
// This is what actually caps how much traffic this Worker can aim at one site.
const SCAN_CACHE_TTL_SEC = 600;
const SCAN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Headline = first critical, else first warning, else first finding (findings are pre-sorted by severity).
function toTeaser(result) {
  const { findings, ...rest } = result;
  const headline = findings.find((f) => f.severity === 'critical') || findings.find((f) => f.severity === 'warning') || findings[0];
  return { ...rest, findings: headline ? [headline] : [], hiddenFindings: Math.max(0, findings.length - 1) };
}

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders(), ...extra },
  });

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

    if (url.pathname === '/api/health') return json({ ok: true, crawlers: PROBES.length, limiter: typeof env.SCAN_LIMITER?.limit === 'function', kv: Boolean(env.KV) });

    if (url.pathname === '/api/scan' && request.method === 'POST') {
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      if (!(await rateLimit(env, ip))) {
        return json({ error: 'Too many scans from this address. Try again in a few minutes.' }, 429);
      }
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, 400); }
      let domain;
      try { domain = normalizeDomain(body.domain); } catch (e) { return json({ error: e.message }, 400); }

      const intent = ['funnel', 'content', 'ecommerce', 'mixed'].includes(body.intent) ? body.intent : 'mixed';
      const cacheKey = `cache:${domain}:${intent}`;
      if (env.KV) {
        const hit = await env.KV.get(cacheKey);
        if (hit) return new Response(hit, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders() } });
      }

      try {
        const result = await runScan(domain, intent);
        if (!env.KV) return json(toTeaser(result)); // no KV: nothing to unlock later
        const scanId = crypto.randomUUID();
        const teaser = JSON.stringify({ ...toTeaser(result), scanId });
        await env.KV.put(`scan:${scanId}`, JSON.stringify(result), { expirationTtl: SCAN_TTL_SEC });
        await env.KV.put(cacheKey, teaser, { expirationTtl: SCAN_CACHE_TTL_SEC });
        return new Response(teaser, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders() } });
      } catch (e) {
        console.error('scan failed', e);
        return json({ error: 'The scan could not complete.' }, 500);
      }
    }

    if (url.pathname === '/api/report' && request.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      if (!SCAN_ID_RE.test(id)) return json({ error: 'Missing or invalid report id.' }, 400);
      const stored = env.KV ? await env.KV.get(`scan:${id}`) : null;
      if (!stored) return json({ error: 'That report has expired. Run a new scan.' }, 404);
      return new Response(stored, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders() } });
    }

    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found.' }, 404);

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Static assets are not bound. Check the [assets] block in wrangler.toml.', { status: 500 });
  },
};

export { normalizeDomain, parseRobots, classify, analyze, toTeaser, CRAWLERS };
