"""Independent, opt-in observation producer; never writes official LIVE state."""
import asyncio
import json
import logging
import os
import subprocess
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, time
from pathlib import Path
from urllib.request import urlopen

from scripts.audit_radar_calendar import parse_market
from scripts import update_market_quotes as mis
from .live_quotes import TAIPEI, _fugle_row, fetch_fugle_quote

SYMBOLS = ("0050", "00757", "00830", "00935")
ALL = (*SYMBOLS, "00662", "009815")
VERSION = "FINAL_CORE_WEIGHT_V1"
MAX_BUCKET_ATTEMPTS = 3
RETRY_AFTER_SECONDS = 20
LOG = logging.getLogger(__name__)
SOURCES = {"MIS_Z", "MIS_PZ", "FUGLE_LAST_TRADE"}
REASONS = {"OBSERVED","QUOTE_UNAVAILABLE","QUOTE_STALE","QUOTE_SOURCE_INVALID",
           "QUOTE_DATE_INVALID","QUOTE_TIME_INVALID","WAITING_FIRST_TRADE",
           "QUOTE_INCOMPLETE","CALCULATION_FAILED","HISTORY_UNVERIFIED","OFF_SESSION",
           "SPLIT_SUSPENDED","SPLIT_RESUMPTION_UNVERIFIED","WAIT_NATIVE"}


def run_node(data):
    result = subprocess.run(["node", str(Path(__file__).with_name("c4_observation_bridge.js"))],
                            input=json.dumps(data), encoding="utf-8", capture_output=True,
                            timeout=25, check=True, env={**os.environ, "TZ": "UTC"})
    return json.loads(result.stdout)


def market_sessions(day):
    month = day[:7].replace("-", "")
    with urlopen(f"https://www.twse.com.tw/exchangeReport/FMTQIK?response=json&date={month}01", timeout=8) as response:
        return parse_market(json.load(response), month, day)


def live_rows(now, *, batch=mis.fetch_mis_batch, fallback=fetch_fugle_quote,
              clock=lambda: datetime.now(TAIPEI), fallback_enabled=False):
    raw = batch([f"tse_{symbol}.tw" for symbol in SYMBOLS])
    if not raw:
        raise ValueError("MIS_UNAVAILABLE")
    rows = {}
    for symbol in SYMBOLS:
        matches = [row for row in raw if row.get("c") == symbol]
        if len(matches) != 1 or matches[0].get("ex") != "tse":
            continue
        source = matches[0]
        parsed, reason = mis.parse_mis_row(source, required=True)
        if parsed is None and fallback_enabled and reason in {"missing_price", "invalid_price"}:
            try:
                parsed = _fugle_row(symbol, source, fallback(symbol, clock()), clock())
            except Exception as exc:
                if "429" in str(exc) or "RATE_LIMIT" in str(exc):
                    fallback_enabled = False
                continue
        if parsed is not None:
            rows[symbol] = parsed
    return rows


def blank(now, reason):
    day = now.date().isoformat()
    items = {symbol: {"status": reason} for symbol in ALL}
    items["009815"] = {"status": "WAIT_NATIVE"}
    if "2026-11-11" <= day <= "2026-11-16":
        items["00662"] = {"status":"SPLIT_SUSPENDED"}
    elif day >= "2026-11-17":
        items["00662"] = {"status":"SPLIT_RESUMPTION_UNVERIFIED"}
    return {"schema_version":1,"kind":"INTRADAY_OBSERVATION","formal_eligible":False,
            "score_version":VERSION,"trading_date":day,"calculated_at":None,"items":items}


def slot_at(now):
    return now.replace(minute=now.minute//5*5, second=0, microsecond=0).isoformat()


class ObservationStore:
    def __init__(self, root):
        self.path = Path(root) / "intraday-observation-v1.json"

    def load(self):
        try:
            record = json.loads(self.path.read_text(encoding="utf-8"))
            if record.get("kind") != "INTRADAY_OBSERVATION" or record.get("schema_version") != 1 or record.get("formal_eligible") is not False or record.get("score_version") != VERSION:
                return {}
            return record
        except (ValueError, OSError, AttributeError):
            return {}

    def save(self, record):
        if self.load().get("bucket", "") >= record["bucket"]:
            return False
        self._write(self.path, record)
        return True

    def attempt(self):
        try:
            row = json.loads(self.path.with_name("intraday-observation-attempt-v1.json").read_text(encoding="utf-8"))
            if not isinstance(row, dict) or set(row) != {"bucket","attempt","at","status","reason"}:
                return {}
            if (type(row["attempt"]) is not int or not 1 <= row["attempt"] <= MAX_BUCKET_ATTEMPTS
                    or row["status"] not in {"RUNNING","RETRY","EXHAUSTED","PUBLISHED","SKIPPED"}
                    or row["reason"] not in {"NONE","HOLIDAY","BUCKET_EXPIRED","CALENDAR_UNAVAILABLE",
                        "PREVIOUS_SESSION_UNVERIFIED","STATE_WRITE_FAILED","MIS_UNAVAILABLE","CALCULATION_FAILED"}):
                return {}
            if slot_at(datetime.fromisoformat(row["bucket"])) != row["bucket"] or datetime.fromisoformat(row["at"]).utcoffset() is None:
                return {}
            return row
        except (OSError, ValueError, TypeError):
            return {}

    def save_attempt(self, record):
        self._write(self.path.with_name("intraday-observation-attempt-v1.json"), record)

    def _write(self, path, record):
        fd, temporary = tempfile.mkstemp(dir=self.path.parent, prefix="observation-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(record, handle, allow_nan=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def public(self, now):
        if not active_session(now):
            return blank(now, "OFF_SESSION")
        record = self.load()
        result = blank(now, "QUOTE_UNAVAILABLE")
        if record.get("trading_date") != result["trading_date"]:
            return result
        try:
            calculated = datetime.fromisoformat(record["calculated_at"])
            if not 0 <= (now-calculated).total_seconds() <= 420:
                return blank(now, "QUOTE_STALE")
            result["calculated_at"] = record["calculated_at"]
            for symbol in SYMBOLS:
                row = record["items"].get(symbol, {})
                status = row.get("status")
                if status not in REASONS:
                    continue
                result["items"][symbol] = {"status":status}
                if status == "OBSERVED":
                    try:
                        stamp = datetime.fromisoformat(row["quote_as_of"])
                        if stamp.utcoffset() is None:
                            raise ValueError("missing timezone")
                    except (TypeError, ValueError, KeyError):
                        result["items"][symbol] = {"status":"QUOTE_TIME_INVALID"}
                        continue
                    age = (now-stamp).total_seconds()
                    score = row.get("score")
                    if not 0 <= age <= 420 or stamp.astimezone(TAIPEI).date() != now.date():
                        result["items"][symbol] = {"status":"QUOTE_STALE"}
                    elif type(score) in (int,float) and 0 <= score <= 100 and row.get("source") in SOURCES and row.get("trading_date") == result["trading_date"]:
                        result["items"][symbol] = {k:row[k] for k in ("status","score","quote_as_of","source","trading_date")}
                    else:
                        result["items"][symbol] = {"status":"CALCULATION_FAILED"}
        except (ValueError, TypeError, KeyError, AttributeError):
            return blank(now,"CALCULATION_FAILED")
        return result


def active_session(now):
    return now.weekday() < 5 and time(9) <= now.time() < time(13,25)


class ObservationScheduler:
    def __init__(self, root, calendar, clock=lambda:datetime.now(TAIPEI)):
        self.store, self.calendar, self.clock = ObservationStore(root), calendar, clock
        self.history = {}
        self._lock = threading.Lock()
        self._attempt = self.store.attempt()
        self._previous = None

    def diagnostics(self):
        # Only fixed stage/reason codes; never provider responses or exceptions.
        return dict(self._attempt)

    def _record(self, bucket, attempt, now, status, reason):
        self._attempt = dict(bucket=bucket, attempt=attempt, at=now.isoformat(),
                             status=status, reason=reason)
        self.store.save_attempt(self._attempt)
        LOG.info("observation bucket=%s attempt=%s status=%s reason=%s",bucket,attempt,status,reason)

    def tick(self):
        if not self._lock.acquire(blocking=False):
            return
        try:
            self._tick()
        finally:
            self._lock.release()

    def _tick(self):
        now = self.clock()
        bucket = slot_at(now)
        if not active_session(now) or self.store.load().get("bucket","") >= bucket:
            return
        prior = self._attempt
        attempt = 1
        if prior and prior["bucket"] >= bucket:
            if (prior["bucket"] != bucket or prior["status"] not in {"RETRY","RUNNING"}
                    or prior["attempt"] >= MAX_BUCKET_ATTEMPTS
                    or (now-datetime.fromisoformat(prior["at"])).total_seconds() < RETRY_AFTER_SECONDS):
                return
            attempt = prior["attempt"] + 1
        # Reserve the attempt before calling providers, including after restart.
        self._record(bucket,attempt,now,"RUNNING","NONE")
        stage = "CALENDAR_UNAVAILABLE"
        try:
            status = self.calendar.check(now.date()).status
            if status == "HOLIDAY":
                self._record(bucket,attempt,now,"SKIPPED","HOLIDAY")
                return
            if status != "TRADING_DAY":
                raise ValueError(stage)
            stage = "PREVIOUS_SESSION_UNVERIFIED"
            record = self._collect(now, bucket)
            if record is None:
                self._record(bucket,attempt,self.clock(),"SKIPPED","BUCKET_EXPIRED")
                return
            stage = "STATE_WRITE_FAILED"
            self.store.save(record)
            self._record(bucket,attempt,self.clock(),"PUBLISHED","NONE")
        except Exception as exc:
            reason = str(exc) if type(exc) is ValueError and str(exc) in {
                "MIS_UNAVAILABLE","CALCULATION_FAILED","PREVIOUS_SESSION_UNVERIFIED"
            } else stage
            self._record(bucket,attempt,self.clock(),
                         "RETRY" if attempt < MAX_BUCKET_ATTEMPTS else "EXHAUSTED",reason)

    def _collect(self, now, bucket):
        day = now.date().isoformat()
        self.history = {k:v for k,v in self.history.items() if k[0] == day}
        if self._previous and self._previous[0] == day:
            previous = self._previous[1]
        else:
            sessions = market_sessions(day)
            previous = max((d for d in sessions if d < day), default=None)
            if previous is None:  # Month boundary: no guessing a previous date.
                from datetime import timedelta
                last_month = (now.date().replace(day=1)-timedelta(days=1)).isoformat()
                previous = max(market_sessions(last_month), default=None)
            if not previous:
                raise ValueError("PREVIOUS_SESSION_UNVERIFIED")
            self._previous = (day,previous)
        def get_history(symbol):
            key = (day,symbol)
            try:
                if key not in self.history:
                    rows = run_node({"loadHistoryFor":symbol,"previousSession":previous})
                    if len(rows) >= 252 and rows[-1].get("date") == previous:
                        self.history[key] = rows
                return symbol, self.history.get(key,[])
            except (OSError,ValueError,TypeError,subprocess.SubprocessError):
                return symbol, []
        with ThreadPoolExecutor(max_workers=4) as pool:
            histories = dict(pool.map(get_history,SYMBOLS))
        # No second consumer of the formal Fugle quota until an account-wide
        # budget is verified. The per-symbol fallback is dependency-injected
        # for testing, never activated by an environment flag alone.
        if slot_at(self.clock()) != bucket:
            return None
        try:
            rows = live_rows(self.clock())
        except Exception:
            raise ValueError("MIS_UNAVAILABLE") from None
        evaluated = self.clock()
        if slot_at(evaluated) != bucket:
            return
        try:
            record = run_node({"tradingDate":day,"slot":datetime.fromisoformat(bucket).strftime("%H:%M"),
                               "now":evaluated.isoformat(),"marketState":"OPEN","rows":rows,
                               "histories":histories,"previousSession":previous})
        except Exception:
            raise ValueError("CALCULATION_FAILED") from None
        return {**record,"bucket":bucket} if slot_at(self.clock()) == bucket else None

    async def run_forever(self):
        while True:
            try:
                await asyncio.to_thread(self.tick)
            except Exception:
                LOG.error("observation scheduler tick failed before attempt")
            await asyncio.sleep(20)
