import io
import json
import pathlib
import unittest
from scripts import update_radar_daily as daily
from scripts.verify_stable_pages import verify


class StablePublicationTests(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(__file__).resolve().parents[1]
        self.receipt = dict(schema='HS_STABLE_APP_RELEASE_V1', deployment_commit='a' * 40)
        self.run = dict(head_sha='a' * 40, head_branch='main', status='completed', conclusion='success')
        self.files = {str(daily.path_for(self.root, s).relative_to(self.root)).replace('\\', '/'):
                      json.loads(daily.path_for(self.root, s).read_text(encoding='utf-8')) for s in daily.SYMBOLS}
        self.files[daily.PUBLIC_STATUS] = json.loads((self.root / daily.PUBLIC_STATUS).read_text(encoding='utf-8'))

    def fetch(self, url, timeout):
        name = url.split('/-hs-invest/')[1].split('?')[0]
        return io.BytesIO(json.dumps(self.receipt if name == 'app-release.json' else self.files[name]).encode())

    def check(self):
        return verify(self.root, 'https://fixture.invalid/-hs-invest/', attempts=1, delay=0,
                      fetcher=self.fetch, run_reader=lambda: [self.run])

    def test_success_requires_real_matching_run_and_all_exact_json(self):
        self.assertTrue(self.check())

    def test_dispatch_or_running_is_not_publication(self):
        self.run['status'] = 'in_progress'
        self.assertFalse(self.check())

    def test_successful_wrong_commit_rejected(self):
        self.run['head_sha'] = 'b' * 40
        self.assertFalse(self.check())

    def test_successful_other_branch_rejected(self):
        self.run['head_branch'] = 'feature'
        self.assertFalse(self.check())

    def test_public_data_mismatch_rejected(self):
        self.files[daily.PUBLIC_STATUS] = dict(self.files[daily.PUBLIC_STATUS], unexpected='TEST_ONLY')
        self.assertFalse(self.check())

    def test_invalid_receipt_rejected(self):
        self.receipt['deployment_commit'] = 'PENDING'
        self.assertFalse(self.check())

    def test_final_verifies_exact_artifact_not_unrelated_raw_generation(self):
        self.files['finalized-core-score-snapshots-v1.json'] = json.loads((self.root / 'finalized-core-score-snapshots-v1.json').read_text(encoding='utf-8'))
        self.files[daily.PUBLIC_STATUS] = {'concurrent_raw_update': True}
        self.assertTrue(verify(self.root, 'https://fixture.invalid/-hs-invest/', attempts=1, delay=0,
                               fetcher=self.fetch, run_reader=lambda: [self.run], verify_final=True))

    def test_final_old_public_artifact_is_not_success(self):
        self.files['finalized-core-score-snapshots-v1.json'] = {'snapshots': []}
        self.assertFalse(verify(self.root, 'https://fixture.invalid/-hs-invest/', attempts=1, delay=0,
                                fetcher=self.fetch, run_reader=lambda: [self.run], verify_final=True))

    def test_final_needs_matching_successful_pages_run(self):
        self.files['finalized-core-score-snapshots-v1.json'] = json.loads((self.root / 'finalized-core-score-snapshots-v1.json').read_text(encoding='utf-8'))
        self.run['status'] = 'in_progress'
        self.assertFalse(verify(self.root, 'https://fixture.invalid/-hs-invest/', attempts=1, delay=0,
                                fetcher=self.fetch, run_reader=lambda: [self.run], verify_final=True))

    def test_final_does_not_read_a_separate_raw_archive(self):
        import tempfile
        payload = json.loads((self.root / 'finalized-core-score-snapshots-v1.json').read_text(encoding='utf-8'))
        self.files['finalized-core-score-snapshots-v1.json'] = payload
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'finalized-core-score-snapshots-v1.json').write_text(json.dumps(payload), encoding='utf-8')
            self.assertTrue(verify(root, 'https://fixture.invalid/-hs-invest/', attempts=1, delay=0,
                                   fetcher=self.fetch, run_reader=lambda: [self.run], verify_final=True))

    def quote_check(self):
        return verify(self.root, 'https://fixture.invalid/-hs-invest/', attempts=1, delay=0,
                      fetcher=self.fetch, run_reader=lambda: [self.run], verify_quotes=True)

    def seed_quotes(self):
        for name in ('market-quotes.json', 'market-quotes-meta.json'):
            self.files[name] = json.loads((self.root / name).read_text(encoding='utf-8'))

    def test_quote_success_attests_both_exact_files_not_raw_history(self):
        self.seed_quotes()
        del self.files[daily.PUBLIC_STATUS]
        self.assertTrue(self.quote_check())

    def test_quote_prices_or_metadata_mismatch_is_not_success(self):
        for name in ('market-quotes.json', 'market-quotes-meta.json'):
            with self.subTest(file=name):
                self.seed_quotes()
                self.files[name] = {'old_or_partial': True}
                self.assertFalse(self.quote_check())

    def test_quote_failed_upload_is_not_success_even_if_public_json_matches(self):
        self.seed_quotes()
        self.run['conclusion'] = 'cancelled'
        self.assertFalse(self.quote_check())

    def test_quote_only_checkout_has_no_dependency_on_unrelated_history(self):
        import tempfile
        self.seed_quotes()
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            for name in ('market-quotes.json', 'market-quotes-meta.json'):
                (root / name).write_text(json.dumps(self.files[name]), encoding='utf-8')
            self.assertTrue(verify(root, 'https://fixture.invalid/-hs-invest/', attempts=1, delay=0,
                                   fetcher=self.fetch, run_reader=lambda: [self.run], verify_quotes=True))

    def test_mutually_conflicting_scopes_rejected(self):
        with self.assertRaisesRegex(ValueError, 'PUBLICATION_SCOPE_CONFLICT'):
            verify(self.root, 'https://fixture.invalid/', verify_final=True, verify_quotes=True)


if __name__ == '__main__':
    unittest.main()
