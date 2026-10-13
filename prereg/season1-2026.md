# juke Season 1 pre-registration: does live grading separate systems faster?

Registered before Season 1 opens (Wed Oct 14, 2026, 06:00 CT).

Commit path: `prereg/season1-2026.md` in the public builder kit (github.com/krishna-brah/getjuked-builders). The commit SHA and this file's SHA-256 are quoted on getjuked.io/systems/weeks the same day. Wording: "registered before Season 1". Never "verified".

Season 1: Oct 14 – Nov 11, 2026 (CONTEXT-UPDATE-2026-10-10). Weeks as juke defines them.
Grading standard: the public kit as of the commit date: pregame against the close; in play against the price about 5 minutes later (`juke.live-mark.provisional.v2`); value per share; game-clustered variance (kit `spec/README.md`).

## 1. Questions and hypotheses
- **Q1 (speed of separation):** Does grading in play against where the market went next tell skilled systems apart from unskilled ones in fewer decisions, or fewer days, than pregame grading against the close?
  - **H1:** for systems active in both modes, the median number of graded decisions to separation is lower in play than pregame.
- **Q2 (stability):** Are skill estimates stable from one Week to the next?
  - **H2:** the week-to-week rank correlation of systems' value per share is positive in both modes, and in play it is not materially lower than pregame.
- **Q3 (real spread):** Do systems ranked top in the first half of the Season stay ahead of bottom-ranked systems in the second half, with and without decisions that could reflect speed rather than judgment?
  - **H3:** the out-of-sample top-minus-bottom difference is positive, and remains positive after the speed adjustment.

These are tests of the *measurement*, not claims that any system is ahead of the market.

## 2. Population and data
- **Unit:** a *system* (an API key, MCP connection, picks file or Lab system) as juke defines it. People are analysed separately as a secondary population.
- **Include:** all systems with at least **30 graded decisions across at least 15 games** in the mode being analysed (the canon juke# minimum), public or private. Private systems appear only in aggregate, never named.
- **Exclude from rankings:**
  - Counterpart (reported as a baseline);
  - juke-internal test systems (listed by id in an appendix before publication);
  - accounts removed for abuse.
- **Graded decisions only:** pregame decisions whose close was captured, two-sided, narrow and not stale; in-play decisions whose mark is **LIVE** or **DECIDED**. LAST_FAIR, AT_TRADE and RESULT marks are excluded from the primary analysis and included in a sensitivity run.
- **Also exclude:**
  - voided or 50-50 markets;
  - Combos (no single market to grade, per canon);
  - decisions placed while a market was suspended;
  - decisions flagged and upheld by human review for abuse (counts reported).
- **Same-owner systems:** kept, but standard errors cluster by **game** (primary) and a sensitivity run keeps one system per owner (the one with the most decisions).
- **Engineering regime:** if the in-play delay, re-quote or guards (engineering memo) ship during the Season, every decision carries a regime flag. Primary analyses use all decisions, with a sensitivity run on post-change decisions only.

## 3. Metric definitions (exact)
Let *v* be a graded decision's value in points per share (100 × price difference per share, the kit's convention). For a system *s*, mode *m* ∈ {pregame, in-play} and decisions 1..n in time order, the running estimate is V(n) = Σv / Σshares, with game-clustered standard error SE(n).

**M1. Decisions to separation (DtS).**
- DtS(s, m) is the smallest *n* ≥ 30 (spanning ≥15 games) at which |V(n)| / SE(n) ≥ **2.58** (two-sided 1%, chosen to limit false separation from repeated looks), evaluated after each game.
- Systems that never separate are **censored** at their last decision.
- Report: the Kaplan–Meier median DtS per mode, the share of systems separated by Season end, and **days** to separation.
- **Primary statistic:** among systems qualifying in both modes, the paired ratio DtS_pregame / DtS_in-play, with censored pairs handled by a log-rank-style comparison. Also reported: the model-based DtS = (2.58 · σ̂/μ̂)² from each system's per-decision mean and SD.

**M2. Week-to-week stability.**
- For each pair of consecutive Weeks (W, W+1) and mode, take systems with **≥20 graded decisions across ≥4 games in both Weeks**. Compute **Spearman ρ** between their Week W and Week W+1 value per share.
- Pool across Week pairs with the Fisher z average, with a bootstrap 95% CI resampling systems.
- Secondary: odd-game vs even-game split-half reliability (Spearman–Brown corrected) over the whole Season.

**M3. Top-minus-bottom spread (out of sample), raw and speed-adjusted.**
- Rank qualifying systems by V over **Weeks 1–2**. Take the top and bottom quartiles (rounded down, minimum 4 each).
- Compute their mean V over **Weeks 3 to Season end**: D = V_top − V_bottom, t = D / SE(D), with SE clustered by game.
- **Speed-adjusted:** recompute after excluding decisions placed within 60 s after a scoring event, card, review or suspension, or within 60 s before a venue mid move of ≥5¢ inside one minute (memo 2.2). Sensitivity windows: 30 s and 120 s.
- Report both versions for pregame and in play.

## 4. Analysis plan
- **Primary analyses:** M1 paired ratio (in play vs pregame), M2 pooled ρ for each mode, and M3 speed-adjusted t for in play.
- No interim tests of the primary analyses. Weekly descriptive tables only (counts, not verdicts), in line with juke's practice of holding live verdicts.
- **Multiple comparisons:** three primary tests, Holm-corrected at α = 0.05.
- **Sensitivity runs:**
  - the LAST_FAIR/AT_TRADE marks included;
  - one system per owner;
  - post-engineering-change decisions only;
  - by sport (NFL, college football, soccer) where n allows;
  - people instead of systems.
- **Code:** the analysis script is committed to the kit before Oct 14 and run unchanged. Any later change is logged as a deviation with its reason.

## 5. Sample size and power (assumptions, stated in advance)
- Canon (updated Oct 12, 2026): 100+ systems on the live Systems Table (101 that day). **Assumption:** 20–40 systems qualify in each mode by Season end, and 15–30 qualify in both.
- One system (Counterpart) made 353 graded calls in 16 games in one Week (CONTEXT-UPDATE, Oct 10, 2026). Active systems should reach 30 decisions across 15 games within 1–3 Weeks.
- **M2 power:** with 30 systems, a Spearman ρ of about 0.5 is detectable at 80% power (two-sided α = 0.05); a ρ near 0.3 would need roughly 85 systems. **Season 1 can show strong stability, not weak stability.**
- **M3 power:** with 7–8 systems per quartile, only a large spread is detectable. Treat M3 as an early signal to repeat in Season 2.
- **M1** is descriptive if fewer than 10 systems qualify in both modes.

## 6. What counts as support or failure
| Metric | Support | Inconclusive | Failure |
| --- | --- | --- | --- |
| M1 | Paired ratio > 1 (in play separates in fewer decisions), Holm-adjusted p < 0.05 | CI includes 1 | Ratio < 1 with p < 0.05 (pregame separates faster) |
| M2 | Pooled in-play ρ ≥ 0.3, CI excludes 0, and not more than 0.15 below pregame ρ | CI includes 0, or n < 15 | Pooled ρ ≤ 0 with CI excluding positive values ≥ 0.2 |
| M3 | Speed-adjusted in-play t ≥ 2 | 0 < t < 2 | t ≤ 0, or the raw spread disappears after the speed adjustment (judgment then can't be separated from speed) |

**Commitment:** results are published whatever they show, with these labels.

## 7. Publication
- Pre-registration: committed and hashed before **Wed Oct 14, 06:00 CT** (Krishna publishes).
- Weekly: descriptive counts in the Systems Report.
- Results: within two weeks of Season end (target **Wed Nov 25, 2026**). A report in the kit (`prereg/season1-results.md`) plus a Systems Report note, with the data needed to re-run (aggregate and anonymised for private systems).

## 8. Wording for the public page (draft)
"Before Season 1 starts, we're registering how we'll test our own grading: whether live grading tells systems apart faster than pregame, whether skill holds from Week to Week, and whether the top systems stay ahead once we remove anything that could be speed rather than judgment. We'll publish the results whatever they show."
