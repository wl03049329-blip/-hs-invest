"""TEST_ONLY historical-date integration. No live sources, grants or writes."""
import copy
import json
import unittest
from datetime import date, timedelta
from unittest.mock import patch

import phase_l7_daily as daily
import phase_l7_exact_recovery as exact
import phase_l7_packaging as packaging
import phase_l7_recovery_adapter as adapter
import phase_l7_recovery_evidence as fresh
import phase_l7_shadow as shadow
import test_phase_l7_exact_recovery as fixtures
from test_phase_l7_daily import at, yahoo_for
import test_phase_l7_packaging as packaging_tests
import test_phase_l7_recovery_adapter as adapter_tests


class HistoricalScopeTests(unittest.TestCase):
    setUp=packaging_tests.PackagingTests.setUp
    unchanged=fixtures.ExactRecoveryTests.unchanged
    dependencies=adapter_tests.AdapterTests.dependencies

    def prepare_day(self,day,time='18:00:00',holidays=()):
        self.now=at(day,time);self.wall=self.now
        self.source.rows=[r for r in self.source.rows if r['date'] <= exact.TARGET]
        cursor=date(2026,10,17)
        while cursor.isoformat() <= day:
            if cursor.weekday() < 5 and cursor.isoformat() not in holidays:
                self.source.rows.append({**copy.deepcopy(self.source.rows[-1]),'date':cursor.isoformat()})
            cursor+=timedelta(days=1)
        self.source.yahoo=yahoo_for(self.source.rows)
        index=next(i for i,r in enumerate(self.source.rows) if r['date']==exact.TARGET)
        self.source.yahoo['chart']['result'][0]['indicators']['quote'][0]['close'][index]=None
        self.source.yahoo['chart']['result'][0]['indicators']['adjclose'][0]['adjclose'][index]=None
        self.source.official['202610']['data']=[[r['date'],'100','40','41','39','40']
            for r in self.source.rows if r['date'].startswith('2026-10')]
        original=self.source.fetch
        if hasattr(self,'base_fetch'):original=self.base_fetch
        else:self.base_fetch=original
        def fetch(url):
            payload=original(url)
            if url==daily.CALENDAR_URL:
                payload += [{'Date':d.replace('-',''),'Name':'休市','Description':''} for d in holidays]
            return payload
        self.source.fetch=fetch

    def refresh(self,mutate=None):
        self.requests=[]
        def request(url):
            self.requests.append(url)
            payload=self.source.fetch(url)
            if mutate:payload=mutate(url,payload)
            return 200,json.dumps(payload).encode()
        return fresh.refresh(self.root,self.now,request=request,clock=lambda:self.wall)

    def valid(self):
        result=self.refresh()
        self.assertEqual(result['status'],'FRESH_VALIDATED_UNSIGNED',result.get('errors'))
        self.assertIsNone(result['draft']['authorization_id']);self.assertEqual(result['draft']['approvals'],[])
        return result

    def test_real_dates_before_after_close_and_later_days_never_extend_target(self):
        for day,time,latest in [('2026-10-18','03:00:00','2026-10-16'),
                ('2026-10-19','09:00:00','2026-10-16'),('2026-10-19','16:29:59','2026-10-16'),
                ('2026-10-19','16:30:00','2026-10-19'),('2026-10-20','18:00:00','2026-10-20'),
                ('2026-10-30','18:00:00','2026-10-30')]:
            with self.subTest(day=day,time=time):
                self.prepare_day(day,time);r=self.valid()
                body,data,*_=exact.context(self.root,r['evidence'],self.wall)
                self.assertEqual(body['actual_latest_completed_session'],latest)
                self.assertEqual(body['recovery_target'],exact.TARGET)
                self.assertEqual(body['anchor_date'],exact.ANCHOR)
                self.assertEqual(body['contract_revision'],2)
                self.assertEqual(body['historical_scope_implementation_sha256'],shadow.sha(exact.Path(exact.scope.__file__)))
                self.assertEqual(data['item']['rows'][-1]['date'],exact.TARGET)
                prior=shadow.read_json(self.root/daily.SNAPSHOT)['item']['rows']
                self.assertEqual(data['item']['rows'][:len(prior)],prior)
                self.assertTrue(all(d['date'] <= exact.TARGET for d in data['item']['rows']))
                self.assertEqual(data['metadata']['official_factor_one_bridge']['target_date'],exact.TARGET)
                self.assertEqual(body['constraints']['max_bridge_sessions'],10)
                expected=18 if latest==exact.TARGET else 22
                self.assertEqual(len(packaging.decode_evidence(packaging.encode_evidence(r['evidence']))['receipts']),expected)
                proof=body['post_target_validation']
                self.assertEqual(proof['status'],'NOT_REQUIRED' if latest==exact.TARGET else 'PASS')
                self.assertEqual(proof['publication'],'NOT_AUTHORIZED')
        self.unchanged()

    def test_weekend_and_official_holiday_are_not_missing_sessions(self):
        for day,holidays,latest in [('2026-10-19',('2026-10-19',),'2026-10-16'),
                                  ('2026-10-20',('2026-10-19',),'2026-10-20'),
                                  ('2026-10-24',(),'2026-10-23')]:
            self.prepare_day(day,holidays=holidays);r=self.valid()
            self.assertEqual(r['draft']['contract']['actual_latest_completed_session'],latest)
            self.assertTrue(all(s['date'] not in holidays for s in r['draft']['contract']['post_target_validation']['sessions']))
        self.unchanged()

    def test_close_boundary_requires_new_evidence_not_automatic_contract_change(self):
        self.prepare_day('2026-10-19','16:29:00');r=self.valid()
        self.wall=at('2026-10-19','16:31:00')
        with self.assertRaisesRegex(daily.Error,'EXACT_LATEST_SESSION_CHANGED_RECAPTURE'):
            exact.context(self.root,r['evidence'],self.wall)
        self.unchanged()

    def test_post_primary_gap_factor_or_ohlc_conflict_is_blocked(self):
        self.prepare_day('2026-10-20')
        original=copy.deepcopy(self.source.yahoo)
        for kind in ('missing','factor','price','nan'):
            self.source.yahoo=copy.deepcopy(original)
            result=self.source.yahoo['chart']['result'][0];q=result['indicators']['quote'][0]
            i=next(i for i,t in enumerate(result['timestamp']) if daily.datetime.fromtimestamp(t,daily.TAIPEI).date().isoformat()=='2026-10-19')
            if kind=='missing':q['close'][i]=None
            elif kind=='factor':result['indicators']['adjclose'][0]['adjclose'][i]=41
            elif kind=='price':q['high'][i]=42
            else:q['volume'][i]=float('nan')
            with self.subTest(kind=kind):
                r=self.refresh();self.assertEqual(r['status'],'EVIDENCE_INCOMPLETE');self.assertIsNone(r['draft'])
                expected={'missing':'EXACT_POST_PRIMARY_INCOMPLETE','factor':'EXACT_POST_FACTOR_CONFLICT',
                          'price':'EXACT_POST_OHLC_CONFLICT','nan':'EXACT_POST_PRIMARY_INCOMPLETE'}[kind]
                self.assertTrue(any(expected in e.get('reason','') for e in r['errors']))
        self.unchanged()

    def test_post_official_missing_and_historical_revision_are_blocked(self):
        self.prepare_day('2026-10-20')
        original=copy.deepcopy(self.source.official['202610'])
        self.source.official['202610']['data']=[r for r in original['data'] if r[0]!='2026-10-19']
        r=self.refresh();self.assertEqual(r['status'],'EVIDENCE_INCOMPLETE');self.assertIsNone(r['draft'])
        self.assertTrue(any('EXACT_POST_OFFICIAL_SESSION_MISSING' in e.get('reason','') for e in r['errors']))
        self.source.official['202610']=original
        result=self.source.yahoo['chart']['result'][0]
        i=next(i for i,t in enumerate(result['timestamp']) if daily.datetime.fromtimestamp(t,daily.TAIPEI).date().isoformat()==exact.ANCHOR)
        result['indicators']['quote'][0]['close'][i]=40.5
        r=self.refresh();self.assertEqual(r['status'],'EVIDENCE_INCOMPLETE');self.assertIsNone(r['draft'])
        self.assertTrue(any('BRIDGE_PRIMARY_CONFLICT' in e.get('reason','') for e in r['errors']))
        self.unchanged()

    def test_post_raw_sha_and_named_source_url_cannot_be_substituted(self):
        self.prepare_day('2026-10-19');r=self.valid()
        for field,value,reason in [('sha256','0'*64,'EXACT_EVIDENCE_SHA_OR_HTTP_MISMATCH'),
                ('source_url','https://invalid.example/not-evidence','EXACT_POST_RECEIPT_SOURCE_MISMATCH')]:
            evidence=copy.deepcopy(r['evidence'])
            next(e for e in evidence['receipts'] if e['name'].startswith('post-'))[field]=value
            with self.subTest(field=field),self.assertRaisesRegex(daily.Error,reason):
                exact.context(self.root,evidence,self.wall)
        self.unchanged()

    def test_all_market_par_value_events_check_stock_id_not_just_nonempty(self):
        self.prepare_day('2026-10-19')
        def mutate(url,payload):
            if 'dataset=TaiwanStockParValueChange' in url and 'end_date=2026-10-19' in url:
                self.assertNotIn('data_id=',url)
                return {'status':200,'msg':'success','data':[{'stock_id':'TEST_OTHER_STOCK','date':'2026-10-19'}]}
            return payload
        r=self.refresh(mutate)
        self.assertEqual(r['status'],'FRESH_VALIDATED_UNSIGNED',r.get('errors'))
        self.unchanged()

    def test_normal_daily_still_uses_real_latest_not_historical_target(self):
        self.prepare_day('2026-10-20');r=self.valid()
        cache={e['source_url']:json.loads(e['raw']) for e in r['evidence']['receipts']}
        def read(url):return copy.deepcopy(cache[url])
        normal,_=daily.collect(self.source.historical,self.source.prior,self.policy,self.now,
            fetcher=read,root=self.root,allow_official_bridge=True,bridge_review_required=True)
        _,historical,*_=exact.context(self.root,r['evidence'],self.wall)
        self.assertEqual(normal['metadata']['expected_completed_bar'],'2026-10-20')
        self.assertEqual(normal['item']['rows'][-1]['date'],'2026-10-20')
        self.assertEqual(historical['item']['rows'][-1]['date'],exact.TARGET)
        self.assertEqual(len(daily.pending_integrity_reviews(self.root,shadow.read_jsonl(
            self.root/self.policy['paths']['forward_ledger']))),7)
        self.unchanged()

    def test_packaging_and_real_planner_keep_post_evidence_but_only_historical_prices(self):
        self.prepare_day('2026-10-20');r=self.valid()
        # Reuse only the explicit synthetic Owner/pins unit fixture constructor.
        # No environment registry, real principal or real approval is installed.
        self.evidence18=lambda:r
        raw,comment,trust,envelope=packaging_tests.PackagingTests.inputs(self)
        output,receipt=packaging.package(self.root,raw,comment,trust,self.now)
        restored=self.output/'TEST_ONLY-post-bundle.json';restored.write_bytes(output)
        from phase_l7_recovery_workflow import load_bundle
        _,actual,decoded=load_bundle(restored)
        plan=exact.production_plan(self.root,actual,decoded,self.wall,trust['pins'])
        self.assertEqual(len(decoded['receipts']),22)
        self.assertEqual(actual['contract']['actual_latest_completed_session'],'2026-10-20')
        self.assertEqual(actual['contract']['recovery_target'],exact.TARGET)
        self.assertEqual(plan['candidate']['item']['rows'][-1]['date'],exact.TARGET)
        self.assertEqual(receipt['candidate_sha256'],daily.digest(plan['candidate']))
        self.assertEqual(actual,envelope)
        self.assertNotIn('pins',json.loads(output));self.assertNotIn('registry',json.loads(output))
        self.unchanged()

    def test_each_post_action_missing_or_event_is_blocked(self):
        self.prepare_day('2026-10-19')
        for dataset in exact.bridge.ACTION_DATASETS:
            for missing in (True,False):
                def mutate(url,payload):
                    if 'dataset='+dataset in url and 'end_date=2026-10-19' in url:
                        return {'status':402,'msg':'restricted','data':None} if missing else {
                            'status':200,'msg':'success','data':[{'date':'2026-10-19','stock_id':'00631L'}]}
                    return payload
                with self.subTest(dataset=dataset,missing=missing):
                    r=self.refresh(mutate);self.assertEqual(r['status'],'EVIDENCE_INCOMPLETE');self.assertIsNone(r['draft'])
                    self.assertEqual(sum('dataset='+dataset in u and 'end_date=2026-10-19' in u for u in self.requests),1)
        self.unchanged()

    def test_unknown_or_p0_new_incident_does_not_join_seven(self):
        self.prepare_day('2026-10-19');r=self.valid()
        path=self.root/daily.INCIDENTS;before=path.read_bytes()
        for reason,requires_review in ((exact.REASON,True),('PROTECTED_ARTIFACT_HASH_MISMATCH:TEST_ONLY',True),
                                      ('PROTECTED_ARTIFACT_HASH_MISMATCH:TEST_ONLY',False)):
            shadow.append_record(path,{'record_id':'TEST_ONLY:new-incident','reason':reason,
                'requires_integrity_review':requires_review,'latest_data_date':exact.ANCHOR,'expected_completed_bar':'2026-10-19'})
            with self.assertRaises(daily.Error):exact.context(self.root,r['evidence'],self.wall)
            path.write_bytes(before)  # Restore ONLY the temporary unit fixture.
        self.unchanged()

    def test_new_contract_rejects_old_revision_target_latest_hash_and_pins(self):
        self.prepare_day('2026-10-20');r=self.valid()
        envelope=fixtures.fixture_approvals(r['draft'],self.now)
        for field,value in [('contract_revision',1),('recovery_target','2026-10-19'),
                            ('actual_latest_completed_session','2026-10-16'),('historical_scope_implementation_sha256','0'*64)]:
            bad=copy.deepcopy(envelope);bad['contract'][field]=value
            with self.subTest(field=field),self.assertRaisesRegex(daily.Error,'EXACT_CONTRACT_ACTUAL_DATA_MISMATCH'):
                exact._plan(self.root,bad,r['evidence'],self.now,fixtures.pins(bad),True)
        for n in range(7):
            bad=copy.deepcopy(envelope);bad['approvals'].pop(n)
            with self.assertRaises(daily.Error):exact._plan(self.root,bad,r['evidence'],self.now,fixtures.pins(bad),True)
        bad_pins=fixtures.pins(envelope);bad_pins['individual'][envelope['approvals'][0]['approval_id']]='0'*64
        with self.assertRaises(daily.Error):exact._plan(self.root,envelope,r['evidence'],self.now,bad_pins,True)
        for when in (self.now+timedelta(hours=6,seconds=1),self.now.replace(hour=23,minute=59)+timedelta(minutes=2)):
            with self.assertRaises(daily.Error):exact.context(self.root,r['evidence'],when)
        self.unchanged()

    def test_six_stage_rerun_is_read_only_and_published_snapshot_remains_stale(self):
        self.prepare_day('2026-10-20');r=self.valid();self.dependencies()
        envelope=fixtures.fixture_approvals(r['draft'],self.now)
        c=adapter.RecoveryAdapter(self.root,self.output/'TEST_ONLY-generation',envelope,r['evidence'],mode='TEST_ONLY',
            trusted_pins=fixtures.pins(envelope),approver_registry={'environment':'TEST_ONLY',
            'authorization_id':envelope['authorization_id'],'approved_contract_sha256':daily.digest(envelope['contract']),
            'approved_principals':['TEST_ONLY:unit-test-not-owner']})
        c.prepare(self.now);c.validate(self.now);c.approve(self.now)
        self.assertEqual(c.commit(self.now),'COMMITTED_GENERATION')
        pointer,files=c.read_committed()
        self.assertEqual(c.commit(self.now),'NOOP_ALREADY_COMMITTED')
        def publish(pointer,files):return {'environment':'TEST_ONLY','git_commit':'TEST_ONLY:local-history', 'generation':pointer['generation']}
        publish.environment='TEST_ONLY';publish.destination='TEST_ONLY:historical-test'
        def verify(receipt,paths):return {'environment':'TEST_ONLY','pages_conclusion':'success',
            'active_release_sha':receipt['git_commit'],'pages_deployment_sha':receipt['git_commit'],'repo_files':files,'public_files':files}
        verify.environment='TEST_ONLY';verify.destination=publish.destination
        c.publish(publish,self.now);c.verify(verify,self.now);output=c.read_verified(self.now)
        self.assertEqual(set(c.stages.values()),{'PASS'})
        front=json.loads(output['00631l-leverage-status-v1.json'])
        self.assertEqual(front['price']['latest_completed_bar'],exact.TARGET)
        self.assertEqual(front['price']['expected_completed_bar'],'2026-10-20')
        self.assertEqual(front['price']['freshness'],'STALE')
        self.assertEqual(output[daily.INCIDENTS],(self.root/daily.INCIDENTS).read_bytes())
        before=shadow.read_jsonl(self.root/self.policy['paths']['forward_ledger'])
        after=[json.loads(line) for line in output[self.policy['paths']['forward_ledger']].splitlines()]
        self.assertEqual(after[:len(before)],before);self.assertEqual(len(after),len(before)+7)
        self.assertEqual(sum(x['record_type']=='SIGNAL_EVALUATION' for x in before),sum(x['record_type']=='SIGNAL_EVALUATION' for x in after))
        status=json.loads(output[daily.STATUS]);self.assertEqual(status['capital_allocation_pct'],0)
        self.assertFalse(status['production_signal']);self.assertFalse(status['live_capital'])
        self.assertEqual(status['eligible_observations'],0)
        self.unchanged()

    def test_cross_year_calendar_is_explicitly_blocked(self):
        now=at('2027-01-04','18:00:00')
        with self.assertRaisesRegex(daily.Error,'EXACT_CROSS_YEAR_REVIEW_REQUIRED'):
            exact.scope.actual_session(now,now,self.source.fetch(daily.CALENDAR_URL),exact.ANCHOR,exact.TARGET)
        self.unchanged()


if __name__=='__main__':unittest.main()
