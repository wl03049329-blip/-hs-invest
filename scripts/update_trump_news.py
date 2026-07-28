#!/usr/bin/env python3
"""Update trump-news.json from White House official pages and Google News RSS.
Uses only Python standard library so it runs directly in GitHub Actions.
"""
from __future__ import annotations
import datetime as dt
import html
import json
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "trump-news.json"
UA = {"User-Agent": "Mozilla/5.0 HS-Invest-Market-Watch/1.0"}
MAX_TITLE_LENGTH = 180
WHITEHOUSE_ACTION_PREFIX = "https://www.whitehouse.gov/presidential-actions/"

BAD_TITLE_MARKERS = (
    "<!doctype",
    "<html",
    "<script",
    "<style",
    "</",
    "@context",
    "@graph",
    "@font-face",
    "@media",
    "application/ld+json",
    "schema.org",
    "wp-block-",
    "sourceurl=",
    "googletagmanager",
    "document.",
    "window.",
    "var(--",
)

KEYWORDS = {
    "關稅／貿易": ["tariff", "trade", "duty", "section 301", "import"],
    "聯準會／利率": ["federal reserve", "fed", "powell", "interest rate"],
    "中國／科技限制": ["china", "semiconductor", "chip", "export control", "taiwan"],
    "財政／稅制": ["tax", "budget", "debt", "treasury"],
    "能源／原物料": ["oil", "energy", "aluminum", "steel", "copper"],
    "地緣政治": ["sanction", "war", "iran", "russia", "ukraine", "israel"],
}

def clean_title(value: object) -> str:
    if not isinstance(value, str):
        return ""
    title = html.unescape(re.sub(r"\s+", " ", value)).strip()
    lower = title.lower()
    if not title or len(title) > MAX_TITLE_LENGTH:
        return ""
    if "<" in title or ">" in title:
        return ""
    if any(marker in lower for marker in BAD_TITLE_MARKERS):
        return ""
    if re.search(r"\{[^{}]{0,160}(?:[a-z-]+\s*:|--[a-z0-9-]+\s*:)", lower):
        return ""
    if lower.count("http://") + lower.count("https://") > 1:
        return ""
    return title

class WhiteHouseActionParser(HTMLParser):
    """Collect only the visible text inside Presidential Actions links."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str]] = []
        self.current_url = ""
        self.current_text: list[str] = []
        self.ignored_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in {"script", "style", "noscript", "template"}:
            self.ignored_depth += 1
            return
        if tag != "a" or self.current_url or self.ignored_depth:
            return
        href = dict(attrs).get("href") or ""
        if href.startswith(WHITEHOUSE_ACTION_PREFIX):
            self.current_url = href
            self.current_text = []

    def handle_data(self, data: str) -> None:
        if self.current_url and not self.ignored_depth:
            self.current_text.append(data)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in {"script", "style", "noscript", "template"}:
            self.ignored_depth = max(0, self.ignored_depth - 1)
            return
        if tag == "a" and self.current_url:
            self.links.append((self.current_url, " ".join(self.current_text)))
            self.current_url = ""
            self.current_text = []

def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()

def classify(title: str) -> tuple[str, str, str]:
    t = title.lower()
    category = "政策／言論"
    for name, words in KEYWORDS.items():
        if any(w in t for w in words):
            category = name
            break
    high = any(w in t for w in ["tariff", "duty", "sanction", "federal reserve", "powell", "china", "war", "emergency", "export control"])
    risk = "高" if high else "中"
    views = {
        "關稅／貿易": "可能改變通膨、企業成本與全球供應鏈預期，科技硬體、製造及出口族群通常較敏感。",
        "聯準會／利率": "可能影響降息預期、美元與美債殖利率，成長型科技股估值通常最敏感。",
        "中國／科技限制": "可能影響半導體、AI、電子供應鏈與台股風險溢價。",
        "財政／稅制": "可能影響企業獲利、國債供給與殖利率，需觀察金融與大型權值股。",
        "能源／原物料": "可能影響原物料價格、製造成本與通膨預期。",
        "地緣政治": "可能推升避險需求與波動，需留意油價、美元與半導體供應鏈。",
        "政策／言論": "政策方向若快速轉變，可能提高市場不確定性；需等待正式文件與資產價格確認。",
    }
    return category, risk, views[category]

def google_rss() -> list[dict]:
    query = 'Donald Trump (tariff OR "Federal Reserve" OR China OR semiconductor OR sanction OR trade) when:3d'
    url = "https://news.google.com/rss/search?" + urllib.parse.urlencode({"q": query, "hl": "en-US", "gl": "US", "ceid": "US:en"})
    root = ET.fromstring(get(url))
    out = []
    for item in root.findall("./channel/item")[:10]:
        title = clean_title(item.findtext("title") or "")
        link = item.findtext("link") or ""
        pub = item.findtext("pubDate") or ""
        source_node = item.find("source")
        source = source_node.text.strip() if source_node is not None and source_node.text else "Google News"
        if not title or "trump" not in title.lower():
            continue
        category, risk, view = classify(title)
        try:
            date = dt.datetime.strptime(pub[:25], "%a, %d %b %Y %H:%M:%S").date().isoformat()
        except Exception:
            date = dt.date.today().isoformat()
        out.append({"date": date, "source": source, "title": title, "url": link, "category": category, "risk": risk, "market_view": view})
    return out

def whitehouse_actions() -> list[dict]:
    url = "https://www.whitehouse.gov/presidential-actions/"
    text = get(url).decode("utf-8", "ignore")
    parser = WhiteHouseActionParser()
    parser.feed(text)
    out, seen = [], set()
    for link, raw in parser.links:
        title = clean_title(raw)
        if len(title) < 20 or title in seen:
            continue
        seen.add(title)
        lower = title.lower()
        if not any(w in lower for words in KEYWORDS.values() for w in words):
            continue
        category, risk, view = classify(title)
        out.append({"date": dt.date.today().isoformat(), "source": "White House", "title": title, "url": link, "category": category, "risk": risk, "market_view": view})
        if len(out) >= 4:
            break
    return out

def main() -> None:
    items = []
    for loader in (whitehouse_actions, google_rss):
        try:
            items.extend(loader())
        except Exception as exc:
            print(f"warning: {loader.__name__}: {exc}")
    # De-duplicate similar titles, prioritize official source and newest date.
    items.sort(key=lambda x: (x["source"] == "White House", x["date"]), reverse=True)
    unique, seen = [], set()
    for item in items:
        title = clean_title(item.get("title"))
        if not title:
            continue
        item["title"] = title
        key = re.sub(r"[^a-z0-9]+", "", title.lower())[:80]
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
        if len(unique) >= 6:
            break
    if not unique and OUT.exists():
        print("No new data; preserving existing JSON")
        return
    payload = {"updated_at": dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="minutes"), "items": unique}
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(unique)} items to {OUT}")

if __name__ == "__main__":
    main()
