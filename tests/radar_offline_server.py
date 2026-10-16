"""Local interaction fixture, never a quote publisher. No upstream requests.

Run from the repository root; visit http://127.0.0.1:8877/?radarLayoutDebug=1
&scenario=complete (or partial / empty / quota). Saved source hashes are checked
against their existing provenance before serving. 'complete' means the complete
SAVED dataset, not H1 or current market coverage. The fixture date axis is the
union of actual saved price / FINALIZED dates, NOT an official exchange calendar.
"""
import hashlib
import json
import re
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, unquote

ROOT = Path(__file__).resolve().parents[1]
# Explicit read-only preview surface; never expose the repository directory tree.
# Remains localhost-only. LAN TLS/firewall/certificate setup requires user review.
HTML = (ROOT / 'index.html').read_text(encoding='utf-8')
STATIC_ALLOWED = {'/' + urlsplit(p).path for p in re.findall(r'(?:src|href)="([^"?#]+)(?:[?#][^"]*)?"', HTML)
                  if not urlsplit(p).scheme and Path(urlsplit(p).path).suffix in ('.js', '.css', '.png', '.svg', '.webmanifest')}
STATIC_ALLOWED |= {'/assets/icon-192-v3.png', '/assets/hs-etf-radar-final.png'}
STATIC_ALLOWED |= {'/' + p for p in (
    'build-info.json', 'etf-universe.json', 'etf-valuation.json', 'data/radar-history/status-v1.json',
    'finalized-core-score-snapshots-v1.json', 'intraday-core-snapshots-v1.json',
    'market-quotes.json', 'market-quotes-meta.json', 'cnn-fear-greed.json',
    'margin-data.json', 'futures-position.json', 'market-events.json', 'trump-news.json')}
STATIC_ALLOWED |= {f'/research/c4_historical/{s}.json' for s in ('0050','00662','00830','00935','009815')}

def allowed_static(path):
    decoded = unquote(path)
    candidate = (ROOT / decoded.lstrip('/')).resolve()
    return decoded in STATIC_ALLOWED and ROOT in candidate.parents and candidate.is_file()
SOURCES = {}
for symbol in ("0050", "00662", "00830", "00935", "009815"):
    p = json.loads((ROOT / f"research/c4_historical/source/{symbol}.json").read_text(encoding="utf-8"))
    meta = json.loads((ROOT / f"research/c4_historical/{symbol}.json").read_text(encoding="utf-8"))
    digest = hashlib.sha256(json.dumps(p, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    assert digest == meta["metadata"]["provenance"]["source_ohlc_sha256"], symbol
    SOURCES[symbol] = p
FINAL = json.loads((ROOT / "finalized-core-score-snapshots-v1.json").read_text(encoding="utf-8"))
ARCHIVES = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in (ROOT / "data/radar-history").glob("*/*.json")}
for symbol, p in ARCHIVES.items():
    content = {k: v for k, v in p.items() if k != "content_sha256"}
    assert hashlib.sha256(json.dumps(content, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest() == p["content_sha256"], symbol
DATES = sorted({r["date"] for p in [*SOURCES.values(), *ARCHIVES.values()] for r in p["price"]} | {s["date"] for s in FINAL["snapshots"] if s.get("finalized")})

BOOT = r"""<script>
// TEST SERVER INJECTION ONLY. Not imported by production HTML.
const fixtureScenario=new URLSearchParams(location.search).get('scenario')||'complete';
// Localhost-only deterministic fixture; never removes production-domain state.
localStorage.removeItem('hsRadar.history.sourceCooldown.v1');
const originalFetch=window.fetch.bind(window);
window.fetch=(input,options={})=>{
 const u=new URL(typeof input==='string'?input:input.url,location.href);
 if(u.origin===location.origin){
  if(u.pathname.startsWith('/research/c4_historical/source/')||u.pathname.startsWith('/data/radar-history/'))u.searchParams.set('scenario',fixtureScenario);
  return originalFetch(u,options);
 }
 if(u.hostname==='api.finmindtrade.com'&&u.searchParams.get('dataset')==='TaiwanStockTradingDate'&&fixtureScenario!=='quota')
   return originalFetch('/__fixture/calendar',options);
 return Promise.resolve(new Response(JSON.stringify({status:402,msg:'OFFLINE FIXTURE: upstream disabled',data:[]}),{status:402,headers:{'Content-Type':'application/json'}}));
};
window.addEventListener('error',e=>{document.documentElement.dataset.fixtureErrors=String(1+Number(document.documentElement.dataset.fixtureErrors||0));});
window.addEventListener('unhandledrejection',e=>{document.documentElement.dataset.fixtureRejections=String(1+Number(document.documentElement.dataset.fixtureRejections||0));});
window.addEventListener('DOMContentLoaded',()=>{const b=document.createElement('p');b.id='fixture-banner';b.textContent='離線真實保存資料驗收：'+fixtureScenario+'｜非最新行情／非官方完整交易日曆｜外部請求已封鎖';b.style.cssText='background:#352600;color:#fff;padding:8px;margin:0';document.body.prepend(b);});
// Test-only read-only evidence: no app globals, data mutation or network calls.
if(new URLSearchParams(location.search).get('radarLayoutDebug')==='1'){
 const shifts=[];let cls=0;
 try{new PerformanceObserver(list=>{for(const e of list.getEntries()){if(!e.hadRecentInput)cls+=e.value;shifts.push({at:e.startTime,value:e.value,recentInput:e.hadRecentInput,sources:e.sources?.map(s=>({node:s.node?.id||s.node?.className,previous:s.previousRect,current:s.currentRect}))});}if(shifts.length>20)shifts.splice(0,shifts.length-20);}).observe({type:'layout-shift',buffered:true});}catch{}
 setInterval(()=>{let pre=document.getElementById('fixture-metrics');if(!pre){pre=document.createElement('pre');pre.id='fixture-metrics';pre.hidden=true;document.body.append(pre);}pre.textContent=JSON.stringify({at:performance.now(),heap:performance.memory?.usedJSHeapSize||null,canvases:document.querySelectorAll('.signalCard.is-selected .radarHistoryCanvas canvas').length,chartTables:document.querySelectorAll('.radarHistoryCanvas table').length,cls,shifts});},1000);
}
</script>"""

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "connect-src 'self'; worker-src 'none'")
        super().end_headers()

    def payload(self, value, content_type="application/json"):
        data = value.encode() if isinstance(value, str) else json.dumps(value, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", content_type + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        from urllib.parse import parse_qs
        url = urlsplit(self.path)
        if any(part.startswith(".") for part in url.path.split("/") if part) or url.path.endswith("sw.js"):
            return self.send_error(404)
        if url.path in ("/", "/index.html"):
            return self.payload((ROOT / "index.html").read_text(encoding="utf-8").replace("<head>", "<head>" + BOOT, 1), "text/html")
        if url.path == "/__fixture/calendar":
            return self.payload({"status": 200, "data": [{"date": d} for d in DATES]})
        if re.fullmatch(r'/data/radar-history/(?:twse|tpex)/\d{4,6}\.json', url.path):
            symbol = Path(url.path).stem
            mode = parse_qs(url.query).get("scenario", ["complete"])[0]
            if symbol not in ARCHIVES or mode in ("partial", "empty", "quota"):
                return self.send_error(404)
            return self.payload(ARCHIVES[symbol])
        if re.fullmatch(r'/research/c4_historical/source/\d{4,6}\.json', url.path):
            symbol = Path(url.path).stem
            if symbol not in SOURCES:
                return self.send_error(404)
            mode = parse_qs(url.query).get("scenario", ["complete"])[0]
            p = dict(SOURCES[symbol])
            if mode == "empty":
                p["price"], p["dividend"] = [], []
            elif mode == "partial":
                # Remove real rows to test missing-data behavior, never invent bars.
                p["price"] = [r for i, r in enumerate(p["price"]) if i % 7 != 0]
            return self.payload(p)
        if not allowed_static(url.path):
            return self.send_error(404)
        self.headers.__delitem__("If-Modified-Since")
        return super().do_GET()

    def do_HEAD(self):
        # Base HEAD must not bypass our file allowlist or expose file metadata.
        return self.send_error(405)

if __name__ == "__main__":
    ThreadingHTTPServer.request_queue_size = 128
    print("Offline-only fixture on 127.0.0.1:8877; source provenance verified", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8877), Handler).serve_forever()
