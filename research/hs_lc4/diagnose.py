"""Read-only capture of Shadow operational evidence; no recovery authorization."""
import argparse,pathlib,json,subprocess
from capture import ROOT,dump,sha,seal
def run(out):
    seal(out);fw=ROOT/'research/hs_leverage/forward'
    status=json.loads((fw/'daily-status.json').read_text(encoding='utf8'))
    p=subprocess.run(['gh','run','view','41860366624','--repo','wl03049329-blip/-hs-invest','--json','conclusion,jobs,headSha,createdAt'],capture_output=True,text=True,encoding='utf8');assert p.returncode==0;p=json.loads(p.stdout);dump(out/'shadow-run-41860366624.json',p)
    log=subprocess.run(['gh','run','view','41860366624','--repo','wl03049329-blip/-hs-invest','--log-failed'],capture_output=True,text=True,encoding='utf8');assert log.returncode==0
    (out/'shadow-run-41860366624.log').write_text(log.stdout,encoding='utf8')
    dump(out/'shadow-diagnosis.json',{'official_last_date':status['latest_data_date'],'frozen_reason':status['reason'],'review':status['diagnostics'],'current_failure_reason':status.get('current_failure_reason'),'github_test_count':212,'github_pass':211,'github_fail':1,'failed_assertion':'test_real_review_preparation_is_read_only_and_never_approval: actual8 incidents vs hardcoded7','daily_job':'SKIPPED_BY_FAILED_SAFETY_JOB','run':41860366624,'run_head':p['headSha'],'log_sha256':sha(log.stdout.encode()),'bridge_guard':'phase_l7_bridge.py requires identical already-published factor-one bridge provenance for a historical primary gap; new bridge cannot retroactively authorize history','production_recovery':'NOT_PERFORMED; exact-recovery window fixed to2026-10-16 and authenticated external approvals/pins required','research_only':'Official reconstructed copy is not a Forward ledger backfill or incident clearance'})
    seal(out);print('SHADOW_DIAGNOSIS_CAPTURED_NO_RECOVERY')
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);run(pathlib.Path(p.parse_args().out).resolve())
