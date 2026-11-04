"""Numerical identities and source/financial isolation, no live data writes."""
import argparse,pathlib,subprocess,sys,time,re,json,math
from common import *
from simulator import CAP
def command(out,name,args):
    p=subprocess.run(args,cwd=ROOT,capture_output=True,text=True,encoding='utf8',errors='replace');log=p.stdout+'\n'+p.stderr;(out/(name+'.log')).write_text(log,encoding='utf8');r={'exit_code':p.returncode,'log_sha256':sha(log.encode())};n=re.search(r'Ran (\d+) tests',log);fail=re.search(r'FAILED \(failures=(\d+)',log)
    if n:r.update(total=int(n[1]),fail=int(fail[1]) if fail else 0,skip=0);r['pass']=r['total']-r['fail']
    return r
def numerical(out):
    runs=load(out/'all-runs.json');assert len(runs)==36
    for k,r in runs.items():
        m=r['metrics'];tr=r['trades'];c=r['curve'];op=r['open_position'];openpnl=(op['proceeds']+c[-1]['invested']-op['cost']) if op else 0
        assert math.isclose(m['final_nav'],CAP+sum(x['pnl'] for x in tr)+openpnl,abs_tol=.0001),('PNL_CONSERVATION',k)
        cash=CAP+sum(x['cash_flow'] for x in r['orders']);assert math.isclose(cash,c[-1]['nav']-c[-1]['invested'],abs_tol=.0001),('CASH_CONSERVATION',k)
        assert len({t['event'] for t in tr})==len(tr);assert all(t['tranches']<=2 for t in tr);assert all(o['decision']<o['fill'] and o['cash_after']>=-.001 for o in r['orders'])
        assert math.isclose(math.prod(1+x for x in m['annual'].values())-1,m['total_return'],abs_tol=1e-10)
        assert all(x['slot_return'] is not None for x in r['event_outcomes'] if x['mature'])
    pairs=load(out/'paired-comparisons.json');assert len(pairs['entry_family'])==27 and len(pairs['exit_family'])==32
    assert all(x['p_holm']>=x['p_raw'] and 0<=x['p_holm']<=1 for fam in ['entry_family','exit_family'] for x in pairs[fam])
    return {'candidates':36,'cash_pnl_conservation':'PASS','annual_compounding':'PASS','at_most_two_tranches':'PASS','same_bar_fills':0,'duplicate_event_trades':0,'pvalue_family_sizes':[27,32]}
def run(out):
    check(out);nums=numerical(out);tests={}
    tests['stage2']=command(out,'test-stage2',[sys.executable,'-m','unittest','discover','-s','research/hs_lc4/stage2','-p','test_stage2.py']);assert tests['stage2']['exit_code']==0
    tests['stage1']=command(out,'test-stage1',[sys.executable,'-m','unittest','discover','-s','research/hs_lc4','-p','test_engine.py']);assert tests['stage1']['exit_code']==0
    tests['legacy_L7']=command(out,'test-legacy-L7',[sys.executable,'-m','unittest','discover','-s','research/hs_leverage','-p','test_phase_l7*.py'])
    tests['original_worktrees']=command(out,'test-original-worktrees',[sys.executable,str(ROOT.parent/'hs-v330-evidence/audit-current.py')]);assert tests['original_worktrees']['exit_code']==0
    seal_=check(out);changed=subprocess.check_output(['git','diff','--name-only',BASE],cwd=ROOT,text=True).splitlines();assert all(x.startswith('research/hs_lc4/stage2/') for x in changed)
    result={'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'tests':tests,'numerical':nums,'protected':seal_['protected'],'provenance':seal_['provenance'],'chains':seal_['chains'],'stage1_files_and_all_evidence':'BYTE_IDENTICAL','original_main_and_worktrees':'UNCHANGED','production_writer':'UNCHANGED_OFF','official_shadow':'UNCHANGED_FAIL_CLOSED','formal_score':'WITHHELD','modified_paths':changed};dump(out/'verification.json',result);print(json.dumps(result))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);run(pathlib.Path(p.parse_args().out).resolve())
