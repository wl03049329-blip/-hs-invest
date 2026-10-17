"""Workflow/Reader/Git integration, entirely temporary TEST_ONLY repositories."""
import base64
import copy
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import phase_l7_daily as daily
import phase_l7_exact_recovery as exact
import phase_l7_recovery_reader as reader
import phase_l7_recovery_workflow as workflow
import phase_l7_recovery_github as github
import phase_l7_shadow as shadow
import test_phase_l7_recovery_adapter as fixture


class LocalPublisher(github.GitPublisher):
    environment='TEST_ONLY'
    destination='TEST_ONLY:local-bare-repository'


class IntegrationTests(unittest.TestCase):
    setUp=fixture.AdapterTests.setUp
    unchanged=fixture.AdapterTests.unchanged
    client=fixture.AdapterTests.client
    approved=fixture.AdapterTests.approved
    dependencies=fixture.AdapterTests.dependencies

    def generation(self):
        self.dependencies();c=self.approved();c.commit(self.now)
        return c,c.read_committed()[1]

    def git(self,*args):
        return subprocess.check_output(['git','-C',str(self.root),*args],stderr=subprocess.DEVNULL)

    def history(self):
        c,files=self.generation()
        # Only TEST fixture working copies receive this materialized generation.
        for p,raw in files.items():
            target=self.root/p;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw)
        self.git('add','--',*files)
        self.git('-c','user.name=github-actions[bot]','-c','user.email=41898282+github-actions[bot]@users.noreply.github.com',
                 'commit','-qm','TEST_ONLY exact publication')
        commit=self.git('rev-parse','HEAD').decode().strip()
        registry=dict(c.registry,execution={'workflow_run_id':'TEST_ONLY:not-a-production-run'})
        receipt={'environment':'TEST_ONLY','contract_sha256':daily.digest(self.envelope['contract']),
            'git_commit':commit,'verified_at':self.now.isoformat(),'files_sha256':{p:exact.sha(b) for p,b in files.items()},
            'stages':{s:'PASS' for s in fixture.adapter.STAGES}}
        config={'envelope':self.envelope,'pins':fixture.fixtures.pins(self.envelope),'registry':registry,
                'receipt':receipt,'verified_receipt_sha256':daily.digest(receipt)}
        records=shadow.read_jsonl(self.root/self.policy['paths']['forward_ledger'])
        return c,config,records

    def test_historical_review_positive_is_test_only_and_never_grants_production(self):
        c,config,records=self.history()
        expected={i['incident_id'] for i in self.envelope['contract']['items']}
        self.assertEqual(reader._ids(self.root,records,config,test_only=True),expected)
        self.assertEqual(reader.reviewed_ids(self.root,records,{'authorizations':[config]}),set())
        self.assertEqual(len(daily.pending_integrity_reviews(self.root,records)),7)
        with self.assertRaises(daily.Error):reader._ids(self.root,records,config)

    def test_missing_external_completion_pin_or_wrong_record_is_rejected(self):
        c,config,records=self.history()
        for mutate in ('pin','target','record','hash'):
            cfg=copy.deepcopy(config);rows=copy.deepcopy(records)
            if mutate=='pin':cfg['verified_receipt_sha256']='0'*64
            if mutate=='target':cfg['envelope']['contract']['recovery_target']='2026-10-19'
            if mutate=='record':rows.pop()
            if mutate=='hash':cfg['envelope']['contract']['items'][0]['record_hash']='0'*64
            with self.subTest(mutate=mutate),self.assertRaises(daily.Error):reader._ids(self.root,rows,cfg,test_only=True)

    def test_disabled_entry_does_not_read_bundle_or_write_output(self):
        out=self.output/'disabled'
        with self.assertRaisesRegex(daily.Error,'RECOVERY_DISABLED'):
            workflow.execute('publish',self.root,self.root/'NONEXISTENT',out,{})
        self.assertFalse(out.exists());self.unchanged()

    def test_contract_pins_actual_incident_classifier_implementation(self):
        body=self.draft['contract']
        self.assertEqual(body['validator_sha256']['phase_l7_incidents.py'],
                         shadow.sha(Path(daily.incidents.__file__)))
        tampered=copy.deepcopy(self.envelope)
        tampered['contract']['validator_sha256']['phase_l7_incidents.py']='0'*64
        c=self.client(tampered);c.prepare(self.now)
        with self.assertRaises(daily.Error):c.validate(self.now)
        self.assertFalse(self.output.joinpath('current.json').exists());self.unchanged()

    def test_manual_gate_rejects_schedule_test_and_empty_approval(self):
        env={'HS_EXACT_RECOVERY_ENABLED':'true','CONFIRM_EXACT_RECOVERY':'true',
             'GITHUB_REPOSITORY':github.REPOSITORY,'GITHUB_REF':'refs/heads/main','GITHUB_EVENT_NAME':'schedule'}
        with self.assertRaisesRegex(daily.Error,'MANUAL_MAIN_ONLY'):workflow.gate(self.envelope,{}, {},env)
        env['GITHUB_EVENT_NAME']='workflow_dispatch'
        with self.assertRaisesRegex(daily.Error,'TEST_CREDENTIALS'):workflow.gate(self.envelope,{}, {'environment':'PRODUCTION'},env)
        # An unsigned production draft has NO invented human approver or time.
        with self.assertRaisesRegex(daily.Error,'SEVEN_APPROVALS'):workflow.gate(self.draft,{}, {'environment':'PRODUCTION'},env)
        self.unchanged()

    def test_missing_or_wrong_dependency_sha_and_workflow_version_rejected(self):
        body=self.draft['contract']
        self.assertEqual(set(body['validator_sha256']),{'phase_l7_daily.py','phase_l7_bridge.py',
                         'phase_l7_shadow.py','phase_l7_incidents.py'})
        self.assertEqual(set(body['adapter_implementation_sha256']),{'phase_l7_recovery_adapter.py',
            'phase_l7_recovery_evidence.py','phase_l7_recovery_reader.py','phase_l7_recovery_github.py',
            'phase_l7_recovery_workflow.py','build_frontend_status.py'})
        for group in ('validator_sha256','adapter_implementation_sha256','workflow_sha256'):
            for change in ('missing','wrong'):
                envelope=copy.deepcopy(self.envelope)
                key=next(iter(envelope['contract'][group]))
                if change=='missing':del envelope['contract'][group][key]
                else:envelope['contract'][group][key]='0'*64
                c=self.client(envelope);c.prepare(self.now)
                with self.subTest(group=group,change=change),self.assertRaises(daily.Error):c.validate(self.now)
                self.assertFalse((self.output/'current.json').exists());self.unchanged()

    def test_changed_actual_incident_module_bytes_rejected_without_source_mutation(self):
        original=Path(daily.incidents.__file__)
        raw=original.read_bytes()
        isolated=self.output/'TEST_ONLY-classifier'/'phase_l7_incidents.py'
        isolated.parent.mkdir();isolated.write_bytes(raw+b'\n# TEST_ONLY changed implementation\n')
        c=self.client();c.prepare(self.now)
        with patch.object(daily.incidents,'__file__',str(isolated)),self.assertRaises(daily.Error):
            c.validate(self.now)
        self.assertEqual(original.read_bytes(),raw)
        self.assertFalse((self.output/'current.json').exists());self.unchanged()

    def test_bundle_sha_verifies_raw_evidence_not_a_pass_string(self):
        evidence=copy.deepcopy(self.evidence)
        for e in evidence['receipts']:e['raw_base64']=base64.b64encode(e.pop('raw')).decode()
        path=self.output/'bundle.json';path.write_text(json.dumps({'envelope':self.envelope,'evidence':evidence}))
        _,_,decoded=workflow.load_bundle(path)
        self.assertEqual(decoded['receipts'][0]['raw'],self.evidence['receipts'][0]['raw'])
        evidence['receipts'][0]['sha256']='0'*64;path.write_text(json.dumps({'envelope':self.envelope,'evidence':evidence}))
        with self.assertRaises(daily.Error):workflow.load_bundle(path)

    def local_publisher(self,files,fail_pages=False):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        remote=Path(temporary.name)/'remote.git'
        subprocess.run(['git','clone','--bare',str(self.root),str(remote)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        base=self.git('rev-parse','HEAD').decode().strip()
        subprocess.run(['git','--git-dir',str(remote),'update-ref','refs/heads/main',base],check=True)
        self.git('remote','add','origin',str(remote))
        receipts=[];requests=[]
        def request(path,method='GET'):
            requests.append((path,method))
            if method=='POST':
                if fail_pages:raise OSError('TEST_ONLY Pages acknowledgement interruption')
                return {'status':'queued'}
            return {'sha':subprocess.check_output(['git','--git-dir',str(remote),'rev-parse','refs/heads/main']).decode().strip()}
        publisher=LocalPublisher(self.root,base,request=request,receipt_sink=receipts.append)
        return publisher,remote,receipts,requests

    def test_git_atomic_commit_ff_push_preserves_working_files_and_real_index(self):
        c,files=self.generation();publisher,remote,receipts,requests=self.local_publisher(files)
        index=(self.root/'.git/index').read_bytes()
        result=publisher(c.read_committed()[0],files)
        self.assertEqual((self.root/'.git/index').read_bytes(),index);self.unchanged()
        for path,raw in files.items():
            actual=subprocess.check_output(['git','--git-dir',str(remote),'show',result['git_commit']+':'+path])
            self.assertEqual(actual,raw)
        self.assertEqual(len(receipts),1);self.assertTrue(any(method=='POST' for _,method in requests))
        with self.assertRaisesRegex(daily.Error,'REMOTE_BASE_CHANGED'):publisher(c.read_committed()[0],files)

    def test_git_publish_interrupted_after_atomic_push_has_resumable_unverified_receipt(self):
        c,files=self.generation();publisher,remote,receipts,_=self.local_publisher(files,fail_pages=True)
        with self.assertRaises(OSError):publisher(c.read_committed()[0],files)
        self.assertEqual(len(receipts),1)
        head=subprocess.check_output(['git','--git-dir',str(remote),'rev-parse','refs/heads/main']).decode().strip()
        self.assertEqual(head,receipts[0]['git_commit']);self.unchanged()

    def test_independent_verifier_reads_repository_and_public_bytes(self):
        c,files=self.generation();commit='a'*40;base=self.envelope['contract']['base_git_sha']
        def request(path,method='GET'):
            if path.endswith('/commits/'+commit):return {'parents':[{'sha':base}],
                'commit':{'author':{'email':'41898282+github-actions[bot]@users.noreply.github.com'}},
                'files':[{'filename':p} for p in files]}
            if '/actions/runs/' in path:return {'id':1,'event':'workflow_dispatch','head_sha':base,'conclusion':'success'}
            if path.endswith('/pages/builds/latest'):return {'status':'built','commit':commit}
            if path.endswith('/commits/main'):return {'sha':commit}
            if '/contents/' in path:
                p=path.split('/contents/',1)[1].split('?')[0]
                return {'encoding':'base64','content':base64.b64encode(files[p]).decode()}
            self.fail('Unexpected TEST_ONLY API path')
        verifier=github.GitPagesVerifier({'workflow_run_id':1},base,request=request,fetch=lambda p:files[p])
        observed=verifier({'git_commit':commit},tuple(files))
        self.assertEqual(observed['repo_files'],files);self.assertEqual(observed['public_files'],files)
        stale=github.GitPagesVerifier({'workflow_run_id':1},base,request=request,fetch=lambda p:b'old')
        self.assertNotEqual(stale({'git_commit':commit},tuple(files))['public_files'],files)

    def test_workflow_is_dispatch_only_disabled_and_validate_default(self):
        root=Path(daily.__file__).resolve().parents[2]
        text=(root/workflow.WORKFLOW).read_text()
        self.assertIn('workflow_dispatch:',text);self.assertNotIn('schedule:',text);self.assertNotIn('workflow_run:',text)
        self.assertIn('default: validate',text);self.assertIn('default: false',text)
        self.assertIn("vars.HS_EXACT_RECOVERY_ENABLED == 'true'",text)
        self.assertIn('environment: 00631l-exact-recovery',text)
        original=(root/'.github/workflows/00631l-forward-shadow.yml').read_text()
        self.assertIn("cron: '47 9,11,13 * * 1-5'",original)
        self.assertIn('HS_EXACT_REVIEWED_AUTHORIZATIONS_JSON',original)
        self.assertNotIn('phase_l7_recovery_workflow.py',original)


if __name__=='__main__':unittest.main()
