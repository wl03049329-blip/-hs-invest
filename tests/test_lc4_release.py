"""SIMULATED GitHub/Pages contracts. No remote Git, credentials or deployments."""
import copy,datetime as dt,json,pathlib,shutil,subprocess,sys,tempfile,unittest
from types import SimpleNamespace
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from scripts import lc4_research_release as r
from scripts import lc4_research_daily as d
NOW=dt.datetime.fromisoformat('2026-11-05T01:00:00+00:00')
PUBLISHED='a'*40

class ReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.receipts=json.loads((ROOT/'tests/fixtures/lc4-research/official-20261104.json').read_text(encoding='utf8'))['entries']
        name='snapshots/2026-11-04-r000002-efa7430fb94b.json';raw=(ROOT/d.DIR/name).read_bytes();b=json.loads(raw)
        cls.pointer={'schema':'HS_LC4_RESEARCH_POINTER_V1','asof':b['asof'],'revision':b['revision'],'path':name,
            'sha256':d.sha(raw),'bytes':len(raw),'input_sha256':d.digest({'history':b['history'],'envelope_version':1})}
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.base=pathlib.Path(self.tmp.name)
        self.root=self.base/'repo';self.root.mkdir()
        for name in ('seed.json','seed-history.json.gz','seed-sources.json.gz','status.json',
                     'snapshots/2026-11-04-r000001-b37dce6724db.json',self.pointer['path']):
            dest=self.root/d.DIR/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/d.DIR/name,dest)
        d.atomic_json(self.root/d.DIR/'latest.json',self.pointer)
        for name in ('lc4-research.js','lc4-research.css'):shutil.copyfile(ROOT/name,self.root/name)
        (self.root/'index.html').write_text('<!doctype html><button data-lc4-research-open>TEST_ONLY</button>')
        (self.root/'synthetic-financial.json').write_text('{"ledger":"TEST_ONLY_UNCHANGED","cash":7000}')
        def git(*args):return subprocess.run(['git',*args],cwd=self.root,capture_output=True,check=True)
        git('init','-q','--initial-branch=main');git('-c','core.autocrlf=false','add','.')
        git('-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','-qm','synthetic baseline')
        self.stage=self.base/'staged';shutil.copytree(self.root/d.DIR,self.stage/d.DIR)
        self.evidence=self.base/'sources';self.evidence.mkdir()
        self.entries=copy.deepcopy(type(self).receipts);self.write_sources()
        self.plan=self.make_plan()
    def write_sources(self,now=NOW,target='2026-11-04',status='NOOP'):
        for i,e in enumerate(self.entries):
            e['sha256']=d.digest(e['payload']);d.atomic_json(self.evidence/(str(i)+'.json'),e)
        p=d.read(self.stage/d.DIR/'latest.json')
        d.atomic_json(self.stage/d.DIR/'status.json',{'schema':'HS_LC4_RESEARCH_OPERATION_V2','status':status,'checked_at':now.isoformat(),
          'asof':target,'verified_target':target,'bundle_sha256':p['sha256'],'live_source_check':True,'writer':False,
          'source_receipts':[d.ref(e) for e in self.entries]})
    def make_plan(self,now=NOW):return r.create_plan(self.root,self.stage,self.evidence,now)
    def public(self):
        p=self.plan['pointer'];payload={r.PREFIX+'latest.json':(self.stage/d.DIR/'latest.json').read_bytes(),
          r.PREFIX+p['path']:(self.stage/d.DIR/p['path']).read_bytes(),r.PREFIX+'status.json':(self.stage/d.DIR/'status.json').read_bytes()}
        assets=[]
        for name in ('lc4-research.js','lc4-research.css','index.html'):
            raw=(self.root/name).read_bytes();url=name+'?v='+d.sha(raw);payload[url]=raw
            assets.append({'url':url,'sha256':d.sha(raw),'bytes':len(raw)})
        payload['app-release.json']=d.encoded({'schema':'HS_STABLE_APP_RELEASE_V1','deployment_commit':PUBLISHED,
          'financial_writer':False,'storage_contract':'hsPersonalV3.v1','assets':assets})
        return payload
    def runs(self):return [{'id':2,'head_sha':PUBLISHED,'head_branch':'main','status':'completed','conclusion':'success'}]
    def test_plan_offline_zero_source_mutation(self):
        before={p:(self.root/p).read_bytes() for p in ('synthetic-financial.json',d.DIR+'/latest.json',d.DIR+'/status.json')}
        with patch.object(r,'urlopen',side_effect=AssertionError('NO NETWORK')):self.make_plan()
        self.assertEqual(before,{p:(self.root/p).read_bytes() for p in before})
        self.assertEqual([e['path'] for e in self.plan['changes']],[r.PREFIX+'status.json'])
        self.assertFalse(self.plan['writer']);self.assertFalse(self.plan['formal_shadow_authorized'])
    def test_fixed_plan_revalidation_is_idempotent(self):self.assertEqual(r.validate_plan(self.root,self.stage,self.evidence,self.plan,NOW),self.plan)
    def test_pure_seed_or_failed_update_cannot_be_published(self):
        p=self.stage/d.DIR/'status.json';op=d.read(p);op['status']='RESEARCH_UPDATE_BLOCKED';d.atomic_json(p,op)
        with self.assertRaisesRegex(ValueError,'NOT_VERIFIED'):self.make_plan()
        op['status']='NOOP';op['live_source_check']=False;d.atomic_json(p,op)
        with self.assertRaisesRegex(ValueError,'NOT_VERIFIED'):self.make_plan()
    def test_wrong_operation_date_rejected(self):
        p=self.stage/d.DIR/'status.json';op=d.read(p);op['verified_target']='2026-11-05';d.atomic_json(p,op)
        with self.assertRaisesRegex(ValueError,'OPERATION_BUNDLE_MISMATCH'):self.make_plan()
    def test_source_tamper_rejected(self):
        p=self.evidence/'0.json';e=d.read(p);e['sha256']='0'*64;d.atomic_json(p,e)
        with self.assertRaisesRegex(ValueError,'RECEIPT_HASH'):self.make_plan()
    def test_missing_source_never_causes_success(self):
        # Isolated fixture only; no original source is removed.
        p=self.evidence/'4.json';p.unlink()
        with self.assertRaisesRegex(ValueError,'EVIDENCE_MISSING'):self.make_plan()
    def test_official_price_revision_requires_review(self):
        e=next(e for e in self.entries if 'stockNo=00631L' in e['url']);e['payload']['data'][-1][6]='30.84';self.write_sources()
        with self.assertRaisesRegex(ValueError,'OVERLAP_CONFLICT'):self.make_plan()
    def test_observed_market_date_required_even_for_noop(self):
        e=next(e for e in self.entries if 'FMTQIK' in e['url']);e['payload']['data'].pop();self.write_sources()
        with self.assertRaises(ValueError):self.make_plan()
    def test_unknown_split_rejects_release(self):
        e=next(e for e in self.entries if 'stockNo=00631L' in e['url']);e['payload']['data'][-1][9]='**';self.write_sources()
        with self.assertRaisesRegex(ValueError,'UNREVIEWED_SPLIT'):self.make_plan()
    def test_capture_before_completion_cannot_pass_after_close(self):
        now=dt.datetime.fromisoformat('2026-11-04T11:00:00+00:00')
        for e in self.entries:e['fetched_at']='2026-11-04T09:00:00+00:00'
        self.write_sources(now)
        with self.assertRaisesRegex(ValueError,'BEFORE_COMPLETION'):self.make_plan(now)
    def test_future_capture_rejected(self):
        self.entries[0]['fetched_at']='2026-11-05T02:00:00Z';self.write_sources()
        with self.assertRaisesRegex(ValueError,'RECEIPT_DATE'):self.make_plan()
    def test_stale_receipts_rejected(self):
        for e in self.entries:e['fetched_at']='2026-11-04T12:00:00Z'
        self.write_sources()
        with self.assertRaisesRegex(ValueError,'RECEIPT_DATE'):self.make_plan()
    def test_verified_bars_behind_expected_day_rejected(self):
        now=dt.datetime.fromisoformat('2026-11-06T01:00:00+00:00')
        for e in self.entries:e['fetched_at']='2026-11-06T00:00:00Z'
        self.write_sources(now)
        with self.assertRaisesRegex(ValueError,'DATE_BEHIND'):self.make_plan(now)
    def test_uncompleted_next_day_rows_ignored(self):
        before=d.load_history(self.stage)
        for e in self.entries:
            if 'stockNo=' in e['url']:
                row=e['payload']['data'][-1].copy();row[0]='115/11/05';row[6]='99999';e['payload']['data'].append(row);e['payload']['total']+=1
        self.write_sources();self.make_plan();self.assertEqual(d.load_history(self.stage),before)
    def test_existing_immutable_snapshot_cannot_change(self):
        p=self.stage/d.DIR/self.plan['pointer']['path'];p.write_bytes(p.read_bytes()+b' ')
        with self.assertRaises(ValueError):self.make_plan()
    def test_new_nonresearch_file_rejected(self):
        (self.stage/d.DIR/'C4-override.json').write_text('{}')
        with self.assertRaisesRegex(ValueError,'OUT_OF_SCOPE'):self.make_plan()
    def test_seed_revision_not_allowed(self):
        (self.stage/d.DIR/'seed.json').write_text('{}')
        with self.assertRaises((ValueError,KeyError)):self.make_plan()
    def test_materialize_delta_and_replay(self):
        delta=self.base/'delta';r.package(self.root,self.stage,self.evidence,self.plan,delta,NOW)
        dest=self.base/'materialized';result=r.materialize(self.root,delta,dest,self.evidence,self.plan,NOW)
        self.assertEqual(result['remote_writes'],0)
        self.assertEqual(d.load_history(dest),d.load_history(self.stage))
    def test_delta_corruption_rejected(self):
        delta=self.base/'delta';r.package(self.root,self.stage,self.evidence,self.plan,delta,NOW)
        (delta/self.plan['changes'][0]['path']).write_text('{}')
        with self.assertRaisesRegex(ValueError,'DELTA_HASH'):r.materialize(self.root,delta,self.base/'bad',self.evidence,self.plan,NOW)
    def test_delta_extra_file_rejected(self):
        delta=self.base/'delta';r.package(self.root,self.stage,self.evidence,self.plan,delta,NOW);(delta/'extra').write_text('bad')
        with self.assertRaisesRegex(ValueError,'DELTA_FILE_SET'):r.materialize(self.root,delta,self.base/'bad',self.evidence,self.plan,NOW)
    def test_untrusted_plan_cannot_escape_staging(self):
        plan=copy.deepcopy(self.plan);plan['changes'][0]['path']='../../synthetic-financial.json';plan.pop('operation_id');plan['operation_id']=d.digest(plan)
        with self.assertRaisesRegex(ValueError,'PLAN_PATH'):r.materialize(self.root,self.base,self.base/'bad',self.evidence,plan,NOW)
    def test_plan_tamper_rejected(self):
        plan=copy.deepcopy(self.plan);plan['target_date']='2026-11-05'
        with self.assertRaisesRegex(ValueError,'PLAN_HASH'):r.validate_plan(self.root,self.stage,self.evidence,plan,NOW)
    def test_default_and_partial_approval_never_authorize(self):
        for env in ({},{'GITHUB_ACTIONS':'true'},{'GITHUB_ACTIONS':'true','GITHUB_REF':'refs/heads/main'}):
            with self.assertRaisesRegex(ValueError,'NOT_AUTHORIZED'):r.execution_guard(self.root,env)
    def test_public_publication_requires_exact_data_and_run(self):
        payload=self.public();self.assertEqual(r.verify_public(self.plan,PUBLISHED,payload.__getitem__,self.runs())['asof'],'2026-11-04')
        with self.assertRaisesRegex(ValueError,'RUN_NOT_SUCCESSFUL'):r.verify_public(self.plan,PUBLISHED,payload.__getitem__,[])
    def test_public_old_deployment_never_green(self):
        payload=self.public();receipt=json.loads(payload['app-release.json']);receipt['deployment_commit']='0'*40;payload['app-release.json']=d.encoded(receipt)
        with self.assertRaisesRegex(ValueError,'RECEIPT_MISMATCH'):r.verify_public(self.plan,PUBLISHED,payload.__getitem__,self.runs())
    def test_public_old_pointer_never_green(self):
        payload=self.public();p=json.loads(payload[r.PREFIX+'latest.json']);p['asof']='2026-11-03';payload[r.PREFIX+'latest.json']=d.encoded(p)
        with self.assertRaisesRegex(ValueError,'POINTER_MISMATCH'):r.verify_public(self.plan,PUBLISHED,payload.__getitem__,self.runs())
    def test_public_corrupt_body_never_green(self):
        payload=self.public();payload[r.PREFIX+self.plan['pointer']['path']]+=b' '
        with self.assertRaisesRegex(ValueError,'BUNDLE_MISMATCH'):r.verify_public(self.plan,PUBLISHED,payload.__getitem__,self.runs())
    def test_public_stale_status_never_green(self):
        payload=self.public();payload[r.PREFIX+'status.json']=b'{}'
        with self.assertRaisesRegex(ValueError,'STATUS_MISMATCH'):r.verify_public(self.plan,PUBLISHED,payload.__getitem__,self.runs())
    def test_public_mixed_code_never_green(self):
        payload=self.public();name='lc4-research.js?v='+self.plan['code_assets']['lc4-research.js'];payload[name]+=b' '
        with self.assertRaisesRegex(ValueError,'CODE_BYTES'):r.verify_public(self.plan,PUBLISHED,payload.__getitem__,self.runs())
    def test_read_only_historical_rollback_is_not_current(self):
        before=(self.root/d.DIR/'latest.json').read_bytes();p,b,n=r.audit_chain(self.root)
        review=r.rollback_review(self.root,b['previous_bundle_sha256'])
        self.assertFalse(review['automatic_promotion']);self.assertFalse(review['writer']);self.assertFalse(review['entry_authorized'])
        self.assertEqual(review['display'],'VERIFIED_HISTORICAL_REVIEW_ONLY');self.assertEqual(before,(self.root/d.DIR/'latest.json').read_bytes())
    def approved_env(self):return {'GITHUB_ACTIONS':'true','GITHUB_REPOSITORY':r.REPO,'GITHUB_REF':'refs/heads/main',
        'GITHUB_EVENT_NAME':'workflow_dispatch','HS_LC4_RESEARCH_ENABLED':'true','HS_LC4_RESEARCH_PUBLISH_ENABLED':'true','HS_LC4_RELEASE_APPROVED':'true'}
    def recorder(self,fail=None,advanced=False):
        test=self
        class SimulatedCommands:
            def __init__(self):self.calls=[];self.dispatched=False
            def read_index(self,name):return (test.root/name).read_bytes()+(b' ' if fail=='index' else b'')
            def run(self,*args):
                self.calls.append(list(args))
                if args[:2]==('git','push') and fail=='push':raise OSError('TEST_ONLY_LOST_PUSH_REPLY')
                if args[:3]==('gh','workflow','run'):
                    self.dispatched=True
                    if fail=='dispatch':raise OSError('TEST_ONLY_DISPATCH_FAILURE')
                    return ''
                if args[:3]==('gh','run','watch'):
                    if fail=='pages':raise OSError('TEST_ONLY_PAGES_FAILURE')
                    return ''
                if args[:2]==('gh','api'):
                    if '/git/ref/' in args[2]:return json.dumps({'object':{'sha':'b'*40 if advanced else test.plan['source_commit']}})
                    return json.dumps({'workflow_runs':test.runs() if self.dispatched else []})
                if args[:2]==('git','diff'):return '\n'.join(e['path'] for e in test.plan['changes'])
                if args[:2]==('git','rev-parse'):return PUBLISHED
                return ''
        return SimulatedCommands()
    def execute_simulated(self,cmd,payload=None):
        class Clock(dt.datetime):
            @classmethod
            def now(cls,tz=None):return NOW if tz else NOW.replace(tzinfo=None)
        with patch.object(r.dt,'datetime',Clock):
            return r.execute(self.root,self.stage,self.evidence,self.plan,self.base/'state.json',env=self.approved_env(),
                commands=cmd,fetch=(payload or self.public()).__getitem__,sleep=lambda _:None)
    def test_simulated_full_publication_protocol_and_financial_boundary(self):
        before=(self.root/'synthetic-financial.json').read_bytes();cmd=self.recorder();state=self.execute_simulated(cmd)
        self.assertEqual(state['phase'],'VERIFIED');self.assertEqual(state['status'],'PUBLIC_RESEARCH_VERIFIED')
        self.assertEqual(before,(self.root/'synthetic-financial.json').read_bytes())
        self.assertEqual(sum(c[:2]==['git','push'] for c in cmd.calls),1)
        self.assertIn(['gh','workflow','run','hs-stable-pages.yml','--ref','main'],cmd.calls)
        self.assertFalse(any('--force' in c or '--rebase' in c for c in cmd.calls))
    def test_remote_main_advanced_stops_before_any_staging_or_push(self):
        before=(self.root/d.DIR/'status.json').read_bytes();cmd=self.recorder(advanced=True)
        with self.assertRaisesRegex(ValueError,'MAIN_ADVANCED'):self.execute_simulated(cmd)
        self.assertEqual(before,(self.root/d.DIR/'status.json').read_bytes());self.assertFalse(any(c[0]=='git' for c in cmd.calls))
    def test_git_index_bytes_must_match_before_commit_or_push(self):
        cmd=self.recorder(fail='index')
        with self.assertRaisesRegex(ValueError,'STAGED_BYTE_PIN_MISMATCH'):self.execute_simulated(cmd)
        self.assertFalse(any(c[:2]==['git','push'] or 'commit' in c for c in cmd.calls))
    def test_lost_push_reply_not_blindly_retried(self):
        cmd=self.recorder(fail='push')
        with self.assertRaises(OSError):self.execute_simulated(cmd)
        self.assertEqual(d.read(self.base/'state.json')['phase'],'PUSH_REQUESTED')
        self.assertEqual(sum(c[:2]==['git','push'] for c in cmd.calls),1)
        self.assertFalse(any(c[:3]==['gh','workflow','run'] for c in cmd.calls))
    def test_dispatch_failure_is_not_a_release(self):
        cmd=self.recorder(fail='dispatch')
        with self.assertRaises(OSError):self.execute_simulated(cmd)
        self.assertEqual(d.read(self.base/'state.json')['phase'],'PAGES_REQUESTED')
    def test_pages_failure_is_not_a_release(self):
        cmd=self.recorder(fail='pages')
        with self.assertRaises(OSError):self.execute_simulated(cmd)
        self.assertEqual(d.read(self.base/'state.json')['phase'],'PAGES_RUNNING')
    def test_cdn_stale_never_becomes_green_after_bounded_checks(self):
        payload=self.public();payload[r.PREFIX+'status.json']=b'{}';cmd=self.recorder()
        with self.assertRaisesRegex(ValueError,'STATUS_MISMATCH'):self.execute_simulated(cmd,payload)
        state=d.read(self.base/'state.json');self.assertEqual(state['phase'],'PUBLICATION_PENDING');self.assertEqual(state['attempt'],6)
    def test_workflow_default_is_dry_run_and_schedule_is_gated(self):
        code=(ROOT/'.github/workflows/lc4-research-daily.yml').read_text(encoding='utf8')
        self.assertIn('default: dry-run',code);self.assertIn("vars.HS_LC4_RESEARCH_ENABLED == 'true'",code)
        self.assertIn("vars.HS_LC4_RESEARCH_PUBLISH_ENABLED == 'true'",code);self.assertIn("vars.HS_LC4_RELEASE_APPROVED == 'true'",code)
        self.assertIn('environment: hs-lc4-research-publish',code);self.assertIn('cancel-in-progress: false',code)
        self.assertNotIn('continue-on-error',code);self.assertIn('test "$GENERATE" = success && test "$PLAN" = success',code)
        self.assertIn('lc4_research_release.py materialize',code);self.assertIn('lc4_research_release.py execute',code)
        self.assertIn('retention-days: 7',code)
    def test_workflow_has_no_financial_or_shadow_dispatch(self):
        code=(ROOT/'.github/workflows/lc4-research-daily.yml').read_text(encoding='utf8')
        for forbidden in ['phase_l7_daily.py','workflow run Packaging','workflow run Recovery','Financial Writer','git reset','git clean']:
            self.assertNotIn(forbidden,code)
    def next_day_fixture(self):
        # Deliberately SYNTHETIC continuation in an isolated temporary fixture.
        # Never used as a real2026-11-05 observation or published source.
        now=dt.datetime.fromisoformat('2026-11-05T11:00:00+00:00')
        for e in self.entries:
            e['fetched_at']='2026-11-05T10:15:00Z'
            if 'STOCK_DAY?' in e['url'] or 'FMTQIK?' in e['url']:
                row=e['payload']['data'][-1].copy();row[0]='115/11/05';e['payload']['data'].append(row)
                if 'total' in e['payload']:e['payload']['total']+=1
            elif 'TWT49U?' in e['url']:
                e['url']=e['url'].replace('endDate=20261104','endDate=20261105');e['payload']['endDate']='20261105'
        self.write_sources(now)
        client=r.RecordedSources(self.evidence,now)
        history=d.extend(d.load_history(self.stage),client,'2026-11-05');d.validate_source_timing(client,'2026-11-05',now)
        return now,client,history
    def test_complete_new_daily_version_end_to_end_without_overwrite(self):
        before={p.name:p.read_bytes() for p in (self.stage/d.DIR/'snapshots').glob('*.json')}
        now,client,history=self.next_day_fixture()
        result=d.publish(self.stage,history,client,now,d.ref(client.get(d.HOLIDAY_URL)))
        self.assertEqual(result['status'],'VERIFIED_RESEARCH_UPDATED')
        self.write_sources(now,'2026-11-05','VERIFIED_RESEARCH_UPDATED');self.plan=self.make_plan(now)
        self.assertEqual(self.plan['pointer']['revision'],3);self.assertEqual(len(self.plan['changes']),3)
        for name,raw in before.items():self.assertEqual(raw,(self.stage/d.DIR/'snapshots'/name).read_bytes())
        delta=self.base/'delta';r.package(self.root,self.stage,self.evidence,self.plan,delta,now)
        dest=self.base/'reconstructed';r.materialize(self.root,delta,dest,self.evidence,self.plan,now)
        self.assertEqual(d.load_history(dest)['asof'],'2026-11-05')
        self.assertEqual(r.verify_public(self.plan,PUBLISHED,self.public().__getitem__,self.runs())['asof'],'2026-11-05')
        self.assertFalse(r.rollback_review(dest,self.plan['previous_pointer']['sha256'])['automatic_promotion'])
        self.assertEqual(d.read(dest/d.DIR/'latest.json')['asof'],'2026-11-05')
    def test_interruption_after_new_snapshot_before_pointer_is_not_publishable(self):
        before=(self.stage/d.DIR/'latest.json').read_bytes();now,client,history=self.next_day_fixture()
        with patch.object(d,'atomic_json',side_effect=OSError('TEST_ONLY_POINTER_INTERRUPTED')):
            with self.assertRaises(OSError):d.publish(self.stage,history,client,now,{})
        self.assertEqual(before,(self.stage/d.DIR/'latest.json').read_bytes())
        with self.assertRaisesRegex(ValueError,'DATE_BEHIND'):self.make_plan(now)
    def test_interruption_after_pointer_before_operation_is_not_publishable(self):
        now,client,history=self.next_day_fixture();d.publish(self.stage,history,client,now,{})
        with self.assertRaisesRegex(ValueError,'OPERATION_BUNDLE_MISMATCH'):self.make_plan(now)
    def test_receipts_after_collection_start_use_validation_clock_not_start(self):
        source=r.RecordedSources(self.evidence,NOW)
        times=iter([dt.datetime.fromisoformat('2026-11-05T00:10:00Z'),NOW])
        class Clock(dt.datetime):
            @classmethod
            def now(cls,tz=None):return next(times)
        args=SimpleNamespace(evidence=self.evidence,output_root=self.stage,seed_only=False)
        with patch.object(d.dt,'datetime',Clock),patch.object(d,'Client',return_value=source),patch('builtins.print'):
            self.assertEqual(d.update(args),0)
        op=d.read(self.stage/d.DIR/'status.json');self.assertEqual(op['checked_at'],NOW.isoformat())
        self.assertTrue(all(r.stamp(e['fetched_at'])<=r.stamp(op['checked_at']) for e in source.entries.values()))
        self.make_plan()
    def test_collection_crossing_completion_boundary_stays_blocked(self):
        source=r.RecordedSources(self.evidence,NOW)
        times=iter([dt.datetime.fromisoformat('2026-11-05T09:59:00Z'),
            dt.datetime.fromisoformat('2026-11-05T10:01:00Z'),dt.datetime.fromisoformat('2026-11-05T10:01:00Z')])
        class Clock(dt.datetime):
            @classmethod
            def now(cls,tz=None):return next(times)
        before=(self.stage/d.DIR/'latest.json').read_bytes()
        with patch.object(d.dt,'datetime',Clock),patch.object(d,'Client',return_value=source):
            with self.assertRaisesRegex(ValueError,'TARGET_CHANGED_DURING_COLLECTION'):
                d.update(SimpleNamespace(evidence=self.evidence,output_root=self.stage,seed_only=False))
        self.assertEqual(before,(self.stage/d.DIR/'latest.json').read_bytes())
        self.assertEqual(d.read(self.stage/d.DIR/'status.json')['status'],'RESEARCH_UPDATE_BLOCKED')
    def test_weekend_publication_uses_last_complete_friday_not_weekend_bar(self):
        # SYNTHETIC future scenario only, never real Nov6/Nov7 source evidence.
        now=dt.datetime.fromisoformat('2026-11-07T11:00:00Z')
        for e in self.entries:
            e['fetched_at']='2026-11-07T10:15:00Z'
            if 'STOCK_DAY?' in e['url'] or 'FMTQIK?' in e['url']:
                for date in ('115/11/05','115/11/06'):
                    row=e['payload']['data'][-1].copy();row[0]=date;e['payload']['data'].append(row)
                    if 'total' in e['payload']:e['payload']['total']+=1
            elif 'TWT49U?' in e['url']:
                e['url']=e['url'].replace('endDate=20261104','endDate=20261106');e['payload']['endDate']='20261106'
        self.write_sources(now);client=r.RecordedSources(self.evidence,now)
        self.assertEqual(d.research_expected_day(client,now)[0],'2026-11-06')
        history=d.extend(d.load_history(self.stage),client,'2026-11-06');d.validate_source_timing(client,'2026-11-06',now)
        d.publish(self.stage,history,client,now,{})
        self.write_sources(now,'2026-11-06','VERIFIED_RESEARCH_UPDATED');plan=self.make_plan(now)
        self.assertEqual(plan['target_date'],'2026-11-06');self.assertFalse(plan['writer'])

if __name__=='__main__':unittest.main()
