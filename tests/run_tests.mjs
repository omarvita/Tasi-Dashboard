#!/usr/bin/env node
// Unit tests for the dashboard's pure financial functions. The app is a single
// HTML file, so functions are extracted by name (brace-matched) and evaluated in
// an isolated context — no DOM, no network. Run: node tests/run_tests.mjs
// CI: .github/workflows/tests.yml

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'TASI_Dashboard.html'), 'utf8');

// Extract `function NAME(...){...}` source by brace matching from the first `{`.
function extractFunction(name) {
  const sig = `function ${name}(`;
  const start = html.indexOf(sig);
  if (start < 0) throw new Error(`function ${name} not found in TASI_Dashboard.html`);
  const braceStart = html.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < html.length; i++) {
    const ch = html[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const ctx = vm.createContext({ console });
// The GDP helpers depend on the SAUDI_GDP_BY_YEAR table and SAUDI_GDP_SAR, which are
// const/let declarations rather than functions — eval them into the context first.
{
  const tbl = html.match(/const SAUDI_GDP_BY_YEAR = \{[\s\S]*?\};/);
  if (tbl) vm.runInContext(tbl[0], ctx);
}
// Scoring helpers depend on the _DE_TOLERANCE / _CYCLICAL_SCORE consts and on
// sectorMedianPE (a mutable global) — eval those before the functions that use them.
for (const re of [/const _DE_TOLERANCE = \{[\s\S]*?\};/, /const _CYCLICAL_SCORE = new Set\([\s\S]*?\);/]) {
  const m = html.match(re); if (m) vm.runInContext(m[0], ctx);
}
vm.runInContext('let sectorMedianPE = {};', ctx);
for (const fn of ['_num', 'deriveMetricsFromStatements', 'scorePEG', 'gdpAt', 'applyGdpFromSnapshot', '_cycleMetrics', 'scoreFundamental', 'scoreBuffett']) {
  vm.runInContext(extractFunction(fn), ctx);
}
vm.runInContext('let SAUDI_GDP_SAR = gdpAt(Date.now());', ctx);
// `const` declarations aren't exposed on the context object — re-export the table by
// reference so tests can read its (mutating) values.
vm.runInContext('globalThis.__GDP = SAUDI_GDP_BY_YEAR;', ctx);
const { _num, deriveMetricsFromStatements, scorePEG, gdpAt, applyGdpFromSnapshot, __GDP,
        _cycleMetrics, scoreFundamental, scoreBuffett } = ctx;

// ── tiny assertion harness ──
let passed = 0, failed = 0;
function eq(actual, expected, label) {
  const ok = Number.isFinite(expected) && Number.isFinite(actual)
    ? Math.abs(actual - expected) < 1e-9 || Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-12) < 1e-6
    : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; }
  else { failed++; console.error(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`); }
}

// ════════ _num ════════
eq(_num('1,234.5'), 1234.5, '_num parses comma-grouped strings');
eq(_num(42), 42, '_num passes numbers through');
eq(_num(null), null, '_num(null) → null');
eq(_num('abc'), null, '_num(non-numeric) → null');

// ════════ deriveMetricsFromStatements — 4-quarter TTM ════════
{
  const qIS = [
    { fiscal_date: '2026-03-31', revenue: 100, net_income: 10, eps: 1.0 },
    { fiscal_date: '2025-12-31', revenue: 110, net_income: 11, eps: 1.1 },
    { fiscal_date: '2025-09-30', revenue: 90,  net_income: 9,  eps: 0.9 },
    { fiscal_date: '2025-06-30', revenue: 100, net_income: 10, eps: 1.0 },
  ];
  const m = deriveMetricsFromStatements(null, { is: qIS });
  eq(m.ttmRev, 400, 'TTM revenue = sum of last 4 quarters');
  eq(m.ttmNI, 40, 'TTM net income = sum of last 4 quarters');
  eq(m.ttmMethod, '4Q TTM', 'TTM method labelled 4Q TTM');
  eq(m.eps, 4.0, 'TTM EPS = sum of 4 quarterly basic EPS');
  eq(m.npm, 0.1, 'Net margin = TTM NI / TTM revenue');
}

// ════════ EPS derived from NI/shares when basicEPS missing ════════
{
  // One quarter has both eps and NI → implied shares = 10/1.0 = 10.
  // Missing-EPS quarters derive eps = NI / 10.
  const qIS = [
    { fiscal_date: '2026-03-31', revenue: 100, net_income: 10, eps: 1.0 },
    { fiscal_date: '2025-12-31', revenue: 100, net_income: 12, eps: null },
    { fiscal_date: '2025-09-30', revenue: 100, net_income: 8,  eps: null },
    { fiscal_date: '2025-06-30', revenue: 100, net_income: 10, eps: null },
  ];
  const m = deriveMetricsFromStatements(null, { is: qIS });
  eq(m.eps, 4.0, 'TTM EPS fills missing quarters from NI ÷ implied shares');
}

// ════════ Semi-annual: cumulative style (IFRS Saudi interim) ════════
{
  // Jun row = H1 (6mo), Dec row = FY (12mo): Dec ≈ 2× Jun → cumulative.
  // TTM proxy = the Dec FY row.
  const qIS = [
    { fiscal_date: '2025-06-30', revenue: 100, net_income: 10, eps: 0.5 },
    { fiscal_date: '2024-12-31', revenue: 200, net_income: 20, eps: 1.0 },
  ];
  const m = deriveMetricsFromStatements(null, { is: qIS });
  eq(m.ttmRev, 200, 'semi-annual cumulative: TTM revenue = prior Dec FY row');
  eq(m.ttmMethod, '2H FY', 'semi-annual cumulative labelled 2H FY');
}

// ════════ Semi-annual: period/standalone style ════════
{
  // Dec row ≈ Jun row → each covers 6 months: TTM = H1 + H2.
  const qIS = [
    { fiscal_date: '2025-06-30', revenue: 100, net_income: 10, eps: 0.5 },
    { fiscal_date: '2024-12-31', revenue: 105, net_income: 11, eps: 0.55 },
  ];
  const m = deriveMetricsFromStatements(null, { is: qIS });
  eq(m.ttmRev, 205, 'semi-annual period style: TTM revenue = H1 + H2 sum');
  eq(m.ttmMethod, '2H Sum', 'semi-annual period style labelled 2H Sum');
  eq(m.eps, 1.05, 'semi-annual period style: EPS = sum of both halves');
}

// ════════ Semi-annual: Dec row most recent (already 12 months) ════════
{
  const qIS = [
    { fiscal_date: '2025-12-31', revenue: 210, net_income: 21, eps: 1.05 },
    { fiscal_date: '2025-06-30', revenue: 100, net_income: 10, eps: 0.5 },
  ];
  const m = deriveMetricsFromStatements(null, { is: qIS });
  eq(m.ttmRev, 210, 'semi-annual Dec-latest: TTM revenue = Dec FY row directly');
}

// ════════ Annual fallback when no quarterlies ════════
{
  const aIS = [
    { fiscal_date: '2025-12-31', revenue: 500, net_income: 50, eps: 2.5 },
    { fiscal_date: '2024-12-31', revenue: 400, net_income: 40, eps: 2.0 },
  ];
  const m = deriveMetricsFromStatements({ is: aIS }, null);
  eq(m.ttmRev, 500, 'annual fallback: TTM revenue = latest FY');
  eq(m.ttmMethod, 'FY Latest', 'annual fallback labelled FY Latest');
  eq(m.eps, 2.5, 'annual fallback: EPS = latest FY EPS');
  eq(m.rg, 0.25, 'revenue growth YoY from two annual rows');
  eq(m.eg, 0.25, 'earnings growth YoY from two annual rows');
}

// ════════ Balance sheet ratios ════════
{
  const aIS = [{ fiscal_date: '2025-12-31', revenue: 500, net_income: 50, eps: 2.5 }];
  const aBS = [{ fiscal_date: '2025-12-31', total_equity: 250, total_assets: 2e9, long_term_debt: 100 }];
  const m = deriveMetricsFromStatements({ is: aIS, bs: aBS }, null);
  eq(m.roe, 0.2, 'ROE = TTM NI / equity');
  eq(m.de, 40, 'D/E (%) = long-term debt / equity × 100');
  eq(m.assets, 2, 'assets reported in billions');
}

// ════════ FCF TTM from quarterly cash flows ════════
{
  const qCF = [
    { fiscal_date: '2026-03-31', free_cash_flow: 5 },
    { fiscal_date: '2025-12-31', free_cash_flow: 6 },
    { fiscal_date: '2025-09-30', free_cash_flow: -2 },
    { fiscal_date: '2025-06-30', free_cash_flow: 4 },
  ];
  const m = deriveMetricsFromStatements(null, { cf: qCF });
  eq(m.fcf, true, 'FCF flag true when 4-quarter sum positive');
}

// ════════ scorePEG ════════
{
  const r = scorePEG(15, 0.15);
  eq(r.peg, 1.0, 'PEG = PE / (growth × 100)');
  eq(r.score, 58, 'PEG 1.0 lands in the fair band (+8)');
}
{
  // Growth above 25% must be capped — one-off spikes shouldn't produce tiny PEGs.
  const r = scorePEG(20, 0.50);
  eq(r.peg, 0.8, 'growth capped at 25% before PEG (20 / 25 = 0.8)');
  eq(r.score, 68, 'capped PEG 0.8 lands in the undervalued band (+18)');
}
{
  // 3 annual rows present → growth comes from the 2-year EPS CAGR, not eg.
  const annIS = [
    { fiscal_date: '2025-12-31', eps: '1.44' },
    { fiscal_date: '2024-12-31', eps: '1.20' },
    { fiscal_date: '2023-12-31', eps: '1.00' },
  ];
  const r = scorePEG(24, 0.05, annIS); // CAGR = sqrt(1.44) − 1 = 20%
  eq(r.peg, 1.2, 'PEG uses 2-yr EPS CAGR from statements over single-year eg');
}
eq(scorePEG(15, -0.10).peg, null, 'negative growth → PEG null');
eq(scorePEG(15, -0.10).score, 50, 'negative growth → neutral score 50');
eq(scorePEG(null, 0.15).peg, null, 'missing P/E → PEG null');
eq(scorePEG(15, null).score, 50, 'missing growth → neutral score 50');
{
  const r = scorePEG(10, 0.25);
  eq(r.peg, 0.4, 'PEG below 0.5');
  eq(r.score, 75, 'PEG < 0.5 → exceptional band (+25)');
}

// ════════ gdpAt — mid-year-anchored interpolation ════════
{
  const jul1 = y => Date.UTC(y, 6, 1);
  // Each annual figure is the value exactly at its mid-year anchor.
  eq(gdpAt(jul1(2024)), __GDP[2024], 'gdpAt at mid-2024 returns the 2024 figure exactly');
  eq(gdpAt(jul1(2025)), __GDP[2025], 'gdpAt at mid-2025 returns the 2025 figure exactly');
  // Halfway between two anchors → halfway between the two figures.
  const mid = (jul1(2024) + jul1(2025)) / 2;
  const expectMid = (__GDP[2024] + __GDP[2025]) / 2;
  eq(gdpAt(mid), expectMid, 'gdpAt halfway between anchors interpolates linearly');
  // Clamps below the first / above the last anchor.
  eq(gdpAt(jul1(2000)), __GDP[2019], 'gdpAt clamps to first year before the table');
  eq(gdpAt(jul1(2099)), __GDP[2026], 'gdpAt clamps to last year after the table');
}

// ════════ applyGdpFromSnapshot — World Bank merge over the seed table ════════
{
  const before2024 = __GDP[2024];
  // Authoritative WB actuals override matching years; new years extend the table.
  const changed = applyGdpFromSnapshot({ 2024: before2024 + 5e9, 2027: 5.5e12 });
  eq(changed, 2, 'applyGdpFromSnapshot reports 2 changed years');
  eq(__GDP[2024], before2024 + 5e9, 'WB actual overrides the seed 2024 value');
  eq(__GDP[2027], 5.5e12, 'WB adds a new year beyond the seed table');
  // Identical/invalid payloads are no-ops.
  eq(applyGdpFromSnapshot({ 2024: before2024 + 5e9 }), 0, 'unchanged value is not re-counted');
  eq(applyGdpFromSnapshot({ 2028: -1, 2029: 0 }), 0, 'non-positive values are ignored');
  eq(applyGdpFromSnapshot(null), 0, 'null payload → 0 changes');
}

// ════════ _cycleMetrics — through-cycle median from annual statements ════════
{
  const annual = {
    is: [
      { fiscal_date:'2024-12-31', revenue:100, net_income:10 },
      { fiscal_date:'2023-12-31', revenue:100, net_income:20 },
      { fiscal_date:'2022-12-31', revenue:100, net_income:30 },
    ],
    bs: [
      { fiscal_date:'2024-12-31', total_equity:100 },
      { fiscal_date:'2023-12-31', total_equity:100 },
      { fiscal_date:'2022-12-31', total_equity:100 },
    ],
  };
  const m = _cycleMetrics({ rawTwelveData:{ annual } });
  eq(m.roe, 0.20, '_cycleMetrics ROE = median of [0.10,0.20,0.30]');
  eq(m.npm, 0.20, '_cycleMetrics net margin = median of yearly margins');
  eq(m.years, 3, '_cycleMetrics reports the number of years used');
  eq(_cycleMetrics({ rawTwelveData:{ annual:{ is:[annual.is[0]] } } }), null, 'single annual row → null (need ≥2)');
  eq(_cycleMetrics({}), null, 'no annual statements → null');
}

// ════════ scoreFundamental — sector-aware D/E ════════
{
  const base = { pe:null, pb:null, roe:null, npm:null, dy:null, fcf:null, rg:null, eg:null, de:90 };
  const deStep = stock => scoreFundamental(stock).steps.find(s => s.label === 'Debt/Equity');
  // 90% D/E is "elevated" (+2) for an asset-light consumer business …
  eq(deStep({ ...base, sector:'Consumer' }).delta, 2, 'D/E 90% → +2 for Consumer (base bands)');
  // … but "moderate" (+7) for a utility, whose bands are widened ×2.5 (50→125).
  eq(deStep({ ...base, sector:'Utilities' }).delta, 7, 'D/E 90% → +7 for Utilities (widened bands)');
}

// ════════ scoreFundamental / scoreBuffett — through-cycle ROE for cyclicals ════════
{
  // Energy name: latest TTM ROE is a trough 4%, but the 3-year median is a healthy 15%.
  const annual = {
    is: [ { fiscal_date:'2024-12-31', revenue:100, net_income:15 },
          { fiscal_date:'2023-12-31', revenue:100, net_income:15 },
          { fiscal_date:'2022-12-31', revenue:100, net_income:15 } ],
    bs: [ { fiscal_date:'2024-12-31', total_equity:100 },
          { fiscal_date:'2023-12-31', total_equity:100 },
          { fiscal_date:'2022-12-31', total_equity:100 } ],
  };
  const cyc = { pe:null, pb:null, npm:null, de:null, dy:null, fcf:null, rg:null, eg:null,
                roe:0.04, sector:'Energy', rawTwelveData:{ annual } };
  const fStep = scoreFundamental(cyc).steps.find(s => s.label === 'ROE');
  eq(fStep.delta, 9, 'cyclical ROE scored on 15% through-cycle median (+9), not the 4% trough (−5)');
  eq(/avg/.test(fStep.raw), true, 'through-cycle ROE is tagged "(Ny avg)" in the breakdown');
  // Non-cyclical sector with the same 4% TTM ROE stays on the trough value.
  const non = { ...cyc, sector:'Consumer' };
  eq(scoreFundamental(non).steps.find(s => s.label === 'ROE').delta, -5, 'non-cyclical sector uses latest 4% ROE (−5)');
}

// ── result ──
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
