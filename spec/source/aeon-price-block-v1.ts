import { formatMicros, parseCanonicalDecimal } from './accounting-kernel';
import type { CounterpartCheckpointV1, CounterpartEventViewV1, CounterpartListingViewV1 } from './counterpart-view-v1';
import type { AccountingSide } from './data-plane-contract';
import type { EventRevealMarketV1 } from './event-reveal-v1';
import {
  marketCloseScheduleV1,
  type MarketCloseListingStateV1,
  type MarketCloseListingV1,
  type MarketEventCloseV1,
} from './market-close-capture-v1';
import type { StockedCatalog } from './stocked-catalog';

/**
 * The Aeon# price block: for each side a player traded on a settled Listing,
 * the entry, the market's close, the result, and the two parts of the outcome.
 *
 * - Closing value is what the player's prices were worth at the close: a buy
 *   of s shares for notional n earns s × close − n, and a sale earns
 *   n − s × close.
 * - Luck is what the result added to the shares still held: net shares ×
 *   (result − close).
 * - Closing value + luck − fees is the Credits the side won or lost, because
 *   every term uses the cash the ledger actually moved. Arithmetic is exact in
 *   micros squared; each part is then rounded once, half away from zero, so
 *   the two displayed parts can differ from the ledger's figure by one micro.
 *
 * A block never grades a close it cannot stand behind: no capture, a stale or
 * wide one, or a trade after the start shows no numbers, and says why. A
 * price is shown only when it is a real two-sided close.
 */
export const AEON_PRICE_BLOCK_V1 = 'aeon.v3.beta.aeon-price-block.v1' as const;
/**
 * Serving the block has its own switch, separate from close capture: reads can
 * be turned off without losing captures, which can never be taken again.
 */
export const V3_BETA_AEON_PRICE_BLOCK_ENV_V1 = 'AEON_V3_BETA_AEON_PRICE_BLOCK_V1' as const;
/**
 * A close is graded only when its two-sided spread is at most 10 probability
 * points, the bound past which Polymarket itself stops showing the midpoint.
 * About half of the first real captures were 1¢/99¢ books with no market.
 */
export const AEON_PRICE_BLOCK_MAX_CLOSE_SPREAD_MICROS_V1 = 100_000n;

const MICRO = 1_000_000n;
/** Close records keep the book's own fixed-point text, e.g. `0.320000`. */
const CLOSE_PRICE = /^(0|[1-9]\d{0,6})(?:\.(\d{1,6}))?$/u;

function closePriceMicros(value: string): bigint {
  const match = CLOSE_PRICE.exec(value);
  if (!match) throw new Error('AEON_PRICE_BLOCK_CLOSE_PRICE_INVALID');
  return BigInt(match[1]!) * MICRO + BigInt((match[2] ?? '').padEnd(6, '0'));
}

const CLOSE_STATES: ReadonlySet<string> = new Set(['PENDING', 'SAMPLED', 'CAPTURED', 'STALE', 'MISSED']);

function closePriceValid(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'string' || !CLOSE_PRICE.test(value)) return false;
  return closePriceMicros(value) <= MICRO;
}

/**
 * The capture module's record check covers its envelope and digest, not each
 * entry's values. Before a block uses a record, every entry must carry a
 * Listing id, a known state, prices between 0 and 1 in the book's own format,
 * and a numeric age; otherwise the whole record is treated as unreadable.
 */
export function aeonPriceBlockRecordUsableV1(record: MarketEventCloseV1): boolean {
  return Array.isArray(record.listings) && record.listings.every((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const listing = entry as Record<string, unknown>;
    return typeof listing.listingId === 'string' && listing.listingId.length > 0
      && typeof listing.state === 'string' && CLOSE_STATES.has(listing.state)
      && closePriceValid(listing.bestBid) && closePriceValid(listing.bestAsk) && closePriceValid(listing.mid)
      && (listing.ageAtStartMs === undefined || (typeof listing.ageAtStartMs === 'number' && Number.isFinite(listing.ageAtStartMs)));
  });
}

export type AeonPriceBlockStateV1 =
  /** Closing value and luck, both graded. */
  | 'GRADED'
  /** Voided or not scoreable: the stake returned, so nothing is graded. */
  | 'NOT_SCORED'
  | 'CLOSE_NOT_CAPTURED'
  | 'CLOSE_STALE'
  | 'CLOSE_SPREAD_WIDE'
  /** A trade at or after the start is not comparable with the pre-start close. */
  | 'TRADED_AFTER_START';

export type AeonPriceBlockCaptureStateV1 =
  | MarketCloseListingStateV1
  /** The Event's record exists but never tracked this Listing. */
  | 'NOT_TRACKED'
  /** No close record for the Event. */
  | 'NO_RECORD'
  /** The live catalog schedules no start for this Listing. */
  | 'NOT_SCHEDULED';

export interface AeonPriceBlockV1 {
  readonly contractVersion: typeof AEON_PRICE_BLOCK_V1;
  readonly listingId: string;
  readonly side: AccountingSide;
  readonly state: AeonPriceBlockStateV1;
  readonly entry: {
    readonly boughtShares: string;
    readonly averageBuyPrice: string | null;
    readonly soldShares: string;
    readonly averageSellPrice: string | null;
    readonly fees: string;
  };
  readonly close: {
    /** A sampled two-sided book's midpoint, or the price Polymarket displayed in the last minutes before the start. */
    readonly source: 'POLYMARKET_LAST_TWO_SIDED_MID' | 'POLYMARKET_DISPLAYED_PRICE';
    readonly captureState: AeonPriceBlockCaptureStateV1;
    readonly startAt: string | null;
    /** The mid for the side held: a NO close is 1 − the YES mid. */
    readonly price: string | null;
    readonly spread: string | null;
    readonly ageAtStartSeconds: number | null;
  };
  /** 1 or 0 for the side held; null when the market was not scored. */
  readonly result: '1' | '0' | null;
  /** Signed decimal strings. `entryPoints` is 100 × (close − average buy price). */
  readonly closingValue: { readonly entryPoints: string | null; readonly credits: string } | null;
  /** Signed decimal strings. `points` is 100 × (result − close). */
  readonly luck: { readonly points: string; readonly credits: string } | null;
  /**
   * Each action on this side graded against the close, in order, when the
   * block is GRADED (otherwise empty): a buy earns shares × close − cash paid,
   * a sale earns cash received − shares × close. They add up to closing value,
   * each rounded once. A sale's value is what it gained or gave up against
   * holding to the close.
   */
  readonly actions: readonly {
    readonly actionReceiptId: string;
    readonly operation: string;
    readonly occurredAt: string;
    readonly credits: string;
  }[];
  /**
   * A pick traded both before and after the start (TRADED_AFTER_START) keeps its pregame part graded
   * against the close: the pregame legs only (occurredAt before the start instant), valued exactly as a
   * GRADED pick's (research review, Oct 4 2026: one in-play share must not hide a pregame entry).
   * Absent when there were no pregame legs or no two-sided close and result.
   */
  readonly pregame?: AeonPriceBlockPregameV1;
  /** In-play actions graded by the provisional live standard; absent when there were none or no marks were read. */
  readonly live?: AeonPriceBlockLiveV1;
  /** Counterpart's sealed view of this Listing; absent when none was sealed or it is not shown. */
  readonly counterpart?: AeonPriceBlockCounterpartV1;
  /** Counterpart's in-play views (halftime, then late); absent when none were sealed. */
  readonly counterpartLive?: readonly AeonPriceBlockCounterpartLiveV1[];
}

export interface AeonPriceBlockPregameV1 {
  readonly boughtShares: string;
  readonly averageBuyPrice: string | null;
  readonly soldShares: string;
  readonly closingValue: { readonly entryPoints: string | null; readonly credits: string };
  readonly luck: { readonly points: string; readonly credits: string };
  readonly actions: readonly { readonly actionReceiptId: string; readonly operation: string; readonly occurredAt: string; readonly credits: string }[];
}

/**
 * Counterpart's view as a block shows it: Aeon's automatic benchmark, sealed
 * before the start without seeing any player's choice. Its own paper actions
 * (the shadow book) are not shown in Season 1.
 */
export interface AeonPriceBlockCounterpartV1 {
  readonly checkpoint: CounterpartCheckpointV1;
  readonly sealedAt: string;
  readonly rulesDigest: string;
  readonly disposition: 'FORECAST' | 'ABSTAIN';
  /** Its fair price for the side held (a NO price is 1 − its YES price); null when it abstained. */
  readonly price: string | null;
  readonly source: 'SHARP_PINNACLE_NO_VIG' | 'RAW_POLYMARKET' | 'HOUSE_MODEL_V1' | null;
  readonly confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  /** Why it abstained; null for a forecast. */
  readonly code: string | null;
}

/** Counterpart's sealed views of one Listing, as the Reports read found them. */
export interface AeonPriceBlockCounterpartViewsV1 {
  readonly views: readonly {
    readonly checkpoint: CounterpartCheckpointV1;
    readonly sealedAt: string;
    readonly rulesDigest: string;
    readonly listing: CounterpartListingViewV1;
  }[];
}

/** One Listing's close as the runtime holds it. */
export interface AeonPriceBlockCloseV1 {
  readonly startAt: string;
  /** The Event's close record state; null when no record was stored. */
  readonly recordState: MarketEventCloseV1['state'] | null;
  /** This Listing's entry in that record; null when the record does not track it. */
  readonly listing: MarketCloseListingV1 | null;
  /** Counterpart's views of this Listing for this start; absent when none is read. */
  readonly counterpart?: AeonPriceBlockCounterpartViewsV1 | null;
  /** The game's in-play YES price by minute after the start (juke live marks); absent when none is read. */
  readonly live?: { readonly series: readonly (readonly [minute: number, yesMicros: number])[] } | null;
  /** Counterpart's in-play views of this Listing (halftime, late), sealed during the game; absent when none. */
  readonly counterpartLive?: readonly AeonPriceBlockCounterpartLiveInputV1[] | null;
}

/** One sealed in-play view of one Listing, as the live Counterpart stored it (YES terms). */
export interface AeonPriceBlockCounterpartLiveInputV1 {
  readonly checkpoint: 'HALF' | 'LATE';
  readonly sealedAt: string;
  readonly fairYes: string;
  readonly minutesLeft: number;
  readonly score: Readonly<{ home: number; away: number }>;
  readonly period: string | null;
  readonly elapsed: string | null;
}

/**
 * Counterpart's in-play view as a block shows it, for the side held: its price and the game state when
 * it sealed. Its own paper action is never shown (the shadow book stays hidden in Season 1).
 */
export interface AeonPriceBlockCounterpartLiveV1 {
  readonly checkpoint: 'HALF' | 'LATE';
  readonly sealedAt: string;
  readonly price: string;
  readonly minutesLeft: number;
  readonly score: Readonly<{ home: number; away: number }>;
  readonly period: string | null;
  readonly elapsed: string | null;
  readonly provisional: true;
}

/**
 * The provisional live-trading standard, v2 (Oct 4 2026, after three red-team rounds). An in-play action
 * is graded from its own minute forward, against where the market stood LIVE_MARK_AFTER_SECONDS later:
 * a buy earns shares × mark − cash paid, a sale earns cash received − shares × mark. The mark is
 *   1. DECIDED: if the price reaches a decided level (≤1¢ or ≥99¢) after the trade and before the mark
 *      minute, or at the mark minute, that decided price (the market stopped there);
 *   2. LIVE: otherwise the first two-sided minute at or after the mark minute, within the window;
 *   3. LAST_FAIR: if the window is empty (the game ended), the last price after the trade and before
 *      the window closed;
 *   4. AT_TRADE: if nothing printed after the trade, the price in the trade's own minute or the one before.
 * Only when the Market has no price at all does the final result mark it. Nothing before the trade's
 * minute can affect its mark (an early decided touch does not freeze later marks), no losing leg can be
 * left unmarked, and near-decided or late trades grade near zero rather than against the result.
 * Provisional until the live-standard study sets the delay and the guards.
 */
export const AEON_LIVE_MARK_STANDARD_V1 = 'juke.live-mark.provisional.v2' as const;
export const LIVE_MARK_AFTER_SECONDS = 300;
export const LIVE_MARK_WINDOW_MINUTES = 3;
const LIVE_DECIDED_LOW = 10_000n;
const LIVE_DECIDED_HIGH = 990_000n;
export type LiveMarkSourceV1 = 'LIVE' | 'DECIDED' | 'LAST_FAIR' | 'AT_TRADE' | 'RESULT';

export interface AeonPriceBlockLiveV1 {
  readonly standard: typeof AEON_LIVE_MARK_STANDARD_V1;
  readonly provisional: true;
  readonly markAfterSeconds: number;
  /** Each in-play action with its mark for the side held (null only before the Market has any price or result) and its value. */
  readonly actions: readonly {
    readonly actionReceiptId: string;
    readonly operation: string;
    readonly occurredAt: string;
    readonly mark: string | null;
    readonly markSource: LiveMarkSourceV1 | null;
    readonly credits: string | null;
  }[];
  readonly gradedActions: number;
  readonly ungradedActions: number;
  /** True when every in-play action has a mark (always, once the Market has a price or a result). */
  readonly complete: boolean;
  /** The graded actions' value, summed. */
  readonly credits: string;
  /** Shares bought or sold by the graded actions: the base for value per share. */
  readonly gradedShares: string;
  /** For buys marked LIVE: 100 × (mark − average buy price), per share bought. Null without one. */
  readonly entryPoints: string | null;
}

/** The mark for one in-play action, by the rule above (YES micros and its source); null when no price exists. */
export function inPlayMarkV2(series: readonly (readonly [number, number])[], startMs: number, atMs: number): { price: bigint; source: Exclude<LiveMarkSourceV1, 'RESULT'> } | null {
  const tradeMinute = Math.floor((atMs - startMs) / 60_000);
  const target = Math.ceil((atMs + LIVE_MARK_AFTER_SECONDS * 1000 - startMs) / 60_000);
  const decided = (price: bigint) => price <= LIVE_DECIDED_LOW || price >= LIVE_DECIDED_HIGH;
  let atTrade: bigint | null = null;
  let lastFair: bigint | null = null;
  for (const [minute, yes] of series) {
    const price = BigInt(yes);
    // The price at the trade counts only from its own minute or the one before: an older print on a
    // quiet Market is stale, and a stale mark would be a gift (review Oct 4).
    if (minute <= tradeMinute) { atTrade = minute >= tradeMinute - 1 ? price : null; continue; }
    if (minute >= target + LIVE_MARK_WINDOW_MINUTES) break;
    if (decided(price)) return { price, source: 'DECIDED' };
    if (minute >= target) return { price, source: 'LIVE' };
    lastFair = price;
  }
  if (lastFair !== null) return { price: lastFair, source: 'LAST_FAIR' };
  if (atTrade !== null) return { price: atTrade, source: 'AT_TRADE' };
  return null;
}

const COUNTERPART_ORDER: readonly CounterpartCheckpointV1[] = Object.freeze(['T_MINUS_6H', 'PUBLICATION'] as const);

/**
 * The view a block shows, for the side held: six hours out when it forecast,
 * else the publication view when it forecast, else the latest abstention. The
 * choice depends only on what was sealed, never on the result.
 */
export function aeonPriceBlockCounterpartV1(
  counterpart: AeonPriceBlockCounterpartViewsV1 | null | undefined,
  side: AccountingSide,
): AeonPriceBlockCounterpartV1 | null {
  const views = counterpart?.views ?? [];
  const ordered = COUNTERPART_ORDER.flatMap((checkpoint) => views.filter((view) => view.checkpoint === checkpoint));
  const chosen = ordered.find((view) => view.listing.disposition === 'FORECAST') ?? ordered[0];
  if (!chosen) return null;
  const base = { checkpoint: chosen.checkpoint, sealedAt: chosen.sealedAt, rulesDigest: chosen.rulesDigest };
  if (chosen.listing.disposition === 'ABSTAIN') {
    return Object.freeze({ ...base, disposition: 'ABSTAIN' as const, price: null, source: null, confidence: null, code: chosen.listing.code });
  }
  const yes = closePriceMicros(chosen.listing.fairYes);
  return Object.freeze({ ...base, disposition: 'FORECAST' as const, price: formatMicros(side === 'YES' ? yes : MICRO - yes),
    source: chosen.listing.source, confidence: chosen.listing.confidence, code: null });
}

/** Division rounded half away from zero; the divisor is positive. */
function divideRounded(numerator: bigint, divisor: bigint): bigint {
  const magnitude = (numerator < 0n ? -numerator : numerator);
  const rounded = (magnitude * 2n + divisor) / (divisor * 2n);
  return numerator < 0n ? -rounded : rounded;
}

function signedDecimal(micros: bigint): string {
  return micros < 0n ? `-${formatMicros(-micros)}` : formatMicros(micros);
}

interface TradeTotals {
  boughtShares: bigint;
  boughtNotional: bigint;
  soldShares: bigint;
  soldNotional: bigint;
}

interface SideTrades extends TradeTotals {
  fees: bigint;
  firstAt: number;
  lastAt: number;
  /** The same totals per action, in action order. */
  readonly actions: Map<string, TradeTotals & { readonly operation: string; readonly occurredAt: string }>;
}

/** Micros squared: shares (micros) × price (micros), cash (micros) × MICRO. */
function closingValueSquared(totals: TradeTotals, price: bigint): bigint {
  return totals.boughtShares * price - totals.boughtNotional * MICRO
    + totals.soldNotional * MICRO - totals.soldShares * price;
}

function sideTrades(market: EventRevealMarketV1): ReadonlyMap<AccountingSide, SideTrades> {
  const bySide = new Map<AccountingSide, SideTrades>();
  for (const action of market.yourReadMarket.actions) {
    const at = Date.parse(action.occurredAt);
    for (const leg of action.legs) {
      if (leg.listingId !== market.listingId) continue;
      const shares = parseCanonicalDecimal(leg.filledShares, 'filledShares');
      if (shares === 0n) continue;
      const notional = parseCanonicalDecimal(leg.notional, 'notional');
      const trades = bySide.get(leg.side) ?? {
        boughtShares: 0n, boughtNotional: 0n, soldShares: 0n, soldNotional: 0n, fees: 0n,
        firstAt: at, lastAt: at, actions: new Map(),
      };
      const perAction = trades.actions.get(action.actionReceiptId) ?? {
        boughtShares: 0n, boughtNotional: 0n, soldShares: 0n, soldNotional: 0n,
        operation: action.operation, occurredAt: action.occurredAt,
      };
      for (const totals of [trades, perAction]) {
        if (leg.cashFlow === 'DEBIT') {
          totals.boughtShares += shares;
          totals.boughtNotional += notional;
        } else {
          totals.soldShares += shares;
          totals.soldNotional += notional;
        }
      }
      trades.actions.set(action.actionReceiptId, perAction);
      trades.fees += parseCanonicalDecimal(leg.fee, 'fee');
      trades.firstAt = Math.min(trades.firstAt, at);
      trades.lastAt = Math.max(trades.lastAt, at);
      bySide.set(leg.side, trades);
    }
  }
  return bySide;
}

function averagePrice(notional: bigint, shares: bigint): string | null {
  return shares === 0n ? null : formatMicros(divideRounded(notional * MICRO, shares));
}

/**
 * The blocks for one Reveal market, one per side the player traded, YES first.
 * `close` is null when the live catalog schedules no start for the Listing.
 */
export function aeonPriceBlocksForMarketV1(input: {
  readonly market: EventRevealMarketV1;
  readonly close: AeonPriceBlockCloseV1 | null;
}): readonly AeonPriceBlockV1[] {
  const { market, close } = input;
  const listing = close?.listing ?? null;
  const captureState: AeonPriceBlockCaptureStateV1 = close === null
    ? 'NOT_SCHEDULED'
    : close.recordState === null ? 'NO_RECORD' : listing === null ? 'NOT_TRACKED' : listing.state;
  const yesMid = listing?.mid === undefined ? null : closePriceMicros(listing.mid);
  const spread = listing?.bestBid === undefined || listing.bestAsk === undefined
    ? null
    : closePriceMicros(listing.bestAsk) - closePriceMicros(listing.bestBid);
  const startAt = close?.startAt ?? null;
  const scored = market.state !== 'VOIDED'
    && (market.scoreability ?? 'SCOREABLE') === 'SCOREABLE'
    && market.outcome !== null;
  const blocks: AeonPriceBlockV1[] = [];
  const trades = sideTrades(market);
  for (const side of ['YES', 'NO'] as const) {
    const sideTrade = trades.get(side);
    if (!sideTrade) continue;
    const midForSide = yesMid === null ? null : side === 'YES' ? yesMid : MICRO - yesMid;
    const result = scored ? (market.outcome === side ? MICRO : 0n) : null;
    const captured = midForSide !== null && close?.recordState === 'FINAL'
      && (captureState === 'CAPTURED' || captureState === 'STALE');
    // A sampled book must be within the bound. A close taken from Polymarket's own displayed price
    // has no book to measure; its capture already required the YES and NO prices to agree.
    const narrow = listing?.midBasis === 'POLYMARKET_DISPLAYED_PRICE'
      || (spread !== null && spread <= AEON_PRICE_BLOCK_MAX_CLOSE_SPREAD_MICROS_V1);
    // A price is shown only when it is a real two-sided close: a sampling
    // record, a missed capture or a 1¢/99¢ book shows none.
    const price = captured && narrow ? midForSide : null;
    const state: AeonPriceBlockStateV1 = startAt !== null && sideTrade.lastAt >= Date.parse(startAt)
      ? 'TRADED_AFTER_START'
      : !captured
        ? 'CLOSE_NOT_CAPTURED'
        : !narrow
          ? 'CLOSE_SPREAD_WIDE'
          : captureState === 'STALE'
            ? 'CLOSE_STALE'
            : result === null ? 'NOT_SCORED' : 'GRADED';
    let closingValue: AeonPriceBlockV1['closingValue'] = null;
    let luck: AeonPriceBlockV1['luck'] = null;
    let actions: AeonPriceBlockV1['actions'] = Object.freeze([]);
    if (state === 'GRADED' && price !== null && result !== null) {
      const netShares = sideTrade.boughtShares - sideTrade.soldShares;
      const luckSquared = netShares * (result - price);
      closingValue = Object.freeze({
        entryPoints: sideTrade.boughtShares === 0n
          ? null
          : signedDecimal(divideRounded(100n * (price * sideTrade.boughtShares - sideTrade.boughtNotional * MICRO), sideTrade.boughtShares)),
        credits: signedDecimal(divideRounded(closingValueSquared(sideTrade, price), MICRO)),
      });
      luck = Object.freeze({
        points: signedDecimal(100n * (result - price)),
        credits: signedDecimal(divideRounded(luckSquared, MICRO)),
      });
      actions = Object.freeze([...sideTrade.actions].map(([actionReceiptId, totals]) => Object.freeze({
        actionReceiptId,
        operation: totals.operation,
        occurredAt: totals.occurredAt,
        credits: signedDecimal(divideRounded(closingValueSquared(totals, price), MICRO)),
      })));
    }
    let pregame: AeonPriceBlockPregameV1 | null = null;
    // The same close guards as a GRADED pick: captured, two-sided, narrow, not stale, scored.
    if (state === 'TRADED_AFTER_START' && startAt !== null && captured && narrow && captureState !== 'STALE' && price !== null && result !== null) {
      const startMs = Date.parse(startAt);
      const legs = [...sideTrade.actions].filter(([, totals]) => Date.parse(totals.occurredAt) < startMs);
      const part: TradeTotals = { boughtShares: 0n, boughtNotional: 0n, soldShares: 0n, soldNotional: 0n };
      for (const [, totals] of legs) {
        part.boughtShares += totals.boughtShares; part.boughtNotional += totals.boughtNotional;
        part.soldShares += totals.soldShares; part.soldNotional += totals.soldNotional;
      }
      if (part.boughtShares + part.soldShares > 0n) {
        const netShares = part.boughtShares - part.soldShares;
        pregame = Object.freeze({
          boughtShares: formatMicros(part.boughtShares),
          averageBuyPrice: averagePrice(part.boughtNotional, part.boughtShares),
          soldShares: formatMicros(part.soldShares),
          closingValue: Object.freeze({
            entryPoints: part.boughtShares === 0n ? null
              : signedDecimal(divideRounded(100n * (price * part.boughtShares - part.boughtNotional * MICRO), part.boughtShares)),
            credits: signedDecimal(divideRounded(closingValueSquared(part, price), MICRO)),
          }),
          luck: Object.freeze({ points: signedDecimal(100n * (result - price)), credits: signedDecimal(divideRounded(netShares * (result - price), MICRO)) }),
          actions: Object.freeze(legs.map(([actionReceiptId, totals]) => Object.freeze({
            actionReceiptId, operation: totals.operation, occurredAt: totals.occurredAt,
            credits: signedDecimal(divideRounded(closingValueSquared(totals, price), MICRO)),
          }))),
        });
      }
    }
    const counterpart = aeonPriceBlockCounterpartV1(close?.counterpart, side);
    const counterpartLive = (close?.counterpartLive ?? [])
      .filter((view) => view.checkpoint === 'HALF' || view.checkpoint === 'LATE')
      .sort((a, b) => (a.checkpoint === b.checkpoint ? 0 : a.checkpoint === 'HALF' ? -1 : 1))
      .map((view) => {
        const yes = closePriceMicros(view.fairYes);
        return Object.freeze({ checkpoint: view.checkpoint, sealedAt: view.sealedAt, price: formatMicros(side === 'YES' ? yes : MICRO - yes),
          minutesLeft: view.minutesLeft, score: Object.freeze({ home: view.score.home, away: view.score.away }), period: view.period, elapsed: view.elapsed, provisional: true as const });
      });
    let live: AeonPriceBlockLiveV1 | null = null;
    if (startAt !== null && close?.live && sideTrade.lastAt >= Date.parse(startAt)) {
      const startMs = Date.parse(startAt);
      let total = 0n; let graded = 0; let ungraded = 0; let gradedBought = 0n; let gradedBoughtSquared = 0n; let gradedShares = 0n;
      const liveActions = [...sideTrade.actions].filter(([, totals]) => Date.parse(totals.occurredAt) >= startMs).map(([actionReceiptId, totals]) => {
        const found = inPlayMarkV2(close.live!.series, startMs, Date.parse(totals.occurredAt));
        const liveMark = found === null ? null : side === 'YES' ? found.price : MICRO - found.price;
        // The result marks only a trade whose Market has no price at all.
        const mark = liveMark ?? result;
        const markSource: LiveMarkSourceV1 | null = found !== null ? found.source : result !== null ? 'RESULT' : null;
        if (mark === null) { ungraded += 1; return Object.freeze({ actionReceiptId, operation: totals.operation, occurredAt: totals.occurredAt, mark: null, markSource: null, credits: null }); }
        graded += 1;
        const squared = closingValueSquared(totals, mark);
        total += squared;
        gradedShares += totals.boughtShares + totals.soldShares;
        // Entry points describe buys against the live market only (not fallback marks).
        if (totals.boughtShares > 0n && markSource === 'LIVE') { gradedBought += totals.boughtShares; gradedBoughtSquared += totals.boughtShares * mark - totals.boughtNotional * MICRO; }
        return Object.freeze({ actionReceiptId, operation: totals.operation, occurredAt: totals.occurredAt, mark: formatMicros(mark), markSource, credits: signedDecimal(divideRounded(squared, MICRO)) });
      });
      if (liveActions.length > 0) live = Object.freeze({
        standard: AEON_LIVE_MARK_STANDARD_V1, provisional: true as const, markAfterSeconds: LIVE_MARK_AFTER_SECONDS,
        actions: Object.freeze(liveActions), gradedActions: graded, ungradedActions: ungraded, complete: ungraded === 0,
        credits: signedDecimal(divideRounded(total, MICRO)),
        gradedShares: formatMicros(gradedShares),
        entryPoints: gradedBought === 0n ? null : signedDecimal(divideRounded(100n * gradedBoughtSquared, gradedBought)),
      });
    }
    blocks.push(Object.freeze({
      contractVersion: AEON_PRICE_BLOCK_V1,
      listingId: market.listingId,
      side,
      state,
      entry: Object.freeze({
        boughtShares: formatMicros(sideTrade.boughtShares),
        averageBuyPrice: averagePrice(sideTrade.boughtNotional, sideTrade.boughtShares),
        soldShares: formatMicros(sideTrade.soldShares),
        averageSellPrice: averagePrice(sideTrade.soldNotional, sideTrade.soldShares),
        fees: formatMicros(sideTrade.fees),
      }),
      close: Object.freeze({
        source: listing?.midBasis === 'POLYMARKET_DISPLAYED_PRICE' ? 'POLYMARKET_DISPLAYED_PRICE' as const : 'POLYMARKET_LAST_TWO_SIDED_MID' as const,
        captureState,
        startAt,
        price: price === null ? null : formatMicros(price),
        spread: spread === null ? null : signedDecimal(spread),
        ageAtStartSeconds: listing?.ageAtStartMs === undefined ? null : Math.round(listing.ageAtStartMs / 1000),
      }),
      result: result === null ? null : result === MICRO ? '1' : '0',
      closingValue,
      luck,
      actions,
      ...(counterpart === null ? {} : { counterpart }),
      ...(counterpartLive.length === 0 ? {} : { counterpartLive: Object.freeze(counterpartLive) }),
      ...(pregame === null ? {} : { pregame }),
      ...(live === null ? {} : { live }),
    }));
  }
  return Object.freeze(blocks);
}

/** The minimal Book shape the read plan needs: its kind and its receipts. */
export interface AeonPriceBlockBookInputV1 {
  readonly descriptor: { readonly bookKind: string };
  readonly ledger: {
    readonly receipts: readonly {
      readonly receiptType: string;
      readonly subjectId: string;
      readonly terms: Readonly<Record<string, unknown>>;
    }[];
  };
}

/**
 * The Listings a Reveal can show a block for: traded in an Arena Book (either
 * leg of a switch included) and carrying a finality receipt there.
 */
export function revealableArenaListingIdsV1(books: readonly AeonPriceBlockBookInputV1[]): ReadonlySet<string> {
  const revealable = new Set<string>();
  for (const book of books) {
    if (book.descriptor.bookKind !== 'ARENA') continue;
    const traded = new Set<string>();
    const finalized = new Set<string>();
    for (const receipt of book.ledger.receipts) {
      if (receipt.receiptType === 'FINALITY') finalized.add(receipt.subjectId);
      if ((receipt.receiptType === 'ACTION' || receipt.receiptType === 'SWITCH')
        && typeof receipt.terms.listingId === 'string') traded.add(receipt.terms.listingId);
    }
    for (const listingId of traded) if (finalized.has(listingId)) revealable.add(listingId);
  }
  return revealable;
}

export interface AeonPriceBlockReadPlanV1 {
  /** One entry per Event to read, in read order. */
  readonly events: readonly { readonly eventId: string; readonly startAt: string }[];
  /** Each scheduled Listing's Event. */
  readonly scheduled: ReadonlyMap<string, { readonly eventId: string; readonly startAt: string }>;
  /** Stocked by a given catalog with no scheduled start: truthfully never captured. */
  readonly unscheduled: ReadonlySet<string>;
}

/**
 * Which close records to read. The catalogs are the live one first, then the
 * sealed version of each departed Arena (its Week's Reveals outlive the
 * rollover); the first catalog stocking a Listing places it. A Listing none of
 * them stocks is in neither map: its close is unknown here, so it gets no
 * block rather than a false "not captured".
 */
export function aeonPriceBlockReadPlanV1(
  catalogs: StockedCatalog | readonly StockedCatalog[],
  revealable: ReadonlySet<string>,
): AeonPriceBlockReadPlanV1 {
  const scheduled = new Map<string, { readonly eventId: string; readonly startAt: string }>();
  const events = new Map<string, { readonly eventId: string; readonly startAt: string }>();
  const unscheduled = new Set<string>();
  for (const catalog of Array.isArray(catalogs) ? catalogs : [catalogs as StockedCatalog]) {
    const placed = new Set([...scheduled.keys(), ...unscheduled]);
    for (const event of marketCloseScheduleV1(catalog).events) {
      for (const listing of event.listings) {
        if (!revealable.has(listing.listingId) || placed.has(listing.listingId)) continue;
        const where = Object.freeze({ eventId: event.eventId, startAt: event.startAt });
        scheduled.set(listing.listingId, where);
        events.set(`${event.eventId}|${event.startAt}`, where);
      }
    }
    for (const arena of catalog.arenas) {
      for (const listing of arena.listings) {
        if (revealable.has(listing.listingId) && !placed.has(listing.listingId)
          && !scheduled.has(listing.listingId)) unscheduled.add(listing.listingId);
      }
    }
  }
  return Object.freeze({ events: Object.freeze([...events.values()]), scheduled, unscheduled });
}

/**
 * The runtime's closes from the plan and what was read, keyed `eventId|startAt`.
 * `'INVALID'` marks a record that failed validation: its Listings get no block,
 * and the rest of the Reports read is unaffected.
 */
export function aeonPriceBlockClosesV1(
  plan: AeonPriceBlockReadPlanV1,
  records: ReadonlyMap<string, MarketEventCloseV1 | 'INVALID'>,
  /** Counterpart's sealed views by Event, when they are read. */
  counterpartViews: ReadonlyMap<string, readonly CounterpartEventViewV1[]> | null = null,
): readonly { readonly listingId: string; readonly close: AeonPriceBlockCloseV1 | null }[] {
  const closes: { readonly listingId: string; readonly close: AeonPriceBlockCloseV1 | null }[] = [];
  for (const [listingId, where] of plan.scheduled) {
    const record = records.get(`${where.eventId}|${where.startAt}`);
    if (record === 'INVALID') continue;
    // A view sealed for another start time was made against another kickoff: it is not shown.
    const views = counterpartViews === null ? null : (counterpartViews.get(where.eventId) ?? [])
      .filter((view) => view.startAt === where.startAt)
      .flatMap((view) => view.listings.filter((entry) => entry.listingId === listingId).map((listing) => Object.freeze({
        checkpoint: view.checkpoint, sealedAt: view.sealedAt, rulesDigest: view.rulesDigest, listing,
      })));
    closes.push(Object.freeze({
      listingId,
      close: Object.freeze({
        startAt: where.startAt,
        recordState: record?.state ?? null,
        listing: record?.listings.find((entry) => entry.listingId === listingId) ?? null,
        ...(views === null || views.length === 0 ? {} : { counterpart: Object.freeze({ views: Object.freeze(views) }) }),
      }),
    }));
  }
  for (const listingId of plan.unscheduled) closes.push(Object.freeze({ listingId, close: null }));
  return Object.freeze(closes);
}

/**
 * Decorates one served Reveal's markets. Only Arena Event Reveals carry blocks
 * (closes are captured for Arena Listings only), and a market whose close is
 * unknown carries none.
 */
export function aeonPriceBlockRevealMarketsV1<M extends EventRevealMarketV1>(input: {
  readonly scope: string;
  readonly markets: readonly M[];
  readonly closes: ReadonlyMap<string, AeonPriceBlockCloseV1 | null>;
}): readonly (M | (M & { readonly aeonPriceBlocks: readonly AeonPriceBlockV1[] }))[] {
  if (input.scope !== 'ARENA_EVENT') return input.markets;
  return Object.freeze(input.markets.map((market) => {
    if (!input.closes.has(market.listingId)) return market;
    let aeonPriceBlocks: readonly AeonPriceBlockV1[];
    try {
      aeonPriceBlocks = aeonPriceBlocksForMarketV1({ market, close: input.closes.get(market.listingId) ?? null });
    } catch {
      // A block that cannot be built is left out; it never takes the Reports
      // read down with it.
      return market;
    }
    return Object.freeze({ ...market, aeonPriceBlocks });
  }));
}
