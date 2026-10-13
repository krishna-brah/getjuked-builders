#!/usr/bin/env python3
"""juke Season 1 pre-registered analysis: does live grading separate systems faster?

This is the analysis script that the Season 1 pre-registration promises (prereg/season1-2026.md, public as commit
0e39692 in github.com/krishna-brah/getjuked-builders, section 4): committed to the kit before Oct 14, 2026 and run
unchanged. Any later change is logged as a deviation with its reason.

Run:    python3 season1_analysis.py decisions.csv > results.json
Needs:  Python 3.9 or newer, standard library only. No network. Nothing random except the seeded bootstrap below.
Tests:  python3 season1_analysis_test.py (synthetic data only).

Input: one CSV of decisions exported by juke, one row per decision, with the columns in COLUMNS below (extra columns
are ignored). Output: one JSON document on stdout with every statistic sections 3 to 6 define, the three primary tests
with their Holm-adjusted p-values and labels, each section 4 sensitivity run, the exclusion counts and the abuse counts.
A malformed row stops the run with its line number; fix the export, never the script.

Grading standard: the kit's own (spec/README.md). Pregame decisions are valued against the close, in-play decisions
against the live mark (juke.live-mark.provisional.v2), and a system's estimate is 100 x sum of value / sum of shares
with a game-clustered standard error, exactly as spec/README.md line 28 and spec/source/sharp.ts lines 112-125 do it.

Output keys: primary (population, M1, M2, M3, tests with p, holm_p and label, published_systems, by_week),
counterpart_baseline, sensitivity (marks_last_fair_at_trade, marks_last_fair_at_trade_result, one_system_per_owner,
post_engineering_change, by_sport, people), exclusions, abuse, diagnostics, settings, input and script_sha256.
Values are in points per share unless a key says otherwise; null means not computable, with a reason beside it.

Determinism: the bootstrap uses SEED = 20261014 and RESAMPLES = 10,000 (constants below). The same CSV gives the same
JSON. The output records the CSV's and this file's SHA-256, so a reader can check the script ran unchanged.

Readings of the registered text
-------------------------------
Where the registered text leaves a choice open, this script takes the plainest standard method, one line each:
- R1 A decision is one sealed action (one action_receipt_id: a buy or a sale), the unit the price block grades; every minimum (30/15, 20/4) counts these decisions and distinct games (event ids).
- R2 v is a decision's graded value in Credits (price difference x shares, as its price block reports it); V = 100 x sum(value) / sum(shares) is in points per share, the kit's estimate.
- R3 A decision's mode is the price block section that graded it: PREGAME against the close (placed before the start), IN_PLAY against its live mark (at or after the start).
- R4 SE(n) is the kit's game-clustered standard error, in points; with fewer than 2 games it is undefined.
- R5 An actor qualifies in a mode with >= 30 graded decisions across >= 15 games in that mode over the Season; M1, M2 and M3 use only qualifying actors, and every run (sensitivity, sport, speed window) re-applies the rule to its own decisions.
- R6 "Evaluated after each game": an actor's games are taken in order of start (earliest start_at, then event id); after each game all of that game's decisions are in, and n is the count so far.
- R7 Separated means |V(n)| / SE(n) >= 2.58; an SE of exactly 0 separates only when V is not 0.
- R8 A system that never separates is censored at its total number of graded decisions in that mode.
- R9 Days to separation run from the start of the system's first graded game in that mode to the start of the game after which it separated (censored: its last game), in fractional days.
- R10 The Kaplan-Meier median is the smallest time at which survival is <= 0.5 (separations before censorings at tied times); null when survival never falls that far.
- R11 The paired ratio is the median over systems of DtS_pregame / DtS_in-play, found with the log-rank-style comparison so censored pairs count: the factor theta at which, with each pregame DtS divided by theta, as many pairs separate first in each mode (with no censoring this is exactly the median of the per-system ratios, the two middle ones averaged on the log scale when their number is even).
- R12 The log-rank-style comparison is the log-rank test stratified by system (one stratum per pair): it scores which mode separated first, a separation before the other's censoring counts, tied separations and a pair whose first time is censored count for neither; its exact null is Binomial(n, 1/2), so p is the exact two-sided sign-test p at theta = 1.
- R13 The paired ratio's 95% CI runs from the smallest to the largest theta that the same exact test does not reject at 0.05 (test inversion); an end with no such bound is reported as null.
- R14 The model-based DtS uses the mean and sample SD (n - 1) of the system's per-decision points per share (100 x value / shares); it is undefined when the mean is 0.
- R15 With fewer than 10 systems qualifying in both modes, M1 is descriptive: its p is shown but not tested, Holm counts it as p = 1, and its label is Inconclusive.
- R16 Weeks are juke's Season 1 cycle ids program:season-1-2026-10-14:W1 to W4; consecutive pairs are W1-W2, W2-W3 and W3-W4; a Week's V is V over that Week's decisions.
- R17 Spearman's rho is the Pearson correlation of average ranks (ties share their mean rank); undefined for fewer than 3 systems or no rank variance.
- R18 The Fisher z average weights atanh(rho) of each Week pair by n - 3 (pairs with n <= 3 drop out) and back-transforms with tanh; |rho| is capped at 0.9999 first.
- R19 The bootstrap draws 10,000 resamples of systems with replacement (seed 20261014, Python's Mersenne Twister); each Week pair is recomputed on the resampled systems it holds; the 95% CI is the 2.5th and 97.5th percentiles (linear interpolation); resamples with no pooled rho are dropped and counted.
- R20 M2's p (for Holm) is the two-sided bootstrap p for pooled in-play rho = 0: 2 x (1 + resamples on the far side of 0) / (defined resamples + 1), capped at 1.
- R21 M2's n is the number of distinct systems in at least one in-play Week pair; "not more than 0.15 below pregame rho" compares the two pooled point estimates.
- R22 M2's label is checked in order: n < 15 gives Inconclusive; then Support; then Failure (rho <= 0 and the CI's upper end < 0.2); anything else is Inconclusive.
- R23 Split-half reliability uses each system's own games in start order, odd-numbered against even-numbered; Spearman's rho across systems of the two halves' V; Spearman-Brown 2 rho / (1 + rho).
- R24 M3 ranks qualifying systems with graded decisions in both Weeks 1-2 and Weeks 3-4 by V over Weeks 1-2 (ties by actor id); each quartile holds max(4, floor(N / 4)) systems; not computed when the two groups would overlap (N < 8).
- R25 M3's mean V is the unweighted mean of the group's per-system V over Weeks 3-4; SE(D) is game-clustered from each game's combined effect on D, which is the kit's formula when a group is one system.
- R26 The speed filter drops a decision when seconds since the latest scoring event, card, review or suspension in its game <= W, or seconds until the next venue mid move of >= 5 cents within one minute <= W (inclusive; blank means none); the whole M3 computation reruns on what is left, in both modes.
- R27 "The raw spread disappears" means raw in-play D > 0 and speed-adjusted D <= 0 (H3: "remains positive"); it is reported as a flag and adds no case beyond t <= 0.
- R28 p-values for t statistics use the normal distribution, as the kit's verdict threshold does.
- R29 Holm runs over three tests (M1, M2 in-play pooled rho, M3 in-play speed-adjusted t) at alpha = 0.05; a test without a p counts as p = 1.
- R30 The section 6 table is applied as written: M1's Support and Failure both use the Holm-adjusted p; M2 and M3 use their CI and t, with the Holm-adjusted p reported beside them.
- R31 The mark sensitivity runs twice: LAST_FAIR and AT_TRADE added (section 4's list), and RESULT added as well (section 2's sentence).
- R32 One system per owner keeps the owner's system with the most graded decisions in both modes together (ties: lower actor id), for every analysis in that run.
- R33 Post-engineering-change decisions are those whose regime is neither blank nor PRE_CHANGE; with none, that run is reported empty.
- R34 By sport: NFL (competition series:12185), college football (series:12756), soccer (sport:soccer), and any other sport under its own sport id; "where n allows" means each statistic's own minimum.
- R35 People get the same analysis as systems (section 2's secondary population, section 4's "people instead of systems").
- R36 Each excluded decision is counted once under its first reason in a fixed order, and also under every reason it has.
- R37 A decision on a Market with no result yet is not graded and is counted as market_not_settled; a decision outside Season 1's four Weeks is counted and dropped.
- R38 Only an upheld review excludes a decision: review status REFUSE, not overturned on appeal; open (HOLD) and CLEARED reviews are kept and counted.
- R39 Counterpart is kept out of every population and ranking and summarised as a baseline; juke test systems and accounts removed for abuse are dropped entirely.
- R40 Only published systems (by handle) and Counterpart get rows of their own; private systems and people appear only in aggregates.
"""

import csv
import hashlib
import io
import json
import math
import os
import random
import re
import sys
from datetime import datetime, timezone
from fractions import Fraction

# ---------------------------------------------------------------------------
# The input: one row per decision.
#
# Every column is required in the header. Booleans are TRUE or FALSE (blank counts as FALSE). Times are ISO 8601 with
# an offset or Z. Numbers are plain decimals. Names follow what juke records: the Season record, the price block
# (spec/source/aeon-price-block-v1.ts), the catalog and the systems store.

COLUMNS = (
    ('action_receipt_id', "The decision: the ledger action's receipt id (the price block's actionReceiptId). Unique."),
    ('actor_kind', 'SYSTEM or PERSON (the player record kind).'),
    ('actor_id', "The player uid: sys_<systemId> for a system (systems/{systemId}), the person's uid or a stable "
                 "pseudonym of it. A juke test account keeps its juke-test- prefix."),
    ('owner_id', "A system's ownerUid (or the same pseudonym); for a person, the same value as actor_id."),
    ('system_kind', 'For a system: BUILDER, LAB, TRACKED or HOUSE (the Systems Table kind). Blank for a person '
                    'and for Counterpart.'),
    ('is_counterpart', 'TRUE for Counterpart, juke\'s own system (a baseline, never ranked).'),
    ('juke_test', 'TRUE for a juke-internal test system listed in the appendix, or any juke-test- account.'),
    ('account_removed_for_abuse', 'TRUE when the account (or the system\'s owner account) was removed for abuse.'),
    ('published', 'TRUE when the owner published the system to the public Systems Table.'),
    ('handle', "The system's handle (ends in _ai). Required when published; never printed otherwise."),
    ('cycle_id', "The decision's Week: juke's cycle id, e.g. program:season-1-2026-10-14:W1 (the Season record's "
                 "weekId)."),
    ('event_id', 'The game (catalog Event id). Standard errors cluster on it.'),
    ('start_at', "The game's start that the price block grades against (block close.startAt), ISO 8601."),
    ('occurred_at', "When the decision was sealed (the action's occurredAt), ISO 8601."),
    ('sport_id', "The Listing's catalog sportId: sport:football, sport:soccer, sport:basketball, ..."),
    ('competition_id', "The Listing's catalog competitionId: series:12185 (NFL), series:12756 (college football), "
                       "..."),
    ('mode', 'PREGAME (graded against the close: the block\'s actions or pregame.actions) or IN_PLAY (graded '
             'against its live mark: the block\'s live.actions).'),
    ('shares', 'Shares the action bought or sold. Positive.'),
    ('value_credits', "The action's graded value in Credits, signed: against the close (pregame: shares x close - "
                      "cash for a buy, cash - shares x close for a sale) or against its mark (in play: the same with "
                      "the mark). Required when close_state is GRADED or mark_source is set; blank otherwise."),
    ('close_state', 'PREGAME only: GRADED when the close was captured, two-sided, narrow and not stale (the block '
                    'graded the pregame legs); otherwise the block\'s reason: CLOSE_NOT_CAPTURED, CLOSE_STALE, '
                    'CLOSE_SPREAD_WIDE or NOT_SCORED. Blank in play.'),
    ('mark_source', 'IN_PLAY only: the mark\'s source, LIVE, DECIDED, LAST_FAIR, AT_TRADE or RESULT; blank when '
                    'unmarked. Blank pregame.'),
    ('mark_standard', 'IN_PLAY only: the live standard that marked it, e.g. juke.live-mark.provisional.v2. '
                      'Required when mark_source is set.'),
    ('market_result', "The Market's settled result: YES, NO, VOIDED (voided, not scoreable) or NEUTRAL_50_50 "
                      "(the source's 50-50 resolution, which juke settles as voided). Blank when not settled."),
    ('is_combo', 'TRUE when the decision is a Combo (no single market to grade).'),
    ('market_lifecycle_at_action', "The Market's state when the decision was placed: OPEN, SUSPENDED, CLOSED, "
                                   "RESOLVED, VOIDED, UNDER_REVIEW or UNKNOWN; blank when not recorded."),
    ('review_status', "The market-integrity review case covering this decision: HOLD (open), CLEARED or REFUSE "
                      "(upheld by an authorized human). Blank when never flagged."),
    ('appeal_status', "That case's appeal: NONE, PENDING, UPHELD or OVERTURNED. Blank when never flagged."),
    ('regime', 'The engineering regime flag (in-play delay, re-quote or guards): blank or PRE_CHANGE before any '
               'change, otherwise the id of the change in force when the decision was placed.'),
    ('seconds_since_game_event', 'Seconds since the latest scoring event, card, review or suspension in that game '
                                 'when the decision was placed. Blank when there was none.'),
    ('seconds_to_mid_move', 'Seconds from the decision until the next venue mid move of at least 5 cents within '
                            'one minute. Blank when there was none.'),
)
COLUMN_NAMES = tuple(name for name, _ in COLUMNS)

CONTRACT = 'juke.season1-prereg-analysis.v1'
REGISTRATION = {'path': 'prereg/season1-2026.md', 'commit': '0e39692',
                'repository': 'github.com/krishna-brah/getjuked-builders'}
LIVE_MARK_STANDARD = 'juke.live-mark.provisional.v2'

# Season 1 as juke defines it (docs/contracts/v3-season-1-2026-10-14-program-v2.json): four Weeks, each a cycle id
# program:season-1-2026-10-14:W<n>, from Wednesday 06:00 America/Chicago.
SEASON_PROGRAM = 'season-1-2026-10-14'
SEASON_WEEKS = ('W1', 'W2', 'W3', 'W4')
RANKING_WEEKS = ('W1', 'W2')
OUT_OF_SAMPLE_WEEKS = ('W3', 'W4')
CYCLE_ID = re.compile(r'^program:' + re.escape(SEASON_PROGRAM) + r':(W[1-4])$')

MODES = ('PREGAME', 'IN_PLAY')
MIN_DECISIONS = 30            # section 2: the canon juke# minimum
MIN_GAMES = 15
WEEK_MIN_DECISIONS = 20       # M2: in both Weeks of a pair
WEEK_MIN_GAMES = 4
SEPARATION_Z = 2.58           # M1: two-sided 1%
M1_MIN_PAIRS = 10             # section 5: M1 is descriptive below this
M2_MIN_SYSTEMS = 15           # section 6: Inconclusive below this
QUARTILE_MIN = 4              # M3: rounded down, minimum 4 each
PRIMARY_SPEED_WINDOW = 60     # M3: memo 2.2
SPEED_WINDOWS = (30, 60, 120)
ALPHA = 0.05
ALPHA_EXACT = Fraction(1, 20)
SEED = 20261014
RESAMPLES = 10000
RHO_CAP = 0.9999
DAY = 86400.0

PRIMARY_MARKS = frozenset(['LIVE', 'DECIDED'])
MARKS_WITH_LAST_FAIR_AT_TRADE = frozenset(['LIVE', 'DECIDED', 'LAST_FAIR', 'AT_TRADE'])
MARKS_WITH_RESULT = frozenset(['LIVE', 'DECIDED', 'LAST_FAIR', 'AT_TRADE', 'RESULT'])

# The by-sport groups. NFL and college football are both sport:football in juke's catalog; the competition id tells
# them apart (src/lib/v3-beta/beta-sports-current-source-policy-v1.ts: NFL series 12185, college football 12756).
COMPETITION_GROUPS = {'series:12185': 'NFL', 'series:12756': 'college football'}
SPORT_GROUPS = {'sport:soccer': 'soccer'}

# Exclusion reasons, in the order a decision is attributed to its first one.
REASONS = (
    'outside_season_1', 'juke_test', 'account_removed_for_abuse', 'voided', 'fifty_fifty', 'market_not_settled',
    'combo', 'suspended', 'abuse_upheld',
    'close_not_captured', 'close_stale', 'close_spread_wide', 'close_not_scored',
    'mark_last_fair', 'mark_at_trade', 'mark_result', 'unmarked',
)
CLOSE_REASON = {'CLOSE_NOT_CAPTURED': 'close_not_captured', 'CLOSE_STALE': 'close_stale',
                'CLOSE_SPREAD_WIDE': 'close_spread_wide', 'NOT_SCORED': 'close_not_scored'}
MARK_REASON = {'LAST_FAIR': 'mark_last_fair', 'AT_TRADE': 'mark_at_trade', 'RESULT': 'mark_result', '': 'unmarked'}

CLOSE_STATES = frozenset(['GRADED', 'CLOSE_NOT_CAPTURED', 'CLOSE_STALE', 'CLOSE_SPREAD_WIDE', 'NOT_SCORED'])
MARK_SOURCES = frozenset(['', 'LIVE', 'DECIDED', 'LAST_FAIR', 'AT_TRADE', 'RESULT'])
MARKET_RESULTS = frozenset(['', 'YES', 'NO', 'VOIDED', 'NEUTRAL_50_50'])
LIFECYCLES = frozenset(['', 'OPEN', 'SUSPENDED', 'CLOSED', 'RESOLVED', 'VOIDED', 'UNDER_REVIEW', 'UNKNOWN'])
REVIEW_STATUSES = frozenset(['', 'HOLD', 'CLEARED', 'REFUSE'])
APPEAL_STATUSES = frozenset(['', 'NONE', 'PENDING', 'UPHELD', 'OVERTURNED'])
SYSTEM_KINDS = frozenset(['', 'BUILDER', 'LAB', 'TRACKED', 'HOUSE'])


class InputError(ValueError):
    """The CSV does not match COLUMNS. The run stops; the export is fixed, never the script."""


# ---------------------------------------------------------------------------
# Reading

class Decision(object):
    """One row of the CSV, parsed."""
    __slots__ = ('line', 'action_receipt_id', 'actor_kind', 'actor_id', 'owner_id', 'system_kind', 'is_counterpart',
                 'juke_test', 'account_removed_for_abuse', 'published', 'handle', 'cycle_id', 'week', 'event_id',
                 'start_at', 'occurred_at', 'sport_id', 'competition_id', 'mode', 'shares', 'value', 'close_state',
                 'mark_source', 'mark_standard', 'market_result', 'is_combo', 'market_lifecycle_at_action',
                 'review_status', 'appeal_status', 'regime', 'seconds_since_game_event', 'seconds_to_mid_move')

    def __init__(self, **fields):
        for name in self.__slots__:
            setattr(self, name, fields[name])


TIME = re.compile(r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$')
DECIMAL = re.compile(r'^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$')


def parse_time(text, column, line):
    """ISO 8601 with an offset, to seconds since the epoch."""
    match = TIME.match(text)
    if not match:
        raise InputError('line %d: %s is not an ISO 8601 time with an offset: %r' % (line, column, text))
    year, month, day, hour, minute, second, fraction, zone = match.groups()
    try:
        moment = datetime(int(year), int(month), int(day), int(hour), int(minute), int(second), tzinfo=timezone.utc)
    except ValueError:
        raise InputError('line %d: %s is not a real time: %r' % (line, column, text))
    seconds = moment.timestamp() + (int(fraction.ljust(9, '0')) / 1e9 if fraction else 0.0)
    if zone != 'Z':
        sign = 1 if zone[0] == '+' else -1
        seconds -= sign * (int(zone[1:3]) * 3600 + int(zone[4:6]) * 60)
    return seconds


def parse_number(text, column, line, blank_ok, minimum=None, positive=False):
    if text == '':
        if blank_ok:
            return None
        raise InputError('line %d: %s is required' % (line, column))
    if not DECIMAL.match(text):
        raise InputError('line %d: %s is not a plain decimal: %r' % (line, column, text))
    value = float(text)
    if positive and not value > 0:
        raise InputError('line %d: %s must be positive: %r' % (line, column, text))
    if minimum is not None and value < minimum:
        raise InputError('line %d: %s must be at least %s: %r' % (line, column, minimum, text))
    return value


def parse_bool(text, column, line):
    upper = text.upper()
    if upper in ('', 'FALSE'):
        return False
    if upper == 'TRUE':
        return True
    raise InputError('line %d: %s must be TRUE or FALSE: %r' % (line, column, text))


def parse_choice(text, column, line, allowed):
    if text not in allowed:
        raise InputError('line %d: %s has an unknown value: %r' % (line, column, text))
    return text


def parse_row(row, line):
    def get(column):
        value = row.get(column)
        return '' if value is None else value.strip()

    action = get('action_receipt_id')
    if not action:
        raise InputError('line %d: action_receipt_id is required' % line)
    actor_kind = parse_choice(get('actor_kind'), 'actor_kind', line, ('SYSTEM', 'PERSON'))
    actor_id = get('actor_id')
    if not actor_id:
        raise InputError('line %d: actor_id is required' % line)
    owner_id = get('owner_id') or (actor_id if actor_kind == 'PERSON' else '')
    if not owner_id:
        raise InputError('line %d: owner_id is required for a system' % line)
    is_counterpart = parse_bool(get('is_counterpart'), 'is_counterpart', line)
    if is_counterpart and actor_kind != 'SYSTEM':
        raise InputError('line %d: Counterpart must be a SYSTEM' % line)
    published = parse_bool(get('published'), 'published', line)
    handle = get('handle')
    if published and actor_kind == 'SYSTEM' and not handle:
        raise InputError('line %d: a published system needs its handle' % line)
    mode = parse_choice(get('mode'), 'mode', line, MODES)
    close_state = get('close_state')
    mark_source = get('mark_source')
    mark_standard = get('mark_standard')
    if mode == 'PREGAME':
        parse_choice(close_state, 'close_state', line, CLOSE_STATES)
        if mark_source:
            raise InputError('line %d: a pregame decision has no mark_source' % line)
    else:
        if close_state:
            raise InputError('line %d: an in-play decision has no close_state' % line)
        parse_choice(mark_source, 'mark_source', line, MARK_SOURCES)
        if mark_source and not mark_standard:
            raise InputError('line %d: a marked in-play decision needs mark_standard' % line)
    graded_value = (mode == 'PREGAME' and close_state == 'GRADED') or (mode == 'IN_PLAY' and mark_source != '')
    value = parse_number(get('value_credits'), 'value_credits', line, blank_ok=not graded_value)
    if not graded_value:
        value = None
    cycle_id = get('cycle_id')
    week_match = CYCLE_ID.match(cycle_id)
    return Decision(
        line=line, action_receipt_id=action, actor_kind=actor_kind, actor_id=actor_id, owner_id=owner_id,
        system_kind=parse_choice(get('system_kind'), 'system_kind', line, SYSTEM_KINDS),
        is_counterpart=is_counterpart,
        juke_test=parse_bool(get('juke_test'), 'juke_test', line),
        account_removed_for_abuse=parse_bool(get('account_removed_for_abuse'), 'account_removed_for_abuse', line),
        published=published and actor_kind == 'SYSTEM', handle=handle,
        cycle_id=cycle_id, week=week_match.group(1) if week_match else None,
        event_id=get('event_id') or _required('event_id', line),
        start_at=parse_time(get('start_at'), 'start_at', line),
        occurred_at=parse_time(get('occurred_at'), 'occurred_at', line),
        sport_id=get('sport_id') or _required('sport_id', line),
        competition_id=get('competition_id'),
        mode=mode,
        shares=parse_number(get('shares'), 'shares', line, blank_ok=False, positive=True),
        value=value, close_state=close_state, mark_source=mark_source, mark_standard=mark_standard,
        market_result=parse_choice(get('market_result'), 'market_result', line, MARKET_RESULTS),
        is_combo=parse_bool(get('is_combo'), 'is_combo', line),
        market_lifecycle_at_action=parse_choice(get('market_lifecycle_at_action'), 'market_lifecycle_at_action',
                                                line, LIFECYCLES),
        review_status=parse_choice(get('review_status'), 'review_status', line, REVIEW_STATUSES),
        appeal_status=parse_choice(get('appeal_status'), 'appeal_status', line, APPEAL_STATUSES),
        regime=get('regime'),
        seconds_since_game_event=parse_number(get('seconds_since_game_event'), 'seconds_since_game_event', line,
                                              blank_ok=True, minimum=0),
        seconds_to_mid_move=parse_number(get('seconds_to_mid_move'), 'seconds_to_mid_move', line, blank_ok=True,
                                         minimum=0),
    )


def _required(column, line):
    raise InputError('line %d: %s is required' % (line, column))


# What an actor is must not change from row to row: a stray published=TRUE would name a private system.
ACTOR_FIELDS = ('actor_kind', 'owner_id', 'system_kind', 'is_counterpart', 'juke_test', 'account_removed_for_abuse',
                'published', 'handle')


def read_decisions(stream):
    """Every row of the CSV, parsed and checked."""
    reader = csv.DictReader(stream)
    header = reader.fieldnames or []
    missing = [name for name in COLUMN_NAMES if name not in header]
    if missing:
        raise InputError('missing columns: ' + ', '.join(missing))
    decisions = []
    seen = set()
    actors = {}
    for line, row in enumerate(reader, start=2):
        decision = parse_row(row, line)
        if decision.action_receipt_id in seen:
            raise InputError('line %d: action_receipt_id %r appears twice' % (line, decision.action_receipt_id))
        seen.add(decision.action_receipt_id)
        identity = tuple(getattr(decision, name) for name in ACTOR_FIELDS)
        first = actors.setdefault(decision.actor_id, (line, identity))
        if first[1] != identity:
            changed = [name for name, a, b in zip(ACTOR_FIELDS, first[1], identity) if a != b]
            raise InputError('line %d: the actor on line %d has a different %s here'
                             % (line, first[0], ', '.join(changed)))
        decisions.append(decision)
    return decisions


# ---------------------------------------------------------------------------
# Which decisions are graded (section 2)

def abuse_upheld(decision):
    """Flagged and upheld by human review: a REFUSE case not overturned on appeal."""
    return decision.review_status == 'REFUSE' and decision.appeal_status != 'OVERTURNED'


def base_reasons(decision):
    """Every reason, other than grading, that keeps this decision out, in REASONS order."""
    reasons = []
    if decision.week is None:
        reasons.append('outside_season_1')
    if decision.juke_test or decision.actor_id.startswith('juke-test-'):
        reasons.append('juke_test')
    if decision.account_removed_for_abuse:
        reasons.append('account_removed_for_abuse')
    if decision.market_result == 'VOIDED':
        reasons.append('voided')
    if decision.market_result == 'NEUTRAL_50_50':
        reasons.append('fifty_fifty')
    if decision.market_result == '':
        reasons.append('market_not_settled')
    if decision.is_combo:
        reasons.append('combo')
    if decision.market_lifecycle_at_action == 'SUSPENDED':
        reasons.append('suspended')
    if abuse_upheld(decision):
        reasons.append('abuse_upheld')
    return reasons


def grading_reason(decision, marks):
    """Why the decision has no grade under these marks, or None when it is graded."""
    if decision.mode == 'PREGAME':
        return None if decision.close_state == 'GRADED' else CLOSE_REASON[decision.close_state]
    if decision.mark_source in marks:
        return None
    return MARK_REASON.get(decision.mark_source, 'mark_' + decision.mark_source.lower())


def exclusion_reasons(decision, marks=PRIMARY_MARKS):
    reasons = base_reasons(decision)
    grading = grading_reason(decision, marks)
    if grading is not None:
        reasons.append(grading)
    return reasons


def graded(decisions, marks):
    return [d for d in decisions if not exclusion_reasons(d, marks)]


# ---------------------------------------------------------------------------
# The kit's estimate

def game_sums(decisions):
    """Per game: (start, event id, sum of value, sum of shares, decisions), games in start order (R6)."""
    games = {}
    for d in decisions:
        entry = games.get(d.event_id)
        if entry is None:
            games[d.event_id] = entry = [d.start_at, [], [], 0]
        entry[0] = min(entry[0], d.start_at)
        entry[1].append(d.value)
        entry[2].append(d.shares)
        entry[3] += 1
    out = [(start, event, math.fsum(values), math.fsum(shares), count)
           for event, (start, values, shares, count) in games.items()]
    out.sort(key=lambda game: (game[0], game[1]))
    return out


def clustered(clusters):
    """The kit's estimate and game-clustered SE from per-game (value, shares) sums, in points per share.

    This is juke's own arithmetic, unchanged (spec/README.md line 28; spec/source/sharp.ts lines 112-125):
        ratio    = sum of value / sum of shares, both summed by game first
        variance = sum over games of (value_g - ratio x shares_g)^2 / (sum of shares)^2 x G / (G - 1)
        estimate = 100 x ratio,  SE = 100 x sqrt(variance)
    sharp.ts prints the estimate as (ratio * 100).toFixed(4); SE is in the same points. With one game the variance
    has no defined value, so SE is None (R4).
    """
    games = len(clusters)
    total_value = math.fsum(value for value, _ in clusters)
    total_shares = math.fsum(shares for _, shares in clusters)
    if games == 0 or not total_shares > 0:
        return None
    ratio = total_value / total_shares
    se = None
    if games >= 2:
        variance = math.fsum((value - ratio * shares) ** 2 for value, shares in clusters) / (total_shares ** 2) \
            * (games / (games - 1))
        se = 100 * math.sqrt(variance)
    return {'estimate': 100 * ratio, 'se': se, 'games': games}


def estimate(decisions):
    """V and SE for a set of graded decisions (any actors), clustered by game."""
    sums = game_sums(decisions)
    result = clustered([(value, shares) for _, _, value, shares, _ in sums])
    if result is None:
        return None
    result['decisions'] = len(decisions)
    return result


def qualifies(decisions):
    """Section 2: at least 30 graded decisions across at least 15 games."""
    return len(decisions) >= MIN_DECISIONS and len(set(d.event_id for d in decisions)) >= MIN_GAMES


# ---------------------------------------------------------------------------
# Small statistics

def two_sided_p(z):
    """Two-sided normal p for a z or t statistic (R28)."""
    if z is None:
        return None
    return math.erfc(abs(z) / math.sqrt(2.0))


def sign_test_p(first, second):
    """Exact two-sided sign-test p: 2 x P(X <= min) for X ~ Binomial(first + second, 1/2), capped at 1."""
    n = first + second
    if n == 0:
        return Fraction(1)
    smaller = min(first, second)
    tail = sum(math.comb(n, j) for j in range(smaller + 1))
    return min(Fraction(1), Fraction(2 * tail, 2 ** n))


def median(values):
    ordered = sorted(values)
    if not ordered:
        return None
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def median_ratio(ratios):
    """The median of positive ratios, the two middle ones averaged on the log scale (R11)."""
    ordered = sorted(ratios)
    if not ordered:
        return None
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return float(ordered[middle])
    return math.sqrt(float(ordered[middle - 1]) * float(ordered[middle]))


def percentile(ordered, q):
    """Linear interpolation between order statistics (R19)."""
    if not ordered:
        return None
    position = q * (len(ordered) - 1)
    low = int(math.floor(position))
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (position - low) * (ordered[high] - ordered[low])


def average_ranks(values):
    """Ranks 1..n, ties sharing their mean rank."""
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        shared = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = shared
        i = j + 1
    return ranks


def spearman(xs, ys):
    """Spearman's rho: the Pearson correlation of average ranks (R17)."""
    if len(xs) != len(ys) or len(xs) < 3:
        return None
    rx = average_ranks(xs)
    ry = average_ranks(ys)
    mean = (len(xs) + 1) / 2.0
    sxy = math.fsum((a - mean) * (b - mean) for a, b in zip(rx, ry))
    sxx = math.fsum((a - mean) ** 2 for a in rx)
    syy = math.fsum((b - mean) ** 2 for b in ry)
    if sxx == 0 or syy == 0:
        return None
    return sxy / math.sqrt(sxx * syy)


def fisher_pool(correlations):
    """Fisher z average of (rho, n) pairs, weights n - 3 (R18). None when no pair has weight."""
    weighted = []
    for rho, n in correlations:
        if rho is None or n <= 3:
            continue
        capped = max(-RHO_CAP, min(RHO_CAP, rho))
        weighted.append((n - 3, math.atanh(capped)))
    total = sum(weight for weight, _ in weighted)
    if total == 0:
        return None
    return math.tanh(math.fsum(weight * z for weight, z in weighted) / total)


def spearman_brown(rho):
    if rho is None or rho == -1:
        return None
    return 2 * rho / (1 + rho)


def holm(pvalues):
    """Holm step-down adjusted p-values. A missing p counts as 1 (R29)."""
    m = len(pvalues)
    ordered = sorted(((1.0 if p is None else float(p)), name) for name, p in pvalues.items())
    adjusted = {}
    running = 0.0
    for i, (p, name) in enumerate(ordered):
        running = max(running, min(1.0, (m - i) * p))
        adjusted[name] = running
    return adjusted


def kaplan_meier_median(observations):
    """Smallest time at which Kaplan-Meier survival is <= 0.5, or None (R10). observations: (time, separated)."""
    if not observations:
        return None
    at_risk = len(observations)
    survival = Fraction(1)
    for time in sorted(set(time for time, _ in observations)):
        events = sum(1 for t, separated in observations if t == time and separated)
        leaving = sum(1 for t, _ in observations if t == time)
        if events:
            survival *= Fraction(at_risk - events, at_risk)
            if survival <= Fraction(1, 2):
                return time
        at_risk -= leaving
    return None


# ---------------------------------------------------------------------------
# M1: decisions to separation

def separation(decisions):
    """DtS for one actor in one mode: the first look, after a game, with n >= 30, >= 15 games and |V|/SE >= 2.58.

    A system that never separates is censored at its last decision (R6-R9).
    """
    games = game_sums(decisions)
    first_start = games[0][0]
    clusters = []
    n = 0
    for start, _, value, shares, count in games:
        clusters.append((value, shares))
        n += count
        if n >= MIN_DECISIONS and len(clusters) >= MIN_GAMES:
            result = clustered(clusters)
            if is_separated(result['estimate'], result['se']):
                return {'separated': True, 'decisions': n, 'games': len(clusters), 'days': (start - first_start) / DAY,
                        'estimate': result['estimate'], 'se': result['se']}
    result = clustered(clusters)
    return {'separated': False, 'decisions': n, 'games': len(clusters), 'days': (games[-1][0] - first_start) / DAY,
            'estimate': result['estimate'], 'se': result['se']}


def is_separated(value, se):
    if se is None:
        return False
    if se == 0:
        return value != 0
    return abs(value) / se >= SEPARATION_Z


def model_dts(decisions):
    """(2.58 x sigma / mu)^2 from the per-decision points per share (R14)."""
    points = [100 * d.value / d.shares for d in decisions]
    if len(points) < 2:
        return None
    mu = math.fsum(points) / len(points)
    if mu == 0:
        return None
    sigma = math.sqrt(math.fsum((x - mu) ** 2 for x in points) / (len(points) - 1))
    return (SEPARATION_Z * sigma / mu) ** 2


def pair_scores(pairs, theta):
    """Which mode separated first in each pair, with every pregame DtS divided by theta (R12).

    pairs: (pregame DtS, pregame separated, in-play DtS, in-play separated). Returns (in-play first, pregame first).
    """
    in_play_first = pregame_first = 0
    for pre_n, pre_sep, live_n, live_sep in pairs:
        pre = Fraction(pre_n) / theta
        live = Fraction(live_n)
        if pre < live:
            pregame_first += 1 if pre_sep else 0
        elif live < pre:
            in_play_first += 1 if live_sep else 0
        elif pre_sep and not live_sep:
            pregame_first += 1
        elif live_sep and not pre_sep:
            in_play_first += 1
    return in_play_first, pregame_first


def paired_ratio(pairs):
    """The paired ratio DtS_pregame / DtS_in-play, its 95% CI and p, by the paired log-rank comparison (R11-R13).

    The balance (in-play first - pregame first) only changes where theta equals a pair's DtS ratio, so it is read
    at each such ratio and between them. With no censoring the estimate is the median of the per-pair ratios and the
    CI is the sign test's order-statistic interval.
    """
    in_play_first, pregame_first = pair_scores(pairs, Fraction(1))
    p = sign_test_p(in_play_first, pregame_first)
    out = {'in_play_first': in_play_first, 'pregame_first': pregame_first, 'p': p,
           'ratio': None, 'ratio_above': None, 'ratio_below': None, 'ci95': [None, None],
           'ci95_unbounded': [False, False]}
    if not pairs:
        return out
    cuts = sorted(set(Fraction(pre_n, live_n) for pre_n, _, live_n, _ in pairs))
    # Cells in order: below the first cut, each cut, between cuts, above the last cut. (low, high, theta to read at)
    cells = [(Fraction(0), cuts[0], cuts[0] / 2)]
    for i, cut in enumerate(cuts):
        cells.append((cut, cut, cut))
        upper = cuts[i + 1] if i + 1 < len(cuts) else None
        cells.append((cut, upper, (cut + upper) / 2 if upper is not None else cut * 2))
    low_end = high_end = None
    ci_low = ci_high = None
    ci_unbounded_low = ci_unbounded_high = False
    for low, high, theta in cells:
        live, pre = pair_scores(pairs, theta)
        balance = live - pre
        if balance > 0:
            low_end = high
        if balance < 0 and high_end is None:
            high_end = low
        if sign_test_p(live, pre) > ALPHA_EXACT:
            if low == 0:
                ci_unbounded_low = True
            elif ci_low is None:
                ci_low = low
            if high is None:
                ci_unbounded_high = True
            else:
                ci_high = high
    if low_end is not None and high_end is not None:
        out['ratio'] = math.sqrt(float(low_end) * float(high_end))
    elif low_end is not None:
        out['ratio_above'] = float(low_end)
    elif high_end is not None:
        out['ratio_below'] = float(high_end)
    out['ci95'] = [None if ci_unbounded_low or ci_low is None else float(ci_low),
                   None if ci_unbounded_high or ci_high is None else float(ci_high)]
    out['ci95_unbounded'] = [ci_unbounded_low, ci_unbounded_high]
    return out


def ratio_direction(paired):
    """IN_PLAY_FASTER when the paired ratio is above 1, PREGAME_FASTER below 1, EVEN otherwise."""
    if paired['ratio'] is not None:
        value = paired['ratio']
    elif paired['ratio_above'] is not None:
        value = float('inf')
    elif paired['ratio_below'] is not None:
        value = 0.0
    else:
        value = 1.0
    if value > 1:
        return 'IN_PLAY_FASTER'
    if value < 1:
        return 'PREGAME_FASTER'
    return 'EVEN'


def metric_m1(groups, qualifying):
    by_mode = {}
    results = {}
    for mode in MODES:
        actors = sorted(qualifying[mode])
        rows = []
        for actor in actors:
            row = separation(groups[(actor, mode)])
            row['model_dts'] = model_dts(groups[(actor, mode)])
            results[(actor, mode)] = row
            rows.append(row)
        separated_count = sum(1 for row in rows if row['separated'])
        model = [row['model_dts'] for row in rows if row['model_dts'] is not None]
        by_mode[mode] = {
            'systems': len(rows),
            'separated': separated_count,
            'share_separated': separated_count / len(rows) if rows else None,
            'km_median_decisions': kaplan_meier_median([(row['decisions'], row['separated']) for row in rows]),
            'km_median_days': kaplan_meier_median([(row['days'], row['separated']) for row in rows]),
            'model_dts_median': median(model),
            'model_dts_undefined': len(rows) - len(model),
        }
    both = sorted(qualifying['PREGAME'] & qualifying['IN_PLAY'])
    pairs = [(results[(a, 'PREGAME')]['decisions'], results[(a, 'PREGAME')]['separated'],
              results[(a, 'IN_PLAY')]['decisions'], results[(a, 'IN_PLAY')]['separated']) for a in both]
    paired = paired_ratio(pairs)
    both_separated = [Fraction(pre_n, live_n) for pre_n, pre_sep, live_n, live_sep in pairs if pre_sep and live_sep]
    model_ratios = []
    for actor in both:
        pre = results[(actor, 'PREGAME')]['model_dts']
        live = results[(actor, 'IN_PLAY')]['model_dts']
        if pre is not None and live is not None and pre > 0 and live > 0:
            model_ratios.append(pre / live)
    paired.update({
        'systems_in_both_modes': len(both),
        'descriptive_only': len(both) < M1_MIN_PAIRS,
        'direction': ratio_direction(paired),
        'pairs_both_separated': sum(1 for pair in pairs if pair[1] and pair[3]),
        'pairs_only_pregame_separated': sum(1 for pair in pairs if pair[1] and not pair[3]),
        'pairs_only_in_play_separated': sum(1 for pair in pairs if pair[3] and not pair[1]),
        'pairs_neither_separated': sum(1 for pair in pairs if not pair[1] and not pair[3]),
        'median_ratio_both_separated': median_ratio(both_separated),
        'model_dts_median_ratio': median_ratio(model_ratios),
    })
    return {'by_mode': by_mode, 'paired': paired}, results


# ---------------------------------------------------------------------------
# M2: Week-to-Week stability

def week_estimates(decisions):
    out = {}
    for week, items in sorted(by_key(decisions, lambda d: d.week).items()):
        result = estimate(items)
        if result is not None:
            out[week] = result
    return out


def week_pairs(weekly):
    """Each consecutive Week pair and its systems with >= 20 decisions across >= 4 games in both Weeks."""
    pairs = []
    for first, second in zip(SEASON_WEEKS, SEASON_WEEKS[1:]):
        members = {}
        for actor in sorted(weekly):
            a = weekly[actor].get(first)
            b = weekly[actor].get(second)
            if a and b and a['decisions'] >= WEEK_MIN_DECISIONS and a['games'] >= WEEK_MIN_GAMES \
                    and b['decisions'] >= WEEK_MIN_DECISIONS and b['games'] >= WEEK_MIN_GAMES:
                members[actor] = (a['estimate'], b['estimate'])
        pairs.append((first, second, members))
    return pairs


def pooled_rho(pairs, sample):
    stats = []
    for _, _, members in pairs:
        xs = []
        ys = []
        for actor in sample:
            values = members.get(actor)
            if values is not None:
                xs.append(values[0])
                ys.append(values[1])
        stats.append((spearman(xs, ys), len(xs)))
    return fisher_pool(stats)


def bootstrap_rho(pairs, resamples, rng):
    """Resample systems with replacement and pool again (R19, R20)."""
    units = sorted(set(actor for _, _, members in pairs for actor in members))
    count = len(units)
    values = []
    undefined = 0
    if count:
        for _ in range(resamples):
            sample = [units[int(rng.random() * count)] for _ in range(count)]
            value = pooled_rho(pairs, sample)
            if value is None:
                undefined += 1
            else:
                values.append(value)
    values.sort()
    out = {'resamples': resamples, 'undefined_resamples': undefined if count else resamples,
           'ci95': [percentile(values, 0.025), percentile(values, 0.975)], 'p': None}
    if values:
        below = sum(1 for value in values if value <= 0)
        above = sum(1 for value in values if value >= 0)
        out['p'] = min(1.0, 2.0 * (1 + min(below, above)) / (len(values) + 1))
    return out


def split_half(groups, actors, mode):
    """Odd-numbered against even-numbered games of each system, Spearman-Brown corrected (R23)."""
    xs = []
    ys = []
    for actor in sorted(actors):
        decisions = groups[(actor, mode)]
        order = {event: i for i, (_, event, _, _, _) in enumerate(game_sums(decisions))}
        odd = estimate([d for d in decisions if order[d.event_id] % 2 == 0])
        even = estimate([d for d in decisions if order[d.event_id] % 2 == 1])
        if odd is not None and even is not None:
            xs.append(odd['estimate'])
            ys.append(even['estimate'])
    rho = spearman(xs, ys)
    return {'systems': len(xs), 'rho': rho, 'spearman_brown': spearman_brown(rho)}


def metric_m2(groups, qualifying, resamples, seed_label):
    out = {}
    for mode in MODES:
        weekly = {actor: week_estimates(groups[(actor, mode)]) for actor in qualifying[mode]}
        pairs = week_pairs(weekly)
        per_pair = []
        for first, second, members in pairs:
            ordered = sorted(members)
            rho = spearman([members[a][0] for a in ordered], [members[a][1] for a in ordered])
            per_pair.append({'weeks': [first, second], 'systems': len(members), 'rho': rho})
        units = sorted(set(actor for _, _, members in pairs for actor in members))
        rng = random.Random('%d:%s:%s' % (SEED, seed_label, mode))
        boot = bootstrap_rho(pairs, resamples, rng)
        out[mode] = {
            'week_pairs': per_pair,
            'systems': len(units),
            'pooled_rho': pooled_rho(pairs, units),
            'ci95': boot['ci95'],
            'p': boot['p'],
            'bootstrap': {'resamples': boot['resamples'], 'undefined_resamples': boot['undefined_resamples'],
                          'seed': '%d:%s:%s' % (SEED, seed_label, mode)},
            'split_half': split_half(groups, qualifying[mode], mode),
        }
    return out


# ---------------------------------------------------------------------------
# M3: top minus bottom, out of sample

def speed_kept(decision, window):
    """False when the decision falls inside the speed window (R26)."""
    if decision.seconds_since_game_event is not None and decision.seconds_since_game_event <= window:
        return False
    if decision.seconds_to_mid_move is not None and decision.seconds_to_mid_move <= window:
        return False
    return True


def quartile_size(ranked):
    """Rounded down, minimum 4 each; None when top and bottom would overlap."""
    size = max(QUARTILE_MIN, ranked // 4)
    return size if 2 * size <= ranked else None


def contrast(weighted_systems):
    """D = sum of w_s x V_s with its game-clustered SE, in points (R25).

    Each game's effect on D is sum of w_s x (value_sg - ratio_s x shares_sg) / shares_s over the systems that played
    it; the variance is the sum of squares of those effects x G / (G - 1). For one system with w = 1 this is the
    kit's variance exactly (spec/source/sharp.ts lines 118-121).
    """
    games = {}
    total = []
    for decisions, weight in weighted_systems:
        sums = game_sums(decisions)
        shares = math.fsum(s for _, _, _, s, _ in sums)
        ratio = math.fsum(v for _, _, v, _, _ in sums) / shares
        total.append(weight * ratio)
        for _, event, value, game_shares, _ in sums:
            games.setdefault(event, []).append(weight * (value - ratio * game_shares) / shares)
    difference = 100 * math.fsum(total)
    count = len(games)
    if count < 2:
        return difference, None, count
    variance = math.fsum(math.fsum(parts) ** 2 for parts in games.values()) * (count / (count - 1))
    return difference, 100 * math.sqrt(variance), count


def m3_spread(decisions):
    """M3 for one mode's decisions (already filtered): rank on Weeks 1-2, compare on Weeks 3-4 (R24, R25)."""
    groups = by_key(decisions, lambda d: d.actor_id)
    rankable = []
    for actor in sorted(groups):
        items = groups[actor]
        if not qualifies(items):
            continue
        early = [d for d in items if d.week in RANKING_WEEKS]
        late = [d for d in items if d.week in OUT_OF_SAMPLE_WEEKS]
        if early and late:
            rankable.append((actor, estimate(early)['estimate'], late))
    size = quartile_size(len(rankable))
    out = {'ranked_systems': len(rankable), 'quartile_size': size, 'D': None, 'se': None, 't': None, 'p': None,
           'games': None, 'v_top': None, 'v_bottom': None, 'v_top_weeks_1_2': None, 'v_bottom_weeks_1_2': None}
    if size is None:
        out['reason'] = 'fewer than %d qualifying systems with graded decisions in both Weeks 1-2 and Weeks 3-4' \
            % (2 * QUARTILE_MIN)
        return out
    ranked = sorted(rankable, key=lambda row: (-row[1], row[0]))
    top = ranked[:size]
    bottom = ranked[-size:]
    difference, se, games = contrast([(row[2], 1.0 / size) for row in top] + [(row[2], -1.0 / size) for row in bottom])
    out.update({
        'D': difference, 'se': se, 'games': games,
        'v_top': math.fsum(estimate(row[2])['estimate'] for row in top) / size,
        'v_bottom': math.fsum(estimate(row[2])['estimate'] for row in bottom) / size,
        'v_top_weeks_1_2': math.fsum(row[1] for row in top) / size,
        'v_bottom_weeks_1_2': math.fsum(row[1] for row in bottom) / size,
    })
    if se is None or se == 0:
        out['reason'] = 'no standard error (fewer than 2 games or no variation)'
    else:
        out['t'] = difference / se
        out['p'] = two_sided_p(out['t'])
    return out


def metric_m3(decisions):
    out = {}
    for mode in MODES:
        in_mode = [d for d in decisions if d.mode == mode]
        raw = m3_spread(in_mode)
        adjusted = {}
        for window in SPEED_WINDOWS:
            kept = [d for d in in_mode if speed_kept(d, window)]
            result = m3_spread(kept)
            result['decisions_removed'] = len(in_mode) - len(kept)
            adjusted[str(window)] = result
        primary = adjusted[str(PRIMARY_SPEED_WINDOW)]
        out[mode] = {
            'raw': raw,
            'speed_adjusted': adjusted,
            'primary_window_seconds': PRIMARY_SPEED_WINDOW,
            'raw_spread_disappears': raw['D'] is not None and raw['D'] > 0
            and primary['D'] is not None and primary['D'] <= 0,
        }
    return out


# ---------------------------------------------------------------------------
# One population, all three metrics

def by_key(items, key):
    groups = {}
    for item in items:
        groups.setdefault(key(item), []).append(item)
    return groups


def analyse(decisions, resamples=RESAMPLES, seed_label='primary'):
    """M1, M2 and M3 for one population of graded decisions."""
    groups = by_key(decisions, lambda d: (d.actor_id, d.mode))
    qualifying = {mode: set() for mode in MODES}
    population = {}
    for mode in MODES:
        actors = sorted(actor for actor, m in groups if m == mode)
        for actor in actors:
            if qualifies(groups[(actor, mode)]):
                qualifying[mode].add(actor)
        in_mode = [d for d in decisions if d.mode == mode]
        population[mode] = {
            'actors_with_graded_decisions': len(actors),
            'qualifying': len(qualifying[mode]),
            'graded_decisions': len(in_mode),
            'games': len(set(d.event_id for d in in_mode)),
        }
    population['qualifying_in_both_modes'] = len(qualifying['PREGAME'] & qualifying['IN_PLAY'])
    kinds = {}
    for actor in sorted(qualifying['PREGAME'] | qualifying['IN_PLAY']):
        kind = next(d.system_kind for mode in MODES for d in groups.get((actor, mode), [])) or 'NONE'
        kinds[kind] = kinds.get(kind, 0) + 1
    population['qualifying_by_system_kind'] = kinds
    m1, separations = metric_m1(groups, qualifying)
    return {
        'population': population,
        'M1': m1,
        'M2': metric_m2(groups, qualifying, resamples, seed_label),
        'M3': metric_m3(decisions),
    }, separations


# ---------------------------------------------------------------------------
# Section 6: labels

def label_m1(m1, holm_p):
    paired = m1['paired']
    if paired['descriptive_only']:
        return 'Inconclusive', 'fewer than %d systems qualify in both modes: M1 is descriptive (section 5)' \
            % M1_MIN_PAIRS
    if holm_p < ALPHA and paired['direction'] == 'IN_PLAY_FASTER':
        return 'Support', 'paired ratio > 1 with Holm-adjusted p < 0.05'
    if holm_p < ALPHA and paired['direction'] == 'PREGAME_FASTER':
        return 'Failure', 'paired ratio < 1 with Holm-adjusted p < 0.05'
    return 'Inconclusive', 'Holm-adjusted p >= 0.05' if holm_p >= ALPHA else 'the paired ratio is exactly 1'


def label_m2(m2):
    live = m2['IN_PLAY']
    pre = m2['PREGAME']
    rho = live['pooled_rho']
    low, high = live['ci95']
    if live['systems'] < M2_MIN_SYSTEMS:
        return 'Inconclusive', 'n < %d systems in the in-play Week pairs' % M2_MIN_SYSTEMS
    if rho is None:
        return 'Inconclusive', 'pooled in-play rho not computed'
    if rho >= 0.3 and low is not None and low > 0 and pre['pooled_rho'] is not None \
            and rho >= pre['pooled_rho'] - 0.15:
        return 'Support', 'pooled in-play rho >= 0.3, CI excludes 0, not more than 0.15 below pregame rho'
    if rho <= 0 and high is not None and high < 0.2:
        return 'Failure', 'pooled in-play rho <= 0 and the CI excludes values >= 0.2'
    if low is not None and high is not None and low <= 0 <= high:
        return 'Inconclusive', 'the CI includes 0'
    return 'Inconclusive', 'neither Support nor Failure applies'


def label_m3(m3):
    raw = m3['IN_PLAY']['raw']
    adjusted = m3['IN_PLAY']['speed_adjusted'][str(PRIMARY_SPEED_WINDOW)]
    t = adjusted['t']
    if t is None:
        return 'Inconclusive', 'speed-adjusted in-play t not computed: ' + adjusted.get('reason', 'no data')
    if t >= 2:
        return 'Support', 'speed-adjusted in-play t >= 2'
    if t <= 0:
        return 'Failure', 'speed-adjusted in-play t <= 0'
    if m3['IN_PLAY']['raw_spread_disappears']:
        return 'Failure', 'the raw spread disappears after the speed adjustment'
    return 'Inconclusive', '0 < speed-adjusted in-play t < 2'


def primary_tests(result):
    m1 = result['M1']
    m2 = result['M2']
    m3 = result['M3']
    m1_p = None if m1['paired']['descriptive_only'] else m1['paired']['p']
    m3_primary = m3['IN_PLAY']['speed_adjusted'][str(PRIMARY_SPEED_WINDOW)]
    pvalues = {'M1': m1_p, 'M2': m2['IN_PLAY']['p'], 'M3': m3_primary['p']}
    adjusted = holm(pvalues)
    tests = {}
    label, reason = label_m1(m1, adjusted['M1'])
    tests['M1'] = {'statistic': 'paired ratio DtS_pregame / DtS_in-play', 'value': m1['paired']['ratio'],
                   'value_above': m1['paired']['ratio_above'], 'value_below': m1['paired']['ratio_below'],
                   'direction': m1['paired']['direction'], 'ci95': m1['paired']['ci95'], 'p': m1_p,
                   'descriptive_p': m1['paired']['p'], 'holm_p': adjusted['M1'], 'label': label,
                   'reason': reason}
    label, reason = label_m2(m2)
    tests['M2'] = {'statistic': 'pooled in-play Spearman rho', 'value': m2['IN_PLAY']['pooled_rho'],
                   'ci95': m2['IN_PLAY']['ci95'], 'pregame_value': m2['PREGAME']['pooled_rho'],
                   'p': m2['IN_PLAY']['p'], 'holm_p': adjusted['M2'], 'label': label, 'reason': reason}
    label, reason = label_m3(m3)
    tests['M3'] = {'statistic': 'speed-adjusted in-play t (60 s)', 'value': m3_primary['t'], 'D': m3_primary['D'],
                   'raw_t': m3['IN_PLAY']['raw']['t'], 'p': m3_primary['p'], 'holm_p': adjusted['M3'],
                   'label': label, 'reason': reason}
    tests['holm'] = {'tests': 3, 'alpha': ALPHA, 'missing_p_counts_as': 1}
    return tests


# ---------------------------------------------------------------------------
# Rows of their own: Counterpart and published systems

def actor_summary(decisions):
    out = {}
    for mode in MODES:
        items = [d for d in decisions if d.mode == mode]
        if not items:
            out[mode] = {'decisions': 0}
            continue
        result = estimate(items)
        row = {'decisions': len(items), 'games': result['games'], 'V': result['estimate'], 'se': result['se'],
               'qualifies': qualifies(items), 'model_dts': model_dts(items),
               'by_week': {week: {'decisions': r['decisions'], 'games': r['games'], 'V': r['estimate']}
                           for week, r in week_estimates(items).items()}}
        found = separation(items)
        row.update({'separated': found['separated'], 'dts': found['decisions'], 'days': found['days']})
        out[mode] = row
    return out


def published_rows(decisions):
    rows = []
    for actor, items in sorted(by_key(decisions, lambda d: d.actor_id).items()):
        if items[0].published:
            rows.append({'handle': items[0].handle, 'system_kind': items[0].system_kind or None,
                         'summary': actor_summary(items)})
    rows.sort(key=lambda row: row['handle'])
    return rows


def by_week_counts(decisions):
    out = {}
    for week in SEASON_WEEKS:
        out[week] = {}
        for mode in MODES:
            items = [d for d in decisions if d.week == week and d.mode == mode]
            out[week][mode] = {'decisions': len(items), 'games': len(set(d.event_id for d in items)),
                               'actors': len(set(d.actor_id for d in items))}
    return out


# ---------------------------------------------------------------------------
# The whole run

def sport_group(decision):
    return COMPETITION_GROUPS.get(decision.competition_id) or SPORT_GROUPS.get(decision.sport_id) \
        or decision.sport_id


def one_per_owner(decisions):
    """Keep each owner's system with the most graded decisions (R32)."""
    counts = {}
    owner = {}
    for d in decisions:
        counts[d.actor_id] = counts.get(d.actor_id, 0) + 1
        owner[d.actor_id] = d.owner_id
    best = {}
    for actor in sorted(counts):
        current = best.get(owner[actor])
        if current is None or counts[actor] > counts[current]:
            best[owner[actor]] = actor
    keep = set(best.values())
    return [d for d in decisions if d.actor_id in keep], len(counts) - len(keep)


def is_post_change(decision):
    return decision.regime not in ('', 'PRE_CHANGE')


def count_exclusions(decisions):
    first = dict((reason, 0) for reason in REASONS)
    every = dict((reason, 0) for reason in REASONS)
    graded_counts = {'systems': 0, 'people': 0, 'counterpart': 0}
    for d in decisions:
        reasons = exclusion_reasons(d, PRIMARY_MARKS)
        if reasons:
            first[reasons[0]] += 1
            for reason in reasons:
                every[reason] += 1
        elif d.is_counterpart:
            graded_counts['counterpart'] += 1
        elif d.actor_kind == 'SYSTEM':
            graded_counts['systems'] += 1
        else:
            graded_counts['people'] += 1
    return {'rows': len(decisions), 'excluded': sum(first.values()), 'by_first_reason': first,
            'by_reason': every, 'graded_primary': graded_counts, 'reason_order': list(REASONS)}


def count_abuse(decisions):
    removed = set(d.actor_id for d in decisions if d.account_removed_for_abuse)
    return {
        'flags_upheld': sum(1 for d in decisions if abuse_upheld(d)),
        'flags_upheld_appeal_pending': sum(1 for d in decisions if abuse_upheld(d) and d.appeal_status == 'PENDING'),
        'flags_overturned_on_appeal': sum(1 for d in decisions
                                          if d.review_status == 'REFUSE' and d.appeal_status == 'OVERTURNED'),
        'flags_cleared': sum(1 for d in decisions if d.review_status == 'CLEARED'),
        'flags_open': sum(1 for d in decisions if d.review_status == 'HOLD'),
        'accounts_removed': len(removed),
        'decisions_of_removed_accounts': sum(1 for d in decisions if d.account_removed_for_abuse),
    }


def diagnostics(decisions):
    standards = {}
    regimes = {}
    groups = {}
    mismatch = 0
    for d in decisions:
        if d.mode == 'IN_PLAY' and d.mark_source:
            standards[d.mark_standard] = standards.get(d.mark_standard, 0) + 1
        regimes[d.regime or 'PRE_CHANGE'] = regimes.get(d.regime or 'PRE_CHANGE', 0) + 1
        group = sport_group(d)
        groups[group] = groups.get(group, 0) + 1
        if (d.mode == 'PREGAME') != (d.occurred_at < d.start_at):
            mismatch += 1
    return {'marked_in_play_rows_by_standard': standards, 'registered_mark_standard': LIVE_MARK_STANDARD,
            'rows_by_regime': regimes, 'rows_by_sport_group': groups, 'rows_mode_disagrees_with_times': mismatch}


def population_split(decisions, marks):
    systems = []
    people = []
    counterpart = []
    for d in graded(decisions, marks):
        if d.is_counterpart:
            counterpart.append(d)
        elif d.actor_kind == 'SYSTEM':
            systems.append(d)
        else:
            people.append(d)
    return systems, people, counterpart


def sensitivity(decisions, systems, people, resamples):
    out = {}
    for name, marks in (('marks_last_fair_at_trade', MARKS_WITH_LAST_FAIR_AT_TRADE),
                        ('marks_last_fair_at_trade_result', MARKS_WITH_RESULT)):
        wider, _, _ = population_split(decisions, marks)
        result, _ = analyse(wider, resamples, name)
        result['marks'] = sorted(marks)
        out[name] = result
    kept, dropped = one_per_owner(systems)
    result, _ = analyse(kept, resamples, 'one_system_per_owner')
    result['systems_dropped'] = dropped
    out['one_system_per_owner'] = result
    post = [d for d in systems if is_post_change(d)]
    result, _ = analyse(post, resamples, 'post_engineering_change')
    result['decisions'] = len(post)
    if not post:
        result['reason'] = 'no decisions carry a post-change regime flag'
    out['post_engineering_change'] = result
    by_sport = {}
    for group, items in sorted(by_key(systems, sport_group).items()):
        result, _ = analyse(items, resamples, 'sport:' + group)
        result['decisions'] = len(items)
        by_sport[group] = result
    for named in ('NFL', 'college football', 'soccer'):
        if named not in by_sport:
            by_sport[named] = {'decisions': 0, 'reason': 'no graded decisions'}
    out['by_sport'] = by_sport
    result, _ = analyse(people, resamples, 'people')
    result['note'] = 'people instead of systems: the secondary population (section 2)'
    out['people'] = result
    return out


def run(stream, input_name, input_sha256, resamples=RESAMPLES):
    """The full analysis of one CSV stream. Returns the result as plain JSON-ready data."""
    decisions = read_decisions(stream)
    systems, people, counterpart = population_split(decisions, PRIMARY_MARKS)
    primary, _ = analyse(systems, resamples, 'primary')
    primary['tests'] = primary_tests(primary)
    primary['published_systems'] = published_rows(systems)
    primary['by_week'] = by_week_counts(systems)
    result = {
        'contract': CONTRACT,
        'registration': REGISTRATION,
        'script_sha256': script_sha256(),
        'input': {'name': input_name, 'sha256': input_sha256, 'rows': len(decisions)},
        'settings': {
            'seed': SEED, 'resamples': resamples, 'separation_z': SEPARATION_Z,
            'minimum': {'decisions': MIN_DECISIONS, 'games': MIN_GAMES},
            'week_minimum': {'decisions': WEEK_MIN_DECISIONS, 'games': WEEK_MIN_GAMES},
            'speed_windows_seconds': list(SPEED_WINDOWS), 'primary_speed_window_seconds': PRIMARY_SPEED_WINDOW,
            'primary_marks': sorted(PRIMARY_MARKS), 'season_weeks': list(SEASON_WEEKS),
            'ranking_weeks': list(RANKING_WEEKS), 'out_of_sample_weeks': list(OUT_OF_SAMPLE_WEEKS),
        },
        'exclusions': count_exclusions(decisions),
        'abuse': count_abuse(decisions),
        'diagnostics': diagnostics(decisions),
        'primary': primary,
        'counterpart_baseline': actor_summary(counterpart) if counterpart else {'decisions': 0},
        'sensitivity': sensitivity(decisions, systems, people, resamples),
    }
    return clean(result)


def clean(value):
    """JSON-ready: exact fractions to floats, every float to 10 significant digits, nothing infinite."""
    if isinstance(value, dict):
        return dict((str(key), clean(item)) for key, item in value.items())
    if isinstance(value, (list, tuple)):
        return [clean(item) for item in value]
    if isinstance(value, bool) or value is None or isinstance(value, (int, str)) and not isinstance(value, Fraction):
        return value
    if isinstance(value, (float, Fraction)):
        number = float(value)
        if not math.isfinite(number):
            return None
        return float('%.10g' % number)
    raise TypeError('cannot write %r' % (value,))


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def script_sha256():
    try:
        return file_sha256(os.path.abspath(__file__))
    except (NameError, OSError):
        return None


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        sys.stderr.write('usage: python3 season1_analysis.py decisions.csv > results.json\n')
        return 2
    path = argv[0]
    try:
        digest = file_sha256(path)
        with io.open(path, newline='', encoding='utf-8-sig') as stream:
            result = run(stream, os.path.basename(path), digest)
    except InputError as error:
        sys.stderr.write('season1_analysis: %s\n' % error)
        return 2
    sys.stdout.write(json.dumps(result, indent=2, sort_keys=True, allow_nan=False))
    sys.stdout.write('\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
