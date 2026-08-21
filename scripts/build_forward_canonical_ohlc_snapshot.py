"""Build one immutable, research-only adjusted-OHLC snapshot strictly through T."""
from __future__ import annotations
import argparse, datetime as dt, hashlib, json, math, pathlib, urllib.parse, urllib.request

SCHEMA_VERSION=1
ADJUSTMENT_ALGORITHM_VERSION="ADJUSTED_OHLC_RATIO_V1"
REPAIR_MANIFEST_VERSION="0050_SPLIT_BASIS_REPAIR_V1"
UNIVERSE={"0050":"0050.TW","00662":"00662.TW","00830":"00830.TW","00935":"00935.TW"}
REPAIR={"0050_YAHOO_PRE_2014_SPLIT_BASIS":{"ticker":"0050","before_date":"2014-01-02","price_factor":0.25,"official_split_date":"2025-06-18","official_split_ratio":"1:4","reason":"verified Yahoo pre-2014 split-basis discontinuity"}}

def canonical(value): return json.dumps(value,ensure_ascii=False,separators=(",",":"),sort_keys=True).encode()
def digest(value): return hashlib.sha256(value if isinstance(value,bytes) else canonical(value)).hexdigest()
def producer_hash(): return digest(pathlib.Path(__file__).read_bytes())
def fetch(symbol):
    query=urllib.parse.urlencode({"period1":int(dt.datetime(2000,1,1,tzinfo=dt.timezone.utc).timestamp()),"period2":int((dt.datetime.now(dt.timezone.utc)+dt.timedelta(days=1)).timestamp()),"interval":"1d","events":"div,splits","includeAdjustedClose":"true"})
    url=f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?{query}"
    with urllib.request.urlopen(urllib.request.Request(url,headers={"User-Agent":"HS-ETF-Forward-Research/1.0"}),timeout=30) as response:
        raw=response.read(); return json.loads(raw)["chart"]["result"][0],{"url":url,"response_sha256":digest(raw),"response_date":response.headers.get("Date")}
def rows_from_chart(chart,ticker,cutoff):
    quote=chart["indicators"]["quote"][0]; adjusted=chart["indicators"]["adjclose"][0]["adjclose"]; rows=[]
    for i,timestamp in enumerate(chart["timestamp"]):
        date=dt.datetime.fromtimestamp(timestamp,dt.timezone.utc).date().isoformat()
        if date>cutoff: continue
        raw={key:quote.get(key,[None]*len(chart["timestamp"]))[i] for key in ("open","high","low","close","volume")}; adj=adjusted[i]
        if not all(isinstance(raw[k],(int,float)) and math.isfinite(raw[k]) for k in ("open","high","low","close")) or not isinstance(adj,(int,float)) or not math.isfinite(adj) or raw["close"]<=0: continue
        ratio=adj/raw["close"]; rows.append({"date":date,"open":round(raw["open"]*ratio,6),"high":round(raw["high"]*ratio,6),"low":round(raw["low"]*ratio,6),"close":round(adj,6),"volume":round(raw["volume"] or 0),"raw_close":round(raw["close"],6),"adjustment_factor":round(ratio,10)})
    repair=REPAIR["0050_YAHOO_PRE_2014_SPLIT_BASIS"]
    if ticker==repair["ticker"]:
        for row in rows:
            if row["date"]<repair["before_date"]:
                row["source_adjustment_factor"]=row["adjustment_factor"]
                for key in ("open","high","low","close"): row[key]=round(row[key]*repair["price_factor"],6)
                row["adjustment_factor"]=round(row["adjustment_factor"]*repair["price_factor"],10); row["source_repair_id"]="0050_YAHOO_PRE_2014_SPLIT_BASIS"
    return rows
def build(charts,cutoff,generated_at):
    items={}; provenance={}
    for ticker,symbol in UNIVERSE.items():
        chart,source=charts[ticker]; rows=rows_from_chart(chart,ticker,cutoff)
        if not rows or rows[-1]["date"]!=cutoff: raise ValueError(f"FAIL_CLOSED_MISSING_T:{ticker}:{cutoff}")
        items[ticker]={"symbol":symbol,"currency":chart.get("meta",{}).get("currency","TWD"),"exchange_timezone":chart.get("meta",{}).get("exchangeTimezoneName","Asia/Taipei"),"rows":rows}; provenance[ticker]=source
    dataset={"metadata":{"snapshot_schema_version":SCHEMA_VERSION,"trading_date":cutoff,"generated_at":generated_at,"source_name":"Yahoo Finance Chart API","price_basis":"Adjusted OHLC","adjustment_algorithm_version":ADJUSTMENT_ALGORITHM_VERSION,"repair_manifest_version":REPAIR_MANIFEST_VERSION,"repair_manifest":REPAIR,"source_open_zero_policy":"PRESERVE_SOURCE_NUMERIC_OPEN_ZERO_V1","no_index_proxy":True},"items":items}
    coverage={ticker:{"rows":len(item["rows"]),"start":item["rows"][0]["date"],"end":item["rows"][-1]["date"]} for ticker,item in items.items()}
    return dataset,{"snapshot_schema_version":SCHEMA_VERSION,"trading_date":cutoff,"generated_at":generated_at,"timezone":"Asia/Taipei","signal_policy":"STRICTLY_THROUGH_T_CLOSE","upstream_provider":"Yahoo Finance Chart API","upstream_endpoint_family":"query1.finance.yahoo.com/v8/finance/chart","etf_universe":list(UNIVERSE),"coverage":coverage,"producer_sha256":producer_hash(),"producer_schema_version":SCHEMA_VERSION,"adjustment_algorithm_version":ADJUSTMENT_ALGORITHM_VERSION,"repair_manifest_version":REPAIR_MANIFEST_VERSION,"repair_manifest":REPAIR,"source_provenance":provenance,"data_quality_status":"PASS","no_lookahead_validation":{"result":"PASS","rule":"all rows date <= trading_date"}}
def write_immutable(root,cutoff,dataset,manifest):
    directory=root/"research"/"forward-action-policy-data"/"snapshots"/cutoff; data_bytes=canonical(dataset); manifest={**manifest,"dataset_sha256":digest(data_bytes)}; manifest_bytes=canonical(manifest)
    if directory.exists():
        old=directory/"historical-adjusted.json"; old_manifest=directory/"manifest.json"
        if old.exists() and old_manifest.exists() and old.read_bytes()==data_bytes: return "NOOP_IDENTICAL",directory,digest(old_manifest.read_bytes())
        raise FileExistsError(f"FAIL_CLOSED_SNAPSHOT_CONFLICT:{directory}")
    directory.mkdir(parents=True); (directory/"historical-adjusted.json").write_bytes(data_bytes); (directory/"manifest.json").write_bytes(manifest_bytes); return "CREATED",directory,digest(manifest_bytes)
def main():
    parser=argparse.ArgumentParser(); parser.add_argument("--trading-date",required=True); parser.add_argument("--output-root",required=True); args=parser.parse_args(); dt.date.fromisoformat(args.trading_date)
    generated=dt.datetime.now(dt.timezone.utc).isoformat(); charts={ticker:fetch(symbol) for ticker,symbol in UNIVERSE.items()}; dataset,manifest=build(charts,args.trading_date,generated); status,directory,manifest_hash=write_immutable(pathlib.Path(args.output_root),args.trading_date,dataset,manifest); print(json.dumps({"status":status,"path":str(directory),"dataset_sha256":manifest["dataset_sha256"] if "dataset_sha256" in manifest else digest(canonical(dataset)),"manifest_sha256":manifest_hash}))
if __name__=="__main__": main()
