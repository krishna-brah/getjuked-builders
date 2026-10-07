#!/usr/bin/env node
/**
 * juke-mcp: connect any MCP client (Claude, ChatGPT, Cursor, ...) to juke through the Builder API.
 * Your AI reads live sports prediction-market boards and places sealed paper picks and forecasts as
 * your registered system. Paper Credits only: no money is ever at stake.
 *
 * Environment:
 *   JUKE_API_KEY   your system's key (jk_...), shown once when you register it on getjuked.io
 *   JUKE_BASE_URL  optional; defaults to https://www.getjuked.io/api/v3-beta. Only https on getjuked.io, or a local juke
 *                  (http://localhost or 127.0.0.1) for testing: the key is never sent anywhere else.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { baseUrl } from './base-url.js';

const BASE = baseUrl(process.env.JUKE_BASE_URL);
const KEY = process.env.JUKE_API_KEY ?? '';
const ARENAS = ['arena:football', 'arena:soccer'] as const;

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: any }> {
  if (BASE === null) return { status: 400, json: { ok: false, code: 'JUKE_BASE_URL_REFUSED', hint: 'JUKE_BASE_URL must be https on getjuked.io, or a local juke on localhost; your key is never sent anywhere else.' } };
  if (!/^jk_/u.test(KEY)) return { status: 401, json: { ok: false, code: 'JUKE_API_KEY_MISSING', hint: 'Set JUKE_API_KEY to your system key from getjuked.io (Builder API).' } };
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', accept: 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  return { status: response.status, json: await response.json().catch(() => ({ ok: false, code: `HTTP_${response.status}` })) };
}

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] });

/** A game's Markets in the shape a model can read: question, the two sides, live prices, closing time. */
function compactListing(listing: any) {
  const presentation = listing.sportsMarketPresentation ?? {};
  return {
    listingId: listing.listingId,
    question: listing.question,
    market: presentation.marketTypeLabel ?? presentation.marketType ?? null,
    line: presentation.line ?? null,
    yes: listing.sideLabelBySide?.YES ?? 'Yes',
    no: listing.sideLabelBySide?.NO ?? 'No',
    priceYes: listing.indicative?.yes ?? null,
    priceNo: listing.indicative?.no ?? null,
    closesAt: listing.actionClosesAt ?? listing.closesAt ?? null,
  };
}

const server = new McpServer({ name: 'juke', version: '0.1.0' });

server.registerTool('juke_games', {
  title: 'List games',
  description: 'This Week\'s games in an Arena (football or soccer): title, start time, game id, number of Markets. Use a game id with juke_markets to see prices.',
  inputSchema: { arena: z.enum(['football', 'soccer']).default('football') },
}, async ({ arena }) => {
  const r = await call('GET', `/builder/board?arenaId=arena:${arena}`);
  if (r.status !== 200) return text(r.json);
  const games = new Map<string, { gameId: string; title: string; startAt: string; markets: number }>();
  for (const listing of r.json.board?.arenas?.[0]?.listings ?? []) {
    if (!listing.sourceEventId) continue;
    const game = games.get(listing.sourceEventId) ?? { gameId: listing.sourceEventId, title: listing.sourceEventTitle, startAt: listing.sourceEventStartAt, markets: 0 };
    game.markets += 1;
    games.set(listing.sourceEventId, game);
  }
  return text({ week: r.json.week?.cycleId ?? null, games: [...games.values()].sort((a, b) => a.startAt.localeCompare(b.startAt)) });
});

server.registerTool('juke_markets', {
  title: 'Markets with live prices',
  description: 'One game\'s Markets with live prices (0 to 1, the price of a YES or NO share). Before or during the game.',
  inputSchema: { arena: z.enum(['football', 'soccer']).default('football'), gameId: z.string().min(3) },
}, async ({ arena, gameId }) => {
  const r = await call('GET', `/builder/board?arenaId=arena:${arena}&eventId=${encodeURIComponent(gameId)}`);
  if (r.status !== 200) return text(r.json);
  return text({ markets: (r.json.board?.arenas?.[0]?.listings ?? []).map(compactListing) });
});

server.registerTool('juke_book', {
  title: 'Your Book',
  description: 'Your system\'s Book this Week: Credits, open positions and the Arena rules.',
  inputSchema: { arena: z.enum(['football', 'soccer']).default('football') },
}, async ({ arena }) => text((await call('GET', `/builder/board?arenaId=arena:${arena}&view=SUMMARY`)).json));

server.registerTool('juke_pick', {
  title: 'Place a paper pick',
  description: 'Buy one side of a Market with paper Credits at the live price. Sealed the moment juke receives it and graded against the market. Set limitPrice (0 to 1) to refuse a worse fill. Never trades twice for the same orderId.',
  inputSchema: {
    arena: z.enum(['football', 'soccer']).default('football'),
    listingId: z.string().min(3),
    side: z.enum(['YES', 'NO']),
    credits: z.string().regex(/^\d{1,4}(\.\d{1,6})?$/u).describe('Paper Credits to spend, e.g. "25"'),
    limitPrice: z.number().gt(0).lt(1).optional(),
    orderId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/u).optional().describe('Reuse it to retry the same order safely'),
  },
  annotations: { destructiveHint: false, idempotentHint: true },
}, async ({ arena, listingId, side, credits, limitPrice, orderId }) => text((await call('POST', '/builder/pick', {
  arenaId: ARENAS.find((id) => id.endsWith(arena)), listingId, side, credits, orderId: orderId ?? `mcp-${randomUUID().slice(0, 18)}`,
  ...(limitPrice === undefined ? {} : { limitPrice }),
})).json));

server.registerTool('juke_close', {
  title: 'Sell a position',
  description: 'Sell (close) shares of one of your open positions at the live price. Get the positionId and shares from juke_positions.',
  inputSchema: {
    arena: z.enum(['football', 'soccer']).default('football'),
    listingId: z.string().min(3), side: z.enum(['YES', 'NO']), positionId: z.string().min(3),
    shares: z.string().regex(/^\d{1,7}(\.\d{1,6})?$/u),
    orderId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/u).optional(),
  },
}, async ({ arena, listingId, side, positionId, shares, orderId }) => text((await call('POST', '/builder/pick', {
  arenaId: ARENAS.find((id) => id.endsWith(arena)), listingId, side, operation: 'CLOSE', positionId, shares, orderId: orderId ?? `mcp-${randomUUID().slice(0, 18)}`,
})).json));

server.registerTool('juke_forecast', {
  title: 'Seal a forecast',
  description: 'Seal your probability that a Market resolves YES (0.01 to 0.99). One per Market; the first one counts. Open before or during the game.',
  inputSchema: { listingId: z.string().min(3), probability: z.number().min(0.01).max(0.99) },
}, async ({ listingId, probability }) => text((await call('POST', '/builder/forecast', { listingId, probability })).json));

server.registerTool('juke_positions', {
  title: 'Your positions',
  description: 'Your open and settled positions.',
  inputSchema: {},
}, async () => text((await call('GET', '/builder/positions')).json));

server.registerTool('juke_record', {
  title: 'Your juke#',
  description: 'Your system\'s record from finished games: graded against the market, never one score; what each cell still needs.',
  inputSchema: {},
}, async () => text((await call('GET', '/builder/record')).json));

await server.connect(new StdioServerTransport());
