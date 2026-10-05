import {
  capabilityZV1,
  aeonCapabilityGraphV1,
  aeonCapabilityWeekV1,
  capabilityTradingFromSeasonWeekV1,
  type CapabilityAxesV1,
  type CapabilityTradingCellV1,
} from '../v3-beta/aeon-capability-graph-v1';
import type { AeonPriceBlockV1 } from '../v3-beta/aeon-price-block-v1';
import type { AeonSeasonRecordV1 } from '../v3-beta/aeon-season-record-v1';
import type { StockedCatalog } from '../v3-beta/stocked-catalog';

/**
 * juke# for one player (docs/research/vision/capability-graph-v1.md): the engine's own
 * capability graph, built from the player's Season record and the price blocks their
 * Reveals already carry. Nothing here computes a statistic; it joins the inputs, calls
 * the tested builder, and returns the cells a page shows. Only the eight primary cells
 * (overall, two sports, five market types) can carry a verdict; a cell below its minimum
 * (30 graded picks across 15 games) says how many it still needs.
 */

/** Polymarket's market types, as the five approved families. A type outside these belongs to no family cell. */
const FAMILY: Readonly<Record<string, string>> = Object.freeze({
  moneyline: 'WINNER', first_half_moneyline: 'WINNER',
  spreads: 'SPREAD', first_half_spreads: 'SPREAD', q1_spreads: 'SPREAD', q2_spreads: 'SPREAD', q3_spreads: 'SPREAD', q4_spreads: 'SPREAD',
  totals: 'TOTAL', first_half_totals: 'TOTAL', q1_totals: 'TOTAL', q2_totals: 'TOTAL', q3_totals: 'TOTAL', q4_totals: 'TOTAL',
  anytime_touchdowns: 'PLAYER_PROP', two_plus_touchdowns: 'PLAYER_PROP', receptions: 'PLAYER_PROP',
  team_totals: 'TEAM_PROP', first_half_team_totals: 'TEAM_PROP', team_touchdowns: 'TEAM_PROP',
  soccer_team_totals: 'TEAM_PROP', soccer_first_half_team_totals: 'TEAM_PROP',
});

export function sharpAxes(catalogs: readonly StockedCatalog[]): Map<string, CapabilityAxesV1> {
  const axes = new Map<string, CapabilityAxesV1>();
  for (const catalog of catalogs) for (const arena of catalog.arenas) for (const listing of arena.listings) {
    const presentation = listing.sportsMarketPresentation;
    axes.set(listing.listingId, Object.freeze({
      sportId: listing.sportId ?? null,
      competitionId: null,
      marketFamily: presentation ? FAMILY[presentation.marketType] ?? null : null,
      period: presentation?.period ?? null,
      // The catalog does not mark a main line; that descriptive cell stays empty rather than guessed.
      isMainLine: null,
    }));
  }
  return axes;
}

export interface SharpCell {
  readonly cellId: string;
  /** Live cells add ESTIMATE_ONLY: enough evidence, verdicts held (LIVE_VERDICTS_V1). */
  readonly label: CapabilityTradingCellV1['label'] | 'ESTIMATE_ONLY';
  readonly picks: number;
  readonly events: number;
  readonly estimate: string | null;
  readonly picksNeeded: number;
  readonly eventsNeeded: number;
}
export type SharpRead =
  | { readonly state: 'AVAILABLE'; readonly seasonId: string; readonly gradedPicks: number; readonly games: number; readonly liveActions: number;
      readonly closingValueCredits: string; readonly verdicts: readonly SharpCell[]; readonly bySportAndType: readonly SharpCell[];
      readonly live: LiveSharp;
      readonly minimum: { readonly picks: number; readonly events: number }; readonly digest: string }
  | { readonly state: 'HELD'; readonly code: string };

const PRIMARY = ['OVERALL', 'SPORT:sport:football', 'SPORT:sport:soccer', 'MARKET_TYPE:WINNER', 'MARKET_TYPE:SPREAD', 'MARKET_TYPE:TOTAL', 'MARKET_TYPE:PLAYER_PROP', 'MARKET_TYPE:TEAM_PROP'];

interface RevealRead { readonly bookId?: string; readonly eventId?: string; readonly markets?: readonly { readonly aeonPriceBlocks?: readonly AeonPriceBlockV1[] }[] }

/**
 * Live trading in juke# (provisional, Oct 3 2026): in-play trades graded against the live
 * market five minutes later. The same eight primary cells, the same minimum (30 graded picks across
 * 15 games) and the same threshold as pregame trading (Bonferroni over the eight cells and the
 * Season's weekly looks). The estimate is points per share above the live mark, Σ value ÷ Σ shares,
 * with a cluster-robust standard error by game.
 */
export interface LiveSharp {
  readonly provisional: true;
  readonly gradedPicks: number;
  readonly games: number;
  readonly credits: string;
  readonly verdicts: readonly SharpCell[];
}

/**
 * The Season's in-play picks (the record's TRADED_AFTER_START picks, one per Book, Market and side),
 * each valued by its graded in-play trades only: value per graded share, so pregame shares and
 * ungraded trades never dilute it.
 */
/**
 * Live verdicts are held (research review, Oct 4 2026): a zero-skill strategy that wins small almost
 * always with a rare large loss (e.g. near-decided favourites in play) reaches ABOVE in 99.96% of
 * simulated seasons by week 4 under this normal interval. Until a tail-valid method passes the registered
 * null and power tests, a live cell with enough evidence shows its estimate as ESTIMATE_ONLY, never a
 * verdict. Pregame cells (graded against the close, not a lopsided payoff) are unchanged.
 */
export const LIVE_VERDICTS_V1 = false;

export function liveSharp(input: { readonly picks: readonly { readonly eventId: string; readonly block: Pick<AeonPriceBlockV1, 'listingId' | 'live'> }[]; readonly axes: ReadonlyMap<string, CapabilityAxesV1>; readonly looks: number; readonly minimum: { readonly picks: number; readonly events: number }; readonly verdicts?: boolean }): LiveSharp {
  interface LivePick { event: string; value: number; shares: number; axes: CapabilityAxesV1 | undefined }
  const picks: LivePick[] = [];
  for (const { eventId, block } of input.picks) {
    const live = block.live;
    // A pick enters the live cells only when every in-play trade has a mark (graded whole or not at all).
    if (!live || live.gradedActions === 0 || live.complete !== true) continue;
    const shares = Number(live.gradedShares);
    if (!(shares > 0)) continue;
    picks.push({ event: eventId, value: Number(live.credits), shares, axes: input.axes.get(block.listingId) });
  }
  const z = capabilityZV1(8, Math.max(1, input.looks));
  const cell = (cellId: string, keep: (pick: LivePick) => boolean): SharpCell => {
    const chosen = picks.filter(keep);
    const byEvent = new Map<string, { value: number; shares: number }>();
    for (const pick of chosen) { const e = byEvent.get(pick.event) ?? { value: 0, shares: 0 }; e.value += pick.value; e.shares += pick.shares; byEvent.set(pick.event, e); }
    const events = byEvent.size;
    const picksNeeded = Math.max(0, input.minimum.picks - chosen.length);
    const eventsNeeded = Math.max(0, input.minimum.events - events);
    if (picksNeeded > 0 || eventsNeeded > 0) return { cellId, label: 'INSUFFICIENT_EVIDENCE', picks: chosen.length, events, estimate: null, picksNeeded, eventsNeeded };
    const totalValue = [...byEvent.values()].reduce((sum, e) => sum + e.value, 0);
    const totalShares = [...byEvent.values()].reduce((sum, e) => sum + e.shares, 0);
    const ratio = totalValue / totalShares;
    const variance = [...byEvent.values()].reduce((sum, e) => sum + (e.value - ratio * e.shares) ** 2, 0) / (totalShares ** 2) * (events / (events - 1));
    const se = Math.sqrt(variance);
    const label = !(input.verdicts ?? LIVE_VERDICTS_V1) ? 'ESTIMATE_ONLY'
      : ratio - z * se > 0 ? 'ABOVE_COPIER_LINE' : ratio + z * se < 0 ? 'BELOW_COPIER_LINE' : 'WITHIN_COPIER_RANGE';
    return { cellId, label, picks: chosen.length, events, estimate: (ratio * 100).toFixed(4), picksNeeded: 0, eventsNeeded: 0 };
  };
  const verdicts = [
    cell('OVERALL', () => true),
    cell('SPORT:sport:football', (pick) => pick.axes?.sportId === 'sport:football'),
    cell('SPORT:sport:soccer', (pick) => pick.axes?.sportId === 'sport:soccer'),
    ...['WINNER', 'SPREAD', 'TOTAL', 'PLAYER_PROP', 'TEAM_PROP'].map((family) => cell(`MARKET_TYPE:${family}`, (pick) => pick.axes?.marketFamily === family)),
  ];
  return { provisional: true, gradedPicks: picks.length, games: new Set(picks.map((pick) => pick.event)).size, credits: picks.reduce((sum, pick) => sum + pick.value, 0).toFixed(6), verdicts };
}

export function jukeSharp(input: {
  readonly actorId: string;
  readonly record: AeonSeasonRecordV1 | null;
  readonly recordCode: string | null;
  readonly reveals: readonly RevealRead[];
  readonly catalogs: readonly StockedCatalog[];
  readonly now: string;
}): SharpRead {
  if (!input.record) return { state: 'HELD', code: input.recordCode ?? 'JUKE_SHARP_RECORD_UNAVAILABLE' };
  try {
    const blocks = new Map<string, AeonPriceBlockV1>();
    for (const reveal of input.reveals) for (const market of reveal.markets ?? []) for (const block of market.aeonPriceBlocks ?? []) {
      blocks.set(`${reveal.bookId}|${block.listingId}|${block.side}`, block);
    }
    const axes = sharpAxes(input.catalogs);
    const node = { kind: 'HUMAN' as const, id: input.actorId.replace(/@/gu, '_'), version: `season:${input.record.seasonId}` };
    const events = new Set<string>();
    let liveActions = 0;
    const livePicks = new Map<string, { eventId: string; block: AeonPriceBlockV1 }>();
    for (const week of input.record.weeks) for (const pick of week.picks) {
      if (pick.status !== 'TRADED_AFTER_START') continue;
      const key = `${pick.bookId}|${pick.listingId}|${pick.side}`;
      const block = blocks.get(key);
      if (block) livePicks.set(key, { eventId: pick.eventId, block });
    }
    const weeks = input.record.weeks.map((week) => {
      const { trading, live } = capabilityTradingFromSeasonWeekV1({ week, blocks, axes });
      for (const pick of trading) events.add(pick.eventId);
      liveActions += live.length;
      return aeonCapabilityWeekV1({ node, weekId: week.weekId, trading, live, forecasts: [], trials: [] });
    });
    const graph = aeonCapabilityGraphV1({ asOf: input.now, node, weeks, looks: Math.max(1, input.record.weeks.length) });
    const minimum = graph.minimums.trading;
    const byId = new Map(graph.competition.cells.map((cell) => [cell.cellId, cell]));
    const cell = (cellId: string): SharpCell => {
      const found = byId.get(cellId);
      return {
        cellId, label: found?.label ?? 'INSUFFICIENT_EVIDENCE', picks: found?.picks ?? 0, events: found?.events ?? 0, estimate: found?.estimate ?? null,
        picksNeeded: found?.progress?.picksNeeded ?? (found ? 0 : minimum.picks), eventsNeeded: found?.progress?.eventsNeeded ?? (found ? 0 : minimum.events),
      };
    };
    return {
      state: 'AVAILABLE', seasonId: input.record.seasonId, gradedPicks: graph.competition.accounting.picks, games: events.size, liveActions,
      closingValueCredits: graph.competition.accounting.closingValueCredits,
      verdicts: PRIMARY.map(cell),
      bySportAndType: graph.competition.cells.filter((entry) => entry.axis === 'SPORT_X_TYPE' && entry.picks > 0).map((entry) => cell(entry.cellId)),
      minimum, digest: graph.graphDigest,
      live: liveSharp({ picks: [...livePicks.values()], axes, looks: Math.max(1, input.record.weeks.length), minimum }),
    };
  } catch (error) {
    const code = error instanceof Error && typeof (error as { code?: unknown }).code === 'string' ? (error as unknown as { code: string }).code : 'JUKE_SHARP_UNAVAILABLE';
    return { state: 'HELD', code };
  }
}
