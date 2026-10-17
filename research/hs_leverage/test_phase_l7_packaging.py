"""Packaging-only fixtures. No real Owner grant, GitHub dispatch or publication.

The local HTTP ZIP roundtrip is real I/O, NOT GitHub Actions artifact attestation.
Production-plan positive acceptance is mocked only in the marked boundary test;
TEST_ONLY credentials remain rejected by the deployed production planner.
"""
import copy
import io
import json
import tempfile
import threading
import unittest
import zipfile
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.request import Request, urlopen

import phase_l7_packaging as p
import phase_l7_recovery_workflow as consumer
import test_phase_l7_exact_recovery as fixtures


class PackagingTests(unittest.TestCase):
    setUp = fixtures.ExactRecoveryTests.setUp
    unchanged = fixtures.ExactRecoveryTests.unchanged

    def evidence18(self):
        def request(url):
            return 200, json.dumps(self.source.fetch(url)).encode()
        result = p.sources.refresh(self.root, self.now, request=request, clock=lambda: self.now)
        self.assertEqual(result['status'], 'FRESH_VALIDATED_UNSIGNED')
        return result

    def inputs(self):
        result = self.evidence18()
        encoded = p.encode_evidence(result['evidence'])
        review = p.json_bytes({'envelope': result['draft'], 'evidence': encoded})
        # Synthetic unit-test objects only, never saved as formal approvals.
        envelope = fixtures.fixture_approvals(result['draft'], self.now)
        envelope.update(environment='PRODUCTION', status='APPROVED', authorization_id='unit-fixture-not-real-authorization')
        for n,a in enumerate(envelope['approvals']):
            a.update(approval_id='unit-fixture-'+str(n), authorization_id=envelope['authorization_id'],
                     approved_by='unit-fixture-not-real-owner', test_only=False)
        text = p.COMMENT_PREFIX + json.dumps(envelope)
        comment = {'id': 123, 'user': {'login':'unit-fixture-not-real-owner','id':12345},
                   'created_at':self.now.isoformat(),'updated_at':self.now.isoformat(),'body':text}
        trust = {'owner_login':comment['user']['login'],'owner_id':12345,'owner_comment_id':123,
                 'owner_comment_body_sha256':p.exact.sha(text.encode()),'pins':fixtures.pins(envelope),
                 'source_bundle_sha256':p.exact.sha(review),'base_git_sha':envelope['contract']['base_git_sha'],
                 'contract_sha256':p.daily.digest(envelope['contract'])}
        return review,comment,trust,envelope

    def test_capture_preserves_all_18_raw_responses_and_unsigned_state(self):
        result=self.evidence18()
        with patch.object(p.sources,'refresh',return_value=result):raw=p.capture(self.root,self.now)
        data=json.loads(raw);decoded=p.decode_evidence(data['evidence'])
        self.assertEqual({r['name'] for r in decoded['receipts']},p.receipt_names())
        self.assertEqual(len(decoded['receipts']),18)
        self.assertEqual(data['envelope']['approvals'],[])
        self.assertIsNone(data['envelope']['authorization_id'])
        self.assertEqual([r['raw'] for r in decoded['receipts']],[r['raw'] for r in result['evidence']['receipts']])
        self.unchanged()

    def test_capture_incomplete_or_new_completed_day_never_outputs_bundle(self):
        for status in ('EVIDENCE_INCOMPLETE','NEW_COMPLETED_DAY_OUTSIDE_RECOVERY_SCOPE'):
            with patch.object(p.sources,'refresh',return_value={'status':status}),self.assertRaises(p.daily.Error):
                p.capture(self.root,self.now)
        self.unchanged()

    def test_receipt_missing_hash_conflict_or_credential_url_rejected(self):
        original=self.evidence18()['evidence']
        for kind in ('missing','sha','url'):
            bad=copy.deepcopy(original)
            if kind=='missing':bad['receipts'].pop()
            elif kind=='sha':bad['receipts'][0]['sha256']='0'*64
            else:bad['receipts'][-1]['source_url']+='&token=unit-only-secret'
            with self.subTest(kind=kind),self.assertRaises(p.daily.Error):p.encode_evidence(bad)

    def test_owner_identity_seven_pins_time_and_body_each_required(self):
        _,comment,trust,envelope=self.inputs()
        self.assertEqual(p.owner_envelope(comment,trust,self.now),envelope)
        for kind in ('identity','body','pin','missing','future','edited','test_only'):
            c=copy.deepcopy(comment);t=copy.deepcopy(trust);e=copy.deepcopy(envelope)
            if kind=='identity':c['user']['id']=999
            elif kind=='body':c['body']+=' '
            elif kind=='pin':t['pins']['individual'][e['approvals'][0]['approval_id']]='0'*64
            elif kind=='missing':e['approvals'].pop()
            elif kind=='future':e['approvals'][0]['approved_at']=(self.now+timedelta(seconds=1)).isoformat()
            elif kind=='edited':c['updated_at']=(self.now+timedelta(seconds=1)).isoformat()
            else:e['approvals'][0]['test_only']=True
            if kind in ('missing','future','test_only'):
                c['body']=p.COMMENT_PREFIX+json.dumps(e)
                t['owner_comment_body_sha256']=p.exact.sha(c['body'].encode());t['pins']=fixtures.pins(e)
            with self.subTest(kind=kind),self.assertRaises(p.daily.Error):p.owner_envelope(c,t,self.now)

    def test_missing_external_pins_or_embedded_pins_never_grants_approval(self):
        _,c,t,e=self.inputs();t.pop('pins')
        with self.assertRaises(p.daily.Error):p.owner_envelope(c,t,self.now)
        e['pins']=fixtures.pins(e);c['body']=p.COMMENT_PREFIX+json.dumps(e)
        t['owner_comment_body_sha256']=p.exact.sha(c['body'].encode())
        with self.assertRaises(p.daily.Error):p.owner_envelope(c,t,self.now)
        self.unchanged()

    def test_package_boundary_invokes_production_validator_never_adapter(self):
        raw,c,t,_=self.inputs()
        with patch.object(p.exact,'production_plan') as validator:
            output,receipt=p.package(self.root,raw,c,t,self.now)
        validator.assert_called_once()
        self.assertEqual(json.loads(output)['evidence'],json.loads(raw)['evidence'])
        self.assertEqual(receipt['contract_sha256'],t['contract_sha256'])
        self.assertNotIn('pins',json.loads(output))
        self.assertNotIn('registry',json.loads(output))
        self.unchanged()

    def test_production_validator_refusal_leaves_no_package(self):
        raw,c,t,_=self.inputs()
        with patch.object(p.exact,'production_plan',side_effect=p.daily.Error('TEST_ONLY validator denial')), self.assertRaises(p.daily.Error):
            p.package(self.root,raw,c,t,self.now)
        self.unchanged()

    def test_expired_version_bundle_or_contract_mismatch_rejected(self):
        raw,c,t,_=self.inputs()
        for kind in ('expired','version','bundle','contract'):
            trust=copy.deepcopy(t);now=self.now
            if kind=='expired':now+=timedelta(hours=7)
            elif kind=='version':trust['base_git_sha']='0'*40
            elif kind=='bundle':trust['source_bundle_sha256']='0'*64
            else:trust['contract_sha256']='0'*64
            with self.subTest(kind=kind),self.assertRaises(p.daily.Error):p.package(self.root,raw,c,trust,now)
        self.unchanged()

    def test_run_and_artifact_identity_are_external_and_not_self_asserted(self):
        trust={'source_run_id':4,'base_git_sha':'a'*40,'github_actors':{'fixture':42},
               'source_artifact_id':5,'source_artifact_digest':'sha256:'+'b'*64}
        run={'event':'workflow_dispatch','conclusion':'success','head_sha':'a'*40,
             'path':p.WORKFLOW,'actor':{'login':'fixture','id':42}}
        artifact={'name':p.REVIEW_ARTIFACT,'id':5,'digest':trust['source_artifact_digest'],'expired':False}
        def request(path):return {'total_count':1,'artifacts':[artifact]} if '/artifacts?' in path else run
        self.assertEqual(p.source_artifact(4,trust,request)['id'],5)
        for key,value in [('source_run_id',9),('source_artifact_id',9),('source_artifact_digest','sha256:bad'),('base_git_sha','c'*40)]:
            bad={**trust,key:value}
            with self.subTest(key=key),self.assertRaises(p.daily.Error):p.source_artifact(4,bad,request)
        run['event']='pull_request'
        with self.assertRaises(p.daily.Error):p.source_artifact(4,trust,request)

    def test_manual_main_actor_and_deployed_version_gate(self):
        policy={'base_git_sha':'a'*40,'github_actors':{'fixture':42}}
        env={'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REPOSITORY':p.REPOSITORY,
             'GITHUB_REF':'refs/heads/main','GITHUB_SHA':'a'*40,'GITHUB_ACTOR':'fixture',
             'GITHUB_ACTOR_ID':'42','GITHUB_RUN_ID':'7'}
        def request(path):
            return {'sha':'a'*40} if '/commits/' in path else {'event':'workflow_dispatch','head_sha':'a'*40,
                    'path':p.WORKFLOW,'actor':{'login':'fixture','id':42}}
        with patch.object(p.subprocess,'check_output',return_value=b'a'*40+b'\n'):
            self.assertEqual(p.guard(self.root,env,policy,request)['workflow_run_id'],7)
            for key,value in [('GITHUB_EVENT_NAME','schedule'),('GITHUB_ACTOR_ID','999'),
                              ('GITHUB_REF','refs/heads/topic'),('GITHUB_SHA','b'*40)]:
                with self.subTest(key=key),self.assertRaises(p.daily.Error):p.guard(self.root,{**env,key:value},policy,request)

    def test_real_local_http_zip_upload_download_matches_consumer_contract(self):
        # Actual ZIP bytes and loopback upload/download; no claim of GitHub service success.
        result=self.evidence18();bundle=p.json_bytes({'envelope':result['draft'],'evidence':p.encode_evidence(result['evidence'])})
        directory=self.output/'artifact'
        p.write_output(self.root,directory,bundle,{'operation':'TEST_ONLY:roundtrip'})
        memory=io.BytesIO()
        with zipfile.ZipFile(memory,'w',zipfile.ZIP_DEFLATED) as archive:
            for file in directory.iterdir():archive.writestr(file.name,file.read_bytes())
        uploaded=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                uploaded.append(self.rfile.read(int(self.headers['Content-Length'])))
                self.send_response(201);self.end_headers()
            def do_GET(self):
                self.send_response(200);self.end_headers();self.wfile.write(uploaded[0])
        server=HTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            url='http://127.0.0.1:'+str(server.server_port)+'/artifact'
            with urlopen(Request(url,data=memory.getvalue(),method='POST'),timeout=5) as response:self.assertEqual(response.status,201)
            with urlopen(url,timeout=5) as response:downloaded=response.read()
        finally:server.shutdown();server.server_close();thread.join()
        self.assertEqual(p.exact.sha(downloaded),p.exact.sha(memory.getvalue()))
        with zipfile.ZipFile(io.BytesIO(downloaded)) as archive:
            self.assertEqual(set(archive.namelist()),{'bundle.json','packaging-receipt.json'})
            self.assertEqual(archive.read('bundle.json'),bundle)
            restored=self.output/'restored';restored.mkdir()
            (restored/'bundle.json').write_bytes(archive.read('bundle.json'))
        raw,envelope,evidence=consumer.load_bundle(restored/'bundle.json')
        self.assertEqual(raw,bundle);self.assertEqual(len(evidence['receipts']),18)
        self.assertEqual(envelope['approvals'],[])
        self.unchanged()

    def test_output_cannot_touch_repo_or_overwrite(self):
        with self.assertRaises(p.daily.Error):p.write_output(self.root,self.root/'new',b'{}',{})
        p.write_output(self.root,self.output/'one',b'{}',{})
        with self.assertRaises(p.daily.Error):p.write_output(self.root,self.output/'one',b'{}',{})
        self.unchanged()


class WorkflowContractTests(unittest.TestCase):
    def test_manual_only_permissions_root_bundle_path_and_unchanged_daily(self):
        root=Path(__file__).resolve().parents[2]
        workflow=(root/p.WORKFLOW).read_text(encoding='utf8')
        self.assertIn('workflow_dispatch:',workflow)
        for forbidden in ('schedule:','push:','pull_request:','contents: write','HS_EXACT_RECOVERY_ENABLED','workflow run'):
            self.assertNotIn(forbidden,workflow)
        self.assertIn('environment: 00631l-evidence-packaging',workflow)
        self.assertIn('persist-credentials: false',workflow)
        self.assertIn('exact-packaging-output/bundle.json',workflow)
        self.assertIn(p.REVIEW_ARTIFACT,workflow);self.assertIn(p.RECOVERY_ARTIFACT,workflow)
        consumer_yaml=(root/'.github/workflows/00631l-exact-recovery.yml').read_text(encoding='utf8')
        self.assertIn('name: exact-recovery-input',consumer_yaml)
        self.assertIn('exact-recovery-input/bundle.json',consumer_yaml)


if __name__=='__main__':unittest.main()
