"""Actual loopback HTTP verification; Actions Run receipt is TEST_ONLY simulated."""
import sys,pathlib,json,threading,http.server,urllib.request,functools
ROOT=pathlib.Path(__file__).resolve().parents[3];sys.path.insert(0,str(ROOT))
from scripts import lc4_research_release as r
site=pathlib.Path(sys.argv[1]).resolve();plan=r.d.read(sys.argv[2]);out=pathlib.Path(sys.argv[3])
class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(site)))
threading.Thread(target=server.serve_forever,daemon=True).start()
base='http://127.0.0.1:'+str(server.server_port)+'/'
def fetch(name):
    with urllib.request.urlopen(base+name,timeout=15) as response:return response.read()
try:
    receipt=json.loads(fetch('app-release.json'));commit=receipt['deployment_commit']
    runs=[{'head_sha':commit,'head_branch':'main','status':'completed','conclusion':'success'}]
    proof=r.verify_public(plan,commit,fetch,runs)
    proof.update(scope='ISOLATED_HTTP_REAL_BYTES_SIMULATED_ACTIONS_RUN',real_github_pages=False,remote_writes=0)
    r.d.atomic_json(out,proof);print(json.dumps(proof))
finally:server.shutdown();server.server_close()
