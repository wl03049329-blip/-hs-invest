"""TEST_ONLY isolated approval fixtures, never actual owner approval."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import phase_l7_daily as daily
import phase_l7_bridge as bridge
import phase_l7_exact_recovery as exact
import phase_l7_shadow as shadow
import test_phase_l7_sources as fixtures
from test_phase_l7_daily import at, data_for, yahoo_for


def fixture_approvals(draft, now):
    envelope = copy.deepcopy(draft)
    envelope.update(environment="TEST_ONLY", authorization_id="TEST_ONLY:exact-fixture",
                    status="TEST_ONLY_APPROVED")
    envelope["approvals"] = [{"incident_id": i["incident_id"], "approval_id": "TEST_ONLY:" + str(n),
        "authorization_id": envelope["authorization_id"], "contract_sha256": daily.digest(envelope["contract"]),
        "item_sha256": daily.digest(i), "recovery_target": exact.TARGET, "test_only": True,
        "approved_by": "TEST_ONLY:unit-test-not-owner", "approved_at": now.isoformat()}
        for n, i in enumerate(envelope["contract"]["items"])]
    return envelope


def pins(envelope):
    return {"authorization_id": envelope["authorization_id"], "envelope_sha256": daily.digest(envelope),
            "individual": {a["approval_id"]: daily.digest(a) for a in envelope["approvals"]}}


class ExactRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.source = fixtures.SourceTests()
        self.source.setUpClass(); self.source.setUp()
        self.addCleanup(self.source.doCleanups)
        self.source.rows += [{**copy.deepcopy(self.source.rows[-1]), "date": d} for d in
                             ("2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07",
                              "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13")]
        self.source.prior = data_for(self.source.rows, at("2026-10-13"))
        self.source.prior["item"]["rows"][-1]["source_provenance"] = {
            "integrity_status": "PASS", "trading_date": exact.ANCHOR, "adjustment_factor": 1,
            "effective_source": "YAHOO"}
        self.source.publish_verified_previous()
        self.root = self.source.root; self.policy = self.source.policy
        self.source.rows += [{**copy.deepcopy(self.source.rows[-1]), "date": d} for d in
                             ("2026-10-14", "2026-10-15", "2026-10-16")]
        self.source.yahoo = yahoo_for(self.source.rows); self.source.null_latest()
        self.source.official["202610"] = {"stat": "OK", "date": "20261001", "title": "00631L 各日成交資訊",
            "fields": ["日期", "成交股數", "開盤價", "最高價", "最低價", "收盤價"],
            "data": [[r["date"], "100", "40", "41", "39", "40"] for r in self.source.rows if r["date"]>="2026-10-01"]}
        for n in range(7):
            shadow.append_record(self.root / daily.INCIDENTS, {"record_type": "DAILY_VALIDATION_FAILURE",
                "record_id": "TEST_ONLY:incident:" + str(n), "reason": exact.REASON,
                "requires_integrity_review": True, "latest_data_date": exact.ANCHOR,
                "expected_completed_bar": (exact.ANCHOR if n==0 else "2026-10-14" if n<3
                                           else "2026-10-15" if n<5 else exact.TARGET),
                "checked_at": at("2026-10-17", "00:00:00").isoformat()})
        self.now = at("2026-10-17", "01:00:00")
        self.load_patch = patch.object(shadow, "load_context", return_value=(self.policy, self.source.historical))
        self.load_patch.start(); self.addCleanup(self.load_patch.stop)
        entries=[]
        def fetch(url):
            raw=json.dumps(self.source.fetch(url)).encode()
            if not any(e["source_url"]==url for e in entries):
                name="yahoo-1" if "yahoo" in url else "source:"+str(len(entries))
                entries.append({"name":name,"source_url":url,"retrieved_at":self.now.isoformat(),
                    "coverage":{"start":exact.ANCHOR,"end":exact.TARGET},"sha256":exact.sha(raw),
                    "raw":raw,"http_status":200})
            return json.loads(raw)
        daily.collect(self.source.historical,self.source.prior,self.policy,self.now,fetcher=fetch,
                      root=self.root,allow_official_bridge=True,bridge_review_required=True)
        self.evidence={"captured_at":self.now.isoformat(),"selected_yahoo_payload":"yahoo-1","receipts":entries}
        self.draft=exact.draft(self.root,self.evidence,self.now)
        self.envelope=fixture_approvals(self.draft,self.now)
        out=tempfile.TemporaryDirectory();self.addCleanup(out.cleanup);self.output=Path(out.name)
        self.before={p:(self.root/p).read_bytes() if (self.root/p).exists() else None for p in exact.formal_paths(self.policy)}

    def simulate(self, envelope=None, evidence=None, now=None, interrupt=None):
        env=envelope or self.envelope
        return exact.simulate(self.root,env,evidence or self.evidence,now or self.now,pins(env),self.output,interrupt)

    def unchanged(self):
        self.assertEqual(self.before,{p:(self.root/p).read_bytes() if (self.root/p).exists() else None for p in self.before})

    def test_all_seven_positive_atomic_generation_and_no_signal(self):
        self.simulate();self.unchanged()
        generation=json.loads((self.output/'TEST_ONLY-committed-generation.json').read_text())
        self.assertEqual(len(generation['recovery_records']),7)
        previous=None
        for line in generation['forward_ledger'].splitlines():
            record=json.loads(line)
            self.assertEqual(record['previous_record_hash'],previous)
            self.assertEqual(record['record_hash'],shadow.payload_hash(record,previous));previous=record['record_hash']
        self.assertTrue(all(r['test_only'] and r['approved_by'].startswith('TEST_ONLY:') for r in generation['recovery_records']))
        self.assertFalse(generation['status']['production_signal']);self.assertFalse(generation['status']['live_capital'])
        self.assertEqual(generation['status']['capital_allocation_pct'],0)
        self.assertEqual(generation['status']['eligible_observations'],0)
        self.assertEqual(generation['status']['completed_outcomes'],0)
        self.assertEqual(generation['candidate']['metadata']['data_version'],self.draft['contract']['candidate_data_version'])
        self.assertEqual(daily.digest(generation['candidate']),self.draft['contract']['candidate_sha256'])

    def test_each_one_of_seven_missing_approval_rejected(self):
        for n in range(7):
            env=copy.deepcopy(self.envelope);env['approvals'].pop(n)
            with self.subTest(n=n),self.assertRaises(daily.Error):self.simulate(env)
            self.unchanged();self.assertFalse((self.output/'TEST_ONLY-committed-generation.json').exists())

    def test_contract_tampering_rejected_even_with_new_test_pins(self):
        for key,value in [('candidate_data_version','wrong'),('candidate_sha256','0'*64),
                          ('anchor_publication_sha','0'*40),('recovery_target','2026-10-19')]:
            env=copy.deepcopy(self.envelope);env['contract'][key]=value
            with self.subTest(key=key),self.assertRaises(daily.Error):self.simulate(env)
        for key in ('incident_id','record_hash','reason','expected_target','p0'):
            env=copy.deepcopy(self.envelope);env['contract']['items'][0][key]='tampered'
            with self.subTest(key=key),self.assertRaises(daily.Error):self.simulate(env)
        self.unchanged()

    def test_bad_individual_approval_rejected(self):
        for key,value in [('item_sha256','wrong'),('contract_sha256','wrong'),('recovery_target','2026-10-19'),
                          ('incident_id','unknown'),('approved_at','2026-10-18T00:00:00+08:00'),
                          ('approved_by',bridge.APPROVED_BY),('test_only',False)]:
            env=copy.deepcopy(self.envelope);env['approvals'][0][key]=value
            with self.subTest(key=key),self.assertRaises(daily.Error):self.simulate(env)
        self.unchanged()

    def test_evidence_corrupt_sha_and_http_rejected(self):
        for key,value in [('sha256','0'*64),('raw',b'{}'),('http_status',402)]:
            evidence=copy.deepcopy(self.evidence);evidence['receipts'][0][key]=value
            with self.subTest(key=key),self.assertRaises(daily.Error):self.simulate(evidence=evidence)
        self.unchanged()

    def test_stale_and_new_trading_day_rejected(self):
        for now in (at('2026-10-17','08:00:00'),at('2026-10-18','01:00:00'),at('2026-10-19','18:00:00')):
            with self.subTest(now=now),self.assertRaises(daily.Error):self.simulate(now=now)
        self.unchanged()

    def test_old_grant_unknown_incident_and_pending_p0_rejected(self):
        env=copy.deepcopy(self.envelope);env['authorization_id']=bridge.APPROVED_BY
        with self.assertRaises(daily.Error):self.simulate(env)
        for reason in (exact.REASON,'PROTECTED_ARTIFACT_HASH_MISMATCH:fixture'):
            with tempfile.TemporaryDirectory() as extra:
                # Additions confined to this existing temporary fixture, never production.
                path=self.root/daily.INCIDENTS;before=path.read_bytes()
                shadow.append_record(path,{'record_id':'TEST_ONLY:unknown','record_type':'DAILY_VALIDATION_FAILURE',
                    'reason':reason,'requires_integrity_review':True})
                with self.assertRaises(daily.Error):self.simulate()
                path.write_bytes(before)
        self.unchanged()

    def test_duplicate_approval_rejected(self):
        env=copy.deepcopy(self.envelope);env['approvals'][1]=copy.deepcopy(env['approvals'][0])
        with self.assertRaises(daily.Error):self.simulate(env)
        self.unchanged()

    def test_external_pins_cannot_be_self_declared(self):
        with self.assertRaises(daily.Error):
            exact._plan(self.root,self.envelope,self.evidence,self.now,None,True)
        bad=pins(self.envelope);bad['individual'].pop(next(iter(bad['individual'])))
        with self.assertRaises(daily.Error):exact._plan(self.root,self.envelope,self.evidence,self.now,bad,True)

    def test_test_only_fixture_never_accepted_by_production(self):
        with self.assertRaisesRegex(daily.Error,'TEST_APPROVAL_FORBIDDEN'):
            exact.production_plan(self.root,self.envelope,self.evidence,self.now,pins(self.envelope))
        with self.assertRaises(daily.Error):exact.production_plan(self.root,self.draft,self.evidence,self.now)
        self.unchanged()

    def test_repeated_execution_no_duplicate_recovery(self):
        first=self.simulate();second=self.simulate()
        self.assertEqual(first['sha256'],second['sha256']);self.assertEqual(second['status'],'NOOP_ALREADY_COMMITTED')
        self.unchanged()

    def test_interrupt_before_commit_and_retry(self):
        def fail(where):raise OSError('TEST_ONLY interruption')
        with self.assertRaises(OSError):self.simulate(interrupt=fail)
        self.assertFalse((self.output/'TEST_ONLY-committed-generation.json').exists());self.unchanged()
        self.assertEqual(self.simulate()['status'],'COMMITTED_TEST_ONLY')

    def test_interrupt_after_commit_and_retry(self):
        def fail(where):
            if where=='AFTER_COMMIT':raise OSError('TEST_ONLY after atomic commit')
        with self.assertRaises(OSError):self.simulate(interrupt=fail)
        self.assertEqual(self.simulate()['status'],'NOOP_ALREADY_COMMITTED');self.unchanged()

    def test_partial_staging_or_corrupt_committed_bundle_never_accepted(self):
        (self.output/'.TEST_ONLY-staging-interrupted').write_bytes(b'{')
        self.simulate();self.unchanged()
        (self.output/'TEST_ONLY-committed-generation.json').write_bytes(b'{')
        with self.assertRaises(daily.Error):self.simulate()

    def test_concurrent_lock_fails_without_publication(self):
        (self.output/'.TEST_ONLY-publish.lock').write_text('TEST_ONLY other publisher')
        with self.assertRaises(FileExistsError):self.simulate()
        self.assertFalse((self.output/'TEST_ONLY-committed-generation.json').exists());self.unchanged()

    def test_test_generation_records_do_not_clear_legacy_latch(self):
        self.simulate();generation=json.loads((self.output/'TEST_ONLY-committed-generation.json').read_text())
        records=shadow.read_jsonl(self.root/self.policy['paths']['forward_ledger'])+generation['recovery_records']
        self.assertEqual(len(daily.pending_integrity_reviews(self.root,records)),7)
        self.assertFalse(bridge.approved(generation['recovery_records']))

    def test_relabelled_old_evidence_after_completed_new_day_rejected(self):
        evidence=copy.deepcopy(self.evidence);now=at('2026-10-19','18:00:00')
        evidence['captured_at']=now.isoformat()
        for receipt in evidence['receipts']:receipt['retrieved_at']=now.isoformat()
        # New dates need actual new source coverage, not rewritten timestamps.
        with self.assertRaisesRegex(daily.Error,'EXACT_REQUIRED_FRESH_SOURCE_MISSING'):
            self.simulate(evidence=evidence,now=now)
        self.assertFalse((self.output/'TEST_ONLY-committed-generation.json').exists());self.unchanged()

    def test_company_action_and_bridge_limit_still_enforced(self):
        for mutation in ('action','missing_actions','bridge_limit','revision'):
            evidence=copy.deepcopy(self.evidence)
            for e in evidence['receipts']:
                if mutation=='action' and 'TaiwanStockSplitPrice' in e['source_url']:
                    payload=json.loads(e['raw']);payload['data']=[{'date':exact.TARGET,'stock_id':'00631L'}]
                    e['raw']=json.dumps(payload).encode();e['sha256']=exact.sha(e['raw'])
                if mutation=='revision' and 'yahoo' in e['source_url']:
                    payload=json.loads(e['raw']);payload['chart']['result'][0]['indicators']['quote'][0]['open'][0]=99
                    e['raw']=json.dumps(payload).encode();e['sha256']=exact.sha(e['raw'])
            if mutation=='missing_actions':evidence['receipts']=[e for e in evidence['receipts'] if 'dataset=' not in e['source_url']]
            with self.subTest(mutation=mutation):
                if mutation=='bridge_limit':
                    with patch.object(bridge,'MAX_SESSIONS',2),self.assertRaises(daily.Error):self.simulate(evidence=evidence)
                else:
                    with self.assertRaises(daily.Error):self.simulate(evidence=evidence)
        self.unchanged()


if __name__ == '__main__':
    unittest.main()
