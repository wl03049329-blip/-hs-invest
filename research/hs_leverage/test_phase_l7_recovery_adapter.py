"""Isolated adapter tests; no real approver, publish client or production write."""
import copy
import json
import shutil
import unittest
from datetime import timedelta
from pathlib import Path

import phase_l7_daily as daily
import phase_l7_exact_recovery as exact
import phase_l7_recovery_adapter as adapter
import phase_l7_recovery_evidence as fresh
import phase_l7_shadow as shadow
import test_phase_l7_exact_recovery as fixtures
from test_phase_l7_daily import at


class AdapterTests(unittest.TestCase):
    setUp = fixtures.ExactRecoveryTests.setUp
    unchanged = fixtures.ExactRecoveryTests.unchanged

    def client(self, envelope=None, **options):
        envelope = envelope or self.envelope
        return adapter.RecoveryAdapter(self.root, self.output, envelope, self.evidence,
            mode='TEST_ONLY', trusted_pins=fixtures.pins(envelope), approver_registry={
                'environment':'TEST_ONLY','authorization_id':envelope['authorization_id'],
                'approved_contract_sha256':daily.digest(envelope['contract']),
                'approved_principals':['TEST_ONLY:unit-test-not-owner']}, **options)

    def approved(self, client=None):
        c=client or self.client();c.prepare(self.now);c.validate(self.now);c.approve(self.now)
        return c

    def dependencies(self):
        paths=set(self.policy['protected_hashes'])|{'research/hs_leverage/phase_l7_forward_policy.json',
            'research/hs_leverage/data/00631L-historical-adjusted.json'}
        paths.update(str(Path(shadow.PROVENANCE_DIR)/p) for _,p in shadow.PROVENANCE_SCOPE)
        for p in paths:
            target=self.root/p;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(shadow.ROOT/p,target)

    def committed(self):
        self.dependencies();c=self.approved();self.assertEqual(c.commit(self.now),'COMMITTED_GENERATION')
        self.unchanged();return c

    @staticmethod
    def publish_client(pointer, files):
        return {'environment':'TEST_ONLY','git_commit':'TEST_ONLY:simulated-release',
                'generation':pointer['generation']}

    def verifier(self, c, stale=False):
        def observe(receipt, paths):
            _,files=c.read_committed();public=dict(files)
            if stale:public['00631l-leverage-status-v1.json']=b'{"old":true}'
            return {'environment':'TEST_ONLY','pages_conclusion':'success',
                'pages_deployment_sha':receipt['git_commit'],'active_release_sha':receipt['git_commit'],
                'repo_files':files,'public_files':public}
        observe.environment='TEST_ONLY';observe.destination='TEST_ONLY:in-memory'
        return observe

    def test_all_six_stages_and_six_file_generation(self):
        c=self.committed();c.publish(self.publish_client,self.now)
        with self.assertRaises(daily.Error):c.read_verified(self.now)
        c.verify(self.verifier(c),self.now)
        files=c.read_verified(self.now);self.assertEqual(len(files),6)
        self.assertEqual(list(c.stages.values()),['PASS']*6)
        status=json.loads(files[daily.STATUS]);self.assertFalse(status['live_capital'])
        self.assertFalse(status['production_signal']);self.assertEqual(status['capital_allocation_pct'],0)
        self.assertEqual(json.loads(files['00631l-leverage-status-v1.json'])['price']['latest_completed_bar'],exact.TARGET)
        self.unchanged()

    def test_no_approval_no_write_and_each_missing_approval(self):
        for n in range(7):
            env=copy.deepcopy(self.envelope);env['approvals'].pop(n);c=self.client(env)
            c.prepare(self.now);c.validate(self.now)
            with self.subTest(n=n),self.assertRaises(daily.Error):c.approve(self.now)
            self.assertFalse((self.output/'current.json').exists());self.unchanged()
        env=copy.deepcopy(self.draft);env['environment']='TEST_ONLY'
        c=self.client(env);c.prepare(self.now);c.validate(self.now)
        with self.assertRaises(daily.Error):c.approve(self.now)

    def test_tampered_manifest_baseline_code_or_candidate_rejected(self):
        for key in ('candidate_data_version','candidate_sha256','base_git_sha','contract_implementation_sha256','recovery_target'):
            env=copy.deepcopy(self.envelope);env['contract'][key]='tampered';c=self.client(env)
            c.prepare(self.now)
            with self.subTest(key=key),self.assertRaises(daily.Error):c.validate(self.now)
        for key in ('incident_id','record_hash','expected_target'):
            env=copy.deepcopy(self.envelope);env['contract']['items'][0][key]='tampered';c=self.client(env)
            c.prepare(self.now)
            with self.subTest(key=key),self.assertRaises(daily.Error):c.validate(self.now)
        self.unchanged()

    def test_stale_public_json_does_not_become_verified(self):
        c=self.committed();c.publish(self.publish_client,self.now)
        with self.assertRaisesRegex(daily.Error,'STALE_REPO_OR_PUBLIC'):c.verify(self.verifier(c,True),self.now)
        self.assertEqual(c.stages['VERIFY'],'FAIL')
        with self.assertRaises(daily.Error):c.read_verified(self.now)
        c.verify(self.verifier(c),self.now);self.assertEqual(c.stages['VERIFY'],'PASS')
        self.unchanged()

    def test_network_interruption_retry_no_duplicate_records(self):
        c=self.committed()
        def offline(*args):raise OSError('TEST_ONLY network interruption')
        offline.environment='TEST_ONLY';offline.destination='TEST_ONLY:in-memory'
        with self.assertRaises(OSError):c.publish(offline,self.now)
        self.assertEqual(c.stages['PUBLISH'],'FAIL')
        with self.assertRaises(daily.Error):c.read_verified(self.now)
        self.assertEqual(c.commit(self.now),'NOOP_ALREADY_COMMITTED')
        c.publish(self.publish_client,self.now);c.verify(self.verifier(c),self.now)
        self.unchanged()

    def test_interrupt_staging_generation_pointer_and_retry(self):
        self.dependencies()
        for point in ('FILES_STAGED','GENERATION_READY','POINTER_COMMITTED'):
            c=self.approved()
            c.store=self.output/point
            def fail(where):
                if where==point:raise OSError('TEST_ONLY interrupt '+point)
            with self.subTest(point=point),self.assertRaises(OSError):c.commit(self.now,fail)
            if point!='POINTER_COMMITTED':self.assertFalse((c.store/'current.json').exists())
            else:self.assertEqual(len(c.read_committed()[1]),6)
            result=c.commit(self.now)
            self.assertEqual(result,'NOOP_ALREADY_COMMITTED' if point=='POINTER_COMMITTED' else 'COMMITTED_GENERATION')
            self.unchanged()

    def test_concurrent_or_residual_lock_rejected(self):
        self.dependencies();c=self.approved();lock=self.output/'.recovery.lock';lock.write_text('TEST_ONLY residual lock')
        with self.assertRaises(FileExistsError):c.commit(self.now)
        self.assertEqual(c.stages['COMMIT'],'FAIL');self.assertFalse((self.output/'current.json').exists());self.unchanged()

    def test_partial_or_modified_generation_not_readable(self):
        c=self.committed();pointer,_=c.read_committed()
        path=self.output/'generations'/pointer['generation']/daily.SNAPSHOT
        path.write_bytes(b'{')
        with self.assertRaises(daily.Error):c.read_committed()
        with self.assertRaises(daily.Error):c.commit(self.now)
        self.unchanged()

    def test_rehashed_generation_still_must_match_approved_plan(self):
        c=self.committed();pointer,_=c.read_committed()
        directory=c.store/'generations'/pointer['generation']
        status_path=directory/daily.STATUS
        status=json.loads(status_path.read_text());status['capital_allocation_pct']=5
        status_path.write_bytes(shadow.canonical(status).encode())
        manifest=shadow.read_json(directory/'generation.json')
        manifest['files'][daily.STATUS]=exact.sha(status_path.read_bytes())
        raw=shadow.canonical(manifest).encode();(directory/'generation.json').write_bytes(raw)
        pointer['manifest_sha256']=exact.sha(raw);(c.store/'current.json').write_bytes(shadow.canonical(pointer).encode())
        with self.assertRaises(daily.Error):c.read_committed()
        self.unchanged()

    def test_long_windows_generation_path_survives_commit_and_read(self):
        self.dependencies()
        envelope=self.envelope
        c=adapter.RecoveryAdapter(self.root,self.output/('nested-path-'*10),envelope,self.evidence,
            mode='TEST_ONLY',trusted_pins=fixtures.pins(envelope),approver_registry={
                'environment':'TEST_ONLY','authorization_id':envelope['authorization_id'],
                'approved_contract_sha256':daily.digest(envelope['contract']),
                'approved_principals':['TEST_ONLY:unit-test-not-owner']})
        ordinary=Path(str(c.store).removeprefix('\\\\?\\')).resolve()
        self.assertIn(self.output.resolve(),ordinary.parents)
        def cleanup_owned_long_fixture():
            # Remove only this verified descendant using its extended path;
            # normal TemporaryDirectory cleanup cannot traverse >MAX_PATH.
            if c.store.exists():shutil.rmtree(c.store)
        self.addCleanup(cleanup_owned_long_fixture)
        self.approved(c);c.commit(self.now)
        self.assertEqual(len(c.read_committed()[1]),6);self.unchanged()

    def test_expiry_between_approve_and_commit_no_write(self):
        c=self.approved()
        with self.assertRaises(daily.Error):c.commit(self.now+timedelta(hours=7))
        self.assertFalse((self.output/'current.json').exists());self.unchanged()

    def test_principal_registry_is_independent_of_pins(self):
        c=self.client();c.registry['approved_principals']=[];c.prepare(self.now);c.validate(self.now)
        with self.assertRaisesRegex(daily.Error,'PRINCIPAL_NOT'):c.approve(self.now)

    def test_production_default_disabled_and_test_credentials_never_accepted(self):
        c=adapter.RecoveryAdapter(self.root,self.output,self.envelope,self.evidence)
        with self.assertRaises(daily.Error):c._approved_plan(self.now)
        with self.assertRaises(daily.Error):c.prepare(self.now)  # Production wall clock cannot be overridden.
        with self.assertRaisesRegex(daily.Error,'TEST_APPROVAL_FORBIDDEN'):
            exact.production_plan(self.root,self.envelope,self.evidence,self.now,fixtures.pins(self.envelope))
        self.unchanged()

    def test_publish_or_verify_cannot_skip_phases(self):
        c=self.client()
        for method in (lambda:c.commit(self.now),lambda:c.publish(self.publish_client,self.now),
                       lambda:c.verify(self.verifier(c),self.now),lambda:c.read_verified(self.now)):
            with self.assertRaises(daily.Error):method()

    def refresh(self, now=None, fail_actions=False):
        now=now or self.now;self.requests=[]
        def request(url):
            self.requests.append(url)
            if fail_actions and 'dataset=' in url:return 402,b'not an empty action list'
            return 200,json.dumps(self.source.fetch(url)).encode()
        return fresh.refresh(self.root,now,request=request,clock=lambda:now)

    def test_refresh_creates_new_unsigned_body_not_extended_old_manifest(self):
        old=copy.deepcopy(self.draft)
        r=self.refresh(self.now+timedelta(minutes=1))
        self.assertEqual(r['status'],'FRESH_VALIDATED_UNSIGNED');self.assertEqual(self.draft,old)
        self.assertNotEqual(daily.digest(r['draft']['contract']),daily.digest(old['contract']))
        self.assertIsNone(r['draft']['authorization_id']);self.assertEqual(r['draft']['approvals'],[])
        self.assertEqual(sum('yahoo' in u for u in self.requests),3);self.unchanged()

    def test_402_stops_actions_and_does_not_fake_empty_data(self):
        r=self.refresh(fail_actions=True)
        self.assertEqual(r['status'],'EVIDENCE_INCOMPLETE');self.assertIsNone(r['draft'])
        self.assertEqual(sum('dataset=' in u for u in self.requests),1)
        self.assertFalse(any(e['name'].startswith('Taiwan') for e in r['evidence']['receipts']))

    def test_new_completed_day_never_expands_old_recovery_target(self):
        r=self.refresh(at('2026-10-19','18:00:00'))
        self.assertEqual(r['status'],'NEW_COMPLETED_DAY_OUTSIDE_RECOVERY_SCOPE');self.assertIsNone(r['draft'])
        self.assertEqual(r['recovery_target'],'2026-10-16');self.assertIn('follow_on_probe',r)


AdapterTests.publish_client.environment='TEST_ONLY'
AdapterTests.publish_client.destination='TEST_ONLY:in-memory'

if __name__=='__main__':unittest.main()
