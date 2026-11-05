"""Independent arithmetic oracle, not another selection/strategy experiment."""
import unittest,json,pathlib,subprocess,statistics,os
ROOT=pathlib.Path(__file__).resolve().parents[1]
class Oracle(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  p=json.loads((ROOT/'data/lc4-research/latest.json').read_text(encoding='utf8'));cls.b=json.loads((ROOT/'data/lc4-research'/p['path']).read_text(encoding='utf8'));cls.rows=cls.b['history']['histories']['00631L']
  cls.actual=json.loads(subprocess.check_output([os.environ.get('HS_NODE','node'),'-e',"const fs=require('fs'),c=require('./lc4-radar-core.js'),p=JSON.parse(fs.readFileSync('data/lc4-research/latest.json')),b=JSON.parse(fs.readFileSync('data/lc4-research/'+p.path));console.log(JSON.stringify(c.describe(b.history)));"],cwd=ROOT,text=True))
 def paths(self,h):
  result=[]
  for e in self.b['history']['fixed_events']:
   i=next(i for i,r in enumerate(self.rows) if r['date']==e['date'])
   if i+h>=len(self.rows):continue
   start=self.rows[i];after=self.rows[i+1:i+h+1];hi=max(r['high'] for r in after);lo=min(r['low'] for r in after)
   result.append(dict(date=e['date'],end=after[-1]['close']/start['close']-1,high=hi/start['close']-1,low=min(0,lo/start['close']-1),break_low=lo<start['low'],peak=next(j+1 for j,r in enumerate(after) if r['high']==hi)))
  return result
 def test_all_45_event_endpoint_and_risk_definitions(self):
  for h in (5,10,20):
   ps=self.paths(h);x=self.actual['horizons'][str(h)];self.assertEqual(x['n'],len(ps));self.assertEqual(x['pending'],15-len(ps))
   for p,a in zip(ps,x['paths']):
    self.assertEqual(p['date'],a['date']);self.assertAlmostEqual(p['end'],a['endReturn'],14);self.assertAlmostEqual(p['high'],a['highReturn'],14);self.assertAlmostEqual(p['low'],a['mae'],14);self.assertEqual(p['break_low'],a['breakLow']);self.assertEqual(p['peak'],a['peakDay'])
 def test_numerators_and_medians(self):
  for h in (5,10,20):
   ps=self.paths(h);x=self.actual['horizons'][str(h)];self.assertEqual(x['up'],sum(p['end']>0 for p in ps));self.assertEqual(x['breakLow'],sum(p['break_low'] for p in ps))
   for k,a in [('end','endMedian'),('high','highMedian'),('low','maeMedian')]:self.assertAlmostEqual(statistics.median(p[k] for p in ps),x[a],14)
   for pct in (5,10,15):self.assertEqual(x['touch'][str(pct)]['count'],sum(p['high']>=pct/100 for p in ps))
 def test_peak_same_complete_twenty_day_population(self):
  ps=self.paths(20);self.assertEqual(self.actual['peak20']['counts'],[sum(1<=p['peak']<=5 for p in ps),sum(6<=p['peak']<=10 for p in ps),sum(11<=p['peak']<=20 for p in ps)])
 def test_year_strata_sum_to_population(self):
  for h in (5,10,20):
   for y in self.actual['byYear']:
    ps=[p for p in self.paths(h) if p['date'].startswith(y)];a=self.actual['byYear'][y]['horizons'][str(h)];self.assertEqual(a['n'],len(ps));self.assertEqual(a['up'],sum(p['end']>0 for p in ps))
 def test_split_seam_is_existing_audited_adjusted_rows(self):
  self.assertEqual(self.rows[0]['close'],20.2/22)
  # Seed prefix cannot change; official research adapter validates source actions.
  import sys;sys.path.insert(0,str(ROOT));from scripts.lc4_research_daily import load_history
  self.assertEqual(load_history(ROOT)['histories']['00631L'],self.rows)
if __name__=='__main__':unittest.main()
