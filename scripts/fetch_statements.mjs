#!/usr/bin/env node
// Fetches financial statements (income/balance/cashflow, annual + quarterly) for
// every dashboard ticker from Yahoo's fundamentals-timeseries endpoint SERVER-SIDE
// (no CORS proxies) and writes data/statements_snapshot.json, served same-origin
// by GitHub Pages. Run weekly by .github/workflows/statements-data.yml.
//
// Row shapes mirror the dashboard's parseYahooTimeseries() exactly, so the
// browser can drop them straight into d.rawTwelveData and run
// applyDerivedMetrics() — TTM P/E, ROE, margins, growth — without any client
// fetch.
//
// Output:
// { generated, generatedISO,
//   statements: { "1010.SR": { annual: {is,bs,cf}, quarterly: {is,bs,cf} } } }

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' };

function extractTickers() {
  const html = readFileSync(join(ROOT, 'TASI_Dashboard.html'), 'utf8');
  const set = new Set(html.match(/\b\d{4}\.SR\b/g) || []);
  if (set.size < 50) throw new Error(`Only ${set.size} tickers extracted — parse problem?`);
  return [...set].sort();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// History caps — must match the dashboard's STMT_QTR_MAX / STMT_ANNUAL_MAX so the
// snapshot accumulates a bounded but generous window (15y quarters / 20y annual).
const STMT_QTR_MAX    = 60;
const STMT_ANNUAL_MAX = 20;

// Union freshly-fetched periods with the previous snapshot's by fiscal date so the
// snapshot ACCUMULATES history. Fresh data wins on field conflicts (restatements);
// older periods that fall outside the new fetch window are preserved.
function mergeStatementArr(fresh, prev, cap) {
  if (!fresh?.length && !prev?.length) return null;
  if (!fresh?.length) return prev.slice(0, cap);
  if (!prev?.length)  return fresh.slice(0, cap);
  const byDate = {};
  for (const r of prev)  { const k = (r.fiscal_date ?? '').slice(0, 7); if (k) byDate[k] = { ...r }; }
  for (const r of fresh) {
    const k = (r.fiscal_date ?? '').slice(0, 7); if (!k) continue;
    if (!byDate[k]) byDate[k] = { ...r };
    else for (const [kk, v] of Object.entries(r)) { if (v != null) byDate[k][kk] = v; }
  }
  return Object.values(byDate)
    .sort((a, b) => (b.fiscal_date ?? '').localeCompare(a.fiscal_date ?? ''))
    .slice(0, cap);
}

// Merge a fetched {annual,quarterly} statement set with the previous snapshot entry.
function mergeStatementEntry(fresh, prev) {
  if (!prev) return fresh;
  if (!fresh) return prev;
  const out = {};
  for (const period of ['annual', 'quarterly']) {
    const cap = period === 'quarterly' ? STMT_QTR_MAX : STMT_ANNUAL_MAX;
    const f = fresh[period], p = prev[period];
    if (!f && !p) continue;
    out[period] = {
      is: mergeStatementArr(f?.is, p?.is, cap),
      bs: mergeStatementArr(f?.bs, p?.bs, cap),
      cf: mergeStatementArr(f?.cf, p?.cf, cap),
    };
  }
  return out;
}

async function fetchJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
      if (r.status === 429) { await sleep(4000 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

// Mirrors the dashboard's fetchYahooTimeseries metric list exactly.
function metricList(prefix) {
  return [
    `${prefix}TotalRevenue`, `${prefix}GrossProfit`, `${prefix}EBITDA`,
    `${prefix}OperatingIncome`, `${prefix}NetIncome`, `${prefix}BasicEPS`,
    `${prefix}TotalAssets`, `${prefix}TotalLiabilitiesNetMinorityInterest`,
    `${prefix}StockholdersEquity`, `${prefix}CashAndCashEquivalents`, `${prefix}LongTermDebt`,
    `${prefix}OperatingCashFlow`, `${prefix}InvestingCashFlow`, `${prefix}FinancingCashFlow`,
    `${prefix}CapitalExpenditure`, `${prefix}FreeCashFlow`, `${prefix}CashDividendsPaid`,
    `${prefix}DepreciationAndAmortization`, `${prefix}InterestExpense`,
  ].join(',');
}

// Mirrors the dashboard's parseYahooTimeseries() — same field names, same row order.
function parseTimeseries(data, period) {
  const prefix = period === 'quarterly' ? 'quarterly' : 'annual';
  const result = data?.timeseries?.result;
  if (!result || !Array.isArray(result)) return null;
  const byDate = {};
  for (const series of result) {
    const metricKey = series?.meta?.type?.[0];
    if (!metricKey) continue;
    const entries = series[metricKey];
    if (!Array.isArray(entries)) continue;
    const stripped = metricKey.replace(new RegExp(`^${prefix}`, 'i'), '');
    const fieldName = (
      stripped === 'EBITDA' ? 'ebitda' :
      stripped === 'CashDividendsPaid' ? 'cashDividendsPaid' :
      stripped.charAt(0).toLowerCase() + stripped.slice(1)
    );
    for (const entry of entries) {
      if (!entry) continue;
      const date = entry.asOfDate;
      if (!date) continue;
      if (!byDate[date]) byDate[date] = { fiscal_date: date };
      byDate[date][fieldName] = entry.reportedValue?.raw ?? null;
    }
  }
  const limit = period === 'quarterly' ? STMT_QTR_MAX : STMT_ANNUAL_MAX;
  const dates = Object.keys(byDate).sort().reverse().slice(0, limit);
  if (!dates.length) return null;
  const rows = dates.map(d => byDate[d]);
  const is = rows.some(r => r.totalRevenue != null || r.netIncome != null) ? rows.map(r => ({
    fiscal_date: r.fiscal_date, revenue: r.totalRevenue ?? null,
    gross_profit: r.grossProfit ?? null,
    ebitda: r.ebitda ?? ((r.operatingIncome != null && r.depreciationAndAmortization != null)
      ? r.operatingIncome + Math.abs(r.depreciationAndAmortization) : null),
    operating_income: r.operatingIncome ?? null, net_income: r.netIncome ?? null,
    eps: r.basicEPS ?? null,
    interest_expense: r.interestExpense ?? null,
  })) : null;
  const bs = rows.some(r => r.totalAssets != null) ? rows.map(r => ({
    fiscal_date: r.fiscal_date, total_assets: r.totalAssets ?? null,
    total_liabilities: r.totalLiabilitiesNetMinorityInterest ?? null,
    total_equity: r.stockholdersEquity ?? null,
    cash_and_equivalents: r.cashAndCashEquivalents ?? null,
    long_term_debt: r.longTermDebt ?? null,
  })) : null;
  const cf = rows.some(r => r.operatingCashFlow != null) ? rows.map(r => ({
    fiscal_date: r.fiscal_date, operating_activities: r.operatingCashFlow ?? null,
    investing_activities: r.investingCashFlow ?? null,
    financing_activities: r.financingCashFlow ?? null,
    capital_expenditure: r.capitalExpenditure ?? null,
    free_cash_flow: r.freeCashFlow ?? null,
    dividends_paid: r.cashDividendsPaid ?? null,
  })) : null;
  if (!is && !bs && !cf) return null;
  return { is, bs, cf };
}

async function fetchStatement(ticker, period) {
  const prefix = period === 'quarterly' ? 'quarterly' : 'annual';
  const url = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(ticker)}?type=${metricList(prefix)}&period1=1388534400&period2=1900000000`;
  try {
    const data = await fetchJSON(url);
    return parseTimeseries(data, period);
  } catch (e) {
    return null;
  }
}

// ── main ──
const tickers = extractTickers();
console.log(`Tickers: ${tickers.length}`);

// Previous snapshot — keep a ticker's last good statements when this run fails for it
let prevSnap = null;
try { prevSnap = JSON.parse(readFileSync(join(ROOT, 'data', 'statements_snapshot.json'), 'utf8')); } catch {}

const statements = {};
let ok = 0, carried = 0, failed = 0;
const CONCURRENCY = 4;
for (let i = 0; i < tickers.length; i += CONCURRENCY) {
  const batch = tickers.slice(i, i + CONCURRENCY);
  await Promise.all(batch.map(async t => {
    const [annual, quarterly] = await Promise.all([
      fetchStatement(t, 'annual'),
      fetchStatement(t, 'quarterly'),
    ]);
    if (annual || quarterly) {
      const fresh = {};
      if (annual) fresh.annual = annual;
      if (quarterly) fresh.quarterly = quarterly;
      // Accumulate against the previous snapshot so older periods aren't dropped.
      statements[t] = mergeStatementEntry(fresh, prevSnap?.statements?.[t]);
      ok++;
    } else if (prevSnap?.statements?.[t]) {
      statements[t] = prevSnap.statements[t];
      carried++;
    } else {
      failed++;
    }
  }));
  if ((i / CONCURRENCY) % 10 === 0) console.log(`  ${Math.min(i + CONCURRENCY, tickers.length)}/${tickers.length}…`);
  await sleep(500);
}

console.log(`Statements: ${ok} fetched · ${carried} carried from previous snapshot · ${failed} unavailable`);
if (ok < tickers.length * 0.3) {
  console.error(`Only ${ok}/${tickers.length} fetched — refusing to overwrite snapshot with bad data`);
  process.exit(1);
}

const snapshot = { generated: Date.now(), generatedISO: new Date().toISOString(), statements };
mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(join(ROOT, 'data', 'statements_snapshot.json'), JSON.stringify(snapshot));
console.log(`Wrote data/statements_snapshot.json (${(JSON.stringify(snapshot).length / 1048576).toFixed(2)} MB)`);
