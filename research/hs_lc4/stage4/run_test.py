import pathlib,sys,subprocess,json,re
from protect import EVIDENCE,ROOT,dump,sha
name=sys.argv[1];args=sys.argv[2:];p=subprocess.run(args,cwd=ROOT,capture_output=True,text=True,encoding='utf8',errors='replace');log=p.stdout+'\n'+p.stderr
dest=EVIDENCE/(name+'.log');assert not dest.exists(),'DO_NOT_OVERWRITE_TEST_EVIDENCE';dest.write_text(log,encoding='utf8');n=re.search(r'Ran (\d+) tests?',log);details=re.search(r'(?:FAILED|OK) \(([^)]+)\)',log);counts={k:int(v) for k,v in re.findall(r'(failures|errors|skipped)=(\d+)',details[1])} if details else {}
r={'exit_code':p.returncode,'log_sha256':sha(log.encode())}
if n:r.update(total=int(n[1]),fail=counts.get('failures',0)+counts.get('errors',0),skip=counts.get('skipped',0));r['pass']=r['total']-r['fail']-r['skip']
dump(EVIDENCE/(name+'.json'),r);print(json.dumps(r));sys.exit(p.returncode)
