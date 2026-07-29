"""Build the searchable Taiwan-listed ETF universe from official structured data."""

from __future__ import annotations

import html
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "etf-universe.json"
TWSE_FUND_URL = "https://openapi.twse.com.tw/v1/opendata/t187ap47_L"
TPEX_FUND_URL = "https://www.tpex.org.tw/openapi/v1/tpex_opfund_latest"
ISIN_URLS = {
    "TWSE": "https://isin.twse.com.tw/isin/C_public.jsp?strMode=2",
    "TPEx": "https://isin.twse.com.tw/isin/C_public.jsp?strMode=4",
}
FINMIND_URL = "https://api.finmindtrade.com/api/v4/data"
TAIPEI = ZoneInfo("Asia/Taipei")
CODE_RE = re.compile(r"^[0-9A-Z]{4,10}$")

ISSUER_BRANDS = {
    "元大": "元大投信",
    "富邦": "富邦投信",
    "國泰": "國泰投信",
    "中信": "中國信託投信",
    "群益": "群益投信",
    "復華": "復華投信",
    "永豐": "永豐投信",
    "統一": "統一投信",
    "野村": "野村投信",
    "凱基": "凱基投信",
    "兆豐": "兆豐投信",
    "第一金": "第一金投信",
    "台新": "台新投信",
    "新光": "新光投信",
    "街口": "街口投信",
    "大華": "大華銀投信",
    "聯博": "聯博投信",
    "安聯": "安聯投信",
    "摩根": "摩根投信",
    "施羅德": "施羅德投信",
}


def fetch_bytes(url: str, timeout: int = 25) -> tuple[bytes, str]:
    request = Request(
        url,
        headers={
            "User-Agent": "HS-ETF-Radar/6.1 (+https://github.com/wl03049329-blip/-hs-invest)",
            "Accept": "application/json,text/html;q=0.8,*/*;q=0.5",
        },
    )
    with urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed official URLs
        return response.read(), response.headers.get_content_charset() or ""


def fetch_json(url: str, timeout: int = 25) -> Any:
    body, charset = fetch_bytes(url, timeout)
    return json.loads(body.decode(charset or "utf-8-sig"))


def clean(value: Any, limit: int = 240) -> str:
    text = html.unescape(str(value or "")).replace("\u3000", " ")
    return re.sub(r"\s+", " ", text).strip()[:limit]


def roc_date(value: Any) -> str:
    raw = re.sub(r"\D", "", clean(value, 20))
    if len(raw) == 7:
        year = int(raw[:3]) + 1911
        month, day = int(raw[3:5]), int(raw[5:7])
        return f"{year:04d}-{month:02d}-{day:02d}" if 1990 <= year <= 2100 and 1 <= month <= 12 and 1 <= day <= 31 else ""
    if len(raw) == 8 and raw.startswith(("19", "20")):
        year, month, day = int(raw[:4]), int(raw[4:6]), int(raw[6:8])
        return f"{year:04d}-{month:02d}-{day:02d}" if 1990 <= year <= 2100 and 1 <= month <= 12 and 1 <= day <= 31 else ""
    match = re.match(r"^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$", clean(value, 20))
    if match:
        year, month, day = map(int, match.groups())
        return f"{year:04d}-{month:02d}-{day:02d}" if 1990 <= year <= 2100 and 1 <= month <= 12 and 1 <= day <= 31 else ""
    return ""


def infer_issuer(name: str, full_name: str, agent: str = "") -> str:
    if clean(agent):
        return clean(agent, 80)
    combined = f"{name} {full_name}"
    for brand, issuer in ISSUER_BRANDS.items():
        if brand in combined:
            return issuer
    return ""


def classify_etf(
    code: str,
    name: str,
    official_type: str,
    benchmark: str,
    foreign_components: str = "",
) -> dict[str, Any]:
    official = clean(official_type, 180)
    bench = clean(benchmark, 180)
    combined = f"{official} {bench}"
    fallback = clean(name, 100)
    active = "主動" in official or code.endswith(("A", "D"))
    category = "other"
    confidence = "high" if official else "medium"
    asset_class = "other"
    multiple = 1

    # TWSE uses the shared official label "槓桿/反向" for both products. The
    # security-code suffix and fund name disambiguate the actual direction.
    if code.endswith(("R", "S")) or re.search(r"反[一1]|反向", fallback):
        category, asset_class, multiple = "inverse", "derivative", -1
    elif code.endswith(("L", "M")) or re.search(r"正[二2]|槓桿", fallback):
        category, asset_class, multiple = "leveraged", "derivative", 2
    elif "反向" in official:
        category, asset_class, multiple = "inverse", "derivative", -1
        confidence = "medium"
    elif "槓桿" in official:
        category, asset_class, multiple = "leveraged", "derivative", 2
        confidence = "medium"
    elif "期貨" in official or code.endswith(("U", "V")):
        category, asset_class = "futures", "commodity_futures"
    elif "境外" in official:
        category, asset_class = "offshore", "offshore"
    elif "多資產" in official or "股債" in combined:
        category, asset_class = "multi_asset", "multi_asset"
    elif "不動產" in combined or "REIT" in combined.upper():
        category, asset_class = "reit", "real_estate"
    elif "債" in official or code.endswith(("B", "D")):
        asset_class = "bond"
        text = f"{combined} {fallback}"
        if active:
            category = "active_bond"
        elif "浮動" in text:
            category = "bond_floating"
        elif "非投等" in text or "非投資級" in text or "高收益" in text:
            category = "bond_high_yield"
        elif "新興" in text:
            category = "bond_emerging"
        elif re.search(r"(公司債|金融債|銀行債|投資級|投等|信用債|科技債|醫療債|電信債|能源債|製藥債|A級|AAA|BBB|IG)", text, re.I):
            category = "bond_investment_grade"
        elif re.search(r"(0[-～~]?[13]年|1[-～~]?3年|短天期|短期)", text):
            category = "bond_government_short"
        elif re.search(r"(7[-～~]?10年|10年|15\+?|20年|25年|30年|長天期|長期)", text):
            category = "bond_government_long"
        elif "公債" in text or "國債" in text:
            category = "bond_government_long"
            confidence = "medium"
        else:
            category = "other"
            confidence = "low"
    elif "股票" in official or "成分證券" in official:
        asset_class = "equity"
        if active:
            category = "active_equity"
        elif "國外" in official or clean(foreign_components) == "是":
            category = "equity_overseas"
        elif re.search(r"(高股息|高息|股利|收益|低波|低波動)", bench):
            category = "equity_dividend"
        elif re.search(r"(科技|半導體|金融|電動車|生技|AI|人工智慧|航太|產業|主題)", bench, re.I):
            category = "equity_sector"
        elif bench and bench != "不適用":
            category = "equity_broad"
        else:
            category = "equity_broad"
            confidence = "medium"
    else:
        # Official type is absent only for an ISIN/FinMind fallback row.
        confidence = "low"
        if code.endswith(("L", "M")):
            category, asset_class, multiple, confidence = "leveraged", "derivative", 2, "medium"
        elif code.endswith(("R", "S")):
            category, asset_class, multiple, confidence = "inverse", "derivative", -1, "medium"
        elif code.endswith(("U", "V")):
            category, asset_class, confidence = "futures", "commodity_futures", "medium"
        elif re.search(r"(債|Bond)", fallback, re.I):
            asset_class, confidence = "bond", "medium"
            if active:
                category = "active_bond"
            elif re.search(r"(非投等|非投資級|高收益)", fallback):
                category = "bond_high_yield"
            elif re.search(r"(浮動|FRN)", fallback, re.I):
                category = "bond_floating"
            elif re.search(r"(新興|EM)", fallback, re.I):
                category = "bond_emerging"
            elif re.search(r"(0[-～~]?[13]年|1[-～~]?3年|短天期|短債)", fallback):
                category = "bond_government_short"
            elif re.search(r"(7[-～~]?10年|10年|15\+?|20年|25年|30年|長天期|美債|公債|國債|市政債|主權債)", fallback):
                category = "bond_government_long"
            elif re.search(r"(公司|金融|銀行|投資級|投等|科技債|醫療債|電信債|能源債|製藥債|信用債|A級|AAA|BBB|IG)", fallback, re.I):
                category = "bond_investment_grade"
            else:
                category, confidence = "other", "low"
        elif re.search(r"(NASDAQ|S&P|道瓊|日經|日本|印度|中國|A50|滬深|上証|上證|全球|美國|歐洲|越南|韓國|恒生|港股|MAG)", fallback, re.I):
            category, asset_class, confidence = "equity_overseas", "equity", "medium"
        elif re.search(r"(高股息|高息|股利|低波)", fallback, re.I):
            category, asset_class, confidence = "equity_dividend", "equity", "medium"
        elif re.search(r"(科技|半導體|金融|生技|電動車|AI|人工智慧|航太|軍工)", fallback, re.I):
            category, asset_class, confidence = "equity_sector", "equity", "medium"
        elif re.search(r"(台灣50|臺灣50|中型100|公司治理|富櫃50|MSCI台灣)", fallback, re.I):
            category, asset_class, confidence = "equity_broad", "equity", "medium"

    if category == "other" and confidence != "low":
        confidence = "low"
    return {
        "asset_class": asset_class,
        "strategy_category": category,
        "active_passive": "active" if active else "passive",
        "leverage_multiple": multiple,
        "classification_confidence": confidence,
    }


def currency_exposure(code: str, name: str, official_type: str) -> str:
    if code.endswith(("K", "M", "S", "V")):
        return "外幣交易級別"
    if "國外" in official_type or re.search(r"(美國|美債|美元|日本|中國|全球|歐洲|新興市場)", name):
        return "外幣資產；是否避險依公開說明書"
    return "新台幣"


def normalize_twse(row: dict[str, Any], updated_at: str) -> dict[str, Any] | None:
    code = clean(row.get("基金代號"), 12).upper()
    name = clean(row.get("基金簡稱"), 80)
    official_type = clean(row.get("基金類型"), 180)
    full_name = clean(row.get("基金中文名稱"), 180)
    benchmark = clean(
        row.get("標的指數/追蹤指數名稱")
        or row.get("績效指標中文名稱"),
        180,
    )
    if not CODE_RE.fullmatch(code) or not name:
        return None
    if "交易所交易基金" not in official_type and "ETF" not in f"{official_type} {full_name}".upper():
        return None
    if re.search(r"ETN|指數投資證券|封閉式", f"{official_type} {full_name}", re.I):
        return None
    classification = classify_etf(
        code,
        name,
        official_type,
        benchmark,
        clean(row.get("是否包含國外成分股"), 10),
    )
    return {
        "code": code,
        "name": name,
        "exchange": "TWSE",
        "listed_date": roc_date(row.get("上市日期")),
        "issuer": infer_issuer(name, full_name, clean(row.get("總代理人"), 80)),
        "official_type": official_type,
        **classification,
        "currency_exposure": currency_exposure(code, name, official_type),
        "benchmark": "" if benchmark == "不適用" else benchmark,
        "source": ["TWSE 基金基本資料彙總表"],
        "updated_at": updated_at,
    }


class TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.in_cell = False
        self.cell: list[str] = []
        self.row: list[str] = []
        self.rows: list[list[str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in {"td", "th"}:
            self.in_cell = True
            self.cell = []

    def handle_data(self, data: str) -> None:
        if self.in_cell:
            self.cell.append(data)

    def handle_endtag(self, tag: str) -> None:
        lowered = tag.lower()
        if lowered in {"td", "th"} and self.in_cell:
            self.row.append(clean("".join(self.cell), 240))
            self.in_cell = False
        elif lowered == "tr":
            if self.row:
                self.rows.append(self.row)
            self.row = []


def decode_html(body: bytes, charset: str) -> str:
    for encoding in [charset, "utf-8", "big5", "cp950"]:
        if not encoding:
            continue
        try:
            return body.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            pass
    return body.decode("utf-8", errors="replace")


def parse_isin(exchange: str, url: str, updated_at: str) -> list[dict[str, Any]]:
    body, charset = fetch_bytes(url)
    parser = TableParser()
    parser.feed(decode_html(body, charset))
    items: list[dict[str, Any]] = []
    for row in parser.rows:
        joined = " ".join(row)
        code_match = re.search(r"\b([0-9][0-9A-Z]{3,9})\b", joined)
        cfi_match = re.search(r"\b(CE[A-Z0-9]{4})\b", joined)
        if not code_match or not cfi_match:
            continue
        code = code_match.group(1).upper()
        if not CODE_RE.fullmatch(code):
            continue
        code_cell = next((cell for cell in row if code in cell), "")
        name = clean(re.sub(rf"^.*?\b{re.escape(code)}\b", "", code_cell), 100)
        if not name:
            continue
        date = next((roc_date(cell) for cell in row if roc_date(cell)), "")
        classification = classify_etf(code, name, "", "")
        items.append(
            {
                "code": code,
                "name": name,
                "exchange": exchange,
                "listed_date": date,
                "issuer": infer_issuer(name, ""),
                "official_type": "ETF（ISIN CFI）",
                **classification,
                "currency_exposure": currency_exposure(code, name, ""),
                "benchmark": "",
                "source": [f"TWSE ISIN 證券編碼（{exchange}）"],
                "updated_at": updated_at,
            }
        )
    return items


def finmind_fallback(updated_at: str) -> list[dict[str, Any]]:
    params = urlencode({"dataset": "TaiwanStockInfo"})
    rows = fetch_json(f"{FINMIND_URL}?{params}")
    items: list[dict[str, Any]] = []
    for row in rows.get("data", []) if isinstance(rows, dict) else []:
        if clean(row.get("industry_category"), 20).upper() != "ETF":
            continue
        code = clean(row.get("stock_id"), 12).upper()
        name = clean(row.get("stock_name"), 100)
        if not CODE_RE.fullmatch(code) or not name or re.search(r"ETN|指數投資證券", name, re.I):
            continue
        classification = classify_etf(code, name, "", "")
        items.append(
            {
                "code": code,
                "name": name,
                "exchange": "TWSE",
                "listed_date": "",
                "issuer": infer_issuer(name, ""),
                "official_type": "ETF（FinMind 備援）",
                **classification,
                "currency_exposure": currency_exposure(code, name, ""),
                "benchmark": "",
                "source": ["FinMind TaiwanStockInfo 備援"],
                "updated_at": updated_at,
            }
        )
    return items


def merge_item(target: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    merged = dict(target)
    for key, value in incoming.items():
        if key == "source":
            merged[key] = list(dict.fromkeys([*target.get(key, []), *incoming.get(key, [])]))
        elif not merged.get(key) and value:
            merged[key] = value
    if target.get("classification_confidence") == "low" and incoming.get("classification_confidence") != "low":
        for key in ["asset_class", "strategy_category", "active_passive", "leverage_multiple", "classification_confidence"]:
            merged[key] = incoming[key]
    return merged


def validate_items(items: list[dict[str, Any]]) -> None:
    if len(items) < 100:
        raise ValueError(f"ETF universe unexpectedly small: {len(items)}")
    codes: set[str] = set()
    valid_categories = {
        "equity_broad", "equity_sector", "equity_dividend", "equity_overseas", "active_equity",
        "bond_government_short", "bond_government_long", "bond_investment_grade", "bond_high_yield",
        "bond_emerging", "bond_floating", "active_bond", "leveraged", "inverse", "commodity",
        "futures", "reit", "multi_asset", "offshore", "other",
    }
    for item in items:
        code = item.get("code", "")
        if not CODE_RE.fullmatch(code) or code in codes:
            raise ValueError(f"invalid or duplicate ETF code: {code}")
        codes.add(code)
        if item.get("exchange") not in {"TWSE", "TPEx"}:
            raise ValueError(f"invalid exchange for {code}")
        if item.get("strategy_category") not in valid_categories:
            raise ValueError(f"invalid strategy category for {code}")
        if re.search(r"ETN|指數投資證券|權證", f"{item.get('name')} {item.get('official_type')}", re.I):
            raise ValueError(f"non-ETF product leaked into universe: {code}")


def write_atomic(path: Path, payload: dict[str, Any]) -> None:
    encoded = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(encoded)
        temporary = Path(handle.name)
    os.replace(temporary, path)


def build_universe(now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(TAIPEI)
    updated_at = now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    source_status: dict[str, str] = {}
    rows: list[dict[str, Any]] = []

    try:
        twse_payload = fetch_json(TWSE_FUND_URL)
        if not isinstance(twse_payload, list):
            raise ValueError("TWSE payload is not an array")
        rows.extend(item for raw in twse_payload if (item := normalize_twse(raw, updated_at)))
        source_status["twse_fund"] = f"ok:{len(rows)}"
    except Exception as exc:  # noqa: BLE001
        source_status["twse_fund"] = f"error:{clean(exc, 100)}"

    # TPEx's structured open-fund endpoint is checked explicitly. Its current products
    # are open-ended fund beneficiary certificates, not ETFs, so none are promoted.
    try:
        tpex_payload = fetch_json(TPEX_FUND_URL)
        if not isinstance(tpex_payload, list):
            raise ValueError("TPEx payload is not an array")
        source_status["tpex_open_fund"] = f"checked:{len(tpex_payload)}:non_etf"
    except Exception as exc:  # noqa: BLE001
        source_status["tpex_open_fund"] = f"error:{clean(exc, 100)}"

    for exchange, url in ISIN_URLS.items():
        try:
            supplement = parse_isin(exchange, url, updated_at)
            rows.extend(supplement)
            source_status[f"isin_{exchange.lower()}"] = f"ok:{len(supplement)}"
        except Exception as exc:  # noqa: BLE001
            source_status[f"isin_{exchange.lower()}"] = f"error:{clean(exc, 100)}"

    if len(rows) < 100:
        try:
            fallback = finmind_fallback(updated_at)
            rows.extend(fallback)
            source_status["finmind_fallback"] = f"used:{len(fallback)}"
        except Exception as exc:  # noqa: BLE001
            source_status["finmind_fallback"] = f"error:{clean(exc, 100)}"
    else:
        source_status["finmind_fallback"] = "not_needed"

    merged: dict[str, dict[str, Any]] = {}
    for item in rows:
        code = item["code"]
        merged[code] = merge_item(merged[code], item) if code in merged else item
    today = now.date().isoformat()
    items = sorted(
        (
            item for item in merged.values()
            if not item.get("listed_date") or item["listed_date"] <= today
        ),
        key=lambda item: item["code"],
    )
    validate_items(items)
    counts = {
        "TWSE": sum(item["exchange"] == "TWSE" for item in items),
        "TPEx": sum(item["exchange"] == "TPEx" for item in items),
    }
    return {
        "version": 1,
        "updated_at": updated_at,
        "data_date": now.date().isoformat(),
        "total": len(items),
        "counts": counts,
        "sources": [
            {"name": "臺灣證券交易所基金基本資料彙總表", "url": TWSE_FUND_URL},
            {"name": "櫃買中心開放式基金 OpenAPI（ETF 排除檢查）", "url": TPEX_FUND_URL},
            {"name": "證交所 ISIN 證券編碼", "url": "https://isin.twse.com.tw/isin/"},
            {"name": "FinMind TaiwanStockInfo（僅失敗備援）", "url": FINMIND_URL},
        ],
        "source_status": source_status,
        "items": items,
    }


def main() -> None:
    try:
        payload = build_universe()
        write_atomic(OUTPUT, payload)
        print(
            f"Updated ETF universe: {payload['total']} "
            f"(TWSE {payload['counts']['TWSE']}, TPEx {payload['counts']['TPEx']})"
        )
    except Exception:
        if OUTPUT.exists():
            print("ETF universe update failed; previous validated JSON was retained.")
            raise
        raise


if __name__ == "__main__":
    main()
