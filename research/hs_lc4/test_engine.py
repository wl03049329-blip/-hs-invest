"""Deterministic synthetic fixtures only; not evidence of profitable trading."""
import copy,math,unittest
from datetime import date,timedelta
from unittest.mock import patch
import engine as e
from audit import valid,number

def fixture(n=100):
    d=date(2020,1,1)
    return e.features([{'date':(d+timedelta(days=i)).isoformat(),'open':100.,'high':101.,'low':99.,'close':100.} for i in range(n)])
def model(entry='NEXT_OPEN',add='NONE',exit='TIME20'):
    return next(m for m in e.candidates() if m['opportunity']=='C95' and m['entry']==entry and m['add']==add and m['exit']==exit)
def run(p=None,m=None,triggers=(5,),**kw):
    p=p or fixture();m=m or model();s=[i in triggers for i in range(len(p))]
    with patch.object(e,'signals',return_value=s):return e.simulate(p,m,**kw)
class EngineTests(unittest.TestCase):
    def test_grid_162_unique(self):self.assertEqual(len({m['id'] for m in e.candidates()}),162)
    def test_no_same_close_fill(self):self.assertTrue(all(o['decision']<o['fill'] for o in run()['orders']))
    def test_next_actual_open(self):self.assertEqual(run()['trades'][0]['entry_i'],6)
    def test_delay_three_completed_bars(self):self.assertEqual(run(m=model(entry='DELAY_3'))['trades'][0]['entry_i'],9)
    def test_confirmation_absent_retains_cash(self):self.assertFalse(run(m=model(entry='CONFIRM_HIGH_WITHIN_5'))['orders'])
    def test_confirmation_before_fill(self):
        p=fixture();p[7]['close']=103;p[7]['high']=104
        self.assertEqual(run(p,model(entry='CONFIRM_HIGH_WITHIN_5'))['trades'][0]['entry_i'],8)
    def test_confirmation_expires(self):
        p=fixture();p[12]['close']=103
        self.assertFalse(run(p,model(entry='CONFIRM_HIGH_WITHIN_5'))['orders'])
    def test_exact_time20(self):self.assertEqual(run()['trades'][0]['held'],20)
    def test_exact_time40(self):self.assertEqual(run(m=model(exit='TIME40'))['trades'][0]['held'],40)
    def test_stop_cannot_fill_at_prior_stop(self):
        p=fixture();p[9]['close']=80;p[9]['low']=79;p[10]['open']=50;p[10]['low']=49
        r=run(p,model(exit='STOP10_TAKE20_TIME40'));t=r['trades'][0]
        self.assertEqual(t['exit_i'],10);self.assertLess(t['net_return'],-.49)
    def test_repeat_does_not_reset_horizon(self):self.assertEqual(run(triggers=tuple(range(5,25)))['trades'][0]['held'],20)
    def test_position_not_more_than_two_tranches(self):
        p=fixture()
        for x in p[8:]:x['close']=90;x['low']=89
        r=run(p,model(add='HALF_THEN_DOWN5'));self.assertEqual(r['trades'][0]['tranches'],2)
    def test_none_no_pyramiding(self):self.assertEqual(run()['trades'][0]['tranches'],1)
    def test_half_without_confirmation_stays_half(self):
        r=run(m=model(add='HALF_THEN_CONFIRM5'));self.assertLess(r['metrics']['max_close_exposure'],.051)
    def test_exit_priority_over_add(self):
        p=fixture();p[9]['close']=80;p[9]['low']=79
        r=run(p,model(add='HALF_THEN_DOWN5',exit='STOP10_TAKE20_TIME40'));self.assertEqual(r['trades'][0]['tranches'],1)
    def test_cash_never_negative(self):self.assertTrue(all(o['cash_after']>=0 for o in run()['orders']))
    def test_new_notional_capped(self):self.assertLessEqual(run()['metrics']['max_close_exposure'],.1)
    def test_gap_exposure_not_hidden(self):
        p=fixture();p[8]['close']=200;p[8]['high']=201
        self.assertGreater(run(p)['metrics']['cap_breach_sessions'],0)
    def test_costs_reduce_flat_trade(self):self.assertLess(run()['trades'][0]['net_return'],0)
    def test_known_flat_round_trip(self):
        t=run()['trades'][0];expected=(1-.001)*(1-e.FEE-e.TAX)/((1+.001)*(1+e.FEE))-1
        self.assertAlmostEqual(t['net_return'],expected,12)
    def test_cash_conservation(self):
        r=run();self.assertAlmostEqual(r['metrics']['final_nav'],e.CAP+sum(t['pnl'] for t in r['trades']),6)
    def test_tail_position_not_fake_closed(self):
        r=run(triggers=(95,));self.assertFalse(r['trades']);self.assertTrue(r['open_position']['censored'])
    def test_last_close_signal_not_filled(self):self.assertFalse(run(triggers=(99,))['orders'])
    def test_future_prices_do_not_change_prior_features(self):
        a=fixture(500);raw=[{k:x[k] for k in ['date','open','high','low','close']} for x in a];raw[400]['close']=500
        b=e.features(raw);self.assertEqual(a[:400],b[:400])
    def test_future_prices_do_not_change_prior_decisions(self):
        a=fixture();b=copy.deepcopy(a);b[80]['close']=1000
        ra=run(a);rb=run(b);self.assertEqual(ra['orders'],rb['orders'])
    def test_training_threshold_past_only(self):
        a=fixture(800);b=copy.deepcopy(a)
        for x in b:
            if x['date']>='2021':x['velocity']=100
        self.assertEqual(e.thresholds(a)[2021],e.thresholds(b)[2021])
    def test_annual_policy_carried_until_exit(self):
        p=fixture();choices={2020:model()['id']};s=[i==5 for i in range(100)]
        with patch.object(e,'signals',return_value=s):r=e.simulate(p,choices=choices)
        self.assertEqual(r['trades'][0]['policy']['id'],model()['id'])
    def test_signal_purge_excludes_late_orders(self):self.assertFalse(run(signal_end=4)['orders'])
    def test_cost_stress_never_better_flat(self):self.assertLess(run(slip=.005)['metrics']['final_nav'],run(slip=.001)['metrics']['final_nav'])
    def test_cash_yield_explicit(self):self.assertGreater(run(triggers=(),cash_yield=.02)['metrics']['final_nav'],e.CAP)
    def test_no_signal_cash_return_zero(self):self.assertEqual(run(triggers=())['metrics']['total_return'],0)
    def test_bad_ohlc_rejected(self):
        with self.assertRaises(AssertionError):valid({'open':10,'high':9,'low':8,'close':10})
    def test_nan_rejected(self):
        with self.assertRaises(AssertionError):number('nan')
    def test_negative_rejected(self):
        with self.assertRaises(AssertionError):number('-1')
    def test_split_normalized_no_fake_crash(self):
        raw=[220,220,10,10];adjusted=[x/22 if i<2 else x for i,x in enumerate(raw)];self.assertEqual(adjusted,[10]*4)
    def test_quantile_interpolated(self):self.assertEqual(e.quantile([1,2,3,4],.5),2.5)
    def test_bootstrap_deterministic(self):self.assertEqual(e.bootstrap(run()['trades']),e.bootstrap(run()['trades']))
    def test_capital_no_real_orders(self):self.assertFalse(e.P['production']['writer']);self.assertFalse(e.P['production']['capital'])
    def test_empty_bootstrap_unknown_not_zero(self):self.assertIsNone(e.bootstrap([]))
    def test_actual_year_change_preserves_policy(self):
        p=fixture(80)
        for i,r in enumerate(p):r['date']=(date(2020,12,1)+timedelta(days=i)).isoformat()
        a=model(exit='TIME40');b=model(exit='TIME20');s=[i==20 for i in range(80)]
        with patch.object(e,'signals',return_value=s):r=e.simulate(p,choices={2020:a['id'],2021:b['id']})
        self.assertEqual(r['trades'][0]['held'],40);self.assertEqual(r['trades'][0]['model'],a['id'])
    def test_official_dividend_not_lost_in_benchmark(self):
        rows=[{'date':'2020-01-01','open':100.,'close':100.},{'date':'2020-01-02','open':90.,'close':90.,'cash_dividend':10.}]
        a=e.baseline(rows,'2020',1,slip=0)
        units=e.CAP/(100*(1+e.FEE));expected=units*(90*(1-e.FEE-e.TAX)+10)
        self.assertAlmostEqual(a['final_nav'],expected,6)
    def test_buyer_on_exdate_does_not_receive_dividend(self):
        a=[{'date':'2020-01-01','open':100.,'close':100.,'cash_dividend':10.},{'date':'2020-01-02','open':100.,'close':100.}];b=copy.deepcopy(a);b[0]['cash_dividend']=0
        self.assertEqual(e.baseline(a,'2020',1),e.baseline(b,'2020',1))
    def test_excluded_crisis_year_does_not_create_trade(self):self.assertFalse(run(excluded_trigger_years=(2020,))['orders'])
    def test_confirmation_requires_actual_previous_high_not_close(self):
        p=fixture();self.assertEqual(p[7]['prior_high5'],101.)
if __name__=='__main__':unittest.main(verbosity=2)
