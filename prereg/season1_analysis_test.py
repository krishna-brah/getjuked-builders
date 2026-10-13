#!/usr/bin/env python3
"""Tests for season1_analysis.py. Synthetic data only: no real systems, people, games or prices.

Run: python3 season1_analysis_test.py

Every expected value here is worked out by hand (the arithmetic is in the comments) or by an independent formula
written in this file, never by running the script and pasting its output. The kit vector tests read the kit's own
spec/ folder: next to this file's folder in the kit, or wherever JUKE_KIT_SPEC points.
"""

import csv
import importlib.util
import io
import itertools
import json
import math
import os
import random
import statistics
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('season1_analysis', str(HERE / 'season1_analysis.py'))
analysis = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(analysis)

SPEC = Path(os.environ.get('JUKE_KIT_SPEC') or (HERE.parent / 'spec'))
UTC = timezone.utc
BASE = datetime(2026, 10, 14, 12, 0, tzinfo=UTC)
WEEK_BOUNDARIES = [datetime(2026, 10, 14, 11, tzinfo=UTC), datetime(2026, 10, 21, 11, tzinfo=UTC),
                   datetime(2026, 10, 28, 11, tzinfo=UTC), datetime(2026, 11, 4, 12, tzinfo=UTC),
                   datetime(2026, 11, 11, 12, tzinfo=UTC)]
_ids = itertools.count(1)


def stamp(moment):
    return moment.strftime('%Y-%m-%dT%H:%M:%SZ')


def cycle(moment):
    for i in range(4):
        if WEEK_BOUNDARIES[i] <= moment < WEEK_BOUNDARIES[i + 1]:
            return 'program:season-1-2026-10-14:W%d' % (i + 1)
    return 'program:synthetic-outside:W1'


def row(**fields):
    """One synthetic in-play decision, graded LIVE, with any field overridden."""
    start = fields.pop('start', BASE)
    base = {
        'action_receipt_id': 'synthetic:a:%d' % next(_ids), 'actor_kind': 'SYSTEM', 'actor_id': 'sys_synthetic01',
        'owner_id': 'owner-synthetic-1', 'system_kind': 'BUILDER', 'is_counterpart': 'FALSE', 'juke_test': 'FALSE',
        'account_removed_for_abuse': 'FALSE', 'published': 'FALSE', 'handle': '', 'cycle_id': cycle(start),
        'event_id': 'synthetic:e:1', 'start_at': stamp(start), 'occurred_at': stamp(start + timedelta(minutes=30)),
        'sport_id': 'sport:football', 'competition_id': 'series:12185', 'mode': 'IN_PLAY', 'shares': '10',
        'value_credits': '1', 'close_state': '', 'mark_source': 'LIVE',
        'mark_standard': 'juke.live-mark.provisional.v2', 'market_result': 'YES', 'is_combo': 'FALSE',
        'market_lifecycle_at_action': 'OPEN', 'review_status': '', 'appeal_status': '', 'regime': '',
        'seconds_since_game_event': '', 'seconds_to_mid_move': '',
    }
    base.update(fields)
    return base


def pregame(**fields):
    """One synthetic pregame decision, graded against a good close."""
    start = fields.get('start', BASE)
    defaults = {'mode': 'PREGAME', 'close_state': 'GRADED', 'mark_source': '', 'mark_standard': '',
                'occurred_at': stamp(start - timedelta(hours=1))}
    defaults.update(fields)
    return row(**defaults)


def csv_text(rows, columns=None):
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=list(columns or analysis.COLUMN_NAMES), lineterminator='\n',
                            extrasaction='ignore')
    writer.writeheader()
    writer.writerows(rows)
    return out.getvalue()


def parse(rows):
    return analysis.read_decisions(io.StringIO(csv_text(rows)))


def games_of(totals, actor='sys_synthetic01', hours_apart=12, per_game=1, mode='IN_PLAY', shares=10, first=0):
    """Rows for one actor: game i has `per_game` decisions whose values add up to totals[i]."""
    rows = []
    for i, total in enumerate(totals):
        start = BASE + timedelta(hours=hours_apart * (first + i))
        for _ in range(per_game):
            fields = {'actor_id': actor, 'event_id': 'synthetic:e:%s:%d' % (actor, first + i), 'start': start,
                      'shares': str(shares), 'value_credits': repr(total / per_game)}
            rows.append(pregame(**fields) if mode == 'PREGAME' else row(**fields))
    return rows


def closed_form_z(game_totals):
    """|V| / SE when every game has the same shares: mean(v_g) x sqrt(G) / sd(v_g). Independent of the script."""
    mean = statistics.mean(game_totals)
    sd = statistics.stdev(game_totals)
    return abs(mean) * math.sqrt(len(game_totals)) / sd


def fisher(r):
    return 0.5 * math.log((1 + r) / (1 - r))


def inverse_fisher(z):
    return (math.exp(2 * z) - 1) / (math.exp(2 * z) + 1)


class EstimateTests(unittest.TestCase):
    def test_v_and_game_clustered_se_by_hand(self):
        # Four decisions in three games: g1 (2 Credits, 10 shares) and (-1, 10); g2 (3, 10); g3 (-2, 20).
        # Sum of value = 2, sum of shares = 50, ratio = 0.04, so V = 4 points per share.
        # Game sums: g1 (1, 20), g2 (3, 10), g3 (-2, 20). Residuals v_g - 0.04 s_g: 0.2, 2.6, -2.8.
        # Sum of squares = 0.04 + 6.76 + 7.84 = 14.64. Variance = 14.64 / 50^2 x 3/2 = 0.008784.
        # SE = 100 x sqrt(0.008784) = 9.3723 points.
        rows = [row(event_id='synthetic:g1', value_credits='2'), row(event_id='synthetic:g1', value_credits='-1'),
                row(event_id='synthetic:g2', value_credits='3'),
                row(event_id='synthetic:g3', value_credits='-2', shares='20')]
        result = analysis.estimate(parse(rows))
        self.assertAlmostEqual(result['estimate'], 4.0, places=12)
        self.assertAlmostEqual(result['se'], 100 * math.sqrt(14.64 / 2500 * 1.5), places=12)
        self.assertAlmostEqual(result['se'], 9.3723, places=4)
        self.assertEqual((result['games'], result['decisions']), (3, 4))
        # Clustering matters: treating the four decisions as four games gives a different SE.
        unclustered = analysis.estimate(parse([dict(r, event_id='synthetic:solo:%d' % i, action_receipt_id='synthetic:u:%d' % i)
                                               for i, r in enumerate(rows)]))
        self.assertNotAlmostEqual(unclustered['se'], result['se'], places=3)

    def test_one_game_has_no_standard_error(self):
        result = analysis.estimate(parse([row(value_credits='2'), row(value_credits='1')]))
        self.assertAlmostEqual(result['estimate'], 15.0, places=12)  # 100 x 3 / 20
        self.assertIsNone(result['se'])


class KitVectorTests(unittest.TestCase):
    """The kit's own vectors, reproduced through this script's functions."""

    def vectors(self, name):
        path = SPEC / name
        if not path.exists():
            self.skipTest('kit spec not found at %s (set JUKE_KIT_SPEC)' % SPEC)
        with path.open() as handle:
            return json.load(handle)

    def test_price_block_value_per_share(self):
        # vectors-price-blocks.json: for a side whose in-play actions are all buys marked LIVE, the block's
        # live.entryPoints is 100 x (mark - average buy price) per share bought, which is 100 x sum(credits) /
        # sum(shares): the script's V over those decisions. The same holds pregame for a GRADED all-buy side and
        # closingValue.entryPoints. Each action's Credits are rounded to a micro, so the tolerance is 2e-6 points.
        live_checked = pregame_checked = 0
        for case_index, case in enumerate(self.vectors('vectors-price-blocks.json')):
            trades = dict((trade['actionReceiptId'], trade) for trade in case['input']['trades'])
            for block in case['expected']:
                live = block.get('live')
                if live and live['actions'] and live['entryPoints'] is not None and all(
                        a['markSource'] == 'LIVE' and trades[a['actionReceiptId']]['cashFlow'] == 'DEBIT'
                        for a in live['actions']):
                    rows = [row(event_id='synthetic:vector:%d' % case_index, value_credits=a['credits'],
                                shares=trades[a['actionReceiptId']]['shares']) for a in live['actions']]
                    self.assertAlmostEqual(analysis.estimate(parse(rows))['estimate'], float(live['entryPoints']),
                                           delta=2e-6, msg='case %d live' % case_index)
                    live_checked += 1
                if block['state'] == 'GRADED' and block['actions'] and block['closingValue']['entryPoints'] is not None \
                        and all(trades[a['actionReceiptId']]['cashFlow'] == 'DEBIT' for a in block['actions']):
                    rows = [pregame(event_id='synthetic:vector:%d' % case_index, value_credits=a['credits'],
                                    shares=trades[a['actionReceiptId']]['shares']) for a in block['actions']]
                    self.assertAlmostEqual(analysis.estimate(parse(rows))['estimate'],
                                           float(block['closingValue']['entryPoints']), delta=2e-6,
                                           msg='case %d pregame' % case_index)
                    pregame_checked += 1
        self.assertEqual((live_checked, pregame_checked), (22, 5))

    def test_capability_z_through_two_sided_p(self):
        # vectors-capability-z.json: z(k, looks) solves Phi(z) = 1 - 0.05 / (2 k looks), so the two-sided p of
        # each expected z is 0.05 / (k looks).
        cases = self.vectors('vectors-capability-z.json')
        self.assertEqual(len(cases), 30)
        for case in cases:
            expected = 0.05 / (case['k'] * case['looks'])
            self.assertAlmostEqual(analysis.two_sided_p(case['expected']) / expected, 1.0, delta=1e-9)


class SeparationTests(unittest.TestCase):
    def test_late_separation_found_at_the_first_passing_look(self):
        # One decision per game, 10 shares. Games 1-30 alternate +2 and -2 Credits; then every game is +2.
        # Closed form (equal shares): z = mean x sqrt(G) / sd. With k games of +2 after the 30:
        #   G = 46 (k = 16): mean 32/46, sd^2 = (184 - 32^2/46)/45 = 3.594203, z = 2.488684, below 2.58;
        #   G = 47 (k = 17): mean 34/47, sd^2 = (188 - 34^2/47)/46 = 3.552267, z = 2.631342, separated.
        totals = [2.0 if i % 2 == 0 else -2.0 for i in range(30)] + [2.0] * 20
        expected = next(g for g in range(30, 51) if closed_form_z(totals[:g]) >= 2.58)
        self.assertEqual(expected, 47)
        self.assertAlmostEqual(closed_form_z(totals[:46]), 2.488684, places=5)
        self.assertAlmostEqual(closed_form_z(totals[:47]), 2.631342, places=5)
        result = analysis.separation(parse(games_of(totals)))
        self.assertTrue(result['separated'])
        self.assertEqual((result['decisions'], result['games']), (47, 47))
        self.assertAlmostEqual(result['days'], 46 * 0.5, places=9)  # games 12 hours apart

    def test_fifteen_games_are_needed_as_well_as_thirty_decisions(self):
        # Three decisions per game, game sums alternate 3.6 and 2.4 Credits on 30 shares. Thirty decisions are in
        # after game 10, but the first look with 15 games is after game 15 (45 decisions). There the closed form
        # gives mean 3.04, sd^2 = (8 x 0.56^2 + 7 x 0.64^2) / 14 = 0.384, z = 3.04 x sqrt(15) / 0.6197 = 19.0.
        totals = [3.6 if i % 2 == 0 else 2.4 for i in range(20)]
        self.assertAlmostEqual(closed_form_z(totals[:15]), 3.04 * math.sqrt(15) / math.sqrt(0.384), places=9)
        result = analysis.separation(parse(games_of(totals, per_game=3)))
        self.assertTrue(result['separated'])
        self.assertEqual((result['decisions'], result['games']), (45, 15))
        self.assertAlmostEqual(result['days'], 14 * 0.5, places=9)

    def test_never_separating_system_is_censored_at_its_last_decision(self):
        # +1, -1, +1, ...: the mean is 0 or 1/G, so z stays near 1/sqrt(G) and never reaches 2.58.
        totals = [1.0 if i % 2 == 0 else -1.0 for i in range(40)]
        result = analysis.separation(parse(games_of(totals)))
        self.assertFalse(result['separated'])
        self.assertEqual((result['decisions'], result['games']), (40, 40))
        self.assertAlmostEqual(result['days'], 39 * 0.5, places=9)

    def test_kaplan_meier_median(self):
        km = analysis.kaplan_meier_median
        # 40 separated, 50 censored, 60 separated, 70 separated, 80 censored:
        # S(40) = 4/5 = 0.8; 3 at risk at 60: S = 0.8 x 2/3 = 0.533; 2 at risk at 70: S = 0.267 <= 0.5.
        self.assertEqual(km([(40, True), (50, False), (60, True), (70, True), (80, False)]), 70)
        # Exactly one half counts: S(10) = 3/4, S(20) = 3/4 x 2/3 = 1/2.
        self.assertEqual(km([(10, True), (20, True), (30, False), (40, False)]), 20)
        # Never reached: S(10) = 2/3, then only censorings.
        self.assertIsNone(km([(10, True), (20, False), (30, False)]))
        # Censored systems from the separation walk: 45 and 47 separated, 40 censored. S(45) = 1/2 (40 has left).
        self.assertEqual(km([(40, False), (45, True), (47, True)]), 45)
        self.assertIsNone(km([]))


class PairedRatioTests(unittest.TestCase):
    def test_uncensored_pairs_give_the_median_ratio_and_the_sign_test(self):
        # Ratios 0.25, 0.5, 1.25, 2, 2.5, 3, 4, 5, 6, 8 (pregame DtS / in-play DtS), all separated.
        pairs = [(30, True, 120, True), (40, True, 80, True), (50, True, 40, True), (60, True, 30, True),
                 (100, True, 40, True), (90, True, 30, True), (120, True, 30, True), (150, True, 30, True),
                 (180, True, 30, True), (240, True, 30, True)]
        result = analysis.paired_ratio(pairs)
        # Ten pairs: the median is sqrt(2.5 x 3) on the log scale.
        self.assertAlmostEqual(result['ratio'], math.sqrt(7.5), places=12)
        # At theta = 1: 8 pairs separate first in play, 2 pregame. p = 2 (C(10,0) + C(10,1) + C(10,2)) / 2^10.
        self.assertEqual((result['in_play_first'], result['pregame_first']), (8, 2))
        self.assertAlmostEqual(float(result['p']), 2 * (1 + 10 + 45) / 1024, places=15)
        # Sign-test 95% CI for ten pairs: from the 2nd to the 9th ratio (8-2 splits are not rejected, 9-1 are).
        self.assertEqual(result['ci95'], [0.5, 6.0])
        self.assertEqual(analysis.ratio_direction(result), 'IN_PLAY_FASTER')

    def test_odd_number_of_pairs(self):
        # Ratios 2, 3, 0.5, 4, 1.5: the middle one is 2.
        pairs = [(60, True, 30, True), (90, True, 30, True), (15, True, 30, True), (120, True, 30, True),
                 (45, True, 30, True)]
        self.assertAlmostEqual(analysis.paired_ratio(pairs)['ratio'], 2.0, places=12)

    def test_censored_pairs_count_through_the_log_rank_comparison(self):
        # A: pregame 60, in play 30, both separated (ratio 2).
        # B: pregame censored at 90, in play separated at 45: in play first while 90/theta >= 45 (theta <= 2).
        # C: pregame separated at 40, in play censored at 80: pregame first while 40/theta <= 80 (theta >= 0.5).
        # E: pregame 30, in play 20, both separated (ratio 1.5).
        # At theta = 1: A, B, E in play first; C pregame first. p = 2 (C(4,0) + C(4,1)) / 16 = 0.625.
        # Balance (in play first - pregame first): +2 up to 1.5, +1 at 1.5 (E ties), 0 between 1.5 and 2,
        # -1 at 2 (A ties; B still counts at its tie), -3 above 2. So the ratio is sqrt(1.5 x 2) = sqrt(3).
        pairs = [(60, True, 30, True), (90, False, 45, True), (40, True, 80, False), (30, True, 20, True)]
        result = analysis.paired_ratio(pairs)
        self.assertEqual((result['in_play_first'], result['pregame_first']), (3, 1))
        self.assertAlmostEqual(float(result['p']), 0.625, places=15)
        self.assertAlmostEqual(result['ratio'], math.sqrt(3), places=12)
        # Four pairs can never reject at 0.05 (smallest two-sided p is 2/16), so both CI ends are open.
        self.assertEqual(result['ci95'], [None, None])
        self.assertEqual(result['ci95_unbounded'], [True, True])
        # Both members censored: the pair says nothing.
        self.assertEqual(analysis.pair_scores([(100, False, 100, False)], analysis.Fraction(1)), (0, 0))
        # Ties: a separation counts before the other mode's censoring at the same count (log-rank convention);
        # two separations at the same count tie and count for neither. Results are (in play first, pregame first).
        one = analysis.Fraction(1)
        self.assertEqual(analysis.pair_scores([(60, True, 60, False)], one), (0, 1))
        self.assertEqual(analysis.pair_scores([(60, False, 60, True)], one), (1, 0))
        self.assertEqual(analysis.pair_scores([(60, True, 60, True)], one), (0, 0))
        # A pregame separation exactly at the in-play censoring count decides the pair's direction and the p:
        # with the eight other pairs in play first, 8 to 1 gives p = 2 x (1 + 9) / 2^9.
        tied = [(60, True, 60, False)] + [(90, True, 30, True)] * 8
        self.assertAlmostEqual(float(analysis.paired_ratio(tied)['p']), 2 * 10 / 512, places=15)

    def test_no_pregame_separation_bounds_the_ratio_from_below(self):
        # Only in-play separations: the balance stays positive until pregame times stop counting.
        result = analysis.paired_ratio([(90, False, 45, True), (60, False, 30, True)])
        self.assertIsNone(result['ratio'])
        self.assertAlmostEqual(result['ratio_above'], 2.0, places=12)
        self.assertEqual(analysis.ratio_direction(result), 'IN_PLAY_FASTER')

    def test_model_based_dts(self):
        # Per-decision points per share 1 and 3: mean 2, sample SD sqrt(2). (2.58 x sqrt(2) / 2)^2 = 3.3282.
        decisions = parse([row(value_credits='0.1'), row(value_credits='0.3')])
        self.assertAlmostEqual(analysis.model_dts(decisions), (2.58 * math.sqrt(2) / 2) ** 2, places=12)
        self.assertAlmostEqual(analysis.model_dts(decisions), 3.3282, places=4)
        self.assertIsNone(analysis.model_dts(parse([row(value_credits='0.1'), row(value_credits='-0.1')])))


class StabilityTests(unittest.TestCase):
    def test_spearman_with_ties_uses_average_ranks(self):
        # x = 1, 2, 2, 4 has ranks 1, 2.5, 2.5, 4; y = 1, 3, 2, 4 has ranks 1, 3, 2, 4. Mean rank 2.5.
        # Products of deviations: 2.25 + 0 + 0 + 2.25 = 4.5; squares 4.5 and 5. rho = 4.5 / sqrt(22.5) = 0.9487.
        rho = analysis.spearman([1, 2, 2, 4], [1, 3, 2, 4])
        self.assertAlmostEqual(rho, 4.5 / math.sqrt(22.5), places=12)
        self.assertAlmostEqual(rho, 0.9487, places=4)
        # The no-ties shortcut 1 - 6 sum(d^2) / (n (n^2 - 1)) would give 0.95 here; it must not be used.
        self.assertNotAlmostEqual(rho, 0.95, places=3)
        # Without ties the shortcut is exact: d = -1, 1, -1, 1, 0, so rho = 1 - 6 x 4 / 120 = 0.8.
        self.assertAlmostEqual(analysis.spearman([10, 20, 30, 40, 50], [2, 1, 4, 3, 5]), 0.8, places=12)
        self.assertIsNone(analysis.spearman([1, 2], [2, 1]))
        self.assertIsNone(analysis.spearman([1, 2, 3], [5, 5, 5]))

    def test_fisher_z_pool(self):
        # Weights n - 3: 7 and 17; a pair with n = 3 has no weight.
        # z = 0.5 ln 3 = 0.549306 and 0.5 ln 1.5 = 0.202733; mean (7 x 0.549306 + 17 x 0.202733) / 24 = 0.303817;
        # back-transformed 0.2948.
        pooled = analysis.fisher_pool([(0.5, 10), (0.2, 20), (0.9, 3), (None, 30)])
        expected = inverse_fisher((7 * fisher(0.5) + 17 * fisher(0.2)) / 24)
        self.assertAlmostEqual(pooled, expected, places=12)
        self.assertAlmostEqual(pooled, 0.2948, places=4)
        self.assertAlmostEqual(analysis.fisher_pool([(1.0, 10)]), 0.9999, places=12)  # capped, not infinite
        self.assertIsNone(analysis.fisher_pool([(0.5, 3)]))

    def test_spearman_brown_and_split_half(self):
        self.assertAlmostEqual(analysis.spearman_brown(0.6), 1.2 / 1.6, places=12)
        # Four systems, four games each (one decision, 10 shares). Odd games (1st, 3rd) and even games (2nd, 4th):
        #   V_odd = 10, 20, 30, 40 and V_even = 5, 15, 2, 30 points.
        # Ranks 1, 2, 3, 4 against 2, 3, 1, 4: d = -1, -1, 2, 0, rho = 1 - 6 x 6 / 60 = 0.4; Spearman-Brown 0.8/1.4.
        halves = {'sys_synthetic01': (1.0, 0.5), 'sys_synthetic02': (2.0, 1.5), 'sys_synthetic03': (3.0, 0.2),
                  'sys_synthetic04': (4.0, 3.0)}
        rows = []
        for actor, (odd, even) in sorted(halves.items()):
            rows += games_of([odd, even, odd, even], actor=actor)
        decisions = parse(rows)
        groups = analysis.by_key(decisions, lambda d: (d.actor_id, d.mode))
        result = analysis.split_half(groups, set(halves), 'IN_PLAY')
        self.assertEqual(result['systems'], 4)
        self.assertAlmostEqual(result['rho'], 0.4, places=12)
        self.assertAlmostEqual(result['spearman_brown'], 0.8 / 1.4, places=12)

    def test_week_pairs_pool_and_bootstrap(self):
        # Five systems, five games a Week, five in-play decisions a game (25 a Week: >= 20 across >= 4 games).
        # Week V (points): W1 1 2 3 4 5; W2 2 1 4 3 5; W3 5 4 3 2 1; W4 4 5 2 1 3.
        #   W1-W2: d = -1 1 -1 1 0, rho = 1 - 6 x 4 / 120 = 0.8
        #   W2-W3: ranks 2 1 4 3 5 against 5 4 3 2 1, d = -3 -3 1 1 4, rho = 1 - 6 x 36 / 120 = -0.8
        #   W3-W4: ranks 5 4 3 2 1 against 4 5 2 1 3, d = 1 -1 1 1 -2, rho = 1 - 6 x 8 / 120 = 0.6
        # Equal weights (n - 3 = 2): pooled = tanh((z(0.8) + z(-0.8) + z(0.6)) / 3) = tanh(0.5 ln 4 / 3) = 0.2270.
        table = {'W1': [1, 2, 3, 4, 5], 'W2': [2, 1, 4, 3, 5], 'W3': [5, 4, 3, 2, 1], 'W4': [4, 5, 2, 1, 3]}
        rows = []
        for week_index, week in enumerate(analysis.SEASON_WEEKS):
            for game in range(5):
                start = WEEK_BOUNDARIES[week_index] + timedelta(hours=12 + 24 * game)
                for system in range(5):
                    for k in range(5):
                        rows.append(row(actor_id='sys_synthetic%02d' % (system + 1), start=start,
                                        event_id='synthetic:e:%s:%d' % (week, game), shares='10',
                                        value_credits=repr(table[week][system] / 10.0)))
        decisions = parse(rows)
        result, _ = analysis.analyse(decisions, resamples=300, seed_label='synthetic-test')
        live = result['M2']['IN_PLAY']
        self.assertEqual([p['systems'] for p in live['week_pairs']], [5, 5, 5])
        for found, expected in zip([p['rho'] for p in live['week_pairs']], [0.8, -0.8, 0.6]):
            self.assertAlmostEqual(found, expected, places=12)
        self.assertAlmostEqual(live['pooled_rho'], inverse_fisher(fisher(0.6) / 3), places=12)
        self.assertAlmostEqual(live['pooled_rho'], 0.2270, places=4)
        self.assertEqual(live['systems'], 5)
        self.assertEqual(result['M2']['PREGAME']['systems'], 0)
        # The bootstrap is seeded: the same input gives the same CI and p.
        again, _ = analysis.analyse(decisions, resamples=300, seed_label='synthetic-test')
        self.assertEqual(again['M2']['IN_PLAY']['ci95'], live['ci95'])
        self.assertEqual(again['M2']['IN_PLAY']['p'], live['p'])
        self.assertEqual(live['bootstrap']['resamples'], 300)
        low, high = live['ci95']
        self.assertTrue(-1 <= low <= high <= 1)
        # Five systems are fewer than 15: Inconclusive whatever rho is.
        self.assertEqual(analysis.label_m2(result['M2'])[0], 'Inconclusive')


class SpreadTests(unittest.TestCase):
    def test_quartile_rule_rounds_down_with_a_minimum_of_four(self):
        expected = {0: None, 7: None, 8: 4, 15: 4, 16: 4, 19: 4, 20: 5, 23: 5, 24: 6, 33: 8}
        for ranked, size in expected.items():
            self.assertEqual(analysis.quartile_size(ranked), size, ranked)

    def test_contrast_se_counts_a_shared_game_once(self):
        # Top T: g1 (2 Credits, 10 shares), g2 (1, 10): ratio 0.15. Bottom B: g1 (-1, 10), g3 (1, 20): ratio 0.
        # D = 100 x (0.15 - 0) = 15 points. Effects on D: T in g1 (2 - 1.5)/20 = 1/40, g2 -1/40;
        # B (weight -1) in g1 -(-1)/30 = 1/30, g3 -(1)/30. Per game: g1 7/120, g2 -1/40, g3 -1/30.
        # Sum of squares 74/14400, times 3/2 = 111/14400. SE = 100 sqrt(111) / 120 = 8.7797 points.
        top = parse([row(actor_id='sys_t', event_id='synthetic:g1', value_credits='2'),
                     row(actor_id='sys_t', event_id='synthetic:g2', value_credits='1')])
        bottom = parse([row(actor_id='sys_b', event_id='synthetic:g1', value_credits='-1'),
                        row(actor_id='sys_b', event_id='synthetic:g3', value_credits='1', shares='20')])
        difference, se, games = analysis.contrast([(top, 1.0), (bottom, -1.0)])
        self.assertAlmostEqual(difference, 15.0, places=12)
        self.assertAlmostEqual(se, 100 * math.sqrt(111) / 120, places=12)
        self.assertEqual(games, 3)
        # Adding the two groups' own variances as if independent would give sqrt(5^2 + 6.667^2) = 8.333 instead.
        self.assertNotAlmostEqual(se, math.sqrt(25 + (20 / 3.0) ** 2), places=2)
        # One system with weight 1 is the kit's own SE.
        self.assertAlmostEqual(analysis.contrast([(top, 1.0)])[1], analysis.estimate(top)['se'], places=12)

    def test_top_and_bottom_quartiles_out_of_sample(self):
        # Eight systems, 16 games each (8 in Weeks 1-2, 8 in Weeks 3-4), two in-play decisions a game, 10 shares.
        # Weeks 1-2: system i has V = i points, so the top four are 8, 7, 6, 5 and the bottom four 4, 3, 2, 1
        # (quartile size max(4, 8 // 4) = 4). Weeks 3-4: top systems have V = 2, 4, 6, 8 (mean 5) and the
        # bottom four V = 1 each, so D = 5 - 1 = 4. Both decisions in a game are V/10 + 0.05 Credits in even games
        # and V/10 - 0.05 in odd ones: four of each per period, so each period's V is exact and SE is not 0.
        late_v = {8: 2, 7: 4, 6: 6, 5: 8, 4: 1, 3: 1, 2: 1, 1: 1}
        rows = []
        for i in range(1, 9):
            for game in range(16):
                week = (game // 4)
                start = WEEK_BOUNDARIES[week] + timedelta(hours=12 + 24 * (game % 4))
                v = i if week < 2 else late_v[i]
                sign = 1 if game % 2 == 0 else -1
                for _ in range(2):
                    rows.append(row(actor_id='sys_synthetic%02d' % i, start=start,
                                    event_id='synthetic:e:%d' % game, value_credits=repr(v / 10.0 + sign * 0.05)))
        result = analysis.m3_spread(parse(rows))
        self.assertEqual((result['ranked_systems'], result['quartile_size']), (8, 4))
        self.assertAlmostEqual(result['v_top_weeks_1_2'], 6.5, places=9)
        self.assertAlmostEqual(result['v_bottom_weeks_1_2'], 2.5, places=9)
        self.assertAlmostEqual(result['v_top'], 5.0, places=9)
        self.assertAlmostEqual(result['v_bottom'], 1.0, places=9)
        self.assertAlmostEqual(result['D'], 4.0, places=9)
        self.assertGreater(result['t'], 0)
        # Seven systems cannot make two groups of four.
        seven = [r for r in rows if r['actor_id'] != 'sys_synthetic08']
        self.assertIsNone(analysis.m3_spread(parse(seven))['quartile_size'])

    def test_speed_filter_windows(self):
        seconds = ['29', '30', '31', '59', '60', '61', '119', '120', '121', '']
        for column in ('seconds_since_game_event', 'seconds_to_mid_move'):
            decisions = parse([row(**{column: s}) for s in seconds])
            for window, kept in ((30, ['31', '59', '60', '61', '119', '120', '121', '']),
                                 (60, ['61', '119', '120', '121', '']),
                                 (120, ['121', ''])):
                found = [s for s, d in zip(seconds, decisions) if analysis.speed_kept(d, window)]
                self.assertEqual(found, kept, (column, window))
        # Either input alone is enough to drop a decision.
        both = parse([row(seconds_since_game_event='300', seconds_to_mid_move='45')])[0]
        self.assertFalse(analysis.speed_kept(both, 60))
        self.assertTrue(analysis.speed_kept(both, 30))


class HolmTests(unittest.TestCase):
    def test_holm_step_down(self):
        # Sorted 0.01, 0.03, 0.04: 3 x 0.01 = 0.03; 2 x 0.03 = 0.06; 1 x 0.04 = 0.04, raised to 0.06.
        adjusted = analysis.holm({'M1': 0.01, 'M2': 0.04, 'M3': 0.03})
        for name, value in (('M1', 0.03), ('M2', 0.06), ('M3', 0.06)):
            self.assertAlmostEqual(adjusted[name], value, places=12)
        # A missing p counts as 1 and keeps m = 3.
        adjusted = analysis.holm({'M1': 0.01, 'M2': None, 'M3': 0.02})
        self.assertAlmostEqual(adjusted['M1'], 0.03, places=12)
        self.assertAlmostEqual(adjusted['M3'], 0.04, places=12)
        self.assertEqual(adjusted['M2'], 1.0)
        self.assertEqual(analysis.holm({'M1': 0.5, 'M2': 0.6, 'M3': 0.7}), {'M1': 1.0, 'M2': 1.0, 'M3': 1.0})


class ExclusionTests(unittest.TestCase):
    def test_each_rule_alone(self):
        cases = [
            (row(cycle_id='program:preseason-2026-10-07:W1'), 'outside_season_1'),
            (row(actor_id='sys_synthetic_test', juke_test='TRUE'), 'juke_test'),
            (row(actor_id='juke-test-synthetic01'), 'juke_test'),
            (row(actor_id='sys_synthetic_removed', account_removed_for_abuse='TRUE'), 'account_removed_for_abuse'),
            (row(market_result='VOIDED'), 'voided'),
            (row(market_result='NEUTRAL_50_50'), 'fifty_fifty'),
            (row(market_result=''), 'market_not_settled'),
            (row(is_combo='TRUE'), 'combo'),
            (row(market_lifecycle_at_action='SUSPENDED'), 'suspended'),
            (row(review_status='REFUSE', appeal_status='NONE'), 'abuse_upheld'),
            (row(review_status='REFUSE', appeal_status='UPHELD'), 'abuse_upheld'),
            (row(review_status='REFUSE', appeal_status='PENDING'), 'abuse_upheld'),
            (pregame(close_state='CLOSE_NOT_CAPTURED', value_credits=''), 'close_not_captured'),
            (pregame(close_state='CLOSE_STALE', value_credits=''), 'close_stale'),
            (pregame(close_state='CLOSE_SPREAD_WIDE', value_credits=''), 'close_spread_wide'),
            (pregame(close_state='NOT_SCORED', value_credits=''), 'close_not_scored'),
            (row(mark_source='LAST_FAIR'), 'mark_last_fair'),
            (row(mark_source='AT_TRADE'), 'mark_at_trade'),
            (row(mark_source='RESULT'), 'mark_result'),
            (row(mark_source='', mark_standard='', value_credits=''), 'unmarked'),
        ]
        decisions = parse([case for case, _ in cases])
        for decision, (_, reason) in zip(decisions, cases):
            self.assertEqual(analysis.exclusion_reasons(decision), [reason], reason)

    def test_graded_decisions_are_kept(self):
        kept = parse([row(mark_source='LIVE'), row(mark_source='DECIDED'), pregame(),
                      row(review_status='REFUSE', appeal_status='OVERTURNED'), row(review_status='HOLD'),
                      row(review_status='CLEARED'), row(market_lifecycle_at_action='UNDER_REVIEW'),
                      row(market_result='NO'), row(regime='synthetic-delay-v1')])
        for decision in kept:
            self.assertEqual(analysis.exclusion_reasons(decision), [], decision.line)

    def test_marks_widen_only_in_their_sensitivity_runs(self):
        last_fair, at_trade, result, unmarked = parse([
            row(mark_source='LAST_FAIR'), row(mark_source='AT_TRADE'), row(mark_source='RESULT'),
            row(mark_source='', mark_standard='', value_credits='')])
        wide = analysis.MARKS_WITH_LAST_FAIR_AT_TRADE
        wider = analysis.MARKS_WITH_RESULT
        self.assertEqual([analysis.exclusion_reasons(d, wide) for d in (last_fair, at_trade, result, unmarked)],
                         [[], [], ['mark_result'], ['unmarked']])
        self.assertEqual([analysis.exclusion_reasons(d, wider) for d in (last_fair, at_trade, result, unmarked)],
                         [[], [], [], ['unmarked']])

    def test_first_reason_and_every_reason_are_counted(self):
        decisions = parse([
            row(market_result='VOIDED', is_combo='TRUE'),                      # first: voided; also combo
            row(is_combo='TRUE', review_status='REFUSE', appeal_status='NONE'),  # first: combo; also abuse
            row(review_status='REFUSE', appeal_status='NONE'),                 # abuse only
            row(mark_source='AT_TRADE'),                                       # mark only
            row(), pregame(),                                                  # graded
            row(is_counterpart='TRUE', actor_id='sys_synthetic_counterpart', system_kind=''),  # graded, baseline
            row(actor_kind='PERSON', actor_id='person-synthetic-1', owner_id='', system_kind=''),  # graded person
        ])
        self.assertEqual(analysis.exclusion_reasons(decisions[0]), ['voided', 'combo'])
        counts = analysis.count_exclusions(decisions)
        self.assertEqual(counts['excluded'], 4)
        self.assertEqual((counts['by_first_reason']['voided'], counts['by_first_reason']['combo'],
                          counts['by_first_reason']['abuse_upheld'], counts['by_first_reason']['mark_at_trade']),
                         (1, 1, 1, 1))
        self.assertEqual((counts['by_reason']['voided'], counts['by_reason']['combo'],
                          counts['by_reason']['abuse_upheld']), (1, 2, 2))
        self.assertEqual(counts['graded_primary'], {'systems': 2, 'people': 1, 'counterpart': 1})
        self.assertEqual(analysis.count_abuse(decisions)['flags_upheld'], 2)

    def test_counterpart_tests_and_removed_accounts_stay_out_of_rankings(self):
        rows = synthetic_population()
        result = analysis.run(io.StringIO(csv_text(rows)), 'synthetic.csv', 'synthetic', resamples=40)
        primary = result['primary']
        # Sixteen builder systems; Counterpart, the juke test system and the removed account would make 19.
        for mode in ('PREGAME', 'IN_PLAY'):
            self.assertEqual(primary['population'][mode]['qualifying'], 16)
            self.assertEqual(primary['M3'][mode]['raw']['ranked_systems'], 16)
        self.assertEqual(primary['M1']['paired']['systems_in_both_modes'], 16)
        self.assertNotIn('NONE', primary['population']['qualifying_by_system_kind'])
        self.assertGreater(result['counterpart_baseline']['IN_PLAY']['decisions'], 0)
        per_actor_rows = 35 * 6
        self.assertEqual(result['exclusions']['by_first_reason']['juke_test'], per_actor_rows)
        self.assertEqual(result['exclusions']['by_first_reason']['account_removed_for_abuse'], per_actor_rows)
        self.assertEqual(result['abuse']['accounts_removed'], 1)
        # Only published systems are named; no private system, person, test system or Counterpart id appears.
        self.assertEqual([r['handle'] for r in primary['published_systems']],
                         ['synthetic01_ai', 'synthetic02_ai', 'synthetic03_ai'])
        text = json.dumps(result)
        for hidden in ('sys_synthetic04', 'sys_synthetic16', 'person-synthetic', 'juke-test-synthetic',
                       'sys_synthetic_counterpart', 'sys_synthetic_removed', 'owner-synthetic'):
            self.assertNotIn(hidden, text)
        # People are a population of their own.
        self.assertEqual(result['sensitivity']['people']['population']['IN_PLAY']['qualifying'], 6)


class RunTests(unittest.TestCase):
    def test_full_run_is_complete_deterministic_and_json(self):
        text = csv_text(synthetic_population())
        first = analysis.run(io.StringIO(text), 'synthetic.csv', 'synthetic', resamples=40)
        second = analysis.run(io.StringIO(text), 'synthetic.csv', 'synthetic', resamples=40)
        dumped = json.dumps(first, sort_keys=True, allow_nan=False)
        self.assertEqual(dumped, json.dumps(second, sort_keys=True, allow_nan=False))
        tests = first['primary']['tests']
        for name in ('M1', 'M2', 'M3'):
            self.assertIn(tests[name]['label'], ('Support', 'Inconclusive', 'Failure'))
            self.assertGreaterEqual(tests[name]['holm_p'], tests[name]['p'] if tests[name]['p'] is not None else 0)
        for mode in ('PREGAME', 'IN_PLAY'):
            m3 = first['primary']['M3'][mode]
            self.assertEqual(sorted(m3['speed_adjusted']), ['120', '30', '60'])
            self.assertIn('raw', m3)
            self.assertIn('km_median_decisions', first['primary']['M1']['by_mode'][mode])
            self.assertIn('split_half', first['primary']['M2'][mode])
        sensitivity = first['sensitivity']
        self.assertEqual(sorted(sensitivity), ['by_sport', 'marks_last_fair_at_trade',
                                               'marks_last_fair_at_trade_result', 'one_system_per_owner',
                                               'people', 'post_engineering_change'])
        # Basketball joins in Week 2 and is handled like any other sport id.
        self.assertEqual(sorted(sensitivity['by_sport']), ['NFL', 'college football', 'soccer', 'sport:basketball'])
        self.assertGreater(sensitivity['by_sport']['sport:basketball']['decisions'], 0)
        self.assertEqual(sensitivity['one_system_per_owner']['systems_dropped'], 3)
        self.assertGreater(sensitivity['post_engineering_change']['decisions'], 0)
        self.assertGreater(sensitivity['marks_last_fair_at_trade']['population']['IN_PLAY']['graded_decisions'],
                           first['primary']['population']['IN_PLAY']['graded_decisions'])

    def test_bad_input_stops_the_run(self):
        with self.assertRaises(analysis.InputError):
            analysis.read_decisions(io.StringIO(csv_text([row()], columns=analysis.COLUMN_NAMES[:-1])))
        duplicate = row()
        with self.assertRaises(analysis.InputError):
            parse([duplicate, dict(duplicate)])
        with self.assertRaises(analysis.InputError):
            parse([row(value_credits='')])           # a LIVE mark needs its value
        with self.assertRaises(analysis.InputError):
            parse([row(occurred_at='2026-10-15 00:30')])
        with self.assertRaises(analysis.InputError):
            parse([row(mark_source='SOMETIME')])
        with self.assertRaises(analysis.InputError):
            parse([row(published='TRUE', handle='')])
        with self.assertRaises(analysis.InputError):
            parse([row(shares='0')])
        # One actor, two identities: a stray published=TRUE must not name a private system.
        with self.assertRaises(analysis.InputError):
            parse([row(actor_id='sys_synthetic09'),
                   row(actor_id='sys_synthetic09', published='TRUE', handle='synthetic09_ai')])
        with self.assertRaises(analysis.InputError):
            parse([row(actor_id='sys_synthetic09'), row(actor_id='sys_synthetic09', owner_id='owner-synthetic-2')])


def synthetic_population():
    """A small synthetic Season (labelled synthetic): 16 builder systems, Counterpart, a juke test system, a
    removed account and six people, over 35 synthetic games in four Weeks. Basketball starts in Week 2."""
    rng = random.Random('synthetic-season-1')
    games = []
    for week in range(4):
        slate = [('sport:football', 'series:12185')] * 2 + [('sport:football', 'series:12756')] * 2 \
            + [('sport:soccer', 'series:synthetic-soccer')] * 4
        if week >= 1:
            slate = slate[:7] + [('sport:basketball', 'series:synthetic-basketball')] * 2
        for i, (sport, competition) in enumerate(slate):
            games.append(('synthetic:e:w%d:%d' % (week + 1, i), WEEK_BOUNDARIES[week] + timedelta(hours=7 + 12 * i),
                          sport, competition))
    actors = []
    for i in range(1, 17):
        owner = 'owner-synthetic-%d' % (i if i > 6 else (i + 1) // 2)    # owners 1-3 own two systems each
        actors.append({'actor_kind': 'SYSTEM', 'actor_id': 'sys_synthetic%02d' % i, 'owner_id': owner,
                       'system_kind': ('BUILDER', 'LAB', 'TRACKED', 'HOUSE')[i % 4],
                       'published': 'TRUE' if i <= 3 else 'FALSE', 'handle': 'synthetic%02d_ai' % i if i <= 3 else '',
                       'skill': (i - 8.5) * 0.8})
    specials = [
        {'actor_id': 'sys_synthetic_counterpart', 'is_counterpart': 'TRUE', 'system_kind': ''},
        {'actor_id': 'juke-test-synthetic', 'juke_test': 'TRUE'},
        {'actor_id': 'sys_synthetic_removed', 'account_removed_for_abuse': 'TRUE'},
    ]
    for special in specials:
        entry = {'actor_kind': 'SYSTEM', 'owner_id': 'owner-synthetic-special', 'system_kind': 'BUILDER',
                 'published': 'FALSE', 'handle': '', 'skill': 20.0}
        entry.update(special)
        actors.append(entry)
    for i in range(1, 7):
        actors.append({'actor_kind': 'PERSON', 'actor_id': 'person-synthetic-%02d' % i, 'owner_id': '',
                       'system_kind': '', 'published': 'FALSE', 'handle': '', 'skill': (i - 3.5) * 0.5})
    rows = []
    for actor in actors:
        skill = actor.pop('skill')
        for event, start, sport, competition in games:
            in_week = start - WEEK_BOUNDARIES[0]
            late = in_week >= timedelta(days=14)
            for k in range(3):
                shares = rng.choice((5, 10, 20, 40))
                points = skill + rng.gauss(0, 6)
                close = 'GRADED' if rng.random() > 0.02 else rng.choice(('CLOSE_STALE', 'CLOSE_SPREAD_WIDE'))
                result = rng.choice(('YES', 'NO')) if rng.random() > 0.01 else rng.choice(('VOIDED', 'NEUTRAL_50_50'))
                common = dict(actor, start=start, event_id=event, sport_id=sport, competition_id=competition,
                              shares=str(shares), market_result=result)
                rows.append(pregame(occurred_at=stamp(start - timedelta(minutes=20 * (k + 1))), close_state=close,
                                    value_credits=('%.6f' % (shares * points / 100)) if close == 'GRADED' else '',
                                    seconds_to_mid_move=str(rng.randint(0, 600)) if rng.random() < 0.1 else '',
                                    **common))
                mark = rng.choice(('LIVE',) * 17 + ('DECIDED', 'LAST_FAIR', 'AT_TRADE', 'RESULT'))
                fast = rng.random() < 0.2
                live_points = skill + (3.0 if fast and skill > 0 else 0.0) + rng.gauss(0, 6)
                rows.append(row(occurred_at=stamp(start + timedelta(minutes=10 + 25 * k)), mark_source=mark,
                                value_credits='%.6f' % (shares * live_points / 100),
                                seconds_since_game_event=str(rng.randint(0, 59)) if fast else
                                (str(rng.randint(61, 900)) if rng.random() < 0.5 else ''),
                                seconds_to_mid_move=str(rng.randint(0, 300)) if rng.random() < 0.15 else '',
                                regime='synthetic-delay-v1' if late else 'PRE_CHANGE',
                                is_combo='TRUE' if rng.random() < 0.003 else 'FALSE',
                                review_status='REFUSE' if rng.random() < 0.003 else '',
                                appeal_status='NONE', **common))
    return rows


if __name__ == '__main__':
    unittest.main()
