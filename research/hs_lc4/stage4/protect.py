"""Stage4 permits code repair, never mutation of prior research/data evidence."""
import pathlib,sys,json,subprocess,hashlib
sys.dont_write_bytecode=True
HERE=pathlib.Path(__file__).resolve().parent;ROOT=HERE.parents[2]
sys.path.insert(0,str(ROOT/'research/hs_leverage'))
import phase_l7_shadow as shadow
BASE='2de99f950d87b3f4befb4d507019dbe423320107'
EVIDENCE=ROOT.parent/'hs-lc4-stage4-evidence'
ALLOWED={'index.html','tests/helpers/final_refresh_projection.cjs','research/hs_leverage/phase_l7_daily.py','research/hs_leverage/test_phase_l7_anchor_review.py','research/hs_leverage/test_phase_l7_daily.py','research/hs_leverage/test_phase_l7_incidents.py'}
PREFIX=('research/hs_lc4/stage4/','data/lc4-research/','tests/test_lc4','scripts/lc4_')
NEW={'lc4-research.js','lc4-research.css','.github/workflows/lc4-research-daily.yml','research/hs_leverage/test_phase_l7_status_timing.py'}
def sha(b):return hashlib.sha256(b).hexdigest()
def load(p):return json.loads(pathlib.Path(p).read_text(encoding='utf8'))
def dump(p,x):p=pathlib.Path(p);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(x,ensure_ascii=False,indent=2,allow_nan=False)+'\n',encoding='utf8',newline='\n')
def check():
    EVIDENCE.mkdir(exist_ok=True);prior={}
    for directory in ['hs-lc4-evidence','hs-lc4-stage2-evidence','hs-lc4-stage3-evidence']:
        old=ROOT.parent/directory
        for f in old.rglob('*'):
            if f.is_file():prior[directory+'/'+str(f.relative_to(old))]=sha(f.read_bytes())
    p=EVIDENCE/'prior-evidence-seal.json'
    if p.exists():assert load(p)==prior,'PRIOR_EVIDENCE_CHANGED'
    else:dump(p,prior)
    files=subprocess.check_output(['git','ls-tree','-r','--name-only',BASE],cwd=ROOT,text=True).splitlines();bad=[]
    for n in files:
        if n in ALLOWED:continue
        old=subprocess.check_output(['git','show',BASE+':'+n],cwd=ROOT)
        if not (ROOT/n).exists() or (ROOT/n).read_bytes()!=old:bad.append(n)
    assert not bad,('UNAUTHORIZED_BASELINE_CHANGE',bad)
    for n in subprocess.check_output(['git','diff','--name-only',BASE],cwd=ROOT,text=True).splitlines():assert n in ALLOWED or n in NEW or n.startswith(PREFIX),('OUT_OF_SCOPE',n)
    policy,_=shadow.load_context(ROOT);assert shadow.validate_provenance(policy)
    chains={p.name:shadow.validate_hash_chain(p) for p in (ROOT/'research/hs_leverage/forward').glob('*.jsonl')};assert len(chains)==3 and all(r['status']=='PASS' for r in chains.values())
    archive=EVIDENCE/'baseline-2de99f9.tar'
    if not archive.exists():
        with archive.open('wb') as f:subprocess.run(['git','archive','--format=tar',BASE],cwd=ROOT,stdout=f,check=True)
    return {'base':BASE,'protected':len(policy['protected_hashes']),'provenance':len(shadow.PROVENANCE_SCOPE),'chains':chains,'prior_evidence_files':len(prior),'prior_evidence':'BYTE_IDENTICAL','baseline_archive_sha256':sha(archive.read_bytes()),'unauthorized_changes':bad}
if __name__=='__main__':print(json.dumps(check()))
