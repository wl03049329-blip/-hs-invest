"""Retain actual test output in Stage5, never overwrite old evidence."""
import sys,subprocess,re,json
from audit import ROOT,E,dump,sha
name=sys.argv[1];dest=E/(name+'.log');E.mkdir(exist_ok=True);assert not dest.exists(),'EVIDENCE_EXISTS'
p=subprocess.run(sys.argv[2:],cwd=ROOT,capture_output=True,text=True,encoding='utf8',errors='replace')
log=p.stdout+'\n'+p.stderr;dest.write_text(log,encoding='utf8',newline='\n')
n=re.search(r'Ran (\d+) tests?',log);counts={k:int(v) for k,v in re.findall(r'(failures|errors|skipped)=(\d+)',log)}
r={'exit_code':p.returncode,'log_sha256':sha(log.encode())}
if n:
    r.update(total=int(n[1]),fail=counts.get('failures',0)+counts.get('errors',0),skip=counts.get('skipped',0));r['pass']=r['total']-r['fail']-r['skip']
dump(E/(name+'.json'),r);print(json.dumps(r));sys.exit(p.returncode)
