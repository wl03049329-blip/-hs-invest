"""Run every existing JS suite, preserving each log and real exit code."""
import os,subprocess,sys,time,json
from protect import ROOT,EVIDENCE,dump
directory=EVIDENCE/sys.argv[1];directory.mkdir(exist_ok=False)
node=sys.argv[2];results=[]
for test in sorted((ROOT/'tests').glob('test*.js')):
    start=time.monotonic()
    try:
        p=subprocess.run([node,str(test)],cwd=ROOT,capture_output=True,text=True,encoding='utf8',errors='replace',timeout=120)
        log=p.stdout+'\n'+p.stderr;code=p.returncode
    except subprocess.TimeoutExpired as e:log=str(e);code=124
    (directory/(test.stem+'.log')).write_text(log,encoding='utf8')
    results.append({'file':test.name,'exit_code':code,'seconds':time.monotonic()-start})
    dump(directory/'partial.json',results)
summary={'pass':sum(r['exit_code']==0 for r in results),'fail':sum(r['exit_code']!=0 for r in results),'skip':0,'suites':results}
dump(directory/'results.json',summary);print(json.dumps({k:summary[k] for k in ('pass','fail','skip')}))
sys.exit(bool(summary['fail']))
