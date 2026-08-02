import importlib.util
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "update_etf_valuation", ROOT / "scripts" / "update_etf_valuation.py"
)
module = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(module)

assert module.number(-5, minimum=0.000001, maximum=300) is None
assert module.number(0, minimum=0.000001, maximum=300) is None
assert module.number(float("inf")) is None
assert module.number("66.35", minimum=0.000001, maximum=300) == 66.35

score, coverage = module.valuation_score(
    {
        "current_pe": 51.891877,
        "forward_pe": 29.070746,
        "pb": 13.62833,
        "earnings_growth": 78.502,
        "peg": 0.661,
        "pe_percentile": None,
        "forward_pe_percentile": None,
    }
)
assert isinstance(score, int) and 0 <= score <= 100
assert coverage == 75

proxy_map = json.loads((ROOT / "valuation-proxy-map.json").read_text(encoding="utf-8"))
assert set(proxy_map["items"]) == {"0050", "00830", "00662", "009815", "00935"}
item = proxy_map["items"]["00830"]
assert item["benchmark"] == "PHLX Semiconductor Sector Index"
assert item["primary_proxy"] == "SOXQ"
assert item["primary_source"]["benchmark"] == "PHLX Semiconductor Sector Index"
assert item["secondary_proxy"] == "SOXX"
assert item["secondary_source"]["benchmark"] == "NYSE Semiconductor Index"

valuation = json.loads((ROOT / "etf-valuation.json").read_text(encoding="utf-8"))
value = valuation["items"]["00830"]
assert value["is_proxy"] is True
assert value["source_name"] == "Invesco public fund characteristics JSON"
assert value["history_sample_count"] < 30
for field in ("current_pe", "forward_pe", "pb", "earnings_growth", "peg", "valuation_score"):
    assert value[field] is None or math.isfinite(value[field])

history = json.loads((ROOT / "valuation-history.json").read_text(encoding="utf-8"))
assert len(history["snapshots"]) >= 1
assert history["snapshots"][-1]["date"] >= value["source_date"]
assert proxy_map["items"]["00662"]["benchmark"] == "NASDAQ-100 Index"
assert proxy_map["items"]["009815"]["benchmark"] == "彭博TPEx Magnificent 7 Plus美國大型科技指數"
assert proxy_map["items"]["00935"]["source_type"] == "reference_only"
assert valuation["items"]["00935"]["valuation_score"] is None
assert valuation["items"]["00935"]["score_status"] == "benchmark_background"

print("PASS valuation updater validation, proxy benchmark separation and initial history")
