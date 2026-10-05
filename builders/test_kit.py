import copy,json,unittest
from pathlib import Path
from unittest.mock import patch
from .agents import AGENTS,Limits
from .client import BuilderClient,ReplayTransport,HttpTransport,ClientError,ReconciliationRequired,RateLimit,canonical
from .mock import MockTransport
from .demo import run
def fixture():return json.loads((Path(__file__).parent/'fixtures.json').read_text())
def request(body):return {'method':'POST','path':'/builder/pick','body':body}
BUY={'arenaId':'arena:football','listingId':'l','side':'YES','credits':'25','orderId':'o','limitPrice':.62}
class KitTests(unittest.TestCase):
    def test_three_offline_consumer_journeys(self):
        with patch('urllib.request.build_opener',side_effect=AssertionError('NETWORK_FORBIDDEN')):
            for name in AGENTS:
                result=run(name);self.assertEqual(result['networkRequests'],0);self.assertEqual(result['decision']['kind'],'BUY');self.assertEqual(result['before']['summary']['credits'],'1000');self.assertEqual(result['after']['summary']['credits'],'975');self.assertEqual(result['after']['summary']['version'],1);self.assertEqual(len(result['positions']['positions']),1);self.assertEqual(result['record']['nativeOfficialGrades'],0)
    def test_idempotent_pick_and_first_forecast(self):
        server=MockTransport(fixture());client=BuilderClient(server)
        first=client.buy('arena:football','l','YES','25','o',limit_price=.62);second=client.buy('arena:football','l','YES','25','o',limit_price=.62)
        self.assertTrue(second['replayed']);self.assertEqual(first['version'],second['version']);self.assertEqual(str(server.credits),'975')
        self.assertTrue(client.forecast('l',.72)['sealed']);self.assertEqual(client.forecast('l',.1)['code'],'FORECAST_ALREADY_SEALED');self.assertEqual(server.forecasts['l'],.72)
    def test_in_progress_retry_keeps_exact_body(self):
        replay=ReplayTransport([{'request':request(BUY),'response':{'ok':False,'code':'ORDER_IN_PROGRESS'}},{'request':request(BUY),'response':{'ok':True,'filled':True}}]);client=BuilderClient(replay,sleeper=lambda _:None)
        result=client.safe_buy('arena:football','l','YES','25','o',limit_price=.62);self.assertTrue(result['filled']);self.assertEqual(replay.requests[0],replay.requests[1]);self.assertIsNone(client.pending_order)
    def test_unknown_reads_positions_and_blocks_new_write(self):
        replay=ReplayTransport([{'request':request(BUY),'response':{'ok':False,'code':'ORDER_OUTCOME_UNKNOWN'}},{'request':{'method':'GET','path':'/builder/positions','body':None},'response':{'ok':True,'positions':[]}},{'request':{'method':'GET','path':'/builder/positions','body':None},'response':{'ok':True,'positions':[]}}]);client=BuilderClient(replay)
        with self.assertRaises(ReconciliationRequired):client.safe_buy('arena:football','l','YES','25','o',limit_price=.62)
        with self.assertRaises(ReconciliationRequired):client.buy('arena:football','l','YES','25','new-id',limit_price=.62)
        self.assertEqual([r['method'] for r in replay.requests],['POST','GET','GET']);self.assertEqual(client.pending_order,'o')
    def test_in_progress_exhaustion_blocks_new_mutation(self):
        replay=ReplayTransport([{'request':request(BUY),'response':{'ok':False,'code':'ORDER_IN_PROGRESS'}},{'request':{'method':'GET','path':'/builder/positions','body':None},'response':{'ok':True,'positions':[]}}]);client=BuilderClient(replay,sleeper=lambda _:None)
        self.assertEqual(client.safe_buy('arena:football','l','YES','25','o',limit_price=.62,max_attempts=1)['code'],'ORDER_IN_PROGRESS')
        with self.assertRaises(ReconciliationRequired):client.forecast('other',.5)
    def test_transport_timeout_blocks_later_mutation(self):
        class TimeoutTransport:
            def __init__(self):self.methods=[]
            def request(self,method,path,body=None):
                self.methods.append(method)
                if len(self.methods)==1:raise TimeoutError('Synthetic submitted-write timeout')
                return {'ok':True,'positions':[]}
        server=TimeoutTransport();client=BuilderClient(server)
        with self.assertRaises(ReconciliationRequired):client.buy('arena:football','l','YES','25','o')
        with self.assertRaises(ReconciliationRequired):client.forecast('other',.5)
        self.assertEqual(server.methods,['POST','GET','GET']);self.assertEqual(client.pending_order,'o')
    def test_refusal_does_not_create_new_order(self):
        replay=ReplayTransport([{'request':request(BUY),'response':{'ok':False,'code':'PRICE_MOVED'}}]);client=BuilderClient(replay)
        self.assertEqual(client.safe_buy('arena:football','l','YES','25','o',limit_price=.62)['code'],'PRICE_MOVED');self.assertEqual(len(replay.requests),1)
    def test_close_wire_and_event_query(self):
        body={'arenaId':'arena:football','listingId':'l','side':'NO','operation':'CLOSE','positionId':'p','shares':'40.5','orderId':'close','limitPrice':.4}
        replay=ReplayTransport([{'request':{'method':'GET','path':'/builder/board?arenaId=arena%3Afootball&eventId=e%3A1','body':None},'response':{'ok':True}},{'request':request(body),'response':{'ok':True}}]);c=BuilderClient(replay);self.assertTrue(c.board('arena:football',event_id='e:1')['ok']);self.assertTrue(c.close('arena:football','l','NO','p','40.5','close',limit_price=.4)['ok'])
    def test_client_rate_caps_and_expiry(self):
        t=[0.];server=MockTransport(fixture());c=BuilderClient(server,clock=lambda:t[0])
        for _ in range(120):c.positions()
        with self.assertRaises(RateLimit):c.positions()
        t[0]=60;c.positions()
        for i in range(30):c.forecast(str(i),.5)
        with self.assertRaises(RateLimit):c.forecast('new',.5)
    def test_http_disabled_before_any_network_or_key_use(self):
        with patch('urllib.request.build_opener',side_effect=AssertionError('NETWORK_FORBIDDEN')):
            with self.assertRaises(ClientError):BuilderClient(HttpTransport()).positions()
        self.assertNotIn('api_key',repr(HttpTransport()));
        with self.assertRaises(ValueError):HttpTransport(base_url='https://example.org/api/v3-beta')
    def test_decimal_and_probability_negative_cases(self):
        for v in ['25.0','1e2','-1','NaN','0','0.0000001',25]:
            with self.assertRaises(ValueError):canonical(v)
        c=BuilderClient(MockTransport(fixture()))
        for p in [True,float('nan'),1.01]:
            with self.assertRaises(ValueError):c.forecast('l',p)
    def test_agent_source_price_and_exposure_holds(self):
        cases=[('rulesVerified',False,'RULE_IDENTITY_UNVERIFIED'),('sport','NCAAF','UNSUPPORTED_SPORT_OR_CONTRACT')]
        for key,value,reason in cases:
            ctx=fixture();ctx[key]=value;self.assertEqual(AGENTS['counterpart_pregame'](ctx)['reason'],reason)
        for field,value,reason in [('openPositions',10,'OPEN_POSITION_CAP'),('weekBuyActions',10,'WEEK_CAP'),('eventBuyActions',1,'GAME_CAP')]:
            ctx=fixture();ctx['book'][field]=value;self.assertEqual(AGENTS['counterpart_pregame'](ctx)['reason'],reason)
        ctx=fixture();ctx['quotes']['YES']['receivedAt']='2026-10-04T17:59:57Z';self.assertEqual(AGENTS['counterpart_pregame'](ctx)['reason'],'QUOTE_STALE_OR_FUTURE')
        ctx=fixture();ctx['quotes']['YES']['askDepthShares']='1';self.assertEqual(AGENTS['counterpart_pregame'](ctx)['reason'],'INSUFFICIENT_ASK_DEPTH')
    def test_live_symmetric_probability_and_clock_guard(self):
        ctx=fixture();ctx['phase']='IN_PLAY';ctx['kickoff']='2026-10-04T17:00:00Z';ctx['ownPrior']['homeWin']=.5;ctx['liveState']['homeScore']=ctx['liveState']['awayScore']=7
        d=AGENTS['live_score_clock'](ctx);self.assertEqual(d['forecast']['probability'],.5);self.assertEqual(d['buy']['side'],'NO');self.assertEqual(d['buy']['limit_price'],.4)
        ctx['liveState']['period']=2;self.assertEqual(AGENTS['live_score_clock'](ctx)['reason'],'CONFLICTING_CLOCKS')
        ctx['liveState']['period']=3;ctx['liveState']['receivedAt']='2026-10-04T17:59:29Z';self.assertEqual(AGENTS['live_score_clock'](ctx)['reason'],'LIVE_STATE_NOT_QUALIFIED')
    def test_pregame_prior_must_be_available_at_decision(self):
        ctx=fixture();ctx['ownPrior']['fitAsOf']='2026-10-04T18:30:00Z'
        self.assertEqual(AGENTS['counterpart_pregame'](ctx)['reason'],'PRIOR_NOT_CAUSAL_OR_RESULTS_ONLY')
if __name__=='__main__':unittest.main()
