import pathlib,subprocess,sys,time,json
from audit import ROOT,E,dump
directory=E/sys.argv[1];directory.mkdir(exist_ok=False);results=[]
for p in sorted((ROOT/'tests').glob('test*.js')):
    start=time.monotonic()
    try:
        r=subprocess.run([sys.argv[2],str(p)],cwd=ROOT,capture_output=True,text=True,encoding='utf8',errors='replace',timeout=120)
        code=r.returncode;log=r.stdout+'\n'+r.stderr
    except subprocess.TimeoutExpired as e:code=124;log=str(e)
    (directory/(p.stem+'.log')).write_text(log,encoding='utf8',newline='\n');results.append({'file':p.name,'exit_code':code,'seconds':time.monotonic()-start});dump(directory/'partial.json',results)
summary={'pass':sum(r['exit_code']==0 for r in results),'fail':sum(r['exit_code']!=0 for r in results),'skip':0,'results':results}
dump(directory/'results.json',summary);print(json.dumps({k:summary[k] for k in ['pass','fail','skip']}));sys.exit(bool(summary['fail']))
