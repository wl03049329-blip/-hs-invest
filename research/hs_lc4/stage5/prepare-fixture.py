"""Package five already-verified PUBLIC responses for offline pipeline tests."""
import pathlib,json,sys,hashlib
ROOT=pathlib.Path(__file__).resolve().parents[3]
source=ROOT.parent/'hs-lc4-stage4-evidence/live-official-20261105'
entries=[]
for p in sorted(source.glob('*.json')):
    e=json.loads(p.read_text(encoding='utf8'))
    raw=json.dumps(e['payload'],sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()
    assert hashlib.sha256(raw).hexdigest()==e['sha256']
    assert e['url'].startswith(('https://www.twse.com.tw/','https://openapi.twse.com.tw/'))
    entries.append(e)
assert len(entries)==5
dest=ROOT/'tests/fixtures/lc4-research/official-20261104.json';assert not dest.exists()
dest.parent.mkdir(parents=True,exist_ok=True)
dest.write_text(json.dumps({'schema':'PUBLIC_RECORDED_SOURCE_FIXTURE_NOT_LIVE','entries':entries},ensure_ascii=False,indent=2)+'\n',encoding='utf8',newline='\n')
print(json.dumps({'public_receipts':len(entries),'bytes':dest.stat().st_size,'sha256':hashlib.sha256(dest.read_bytes()).hexdigest()}))
