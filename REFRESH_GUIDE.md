# How data refresh works — TASI Dashboard

## TL;DR — the one procedure you need

1. Open the dashboard. It loads automatically: cached prices appear in seconds.
2. If you want the freshest data, click **↻ Reload Data** — once.
3. Wait for the progress bar to finish. That's it. Do **not** click again while it runs.

Everything below happens automatically — you don't need to do anything.

## Where prices come from (in order)

| # | Source | Speed | How fresh |
|---|--------|-------|-----------|
| 1 | Browser cache (IndexedDB) | instant | same day |
| 2 | Google Drive cache | ~2 s | last save from any device |
| 3 | **GitHub snapshot** (`data/market_snapshot.json`) | ~1 s, always works | at most a few hours on trading days |
| 4 | Yahoo Finance live (via CORS proxies) | 30–120 s, can fail | real-time |
| 5 | TradingView scanner (fallback) | ~5 s | real-time |

The GitHub snapshot is the key reliability layer: a GitHub robot
(`.github/workflows/market-data.yml`) fetches the whole market **server-side**
— no CORS proxies — at **10:30, 12:05 and 15:30 Saudi time** every trading day
(Sun–Thu) and commits the result to this repository. GitHub Pages then serves
it to the dashboard same-origin, so it loads even when every proxy is blocked.

## The buttons

- **↻ Reload Data** — normal refresh. Uses today's cache if valid, otherwise
  runs the full pipeline above. Use this 99% of the time.
- **⟳ Force** — clears the day cache first and re-fetches everything live.
  Use only if you suspect the cache is wrong (e.g. you see yesterday's prices
  during market hours after ↻ already completed).
- **📊 Retrieve All Financial Statements** (Settings ⚙) — heavy, ~5 min.
  Fetches income statements/balance sheets for all stocks and saves to Drive.
  Do this maybe once per quarter, after earnings season.

## Scheduled auto-refresh (Settings ⚙)

Enable **Daily auto-refresh** and pick an hour (default 12:00). While the page
is open in any tab, the dashboard force-refreshes at that hour once per day
and saves everything (prices, fundamentals, statements) to Google Drive.

Note: a browser tab cannot run when it's closed — that's what the GitHub robot
covers. Between the two, your data is never more than a few hours old.

## If something looks stuck

- "batch X/20 got no data" — Yahoo proxies are failing; the dashboard
  automatically falls back to TradingView and the GitHub snapshot. Prices shown
  are then snapshot prices (a few hours old), which is fine for screening.
- 0 prices after a full run — you are offline, or GitHub Pages is down.
  Reload the page.
- Drive token expired (toast message) — open Settings ⚙ → Connect to
  re-authorize Google Drive. The dashboard still works without it.
