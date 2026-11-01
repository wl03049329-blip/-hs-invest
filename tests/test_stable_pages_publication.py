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


if __name__ == '__main__':
    unittest.main()
