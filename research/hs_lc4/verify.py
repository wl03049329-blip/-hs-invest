"""Persist actual test output and immutable legacy/other-worktree verification."""
import argparse,json,pathlib,re,subprocess,sys,time
from capture import ROOT,dump,sha,seal
def command(out,name,args,cwd=ROOT):
    start=time.monotonic();p=subprocess.run(args,cwd=cwd,capture_output=True,text=True,encoding='utf8',errors='replace');log=p.stdout+'\n'+p.stderr;(out/(name+'.log')).write_text(log,encoding='utf8');r={'exit_code':p.returncode,'duration_seconds':time.monotonic()-start,'log_sha256':sha(log.encode())}
    ran=re.search(r'Ran (\d+) tests',log)
    if ran:
        total=int(ran[1]);bad=re.search(r'FAILED \(failures=(\d+)',log);fail=int(bad[1]) if bad else 0;r.update({'total':total,'pass':total-fail,'fail':fail,'skip':0})
    return r
def run(out):
    before=seal(out);tests={}
    tests['research']=command(out,'test-research',[sys.executable,'-m','unittest','discover','-s','research/hs_lc4','-p','test_engine.py']);assert tests['research']['exit_code']==0
    tests['legacy_L7']=command(out,'test-legacy-L7',[sys.executable,'-m','unittest','discover','-s','research/hs_leverage','-p','test_phase_l7*.py'])
    tests['original_worktrees']=command(out,'test-original-worktrees',[sys.executable,str(ROOT.parent/'hs-v330-evidence/audit-current.py')]);assert tests['original_worktrees']['exit_code']==0
    after=seal(out);assert before['files']==after['files']
    changed=subprocess.check_output(['git','diff','--name-only','7cb3a015e565222d95cdc42ec8eac100951f6cbe'],cwd=ROOT,text=True).splitlines();assert all(x.startswith('research/hs_lc4/') for x in changed)
    results={'commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'tests':tests,'protected':after['protected'],'provenance':after['provenance'],'chains':after['chains'],'legacy_files_byte_identical':True,'production_changes':False,'writer':'UNCHANGED_OFF','scope':'RESEARCH_ONLY','legacy_failure_not_suppressed':tests['legacy_L7']['exit_code']!=0,'modified_scope':changed}
    dump(out/'verification.json',results);print(json.dumps(results,ensure_ascii=True))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);run(pathlib.Path(p.parse_args().out).resolve())
