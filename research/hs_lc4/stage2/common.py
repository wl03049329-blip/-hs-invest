"""Stage2 isolation: never write a stage1 or production path."""
import pathlib,sys,json,subprocess
HERE=pathlib.Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent))
from capture import ROOT,sha,dump,seal,FIELDS
BASE='867c244804af37e154db387c32c52a9932284794'
P1=ROOT.parent/'hs-lc4-evidence'
P=json.loads((HERE/'protocol.json').read_text(encoding='utf8'))
def load(p):return json.loads(pathlib.Path(p).read_text(encoding='utf8'))
def check(out):
    out=pathlib.Path(out).resolve();assert out!=P1 and P1 not in out.parents and ROOT not in out.parents
    s=seal(P1);files={str(f.relative_to(P1)):sha(f.read_bytes()) for f in P1.rglob('*') if f.is_file()}
    for name in subprocess.check_output(['git','ls-tree','-r','--name-only',BASE,'--','research/hs_lc4'],cwd=ROOT,text=True).splitlines():
        blob=subprocess.check_output(['git','show',BASE+':'+name],cwd=ROOT);assert (ROOT/name).read_bytes()==blob,('PHASE1_CODE_CHANGED',name)
    out.mkdir(parents=True,exist_ok=True);before=out/'stage1-seal.json'
    if before.exists():assert load(before)['files']==files,'PHASE1_EVIDENCE_CHANGED'
    else:dump(before,{'base':BASE,'files':files,'legacy_protection':s})
    for name,r in load(P1/'source-manifest.json').items():assert sha((P1/'raw'/name).read_bytes())==r['sha256']
    for symbol,r in load(P1/'dataset-manifest.json').items():assert sha((P1/('adjusted-'+symbol+'.json')).read_bytes())==r['sha256']
    return s
