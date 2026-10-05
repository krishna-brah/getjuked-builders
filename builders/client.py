"""Small transport-injected Builder API v1 client; no network on import."""
from collections import deque
from dataclasses import dataclass
from decimal import Decimal,InvalidOperation
import json,math,time,urllib.parse,urllib.request,urllib.error

class ClientError(RuntimeError):pass
class RateLimit(ClientError):pass
class ReconciliationRequired(ClientError):
    def __init__(self,order_id,positions):
        super().__init__('Order outcome uncertain; reconcile positions before another mutation.')
        self.order_id=order_id;self.positions=positions

def canonical(value):
    if not isinstance(value,str):raise ValueError('Credits/shares must be canonical decimal strings.')
    try:d=Decimal(value)
    except InvalidOperation:raise ValueError('Invalid decimal.')
    if not d.is_finite() or d<=0 or d.as_tuple().exponent<-6:raise ValueError('Positive finite decimal with at most six places required.')
    text=format(d,'f').rstrip('0').rstrip('.') if '.' in format(d,'f') else format(d,'f')
    if text!=value:raise ValueError('Noncanonical decimal.')
    return text

class Budget:
    def __init__(self,clock=time.monotonic):self.clock=clock;self.reads=deque();self.writes=deque()
    def consume(self,method):
        now=self.clock();queue=self.reads if method=='GET' else self.writes;maximum=120 if method=='GET' else 30
        while queue and queue[0]<=now-60:queue.popleft()
        if len(queue)>=maximum:raise RateLimit('Local per-minute request budget exhausted.')
        queue.append(now)

class HttpTransport:
    """Optional future transport. This task never enables or executes it."""
    def __init__(self,api_key=None,*,enable_network=False,base_url='https://www.getjuked.io/api/v3-beta',timeout=10):
        p=urllib.parse.urlsplit(base_url)
        if p.scheme!='https' or p.hostname not in ('www.getjuked.io','getjuked.io') or p.port not in (None,443) or p.path!='/api/v3-beta' or p.query or p.fragment or p.username:raise ValueError('Unexpected API origin.')
        self.base_url=base_url;self._api_key=api_key;self.enabled=enable_network;self.timeout=timeout
    def __repr__(self):return f'HttpTransport(base_url={self.base_url!r}, enabled={self.enabled!r})'
    def request(self,method,path,body=None):
        if not self.enabled:raise ClientError('Network transport disabled. Use replay/mocks in this research kit.')
        if not isinstance(self._api_key,str) or not self._api_key.startswith('jk_'):raise ClientError('Supply your own system key explicitly when authorized.')
        if not path.startswith('/builder/') or '#' in path:raise ClientError('Unexpected API path.')
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args,**kwargs):return None
        opener=urllib.request.build_opener(NoRedirect())
        payload=None if body is None else json.dumps(body,separators=(',',':'),allow_nan=False).encode()
        req=urllib.request.Request(self.base_url+path,data=payload,method=method,headers={'Authorization':'Bearer '+self._api_key,'Content-Type':'application/json'})
        try:
            response=opener.open(req,timeout=self.timeout)
        except urllib.error.HTTPError as e:
            response=e
        except (urllib.error.URLError,TimeoutError,OSError):
            return {'ok':False,'code':'CLIENT_TRANSPORT_UNCERTAIN' if method!='GET' else 'CLIENT_READ_FAILED'}
        with response:
            data=response.read(8*1024*1024+1)
            if len(data)>8*1024*1024:return {'ok':False,'code':'CLIENT_RESPONSE_TOO_LARGE_UNCERTAIN' if method!='GET' else 'CLIENT_RESPONSE_TOO_LARGE'}
            try:parsed=json.loads(data)
            except (ValueError,UnicodeDecodeError):return {'ok':False,'code':'CLIENT_RESPONSE_INVALID_UNCERTAIN' if method!='GET' else 'CLIENT_RESPONSE_INVALID'}
        if not isinstance(parsed,dict):return {'ok':False,'code':'CLIENT_RESPONSE_INVALID_UNCERTAIN' if method!='GET' else 'CLIENT_RESPONSE_INVALID'}
        return parsed

class ReplayTransport:
    """Strict recorded request/response steps; never a socket."""
    def __init__(self,steps):self.steps=list(steps);self.requests=[]
    def request(self,method,path,body=None):
        if not self.steps:raise ClientError('Replay exhausted.')
        step=self.steps.pop(0);actual={'method':method,'path':path,'body':body}
        if actual!=step['request']:raise ClientError('Request does not match recorded fixture.')
        self.requests.append(actual);return json.loads(json.dumps(step['response']))

class BuilderClient:
    def __init__(self,transport,*,clock=time.monotonic,sleeper=time.sleep):
        self.transport=transport;self.budget=Budget(clock);self.sleeper=sleeper;self.pending_order=None;self.pending_body=None;self.pending_retry_allowed=False
    def _request(self,method,path,body=None):
        if method!='GET' and self.pending_order is not None and not (self.pending_retry_allowed and path=='/builder/pick' and body==self.pending_body):raise ReconciliationRequired(self.pending_order,self.positions())
        self.budget.consume(method)
        try:result=self.transport.request(method,path,body)
        except (OSError,urllib.error.URLError):
            result={'ok':False,'code':'CLIENT_TRANSPORT_UNCERTAIN' if method!='GET' else 'CLIENT_READ_FAILED'}
        if method!='GET':
            code=result.get('code');identity=body.get('orderId','forecast:'+body.get('listingId',''))
            if code in ('ORDER_OUTCOME_UNKNOWN','CLIENT_TRANSPORT_UNCERTAIN','CLIENT_RESPONSE_TOO_LARGE_UNCERTAIN','CLIENT_RESPONSE_INVALID_UNCERTAIN'):
                self.pending_order=identity;self.pending_body=dict(body);self.pending_retry_allowed=False
                raise ReconciliationRequired(identity,self.positions())
            if code=='ORDER_IN_PROGRESS':self.pending_order=identity;self.pending_body=dict(body);self.pending_retry_allowed=True
            elif self.pending_order==identity:self.pending_order=None;self.pending_body=None;self.pending_retry_allowed=False
        return result
    def board(self,arena_id,*,event_id=None,summary=False):
        if arena_id not in ('arena:football','arena:soccer'):raise ValueError('Unknown Arena.')
        q={'arenaId':arena_id}
        if event_id is not None:q['eventId']=str(event_id)
        if summary:q['view']='SUMMARY'
        return self._request('GET','/builder/board?'+urllib.parse.urlencode(q))
    def positions(self):return self._request('GET','/builder/positions')
    def record(self):return self._request('GET','/builder/record')
    def buy(self,arena_id,listing_id,side,credits,order_id,*,limit_price=None):
        body={'arenaId':arena_id,'listingId':listing_id,'side':side,'credits':canonical(credits),'orderId':order_id}
        return self._pick(body,limit_price)
    def close(self,arena_id,listing_id,side,position_id,shares,order_id,*,limit_price=None):
        body={'arenaId':arena_id,'listingId':listing_id,'side':side,'operation':'CLOSE','positionId':position_id,'shares':canonical(shares),'orderId':order_id}
        return self._pick(body,limit_price)
    def _pick(self,body,limit_price):
        if body['arenaId'] not in ('arena:football','arena:soccer') or body['side'] not in ('YES','NO') or not all(isinstance(body[k],str) and body[k] for k in ['listingId','orderId']):raise ValueError('Invalid pick identity.')
        if 'positionId' in body and (not isinstance(body['positionId'],str) or not body['positionId']):raise ValueError('Position identity required.')
        if limit_price is not None:
            if isinstance(limit_price,bool) or not isinstance(limit_price,(float,int)) or not math.isfinite(limit_price) or not 0<limit_price<1:raise ValueError('Invalid limit price.')
            body['limitPrice']=limit_price
        return self._request('POST','/builder/pick',body)
    def forecast(self,listing_id,probability):
        if not isinstance(listing_id,str) or not listing_id or isinstance(probability,bool) or not isinstance(probability,(float,int)) or not math.isfinite(probability) or not 0<=probability<=1:raise ValueError('Invalid forecast.')
        return self._request('POST','/builder/forecast',{'listingId':listing_id,'probability':probability})
    def safe_buy(self,*args,max_attempts=3,retry_seconds=1,**kwargs):
        if not 1<=max_attempts<=3 or not 0<=retry_seconds<=5:raise ValueError('Bounded retry required.')
        for attempt in range(max_attempts):
            result=self.buy(*args,**kwargs);code=result.get('code')
            if code=='ORDER_IN_PROGRESS' and attempt+1<max_attempts:self.sleeper(retry_seconds);continue
            if code in ('ORDER_OUTCOME_UNKNOWN','CLIENT_TRANSPORT_UNCERTAIN','CLIENT_RESPONSE_TOO_LARGE_UNCERTAIN','CLIENT_RESPONSE_INVALID_UNCERTAIN'):
                self.pending_order=args[4] if len(args)>4 else kwargs['order_id'];positions=self.positions();raise ReconciliationRequired(self.pending_order,positions)
            return result
    def confirm_reconciled(self,order_id,*,confirmed_outcome):
        if self.pending_order!=order_id or confirmed_outcome not in ('FILLED','REFUSED','NOT_PLACED_CONFIRMED'):raise ValueError('Explicit reconciled identity/outcome required.')
        self.pending_order=None;self.pending_body=None;self.pending_retry_allowed=False
