import type { AeonPriceBlockV1 } from './aeon-price-block-v1';
import type { AeonSeasonRecordWeekV1 } from './aeon-season-record-v1';
import { COPIER_LINE_V1_RULES_DIGEST, copierLuckReceiptV1 } from './counterpart-model-copier-line-v1';
import { counterpartCheckpointLateV1, type CounterpartEventViewV1 } from './counterpart-view-v1';
import { dataPlaneDigest, type AccountingSide, type DataPlaneDigest } from './data-plane-contract';

/**
 * The predictive capability graph (docs/research/vision/capability-graph-v1.md): who
 * and what performs, under which conditions, with the result relative to the close
 * kept apart and "insufficient evidence" said honestly.
 *
 * - **Nodes** are versioned systems (`{kind}:{id}@{version}`). A new version starts an
 *   empty record.
 * - **Four dimensions, never combined into one score** (final handoff §8):
 *   1. forecast quality: a sealed probability against the close, measured from the
 *      copier line (the Polymarket mid it sealed with). A task with no forecast scores
 *      0. Brier against results is shown beside it and never labelled;
 *   2. competition/accounting: points per share above the copier line, graded against
 *      the close, plus the Credits totals, the entry/exit/size decomposition, and Live
 *      Pressure (NOT_MEASURABLE until the live mark is captured);
 *   3. contribution: a controlled Challenger − Champion difference per paired task,
 *      from a trial written down in advance;
 *   4. operations: tasks, eligibility, forecasts, abstentions by code, not run,
 *      failed, timed out, late, pending, latency and cost.
 * - **Statistics.**
 *   - The grid is fixed, and only the primary family (overall, sport, market type:
 *     K = 8) can carry ABOVE or BELOW. Its intervals are Bonferroni-adjusted, two-sided,
 *     over K × the Season's weekly looks. Every other cell is DESCRIPTIVE.
 *   - Below its minimum, a cell shows counts and the evidence still needed, never an
 *     estimate.
 *   - Intervals are cluster-robust by event, from per-event sums. A Week document
 *     stores only additive sums, so a Season is the sum of its Weeks.
 * - **Tables** label across nodes with Benjamini–Hochberg at 5%. They rank only the
 *   labelled nodes, shrinking toward the copier line when 20 or more are ranked. The
 *   copier row comes first.
 *
 * Pure: every input, including each Listing's outcome from the source-finality
 * boundary, is an argument. It reads nothing.
 */
export const AEON_CAPABILITY_GRAPH_V1 = 'aeon.v3.beta.aeon-capability-graph.v1' as const;

const SPORTS = Object.freeze(['sport:soccer', 'sport:football'] as const);
const FAMILIES = Object.freeze(['WINNER', 'SPREAD', 'TOTAL', 'PLAYER_PROP', 'TEAM_PROP'] as const);
const LATENCY_BUCKETS = Object.freeze([
  ['LE_1S', 1_000], ['LE_5S', 5_000], ['LE_30S', 30_000], ['LE_2M', 120_000], ['LE_10M', 600_000], ['LE_30M', 1_800_000], ['GT_30M', Infinity],
] as const);

export const AEON_CAPABILITY_GRAPH_V1_RULES = Object.freeze({
  version: 'aeon-capability-graph-v1',
  primaryFamily: Object.freeze(['OVERALL', 'SPORT', 'MARKET_TYPE'] as const),
  primaryK: 8,
  adjustment: 'BONFERRONI_TWO_SIDED_OVER_K_TIMES_WEEKLY_LOOKS',
  alpha: '0.05',
  minimums: Object.freeze({
    trading: Object.freeze({ picks: 30, events: 15 }),
    forecasting: Object.freeze({ listings: 50, events: 15 }),
    trial: Object.freeze({ tasks: 50, events: 15 }),
  }),
  tableFalseDiscoveryRate: '0.05',
  tableShrinkMinNodes: 20,
  sports: SPORTS,
  families: FAMILIES,
  timeBins: 'H24_PLUS [24h,inf), H6_24 [6h,24h), H1_6 [1h,6h), H0_1 [0,1h) before the start',
  priceBins: 'P00_20 [0,0.2), P20_40 [0.2,0.4), P40_60 [0.4,0.6), P60_80 [0.6,0.8), P80_100 [0.8,1]',
  spreadBins: 'LE_2 [0,0.02], P2_5 (0.02,0.05], P5_10 (0.05,0.10]',
  liveMark: 'MID_15_MINUTES_AFTER_OR_PERIOD_END_IF_SOONER; NOT_CAPTURED',
  forecastNoForecastScores: 'ZERO',
  copierLine: COPIER_LINE_V1_RULES_DIGEST,
});
export const AEON_CAPABILITY_GRAPH_V1_RULES_DIGEST: DataPlaneDigest = dataPlaneDigest(AEON_CAPABILITY_GRAPH_V1_RULES);

export class AeonCapabilityGraphV1Error extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AeonCapabilityGraphV1Error';
  }
}
function fail(code: string): never {
  throw new AeonCapabilityGraphV1Error(code);
}

// ---------------------------------------------------------------------------
// Inputs

export type CapabilityNodeKindV1 = 'COPIER' | 'COUNTERPART' | 'AI_SEAT' | 'USER_SYSTEM' | 'HUMAN';
export interface CapabilityNodeRefV1 {
  readonly kind: CapabilityNodeKindV1;
  readonly id: string;
  /** The config digest; for a HUMAN, `season:{seasonId}`. */
  readonly version: string;
}

export interface CapabilityAxesV1 {
  readonly sportId: string | null;
  readonly competitionId: string | null;
  readonly marketFamily: string | null;
  readonly period: string | null;
  readonly isMainLine: boolean | null;
}

/** One graded pre-game pick (a Season record GRADED pick joined to its price block). */
export interface CapabilityTradingPickV1 {
  readonly eventId: string;
  readonly listingId: string;
  readonly side: AccountingSide;
  readonly axes: CapabilityAxesV1;
  readonly startAt: string;
  /** The last action on this pick, before the start. */
  readonly decidedAt: string;
  readonly boughtShares: string;
  readonly soldShares: string;
  readonly averageBuyPrice: string | null;
  readonly closeForSide: string;
  /** Null for a displayed-price close, which has no bid and ask. */
  readonly closeSpread: string | null;
  readonly closingValueCredits: string;
  readonly copierLineCredits: string;
  readonly resultRelativeCredits: string;
  readonly feesCredits: string;
  readonly result: '1' | '0';
}

/** An action at or after the start (TRADED_AFTER_START): counted, not graded until a live mark exists. */
export interface CapabilityLiveActionV1 {
  readonly eventId: string;
  readonly listingId: string;
  readonly axes: CapabilityAxesV1;
}

/** A Listing's final outcome from the source-finality boundary (owned by the integration owner). */
export interface CapabilityListingOutcomeV1 {
  readonly listingId: string;
  readonly state: 'FINAL' | 'VOIDED';
  readonly winningOutcome: 'YES' | 'NO' | null;
  readonly receiptId: string;
  readonly correctionId: string | null;
}

export type CapabilityDispositionV1 = 'FORECAST' | 'ABSTAIN' | 'NOT_RUN' | 'FAILED' | 'TIMED_OUT' | 'LATE';

/** One forecasting task: a Listing at a checkpoint. */
export interface CapabilityForecastRowV1 {
  readonly eventId: string;
  /** The event's start: a game belongs to the Week it starts in, whatever its checkpoints' sealing times. */
  readonly eventStartAt: string;
  readonly listingId: string;
  readonly axes: CapabilityAxesV1;
  readonly checkpoint: 'PUBLICATION' | 'T_MINUS_6H';
  readonly disposition: CapabilityDispositionV1;
  /** The method's own abstention code (ABSTAIN only). */
  readonly abstainCode: string | null;
  readonly forecastYes: string | null;
  /** The Polymarket YES mid the node sealed with: the copier's forecast. */
  readonly marketYes: string | null;
  /** Aeon's captured, gradeable YES close, or null. */
  readonly closeYes: string | null;
  readonly closeSpread: string | null;
  /** Null while the outcome is pending. */
  readonly outcome: CapabilityListingOutcomeV1 | null;
  readonly latencyMs: number | null;
  readonly costMicroUsd: string | null;
}

export interface CapabilityTrialMetaV1 {
  readonly trialId: string;
  readonly championNodeId: string;
  readonly challengerNodeId: string;
  readonly changedComponent: string;
  /** The pre-registered metric; `difference` is challenger − champion in its units, positive = challenger better. */
  readonly metric: string;
  readonly preRegistration: string;
  /** A historical replay can generate a hypothesis; only a prospective trial supports a claim (handoff §6). */
  readonly mode: 'PROSPECTIVE' | 'HISTORICAL_REPLAY';
  /** The trial's stopping time: its one look. Before it, the trial is shown running, without a label. */
  readonly until: string;
}
export interface CapabilityTrialPairV1 {
  readonly trialId: string;
  readonly eventId: string;
  readonly taskId: string;
  readonly difference: string;
}

// ---------------------------------------------------------------------------
// Arithmetic

const MICRO = 1_000_000n;
const SIGNED = /^(-)?(0|[1-9]\d*)(?:\.(\d{1,6}))?$/u;

function micros(value: string, code = 'AEON_CAPABILITY_GRAPH_DECIMAL_INVALID'): bigint {
  const match = typeof value === 'string' ? SIGNED.exec(value) : null;
  if (!match) fail(code);
  const magnitude = BigInt(match[2]!) * MICRO + BigInt((match[3] ?? '').padEnd(6, '0'));
  return match[1] === '-' ? -magnitude : magnitude;
}
function probability(value: string): bigint {
  const parsed = micros(value);
  if (parsed < 0n || parsed > MICRO) fail('AEON_CAPABILITY_GRAPH_PROBABILITY_INVALID');
  return parsed;
}
function formatMicrosSigned(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const fraction = (magnitude % MICRO).toString().padStart(6, '0').replace(/0+$/u, '');
  const text = fraction === '' ? (magnitude / MICRO).toString() : `${(magnitude / MICRO).toString()}.${fraction}`;
  return negative && magnitude !== 0n ? `-${text}` : text;
}
/** Ten-thousandths as fixed four-decimal text. */
function formatTenThousandths(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const text = `${(magnitude / 10_000n).toString()}.${(magnitude % 10_000n).toString().padStart(4, '0')}`;
  return negative && magnitude !== 0n ? `-${text}` : text;
}
function divideRounded(numerator: bigint, divisor: bigint): bigint {
  const magnitude = numerator < 0n ? -numerator : numerator;
  const rounded = (magnitude * 2n + divisor) / (divisor * 2n);
  return numerator < 0n ? -rounded : rounded;
}
function fixed4(value: number): string {
  const text = value.toFixed(4);
  return text === '-0.0000' ? '0.0000' : text;
}

/** −100·KL(c‖x) in ten-thousandths of a log point, rounded per Listing as `counterpartViewGradeV1` rounds. */
function gradeTenThousandths(x: bigint, c: bigint): bigint {
  const cf = Number(c) / 1e6;
  const xf = Number(x) / 1e6;
  const log = 100 * (cf * Math.log(xf / cf) + (1 - cf) * Math.log((1 - xf) / (1 - cf)));
  return BigInt(Math.round((Math.round(log * 10_000) / 10_000 || 0) * 10_000));
}

function erfc(x: number): number {
  if (x < 0) return 2 - erfc(-x);
  if (x < 2.5) {
    // erf by its Taylor series.
    let sum = 0;
    let term = x;
    for (let n = 0; n < 200; n += 1) {
      const add = term / (2 * n + 1);
      sum += add;
      if (Math.abs(add) < 1e-17) break;
      term *= -(x * x) / (n + 1);
    }
    return 1 - (2 / Math.sqrt(Math.PI)) * sum;
  }
  // The continued fraction, evaluated from its tail.
  let tail = x;
  for (let k = 120; k >= 1; k -= 1) tail = x + (k / 2) / tail;
  return Math.exp(-x * x) / (Math.sqrt(Math.PI) * tail);
}

/** The standard normal CDF. */
export function capabilityNormalCdfV1(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2);
}

/** The two-sided Bonferroni critical value for K cells over `looks` weekly looks at α = 0.05. */
export function capabilityZV1(k: number, looks: number): number {
  if (!Number.isInteger(k) || k < 1 || !Number.isInteger(looks) || looks < 1) fail('AEON_CAPABILITY_GRAPH_ADJUSTMENT_INVALID');
  const target = 1 - 0.05 / (k * looks) / 2;
  let lo = -40;
  let hi = 40;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (capabilityNormalCdfV1(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
const Z95 = capabilityZV1(1, 1);

/**
 * Empirical-Bayes shrinkage toward 0, the copier line. The prior is centred on 0, so
 * τ² is estimated around 0 too: τ² = max(0, mean(estimate²) − mean(SE²)).
 */
export function capabilityShrinkV1(estimates: readonly number[], ses: readonly number[]): number[] {
  if (estimates.length !== ses.length || estimates.length < 2) fail('AEON_CAPABILITY_GRAPH_SHRINK_INVALID');
  const tau2 = Math.max(0, estimates.reduce((a, b) => a + b * b, 0) / estimates.length - ses.reduce((a, b) => a + b * b, 0) / ses.length);
  return estimates.map((estimate, i) => (tau2 === 0 ? 0 : (tau2 / (tau2 + ses[i]! ** 2)) * estimate));
}

// ---------------------------------------------------------------------------
// Cluster statistics: per-event sums, additive across Weeks

export interface CapabilityClusterStatsV1 {
  readonly n: number;
  readonly events: number;
  readonly sumS: string;
  readonly sumS2: string;
  readonly sumNS: string;
  readonly sumN2: string;
}

class Clusters {
  readonly byEvent = new Map<string, { n: number; s: bigint }>();
  add(eventId: string, value: bigint): void {
    const entry = this.byEvent.get(eventId) ?? { n: 0, s: 0n };
    entry.n += 1;
    entry.s += value;
    this.byEvent.set(eventId, entry);
  }
  stats(): CapabilityClusterStatsV1 {
    let n = 0;
    let s = 0n;
    let s2 = 0n;
    let ns = 0n;
    let n2 = 0n;
    for (const entry of this.byEvent.values()) {
      n += entry.n;
      s += entry.s;
      s2 += entry.s * entry.s;
      ns += BigInt(entry.n) * entry.s;
      n2 += BigInt(entry.n * entry.n);
    }
    return { n, events: this.byEvent.size, sumS: s.toString(), sumS2: s2.toString(), sumNS: ns.toString(), sumN2: n2.toString() };
  }
}

function addClusters(left: CapabilityClusterStatsV1 | undefined, right: CapabilityClusterStatsV1): CapabilityClusterStatsV1 {
  if (!left) return right;
  return {
    n: left.n + right.n,
    events: left.events + right.events,
    sumS: (BigInt(left.sumS) + BigInt(right.sumS)).toString(),
    sumS2: (BigInt(left.sumS2) + BigInt(right.sumS2)).toString(),
    sumNS: (BigInt(left.sumNS) + BigInt(right.sumNS)).toString(),
    sumN2: (BigInt(left.sumN2) + BigInt(right.sumN2)).toString(),
  };
}

/** The mean (in stored units) and its cluster-robust standard error. */
function meanAndSe(stats: CapabilityClusterStatsV1): { mean: number; se: number } {
  const n = BigInt(stats.n);
  const s = BigInt(stats.sumS);
  const numerator = n * n * BigInt(stats.sumS2) - 2n * n * s * BigInt(stats.sumNS) + s * s * BigInt(stats.sumN2);
  const e = stats.events;
  const variance = e > 1 ? (Math.max(0, Number(numerator)) * (e / (e - 1))) / Number(n) ** 4 : 0;
  return { mean: Number(s) / stats.n, se: Math.sqrt(variance) };
}

// ---------------------------------------------------------------------------
// Cells

interface CellKey {
  readonly cellId: string;
  readonly axis: string;
  readonly bin: string;
}

function isPrimary(axis: string): boolean {
  return (AEON_CAPABILITY_GRAPH_V1_RULES.primaryFamily as readonly string[]).includes(axis);
}

function priceBin(value: bigint): string {
  if (value < 200_000n) return 'P00_20';
  if (value < 400_000n) return 'P20_40';
  if (value < 600_000n) return 'P40_60';
  if (value < 800_000n) return 'P60_80';
  return 'P80_100';
}
function spreadBin(value: bigint): string | null {
  if (value < 0n) return null;
  if (value <= 20_000n) return 'LE_2';
  if (value <= 50_000n) return 'P2_5';
  if (value <= 100_000n) return 'P5_10';
  return null;
}
function timeBin(startAt: string, decidedAt: string): string | null {
  const ms = Date.parse(startAt) - Date.parse(decidedAt);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const hour = 3_600_000;
  if (ms >= 24 * hour) return 'H24_PLUS';
  if (ms >= 6 * hour) return 'H6_24';
  if (ms >= hour) return 'H1_6';
  return 'H0_1';
}

function axisCells(axes: CapabilityAxesV1, extra: readonly CellKey[]): CellKey[] {
  const cells: CellKey[] = [{ cellId: 'OVERALL', axis: 'OVERALL', bin: 'ALL' }];
  const sport = axes.sportId !== null && (SPORTS as readonly string[]).includes(axes.sportId) ? axes.sportId : null;
  const family = axes.marketFamily !== null && (FAMILIES as readonly string[]).includes(axes.marketFamily) ? axes.marketFamily : null;
  if (sport) cells.push({ cellId: `SPORT:${sport}`, axis: 'SPORT', bin: sport });
  if (family) cells.push({ cellId: `MARKET_TYPE:${family}`, axis: 'MARKET_TYPE', bin: family });
  if (axes.period !== null) {
    const bin = axes.period === 'FULL_GAME' ? 'FULL' : 'PART';
    cells.push({ cellId: `PERIOD:${bin}`, axis: 'PERIOD', bin });
  }
  if (axes.isMainLine !== null) {
    const bin = axes.isMainLine ? 'MAIN' : 'OTHER';
    cells.push({ cellId: `MAIN_LINE:${bin}`, axis: 'MAIN_LINE', bin });
  }
  cells.push(...extra);
  if (sport && family) cells.push({ cellId: `SPORT_X_TYPE:${sport}|${family}`, axis: 'SPORT_X_TYPE', bin: `${sport}|${family}` });
  if (axes.competitionId !== null) cells.push({ cellId: `LEAGUE:${axes.competitionId}`, axis: 'LEAGUE', bin: axes.competitionId });
  return cells;
}

function gridCells(timeAxis: 'TIME' | 'CHECKPOINT'): CellKey[] {
  const cells: CellKey[] = [{ cellId: 'OVERALL', axis: 'OVERALL', bin: 'ALL' }];
  for (const sport of SPORTS) cells.push({ cellId: `SPORT:${sport}`, axis: 'SPORT', bin: sport });
  for (const family of FAMILIES) cells.push({ cellId: `MARKET_TYPE:${family}`, axis: 'MARKET_TYPE', bin: family });
  for (const bin of ['FULL', 'PART']) cells.push({ cellId: `PERIOD:${bin}`, axis: 'PERIOD', bin });
  for (const bin of ['MAIN', 'OTHER']) cells.push({ cellId: `MAIN_LINE:${bin}`, axis: 'MAIN_LINE', bin });
  const times = timeAxis === 'TIME' ? ['H24_PLUS', 'H6_24', 'H1_6', 'H0_1'] : ['PUBLICATION', 'T_MINUS_6H'];
  for (const bin of times) cells.push({ cellId: `${timeAxis}:${bin}`, axis: timeAxis, bin });
  for (const bin of ['P00_20', 'P20_40', 'P40_60', 'P60_80', 'P80_100']) cells.push({ cellId: `PRICE:${bin}`, axis: 'PRICE', bin });
  for (const bin of ['LE_2', 'P2_5', 'P5_10']) cells.push({ cellId: `SPREAD:${bin}`, axis: 'SPREAD', bin });
  for (const sport of SPORTS) {
    for (const family of FAMILIES) cells.push({ cellId: `SPORT_X_TYPE:${sport}|${family}`, axis: 'SPORT_X_TYPE', bin: `${sport}|${family}` });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// The Week projection

export interface CapabilityTradingCellStatsV1 {
  readonly axis: string;
  readonly bin: string;
  readonly values: CapabilityClusterStatsV1;
  readonly won: number;
  readonly sumCloseMicros: string;
  readonly sumWeight: string;
  readonly sumWeightedValue: string;
}
export interface CapabilityForecastCellStatsV1 {
  readonly axis: string;
  readonly bin: string;
  readonly values: CapabilityClusterStatsV1;
  readonly forecasts: number;
  readonly brierN: number;
  readonly sumBrier: string;
  readonly sumCopierBrier: string;
}
export interface CapabilityLiveCellStatsV1 {
  readonly actions: number;
  readonly events: number;
}
export interface CapabilityOperationsStatsV1 {
  readonly tasks: number;
  readonly eligible: number;
  readonly pending: number;
  readonly voided: number;
  readonly closeUnavailable: number;
  readonly forecasts: number;
  readonly abstentions: Readonly<Record<string, number>>;
  readonly notRun: number;
  readonly failed: number;
  readonly timedOut: number;
  readonly late: number;
  readonly latencyBuckets: readonly number[];
  readonly costMeasured: number;
  readonly costMicroUsd: string;
}
export interface CapabilityAccountingStatsV1 {
  readonly picks: number;
  readonly closingValue: string;
  readonly resultRelative: string;
  readonly fees: string;
  readonly entryCredits: string;
  readonly boughtShares: string;
  readonly exitCredits: string;
  readonly soldShares: string;
}

export interface AeonCapabilityWeekV1 {
  readonly contractVersion: typeof AEON_CAPABILITY_GRAPH_V1;
  readonly rulesDigest: DataPlaneDigest;
  readonly nodeId: string;
  readonly kind: CapabilityNodeKindV1;
  readonly weekId: string;
  readonly trading: Readonly<Record<string, CapabilityTradingCellStatsV1>>;
  readonly forecasts: Readonly<Record<string, CapabilityForecastCellStatsV1>>;
  readonly live: Readonly<Record<string, CapabilityLiveCellStatsV1>>;
  readonly accounting: CapabilityAccountingStatsV1;
  readonly operations: CapabilityOperationsStatsV1;
  readonly trials: Readonly<Record<string, { readonly meta: CapabilityTrialMetaV1; readonly stats: CapabilityClusterStatsV1 }>>;
  /** Every event this Week's trading and forecasting cells hold: a game belongs to one Week only. */
  readonly eventIds: readonly string[];
  readonly weekDigest: DataPlaneDigest;
}

export function capabilityNodeIdV1(node: CapabilityNodeRefV1): string {
  const kinds: readonly string[] = ['COPIER', 'COUNTERPART', 'AI_SEAT', 'USER_SYSTEM', 'HUMAN'];
  if (!kinds.includes(node.kind) || typeof node.id !== 'string' || node.id.length === 0 || node.id.includes('@')
    || typeof node.version !== 'string' || node.version.length === 0) fail('AEON_CAPABILITY_GRAPH_NODE_INVALID');
  return `${node.kind}:${node.id}@${node.version}`;
}

function sortedRecord<T>(entries: Iterable<[string, T]>): Record<string, T> {
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function aeonCapabilityWeekV1(input: {
  readonly node: CapabilityNodeRefV1;
  readonly weekId: string;
  readonly trading: readonly CapabilityTradingPickV1[];
  readonly live: readonly CapabilityLiveActionV1[];
  readonly forecasts: readonly CapabilityForecastRowV1[];
  readonly trials: readonly { readonly meta: CapabilityTrialMetaV1; readonly pairs: readonly CapabilityTrialPairV1[] }[];
}): AeonCapabilityWeekV1 {
  const nodeId = capabilityNodeIdV1(input.node);
  if (typeof input.weekId !== 'string' || input.weekId.length === 0) fail('AEON_CAPABILITY_GRAPH_WEEK_INVALID');
  if (input.node.kind === 'HUMAN' && input.forecasts.length > 0) fail('AEON_CAPABILITY_GRAPH_HUMAN_HAS_NO_FORECASTS');

  // Competition/accounting.
  const trading = new Map<string, { key: CellKey; clusters: Clusters; won: number; close: bigint; w: bigint; wv: bigint }>();
  let closingValue = 0n;
  let resultRelative = 0n;
  let fees = 0n;
  let entryCredits = 0n;
  let bought = 0n;
  let sold = 0n;
  for (const pick of input.trading) {
    const b = micros(pick.boughtShares);
    const s = micros(pick.soldShares);
    const shares = b + s;
    if (b < 0n || s < 0n || shares === 0n) fail('AEON_CAPABILITY_GRAPH_SHARES_INVALID');
    const cv = micros(pick.closingValueCredits);
    const copier = micros(pick.copierLineCredits);
    const close = probability(pick.closeForSide);
    const value = divideRounded(100n * (cv - copier) * MICRO, shares);
    const entry = pick.averageBuyPrice === null ? 0n : divideRounded(b * (close - probability(pick.averageBuyPrice)), MICRO);
    closingValue += cv;
    resultRelative += micros(pick.resultRelativeCredits);
    fees += micros(pick.feesCredits);
    entryCredits += entry;
    bought += b;
    sold += s;
    const extra: CellKey[] = [];
    const time = timeBin(pick.startAt, pick.decidedAt);
    if (time) extra.push({ cellId: `TIME:${time}`, axis: 'TIME', bin: time });
    if (pick.averageBuyPrice !== null) {
      const bin = priceBin(probability(pick.averageBuyPrice));
      extra.push({ cellId: `PRICE:${bin}`, axis: 'PRICE', bin });
    }
    const spread = pick.closeSpread === null ? null : spreadBin(probability(pick.closeSpread));
    if (spread) extra.push({ cellId: `SPREAD:${spread}`, axis: 'SPREAD', bin: spread });
    for (const key of axisCells(pick.axes, extra)) {
      const cell = trading.get(key.cellId) ?? { key, clusters: new Clusters(), won: 0, close: 0n, w: 0n, wv: 0n };
      cell.clusters.add(pick.eventId, value);
      if (pick.result === '1') cell.won += 1;
      cell.close += close;
      cell.w += shares;
      cell.wv += shares * value;
      trading.set(key.cellId, cell);
    }
  }

  // Live Pressure: counts only.
  const live = new Map<string, { actions: number; events: Set<string> }>();
  for (const action of input.live) {
    for (const key of axisCells(action.axes, []).filter((cell) => cell.axis === 'OVERALL' || cell.axis === 'SPORT')) {
      const cell = live.get(key.cellId) ?? { actions: 0, events: new Set<string>() };
      cell.actions += 1;
      cell.events.add(action.eventId);
      live.set(key.cellId, cell);
    }
  }

  // Forecast quality and operations.
  const forecasts = new Map<string, { key: CellKey; clusters: Clusters; forecasts: number; brierN: number; brier: bigint; copierBrier: bigint }>();
  const abstentions = new Map<string, number>();
  const ops = { tasks: 0, eligible: 0, pending: 0, voided: 0, closeUnavailable: 0, forecasts: 0, notRun: 0, failed: 0, timedOut: 0, late: 0 };
  const latency = LATENCY_BUCKETS.map(() => 0);
  let costMeasured = 0;
  let cost = 0n;
  for (const row of input.forecasts) {
    if (typeof row.eventStartAt !== 'string' || !Number.isFinite(Date.parse(row.eventStartAt))) fail('AEON_CAPABILITY_GRAPH_EVENT_START_INVALID');
    ops.tasks += 1;
    switch (row.disposition) {
      case 'FORECAST': ops.forecasts += 1; break;
      case 'ABSTAIN': abstentions.set(row.abstainCode ?? 'UNSPECIFIED', (abstentions.get(row.abstainCode ?? 'UNSPECIFIED') ?? 0) + 1); break;
      case 'NOT_RUN': ops.notRun += 1; break;
      case 'FAILED': ops.failed += 1; break;
      case 'TIMED_OUT': ops.timedOut += 1; break;
      case 'LATE': ops.late += 1; break;
      default: fail('AEON_CAPABILITY_GRAPH_DISPOSITION_INVALID');
    }
    if (row.disposition === 'FORECAST' && (row.forecastYes === null || row.marketYes === null)) fail('AEON_CAPABILITY_GRAPH_FORECAST_WITHOUT_MARKET');
    if (row.latencyMs !== null) {
      if (!Number.isFinite(row.latencyMs) || row.latencyMs < 0) fail('AEON_CAPABILITY_GRAPH_LATENCY_INVALID');
      latency[LATENCY_BUCKETS.findIndex(([, bound]) => row.latencyMs! <= bound)]! += 1;
    }
    if (row.costMicroUsd !== null) {
      if (typeof row.costMicroUsd !== 'string' || !/^(?:0|[1-9]\d{0,17})$/u.test(row.costMicroUsd)) fail('AEON_CAPABILITY_GRAPH_COST_INVALID');
      costMeasured += 1;
      cost += BigInt(row.costMicroUsd);
    }
    if (row.outcome === null) {
      ops.pending += 1;
      continue;
    }
    if (row.outcome.listingId !== row.listingId) fail('AEON_CAPABILITY_GRAPH_OUTCOME_MISMATCH');
    if (row.outcome.state === 'VOIDED' || row.outcome.winningOutcome === null) {
      ops.voided += 1;
      continue;
    }
    const c = row.closeYes === null ? null : probability(row.closeYes);
    if (c === null || c <= 0n || c >= MICRO) {
      ops.closeUnavailable += 1;
      continue;
    }
    ops.eligible += 1;
    const isForecast = row.disposition === 'FORECAST';
    const m = row.marketYes === null ? null : probability(row.marketYes);
    const p = row.forecastYes === null ? null : probability(row.forecastYes);
    // A task with no forecast (abstention, failure, lateness) scores the copier line, 0.
    const d = isForecast && m !== null && p !== null && m > 0n && m < MICRO && p > 0n && p < MICRO
      ? gradeTenThousandths(p, c) - gradeTenThousandths(m, c) : 0n;
    const y = row.outcome.winningOutcome === 'YES' ? MICRO : 0n;
    const extra: CellKey[] = [{ cellId: `CHECKPOINT:${row.checkpoint}`, axis: 'CHECKPOINT', bin: row.checkpoint }];
    if (m !== null) {
      const bin = priceBin(m);
      extra.push({ cellId: `PRICE:${bin}`, axis: 'PRICE', bin });
    }
    const spread = row.closeSpread === null ? null : spreadBin(probability(row.closeSpread));
    if (spread) extra.push({ cellId: `SPREAD:${spread}`, axis: 'SPREAD', bin: spread });
    for (const key of axisCells(row.axes, extra)) {
      const cell = forecasts.get(key.cellId) ?? { key, clusters: new Clusters(), forecasts: 0, brierN: 0, brier: 0n, copierBrier: 0n };
      cell.clusters.add(row.eventId, d);
      if (isForecast) {
        cell.forecasts += 1;
        if (p !== null && m !== null) {
          cell.brierN += 1;
          cell.brier += (p - y) * (p - y);
          cell.copierBrier += (m - y) * (m - y);
        }
      }
      forecasts.set(key.cellId, cell);
    }
  }

  // Contribution: paired trial differences.
  const trials = new Map<string, { meta: CapabilityTrialMetaV1; stats: CapabilityClusterStatsV1 }>();
  for (const trial of input.trials) {
    const clusters = new Clusters();
    for (const pair of trial.pairs) {
      if (pair.trialId !== trial.meta.trialId) fail('AEON_CAPABILITY_GRAPH_TRIAL_MISMATCH');
      clusters.add(pair.eventId, micros(pair.difference));
    }
    if (trials.has(trial.meta.trialId)) fail('AEON_CAPABILITY_GRAPH_TRIAL_DUPLICATE');
    trials.set(trial.meta.trialId, { meta: { ...trial.meta }, stats: clusters.stats() });
  }

  const body = {
    contractVersion: AEON_CAPABILITY_GRAPH_V1,
    rulesDigest: AEON_CAPABILITY_GRAPH_V1_RULES_DIGEST,
    nodeId,
    kind: input.node.kind,
    weekId: input.weekId,
    trading: sortedRecord([...trading].map(([id, cell]) => [id, {
      axis: cell.key.axis, bin: cell.key.bin, values: cell.clusters.stats(), won: cell.won, sumCloseMicros: cell.close.toString(),
      sumWeight: cell.w.toString(), sumWeightedValue: cell.wv.toString(),
    }])),
    forecasts: sortedRecord([...forecasts].map(([id, cell]) => [id, {
      axis: cell.key.axis, bin: cell.key.bin, values: cell.clusters.stats(), forecasts: cell.forecasts, brierN: cell.brierN,
      sumBrier: cell.brier.toString(), sumCopierBrier: cell.copierBrier.toString(),
    }])),
    live: sortedRecord([...live].map(([id, cell]) => [id, { actions: cell.actions, events: cell.events.size }])),
    accounting: {
      picks: input.trading.length,
      closingValue: closingValue.toString(),
      resultRelative: resultRelative.toString(),
      fees: fees.toString(),
      entryCredits: entryCredits.toString(),
      boughtShares: bought.toString(),
      exitCredits: (closingValue - entryCredits).toString(),
      soldShares: sold.toString(),
    },
    operations: { ...ops, abstentions: sortedRecord(abstentions), latencyBuckets: latency, costMeasured, costMicroUsd: cost.toString() },
    trials: sortedRecord(trials),
    eventIds: Object.freeze([...new Set([...input.trading.map((pick) => pick.eventId), ...input.forecasts.map((row) => row.eventId)])].sort()),
  };
  return Object.freeze({ ...body, weekDigest: dataPlaneDigest(body) });
}

// ---------------------------------------------------------------------------
// The node view

export type CapabilityLabelV1 =
  | 'NOT_MEASURABLE'
  | 'NOT_YET_EVALUATED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'DESCRIPTIVE'
  | 'WITHIN_COPIER_RANGE'
  | 'ABOVE_COPIER_LINE'
  | 'BELOW_COPIER_LINE';

export interface CapabilityTradingCellV1 {
  readonly cellId: string;
  readonly axis: string;
  readonly bin: string;
  readonly primary: boolean;
  readonly label: CapabilityLabelV1;
  readonly picks: number;
  readonly events: number;
  readonly won: number;
  /** Points per share above the copier line. */
  readonly estimate: string | null;
  readonly interval95: readonly [string, string] | null;
  readonly adjustedInterval: readonly [string, string] | null;
  readonly copierLine: '0' | null;
  readonly progress: { readonly picksNeeded: number; readonly eventsNeeded: number } | null;
  readonly receipt: { readonly picks: number; readonly won: number; readonly closeExpectedWins: string | null; readonly coinFlipAtLeastPercent: string | null };
}
export interface CapabilityForecastCellV1 {
  readonly cellId: string;
  readonly axis: string;
  readonly bin: string;
  readonly primary: boolean;
  readonly label: CapabilityLabelV1;
  readonly eligible: number;
  readonly forecasts: number;
  readonly coverage: string | null;
  readonly events: number;
  /** Log points above the copier line (a task with no forecast scores 0). */
  readonly estimate: string | null;
  readonly interval95: readonly [string, string] | null;
  readonly adjustedInterval: readonly [string, string] | null;
  readonly brier: string | null;
  readonly copierBrier: string | null;
  readonly progress: { readonly listingsNeeded: number; readonly eventsNeeded: number } | null;
}
export interface CapabilityLiveCellV1 {
  readonly cellId: string;
  readonly label: 'NOT_MEASURABLE';
  readonly actions: number;
  readonly events: number;
}
export interface CapabilityTrialResultV1 extends CapabilityTrialMetaV1 {
  readonly label: 'TRIAL_RUNNING' | 'NOT_YET_EVALUATED' | 'INSUFFICIENT_EVIDENCE' | 'CHALLENGER_BETTER' | 'CHAMPION_BETTER' | 'NOT_DISTINGUISHABLE';
  readonly tasks: number;
  readonly events: number;
  readonly estimate: string | null;
  readonly interval95: readonly [string, string] | null;
  readonly progress: { readonly tasksNeeded: number; readonly eventsNeeded: number } | null;
  /** True only for a prospective trial: a replay's finding is never shown as a claim. */
  readonly claimable: boolean;
}

export interface AeonCapabilityNodeV1 {
  readonly contractVersion: typeof AEON_CAPABILITY_GRAPH_V1;
  readonly rulesDigest: DataPlaneDigest;
  readonly nodeId: string;
  readonly kind: CapabilityNodeKindV1;
  readonly weeksIncluded: readonly string[];
  readonly adjustment: { readonly method: 'BONFERRONI_TWO_SIDED'; readonly primaryFamily: readonly string[]; readonly K: number; readonly looks: number; readonly z: string };
  readonly minimums: typeof AEON_CAPABILITY_GRAPH_V1_RULES.minimums;
  /** Null for a HUMAN: a person never states a probability, and none is inferred. */
  readonly forecastQuality: { readonly cells: readonly CapabilityForecastCellV1[] } | null;
  readonly competition: {
    readonly cells: readonly CapabilityTradingCellV1[];
    readonly live: readonly CapabilityLiveCellV1[];
    readonly accounting: { readonly picks: number; readonly closingValueCredits: string; readonly resultRelativeToCloseCredits: string;
      readonly feesCredits: string; readonly netCredits: string };
    readonly decomposition: { readonly entryPointsPerShare: string | null; readonly exitPointsPerShare: string | null; readonly sizeEffectPoints: string | null };
  };
  readonly contribution: { readonly trials: readonly CapabilityTrialResultV1[] };
  readonly operations: {
    readonly tasks: number; readonly eligible: number; readonly pending: number; readonly voided: number; readonly closeUnavailable: number;
    readonly forecasts: number; readonly abstentions: Readonly<Record<string, number>>;
    readonly notRun: number; readonly failed: number; readonly timedOut: number; readonly late: number;
    readonly latency: { readonly measured: number; readonly p50: string | null; readonly p95: string | null };
    readonly cost: { readonly measured: number; readonly microUsd: string } | null;
  };
  /** Links to pre-registered tests and their verdicts; the graph originates none. */
  readonly claims: readonly string[];
  readonly graphDigest: DataPlaneDigest;
}

function interval(mean: number, se: number, z: number): readonly [string, string] {
  return Object.freeze([fixed4(mean - z * se), fixed4(mean + z * se)] as const);
}
function direction(mean: number, se: number, z: number): CapabilityLabelV1 {
  if (mean - z * se > 0) return 'ABOVE_COPIER_LINE';
  if (mean + z * se < 0) return 'BELOW_COPIER_LINE';
  return 'WITHIN_COPIER_RANGE';
}

function sumWeeks<T>(weeks: readonly AeonCapabilityWeekV1[], pick: (week: AeonCapabilityWeekV1) => Readonly<Record<string, T>>): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const week of weeks) {
    for (const [id, value] of Object.entries(pick(week))) out.set(id, [...(out.get(id) ?? []), value]);
  }
  return out;
}

export function aeonCapabilityGraphV1(input: {
  /** When the graph is read: a trial is labelled only from its stopping time. */
  readonly asOf: string;
  readonly node: CapabilityNodeRefV1;
  readonly weeks: readonly AeonCapabilityWeekV1[];
  /** The Season's weekly looks (its number of Weeks). */
  readonly looks: number;
}): AeonCapabilityNodeV1 {
  const nodeId = capabilityNodeIdV1(input.node);
  const seen = new Set<string>();
  for (const week of input.weeks) {
    if (week.contractVersion !== AEON_CAPABILITY_GRAPH_V1 || week.rulesDigest !== AEON_CAPABILITY_GRAPH_V1_RULES_DIGEST) fail('AEON_CAPABILITY_GRAPH_WEEK_RULES_MISMATCH');
    if (week.nodeId !== nodeId) fail('AEON_CAPABILITY_GRAPH_NODE_MISMATCH');
    if (seen.has(week.weekId)) fail('AEON_CAPABILITY_GRAPH_WEEK_DUPLICATE');
    seen.add(week.weekId);
  }
  const asOfMs = Date.parse(input.asOf);
  if (!Number.isFinite(asOfMs)) fail('AEON_CAPABILITY_GRAPH_CLOCK_INVALID');
  const weekOfEvent = new Map<string, string>();
  for (const week of input.weeks) {
    for (const eventId of week.eventIds) {
      const prior = weekOfEvent.get(eventId);
      if (prior !== undefined && prior !== week.weekId) fail('AEON_CAPABILITY_GRAPH_EVENT_IN_TWO_WEEKS');
      weekOfEvent.set(eventId, week.weekId);
    }
  }
  const weeks = [...input.weeks].sort((a, b) => (a.weekId < b.weekId ? -1 : a.weekId > b.weekId ? 1 : 0));
  const K = AEON_CAPABILITY_GRAPH_V1_RULES.primaryK;
  const z = capabilityZV1(K, input.looks);
  const minTrading = AEON_CAPABILITY_GRAPH_V1_RULES.minimums.trading;
  const minForecast = AEON_CAPABILITY_GRAPH_V1_RULES.minimums.forecasting;
  const minTrial = AEON_CAPABILITY_GRAPH_V1_RULES.minimums.trial;

  // Competition cells.
  const tradingStats = sumWeeks(weeks, (week) => week.trading);
  const leagueIds = [...tradingStats.keys()].filter((id) => id.startsWith('LEAGUE:')).sort();
  const tradingKeys = [...gridCells('TIME'), ...leagueIds.map((id) => ({ cellId: id, axis: 'LEAGUE', bin: id.slice('LEAGUE:'.length) }))];
  const tradingCells = tradingKeys.map((key): CapabilityTradingCellV1 => {
    const parts = tradingStats.get(key.cellId) ?? [];
    const values = parts.reduce<CapabilityClusterStatsV1 | undefined>((acc, part) => addClusters(acc, part.values), undefined);
    const n = values?.n ?? 0;
    const events = values?.events ?? 0;
    const won = parts.reduce((acc, part) => acc + part.won, 0);
    const primary = isPrimary(key.axis);
    const base = { cellId: key.cellId, axis: key.axis, bin: key.bin, primary, picks: n, events, won };
    if (!values || n < minTrading.picks || events < minTrading.events) {
      return Object.freeze({
        ...base,
        label: n === 0 ? 'NOT_YET_EVALUATED' as const : 'INSUFFICIENT_EVIDENCE' as const,
        estimate: null, interval95: null, adjustedInterval: null, copierLine: null,
        progress: Object.freeze({ picksNeeded: Math.max(0, minTrading.picks - n), eventsNeeded: Math.max(0, minTrading.events - events) }),
        receipt: Object.freeze({ picks: n, won, closeExpectedWins: null, coinFlipAtLeastPercent: null }),
      });
    }
    const { mean, se } = meanAndSe(values);
    const meanPoints = mean / 1e6;
    const sePoints = se / 1e6;
    const sumClose = parts.reduce((acc, part) => acc + BigInt(part.sumCloseMicros), 0n);
    const coin = copierLuckReceiptV1(Array.from({ length: n }, (_, i) => ({ result: i < won ? '1' as const : '0' as const, closeForSide: '0' })));
    return Object.freeze({
      ...base,
      label: primary ? direction(meanPoints, sePoints, z) : 'DESCRIPTIVE' as const,
      estimate: formatMicrosSigned(divideRounded(BigInt(values.sumS), BigInt(n))),
      interval95: interval(meanPoints, sePoints, Z95),
      adjustedInterval: primary ? interval(meanPoints, sePoints, z) : null,
      copierLine: '0' as const,
      progress: null,
      receipt: Object.freeze({ picks: n, won, closeExpectedWins: formatMicrosSigned(sumClose), coinFlipAtLeastPercent: coin.coinFlipAtLeastPercent }),
    });
  });

  // Live Pressure.
  const liveStats = sumWeeks(weeks, (week) => week.live);
  const liveCells = ['OVERALL', ...SPORTS.map((sport) => `SPORT:${sport}`)].map((cellId): CapabilityLiveCellV1 => {
    const parts = liveStats.get(cellId) ?? [];
    return Object.freeze({ cellId, label: 'NOT_MEASURABLE' as const,
      actions: parts.reduce((acc, part) => acc + part.actions, 0), events: parts.reduce((acc, part) => acc + part.events, 0) });
  });

  // Accounting and decomposition (overall).
  const acc = weeks.reduce((sum, week) => ({
    picks: sum.picks + week.accounting.picks,
    closingValue: sum.closingValue + BigInt(week.accounting.closingValue),
    resultRelative: sum.resultRelative + BigInt(week.accounting.resultRelative),
    fees: sum.fees + BigInt(week.accounting.fees),
    entry: sum.entry + BigInt(week.accounting.entryCredits),
    bought: sum.bought + BigInt(week.accounting.boughtShares),
    exit: sum.exit + BigInt(week.accounting.exitCredits),
    sold: sum.sold + BigInt(week.accounting.soldShares),
  }), { picks: 0, closingValue: 0n, resultRelative: 0n, fees: 0n, entry: 0n, bought: 0n, exit: 0n, sold: 0n });
  const overallParts = tradingStats.get('OVERALL') ?? [];
  const overallValues = overallParts.reduce<CapabilityClusterStatsV1 | undefined>((a, part) => addClusters(a, part.values), undefined);
  const sumW = overallParts.reduce((a, part) => a + BigInt(part.sumWeight), 0n);
  const sumWV = overallParts.reduce((a, part) => a + BigInt(part.sumWeightedValue), 0n);
  const sizeEffect = overallValues && overallValues.n > 0 && sumW > 0n
    ? formatMicrosSigned(divideRounded(sumWV, sumW) - divideRounded(BigInt(overallValues.sumS), BigInt(overallValues.n)))
    : null;

  // Forecast quality.
  let forecastQuality: AeonCapabilityNodeV1['forecastQuality'] = null;
  if (input.node.kind !== 'HUMAN') {
    const forecastStats = sumWeeks(weeks, (week) => week.forecasts);
    const leagues = [...forecastStats.keys()].filter((id) => id.startsWith('LEAGUE:')).sort();
    const keys = [...gridCells('CHECKPOINT'), ...leagues.map((id) => ({ cellId: id, axis: 'LEAGUE', bin: id.slice('LEAGUE:'.length) }))];
    forecastQuality = Object.freeze({ cells: keys.map((key): CapabilityForecastCellV1 => {
      const parts = forecastStats.get(key.cellId) ?? [];
      const values = parts.reduce<CapabilityClusterStatsV1 | undefined>((a, part) => addClusters(a, part.values), undefined);
      const eligible = values?.n ?? 0;
      const events = values?.events ?? 0;
      const forecastCount = parts.reduce((a, part) => a + part.forecasts, 0);
      const primary = isPrimary(key.axis);
      const base = { cellId: key.cellId, axis: key.axis, bin: key.bin, primary, eligible, forecasts: forecastCount, events };
      if (!values || eligible < minForecast.listings || events < minForecast.events) {
        return Object.freeze({
          ...base, label: eligible === 0 ? 'NOT_YET_EVALUATED' as const : 'INSUFFICIENT_EVIDENCE' as const,
          coverage: null, estimate: null, interval95: null, adjustedInterval: null, brier: null, copierBrier: null,
          progress: Object.freeze({ listingsNeeded: Math.max(0, minForecast.listings - eligible), eventsNeeded: Math.max(0, minForecast.events - events) }),
        });
      }
      const { mean, se } = meanAndSe(values);
      const meanPoints = mean / 1e4;
      const sePoints = se / 1e4;
      const brierN = parts.reduce((a, part) => a + part.brierN, 0);
      const brier = parts.reduce((a, part) => a + BigInt(part.sumBrier), 0n);
      const copierBrier = parts.reduce((a, part) => a + BigInt(part.sumCopierBrier), 0n);
      return Object.freeze({
        ...base,
        label: primary ? direction(meanPoints, sePoints, z) : 'DESCRIPTIVE' as const,
        coverage: formatTenThousandths(divideRounded(BigInt(forecastCount) * 10_000n, BigInt(eligible))),
        estimate: formatTenThousandths(divideRounded(BigInt(values.sumS), BigInt(eligible))),
        interval95: interval(meanPoints, sePoints, Z95),
        adjustedInterval: primary ? interval(meanPoints, sePoints, z) : null,
        brier: brierN === 0 ? null : formatMicrosSigned(divideRounded(brier, BigInt(brierN) * MICRO)),
        copierBrier: brierN === 0 ? null : formatMicrosSigned(divideRounded(copierBrier, BigInt(brierN) * MICRO)),
        progress: null,
      });
    }) });
  }

  // Contribution.
  const trialStats = new Map<string, { meta: CapabilityTrialMetaV1; stats: CapabilityClusterStatsV1 }>();
  for (const week of weeks) {
    for (const [trialId, trial] of Object.entries(week.trials)) {
      const prior = trialStats.get(trialId);
      if (prior && dataPlaneDigest(prior.meta) !== dataPlaneDigest(trial.meta)) fail('AEON_CAPABILITY_GRAPH_TRIAL_META_MISMATCH');
      trialStats.set(trialId, { meta: trial.meta, stats: addClusters(prior?.stats, trial.stats) });
    }
  }
  const trials = [...trialStats.values()].sort((a, b) => (a.meta.trialId < b.meta.trialId ? -1 : 1)).map(({ meta, stats }): CapabilityTrialResultV1 => {
    if (meta.mode !== 'PROSPECTIVE' && meta.mode !== 'HISTORICAL_REPLAY') fail('AEON_CAPABILITY_GRAPH_TRIAL_MODE_INVALID');
    if (typeof meta.until !== 'string' || !Number.isFinite(Date.parse(meta.until))) fail('AEON_CAPABILITY_GRAPH_TRIAL_UNTIL_INVALID');
    const base = { ...meta, tasks: stats.n, events: stats.events, claimable: meta.mode === 'PROSPECTIVE' };
    // One look, at the stopping time: before it the trial shows its counts and no result.
    if (asOfMs < Date.parse(meta.until)) {
      return Object.freeze({ ...base, label: 'TRIAL_RUNNING' as const, estimate: null, interval95: null, progress: null });
    }
    if (stats.n < minTrial.tasks || stats.events < minTrial.events) {
      return Object.freeze({ ...base, label: stats.n === 0 ? 'NOT_YET_EVALUATED' as const : 'INSUFFICIENT_EVIDENCE' as const,
        estimate: null, interval95: null,
        progress: Object.freeze({ tasksNeeded: Math.max(0, minTrial.tasks - stats.n), eventsNeeded: Math.max(0, minTrial.events - stats.events) }) });
    }
    const { mean, se } = meanAndSe(stats);
    const m = mean / 1e6;
    const s = se / 1e6;
    return Object.freeze({
      ...base,
      label: m - Z95 * s > 0 ? 'CHALLENGER_BETTER' as const : m + Z95 * s < 0 ? 'CHAMPION_BETTER' as const : 'NOT_DISTINGUISHABLE' as const,
      estimate: formatMicrosSigned(divideRounded(BigInt(stats.sumS), BigInt(stats.n))),
      interval95: interval(m, s, Z95),
      progress: null,
    });
  });

  // Operations.
  const ops = weeks.reduce((sum, week) => {
    const o = week.operations;
    const abstentions = new Map(Object.entries(sum.abstentions));
    for (const [code, count] of Object.entries(o.abstentions)) abstentions.set(code, (abstentions.get(code) ?? 0) + count);
    return {
      tasks: sum.tasks + o.tasks, eligible: sum.eligible + o.eligible, pending: sum.pending + o.pending, voided: sum.voided + o.voided,
      closeUnavailable: sum.closeUnavailable + o.closeUnavailable, forecasts: sum.forecasts + o.forecasts,
      abstentions: sortedRecord(abstentions),
      notRun: sum.notRun + o.notRun, failed: sum.failed + o.failed, timedOut: sum.timedOut + o.timedOut, late: sum.late + o.late,
      latencyBuckets: sum.latencyBuckets.map((count, i) => count + (o.latencyBuckets[i] ?? 0)),
      costMeasured: sum.costMeasured + o.costMeasured, cost: sum.cost + BigInt(o.costMicroUsd),
    };
  }, { tasks: 0, eligible: 0, pending: 0, voided: 0, closeUnavailable: 0, forecasts: 0, abstentions: {} as Record<string, number>,
    notRun: 0, failed: 0, timedOut: 0, late: 0, latencyBuckets: LATENCY_BUCKETS.map(() => 0), costMeasured: 0, cost: 0n });
  const measured = ops.latencyBuckets.reduce((a, b) => a + b, 0);
  const quantile = (q: number): string | null => {
    if (measured === 0) return null;
    const rank = Math.ceil(q * measured);
    let cumulative = 0;
    for (let i = 0; i < LATENCY_BUCKETS.length; i += 1) {
      cumulative += ops.latencyBuckets[i]!;
      if (cumulative >= rank) return LATENCY_BUCKETS[i]![0];
    }
    return null;
  };

  const body = {
    contractVersion: AEON_CAPABILITY_GRAPH_V1,
    rulesDigest: AEON_CAPABILITY_GRAPH_V1_RULES_DIGEST,
    nodeId,
    kind: input.node.kind,
    weeksIncluded: Object.freeze(weeks.map((week) => week.weekId)),
    adjustment: Object.freeze({ method: 'BONFERRONI_TWO_SIDED' as const, primaryFamily: AEON_CAPABILITY_GRAPH_V1_RULES.primaryFamily,
      K, looks: input.looks, z: z.toFixed(4) }),
    minimums: AEON_CAPABILITY_GRAPH_V1_RULES.minimums,
    forecastQuality,
    competition: Object.freeze({
      cells: Object.freeze(tradingCells),
      live: Object.freeze(liveCells),
      accounting: Object.freeze({
        picks: acc.picks,
        closingValueCredits: formatMicrosSigned(acc.closingValue),
        resultRelativeToCloseCredits: formatMicrosSigned(acc.resultRelative),
        feesCredits: formatMicrosSigned(acc.fees),
        netCredits: formatMicrosSigned(acc.closingValue + acc.resultRelative - acc.fees),
      }),
      decomposition: Object.freeze({
        entryPointsPerShare: acc.bought === 0n ? null : formatMicrosSigned(divideRounded(100n * acc.entry * MICRO, acc.bought)),
        exitPointsPerShare: acc.sold === 0n ? null : formatMicrosSigned(divideRounded(100n * acc.exit * MICRO, acc.sold)),
        sizeEffectPoints: sizeEffect,
      }),
    }),
    contribution: Object.freeze({ trials: Object.freeze(trials) }),
    operations: Object.freeze({
      tasks: ops.tasks, eligible: ops.eligible, pending: ops.pending, voided: ops.voided, closeUnavailable: ops.closeUnavailable,
      forecasts: ops.forecasts, abstentions: Object.freeze(ops.abstentions),
      notRun: ops.notRun, failed: ops.failed, timedOut: ops.timedOut, late: ops.late,
      latency: Object.freeze({ measured, p50: quantile(0.5), p95: quantile(0.95) }),
      cost: ops.costMeasured === 0 ? null : Object.freeze({ measured: ops.costMeasured, microUsd: ops.cost.toString() }),
    }),
    claims: Object.freeze([] as string[]),
  };
  return Object.freeze({ ...body, graphDigest: dataPlaneDigest(body) });
}

// ---------------------------------------------------------------------------
// Tables

export interface CapabilityTableRowV1 {
  readonly nodeId: string;
  readonly kind: CapabilityNodeKindV1;
  readonly label: CapabilityLabelV1 | 'REFERENCE';
  readonly rank: number | null;
  readonly estimate: string | null;
  readonly interval95: readonly [string, string] | null;
  readonly events: number;
}

/**
 * A table of nodes on one dimension's overall cell: the copier row first, labels by
 * Benjamini–Hochberg at 5% across the ranked nodes, and ranks only for labelled nodes.
 */
export function aeonCapabilityTableV1(input: {
  readonly tableId: string;
  readonly dimension: 'COMPETITION' | 'FORECAST_QUALITY';
  readonly nodes: readonly AeonCapabilityNodeV1[];
}): { readonly tableId: string; readonly dimension: string; readonly rows: readonly CapabilityTableRowV1[]; readonly tableDigest: DataPlaneDigest } {
  const overall = (node: AeonCapabilityNodeV1) => {
    const cells: readonly (CapabilityTradingCellV1 | CapabilityForecastCellV1)[] | undefined = input.dimension === 'COMPETITION'
      ? node.competition.cells : node.forecastQuality?.cells;
    return cells?.find((cell) => cell.cellId === 'OVERALL') ?? null;
  };
  const candidates = input.nodes.filter((node) => node.kind !== 'COPIER').map((node) => {
    const cell = overall(node);
    const measured = cell !== null && cell.estimate !== null && cell.interval95 !== null;
    let mean = 0;
    let se = 0;
    if (measured) {
      const [lo, hi] = cell.interval95!.map(Number) as [number, number];
      mean = (lo + hi) / 2;
      se = (hi - lo) / (2 * Z95);
    }
    return { node, cell, measured, mean, se };
  }).sort((a, b) => (a.node.nodeId < b.node.nodeId ? -1 : 1));
  const ranked = candidates.filter((entry) => entry.measured);
  const pValues = ranked.map((entry) => (entry.se === 0 ? (entry.mean === 0 ? 1 : 0) : 2 * (1 - capabilityNormalCdfV1(Math.abs(entry.mean / entry.se)))));
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p || a.i - b.i);
  let rejectedCount = 0;
  order.forEach(({ p }, position) => {
    if (p <= ((position + 1) / order.length) * Number(AEON_CAPABILITY_GRAPH_V1_RULES.tableFalseDiscoveryRate)) rejectedCount = position + 1;
  });
  const rejected = new Set(order.slice(0, rejectedCount).map(({ i }) => i));
  const shrunk = ranked.length >= AEON_CAPABILITY_GRAPH_V1_RULES.tableShrinkMinNodes
    ? capabilityShrinkV1(ranked.map((entry) => entry.mean), ranked.map((entry) => entry.se))
    : ranked.map((entry) => entry.mean);
  // A row carries a direction only when the node's own (Bonferroni K×L) label has one and
  // Benjamini–Hochberg across the table also rejects: the table can withhold a direction,
  // never add one, so it never contradicts the node's own page.
  const nodeDirection = (entry: typeof ranked[number]) => entry.cell!.label === 'ABOVE_COPIER_LINE' || entry.cell!.label === 'BELOW_COPIER_LINE';
  const labelled = ranked.map((entry, i) => ({ entry, i, score: shrunk[i]! })).filter(({ i, entry }) => rejected.has(i) && nodeDirection(entry))
    .sort((a, b) => b.score - a.score || b.entry.mean - a.entry.mean || (a.entry.node.nodeId < b.entry.node.nodeId ? -1 : 1));
  const labelledIndexes = new Set(labelled.map(({ i }) => i));
  const row = (entry: typeof candidates[number], label: CapabilityTableRowV1['label'], rank: number | null): CapabilityTableRowV1 => Object.freeze({
    nodeId: entry.node.nodeId, kind: entry.node.kind, label, rank,
    estimate: entry.measured ? entry.cell!.estimate : null, interval95: entry.measured ? entry.cell!.interval95 : null,
    events: entry.cell?.events ?? 0,
  });
  const rows: CapabilityTableRowV1[] = [Object.freeze({
    nodeId: `COPIER:polymarket-mid@${COPIER_LINE_V1_RULES_DIGEST}`, kind: 'COPIER' as const, label: 'REFERENCE' as const,
    rank: null, estimate: '0', interval95: null, events: 0,
  })];
  labelled.forEach(({ entry }, position) => rows.push(row(entry, entry.cell!.label as CapabilityLabelV1, position + 1)));
  ranked.forEach((entry, i) => { if (!labelledIndexes.has(i)) rows.push(row(entry, 'WITHIN_COPIER_RANGE', null)); });
  candidates.filter((entry) => !entry.measured).forEach((entry) => rows.push(row(entry, entry.cell?.label === 'NOT_YET_EVALUATED' || entry.cell === null
    ? 'NOT_YET_EVALUATED' : 'INSUFFICIENT_EVIDENCE', null)));
  const body = { tableId: input.tableId, dimension: input.dimension, rows: Object.freeze(rows) };
  return Object.freeze({ ...body, tableDigest: dataPlaneDigest(body) });
}

// ---------------------------------------------------------------------------
// Adapters from the app's own records

function canonical(value: string): string {
  return formatMicrosSigned(probability(value));
}
const NO_AXES: CapabilityAxesV1 = Object.freeze({ sportId: null, competitionId: null, marketFamily: null, period: null, isMainLine: null });

/**
 * A Week of the Season record, joined to the price blocks it was built from (keyed
 * `bookId|listingId|side`) and to the catalog's axes: graded picks become trading
 * picks, trades after the start become live actions, and everything else is left to
 * the Season record's own counts.
 */
export function capabilityTradingFromSeasonWeekV1(input: {
  readonly week: AeonSeasonRecordWeekV1;
  readonly blocks: ReadonlyMap<string, AeonPriceBlockV1>;
  readonly axes: ReadonlyMap<string, CapabilityAxesV1>;
}): { readonly trading: readonly CapabilityTradingPickV1[]; readonly live: readonly CapabilityLiveActionV1[] } {
  const trading: CapabilityTradingPickV1[] = [];
  const live: CapabilityLiveActionV1[] = [];
  for (const pick of input.week.picks) {
    if (pick.status !== 'GRADED' && pick.status !== 'TRADED_AFTER_START') continue;
    const axes = input.axes.get(pick.listingId) ?? NO_AXES;
    if (pick.status === 'TRADED_AFTER_START') {
      live.push(Object.freeze({ eventId: pick.eventId, listingId: pick.listingId, axes }));
      // Its pregame part, when it has one, is a trading pick like any other (research review, Oct 4 2026).
      const mixed = pick.pregamePart ? input.blocks.get(`${pick.bookId}|${pick.listingId}|${pick.side}`) : undefined;
      const part = mixed?.pregame;
      if (!pick.pregamePart) continue;
      if (!mixed || !part || mixed.listingId !== pick.listingId || mixed.side !== pick.side) fail('AEON_CAPABILITY_GRAPH_BLOCK_MISSING');
      const shown = mixed.close.source === 'POLYMARKET_DISPLAYED_PRICE' && mixed.close.spread === null;
      const copier = pick.copierLineCredits ?? (shown ? '0' : null);
      if (mixed.close.startAt === null || mixed.close.price === null || pick.result === null || pick.closingValueCredits === null
        || copier === null || pick.luckCredits === null || part.actions.length === 0) fail('AEON_CAPABILITY_GRAPH_GRADED_PICK_INCOMPLETE');
      trading.push(Object.freeze({
        eventId: pick.eventId, listingId: pick.listingId, side: pick.side, axes, startAt: mixed.close.startAt,
        decidedAt: part.actions.map((action) => action.occurredAt).sort().at(-1)!,
        boughtShares: part.boughtShares, soldShares: part.soldShares, averageBuyPrice: part.averageBuyPrice,
        closeForSide: mixed.close.price, closeSpread: mixed.close.spread,
        closingValueCredits: pick.closingValueCredits, copierLineCredits: copier,
        resultRelativeCredits: pick.luckCredits, feesCredits: pick.feesCredits, result: pick.result,
      }));
      continue;
    }
    const block = input.blocks.get(`${pick.bookId}|${pick.listingId}|${pick.side}`);
    if (!block || block.listingId !== pick.listingId || block.side !== pick.side) fail('AEON_CAPABILITY_GRAPH_BLOCK_MISSING');
    // A close read from Polymarket's displayed price (juke's one method for every game) carries no bid
    // and ask, so no spread and no copier line. The Season record already counts its copier line as zero;
    // juke# does the same, so the two agree, and the spread cell is left empty. Found Oct 3: requiring a
    // spread here held every player's juke#.
    const displayed = block.close.source === 'POLYMARKET_DISPLAYED_PRICE' && block.close.spread === null;
    const copierLineCredits = pick.copierLineCredits ?? (displayed ? '0' : null);
    if (block.close.startAt === null || (block.close.spread === null && !displayed) || block.close.price === null || pick.result === null
      || pick.closingValueCredits === null || copierLineCredits === null || pick.luckCredits === null || block.actions.length === 0) {
      fail('AEON_CAPABILITY_GRAPH_GRADED_PICK_INCOMPLETE');
    }
    const decidedAt = block.actions.map((action) => action.occurredAt).sort().at(-1)!;
    trading.push(Object.freeze({
      eventId: pick.eventId, listingId: pick.listingId, side: pick.side, axes, startAt: block.close.startAt, decidedAt,
      boughtShares: block.entry.boughtShares, soldShares: block.entry.soldShares, averageBuyPrice: block.entry.averageBuyPrice,
      closeForSide: block.close.price, closeSpread: block.close.spread,
      closingValueCredits: pick.closingValueCredits, copierLineCredits,
      resultRelativeCredits: pick.luckCredits, feesCredits: pick.feesCredits, result: pick.result,
    }));
  }
  return Object.freeze({ trading: Object.freeze(trading), live: Object.freeze(live) });
}

/**
 * Counterpart's sealed views as forecasting tasks, one per Listing and checkpoint. A
 * checkpoint sealed late is LATE, not the method abstaining (handoff §5).
 */
export function capabilityForecastsFromCounterpartViewsV1(input: {
  readonly views: readonly CounterpartEventViewV1[];
  readonly axes: ReadonlyMap<string, CapabilityAxesV1>;
  readonly closes: ReadonlyMap<string, { readonly closeYes: string | null; readonly closeSpread: string | null }>;
  readonly outcomes: ReadonlyMap<string, CapabilityListingOutcomeV1>;
}): readonly CapabilityForecastRowV1[] {
  const rows: CapabilityForecastRowV1[] = [];
  for (const view of input.views) {
    const late = counterpartCheckpointLateV1(view.checkpoint, view.dueAt, view.sealedAt);
    const latencyMs = Math.max(0, Date.parse(view.sealedAt) - Date.parse(view.dueAt));
    for (const listing of view.listings) {
      const close = input.closes.get(listing.listingId) ?? { closeYes: null, closeSpread: null };
      const base = {
        eventId: view.eventId, eventStartAt: view.startAt, listingId: listing.listingId, axes: input.axes.get(listing.listingId) ?? NO_AXES,
        checkpoint: view.checkpoint,
        closeYes: close.closeYes === null ? null : canonical(close.closeYes), closeSpread: close.closeSpread,
        outcome: input.outcomes.get(listing.listingId) ?? null, latencyMs, costMicroUsd: null,
      };
      if (listing.disposition === 'FORECAST' && listing.book !== null) {
        rows.push(Object.freeze({ ...base, disposition: 'FORECAST' as const, abstainCode: null,
          forecastYes: canonical(listing.fairYes), marketYes: canonical(listing.book.mid) }));
      } else if (listing.disposition === 'FORECAST') {
        // A house-model forecast sealed on a one-sided market has no copier
        // reference, so its distance from the copier line cannot be measured.
        rows.push(Object.freeze({ ...base, disposition: 'ABSTAIN' as const, abstainCode: 'INPUT_NOT_TWO_SIDED' as const, forecastYes: null, marketYes: null }));
      } else if (late && listing.code === 'STALE_INPUT') {
        rows.push(Object.freeze({ ...base, disposition: 'LATE' as const, abstainCode: null, forecastYes: null, marketYes: null }));
      } else {
        rows.push(Object.freeze({ ...base, disposition: 'ABSTAIN' as const, abstainCode: listing.code, forecastYes: null, marketYes: null }));
      }
    }
  }
  return Object.freeze(rows);
}

/**
 * Forecasting rows by the Week their event starts in (the Wednesday 06:00 America/Chicago
 * boundaries the caller supplies as `startsAt`), so a publication sealed before a
 * boundary and a T−6h view sealed after it land in the same Week. A start before the
 * first Week is out of season.
 */
export function capabilitySplitForecastsByWeekV1(input: {
  readonly weeks: readonly { readonly weekId: string; readonly startsAt: string }[];
  readonly forecasts: readonly CapabilityForecastRowV1[];
}): { readonly byWeek: ReadonlyMap<string, readonly CapabilityForecastRowV1[]>; readonly outOfSeason: number } {
  const weeks = [...input.weeks].map((week) => ({ weekId: week.weekId, startMs: Date.parse(week.startsAt) }))
    .sort((a, b) => a.startMs - b.startMs);
  if (weeks.some((week) => !Number.isFinite(week.startMs)) || new Set(weeks.map((week) => week.weekId)).size !== weeks.length) {
    fail('AEON_CAPABILITY_GRAPH_WEEK_INVALID');
  }
  const byWeek = new Map<string, CapabilityForecastRowV1[]>();
  let outOfSeason = 0;
  for (const row of input.forecasts) {
    const startMs = Date.parse(row.eventStartAt);
    if (!Number.isFinite(startMs)) fail('AEON_CAPABILITY_GRAPH_EVENT_START_INVALID');
    const week = [...weeks].reverse().find((candidate) => candidate.startMs <= startMs);
    if (!week) { outOfSeason += 1; continue; }
    byWeek.set(week.weekId, [...(byWeek.get(week.weekId) ?? []), row]);
  }
  return Object.freeze({ byWeek, outOfSeason });
}
