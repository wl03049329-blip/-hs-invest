import importlib.util, json, pathlib, tempfile, datetime as dt
spec=importlib.util.spec_from_file_location("producer",pathlib.Path(__file__).parents[1]/"scripts"/"build_forward_canonical_ohlc_snapshot.py"); p=importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
assert p.rows_from_chart({"timestamp":[1388448000],"indicators":{"quote":[{"open":[10.0],"high":[11.0],"low":[9.0],"close":[10.0],"volume":[1]}],"adjclose":[{"adjclose":[10.0]}]}},"0050","2013-12-31")[0]["close"]==2.5
def chart(): return {"timestamp":[int(dt.datetime(2026,8,10,tzinfo=dt.timezone.utc).timestamp())],"meta":{},"indicators":{"quote":[{"open":[10.0],"high":[11.0],"low":[9.0],"close":[10.0],"volume":[1]}],"adjclose":[{"adjclose":[10.0]}]}}
charts={ticker:(chart(),{}) for ticker in p.UNIVERSE}; commit="a"*40; data,manifest=p.build(charts,"2026-08-10","2026-08-10T13:30:00+00:00",commit); data2,manifest2=p.build(charts,"2026-08-10","2026-08-10T13:30:00+00:00",commit); assert manifest["producer_commit_sha"]==commit and p.canonical(data)==p.canonical(data2) and p.canonical(manifest)==p.canonical(manifest2)
try: p.build(charts,"2026-08-10","2026-08-10T13:30:00+00:00","bad"); raise AssertionError("malformed producer commit accepted")
except ValueError: pass
with tempfile.TemporaryDirectory() as root:
    status,directory,_=p.write_immutable(pathlib.Path(root),"2026-08-10",data,manifest); assert status=="CREATED"; assert p.write_immutable(pathlib.Path(root),"2026-08-10",data,manifest)[0]=="NOOP_IDENTICAL"; altered=json.loads(json.dumps(data)); altered["items"]["0050"]["rows"][0]["close"]=11
    try: p.write_immutable(pathlib.Path(root),"2026-08-10",altered,manifest); raise AssertionError("conflict accepted")
    except FileExistsError: pass
print("PASS forward canonical snapshot producer tests")
