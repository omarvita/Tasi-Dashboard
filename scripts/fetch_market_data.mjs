#!/usr/bin/env node
// Fetches live Tadawul market data from Yahoo Finance SERVER-SIDE (no CORS limits)
// and writes data/market_snapshot.json, which the dashboard loads same-origin from
// GitHub Pages. Run by .github/workflows/market-data.yml on a schedule.
//
// Output shape (kept compact — the dashboard maps it back to its own fields):
// {
//   generated: 1760000000000, generatedISO: "...",
//   quotes: { "1010.SR": { p, c, pe, eps, pb, mc, v, av, h52, l52, dy } },
//   closes: { "1010.SR": { c: [..], t: [..] } },          // ~5y daily
//   tasi:   { price, change, closes, timestamps, ytdReturn }
// }

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' };

// ── 1. Ticker list: extracted from the dashboard itself so it never drifts ──
function extractTickers() {
  const html = readFileSync(join(ROOT, 'TASI_Dashboard.html'), 'utf8');
  const set = new Set(html.match(/\b\d{4}\.SR\b/g) || []);
  if (set.size < 50) throw new Error(`Only ${set.size} tickers extracted — parse problem?`);
  return [...set].sort();
}

// ── 2. Yahoo cookie + crumb (required for v7/quote since 2023) ──
async function getCrumb() {
  try {
    const r1 = await fetch('https://fc.yahoo.com/', { headers: UA, redirect: 'manual' }).catch(() => null);
    const cookie = r1?.headers?.get('set-cookie')?.split(';')[0] || '';
    if (!cookie) return null;
    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { ...UA, Cookie: cookie } });
    const crumb = (await r2.text()).trim();
    if (!crumb || crumb.length > 30 || crumb.includes('<')) return null;
    return { cookie, crumb };
  } catch { return null; }
}

async function fetchJSON(url, headers = UA, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      if (r.status === 429) { await sleep(3000 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1500 * (i + 1));
    }
  }
  // Every attempt hit 429 (the `continue` path never returned) — surface it as an error so
  // callers treat it like any other failure instead of silently receiving `undefined`.
  throw new Error('429 rate-limited — retries exhausted');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const r2 = x => x == null ? null : Math.round(x * 100) / 100;
const r4 = x => x == null ? null : Math.round(x * 10000) / 10000;

// ── 3. Bulk quotes via v7 (rich fields). Falls back to spark-derived prices. ──
async function fetchQuotes(tickers, auth) {
  const out = {};
  if (!auth) return out;
  const headers = { ...UA, Cookie: auth.cookie };
  for (let i = 0; i < tickers.length; i += 50) {
    const syms = tickers.slice(i, i + 50).map(encodeURIComponent).join(',');
    try {
      const j = await fetchJSON(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${syms}&crumb=${encodeURIComponent(auth.crumb)}`,
        headers);
      for (const q of j?.quoteResponse?.result || []) {
        if (!q.symbol || q.regularMarketPrice == null) continue;
        // dividendYield comes back in PERCENT — normalize to a fraction here so the
        // dashboard can apply it without unit guessing.
        let dy = q.trailingAnnualDividendYield ?? (q.dividendYield != null ? q.dividendYield / 100 : null);
        if (dy != null && dy > 0.5) dy = dy / 100; // belt-and-braces
        out[q.symbol] = {
          p: r2(q.regularMarketPrice), c: r2(q.regularMarketChangePercent),
          pe: q.trailingPE > 0 ? r2(q.trailingPE) : null,
          eps: q.epsTrailingTwelveMonths > 0 ? r4(q.epsTrailingTwelveMonths) : null,
          pb: q.priceToBook > 0 ? r2(q.priceToBook) : null,
          mc: q.marketCap ?? null, v: q.regularMarketVolume ?? null,
          av: q.averageDailyVolume3Month ?? null,
          h52: r2(q.fiftyTwoWeekHigh), l52: r2(q.fiftyTwoWeekLow),
          dy: r4(dy),
        };
      }
    } catch (e) { console.warn(`quote batch ${i}: ${e.message}`); }
    await sleep(400);
  }
  return out;
}

// ── 4. Daily closes via spark (no crumb needed) ──
async function fetchCloses(tickers) {
  const out = {};
  for (let i = 0; i < tickers.length; i += 20) {
    const syms = tickers.slice(i, i + 20).map(encodeURIComponent).join(',');
    try {
      const j = await fetchJSON(
        `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${syms}&range=5y&interval=1d`);
      // Yahoo serves spark in TWO shapes: browsers get {spark:{result:[{symbol,response:[…]}]}},
      // server-side callers get the compact map {"1010.SR":{timestamp:[…],close:[…]}}.
      let entries = [];
      if (Array.isArray(j?.spark?.result)) {
        entries = j.spark.result.map(r => {
          const resp = r.response?.[0];
          return { sym: r.symbol, ts: resp?.timestamp || [], cl: resp?.indicators?.quote?.[0]?.close || [] };
        });
      } else if (j && typeof j === 'object') {
        entries = Object.entries(j).map(([sym, v]) =>
          ({ sym, ts: v?.timestamp || [], cl: v?.close || [] }));
      }
      for (const { sym, ts, cl } of entries) {
        if (!sym || !Array.isArray(cl) || cl.length < 6) continue;
        const vi = cl.map((v, k) => v != null ? k : null).filter(k => k !== null);
        out[sym] = { c: vi.map(k => r2(cl[k])), t: vi.map(k => ts[k]) };
      }
    } catch (e) { console.warn(`spark batch ${i}: ${e.message}`); }
    await sleep(400);
  }
  return out;
}

// ── 5. TASI index — 10y daily so the snapshot seeds enough history to clear the
// dashboard's < 2000-close threshold (no redundant fetchTASIIndexLong on every load). ──
async function fetchTasi() {
  try {
    const j = await fetchJSON('https://query1.finance.yahoo.com/v8/finance/chart/%5ETASI.SR?range=10y&interval=1d');
    const res = j?.chart?.result?.[0];
    if (!res) return null;
    const ts = res.timestamp || [];
    const cl = res.indicators?.quote?.[0]?.close || [];
    const vi = cl.map((v, k) => v != null ? k : null).filter(k => k !== null);
    const closes = vi.map(k => r2(cl[k]));
    const timestamps = vi.map(k => ts[k]);
    if (closes.length < 10) return null;
    const price = res.meta?.regularMarketPrice ?? closes[closes.length - 1];
    // meta.chartPreviousClose is the close before the RANGE START (10y ago here) —
    // regularMarketPreviousClose is yesterday's close, which is what "change" means.
    const prev = res.meta?.regularMarketPreviousClose ?? closes[closes.length - 2];
    const change = prev ? r2((price - prev) / prev * 100) : null;
    // YTD as a FRACTION (0.073 = +7.3%) — matches the dashboard's tasiIndex convention
    const yr = new Date().getFullYear();
    const y0 = timestamps.findIndex(t => new Date(t * 1000).getFullYear() === yr);
    const ytdReturn = y0 >= 0 && closes[y0] ? r4((price - closes[y0]) / closes[y0]) : null;
    return { price: r2(price), change, closes, timestamps, ytdReturn };
  } catch (e) { console.warn(`TASI index: ${e.message}`); return null; }
}

// ── 6. Saudi nominal GDP from the World Bank (NY.GDP.MKTP.CN = GDP in current ──
// local currency = SAR, exactly the unit the dashboard's Buffett denominator uses).
// Free, no key. The WB publishes actuals ~1y in arrears, so this keeps the
// historical years aligned with official GASTAT revisions and adds each new year
// as it lands; the dashboard keeps its hardcoded IMF forecast for years the WB
// hasn't published yet. Returns { "2019": 3145..e9, ... } in SAR, or null.
async function fetchGDP() {
  try {
    const j = await fetchJSON('https://api.worldbank.org/v2/country/SA/indicator/NY.GDP.MKTP.CN?format=json&per_page=40');
    const rows = Array.isArray(j) ? j[1] : null;
    if (!Array.isArray(rows)) return null;
    const out = {};
    for (const r of rows) {
      const y = Number(r?.date), v = r?.value;
      if (Number.isInteger(y) && v != null && v > 0) out[y] = Math.round(v);
    }
    return Object.keys(out).length ? out : null;
  } catch (e) { console.warn(`GDP: ${e.message}`); return null; }
}

// ── main ──
const tickers = extractTickers();
console.log(`Tickers: ${tickers.length}`);

// Previous snapshot — fundamentals fallback if this run's crumb flow breaks
let prevSnap = null;
try { prevSnap = JSON.parse(readFileSync(join(ROOT, 'data', 'market_snapshot.json'), 'utf8')); } catch {}

const auth = await getCrumb();
console.log(auth ? 'Yahoo crumb OK' : 'No crumb — falling back to spark-derived quotes');

const [quotes, closes, tasi] = [
  await fetchQuotes(tickers, auth),
  await fetchCloses(tickers),
  await fetchTasi(),
];

// Saudi GDP — carry the previous snapshot forward if the WB call hiccups so the
// Buffett denominator never silently drops to its hardcoded fallback.
const gdp = (await fetchGDP()) || prevSnap?.gdp || null;
if (gdp) console.log(`GDP: ${Object.keys(gdp).length} years (latest ${Math.max(...Object.keys(gdp).map(Number))})`);
else console.warn('GDP: unavailable this run — dashboard will use its hardcoded table');

// ── Portfolio assets that aren't on Tadawul — priced from Yahoo for the portfolio view. ──
// IBIT = iShares Bitcoin ETF (USD/share). Kept separate from `quotes` so they never
// enter the TASI universe / breadth / delisting logic.
// Gold is tracked in SAR/gram via Al Rajhi and is updated manually — NOT auto-fetched here.
const EXTERNAL = ['IBIT'];
const [extQuotes, extCloses] = [await fetchQuotes(EXTERNAL, auth), await fetchCloses(EXTERNAL)];
const external = {};
for (const s of EXTERNAL) {
  const q = extQuotes[s], c = extCloses[s];
  if (q?.p > 0) external[s] = { p: q.p, c: q.c, ccy: 'USD', closes: c?.c || [], timestamps: c?.t || [] };
  else if (prevSnap?.external?.[s]) external[s] = prevSnap.external[s]; // carry forward on a failed fetch
}
console.log(`External: ${Object.keys(external).length}/${EXTERNAL.length} priced (${Object.keys(external).join(', ') || 'none'})`);

// Fill quote gaps from spark closes (price = last close, change = vs previous)
let derived = 0;
for (const t of tickers) {
  if (quotes[t] || !closes[t]) continue;
  const c = closes[t].c;
  if (c.length < 2) continue;
  quotes[t] = { p: c[c.length - 1], c: r2((c[c.length - 1] - c[c.length - 2]) / c[c.length - 2] * 100),
    pe: null, eps: null, pb: null, mc: null, v: null, av: null, h52: r2(Math.max(...c)), l52: r2(Math.min(...c)), dy: null };
  derived++;
}

// When the crumb flow breaks, quotes degrade to price-only (pe/eps/pb/mc/dy all null).
// Don't let that permanently replace a snapshot that HAD fundamentals — carry the
// previous run's fundamentals forward per ticker until v7/quote works again.
let carried = 0;
for (const [t, q] of Object.entries(quotes)) {
  const old = prevSnap?.quotes?.[t];
  if (!old || q.pe != null || q.mc != null) continue;
  for (const k of ['pe', 'eps', 'pb', 'mc', 'av', 'h52', 'l52', 'dy']) {
    if (q[k] == null && old[k] != null) q[k] = old[k];
  }
  carried++;
}
if (carried) console.warn(`Carried fundamentals forward from previous snapshot for ${carried} tickers (crumb flow degraded?)`);

const nq = Object.keys(quotes).length, nc = Object.keys(closes).length;
console.log(`Quotes: ${nq} (${derived} derived from closes) · Closes: ${nc} · TASI: ${tasi ? 'OK' : 'MISSING'}`);
if (nq < tickers.length * 0.5) {
  console.error(`Only ${nq}/${tickers.length} quotes — refusing to overwrite snapshot with bad data`);
  process.exit(1);
}

// ── Delisting tracker ──────────────────────────────────────────────────────
// `seen` records when each ticker last returned a quote. Tickers silent for 35+
// days (≈ a month of trading incl. Saudi weekends/holidays) are flagged as
// `delisted` — the dashboard greys them out and drops them from market stats.
const seen = { ...(prevSnap?.seen || {}) };
const now = Date.now();
for (const t of Object.keys(quotes)) seen[t] = now;
for (const t of tickers) if (seen[t] == null) seen[t] = now; // start the clock at first observation
for (const t of Object.keys(seen)) if (!tickers.includes(t)) delete seen[t]; // dropped from universe
const DELIST_MS = 35 * 24 * 36e5;
const delisted = tickers.filter(t => seen[t] != null && now - seen[t] > DELIST_MS);
if (delisted.length) console.warn(`Possibly delisted/suspended (${delisted.length}): ${delisted.join(', ')}`);

const snapshot = { generated: Date.now(), generatedISO: new Date().toISOString(), quotes, closes, tasi, seen, delisted, gdp, external, fx: { USDSAR: 3.75 } };
mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(join(ROOT, 'data', 'market_snapshot.json'), JSON.stringify(snapshot));
console.log(`Wrote data/market_snapshot.json (${(JSON.stringify(snapshot).length / 1048576).toFixed(2)} MB)`);
