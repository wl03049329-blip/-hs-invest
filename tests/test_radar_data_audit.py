"""Offline contract tests. Synthetic rows are test-only and never published."""
import copy
import unittest
from scripts.audit_radar_calendar import FIELDS, parse_market
from scripts.audit_radar_tpex import MONTH_FIELDS, daily, monthly, verified_archive

class RadarAuditTests(unittest.TestCase):
    def setUp(self):
        self.month={'stat':'ok','tables':[{'date':'20261001','subtitle':'009815 大華','fields':MONTH_FIELDS,'totalCount':1,'data':[['115/10/13','1,659','100','12.16','12.20','12.13','12.20','0.1','100']]}]}
        self.row=monthly(self.month,'202610')['2026-10-13']
        self.day={'stat':'ok','date':'20261013','tables':[{'fields':['代號','開盤','最高','最低','收盤','成交股數'],'data':[['009815','12.16','12.20','12.13','12.20','1,658,941']]}]}

    def test_exact_shares_not_rounded_lots(self):
        r=daily(self.day,'2026-10-13',self.row)
        self.assertEqual(r['Trading_Volume'],1658941)
        self.assertNotEqual(r['Trading_Volume'],self.row['displayed_lots']*1000)

    def test_reject_missing_fractional_or_zero_share_count(self):
        for v in [None,'--','0','1.2','NaN']:
            p=copy.deepcopy(self.day);p['tables'][0]['data'][0][5]=v
            with self.assertRaises(ValueError):daily(p,'2026-10-13',self.row)

    def test_price_or_volume_conflict_rejected(self):
        for index,v in [(1,'12.17'),(5,'1,800,000')]:
            p=copy.deepcopy(self.day);p['tables'][0]['data'][0][index]=v
            with self.assertRaises(ValueError):daily(p,'2026-10-13',self.row)

    def test_wrong_symbol_date_or_duplicate_rejected(self):
        for p in [dict(self.day,date='20261012'),dict(self.day,stat='quota')]:
            with self.assertRaises(ValueError):daily(p,'2026-10-13',self.row)
        for symbol in ['0050','']:
            p=copy.deepcopy(self.day);p['tables'][0]['data'][0][0]=symbol
            with self.assertRaises(ValueError):daily(p,'2026-10-13',self.row)
        p=copy.deepcopy(self.day);p['tables'][0]['data']*=2
        with self.assertRaises(ValueError):daily(p,'2026-10-13',self.row)

    def test_month_schema_and_duplicate_rejected(self):
        p=copy.deepcopy(self.month);p['tables'][0]['data']*=2;p['tables'][0]['totalCount']=2
        with self.assertRaises(ValueError):monthly(p,'202610')
        with self.assertRaises(ValueError):monthly(self.month,'202609')

    def test_calendar_uses_observed_sessions_not_weekdays(self):
        p={'stat':'OK','date':'20030601','fields':FIELDS,'data':[[' 92/06/07','100','1','1','1','0'],[' 92/06/09','100','1','1','1','0']]}
        self.assertEqual(parse_market(p,'200306','2003-06-09'),['2003-06-07','2003-06-09'])
        self.assertEqual(parse_market(p,'200306','2003-06-08'),['2003-06-07'])
        p['data']*=2
        with self.assertRaises(ValueError):parse_market(p,'200306','2003-06-09')

    def test_calendar_bad_source_never_synthesizes_dates(self):
        for p in [{'stat':'quota'}, {'stat':'OK','date':'20030601','fields':FIELDS,'data':[]}]:
            with self.assertRaises(ValueError):parse_market(p,'200306','2003-06-30')

    def test_promotion_requires_all_actions_overlap_and_sessions(self):
        seed={'price':[dict(date='2026-10-12')],'dividend':[]}
        report={'symbol':'009815','as_of':'2026-10-13','price':[daily(self.day,'2026-10-13',self.row)],'overlap':{'count':1,'volume_differences':[]},'sessions':['2026-10-12','2026-10-13'],'actions':[{'source':s,'matches':[],'sha256':'a'*64} for s in ('exDailyQ','etfSplitRslt','etfRvsRslt','revivt','pvChgRslt')],'evidence':[{'fetched_at':'2026-10-14T00:00:00Z'}]}
        a=verified_archive(report,seed)
        self.assertEqual(a['price'][0]['Trading_Volume'],1658941)
        self.assertEqual(a['provider'],'TPEx/dailyQuotes')
        for kind in ('event','missing_check','volume','session'):
            p=copy.deepcopy(report)
            if kind=='event':p['actions'][0]['matches']=[['unreviewed']]
            elif kind=='missing_check':p['actions'].pop()
            elif kind=='volume':p['overlap']['volume_differences']=[{'difference':1}]
            else:p['sessions'].append('2026-10-09')
            with self.assertRaises(ValueError):verified_archive(p,seed)

if __name__=='__main__':unittest.main()
