import unittest,copy,math
from datetime import date,timedelta
from base import *
from analysis import *
def rows(n=300):return [{'date':(date(2014,1,1)+timedelta(days=i)).isoformat(),'open':100.,'high':101.,'low':99.,'close':100.,'cash_dividend':0.} for i in range(n)]
def event(i=20):return {'id':'FIXTURE','i':i,'date':'2014-01-21','mature':True}
class Tests(unittest.TestCase):
    def test_source_rows_verified(self):
        out=ROOT.parent/'hs-lc4-stage3-evidence';r=load(out/'data-review.json');self.assertEqual(r['conflict_dates'],222);self.assertEqual(r['missing_dates'],14);self.assertTrue(r['same_values_as_prior_repaired_copy'])
    def test_duplicate_split_not_applied(self):
        out=ROOT.parent/'hs-lc4-stage3-evidence';a=load(out/'research-copy-00631L.json')['rows'];b=load(P1/'adjusted-00631L.json')['rows'];self.assertEqual([r['close'] for r in a],[r['close'] for r in b])
    def test_dd120_insufficient(self):self.assertIsNone(radar_features(rows(119))[-1]['dd120'])
    def test_dd240_insufficient(self):self.assertIsNone(radar_features(rows(239))[-1]['dd240'])
    def test_dd_window_includes_current_not_old_peak(self):
        r=rows();r[0]['close']=1000.;p=radar_features(r);self.assertEqual(p[-1]['dd120'],0);self.assertEqual(p[-1]['dd240'],0)
    def test_dd_known(self):
        r=rows();r[-1]['close']=80.;self.assertAlmostEqual(radar_features(r)[-1]['dd120'],-.2)
    def test_five_day_velocity(self):
        r=rows();r[-1]['close']=80.;p=radar_features(r);self.assertAlmostEqual(p[-1]['return5'],-.2);self.assertAlmostEqual(p[-1]['velocity'],4.)
    def test_percentile_unknown_not_zero(self):self.assertIsNone(empirical_rank(1,[]));self.assertIsNone(empirical_rank(None,[1,2]))
    def test_percentile_ties(self):self.assertEqual(empirical_rank(2,[1,2,2,3]),50)
    def test_market_dividend_does_not_fake_downtrend(self):
        r=rows(2);r[1]['close']=90.;r[1]['cash_dividend']=10.;m=market_panel(r);self.assertEqual(list(m.values())[0]['index'],list(m.values())[1]['index'])
    def test_market_needs205_sessions(self):self.assertEqual(list(market_panel(rows(204)).values())[-1]['regime'],'UNKNOWN')
    def test_market_bull(self):
        r=rows()
        for i,x in enumerate(r):x['close']=100+i
        self.assertEqual(list(market_panel(r).values())[-1]['regime'],'BULL')
    def test_market_bear(self):
        r=rows()
        for i,x in enumerate(r):x['close']=500-i
        self.assertEqual(list(market_panel(r).values())[-1]['regime'],'BEAR')
    def test_market_range(self):self.assertEqual(list(market_panel(rows()).values())[-1]['regime'],'RANGE')
    def test_market_no_forward_filled_absent_dates(self):
        r=rows(300);missing=r.pop(220)['date'];self.assertNotIn(missing,market_panel(r))
    def test_prefix_features_no_future(self):
        r=rows();p=radar_features(r);r[-1]['close']=10.;q=radar_features(r);self.assertEqual(p[:-1],q[:-1])
    def test_market_prefix_no_future(self):
        r=rows();p=market_panel(r);r[-1]['close']=10.;q=market_panel(r);self.assertEqual(list(p.values())[:-1],list(q.values())[:-1])
    def test_path_close_vs_executable_return_separated(self):
        p=rows();p[21]['open']=110.
        for x in p[21:27]:x['close']=105.;x['high']=111.
        p[26]['open']=105.;a=path(p,event(),5);self.assertGreater(a['close_return'],0);self.assertLess(a['net_next_open_return'],0)
    def test_path_flat_costs_not_free_return(self):a=path(rows(),event(),5);self.assertEqual(a['close_return'],0);self.assertLess(a['net_next_open_return'],0)
    def test_horizon_exact(self):a=path(rows(),event(),5);self.assertEqual(a['path_end'],rows()[25]['date']);self.assertEqual(a['entry_open_date'],rows()[21]['date']);self.assertEqual(a['exit_open_date'],rows()[26]['date'])
    def test_future_high_not_executable_price(self):
        p=rows();a=path(p,event(),5);p[23]['high']=10000.;b=path(p,event(),5);self.assertEqual(a['net_next_open_return'],b['net_next_open_return']);self.assertGreater(b['max_high_vs_entry'],a['max_high_vs_entry'])
    def test_break_reference_is_trigger_low(self):
        p=rows();p[20]['low']=90.;p[23]['low']=89.;a=path(p,event(),5);self.assertEqual(a['further_break'],1);self.assertAlmostEqual(a['further_break_depth'],89/90-1)
    def test_no_break_is_not_zero_price(self):a=path(rows(),event(),5);self.assertEqual(a['further_break'],0);self.assertEqual(a['further_break_depth'],0);self.assertEqual(a['min_low'],99.)
    def test_no_recovery_case(self):
        p=rows()
        for x in p[21:26]:x['close']=90.;x['high']=95.
        self.assertEqual(path(p,event(),5)['never_recovered_trigger_close'],1)
    def test_incomplete_path_pending(self):self.assertEqual(path(rows(24),event(),5)['status'],'PENDING_INCOMPLETE_PATH')
    def test_exit_open_pending_not_filled_with_close(self):a=path(rows(26),event(),5);self.assertEqual(a['status'],'PATH_COMPLETE_EXIT_OPEN_PENDING');self.assertIsNone(a['net_next_open_return'])
    def test_zero_sample_unknown(self):self.assertIsNone(distribution([],'x')['mean']);self.assertIsNone(frequency([],'x')['historical_fraction'])
    def test_wilson_zero_occurrences_not_zero_risk(self):self.assertGreater(wilson(0,14)[1],0)
    def test_wilson_all_occurrences_not_certainty(self):self.assertLess(wilson(14,14)[0],1)
    def test_snapshot_no_authorization_score(self):
        s=load(ROOT.parent/'hs-lc4-stage3-evidence/radar-snapshot.json');self.assertFalse(s['entry']['authorized']);self.assertFalse(s['writer']);self.assertIsNone(s['score']);self.assertIsNone(s['predictive_probability'])
    def test_training_excludes_snapshot_year(self):
        s=load(ROOT.parent/'hs-lc4-stage3-evidence/radar-snapshot.json');self.assertLess(s['training_end'][:4],s['asof'][:4])
    def test_ui_no_external_or_financial_apis(self):
        from prototype import TEMPLATE
        for x in ['fetch(', 'XMLHttpRequest','localStorage.','indexedDB.','serviceWorker.register','https://']:self.assertNotIn(x,TEMPLATE)
        self.assertIn("connect-src 'none'",TEMPLATE);self.assertIn('進場資格：尚未核准',TEMPLATE)
    def test_same_fixed_events(self):
        paths=load(ROOT.parent/'hs-lc4-stage3-evidence/event-paths.json');self.assertEqual({r['event'] for r in paths},{r['id'] for r in load(P2/'events.json')});self.assertEqual(len(paths),75)
    def test_common_horizon_denominator(self):
        d=load(ROOT.parent/'hs-lc4-stage3-evidence/distributions.json');self.assertTrue(all(r['common_mature']['close_return']['n']==14 for r in d.values()))
    def test_ui_state_not_live_or_shadow_approved(self):
        s=load(ROOT.parent/'hs-lc4-stage3-evidence/radar-snapshot.json');self.assertTrue(s['not_live']);self.assertEqual(s['data']['formal_shadow'],'FAIL_CLOSED_UNCHANGED')
if __name__=='__main__':unittest.main()
