"""Research-only release gate, default PLAN. Never invoked remotely in Stage5.

The execute command is disabled outside explicitly approved main-only Actions.
No financial/Shadow files are staged, no force/rebase, and no second publisher.
"""
import argparse, datetime as dt, json, os, re, shutil, subprocess, sys, time
from pathlib import Path
from urllib.request import urlopen
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from scripts import lc4_research_daily as d

REPO='wl03049329-blip/-hs-invest'
BASE_URL='https://wl03049329-blip.github.io/-hs-invest/'
PREFIX='data/lc4-research/'
SCHEMA='HS_LC4_RESEARCH_RELEASE_PLAN_V1'
SNAP=re.compile(r'snapshots/\d{4}-\d{2}-\d{2}-r\d{6}-[a-f0-9]{12}\.json')
def git(root,*args):return subprocess.check_output(['git',*args],cwd=root,text=True,encoding='utf8').strip()
def require(v,reason):d.require(v,reason)
def stamp(value):
    t=dt.datetime.fromisoformat(value);require(t.tzinfo is not None,'UTC_EVIDENCE_REQUIRED');return t

class RecordedSources:
    """Strict offline replay of this run's original response receipts."""
    def __init__(self,directory,now):
        self.entries={}
        for f in Path(directory).glob('*.json'):
            e=d.read(f)
            if not isinstance(e,dict) or not {'url','payload','sha256','fetched_at'}<=e.keys():continue
            require(d.digest(e['payload'])==e['sha256'],'SOURCE_RECEIPT_HASH')
            t=stamp(e['fetched_at'])
            require(t<=now and t.astimezone(d.TZ).date()==now.astimezone(d.TZ).date(),'SOURCE_RECEIPT_DATE')
            require(e['url'] not in self.entries,'DUPLICATE_SOURCE_URL')
            self.entries[e['url']]=e
        require(bool(self.entries),'SOURCE_EVIDENCE_MISSING')
    def get(self,url):
        require(url in self.entries,'SOURCE_EVIDENCE_MISSING:'+url)
        return self.entries[url]

def audit_chain(root):
    directory=Path(root)/d.DIR;p=d.read(directory/'latest.json');nodes={}
    for f in (directory/'snapshots').glob('*.json'):
        raw=f.read_bytes();b=json.loads(raw);h=d.sha(raw)
        require(SNAP.fullmatch('snapshots/'+f.name) and f.stem.endswith(h[:12]),'SNAPSHOT_NAME_HASH')
        require(b.get('schema')=='HS_LC4_RESEARCH_BUNDLE_V1' and b.get('research_only') is True and
                b.get('writer') is False and b.get('entry_authorized') is False and b.get('score') is None,'RESEARCH_AUTHORIZATION_INVALID')
        nodes[h]=b
    seen=set();key=p['sha256'];last=None
    while key:
        require(key in nodes and key not in seen,'RESEARCH_CHAIN_MISSING_OR_CYCLIC')
        b=nodes[key];seen.add(key)
        if last:require(last['revision']==b['revision']+1 and last['asof']>=b['asof'],'RESEARCH_CHAIN_ORDER')
        last=b;key=b['previous_bundle_sha256']
    require(last is not None and last['revision']==1,'RESEARCH_CHAIN_ORIGIN')
    return p,nodes[p['sha256']],len(seen)

def rollback_review(root,target_sha):
    """Read-only recovery proof, not a silent high-water or financial rewind."""
    p,b,_=audit_chain(root);directory=Path(root)/d.DIR
    nodes={d.sha(f.read_bytes()):json.loads(f.read_bytes()) for f in (directory/'snapshots').glob('*.json')}
    key=p['sha256'];reachable=set()
    while key:reachable.add(key);key=nodes[key]['previous_bundle_sha256']
    require(target_sha in reachable,'ROLLBACK_NOT_VERIFIED_ANCESTOR')
    old=nodes[target_sha]
    return {'schema':'HS_LC4_ROLLBACK_REVIEW_V1','asof':old['asof'],'snapshot_sha256':target_sha,
        'display':'VERIFIED_HISTORICAL_REVIEW_ONLY','automatic_promotion':False,
        'recovery':'DISABLE_RESEARCH_PUBLICATION_THEN_NORMAL_CODE_REVERT_KEEP_ALL_DATA',
        'writer':False,'entry_authorized':False,'changes_financial_data':False}

def files(root):
    directory=Path(root)/d.DIR
    require(not any(f.is_symlink() for f in directory.rglob('*')),'RESEARCH_SYMLINK_REJECTED')
    return {f.relative_to(directory).as_posix():f.read_bytes() for f in directory.rglob('*') if f.is_file()}

def validate_plan_paths(plan):
    require(plan.get('schema')==SCHEMA and plan.get('repository')==REPO and plan.get('writer') is False
            and plan.get('formal_shadow_authorized') is False and plan.get('research_only') is True,'PLAN_CONTRACT')
    require(re.fullmatch('[a-f0-9]{40}',plan.get('source_commit','')),'PLAN_COMMIT')
    require(1<=len(plan['changes'])<=3,'PLAN_CHANGE_COUNT')
    paths=[]
    for e in plan['changes']:
        name=e['path'];require(name.startswith(PREFIX),'PLAN_PATH')
        tail=name[len(PREFIX):]
        require(tail in ('latest.json','status.json') or SNAP.fullmatch(tail),'PLAN_PATH')
        require(re.fullmatch('[a-f0-9]{64}',e['sha256']) and type(e['bytes']) is int and 0<e['bytes']<=8000000,'PLAN_FILE_PIN')
        paths.append(name)
    require(len(paths)==len(set(paths)) and PREFIX+'status.json' in paths,'PLAN_DUPLICATE_OR_MISSING_STATUS')
    copy=dict(plan);operation=copy.pop('operation_id');require(d.digest(copy)==operation,'PLAN_HASH')

def validate_candidate(staged,evidence,now,base_history):
    history=d.load_history(staged);p,b,n=audit_chain(staged);op=d.read(Path(staged)/d.DIR/'status.json')
    require(op.get('status') in ('NOOP','VERIFIED_RESEARCH_UPDATED') and op.get('live_source_check') is True and
            op.get('writer') is False and op.get('schema')=='HS_LC4_RESEARCH_OPERATION_V2','UPDATE_NOT_VERIFIED')
    require(op.get('bundle_sha256')==p['sha256'] and op.get('asof')==p['asof'] and
            op.get('verified_target')==p['asof'],'OPERATION_BUNDLE_MISMATCH')
    source=RecordedSources(evidence,now);checked=stamp(op['checked_at'])
    require(checked<=now and checked.astimezone(d.TZ).date()==now.astimezone(d.TZ).date(),'CHECK_TIME_INVALID')
    require(all(stamp(e['fetched_at'])<=checked for e in source.entries.values()),'CHECK_PRECEDES_SOURCES')
    for ref in op['source_receipts']:
        e=source.get(ref['url']);require(d.ref(e)==ref,'SOURCE_REFERENCE_MISMATCH')
    require(len(op['source_receipts'])==len(source.entries),'INCOMPLETE_SOURCE_REFERENCES')
    target,_,_=d.research_expected_day(source,now)
    require(target==p['asof'],'RESEARCH_DATE_BEHIND_OR_FUTURE')
    # Replay from the same verified parent used by generation. Revalidating
    # from the NEW anchor would request a different corporate-action range,
    # discard the original receipt identity and fail every real new-day update.
    require(d.extend(base_history,source,target)==history,'UNPUBLISHED_COMPLETE_BARS')
    d.validate_source_timing(source,target,now)
    expected=d.describe(history);actual=b['description']
    # Formal operational status may evolve independently. Compare ALL research
    # mathematics but never turn snapshot/cache review metadata into authority.
    for obj in (expected,actual):
        obj['radar']=dict(obj['radar']);obj['radar']['data']={k:v for k,v in obj['radar']['data'].items()
             if k not in ('canonical_incidents','cached_incidents','formal_shadow')}
    require(actual==expected,'RESEARCH_MODEL_OR_DESCRIPTION_MISMATCH')
    return {'target':target,'pointer':p,'operation':op,'chain_nodes':n}

def create_plan(root,staged,evidence,now):
    root=Path(root).resolve();staged=Path(staged).resolve()
    require(root!=staged and root not in staged.parents,'STAGING_MUST_BE_ISOLATED')
    proof=validate_candidate(staged,evidence,now,d.load_history(root));oldp,_,_=audit_chain(root)
    before,after=files(root),files(staged);p=proof['pointer']
    require(set(before)<=set(after),'RESEARCH_FILE_DELETION')
    changed=[]
    for name,raw in after.items():
        if before.get(name)==raw:continue
        require(name in ('latest.json','status.json') or (SNAP.fullmatch(name) and name not in before and
                name==p['path'] and p['revision']>oldp['revision']),'OUT_OF_SCOPE_RESEARCH_CHANGE:'+name)
        changed.append({'path':PREFIX+name,'sha256':d.sha(raw),'bytes':len(raw)})
    p=proof['pointer']
    require(p['revision']>=oldp['revision'] and p['asof']>=oldp['asof'],'RESEARCH_POINTER_ROLLBACK')
    if p['revision']==oldp['revision']:require(p==oldp,'REVISION_PAYLOAD_REUSED')
    else:
        # All prior immutable snapshots must still form a prefix of the chain.
        current=d.read(Path(staged)/d.DIR/p['path'])
        prev=current['previous_bundle_sha256'];seen=set()
        bysha={d.sha(v):json.loads(v) for k,v in after.items() if SNAP.fullmatch(k)}
        while prev and prev!=oldp['sha256']:
            require(prev in bysha and prev not in seen,'OLD_POINTER_NOT_ANCESTOR');seen.add(prev);prev=bysha[prev]['previous_bundle_sha256']
        require(prev==oldp['sha256'],'OLD_POINTER_NOT_ANCESTOR')
    require(bool(changed),'NO_VERIFIED_OPERATION_RECORD')
    plan={'schema':SCHEMA,'repository':REPO,'source_commit':git(root,'rev-parse','HEAD'),
          'created_at':now.isoformat(),'target_date':proof['target'],'pointer':p,'previous_pointer':oldp,
          'changes':sorted(changed,key=lambda x:x['path']),'code_assets':{n:d.sha((root/n).read_bytes()) for n in ('lc4-research.js','lc4-research.css')},
          'generation_status':proof['operation']['status'],'chain_nodes':proof['chain_nodes'],
          'formal_shadow_authorized':False,'writer':False,'research_only':True}
    plan['operation_id']=d.digest(plan);validate_plan_paths(plan);return plan

def validate_plan(root,staged,evidence,plan,now):
    validate_plan_paths(plan)
    expected=create_plan(root,staged,evidence,now)
    # Revalidation time changes, not the bound candidate or operation.
    expected['created_at']=plan['created_at'];expected.pop('operation_id');expected['operation_id']=d.digest(expected)
    require(expected==plan,'RELEASE_INPUTS_CHANGED');return plan

def package(root,staged,evidence,plan,delta,now):
    validate_plan(root,staged,evidence,plan,now);delta=Path(delta).resolve()
    require(not delta.exists() and Path(root).resolve() not in delta.parents,'ISOLATED_NEW_DELTA_REQUIRED')
    for entry in plan['changes']:
        dest=delta/entry['path'];dest.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(Path(staged)/entry['path'],dest)
    return {'status':'VERIFIED_DELTA_PACKAGED','files':len(plan['changes']),'bytes':sum(e['bytes'] for e in plan['changes'])}

def materialize(root,delta,staged,evidence,plan,now):
    validate_plan_paths(plan)
    staged=Path(staged).resolve();root=Path(root).resolve();delta=Path(delta)
    require(not staged.exists() and root!=staged and root not in staged.parents,'ISOLATED_NEW_STAGE_REQUIRED')
    actual={f.relative_to(delta).as_posix() for f in delta.rglob('*') if f.is_file()}
    require(actual=={e['path'] for e in plan['changes']},'DELTA_FILE_SET_MISMATCH')
    require(git(root,'rev-parse','HEAD')==plan['source_commit'],'MAIN_ADVANCED_REGENERATE_NO_REBASE')
    require(d.read(root/d.DIR/'latest.json')==plan['previous_pointer'],'BASE_POINTER_CHANGED')
    shutil.copytree(root/d.DIR,staged/d.DIR)
    for e in plan['changes']:
        src=delta/e['path'];require(not src.is_symlink() and src.is_file() and d.sha(src.read_bytes())==e['sha256'],'DELTA_HASH_MISMATCH')
        dest=staged/e['path'];dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dest)
    validate_plan(root,staged,evidence,plan,now)
    return {'status':'VERIFIED_STAGE_MATERIALIZED','remote_writes':0}

class Commands:
    def __init__(self,root):self.root=Path(root)
    def run(self,*args):return subprocess.check_output(args,cwd=self.root,text=True,encoding='utf8',stderr=subprocess.PIPE).strip()
    def read_index(self,name):return subprocess.check_output(['git','show',':'+name],cwd=self.root)

def execution_guard(root,env):
    require(env.get('GITHUB_ACTIONS')=='true' and env.get('GITHUB_REPOSITORY')==REPO and
        env.get('GITHUB_REF')=='refs/heads/main' and env.get('HS_LC4_RESEARCH_ENABLED')=='true' and
        env.get('HS_LC4_RESEARCH_PUBLISH_ENABLED')=='true' and env.get('HS_LC4_RELEASE_APPROVED')=='true','REMOTE_PUBLICATION_NOT_AUTHORIZED')
    require(env.get('GITHUB_EVENT_NAME') in ('schedule','workflow_dispatch'),'UNAPPROVED_EVENT')
    require(git(root,'branch','--show-current')=='main','MAIN_ONLY')
    require(not git(root,'status','--porcelain'),'PUBLISH_CHECKOUT_NOT_CLEAN')

def verify_public(plan,published_commit,fetch,runs):
    receipt=json.loads(fetch('app-release.json'))
    require(receipt.get('schema')=='HS_STABLE_APP_RELEASE_V1' and receipt.get('deployment_commit')==published_commit and
            receipt.get('financial_writer') is False and receipt.get('storage_contract')=='hsPersonalV3.v1','PUBLIC_DEPLOYMENT_RECEIPT_MISMATCH')
    require(any(r.get('head_sha')==published_commit and r.get('head_branch')=='main' and
       r.get('status')=='completed' and r.get('conclusion')=='success' for r in runs),'PAGES_RUN_NOT_SUCCESSFUL')
    pointer=json.loads(fetch(PREFIX+'latest.json'));require(pointer==plan['pointer'],'PUBLIC_RESEARCH_POINTER_MISMATCH')
    raw=fetch(PREFIX+pointer['path']);require(d.sha(raw)==pointer['sha256'] and len(raw)==pointer['bytes'],'PUBLIC_RESEARCH_BUNDLE_MISMATCH')
    op_raw=fetch(PREFIX+'status.json');op=json.loads(op_raw)
    status=next(c for c in plan['changes'] if c['path']==PREFIX+'status.json')
    require(d.sha(op_raw)==status['sha256'] and op.get('verified_target')==plan['target_date'] and op.get('live_source_check') is True,'PUBLIC_RESEARCH_STATUS_MISMATCH')
    for name,pin in plan['code_assets'].items():
        asset=next((a for a in receipt['assets'] if a['url'].split('?')[0]==name),None)
        require(asset and asset['sha256']==pin and asset['url']==name+'?v='+pin,'PUBLIC_CODE_VERSION_MISMATCH')
        code=fetch(asset['url']);require(d.sha(code)==pin and len(code)==asset['bytes'],'PUBLIC_CODE_BYTES_MISMATCH')
    asset=next(a for a in receipt['assets'] if a['url'].split('?')[0]=='index.html')
    html=fetch(asset['url']);require(d.sha(html)==asset['sha256'] and len(html)==asset['bytes'] and b'data-lc4-research-open' in html,'PUBLIC_ROOT_INTEGRATION_MISMATCH')
    return {'status':'PUBLIC_RESEARCH_VERIFIED','deployment_commit':published_commit,'asof':pointer['asof'],'writer':False}

def execute(root,staged,evidence,plan,state_path,env=None,commands=None,fetch=None,sleep=time.sleep):
    env=os.environ if env is None else env;execution_guard(root,env)
    now=dt.datetime.now(dt.timezone.utc);validate_plan(root,staged,evidence,plan,now)
    cmd=commands or Commands(root);state={'operation_id':plan['operation_id'],'phase':'VALIDATED','writer':False}
    def phase(name,**extra):state.update(phase=name,**extra);d.atomic_json(Path(state_path),state)
    remote=json.loads(cmd.run('gh','api',f'repos/{REPO}/git/ref/heads/main'))['object']['sha']
    require(remote==plan['source_commit'],'MAIN_ADVANCED_REGENERATE_NO_REBASE')
    for entry in plan['changes']:
        dest=Path(root)/entry['path'];src=Path(staged)/entry['path'];raw=src.read_bytes()
        require(d.sha(raw)==entry['sha256'] and len(raw)==entry['bytes'],'STAGED_BYTES_CHANGED')
        dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(raw)
    cmd.run('git','-c','core.autocrlf=false','add','--',*[e['path'] for e in plan['changes']])
    require(set(cmd.run('git','diff','--cached','--name-only').splitlines())=={e['path'] for e in plan['changes']},'UNEXPECTED_STAGED_PATH')
    for e in plan['changes']:
        raw=cmd.read_index(e['path']);require(d.sha(raw)==e['sha256'] and len(raw)==e['bytes'],'STAGED_BYTE_PIN_MISMATCH')
    cmd.run('git','-c','user.name=github-actions[bot]','-c','user.email=41898282+github-actions[bot]@users.noreply.github.com',
            'commit','-m','Update verified L-C4 research '+plan['target_date'])
    commit=cmd.run('git','rev-parse','HEAD');phase('LOCAL_COMMITTED',commit=commit)
    phase('PUSH_REQUESTED');cmd.run('git','push','origin','HEAD:main');phase('PUSH_CONFIRMED')
    # GITHUB_TOKEN pushes do not trigger another push workflow. Dispatch ONLY
    # the existing Stable Pages publisher, never a financial/Shadow workflow.
    url=f'repos/{REPO}/actions/workflows/hs-stable-pages.yml/runs?event=workflow_dispatch&per_page=20'
    previous=max([r['id'] for r in json.loads(cmd.run('gh','api',url))['workflow_runs']],default=0)
    phase('PAGES_REQUESTED');cmd.run('gh','workflow','run','hs-stable-pages.yml','--ref','main')
    run_id=None
    for attempt in range(12):
        runs=json.loads(cmd.run('gh','api',url))['workflow_runs']
        found=[r for r in runs if r['id']>previous and r['head_sha']==commit and r['head_branch']=='main']
        if found:run_id=max(r['id'] for r in found);break
        if attempt<11:sleep(5)
    require(run_id is not None,'PAGES_RUN_NOT_CREATED_OR_SUPERSEDED')
    phase('PAGES_RUNNING',run_id=run_id);cmd.run('gh','run','watch',str(run_id),'--interval','5','--exit-status')
    if fetch is None:
        def fetch(name):
            suffix='&' if '?' in name else '?'
            with urlopen(BASE_URL+name+suffix+'lc4-verify='+str(time.time_ns()),timeout=25) as response:return response.read()
    for attempt in range(6):
        try:
            runs=json.loads(cmd.run('gh','api',url))['workflow_runs'];result=verify_public(plan,commit,fetch,runs)
            phase('VERIFIED',**result);return state
        except Exception as exc:
            phase('PUBLICATION_PENDING',reason=str(exc),attempt=attempt+1)
            if attempt==5:raise
            sleep(20)

def main():
    p=argparse.ArgumentParser();p.add_argument('command',choices=('plan','package','materialize','execute'));p.add_argument('--staged',type=Path,required=True)
    p.add_argument('--evidence',type=Path,required=True);p.add_argument('--plan',type=Path,required=True);p.add_argument('--state',type=Path)
    p.add_argument('--delta',type=Path)
    args=p.parse_args()
    require(ROOT not in args.plan.resolve().parents,'PLAN_MUST_BE_OUTSIDE_PUBLIC_CHECKOUT')
    if args.command=='plan':
        plan=create_plan(ROOT,args.staged,args.evidence,dt.datetime.now(dt.timezone.utc));d.atomic_json(args.plan,plan)
        print(json.dumps({'status':'DRY_RUN_PLAN_VERIFIED','target':plan['target_date'],'changes':len(plan['changes']),'operation_id':plan['operation_id'],'remote_writes':0}));return
    if args.command in ('package','materialize'):
        require(args.delta is not None,'DELTA_DIRECTORY_REQUIRED')
        print(json.dumps(globals()[args.command](ROOT,args.staged,args.evidence,d.read(args.plan),args.delta,dt.datetime.now(dt.timezone.utc))) if args.command=='package' else
              json.dumps(materialize(ROOT,args.delta,args.staged,args.evidence,d.read(args.plan),dt.datetime.now(dt.timezone.utc))));return
    require(args.state is not None and ROOT not in args.state.resolve().parents,'EXTERNAL_RELEASE_STATE_REQUIRED')
    result=execute(ROOT,args.staged,args.evidence,d.read(args.plan),args.state);print(json.dumps(result))

if __name__=='__main__':main()
