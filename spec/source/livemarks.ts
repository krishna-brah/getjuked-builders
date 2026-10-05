import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import type { Firestore } from 'firebase-admin/firestore';

import { dataPlaneDigest } from '../v3-beta/data-plane-contract';
import type { StockedCatalog, StockedListing } from '../v3-beta/stocked-catalog';
import { WEEK_COLLECTION } from './catalog';
import type { PricePoint } from './closes';

/**
 * Live marks (provisional live-trading standard, Oct 3 2026): the market's own price during
 * a game, minute by minute, so an in-play decision can be graded against where the market stood a
 * few minutes after it, the in-play counterpart of grading a pregame decision against the close.
 *
 * Read once per game after it has a result, from Polymarket's public price history (the same source
 * as the close). A minute counts only when the YES and the NO price both have a point in it and they
 * agree (sum to 1 within LIVE_AGREEMENT): a two-sided market, not a stale or one-sided print. The
 * stored value is the YES price that both imply, (yes + 1 − no) / 2. Written once, never rewritten.
 */
export const LIVE_AGREEMENT = 0.01;
/** History is read from the start for this long; longer games keep what fits. */
const WINDOW_SECONDS = 5 * 60 * 60;
const HISTORY = 'https://clob.polymarket.com/prices-history';
const READ_CONCURRENCY = 8;
const GAMES_PER_RUN = 4;
/** A game is read only once its last result is this old, so the history is complete. */
const SETTLE_MS = 10 * 60_000;
/** A game with no two-sided minute at all is stored empty after this long, so it stops taking a slot. */
const EMPTY_AFTER_MS = 24 * 60 * 60_000;

/** One Market's in-play YES price by minute after the start: [minute, price in millionths]. */
export type LiveSeries = readonly (readonly [minute: number, yesMicros: number])[];
export interface GameLiveMarks {
  readonly contractVersion: 'juke.live-marks.v1';
  readonly eventId: string;
  readonly startAt: string;
  readonly capturedAt: string;
  readonly listings: Readonly<Record<string, LiveSeries>>;
  readonly recordDigest: string;
}

const docId = (value: string) => value.replace(/\//g, '_');
const marksRef = (db: Firestore, cycleId: string, eventId: string) =>
  db.collection(WEEK_COLLECTION).doc(docId(cycleId)).collection('livemarks').doc(dataPlaneDigest({ eventId }).slice('sha256:'.length, 'sha256:'.length + 40));

/** The minute-by-minute two-sided YES price from the two histories, by the rule above. */
export function liveSeriesFromHistory(startAt: string, yes: readonly PricePoint[], no: readonly PricePoint[]): LiveSeries {
  const start = Math.floor(Date.parse(startAt) / 1000);
  const byMinute = (points: readonly PricePoint[]) => {
    const out = new Map<number, number>();
    for (const point of points) {
      if (!Number.isFinite(point?.t) || !Number.isFinite(point?.p) || point.t < start || !(point.p > 0 && point.p < 1)) continue;
      // The last print in each minute.
      out.set(Math.floor((point.t - start) / 60), point.p);
    }
    return out;
  };
  const yesByMinute = byMinute(yes);
  const noByMinute = byMinute(no);
  const series: [number, number][] = [];
  for (const [minute, y] of [...yesByMinute.entries()].sort((a, b) => a[0] - b[0])) {
    const n = noByMinute.get(minute);
    if (n === undefined || Math.abs(y + n - 1) > LIVE_AGREEMENT + 1e-9) continue;
    series.push([minute, Math.round(((y + 1 - n) / 2) * 1_000_000)]);
  }
  return series;
}

async function history(tokenId: string, startSeconds: number, fetchImpl: typeof fetch): Promise<readonly PricePoint[]> {
  const url = `${HISTORY}?market=${encodeURIComponent(tokenId)}&startTs=${startSeconds}&endTs=${startSeconds + WINDOW_SECONDS}&fidelity=1`;
  const response = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`GJ_LIVE_MARKS_SOURCE_${response.status}`);
  const body = await response.json() as { history?: unknown };
  return Array.isArray(body.history) ? body.history as PricePoint[] : [];
}

/**
 * One Market that cannot be read (after one retry) is stored with no series, so its in-play picks
 * show as not graded, rather than holding the whole game back; when most Markets fail, the source
 * is treated as down and the game is asked again later.
 */
export async function fetchGameLiveMarks(listings: readonly StockedListing[], eventId: string, startAt: string, fetchImpl: typeof fetch = fetch, allowEmpty = false): Promise<GameLiveMarks> {
  const startSeconds = Math.floor(Date.parse(startAt) / 1000);
  const out: Record<string, LiveSeries> = {};
  let unread = 0;
  const read = async (listing: StockedListing) => {
    const [yes, no] = await Promise.all([history(listing.tokenIdBySide.YES, startSeconds, fetchImpl), history(listing.tokenIdBySide.NO, startSeconds, fetchImpl)]);
    return liveSeriesFromHistory(startAt, yes, no);
  };
  for (let at = 0; at < listings.length; at += READ_CONCURRENCY) {
    await Promise.all(listings.slice(at, at + READ_CONCURRENCY).map(async (listing) => {
      try { out[listing.listingId] = await read(listing); } catch {
        try { out[listing.listingId] = await read(listing); } catch { out[listing.listingId] = []; unread += 1; }
      }
    }));
  }
  if (unread * 2 > listings.length) throw new Error('GJ_LIVE_MARKS_SOURCE_UNAVAILABLE');
  // No two-sided minute anywhere usually means the history is not there yet: asked again, and stored
  // empty only once the game is a day old (a market that never had two-sided prices).
  if (!allowEmpty && Object.values(out).every((series) => series.length === 0)) throw new Error('GJ_LIVE_MARKS_EMPTY');
  const body = { contractVersion: 'juke.live-marks.v1' as const, eventId, startAt, capturedAt: new Date().toISOString(), listings: out };
  return { ...body, recordDigest: dataPlaneDigest(body) };
}

/** Finished games (most Markets resolved and the last result settled, or past the read window) with no live marks yet, earliest first. */
export function gamesAwaitingLiveMarks(catalog: StockedCatalog, resolvedAt: ReadonlyMap<string, string>, stored: ReadonlySet<string>, now: string) {
  const games = new Map<string, { eventId: string; startAt: string; listings: StockedListing[] }>();
  for (const listing of catalog.arenas.flatMap((arena) => arena.listings)) {
    if (!listing.sourceEventId || !listing.sourceEventStartAt || stored.has(listing.sourceEventId)) continue;
    const game = games.get(listing.sourceEventId) ?? { eventId: listing.sourceEventId, startAt: listing.sourceEventStartAt, listings: [] };
    game.listings.push(listing);
    games.set(listing.sourceEventId, game);
  }
  const nowMs = Date.parse(now);
  return [...games.values()].filter((game) => {
    const resolved = game.listings.map((listing) => resolvedAt.get(listing.listingId)).filter((at): at is string => !!at);
    // A game with no result at all may be postponed: never read from its old start.
    if (resolved.length === 0) return false;
    // Past the read window the history is complete however many props have resolved.
    if (nowMs >= Date.parse(game.startAt) + WINDOW_SECONDS * 1000 + SETTLE_MS) return true;
    // Before that, a game counts as finished when most of its Markets have a result.
    if (resolved.length < Math.ceil(game.listings.length / 2)) return false;
    return nowMs - Math.max(...resolved.map((at) => Date.parse(at))) >= SETTLE_MS;
  }).sort((a, b) => a.startAt.localeCompare(b.startAt) || a.eventId.localeCompare(b.eventId));
}

/** One live-marks run: reads a few finished games and stores each once. */
export async function runLiveMarksCheck(db: Firestore, cycleId: string, catalog: StockedCatalog, resolvedAt: ReadonlyMap<string, string>, now = new Date().toISOString(), fetchImpl: typeof fetch = fetch) {
  const eventIds = [...new Set(catalog.arenas.flatMap((arena) => arena.listings).map((listing) => listing.sourceEventId).filter((id): id is string => !!id))];
  const refs = eventIds.map((eventId) => marksRef(db, cycleId, eventId));
  const stored = new Set<string>();
  for (let at = 0; at < refs.length; at += 200) {
    const snapshots = await db.getAll(...refs.slice(at, at + 200), { fieldMask: ['eventId'] });
    for (const snapshot of snapshots) if (snapshot.exists) stored.add(snapshot.get('eventId') as string);
  }
  const waiting = gamesAwaitingLiveMarks(catalog, resolvedAt, stored, now);
  let captured = 0;
  const failed: string[] = [];
  for (const game of waiting.slice(0, GAMES_PER_RUN)) {
    try {
      const marks = await fetchGameLiveMarks(game.listings, game.eventId, game.startAt, fetchImpl, Date.parse(now) - Date.parse(game.startAt) >= EMPTY_AFTER_MS);
      const packed = brotliCompressSync(Buffer.from(JSON.stringify(marks)));
      try {
        await marksRef(db, cycleId, game.eventId).create({ eventId: game.eventId, marksBr: packed, capturedAt: marks.capturedAt });
        captured += 1;
      } catch (error) {
        if ((error as { code?: number }).code !== 6) throw error;
      }
    } catch (error) {
      failed.push(`${game.eventId.slice(-8)}:${(error as Error).message}`);
    }
  }
  return { waiting: waiting.length, captured, remaining: Math.max(0, waiting.length - captured), failed };
}

/** Stored marks never change: one read per game per server instance; a game not captured yet is asked again after a while. */
const kept = new Map<string, GameLiveMarks>();
const missingUntil = new Map<string, number>();
const MISSING_RETRY_MS = 10 * 60_000;

/** Two Weeks of games are a few hundred entries; past this the maps start over rather than grow. */
const KEPT_LIMIT = 5_000;

export async function liveMarksFor(db: Firestore, cycleId: string, eventIds: readonly string[]): Promise<Map<string, GameLiveMarks>> {
  const nowMs = Date.now();
  if (kept.size > KEPT_LIMIT) kept.clear();
  if (missingUntil.size > KEPT_LIMIT) missingUntil.clear();
  const missing = eventIds.filter((eventId) => !kept.has(`${cycleId}/${eventId}`) && (missingUntil.get(`${cycleId}/${eventId}`) ?? 0) <= nowMs);
  for (let at = 0; at < missing.length; at += 100) {
    const batch = missing.slice(at, at + 100);
    const snapshots = await db.getAll(...batch.map((eventId) => marksRef(db, cycleId, eventId)));
    snapshots.forEach((snapshot, index) => {
      const eventId = batch[index]!;
      if (!snapshot.exists) { missingUntil.set(`${cycleId}/${eventId}`, nowMs + MISSING_RETRY_MS); return; }
      try { kept.set(`${cycleId}/${eventId}`, JSON.parse(brotliDecompressSync(snapshot.get('marksBr') as Buffer).toString('utf8')) as GameLiveMarks); } catch { /* unreadable: left out */ }
    });
  }
  const out = new Map<string, GameLiveMarks>();
  for (const eventId of eventIds) { const marks = kept.get(`${cycleId}/${eventId}`); if (marks) out.set(eventId, marks); }
  return out;
}
