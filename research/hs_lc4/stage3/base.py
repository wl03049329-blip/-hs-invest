"""Read-only prior stages; only new evidence directory may be written."""
import pathlib,sys,json,subprocess
sys.dont_write_bytecode=True
HERE=pathlib.Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/'stage2'));sys.path.insert(1,str(HERE.parent))
import common as prior
from capture import ROOT,sha,dump,FIELDS
from common import load,P1
P2=ROOT.parent/'hs-lc4-stage2-evidence';BASE='3cc239a80c0c8fee5553add54c9bea6ab987963f'
P=load(HERE/'protocol.json')
def guard(out):
    out=pathlib.Path(out).resolve();assert ROOT not in out.parents and out!=ROOT
    for old in [P1,P2]:assert out!=old and old not in out.parents
    oldseal=prior.check(P2)
    files={f'{tag}/{f.relative_to(old)}':sha(f.read_bytes()) for tag,old in [('stage1',P1),('stage2',P2)] for f in old.rglob('*') if f.is_file()}
    for name in subprocess.check_output(['git','ls-tree','-r','--name-only',BASE,'--','research/hs_lc4'],cwd=ROOT,text=True).splitlines():assert (ROOT/name).read_bytes()==subprocess.check_output(['git','show',BASE+':'+name],cwd=ROOT),('PRIOR_CODE_CHANGED',name)
    changed=subprocess.check_output(['git','diff','--name-only',BASE],cwd=ROOT,text=True).splitlines();assert all(x.startswith('research/hs_lc4/stage3/') for x in changed)
    out.mkdir(parents=True,exist_ok=True);p=out/'prior-stages-seal.json'
    if p.exists():assert load(p)['files']==files,'PRIOR_EVIDENCE_CHANGED'
    else:dump(p,{'base':BASE,'files':files,'protected':oldseal})
    return oldseal
