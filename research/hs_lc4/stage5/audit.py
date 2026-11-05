"""Stage5 change boundary and immutable prior-stage/worktree evidence."""
import pathlib,sys,subprocess,json,hashlib
sys.dont_write_bytecode=True
ROOT=pathlib.Path(__file__).resolve().parents[3];E=ROOT.parent/'hs-lc4-stage5-evidence'
BASE='45c4224e9d91b42f180dbcdafe3df055a5dbba35'
ALLOWED={'scripts/lc4_research_daily.py','tests/test_lc4_research_daily.py','.github/workflows/lc4-research-daily.yml','lc4-research.js'}
PREFIX=('scripts/lc4_research_release','tests/test_lc4_release','tests/fixtures/lc4-research/','research/hs_lc4/stage5/')
def sha(b):return hashlib.sha256(b).hexdigest()
def dump(p,x):p=pathlib.Path(p);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n',encoding='utf8',newline='\n')
def check():
    E.mkdir(exist_ok=True);prior={}
    for name in ('hs-lc4-evidence','hs-lc4-stage2-evidence','hs-lc4-stage3-evidence','hs-lc4-stage4-evidence'):
        for f in (ROOT.parent/name).rglob('*'):
            if f.is_file():prior[name+'/'+f.relative_to(ROOT.parent/name).as_posix()]=sha(f.read_bytes())
    seal=E/'prior-stage-seal.json'
    if seal.exists():assert json.loads(seal.read_text(encoding='utf8'))==prior,'PRIOR_EVIDENCE_CHANGED'
    else:dump(seal,prior)
    names=subprocess.check_output(['git','ls-tree','-r','--name-only',BASE],cwd=ROOT,text=True).splitlines();checked=0
    for name in names:
        if name in ALLOWED:continue
        old=subprocess.check_output(['git','show',BASE+':'+name],cwd=ROOT)
        assert (ROOT/name).read_bytes()==old,('PRIOR_BLOB_CHANGED',name);checked+=1
    changes=subprocess.check_output(['git','diff','--name-only',BASE],cwd=ROOT,text=True).splitlines()
    assert all(n in ALLOWED or n.startswith(PREFIX) for n in changes),changes
    untracked=subprocess.check_output(['git','ls-files','--others','--exclude-standard'],cwd=ROOT,text=True).splitlines()
    assert all(n.startswith(PREFIX) for n in untracked),untracked
    sys.path.insert(0,str(ROOT/'research/hs_leverage'));import phase_l7_shadow as sh
    policy,_=sh.load_context(ROOT);assert len(policy['protected_hashes'])==20 and sh.validate_provenance(policy)
    chains={p.name:sh.validate_hash_chain(p) for p in (ROOT/'research/hs_leverage/forward').glob('*.jsonl')}
    assert len(chains)==3 and all(v['status']=='PASS' for v in chains.values())
    return {'base':BASE,'unchanged_baseline_blobs':checked,'prior_evidence_files':len(prior),'prior_stages':'BYTE_IDENTICAL',
            'protected':20,'provenance':len(sh.PROVENANCE_SCOPE),'chains':chains,'allowed_changes':changes}
if __name__=='__main__':
    result=check();dump(E/'audit.json',result);print(json.dumps(result))
