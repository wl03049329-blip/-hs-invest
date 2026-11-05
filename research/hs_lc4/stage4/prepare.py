"""One-time local packaging of audited stages; originals are read-only."""
import gzip, json, sys
from datetime import datetime, timezone
from protect import ROOT, EVIDENCE, load, dump, sha

def run():
    p1=ROOT.parent/'hs-lc4-evidence';p2=ROOT.parent/'hs-lc4-stage2-evidence';p3=ROOT.parent/'hs-lc4-stage3-evidence'
    out=ROOT/'data/lc4-research';out.mkdir(parents=True,exist_ok=True)
    manifest=load(p1/'source-manifest.json');sources={}
    for name,ref in manifest.items():
        raw=(p1/'raw'/name).read_bytes()
        assert sha(raw)==ref['sha256'], ('SOURCE_BYTES_CHANGED',name)
        sources[name]={'receipt':ref,'payload':json.loads(raw)}
    encoded=gzip.compress(json.dumps(sources,ensure_ascii=False,separators=(',',':')).encode(),mtime=0)
    (out/'seed-sources.json.gz').write_bytes(encoded)
    bundle={'schema':'HS_LC4_RESEARCH_HISTORY_V1','model':'STAGE3_FIXED_DESCRIPTIVE_V1',
      'asof':load(p3/'radar-snapshot.json')['asof'],
      'histories':{'00631L':load(p3/'research-copy-00631L.json')['rows'],
                   '0050':load(p1/'adjusted-0050.json')['rows']},
      'fixed_events':load(p2/'events.json'),'review':load(p3/'data-review.json'),
      'source_manifest':manifest,'seed_sources_sha256':sha(encoded),
      'frozen_model_selection_history':True,'historical_as_published_vintages':False}
    raw=gzip.compress(json.dumps(bundle,ensure_ascii=False,separators=(',',':')).encode(),mtime=0)
    (out/'seed-history.json.gz').write_bytes(raw)
    dump(out/'seed.json',{'schema':'HS_LC4_RESEARCH_SEED_V1','history_sha256':sha(raw),
                         'sources_sha256':sha(encoded),'asof':bundle['asof'],
                         'prior_stage_commit':'2de99f950d87b3f4befb4d507019dbe423320107'})
    dump(EVIDENCE/'seed-packaging.json',{'sources':len(sources),'history_sha256':sha(raw),
       'sources_sha256':sha(encoded),'rows':{s:len(r) for s,r in bundle['histories'].items()}})

if __name__=='__main__':run()
