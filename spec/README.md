# The juke grading standard

Every `vectors-*.json` file here was produced by juke's own production code (`source/`), so a replica that reproduces them grades exactly as juke does. The TypeScript in `source/` is for reference.

Conventions: prices are probabilities in [0, 1]; "micros" are millionths (0.58 = 580000); Credits are decimal strings with up to 6 places; points = 100 × price difference per share. The thresholds are in `constants.json`.

## 1. Live series (`vectors-live-series.json`, `livemarks.ts`)
For each minute after the start, keep the last YES print and the last NO print in that minute (strictly inside (0, 1)). Keep the minute only if both exist and agree within 1¢ (`|yes + no − 1| ≤ 0.01`). Value = `round(((yes + 1 − no)/2) × 1e6)`.

## 2. The in-play mark (`vectors-live-mark.json`, `inPlayMarkV2` in `aeon-price-block-v1.ts`) — provisional standard `juke.live-mark.provisional.v2`
Each in-play action is marked from its own minute forward. Target minute = `ceil((trade time + 300 s − start)/60 s)`; window = 3 minutes.
- **DECIDED** — a print ≤1¢ or ≥99¢ after the trade, at or before the window's end: that price.
- **LIVE** — else the first two-sided minute at or after the target, inside the window.
- **LAST_FAIR** — else the last print after the trade.
- **AT_TRADE** — else a print from the trade's own minute or the minute before.
- **RESULT** — only if the Market has no price at all: its result (1 or 0).

## 3. Price blocks (`vectors-price-blocks.json`, `aeonPriceBlocksForMarketV1`)
One block per side held.
- **Pregame-only pick** (`GRADED`): graded against the close (the two-sided price at the start). Closing value = Σ buys (shares × close − cash) + Σ sales (cash − shares × close), in the held side's terms (NO = 1 − YES). Result vs close = the same with the result in place of the close, minus closing value.
- **Pick with any action at or after the start** (`TRADED_AFTER_START`): each in-play action is valued against its mark (shares × mark − cash for a buy; cash − shares × mark for a sale) in `live`; `gradedShares` = shares of graded actions. Its **pregame legs** (strictly before the start) are graded against the close exactly as a pregame-only pick, in `pregame`. One in-play share cannot hide a pregame price.
- The close is graded only when it was captured, two-sided, narrow and not stale; otherwise nothing is graded against it.

## 4. The verdict threshold (`vectors-capability-z.json`)
`z(k, looks)` solves Φ(z) = 1 − 0.05/(2·k·looks): Bonferroni over 8 cells and the number of looks.

## 5. juke# live cells (`vectors-live-sharp.json`, `liveSharp` in `sharp.ts`)
Value = live Credits, base = graded shares, clustered by game. A cell needs 30 picks across 15 games. Estimate = 100 × Σ value / Σ shares. The vectors include the verdict arithmetic (ratio ± z·se, game-clustered variance) for replicas. **In production, live verdicts are held**: a cell with enough evidence shows its estimate only, because a strategy with small frequent wins and a rare large loss can pass a normal-interval test by luck. Pregame cells give verdicts.

## 6. Counterpart in play (`vectors-counterpart-live.json`, `counterpart-live.ts`)
Checkpoints: football halftime (26–32 minutes left) and late (11–17); soccer 38–50 and 12–25. Football: final home margin ~ Normal(current margin + μ₀·r, σ√r), r = minutes left / 60, μ₀ from the pregame price, σ 13.86 (NFL) or 16 (college). Soccer: Poisson goal rates fitted to the pregame home/draw/away, scaled to the time left. It acts when its price beats the ask by 5 points with a book no wider than 2¢, at most once per game per checkpoint.
