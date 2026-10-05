import type { Firestore } from 'firebase-admin/firestore';

import { dataPlaneDigest, type DataPlaneDigest } from '../v3-beta/data-plane-contract';
import type { LiveResultHoldsRuleV1 } from '../v3-beta/live-result-holds-projection-v1';
import { fetchMarketCloseBooksV1, type MarketCloseBookSampleV1 } from '../v3-beta/market-close-capture-v1';
import type { CounterpartEventViewV1 } from '../v3-beta/counterpart-view-v1';
import type { StockedCatalog, StockedListing } from '../v3-beta/stocked-catalog';
import { WEEK_COLLECTION } from './catalog';
import { counterpartViewsFor } from './counterpart';
import type { GameScore, ScoreRules } from './live';

/**
 * Live Counterpart (provisional, Oct 3 2026): Counterpart decides during the game too.
 *
 * At two checkpoints per game, halftime and late (start of the 4th quarter, about the 70th minute),
 * it takes its own sealed pregame view, updates it for the live score and the time left, reads the
 * market's real bid and ask at that moment, and seals one record: its fair price for each Market it
 * can model, and a paper action (buy at the ask) only where its price differs from the market by
 * LIVE_EDGE and the book is tight; otherwise a pass with the reason. At most one action per game and
 * checkpoint, on a winner (or draw) Market, the largest edge: one opinion is one piece of evidence,
 * not one per spread line. Written once, never changed.
 * It uses no market price to form its own view (the Season 1 independence rule) and no paid data.
 *
 * Models (textbook, provisional until a trained live model replaces them):
 * - Football: the final margin is normal; its mean is the current margin plus the pregame expected
 *   margin scaled by the time left, its variance σ² scaled by the time left (Stern 1991). The pregame
 *   expected margin is σ·Φ⁻¹(Counterpart's pregame home-win price).
 * - Soccer: goals for each side are Poisson; the two rates are fitted to Counterpart's pregame
 *   home/draw/away prices, and the rest of the match scores at that rate for the minutes left.
 */
export const COUNTERPART_LIVE_V1 = 'juke.counterpart.live-view.v1' as const;
export type LiveCheckpoint = 'HALF' | 'LATE';
export const LIVE_EDGE = 0.05;
export const LIVE_MAX_SPREAD = 0.02;
const PRICE_FLOOR = 0.05;
const PRICE_CEILING = 0.95;
/** Final-margin standard deviation over a whole game, in points (provisional). */
export const MARGIN_SIGMA = { NFL: 13.86, COLLEGE: 16 } as const;
const SOCCER_MINUTES = 94; // 90 plus typical stoppage time

export type LiveAction =
  | Readonly<{ kind: 'ACT'; side: 'YES' | 'NO'; buyPrice: string; edgePoints: string }>
  | Readonly<{ kind: 'PASS'; reason: 'EDGE_AT_OR_BELOW_THRESHOLD' | 'SPREAD_TOO_WIDE' | 'PRICE_OUT_OF_RANGE' | 'NO_TWO_SIDED_BOOK' | 'ONE_ACTION_PER_GAME' }>;

export interface LiveListingView {
  readonly listingId: string;
  readonly fairYes: string;
  readonly book: Readonly<{ bestBid: string; bestAsk: string; sourceOccurredAt: string }> | null;
  readonly action: LiveAction;
}

export interface CounterpartLiveView {
  readonly contractVersion: typeof COUNTERPART_LIVE_V1;
  readonly provisional: true;
  readonly eventId: string;
  readonly startAt: string;
  readonly checkpoint: LiveCheckpoint;
  readonly sealedAt: string;
  readonly game: Readonly<{ period: string | null; elapsed: string | null; home: number; away: number; observedAt: string; minutesLeft: number }>;
  readonly model: Readonly<{ name: 'FOOTBALL_NORMAL_MARGIN' | 'SOCCER_POISSON'; parameters: Readonly<Record<string, number>> }>;
  /** The pregame view it started from. */
  readonly pregame: Readonly<{ checkpoint: string; viewDigest: DataPlaneDigest }>;
  readonly listings: readonly LiveListingView[];
  readonly recordDigest: DataPlaneDigest;
}

// ---------- the clock ----------

const CLOCK = /^(\d{1,2}):(\d{2})$/u;

/** Minutes left in regulation, from the source's period and clock; null when it cannot be read or the game is in overtime. */
export function minutesLeft(kind: 'FOOTBALL' | 'SOCCER', period: string | null, elapsed: string | null): number | null {
  const p = (period ?? '').trim().toUpperCase();
  if (kind === 'FOOTBALL') {
    if (p === 'HT' || p === 'HALFTIME' || p === 'END Q2') return 30;
    if (p === 'END Q1') return 45;
    if (p === 'END Q3') return 15;
    const quarter = p.match(/^Q([1-4])$/u);
    const clock = (elapsed ?? '').match(CLOCK);
    if (!quarter || !clock) return null;
    const inQuarter = Number(clock[1]) + Number(clock[2]) / 60;
    if (inQuarter > 15) return null;
    return (4 - Number(quarter[1])) * 15 + inQuarter;
  }
  if (p === 'HT') return 45;
  const minute = Number((elapsed ?? '').replace(/'.*$/u, ''));
  if (!Number.isFinite(minute) || minute < 0 || minute > 130) return null;
  if (p === '1H') return Math.max(45, 90 - minute);
  if (p === '2H') return Math.max(0, 90 - Math.max(45, minute));
  return null;
}

/** The checkpoint a game is in, if any: a window wide enough for a 10-minute job to land in. */
export function checkpointAt(kind: 'FOOTBALL' | 'SOCCER', left: number | null): LiveCheckpoint | null {
  if (left === null) return null;
  if (kind === 'FOOTBALL') return left >= 26 && left <= 32 ? 'HALF' : left >= 11 && left <= 17 ? 'LATE' : null;
  return left >= 38 && left <= 50 ? 'HALF' : left >= 12 && left <= 25 ? 'LATE' : null;
}

// ---------- the models ----------

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 through erf; |error| < 1.5e-7). */
export function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Inverse standard normal CDF (Acklam's rational approximation). */
export function normalQuantile(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q = Math.min(Math.max(p, 1e-9), 1 - 1e-9);
  if (q < 0.02425) { const r = Math.sqrt(-2 * Math.log(q)); return (((((c[0]! * r + c[1]!) * r + c[2]!) * r + c[3]!) * r + c[4]!) * r + c[5]!) / ((((d[0]! * r + d[1]!) * r + d[2]!) * r + d[3]!) * r + 1); }
  if (q > 1 - 0.02425) return -normalQuantile(1 - q);
  const r = q - 0.5; const s = r * r;
  return (((((a[0]! * s + a[1]!) * s + a[2]!) * s + a[3]!) * s + a[4]!) * s + a[5]!) * r / (((((b[0]! * s + b[1]!) * s + b[2]!) * s + b[3]!) * s + b[4]!) * s + 1);
}

/** Football: P(YES) for a winner or spread Market; null for anything else. */
export function footballLiveYes(rule: LiveResultHoldsRuleV1, input: { pregameHomeWin: number; sigma: number; home: number; away: number; minutesLeft: number }): number | null {
  if (rule.kind !== 'TEAM_WIN' && rule.kind !== 'SPREAD') return null;
  const r = Math.max(input.minutesLeft, 0.25) / 60;
  const pregameMargin = input.sigma * normalQuantile(input.pregameHomeWin);
  // Home margin at the end: current + expected rest, spread by the time left.
  const mean = (input.home - input.away) + pregameMargin * r;
  const sd = input.sigma * Math.sqrt(r);
  const sign = rule.selection === 'HOME' ? 1 : -1;
  const line = rule.kind === 'SPREAD' ? Number(rule.lineFixed) : 0;
  // YES when (selected margin) + line > 0.
  return normalCdf((sign * mean + line) / sd);
}

function poisson(lambda: number, max: number): number[] {
  const out: number[] = [];
  let p = Math.exp(-lambda);
  for (let k = 0; k <= max; k += 1) { out.push(p); p *= lambda / (k + 1); }
  return out;
}

/** Soccer: the two goal rates (per match) that best reproduce the pregame home/draw/away prices. */
export function soccerRates(home: number, draw: number, away: number): { home: number; away: number } {
  const total = home + draw + away;
  const target = [home / total, draw / total, away / total];
  let best = { home: 1.4, away: 1.1, error: Infinity };
  for (let h = 0.2; h <= 4.0001; h += 0.02) {
    const ph = poisson(h, 12);
    for (let a = 0.2; a <= 4.0001; a += 0.02) {
      const pa = poisson(a, 12);
      let w = 0; let d = 0; let l = 0;
      for (let i = 0; i <= 12; i += 1) for (let j = 0; j <= 12; j += 1) { const p = ph[i]! * pa[j]!; if (i > j) w += p; else if (i === j) d += p; else l += p; }
      const error = (w - target[0]!) ** 2 + (d - target[1]!) ** 2 + (l - target[2]!) ** 2;
      if (error < best.error) best = { home: h, away: a, error };
    }
  }
  return { home: Math.round(best.home * 100) / 100, away: Math.round(best.away * 100) / 100 };
}

/** Soccer: P(YES) for any score-decided Market, from the current score and the goals still to come. */
export function soccerLiveYes(rule: LiveResultHoldsRuleV1, input: { rates: { home: number; away: number }; home: number; away: number; minutesLeft: number }): number | null {
  const share = Math.max(input.minutesLeft + 4, 0.5) / SOCCER_MINUTES;
  const ph = poisson(input.rates.home * share, 12);
  const pa = poisson(input.rates.away * share, 12);
  let yes = 0;
  for (let i = 0; i <= 12; i += 1) for (let j = 0; j <= 12; j += 1) {
    const h = input.home + i; const a = input.away + j; const p = ph[i]! * pa[j]!;
    const won = rule.kind === 'TEAM_WIN' ? (rule.selection === 'HOME' ? h > a : a > h)
      : rule.kind === 'DRAW' ? h === a
      : rule.kind === 'BOTH_TEAMS_TO_SCORE' ? h > 0 && a > 0
      : rule.kind === 'TOTAL' ? (rule.selection === 'OVER' ? h + a > Number(rule.lineFixed) : h + a < Number(rule.lineFixed))
      : (rule.selection === 'HOME' ? h - a : a - h) + Number(rule.lineFixed) > 0;
    if (won) yes += p;
  }
  return yes;
}

// ---------- the decision ----------

const six = (value: number) => value.toFixed(6);

/** Act only on a tight, live-priced book where Counterpart's price differs from the market by LIVE_EDGE. */
export function liveAction(fairYes: number, book: { bestBid: number; bestAsk: number } | null): LiveAction {
  if (!book) return { kind: 'PASS', reason: 'NO_TWO_SIDED_BOOK' };
  if (book.bestAsk - book.bestBid > LIVE_MAX_SPREAD + 1e-9) return { kind: 'PASS', reason: 'SPREAD_TOO_WIDE' };
  const mid = (book.bestBid + book.bestAsk) / 2;
  if (mid < PRICE_FLOOR || mid > PRICE_CEILING) return { kind: 'PASS', reason: 'PRICE_OUT_OF_RANGE' };
  if (fairYes - book.bestAsk >= LIVE_EDGE) return { kind: 'ACT', side: 'YES', buyPrice: six(book.bestAsk), edgePoints: (100 * (fairYes - book.bestAsk)).toFixed(1) };
  if (book.bestBid - fairYes >= LIVE_EDGE) return { kind: 'ACT', side: 'NO', buyPrice: six(1 - book.bestBid), edgePoints: (100 * (book.bestBid - fairYes)).toFixed(1) };
  return { kind: 'PASS', reason: 'EDGE_AT_OR_BELOW_THRESHOLD' };
}

interface GameInput {
  readonly kind: 'FOOTBALL' | 'SOCCER';
  readonly college: boolean;
  readonly eventId: string;
  readonly startAt: string;
  readonly listings: readonly StockedListing[];
}

/** Counterpart's pregame price for a Listing (T−6h first, then publication), or null when it abstained or has none. */
function pregameFair(views: readonly CounterpartEventViewV1[], listingId: string): { fair: number; view: CounterpartEventViewV1 } | null {
  for (const checkpoint of ['T_MINUS_6H', 'PUBLICATION'] as const) {
    const view = views.find((candidate) => candidate.checkpoint === checkpoint);
    const listing = view?.listings.find((candidate) => candidate.listingId === listingId);
    if (view && listing?.disposition === 'FORECAST') return { fair: Number(listing.fairYes), view };
  }
  return null;
}

/** One game's live view, or the reason there is none. Pure: every input is an argument. */
export function buildLiveView(input: {
  game: GameInput;
  score: GameScore;
  rules: ScoreRules;
  pregame: readonly CounterpartEventViewV1[];
  books: ReadonlyMap<string, MarketCloseBookSampleV1 | null>;
  now: string;
}): { view: CounterpartLiveView } | { skipped: string } {
  const { game, score } = input;
  if (score.state !== 'LIVE' || !score.score) return { skipped: 'NOT_LIVE' };
  const left = minutesLeft(game.kind, score.period, score.elapsed);
  const checkpoint = checkpointAt(game.kind, left);
  if (!checkpoint || left === null) return { skipped: 'NOT_AT_CHECKPOINT' };
  const ruled = game.listings.map((listing) => ({ listing, rule: input.rules[listing.listingId]?.rule ?? null })).filter((entry): entry is { listing: StockedListing; rule: LiveResultHoldsRuleV1 } => entry.rule !== null);
  const find = (match: (rule: LiveResultHoldsRuleV1) => boolean) => ruled.filter((entry) => match(entry.rule)).map((entry) => pregameFair(input.pregame, entry.listing.listingId)).find((found) => found !== null) ?? null;
  const homeWin = find((rule) => rule.kind === 'TEAM_WIN' && rule.selection === 'HOME');
  const awayWin = find((rule) => rule.kind === 'TEAM_WIN' && rule.selection === 'AWAY');
  let price: (rule: LiveResultHoldsRuleV1) => number | null;
  let model: CounterpartLiveView['model'];
  let base: CounterpartEventViewV1;
  if (game.kind === 'FOOTBALL') {
    const prior = homeWin ? homeWin.fair : awayWin ? 1 - awayWin.fair : null;
    if (prior === null) return { skipped: 'NO_PREGAME_VIEW' };
    base = (homeWin ?? awayWin)!.view;
    const sigma = game.college ? MARGIN_SIGMA.COLLEGE : MARGIN_SIGMA.NFL;
    model = { name: 'FOOTBALL_NORMAL_MARGIN', parameters: { sigma, pregameHomeWin: Number(prior.toFixed(6)) } };
    price = (rule) => footballLiveYes(rule, { pregameHomeWin: prior, sigma, home: score.score!.home, away: score.score!.away, minutesLeft: left });
  } else {
    const draw = find((rule) => rule.kind === 'DRAW');
    if (!homeWin || !awayWin || !draw) return { skipped: 'NO_PREGAME_VIEW' };
    base = homeWin.view;
    const rates = soccerRates(homeWin.fair, draw.fair, awayWin.fair);
    model = { name: 'SOCCER_POISSON', parameters: { homeRate: rates.home, awayRate: rates.away } };
    price = (rule) => soccerLiveYes(rule, { rates, home: score.score!.home, away: score.score!.away, minutesLeft: left });
  }
  const listings: LiveListingView[] = [];
  for (const { listing, rule } of ruled) {
    const fair = price(rule);
    if (fair === null || !Number.isFinite(fair)) continue;
    const clamped = Math.min(Math.max(fair, 0.001), 0.999);
    const sample = input.books.get(listing.tokenIdBySide.YES) ?? null;
    const book = sample ? { bestBid: Number(sample.bestBid), bestAsk: Number(sample.bestAsk) } : null;
    listings.push({
      listingId: listing.listingId, fairYes: six(clamped),
      book: sample ? { bestBid: sample.bestBid, bestAsk: sample.bestAsk, sourceOccurredAt: sample.sourceOccurredAt } : null,
      action: liveAction(clamped, book),
    });
  }
  if (listings.length === 0) return { skipped: 'NO_MODELLED_MARKET' };
  // One action per game: the winner-or-draw Market with the largest edge keeps its action.
  const winnerKinds = new Set(['TEAM_WIN', 'DRAW']);
  const edge = (entry: LiveListingView) => entry.action.kind === 'ACT' ? Number(entry.action.edgePoints) : -1;
  const chosen = listings.filter((entry) => entry.action.kind === 'ACT' && winnerKinds.has(input.rules[entry.listingId]!.rule!.kind))
    .sort((a, b) => edge(b) - edge(a) || a.listingId.localeCompare(b.listingId))[0];
  for (const [index, entry] of listings.entries()) {
    if (entry.action.kind === 'ACT' && entry !== chosen) listings[index] = { ...entry, action: { kind: 'PASS', reason: 'ONE_ACTION_PER_GAME' } };
  }
  const body = {
    contractVersion: COUNTERPART_LIVE_V1, provisional: true as const, eventId: game.eventId, startAt: game.startAt, checkpoint, sealedAt: input.now,
    game: { period: score.period, elapsed: score.elapsed, home: score.score.home, away: score.score.away, observedAt: score.observedAt, minutesLeft: Math.round(left * 100) / 100 },
    model, pregame: { checkpoint: base.checkpoint, viewDigest: base.viewDigest }, listings,
  };
  return { view: { ...body, recordDigest: dataPlaneDigest(body) } };
}

// ---------- the job ----------

const docId = (value: string) => value.replace(/\//g, '_');
const liveViews = (db: Firestore, cycleId: string) => db.collection(WEEK_COLLECTION).doc(docId(cycleId)).collection('counterpart-live');
export const liveViewId = (eventId: string, startAt: string, checkpoint: LiveCheckpoint) => dataPlaneDigest({ eventId, startAt, checkpoint }).slice('sha256:'.length, 'sha256:'.length + 40);
/** A score older than this is not acted on. */
const SCORE_MAX_AGE_MS = 3 * 60_000;

/** Sealed live views never change: one read per view per server instance; a missing one is asked again after a while. */
const keptLive = new Map<string, CounterpartLiveView>();
const missingLiveUntil = new Map<string, number>();
const LIVE_RETRY_MS = 10 * 60_000;

/** The live views (halftime, late) of these finished games, by event. */
export async function liveViewsFor(db: Firestore, cycleId: string, games: readonly { eventId: string; startAt: string }[]): Promise<Map<string, CounterpartLiveView[]>> {
  if (keptLive.size > 5_000) keptLive.clear();
  if (missingLiveUntil.size > 5_000) missingLiveUntil.clear();
  const nowMs = Date.now();
  const ids = games.flatMap((game) => (['HALF', 'LATE'] as const).map((checkpoint) => `${cycleId}/${liveViewId(game.eventId, game.startAt, checkpoint)}`));
  const missing = ids.filter((id) => !keptLive.has(id) && (missingLiveUntil.get(id) ?? 0) <= nowMs);
  for (let at = 0; at < missing.length; at += 100) {
    const batch = missing.slice(at, at + 100);
    const snapshots = await db.getAll(...batch.map((id) => liveViews(db, cycleId).doc(id.slice(cycleId.length + 1))));
    snapshots.forEach((snapshot, index) => {
      const id = batch[index]!;
      if (!snapshot.exists) { missingLiveUntil.set(id, nowMs + LIVE_RETRY_MS); return; }
      try {
        const view = JSON.parse(snapshot.get('json') as string) as CounterpartLiveView;
        if (view.contractVersion === COUNTERPART_LIVE_V1) keptLive.set(id, view);
      } catch { /* unreadable: left out */ }
    });
  }
  const out = new Map<string, CounterpartLiveView[]>();
  for (const id of ids) { const view = keptLive.get(id); if (view) out.set(view.eventId, [...(out.get(view.eventId) ?? []), view]); }
  return out;
}

/** Seals the live views that are due now. Run by the results job after the scores are refreshed. */
export async function runLiveCounterpartCheck(db: Firestore, cycleId: string, catalog: StockedCatalog, live: { rules: ScoreRules; scores: { games: Readonly<Record<string, GameScore>> } | null }, now = new Date().toISOString(), fetchImpl: typeof fetch = fetch) {
  const games = new Map<string, GameInput>();
  for (const arena of catalog.arenas) {
    const kind = /soccer/iu.test(arena.arenaId) ? 'SOCCER' as const : /football/iu.test(arena.arenaId) ? 'FOOTBALL' as const : null;
    if (!kind) continue;
    for (const listing of arena.listings) {
      if (!listing.sourceEventId || !listing.sourceEventStartAt) continue;
      const game = games.get(listing.sourceEventId) ?? { kind, college: /college|ncaa|cfb/iu.test(listing.competitionLabel ?? ''), eventId: listing.sourceEventId, startAt: listing.sourceEventStartAt, listings: [] as StockedListing[] };
      (game.listings as StockedListing[]).push(listing);
      games.set(listing.sourceEventId, game);
    }
  }
  const nowMs = Date.parse(now);
  const due: { game: GameInput; score: GameScore; checkpoint: LiveCheckpoint }[] = [];
  for (const game of games.values()) {
    const score = live.scores?.games[game.eventId];
    if (!score || score.state !== 'LIVE' || nowMs - Date.parse(score.observedAt) > SCORE_MAX_AGE_MS) continue;
    const checkpoint = checkpointAt(game.kind, minutesLeft(game.kind, score.period, score.elapsed));
    if (checkpoint) due.push({ game, score, checkpoint });
  }
  if (due.length === 0) return { due: 0, sealed: 0, skipped: {} as Record<string, number> };
  const refs = due.map((entry) => liveViews(db, cycleId).doc(liveViewId(entry.game.eventId, entry.game.startAt, entry.checkpoint)));
  const existing = await db.getAll(...refs, { fieldMask: ['sealedAt'] });
  const open = due.filter((_, index) => !existing[index]!.exists);
  if (open.length === 0) return { due: due.length, sealed: 0, skipped: {} };
  const pregame = await counterpartViewsFor(db, cycleId, open.map((entry) => ({ eventId: entry.game.eventId, startAt: entry.game.startAt })));
  const tokens = open.flatMap((entry) => entry.game.listings.filter((listing) => live.rules[listing.listingId]?.rule).map((listing) => listing.tokenIdBySide.YES));
  const { books } = tokens.length ? await fetchMarketCloseBooksV1(fetchImpl, tokens, { deadlineMs: Date.now() + 8_000 }) : { books: new Map<string, MarketCloseBookSampleV1 | null>() };
  let sealed = 0;
  const skipped: Record<string, number> = {};
  for (const entry of open) {
    const built = buildLiveView({ game: entry.game, score: entry.score, rules: live.rules, pregame: pregame.get(entry.game.eventId) ?? [], books, now });
    if ('skipped' in built) { skipped[built.skipped] = (skipped[built.skipped] ?? 0) + 1; continue; }
    try {
      await liveViews(db, cycleId).doc(liveViewId(built.view.eventId, built.view.startAt, built.view.checkpoint)).create({ json: JSON.stringify(built.view), sealedAt: built.view.sealedAt, eventId: built.view.eventId });
      sealed += 1;
    } catch (error) {
      if ((error as { code?: number }).code !== 6) throw error;
    }
  }
  return { due: due.length, sealed, skipped };
}
