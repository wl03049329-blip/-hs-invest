"""Status must describe the durable incident chain, not its pre-append view."""
import json
import unittest
from unittest.mock import patch
import phase_l7_daily as daily
import phase_l7_shadow as shadow
import test_phase_l7_incidents as incident_fixtures


class StatusTimingTests(unittest.TestCase):
    def setUp(self):
        self.fixture = incident_fixtures.IncidentTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def test_new_incident_is_present_with_real_hash_in_persisted_status(self):
        f = self.fixture
        result = f.tick()
        chain = shadow.read_jsonl(f.root / daily.INCIDENTS)
        expected = {r['record_id']: r['record_hash'] for r in chain
                    if r.get('requires_integrity_review')}
        self.assertTrue(expected)
        self.assertEqual({r['incident_id']: r['record_hash']
                          for r in result['blocking_incidents']}, expected)
        self.assertEqual(json.loads((f.root / daily.STATUS).read_text()), result)
        self.assertEqual(result['status'], 'FAIL_CLOSED')
        self.assertEqual(shadow.validate_hash_chain(f.root / daily.INCIDENTS)['status'], 'PASS')
        saved = (f.root / daily.INCIDENTS).read_bytes()
        f.tick()
        self.assertEqual((f.root / daily.INCIDENTS).read_bytes(), saved)

    def test_dry_run_does_not_create_an_incident_or_status(self):
        f = self.fixture
        before = f.bytes()
        result = f.tick(dry_run=True)
        self.assertEqual(result['status'], 'FAIL_CLOSED')
        self.assertEqual(f.bytes(), before)

    def test_status_write_failure_does_not_rewrite_durable_incident(self):
        f = self.fixture
        with patch.object(daily, 'atomic_json', side_effect=OSError('fixture disk failure')):
            with self.assertRaises(OSError):
                f.tick()
        self.assertEqual(shadow.validate_hash_chain(f.root / daily.INCIDENTS)['status'], 'PASS')
        self.assertTrue(shadow.read_jsonl(f.root / daily.INCIDENTS))


if __name__ == '__main__':
    unittest.main()
