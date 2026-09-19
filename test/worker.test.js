import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyze, CRAWLERS, classify, normalizeDomain, parseRobots, toTeaser } from '../src/worker.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

// Build the `results` array runScan() would produce, with every probe allowed unless overridden.
function mkResults(verdicts = {}, robotsVerdict = 'allowed') {
  return CRAWLERS.map((c) => ({
    id: c.id,
    label: c.label,
    vendor: c.vendor,
    behavior: c.behavior,
    probed: Boolean(c.probe),
    verdict: c.probe ? verdicts[c.id] || 'allowed' : 'not-probed',
    status: c.probe ? 200 : null,
    robots: robotsVerdict,
    token: c.token || null,
    seoCritical: c.seoCritical,
  }));
}

function mkScan(overrides = {}) {
  const robots = parseRobots('User-agent: *\nAllow: /\n');
  robots.llmsTxtPresent = false;
  return { domain: 'example.com', intent: 'mixed', results: mkResults(), robots, onCloudflare: true, siteReachable: true, ...overrides };
}

/* ------------------------------------------------------------------ *
 * normalizeDomain
 * ------------------------------------------------------------------ */

describe('normalizeDomain', () => {
  it('strips scheme, www, path, query, port, and credentials', () => {
    assert.equal(normalizeDomain('https://www.Example.com/path?q=1'), 'example.com');
    assert.equal(normalizeDomain('http://user@shop.example.co.uk:8080/'), 'shop.example.co.uk');
    assert.equal(normalizeDomain('  example.com  '), 'example.com');
  });

  it('rejects empty, malformed, and non-string input', () => {
    assert.throws(() => normalizeDomain(''), /Enter a domain/);
    assert.throws(() => normalizeDomain(42), /Enter a domain/);
    assert.throws(() => normalizeDomain('not a domain'), /valid domain/);
    assert.throws(() => normalizeDomain('localhost'), /valid domain/);
  });

  it('blocks private and internal hosts', () => {
    for (const host of ['10.0.0.1', '192.168.1.1', '172.16.0.1', '127.0.0.1', 'printer.local', 'metadata.google.internal']) {
      assert.throws(() => normalizeDomain(host), /cannot be scanned/, host);
    }
  });
});

/* ------------------------------------------------------------------ *
 * parseRobots
 * ------------------------------------------------------------------ */

describe('parseRobots', () => {
  it('treats empty text as no robots.txt', () => {
    const r = parseRobots('');
    assert.equal(r.present, false);
    assert.equal(r.blockedTokens.size, 0);
  });

  it('collects tokens from groups that disallow everything', () => {
    const r = parseRobots('User-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\n\nUser-agent: Googlebot\nDisallow: /private\n');
    assert.deepEqual([...r.blockedTokens].sort(), ['ccbot', 'gptbot']);
  });

  it('reads Content-Signal lines', () => {
    const r = parseRobots('# Content-Signal: search=yes, ai-input=yes, ai-train=no\nUser-agent: *\nAllow: /\n');
    assert.deepEqual(r.contentSignals, { search: 'yes', 'ai-input': 'yes', 'ai-train': 'no' });
  });

  it('flags llms.txt references', () => {
    assert.equal(parseRobots('User-agent: *\nAllow: /\n# see /llms.txt\n').llmsTxtReferenced, true);
  });
});

/* ------------------------------------------------------------------ *
 * classify
 * ------------------------------------------------------------------ */

describe('classify', () => {
  it('maps probe outcomes to verdicts', () => {
    assert.equal(classify({ status: 200 }), 'allowed');
    assert.equal(classify({ status: 301 }), 'allowed');
    assert.equal(classify({ status: 403 }), 'blocked');
    assert.equal(classify({ status: 402 }), 'priced');
    assert.equal(classify({ status: 429 }), 'rate-limited');
    assert.equal(classify({ status: 503, cfMitigated: 'challenge' }), 'challenged');
    assert.equal(classify({ status: 200, cfMitigated: 'challenge' }), 'challenged');
    assert.equal(classify({ status: 502 }), 'origin-error');
    assert.equal(classify({ status: 0, error: 'timeout' }), 'timeout');
    assert.equal(classify(null), 'error');
  });
});

/* ------------------------------------------------------------------ *
 * analyze
 * ------------------------------------------------------------------ */

describe('analyze', () => {
  it('returns a clamped score and severity-sorted findings', () => {
    const a = analyze(mkScan());
    assert.ok(a.score >= 0 && a.score <= 100);
    const rank = { critical: 0, warning: 1, good: 2, info: 3 };
    const ranks = a.findings.map((f) => rank[f.severity]);
    assert.deepEqual(ranks, [...ranks].sort((x, y) => x - y));
  });

  it('caps the score at 40 and raises a critical when Googlebot is blocked', () => {
    const a = analyze(mkScan({ results: mkResults({ googlebot: 'blocked' }) }));
    assert.ok(a.score <= 40, `score ${a.score}`);
    assert.ok(a.counts.critical >= 1);
  });

  it('flags an unreachable site as critical', () => {
    const a = analyze(mkScan({ siteReachable: false }));
    assert.match(a.findings[0].title, /did not answer/);
  });
});

/* ------------------------------------------------------------------ *
 * toTeaser (the scan response must not carry the gated findings)
 * ------------------------------------------------------------------ */

describe('toTeaser', () => {
  const findings = [
    { severity: 'critical', title: 'A' },
    { severity: 'critical', title: 'B' },
    { severity: 'warning', title: 'C' },
    { severity: 'good', title: 'D' },
  ];

  it('keeps only the headline finding and counts the rest', () => {
    const t = toTeaser({ domain: 'example.com', score: 30, findings });
    assert.deepEqual(t.findings, [{ severity: 'critical', title: 'A' }]);
    assert.equal(t.hiddenFindings, 3);
    assert.equal(t.score, 30);
  });

  it('falls back to a warning, then to the first finding', () => {
    assert.equal(toTeaser({ findings: findings.slice(2) }).findings[0].title, 'C');
    assert.equal(toTeaser({ findings: [{ severity: 'good', title: 'D' }] }).findings[0].title, 'D');
    assert.deepEqual(toTeaser({ findings: [] }).findings, []);
  });
});
