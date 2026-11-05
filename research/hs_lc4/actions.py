"""Capture official TWSE ex-right/dividend calendar (all securities, annual scope)."""
import argparse,pathlib,time
from capture import request,dump,seal
def run(out):
    seal(out);results=[]
    for year in range(2014,2027):
        name=f'twse-actions-{year}';url=f'https://www.twse.com.tw/exchangeReport/TWT49U?response=json&startDate={year}0101&endDate={year}1231'
        p=request(out,name,url);assert p.get('stat')=='OK',(year,p.get('stat'));results.append({'year':year,'fields':p.get('fields'),'rows':len(p.get('data',[]))});print(year,results[-1],flush=True);time.sleep(1)
    dump(out/'actions-capture.json',results)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);run(pathlib.Path(p.parse_args().out).resolve())
