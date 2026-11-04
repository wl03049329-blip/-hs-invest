import unittest,copy,math
from datetime import date,timedelta
from common import *
from simulator import *
from forensics import classify_frozen,incidents
def panel(n=150):
    return features([{'date':(date(2018,1,1)+timedelta(days=i)).isoformat(),'open':100.,'high':101.,'low':99.,'close':100.} for i in range(n)])
def model(entry='NEXT_OPEN_FULL',exit='TIME20'):return {'id':entry+'|'+exit,'entry':entry,'exit':exit}
def ev(p,idx=5):return [{'id':'EVENT:'+p[idx]['date'],'i':idx,'date':p[idx]['date'],'regime':'BULL','mature':idx+70<len(p),'velocity':5.,'dd20':-10.}]
def run(p=None,m=None):
    p=p or panel();return simulate(p,m or model(),ev(p))
class SafetyTests(unittest.TestCase):
    def test_grid(self):self.assertEqual(len({x['id'] for x in models()}),36)
    def test_predeclared_no_live(self):self.assertFalse(P['production']['writer']);self.assertFalse(P['production']['shadow_recovery'])
    def test_next_open(self):self.assertEqual(run()['trades'][0]['entry_i'],6)
    def test_no_same_bar(self):self.assertTrue(all(x['decision']<x['fill'] for x in run()['orders']))
    def test_all_fixed_horizons(self):
        for h in [5,10,20,40,60]:self.assertEqual(run(m=model(exit='TIME'+str(h)))['trades'][0]['held'],h)
    def test_no_confirm_no_trade_but_zero_mature_episode(self):
        r=run(m=model('CONFIRM_HIGH5_FULL'));self.assertFalse(r['trades']);self.assertEqual(r['event_outcomes'][0]['slot_return'],0)
    def test_confirm_then_next_open(self):
        p=panel();p[7]['close']=103;p[7]['high']=104
        self.assertEqual(run(p,model('CONFIRM_HIGH5_FULL'))['trades'][0]['entry_i'],8)
    def test_confirm_window_expires(self):
        p=panel();p[12]['close']=103;p[12]['high']=104
        self.assertFalse(run(p,model('CONFIRM_HIGH5_FULL'))['trades'])
    def test_half_not_full_before_add(self):self.assertLess(run(m=model('HALF_THEN_DOWN5'))['metrics']['max_exposure'],.051)
    def test_probe_quarter(self):self.assertLess(run(m=model('QUARTER_THEN_CONFIRM5'))['metrics']['max_exposure'],.026)
    def test_down_tranche_two_only(self):
        p=panel()
        for x in p[8:]:x.update({'open':94.,'close':94.,'high':95.,'low':93.})
        r=run(p,model('HALF_THEN_DOWN5'));self.assertEqual(r['trades'][0]['tranches'],2);self.assertEqual(sum(o['kind']=='ADD' for o in r['orders']),1)
    def test_confirmation_add(self):
        p=panel();p[8]['close']=103;p[8]['high']=104
        r=run(p,model('QUARTER_THEN_CONFIRM5'));self.assertEqual(r['trades'][0]['tranches'],2)
    def test_add_window_expires(self):
        p=panel();p[25]['close']=90;p[25]['low']=89
        self.assertEqual(run(p,model('HALF_THEN_DOWN5',exit='TIME60'))['trades'][0]['tranches'],1)
    def test_trim_next_open(self):
        p=panel()
        for x in p[8:]:x.update({'open':200.,'close':200.,'low':199.,'high':201.})
        r=run(p);tr=[x for x in r['orders'] if x['kind']=='TRIM'];self.assertTrue(tr);self.assertEqual(tr[0]['fill'],p[9]['date']);self.assertGreater(tr[0]['quantity'],0)
    def test_trim_not_free_money(self):
        p=panel()
        for x in p[8:]:x.update({'open':200.,'close':200.,'low':199.,'high':201.})
        r=run(p);self.assertAlmostEqual(r['metrics']['final_nav'],CAP+sum(t['pnl'] for t in r['trades']),6)
    def test_exit_before_add(self):
        p=panel();p[8]['close']=70;p[8]['low']=69
        r=run(p,model('HALF_THEN_DOWN5','RISK_STOP10_BEAR_MA10_MAX40'));self.assertEqual(r['trades'][0]['tranches'],1)
    def test_gap_not_filled_at_stop(self):
        p=panel();p[8]['close']=70;p[8]['low']=69;p[9].update({'open':50.,'low':49.})
        r=run(p,model(exit='RISK_STOP10_BEAR_MA10_MAX40'));self.assertLess(r['trades'][0]['net_return'],-.49)
    def test_cost_on_flat_market(self):self.assertLess(run()['trades'][0]['net_return'],0)
    def test_cash_conservation(self):
        r=run();self.assertAlmostEqual(r['metrics']['final_nav'],CAP+sum(x['pnl'] for x in r['trades']),6)
    def test_cash_not_negative(self):self.assertTrue(all(x['cash_after']>=0 for x in run()['orders']))
    def test_censor_not_completed(self):
        p=panel(15);r=run(p,model(exit='TIME60'));self.assertFalse(r['trades']);self.assertIsNotNone(r['open_position']);self.assertIsNone(r['event_outcomes'][0]['slot_return'])
    def test_future_data_cannot_change_past_orders(self):
        a=panel();b=copy.deepcopy(a);b[100].update({'open':200.,'close':200.,'high':201.,'low':199.})
        self.assertEqual(run(a)['orders'],run(b)['orders'])
    def test_time_stop(self):self.assertEqual(run(m=model(exit='TIME_STOP10_MAX40'))['trades'][0]['held'],10)
    def test_invalid_price(self):
        p=panel();p[5]['open']=float('nan')
        with self.assertRaises(AssertionError):run(p)
    def test_unknown_model(self):
        with self.assertRaises(AssertionError):run(m=model(exit='BAD'))
    def test_control_uses_prior_day_only(self):
        p=panel();src=[{'date':x['date'],'exposure':.1 if i>=5 else 0} for i,x in enumerate(p)];r=control(p,src)
        self.assertEqual(r['orders'][5]['target'],0);self.assertEqual(r['orders'][6]['target'],.1);self.assertTrue(all(x['decision'] is None or x['decision']<x['fill'] for x in r['orders']))
    def test_control_future_weight_not_used(self):
        p=panel();a=[{'date':x['date'],'exposure':0.} for x in p];b=copy.deepcopy(a);b[100]['exposure']=.1
        self.assertEqual(control(p,a)['curve'][:101],control(p,b)['curve'][:101])
    def test_dividends_not_reinvested_early(self):
        p=panel();p[8]['cash_dividend']=2.;r=control(p);self.assertGreater(r['metrics']['locked_dividend_receivable'],0)
    def test_precision_and_tick_distinguished(self):
        raw={'open':20.,'high':21.,'low':19.,'close':20.};small={**raw,'close':20.0001};tick={**raw,'close':20.01}
        self.assertEqual(classify_frozen(raw,small),'NUMERIC_PRECISION_ONLY');self.assertEqual(classify_frozen(raw,tick),'ONE_TICK_CLOSE_SOURCE_DIFFERENCE')
    def test_split_basis(self):
        raw={'open':22.,'high':23.,'low':21.,'close':22.};self.assertEqual(classify_frozen(raw,{k:v/22 for k,v in raw.items()}),'SPLIT_BASIS_ONLY')
    def test_incident_canonical_set_not_fixed_count(self):
        r=incidents();self.assertEqual(r['added'],[r['newest']['record_id']]);self.assertTrue(all(not x['authorized'] for x in r['rows']))
if __name__=='__main__':unittest.main()
