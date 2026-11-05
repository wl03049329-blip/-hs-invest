"""Isolated public-market fixtures; no personal financial data or network."""
import copy, datetime as dt, gzip, json, pathlib, shutil, sys, tempfile, unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from scripts import lc4_research_daily as daily

class ResearchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.history=daily.load_history(ROOT)
        cls.sources=json.loads(gzip.decompress((ROOT/daily.DIR/'seed-sources.json.gz').read_bytes()))
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=pathlib.Path(self.tmp.name)
        shutil.copytree(ROOT/daily.DIR,self.root/daily.DIR)
        self.history=copy.deepcopy(type(self).history)
    def client(self,mutate=None):
        sources=self.sources
        class Fixture:
            entries={}
            def get(self,url):
                symbol='00631L' if 'stockNo=00631L' in url else '0050'
                payload=copy.deepcopy(sources[f'twse-{symbol}-202611.json']['payload'])
                if mutate:mutate(payload,symbol)
                return {'payload':payload}
        return Fixture()
    def extend(self,client,target='2026-11-04'):
        with patch.object(daily,'official_sessions',return_value=(['2026-11-02','2026-11-03','2026-11-04'],{})),patch.object(daily,'twse_actions',return_value=([],[],None)):
            return daily.extend(self.history,client,target)
    def test_seed_hashes_and_history_integrity(self):
        for symbol,n in [('00631L',2924),('0050',2923)]:
            self.assertEqual(len(self.history['histories'][symbol]),n)
            daily.validate_rows(self.history['histories'][symbol])
    def test_noop_overlap_is_byte_identical(self):self.assertEqual(self.extend(self.client()),self.history)
    def test_conflicting_official_close_rejected(self):
        with self.assertRaisesRegex(ValueError,'OVERLAP_CONFLICT'):
            self.extend(self.client(lambda p,s:p['data'][-1].__setitem__(6,'30.84')))
    def test_unreviewed_split_rejected(self):
        with self.assertRaisesRegex(ValueError,'UNREVIEWED_SPLIT'):
            self.extend(self.client(lambda p,s:p['data'][-1].__setitem__(9,'**')))
    def test_missing_anchor_rejected(self):
        def remove(p,s):p['data'].pop();p['total']-=1
        with self.assertRaisesRegex(ValueError,'ANCHOR_MISSING'):self.extend(self.client(remove))
    def test_wrong_symbol_rejected(self):
        with self.assertRaisesRegex(ValueError,'SYMBOL_MISMATCH'):
            self.extend(self.client(lambda p,s:p.__setitem__('title','00000 invalid')))
    def test_target_rollback_rejected(self):
        with self.assertRaisesRegex(ValueError,'ROLLBACK'):self.extend(self.client(),'2026-11-03')
    def test_missing_session_rejected(self):
        with patch.object(daily,'official_sessions',return_value=(['2026-11-05'],{})):
            with self.assertRaisesRegex(ValueError,'MISSING_OR_EXTRA_SESSION'):
                daily.extend(self.history,self.client(),'2026-11-05')
    def test_verified_append_both_symbols_without_rewriting_anchor(self):
        def append(p,s):
            row=p['data'][-1].copy();row[0]='115/11/05';p['data'].append(row);p['total']+=1
        original=copy.deepcopy(self.history)
        with patch.object(daily,'official_sessions',return_value=(['2026-11-04','2026-11-05'],{})),patch.object(daily,'twse_actions',return_value=([],[],None)):
            new=daily.extend(self.history,self.client(append),'2026-11-05')
        self.assertEqual(new['asof'],'2026-11-05');self.assertEqual(self.history,original)
        for s in ('00631L','0050'):
            self.assertEqual(new['histories'][s][:-1],original['histories'][s]);self.assertEqual(new['histories'][s][-1]['date'],'2026-11-05')
    def test_new_cash_action_on_leverage_requires_review(self):
        with patch.object(daily,'official_sessions',return_value=([],{})),patch.object(daily,'twse_actions',return_value=([{'date':'2026-11-04','amount':1}],[],None)):
            with self.assertRaisesRegex(ValueError,'ACTION_REQUIRES_REVIEW'):daily.extend(self.history,self.client(),'2026-11-04')
    def test_source_failure_preserves_last_verified_pointer(self):
        before=(self.root/daily.DIR/'latest.json').read_bytes()
        class Offline:
            def get(self,url):raise OSError('fixture network unavailable')
        with self.assertRaises(OSError):daily.extend(self.history,Offline(),'2026-11-05')
        self.assertEqual((self.root/daily.DIR/'latest.json').read_bytes(),before)
    def test_corrupt_pointer_rejected_without_reset(self):
        p=self.root/daily.DIR/'latest.json';old=p.read_bytes();x=json.loads(old);x['sha256']='0'*64;p.write_bytes(daily.encoded(x))
        with self.assertRaisesRegex(ValueError,'BUNDLE_HASH'):daily.load_history(self.root)
        self.assertEqual(json.loads(p.read_bytes())['sha256'],'0'*64)
    def test_traversal_pointer_rejected(self):
        p=self.root/daily.DIR/'latest.json';x=json.loads(p.read_bytes());x['path']='snapshots/../../index.html';p.write_bytes(daily.encoded(x))
        with self.assertRaisesRegex(ValueError,'BUNDLE_PATH'):daily.load_history(self.root)
    def test_fixed_events_and_authorization_stay_separate(self):
        r=daily.describe(self.history);self.assertEqual(r['fixed_event_count'],15)
        self.assertFalse(r['radar']['entry']['authorized']);self.assertIsNone(r['radar']['score']);self.assertFalse(r['radar']['writer'])
        self.assertEqual(r['radar']['data']['formal_shadow'],'FAIL_CLOSED')
        self.assertEqual(r['radar']['data']['canonical_incidents'],8)
        for h,count,n in [('5',10,15),('10',11,15),('20',11,14)]:
            # Stage3 available-case denominators (not its common-mature14).
            x=r['risk'][h];self.assertEqual(x['n'],n);self.assertGreaterEqual(x['further_break_count'],count)
            self.assertTrue(x['not_a_forecast']);self.assertEqual(len(x['mae_values']),n)
    def test_publish_is_idempotent(self):
        class Fixture:entries={}
        before=(self.root/daily.DIR/'latest.json').read_bytes()
        result=daily.publish(self.root,self.history,Fixture(),dt.datetime.now(dt.timezone.utc),{})
        self.assertEqual(result['status'],'NOOP');self.assertEqual(before,(self.root/daily.DIR/'latest.json').read_bytes())
    def test_atomic_pointer_failure_retains_previous_bundle(self):
        class Fixture:entries={}
        before=(self.root/daily.DIR/'latest.json').read_bytes()
        altered=copy.deepcopy(self.history);altered['test_only_revision']='isolated fixture'
        with patch.object(daily,'atomic_json',side_effect=OSError('isolated pointer failure')):
            with self.assertRaises(OSError):daily.publish(self.root,altered,Fixture(),dt.datetime.now(dt.timezone.utc),{})
        self.assertEqual(before,(self.root/daily.DIR/'latest.json').read_bytes())
        self.assertEqual(daily.load_history(self.root),self.history)
    def test_calendar_boundaries_use_existing_eighteen_hour_policy(self):
        calendar=self.sources['calendar.json']['payload']
        class Fixture:
            def get(self,url):return {'url':url,'payload':calendar,'sha256':daily.digest(calendar),'fetched_at':'2026-11-05T00:00:00Z'}
        for clock,target in [('2026-11-05T00:53:00+08:00','2026-11-04'),('2026-11-05T17:59:00+08:00','2026-11-04'),('2026-11-05T18:00:00+08:00','2026-11-05'),('2026-11-07T18:00:00+08:00','2026-11-06'),('2026-10-10T18:00:00+08:00','2026-10-08')]:
            self.assertEqual(daily.research_expected_day(Fixture(),dt.datetime.fromisoformat(clock))[0],target)
        with self.assertRaisesRegex(ValueError,'CALENDAR_COVERAGE'):
            daily.research_expected_day(Fixture(),dt.datetime.fromisoformat('2027-01-05T18:00:00+08:00'))
    def test_same_day_corrupt_history_fails(self):
        rows=copy.deepcopy(self.history['histories']['00631L']);rows[-1]['close']=float('nan')
        with self.assertRaisesRegex(ValueError,'HISTORY_OHLC'):daily.validate_rows(rows)
    def test_competing_cli_run_does_not_steal_lock(self):
        lock=self.root/daily.DIR/'.update.lock';lock.write_text('owned by another isolated process')
        with patch.object(daily,'ROOT',self.root),patch.object(sys,'argv',['lc4_research_daily.py','--evidence',str(self.root.parent/'unused-evidence')]),patch.object(daily,'update') as update:
            with self.assertRaises(FileExistsError):daily.main()
            update.assert_not_called()
        self.assertEqual(lock.read_text(),'owned by another isolated process')
    def test_read_only_root_integration_preserves_original_signal(self):
        html=(ROOT/'index.html').read_text(encoding='utf8');self.assertIn('id="homeLeverageCard"',html)
        self.assertEqual(html.count('data-lc4-research-open'),2)
        js=(ROOT/'lc4-research.js').read_text(encoding='utf8')
        for forbidden in ['localStorage','indexedDB','sessionStorage','HSLeverage','execute(']:self.assertNotIn(forbidden,js)

if __name__=='__main__':unittest.main()
