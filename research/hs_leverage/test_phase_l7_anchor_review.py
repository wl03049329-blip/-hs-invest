"""Local-only anchor and review-isolation regression; never collect production data."""
import copy
import json
import os
import subprocess
import sys
import unittest
from unittest.mock import patch

import phase_l7_bridge as bridge
import phase_l7_daily as daily
import phase_l7_shadow as shadow
import test_phase_l7_bridge as fixtures
from test_phase_l7_daily import at, yahoo_for, data_for


class AnchorReviewTests(unittest.TestCase):
    setUp = fixtures.BridgeTests.setUp
    collect = fixtures.BridgeTests.collect
    omit = fixtures.BridgeTests.omit
    null = fixtures.BridgeTests.null
    incident = fixtures.BridgeTests.incident
    tick = fixtures.BridgeTests.tick

    def files(self):
        paths = [daily.SNAPSHOT, '00631l-leverage-status-v1.json', *self.policy['paths'].values()]
        return {p: (self.root / p).read_bytes() if (self.root / p).exists() else None for p in paths}

    def republish(self):
        # A fresh isolated Git fixture, never an attestation bypass/mock.
        self.source.publish_verified_previous()
        self.root = self.source.root

    def test_published_yahoo_anchor_absent_reused_without_byte_or_provenance_change(self):
        before = copy.deepcopy(self.source.prior)
        files = self.files()
        self.omit('2026-09-30')
        self.null()
        data = self.collect()
        row = next(r for r in data['item']['rows'] if r['date'] == '2026-09-30')
        self.assertEqual(row, before['item']['rows'][-1])
        self.assertEqual(shadow.canonical(row), shadow.canonical(before['item']['rows'][-1]))
        self.assertEqual(self.source.prior, before)
        self.assertEqual(self.files(), files)

    def test_published_yahoo_anchor_null_reuses_same_published_row(self):
        before = copy.deepcopy(self.source.prior['item']['rows'][-1])
        self.null('2026-09-30', (*daily.FIELDS, 'volume', 'adjclose'))
        row = next(r for r in self.collect()['item']['rows'] if r['date'] == before['date'])
        self.assertEqual(row, before)

    def test_published_bridge_anchor_keeps_original_provenance(self):
        self.source.prior['item']['rows'][-1]['source_provenance'].update(
            effective_source='TWSE_FACTOR_ONE_BRIDGE', fallback_used=True,
            bridge_anchor_date='2026-09-30')
        self.republish()
        before = copy.deepcopy(self.source.prior['item']['rows'][-1])
        self.omit('2026-09-30')
        self.assertEqual(next(r for r in self.collect()['item']['rows'] if r['date'] == before['date']), before)

    def test_published_non_one_or_bool_factor_fails(self):
        for factor in (.5, True):
            with self.subTest(factor=factor):
                self.source.prior['item']['rows'][-1]['adjustment_factor'] = factor
                self.republish()
                with self.assertRaisesRegex(daily.Error, 'ADJUSTMENT_UNRESOLVED|ANCHOR_FACTOR_NOT_ONE'):
                    self.collect()

    def test_bool_provenance_factor_is_not_numeric_one(self):
        self.source.prior['item']['rows'][-1]['source_provenance']['adjustment_factor'] = True
        self.republish()
        with self.assertRaisesRegex(daily.Error, 'ANCHOR_FACTOR_NOT_ONE'):
            self.collect()

    def test_wrong_publication_sha_is_not_attested(self):
        self.omit('2026-09-30')
        original = subprocess.check_output
        def wrong_sha(args, **kwargs):
            if 'log' in args and '--format=%H' in args:
                return b'f' * 40 + b'\n'
            return original(args, **kwargs)
        with patch.object(daily.subprocess, 'check_output', side_effect=wrong_sha):
            with self.assertRaisesRegex(daily.Error, 'ANCHOR_UNVERIFIED'):
                self.collect()

    def test_yahoo_anchor_after_unreconciled_bridge_does_not_reset_window(self):
        self.source.prior['item']['rows'][-2]['source_provenance'] = {
            'effective_source': 'TWSE_FACTOR_ONE_BRIDGE', 'fallback_used': True,
            'integrity_status': 'PASS', 'bridge_anchor_date': '2026-09-01'}
        self.republish()
        self.assertEqual(self.source.prior['item']['rows'][-1]['source_provenance']['effective_source'], 'YAHOO')
        with self.assertRaisesRegex(daily.Error, 'BRIDGE_WINDOW_REVIEW_REQUIRED'):
            self.collect()

    def test_exactly_ten_official_sessions_pass_but_eleven_fail(self):
        for day in ['2026-10-08', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']:
            self.source.rows.append({**copy.deepcopy(self.source.rows[-1]), 'date': day})
            self.source.official['202610']['data'].append([day, '100', '40', '41', '39', '40'])
        self.source.yahoo = yahoo_for(self.source.rows)
        self.now = at('2026-10-16', '03:00:00')
        original = self.source.fetch
        def calendar(url):
            payload = original(url)
            return payload + [{'Date': '20261009', 'Name': '休市', 'Description': ''}] if url == daily.CALENDAR_URL else payload
        with patch.object(self.source, 'fetch', side_effect=calendar):
            self.null('2026-10-15')
            self.assertEqual(len(self.collect()['metadata']['official_factor_one_bridge']['sessions']), 11)  # anchor +10
            self.source.rows.append({**copy.deepcopy(self.source.rows[-1]), 'date': '2026-10-16'})
            self.source.official['202610']['data'].append(['2026-10-16', '100', '40', '41', '39', '40'])
            self.source.yahoo = yahoo_for(self.source.rows)
            self.now = at('2026-10-17', '03:00:00')
            with self.assertRaisesRegex(daily.Error, 'BRIDGE_WINDOW_REVIEW_REQUIRED'):
                self.collect()

    def test_historical_revision_is_not_hidden_by_pinned_anchor(self):
        self.omit('2026-09-30')
        result = self.source.yahoo['chart']['result'][0]
        days = [daily.datetime.fromtimestamp(t, daily.TAIPEI).date().isoformat() for t in result['timestamp']]
        result['indicators']['quote'][0]['open'][days.index('2026-09-29')] = 40.25
        with self.assertRaisesRegex(daily.Error, 'HISTORICAL_REVISION_REVIEW_REQUIRED'):
            self.collect()

    def test_attestation_rejects_unpublished_or_different_published_sha(self):
        self.omit('2026-09-30')
        self.null()
        price = self.root / daily.SNAPSHOT
        price.write_bytes(price.read_bytes() + b'\n')
        with self.assertRaisesRegex(daily.Error, 'ANCHOR_UNVERIFIED'):
            self.collect()
        # A provenance label cannot impersonate an immutable publication commit.
        subprocess.run(['git', '-C', str(self.root), 'add', '--', daily.SNAPSHOT], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=untrusted', '-c',
                        'user.email=untrusted@example.invalid', 'commit', '-qm', 'not bot publication'], check=True)
        with self.assertRaisesRegex(daily.Error, 'ANCHOR_UNVERIFIED'):
            self.collect()

    def test_unresolved_revision_or_p0_prevents_anchor_reuse(self):
        self.omit('2026-09-30')
        for i, reason in enumerate(['HISTORICAL_REVISION_REVIEW_REQUIRED:2026-09-30',
                                    'CORPORATE_ACTION_REVIEW_REQUIRED', 'PROVENANCE_ARTIFACT_HASH_MISMATCH:x']):
            with self.subTest(reason=reason):
                self.incident(reason, 'CONFLICT:' + str(i))
                with self.assertRaisesRegex(daily.Error, 'BRIDGE_PENDING_INTEGRITY_CONFLICT'):
                    self.collect()

    def test_confirmed_conflicts_are_never_reviewable_as_source_gaps(self):
        for reason in ['BRIDGE_ANCHOR_OHLC_CONFLICT', 'FALLBACK_PREVIOUS_ANCHOR_CONFLICT',
                       'BRIDGE_ANCHOR_FACTOR_NOT_ONE', 'BRIDGE_ORIGIN_UNVERIFIED',
                       'LEGACY_ADJUSTMENT_REVIEW_REQUIRED', 'SYMBOL_MISMATCH',
                       'OFFICIAL_SYMBOL_MISMATCH', 'INSTRUMENT_MISMATCH',
                       'EXCHANGE_TIMEZONE_MISMATCH', 'DAILY_FREQUENCY_REQUIRED']:
            with self.subTest(reason=reason):
                self.assertTrue(bridge.integrity_conflict(reason))
        self.assertFalse(bridge.integrity_conflict('BRIDGE_HISTORICAL_GAP_REVIEW_REQUIRED:2026-10-13'))

    def test_seven_reviews_remain_pending_with_passed_candidate_and_no_publication(self):
        for i in range(7):
            self.incident('BRIDGE_HISTORICAL_GAP_REVIEW_REQUIRED:2026-09-30', 'PENDING:' + str(i))
        before = self.files()
        for _ in range(2):
            with patch.object(shadow, 'load_context', return_value=(self.policy, self.source.historical)):
                status = daily.run(self.root, now=self.now, fetcher=self.source.fetch, dry_run=True)
            self.assertEqual(status['diagnostics'], {'SOURCE_COLLECTION': 'SUCCESS',
                'CANDIDATE_VALIDATION': 'PASS', 'INTEGRITY_REVIEW': 'PENDING',
                'PUBLICATION': 'NOT_PUBLISHED'})
            self.assertEqual(len(status['blocking_incidents']), 7)
            self.assertEqual(status['current_failure_reason'], 'RECOVERY_EVIDENCE_AVAILABLE')
            self.assertTrue(status['requires_integrity_review'])
            self.assertEqual(status['status'], 'FAIL_CLOSED')
            self.assertEqual(self.files(), before)
        self.assertFalse(any(r.get('record_type') == 'CORPORATE_ACTION_RECOVERY'
                             for r in shadow.read_jsonl(self.root / self.policy['paths']['forward_ledger'])))

    def test_source_error_is_not_a_candidate_pass(self):
        with patch.object(self.source, 'fetch', side_effect=OSError('fixture offline')):
            result = self.tick()
        self.assertEqual(result['diagnostics']['SOURCE_COLLECTION'], 'FAILED')
        self.assertEqual(result['diagnostics']['CANDIDATE_VALIDATION'], 'FAIL')
        self.assertEqual(result['diagnostics']['PUBLICATION'], 'NOT_PUBLISHED')

    def test_complete_source_with_bad_ohlc_is_validation_failure(self):
        self.source.yahoo['chart']['result'][0]['indicators']['quote'][0]['open'][-1] = 42
        result = self.tick()
        self.assertEqual(result['diagnostics']['SOURCE_COLLECTION'], 'SUCCESS')
        self.assertEqual(result['diagnostics']['CANDIDATE_VALIDATION'], 'FAIL')
        self.assertEqual(result['diagnostics']['INTEGRITY_REVIEW'], 'BLOCKED')
        self.assertEqual(result['diagnostics']['PUBLICATION'], 'NOT_PUBLISHED')

    def test_local_write_failure_is_not_mislabeled_source_failure(self):
        before = self.files()
        original = daily.atomic_json
        def fail_price(path, value):
            if path == self.root / daily.SNAPSHOT:
                raise OSError('isolated local write failure')
            return original(path, value)
        with patch.object(shadow, 'load_context', return_value=(self.policy, self.source.historical)), patch.object(
                daily, 'collect', return_value=(data_for(self.source.rows, self.now), set())), patch.object(
                daily, 'atomic_json', side_effect=fail_price):
            result = daily.run(self.root, now=self.now)
        self.assertEqual(result['current_failure_reason'], 'LOCAL_PUBLICATION_FAILED')
        self.assertEqual(result['diagnostics'], {'SOURCE_COLLECTION': 'SUCCESS',
            'CANDIDATE_VALIDATION': 'PASS', 'INTEGRITY_REVIEW': 'PASS', 'PUBLICATION': 'FAILED'})
        self.assertEqual(self.files(), before)

    def test_old_authorization_cannot_publish_new_bridge_target(self):
        record = {'record_type': 'CORPORATE_ACTION_RECOVERY', 'approved_by': bridge.APPROVED_BY,
                  'recovery_mode': 'OFFICIAL_FACTOR_ONE_BRIDGE', 'integrity_review_status': 'PASS',
                  'new_data_version': 'fixture', 'recovery_steps_completed': list(bridge.REVIEW_STEPS)}
        data = {'metadata': {'expected_completed_bar': '2026-10-16', 'official_factor_one_bridge':
                            {'target_date': '2026-10-16', 'bridge_sessions': ['2026-10-16']}}}
        self.assertFalse(bridge.publication_authorized([record], data))
        self.assertEqual(bridge.AUTHORIZED_TARGET, '2026-10-07')
        self.assertEqual(bridge.APPROVED_BY, 'USER_AUTHORIZED_REPAIR_2026-10-08')

    def test_old_recovery_does_not_auto_approve_next_target_in_run(self):
        self.incident()
        self.assertFalse(self.tick(flag=True)['requires_integrity_review'])  # Isolated old grant only.
        subprocess.run(['git', '-C', str(self.root), '-c', 'core.autocrlf=false', 'add', '--',
                        daily.SNAPSHOT, daily.STATUS, self.policy['paths']['forward_ledger']], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=github-actions[bot]', '-c',
                        'user.email=41898282+github-actions[bot]@users.noreply.github.com',
                        'commit', '-qm', 'isolated old recovery publication'], check=True)
        self.source.prior = shadow.read_json(self.root / daily.SNAPSHOT)
        self.source.rows.append({**copy.deepcopy(self.source.rows[-1]), 'date': '2026-10-08'})
        self.source.yahoo = yahoo_for(self.source.rows)
        self.source.official['202610']['data'].append(['2026-10-08', '100', '40', '41', '39', '40'])
        self.now = at('2026-10-09', '03:00:00')
        self.null('2026-10-08')
        before = self.files()
        result = self.tick(event='schedule')
        self.assertEqual(result['current_failure_reason'], 'BRIDGE_PUBLICATION_OUTSIDE_AUTHORIZED_SCOPE')
        self.assertEqual(result['diagnostics']['CANDIDATE_VALIDATION'], 'PASS')
        self.assertEqual(result['diagnostics']['INTEGRITY_REVIEW'], 'BLOCKED')
        self.assertEqual(result['diagnostics']['PUBLICATION'], 'NOT_PUBLISHED')
        self.assertEqual(self.files(), before)

    def test_read_only_cli_does_not_lock_or_write_workflow_outputs(self):
        output = self.root / 'github-output'
        with patch.object(sys, 'argv',
                          ['phase_l7_daily.py', '--prepare-review']), patch.dict(os.environ,
                          {'GITHUB_OUTPUT': str(output), 'GITHUB_STEP_SUMMARY': str(output)}), patch('builtins.print'):
            self.assertEqual(daily.main(), 0)
        self.assertFalse(output.exists())
        self.assertFalse((shadow.ROOT / daily.FORWARD / '.daily.lock').exists())

    def test_real_review_preparation_is_read_only_and_never_approval(self):
        root = shadow.ROOT
        paths = [daily.SNAPSHOT, daily.STATUS, daily.INCIDENTS,
                 '00631l-leverage-status-v1.json', *self.policy['paths'].values()]
        before = {p: (root / p).read_bytes() for p in paths}
        report = daily.prepare_review(root)
        self.assertEqual(len(report['incidents']), 7)
        self.assertTrue(report['read_only'])
        self.assertFalse(report['authorizes_recovery'])
        for row in report['incidents']:
            self.assertFalse(row['authorized'])
            self.assertFalse(row['fresh_evidence_complete'])
            self.assertTrue(row['incident_record_hash'])
        self.assertEqual({p: (root / p).read_bytes() for p in paths}, before)


if __name__ == '__main__':
    unittest.main()
