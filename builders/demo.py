"""python -m builders.demo --agent all : deterministic offline examples only."""
import argparse,json
from pathlib import Path
from .agents import AGENTS
from .client import BuilderClient
from .mock import MockTransport
def run(name):
    ctx=json.loads((Path(__file__).parent/'fixtures.json').read_text());ctx['decisionId']='synthetic-'+name+'-001'
    if name=='live_score_clock':ctx['kickoff']='2026-10-04T17:00:00Z';ctx['phase']='IN_PLAY'
    server=MockTransport(ctx);client=BuilderClient(server,sleeper=lambda s:None)
    before=client.board(ctx['arenaId'],summary=True);board=client.board(ctx['arenaId'],event_id=ctx['eventId']);decision=AGENTS[name](board['normalizedFixture'])
    forecast=client.forecast(**{'listing_id':ctx['listingId'],'probability':decision['forecast']['probability']}) if 'forecast' in decision else None
    pick=client.safe_buy(**decision['buy']) if decision['kind']=='BUY' else None
    positions=client.positions();after=client.board(ctx['arenaId'],summary=True);record=client.record()
    return {'agent':name,'evidence':'SYNTHETIC_OFFLINE_ONLY','networkRequests':0,'before':before,'decision':decision,'forecast':forecast,'pick':pick,'positions':positions,'after':after,'record':record,'requests':server.requests}
def main():
    p=argparse.ArgumentParser();p.add_argument('--agent',choices=list(AGENTS)+['all'],default='all');a=p.parse_args()
    print(json.dumps([run(n) for n in AGENTS] if a.agent=='all' else run(a.agent),indent=2,sort_keys=True))
if __name__=='__main__':main()
