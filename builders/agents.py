"""Three transparent paper reference agents over an explicit normalized fixture seam."""
from dataclasses import dataclass
from decimal import Decimal
from datetime import datetime
from statistics import NormalDist
import math

@dataclass(frozen=True)
class Limits:
    minimum_edge_points:float=5
    credits:str='25'
    picks_per_game:int=1
    picks_per_week:int=10
    maximum_open_positions:int=10

def at(s):
    value=datetime.fromisoformat(s.replace('Z','+00:00'))
    if value.tzinfo is None:raise ValueError('Timestamp needs offset.')
    return value
def base_guard(ctx,limits):
    if ctx.get('schema')!='juke.builder.synthetic-input.v1' or ctx.get('synthetic') is not True:return 'ADAPTER_NOT_QUALIFIED'
    if ctx.get('rulesVerified') is not True or ctx.get('yesMeans')!='HOME_WIN':return 'RULE_IDENTITY_UNVERIFIED'
    if ctx.get('sport')!='NFL' or ctx.get('marketType')!='winner':return 'UNSUPPORTED_SPORT_OR_CONTRACT'
    now=at(ctx['now']);q=ctx['quotes'];credit=Decimal(limits.credits)
    for side in ['YES','NO']:
        quote=q.get(side)
        if quote is None:return 'MISSING_BOOK_SIDE'
        age=(now-at(quote['receivedAt'])).total_seconds()
        if not 0<=age<=2:return 'QUOTE_STALE_OR_FUTURE'
        bid,ask=Decimal(quote['bid']),Decimal(quote['ask']);depth=Decimal(quote['askDepthShares'])
        if any(not v.is_finite() for v in [bid,ask,depth]) or depth<0:return 'INVALID_BOOK_NUMBER'
        if not 0<bid<=ask<1 or ask-bid>Decimal('.02'):return 'BAD_OR_WIDE_BOOK'
        if depth*ask<credit:return 'INSUFFICIENT_ASK_DEPTH'
    book=ctx['book']
    available=Decimal(book['availableCredits'])
    if not available.is_finite():return 'INVALID_BOOK_NUMBER'
    if available<credit:return 'INSUFFICIENT_CREDITS'
    if any(isinstance(book[k],bool) or not isinstance(book[k],int) or book[k]<0 for k in ['openPositions','weekBuyActions','eventBuyActions']):return 'INVALID_BOOK_COUNT'
    if book['openPositions']>=limits.maximum_open_positions:return 'OPEN_POSITION_CAP'
    if book['weekBuyActions']>=limits.picks_per_week:return 'WEEK_CAP'
    if book['eventBuyActions']>=limits.picks_per_game:return 'GAME_CAP'
    return None
def decide(ctx,fair_yes,limits,*,follow=False):
    held=base_guard(ctx,limits)
    if held:return {'kind':'PASS','reason':held}
    if isinstance(fair_yes,bool) or not isinstance(fair_yes,(int,float)) or not math.isfinite(fair_yes) or not .001<=fair_yes<=.999:return {'kind':'PASS','reason':'INVALID_MODEL_PROBABILITY'}
    choices=[]
    for side,p in [('YES',fair_yes),('NO',1-fair_yes)]:
        ask=Decimal(ctx['quotes'][side]['ask']);edge=100*(Decimal(str(p))-ask)
        if edge>=Decimal(str(limits.minimum_edge_points)) or (follow and ((side=='YES' and fair_yes>=.5) or (side=='NO' and fair_yes<.5))):choices.append((float(edge),side=='YES',side,float(ask)))
    if not choices:return {'kind':'PASS','reason':'NO_EDGE_AT_ASK','forecast':{'listingId':ctx['listingId'],'probability':fair_yes}}
    edge,_,side,ask=max(choices)
    return {'kind':'BUY','forecast':{'listingId':ctx['listingId'],'probability':fair_yes},'buy':{'arena_id':ctx['arenaId'],'listing_id':ctx['listingId'],'side':side,'credits':limits.credits,'order_id':ctx['decisionId'],'limit_price':ask},'expectedEdgePoints':edge,'qualification':'SYNTHETIC_OFFLINE_ONLY'}
def market_follower(ctx,limits=Limits()):
    q=ctx.get('quotes',{}).get('YES')
    if q is None:return {'kind':'PASS','reason':'MISSING_BOOK_SIDE'}
    fair=float((Decimal(q['bid'])+Decimal(q['ask']))/2)
    return decide(ctx,fair,limits,follow=True)
def counterpart_pregame(ctx,limits=Limits()):
    if ctx.get('phase')!='PREGAME' or at(ctx['now'])>=at(ctx['kickoff']):return {'kind':'PASS','reason':'NOT_PREGAME'}
    prior=ctx['ownPrior']
    if prior.get('resultsOnly') is not True or at(prior['fitAsOf'])>=at(ctx['kickoff']) or at(prior['fitAsOf'])>at(ctx['now']):return {'kind':'PASS','reason':'PRIOR_NOT_CAUSAL_OR_RESULTS_ONLY'}
    return decide(ctx,prior['homeWin'],limits)
def live_score_clock(ctx,limits=Limits()):
    if ctx.get('phase')!='IN_PLAY' or at(ctx['now'])<at(ctx['kickoff']):return {'kind':'PASS','reason':'NOT_IN_PLAY'}
    s=ctx['liveState'];age=(at(ctx['now'])-at(s['receivedAt'])).total_seconds()
    if not 0<=age<=30 or s.get('scoreSemantics')!='PRE_PLAY' or s.get('status')!='REGULATION':return {'kind':'PASS','reason':'LIVE_STATE_NOT_QUALIFIED'}
    p=ctx['ownPrior']['homeWin'];sec=s['regulationSecondsRemaining'];h=s['homeScore'];a=s['awayScore']
    if ctx['ownPrior'].get('resultsOnly') is not True or at(ctx['ownPrior']['fitAsOf'])>=at(ctx['kickoff']):return {'kind':'PASS','reason':'PRIOR_NOT_CAUSAL_OR_RESULTS_ONLY'}
    if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in [p,sec,h,a]) or not .001<=p<=.999 or not 1<=sec<=3600 or not 0<=h<=100 or not 0<=a<=100 or int(h)!=h or int(a)!=a:return {'kind':'PASS','reason':'INVALID_LIVE_STATE'}
    period=s['period'];quarter=s['quarterSecondsRemaining']
    if isinstance(period,bool) or isinstance(quarter,bool) or not isinstance(period,int) or not isinstance(quarter,int) or not 1<=period<=4 or not 0<=quarter<=900 or (4-period)*900+quarter!=sec:return {'kind':'PASS','reason':'CONFLICTING_CLOCKS'}
    frac=max(sec/3600,1/240);sigma=13.86;mean=h-a+sigma*NormalDist().inv_cdf(p)*frac
    fair=.5*math.erfc(-mean/(sigma*math.sqrt(frac))/math.sqrt(2))
    return decide(ctx,min(max(fair,.001),.999),limits)
def checked(fn):
    def run(ctx,limits=Limits()):
        try:return fn(ctx,limits)
        except (KeyError,ValueError,TypeError,ArithmeticError):return {'kind':'PASS','reason':'MALFORMED_INPUT'}
    return run
AGENTS={'market_follower':checked(market_follower),'counterpart_pregame':checked(counterpart_pregame),'live_score_clock':checked(live_score_clock)}
