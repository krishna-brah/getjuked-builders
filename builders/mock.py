"""Transparent synthetic paper server for consumer readback, not hosted acceptance."""
import json
from decimal import Decimal
from urllib.parse import urlsplit,parse_qs
class MockTransport:
    def __init__(self,context):
        self.context=json.loads(json.dumps(context));self.requests=[];self.orders={};self.forecasts={};self.positions=[];self.credits=Decimal(context['book']['availableCredits']);self.version=0
    def request(self,method,path,body=None):
        self.requests.append({'method':method,'path':path,'body':body});url=urlsplit(path)
        if method=='GET' and url.path=='/builder/board':
            q=parse_qs(url.query)
            if q.get('view')==['SUMMARY']:return {'ok':True,'synthetic':True,'summary':{'credits':str(self.credits),'version':self.version,'openPositions':len(self.positions)}}
            return {'ok':True,'synthetic':True,'normalizedFixture':self.context}
        if method=='GET' and path=='/builder/positions':return {'ok':True,'synthetic':True,'positions':json.loads(json.dumps(self.positions))}
        if method=='GET' and path=='/builder/record':return {'ok':True,'synthetic':True,'verdict':'INSUFFICIENT_EVIDENCE','nativeOfficialGrades':0}
        if method=='POST' and path=='/builder/forecast':
            listing=body['listingId']
            if listing in self.forecasts:return {'ok':False,'code':'FORECAST_ALREADY_SEALED'}
            self.forecasts[listing]=body['probability'];return {'ok':True,'synthetic':True,'sealed':True}
        if method=='POST' and path=='/builder/pick':
            oid=body['orderId']
            if oid in self.orders:return self.orders[oid]|{'replayed':True}
            if body.get('operation')=='CLOSE':result={'ok':False,'code':'FIXTURE_CLOSE_NOT_IMPLEMENTED'}
            else:
                ask=Decimal(self.context['quotes'][body['side']]['ask'])
                if 'limitPrice' in body and ask>Decimal(str(body['limitPrice'])):result={'ok':False,'code':'PRICE_MOVED'}
                elif Decimal(body['credits'])>self.credits:result={'ok':False,'code':'INSUFFICIENT_CREDITS'}
                else:
                    self.credits-=Decimal(body['credits']);self.version+=1
                    self.positions.append({'positionId':'synthetic-position-'+str(self.version),'listingId':body['listingId'],'side':body['side'],'credits':body['credits'],'state':'OPEN','synthetic':True})
                    result={'ok':True,'synthetic':True,'orderId':oid,'version':self.version,'filled':True}
            self.orders[oid]=result;return result
        return {'ok':False,'code':'FIXTURE_UNSUPPORTED_ROUTE'}
