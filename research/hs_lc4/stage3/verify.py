"""Current targeted tests, inherited evidence labels, and byte-safe research audit."""
import argparse,pathlib,re,subprocess,sys,math
from base import *
def command(out,name,args):
    p=subprocess.run(args,cwd=ROOT,capture_output=True,text=True,encoding='utf8',errors='replace');log=p.stdout+'\n'+p.stderr;(out/(name+'.log')).write_text(log,encoding='utf8');r={'exit_code':p.returncode,'log_sha256':sha(log.encode()),'mode':'EXECUTED_THIS_STAGE'};n=re.search(r'Ran (\d+) tests',log);details=re.search(r'(?:FAILED|OK) \(([^)]+)\)',log);c={k:int(v) for k,v in re.findall(r'(failures|errors|skipped)=(\d+)',details[1])} if details else {}
    if n:r.update(total=int(n[1]),fail=c.get('failures',0)+c.get('errors',0),skip=c.get('skipped',0));r['pass']=r['total']-r['fail']-r['skip']
    return r
def identities(out):
    paths=load(out/'event-paths.json');assert len(paths)==75
    for r in paths:
        if r['common_mature']:assert r['status']=='COMPLETE_PATH'
        if r['status']=='COMPLETE_PATH':assert r['date']<r['entry_open_date']<r['exit_open_date']
    stats=load(out/'distributions.json')
    for h,x in stats.items():
        n=x['common_mature']['close_return']['n'];assert n==14
        assert sum(g['close_return']['n'] for g in x['by0050_environment'].values())==n
        assert x['available_case']['close_return']['n']>=n
        for name in ['further_break','end_below_trigger_close','never_recovered_trigger_close']:
            f=x['common_mature'][name];assert 0<=f['count']<=f['n'];assert f['not_a_forecast']
    snap=load(out/'radar-snapshot.json');assert snap['score'] is None and snap['tiers'] is None and not snap['entry']['authorized'] and not snap['writer'];assert snap['training_end'][:4]<snap['asof'][:4]
    reused=load(out/'risk-comparison-reused.json');assert reused['source_sha256']==sha((P2/'all-models.json').read_bytes()) and len(reused['models'])==4
    ui=load(out/'ui-results.json');assert ui['input_html_sha256']==sha((out/'radar-design.html').read_bytes()) and ui['fail']==0
    return {'same_fixed_events':15,'common_mature':14,'path_records':75,'new_strategy_count':0,'horizon_denominators':'PASS','market_partition':'PASS','snapshot_authorization':'NOT_APPROVED','score':None}
def run(out):
    guard(out);tests={}
    for name,folder,pattern in [('stage3','research/hs_lc4/stage3','test_stage3.py'),('stage2','research/hs_lc4/stage2','test_stage2.py'),('stage1','research/hs_lc4','test_engine.py')]:
        tests[name]=command(out,'test-'+name,[sys.executable,'-m','unittest','discover','-s',folder,'-p',pattern]);assert tests[name]['exit_code']==0
    tests['L7_focused_existing_failure']=command(out,'test-L7-existing-failure',[sys.executable,'-m','unittest','discover','-s','research/hs_leverage','-p','test_phase_l7_anchor_review.py','-k','test_real_review_preparation_is_read_only_and_never_approval'])
    tests['original_worktrees']=command(out,'test-original-worktrees',[sys.executable,str(ROOT.parent/'hs-v330-evidence/audit-current.py')]);assert tests['original_worktrees']['exit_code']==0
    prior=load(P2/'verification.json');inherited={**prior['tests']['legacy_L7'],'mode':'REUSED_STAGE2_IDENTICAL_LEGACY_CODE_AND_CHAIN_BYTES','source_head':prior['head'],'not_a_new_full_suite_run':True}
    prot=guard(out);result={'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'tests':tests,'inherited_full_L7':inherited,'data_identities':identities(out),'protected':prot['protected'],'provenance':prot['provenance'],'chains':prot['chains'],'prior_stages_all_code_evidence':'BYTE_IDENTICAL','original_dirty_main':'UNCHANGED','formal_writer':'UNCHANGED_OFF','formal_shadow':'NO_RECOVERY','UI':load(out/'ui-results.json') if (out/'ui-results.json').exists() else {'status':'PENDING'},'production_deployed':False};dump(out/'verification.json',result);print(json.dumps(result,ensure_ascii=True))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);run(pathlib.Path(p.parse_args().out).resolve())
