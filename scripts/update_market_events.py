"""Verify near-term market-event results from official publications only."""

from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime, timedelta, timezone
from html import unescape
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "market-events.json"
TAIPEI = ZoneInfo("Asia/Taipei")
FOMC_INDEX = "https://www.federalreserve.gov/newsevents/pressreleases/2026-press-fomc.htm"
BEA_SCHEDULE = "https://www.bea.gov/news/schedule/full"
BLS_CURRENT = {
    "CPI": "https://www.bls.gov/news.release/cpi.nr0.htm",
    "NFP": "https://www.bls.gov/news.release/empsit.nr0.htm",
    "UNEMPLOYMENT": "https://www.bls.gov/news.release/empsit.nr0.htm",
}
OFFICIAL_HOSTS = (
    "federalreserve.gov", "bls.gov", "bea.gov", "whitehouse.gov", "ustr.gov",
    "commerce.gov", "federalregister.gov", "cbc.gov.tw",
)


def fetch_text(url: str, timeout: int = 25) -> str:
    request = Request(
        url,
        headers={
            "User-Agent": "HS-ETF-Radar/6.1 (+https://github.com/wl03049329-blip/-hs-invest)",
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        },
    )
    with urlopen(request, timeout=timeout) as response:  # noqa: S310 - allowlisted official URL
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


def official_url(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
        return any(host == domain or host.endswith(f".{domain}") for domain in OFFICIAL_HOSTS)
    except ValueError:
        return False


def plain_text(document: str) -> str:
    document = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", " ", document, flags=re.I | re.S)
    document = re.sub(r"<[^>]+>", " ", document)
    return re.sub(r"\s+", " ", unescape(document)).strip()


def fraction_number(value: str) -> float:
    value = value.strip().replace("‑", "-").replace("–", "-")
    match = re.fullmatch(r"(\d+)(?:-(\d+)/(\d+))?", value)
    if not match:
        return float(value)
    return float(match.group(1)) + (float(match.group(2)) / float(match.group(3)) if match.group(2) else 0)


def parse_fomc_statement(document: str) -> tuple[float, float] | None:
    text = plain_text(document)
    match = re.search(
        r"target range for the federal funds rate (?:at|to) "
        r"(\d+(?:[-‑]\d+/\d+)?(?:\.\d+)?)\s*(?:percent)?\s+to\s+"
        r"(\d+(?:[-‑]\d+/\d+)?(?:\.\d+)?)\s*percent",
        text,
        re.I,
    )
    return (fraction_number(match.group(1)), fraction_number(match.group(2))) if match else None


def format_rate(value: float) -> str:
    return f"{value:.2f}".rstrip("0").rstrip(".")


def previous_fomc_midpoint(items: list[dict[str, Any]], current_date: str) -> float | None:
    previous = [
        item for item in items
        if item.get("type") == "FOMC"
        and item.get("date", "") < current_date
        and item.get("status") in {"announced", "revised"}
        and item.get("target_range")
    ]
    for item in sorted(previous, key=lambda row: row["date"], reverse=True):
        numbers = re.findall(r"\d+(?:\.\d+)?", str(item["target_range"]))
        if len(numbers) >= 2:
            return (float(numbers[0]) + float(numbers[1])) / 2
    return None


def update_fomc(event: dict[str, Any], items: list[dict[str, Any]], now: datetime) -> bool:
    index = fetch_text(FOMC_INDEX)
    compact_date = event["date"].replace("-", "")
    links = re.findall(r'href=["\']([^"\']*monetary(\d{8})a\.htm)["\']', index, re.I)
    candidate = next((href for href, date in links if date == compact_date), "")
    if not candidate:
        return False
    url = urljoin(FOMC_INDEX, candidate)
    if not official_url(url):
        return False
    target = parse_fomc_statement(fetch_text(url))
    if not target:
        return False
    old_midpoint = previous_fomc_midpoint(items, event["date"])
    new_midpoint = sum(target) / 2
    change = round(new_midpoint - old_midpoint, 4) * 100 if old_midpoint is not None else None
    bps = round(change) if change is not None else None
    if bps == 0:
        summary = "維持聯邦基金利率目標區間不變"
    elif bps is not None:
        summary = f"{'升息' if bps > 0 else '降息'} {abs(bps)} 個基點"
    else:
        summary = "聯準會公布新的聯邦基金利率目標區間"
    event.update(
        status="announced",
        result_summary=summary,
        decision_change_bps=bps,
        target_range=f"{format_rate(target[0])}%～{format_rate(target[1])}%",
        official_source_name="Federal Reserve",
        official_source_url=url,
        verified_at=now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
    )
    return True


def release_date_text(value: str) -> str:
    parsed = datetime.strptime(value, "%Y-%m-%d")
    return f"{parsed.strftime('%B')} {parsed.day}, {parsed.year}"


def release_date_matches(document: str, event_date: str) -> bool:
    return release_date_text(event_date).lower() in plain_text(document).lower()


def previous_actual(items: list[dict[str, Any]], event: dict[str, Any]) -> str:
    if str(event.get("previous", "")).strip():
        return str(event["previous"]).strip()
    prior = [
        item for item in items
        if item.get("type") == event.get("type")
        and item.get("date", "") < event.get("date", "")
        and item.get("status") in {"announced", "revised"}
        and str(item.get("actual", "")).strip()
    ]
    return str(sorted(prior, key=lambda row: row["date"], reverse=True)[0]["actual"]) if prior else ""


def bea_release_url(event: dict[str, Any]) -> str:
    schedule = fetch_text(BEA_SCHEDULE)
    keyword = "Personal Income and Outlays" if event.get("type") == "PCE" else "GDP ("
    date_label = release_date_text(event["date"]).replace(f", {event['date'][:4]}", "")
    for row in re.findall(r"<tr\b[^>]*scheduled-releases-type-press[^>]*>.*?</tr>", schedule, re.I | re.S):
        text = plain_text(row)
        if keyword.lower() not in text.lower() or date_label.lower() not in text.lower():
            continue
        match = re.search(r'href=["\']([^"\']+)["\']', row, re.I)
        if match:
            url = urljoin(BEA_SCHEDULE, unescape(match.group(1)))
            if official_url(url):
                return url
    return ""


def signed_number(direction: str, raw: str) -> float:
    value = float(raw.replace(",", ""))
    return -value if direction.lower() in {"decreased", "declined", "fell"} else value


def mark_macro_result(
    event: dict[str, Any],
    *,
    actual: float,
    summary: str,
    source_name: str,
    source_url: str,
    now: datetime,
    items: list[dict[str, Any]],
) -> bool:
    event.update(
        status="revised" if re.search(r"(修正|第二|第三|second|third)", event.get("title", ""), re.I) else "announced",
        result_summary=summary,
        actual=f"{actual:g}",
        previous=previous_actual(items, event),
        official_source_name=source_name,
        official_source_url=source_url,
        verified_at=now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
    )
    return True


def update_bea_event(event: dict[str, Any], items: list[dict[str, Any]], now: datetime) -> bool:
    url = bea_release_url(event)
    if not url:
        return False
    document = fetch_text(url)
    if not release_date_matches(document, event["date"]):
        return False
    text = plain_text(document)
    if event.get("type") == "PCE":
        match = re.search(
            r"(?:From the same month one year ago,\s*)?the PCE price index "
            r"(increased|decreased) ([\d.]+) percent(?: from the same month one year ago)?",
            text,
            re.I,
        )
        if not match:
            return False
        actual = signed_number(match.group(1), match.group(2))
        return mark_macro_result(
            event, actual=actual, summary=f"PCE 物價指數年增 {actual:g}%",
            source_name="U.S. Bureau of Economic Analysis", source_url=url, now=now, items=items,
        )
    if event.get("type") == "GDP":
        match = re.search(
            r"Real gross domestic product \(GDP\) (increased|decreased) at an annual rate of ([\d.]+) percent",
            text,
            re.I,
        )
        if not match:
            return False
        actual = signed_number(match.group(1), match.group(2))
        return mark_macro_result(
            event, actual=actual, summary=f"實質 GDP 年率成長 {actual:g}%",
            source_name="U.S. Bureau of Economic Analysis", source_url=url, now=now, items=items,
        )
    return False


def update_bls_event(event: dict[str, Any], items: list[dict[str, Any]], now: datetime) -> bool:
    url = BLS_CURRENT.get(event.get("type", ""))
    if not url:
        return False
    document = fetch_text(url)
    if not release_date_matches(document, event["date"]):
        return False
    text = plain_text(document)
    event_type = event.get("type")
    if event_type == "CPI":
        match = re.search(r"Over the last 12 months, the all items index (increased|decreased) ([\d.]+) percent", text, re.I)
        if not match:
            return False
        actual = signed_number(match.group(1), match.group(2))
        return mark_macro_result(
            event, actual=actual, summary=f"消費者物價指數年增 {actual:g}%",
            source_name="U.S. Bureau of Labor Statistics", source_url=url, now=now, items=items,
        )
    if event_type == "NFP":
        match = re.search(r"Total nonfarm payroll employment (increased|declined) by ([\d,]+)", text, re.I)
        if not match:
            return False
        actual = signed_number(match.group(1), match.group(2))
        event["unit"] = "人"
        return mark_macro_result(
            event, actual=actual, summary=f"非農就業人數變動 {actual:+g} 人",
            source_name="U.S. Bureau of Labor Statistics", source_url=url, now=now, items=items,
        )
    if event_type == "UNEMPLOYMENT":
        match = re.search(r"unemployment rate (?:was|held at|rose to|fell to|changed little at) ([\d.]+) percent", text, re.I)
        if not match:
            return False
        actual = float(match.group(1))
        event["unit"] = "%"
        return mark_macro_result(
            event, actual=actual, summary=f"失業率 {actual:g}%",
            source_name="U.S. Bureau of Labor Statistics", source_url=url, now=now, items=items,
        )
    return False


def validate(items: list[dict[str, Any]]) -> None:
    ids: set[str] = set()
    for event in items:
        if not event.get("id") or event["id"] in ids:
            raise ValueError("missing or duplicate event id")
        ids.add(event["id"])
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(event.get("date", ""))):
            raise ValueError(f"invalid date: {event['id']}")
        if event.get("status") not in {"scheduled", "announced", "revised", "cancelled"}:
            raise ValueError(f"invalid status: {event['id']}")
        if event.get("status") in {"announced", "revised"}:
            if not official_url(str(event.get("official_source_url", ""))) or not event.get("result_summary"):
                raise ValueError(f"unverified result: {event['id']}")
        bps = event.get("decision_change_bps")
        if bps is not None and (not isinstance(bps, int) or abs(bps) > 1000):
            raise ValueError(f"invalid basis-point change: {event['id']}")


def write_atomic(payload: dict[str, Any]) -> None:
    encoded = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=ROOT, delete=False) as handle:
        handle.write(encoded)
        temporary = Path(handle.name)
    os.replace(temporary, OUTPUT)


def update_events(now: datetime | None = None) -> tuple[dict[str, Any], int, int]:
    now = now or datetime.now(TAIPEI)
    payload = json.loads(OUTPUT.read_text(encoding="utf-8"))
    items = payload.get("items", [])
    if not isinstance(items, list):
        raise ValueError("market-events items must be an array")
    checked = updated = 0
    for event in items:
        if event.get("status") in {"announced", "revised", "cancelled"}:
            continue
        try:
            event_date = datetime.strptime(event["date"], "%Y-%m-%d").replace(tzinfo=TAIPEI)
        except (KeyError, ValueError):
            continue
        if abs((event_date - now).total_seconds()) > 48 * 3600:
            continue
        checked += 1
        try:
            if event.get("type") == "FOMC" and update_fomc(event, items, now):
                updated += 1
            elif event.get("type") in {"PCE", "GDP"} and update_bea_event(event, items, now):
                updated += 1
            elif event.get("type") in BLS_CURRENT and update_bls_event(event, items, now):
                updated += 1
        except Exception as exc:  # noqa: BLE001 - retain prior event on any source failure
            event["source_status"] = f"temporary_error:{type(exc).__name__}"
    validate(items)
    if updated:
        payload["updated_at"] = now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        payload["source_status"] = {"checked": checked, "updated": updated, "rule": "official sources within ±48 hours"}
    return payload, checked, updated


def main() -> None:
    try:
        payload, checked, updated = update_events()
        if updated:
            write_atomic(payload)
        print(f"Checked {checked} near-term events; updated {updated}.")
    except Exception:
        print("Market-event update failed; previous JSON was retained.")
        raise


if __name__ == "__main__":
    main()
