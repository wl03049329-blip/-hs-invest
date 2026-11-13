import tempfile
import unittest
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch

from backend import c4_observation as ob


class ObservationRuntime(unittest.TestCase):
    def test_api_separate_from_formal_endpoint_and_no_store(self):
        from fastapi.testclient import TestClient
        from backend.state_store import StateStore
        now = datetime.fromisoformat("2026-11-13T09:31:00+08:00")
        with tempfile.TemporaryDirectory() as root:
            with patch.dict("os.environ", {"HS_LIVE_VOLUME_PATH":root}):
                from backend.app import create_app
            store = StateStore(root)
            observation = SimpleNamespace(clock=lambda:now,store=ob.ObservationStore(root))
            api = TestClient(create_app(state_store=store,observation_scheduler=observation))
            response = api.get("/api/intraday-observation")
            self.assertEqual(response.headers["cache-control"],"no-store")
            self.assertIs(response.json()["formal_eligible"],False)
            self.assertEqual(response.json()["items"]["00662"]["status"],"SPLIT_SUSPENDED")
            self.assertEqual(api.post("/api/intraday-observation").status_code,405)
            formal = api.get("/api/live-scores").json()
            self.assertNotIn("formal_eligible",formal)
            self.assertEqual(formal["completeness"],"0/5")
            self.assertEqual(TestClient(create_app(state_store=store)).get("/api/intraday-observation").status_code,404)

    def test_scheduler_uses_prior_session_and_does_not_repeat_bucket_after_restart(self):
        now = datetime.fromisoformat("2026-11-13T09:31:00+08:00")
        with tempfile.TemporaryDirectory() as root:
            calendar = SimpleNamespace(check=lambda _:SimpleNamespace(status="TRADING_DAY"))
            scheduler = ob.ObservationScheduler(root,calendar,clock=lambda:now)
            def bridge(data):
                if "loadHistoryFor" in data:
                    self.assertEqual(data["previousSession"],"2026-11-12")
                    if data["loadHistoryFor"] == "0050":
                        raise ValueError("source missing")
                    return [{"date":"2026-11-12"}]*252
                self.assertEqual(data["histories"]["0050"],[])
                self.assertEqual(len(data["histories"]["00757"]),252)
                return {**ob.blank(now,"HISTORY_UNVERIFIED"),"calculated_at":now.isoformat()}
            with patch.object(ob,"market_sessions",return_value=["2026-11-12"]), \
                 patch.object(ob,"live_rows",return_value={}) as quotes, patch.object(ob,"run_node",side_effect=bridge):
                scheduler.tick()
                ob.ObservationScheduler(root,calendar,clock=lambda:now).tick()
                quotes.assert_called_once()
                self.assertEqual(scheduler.store.public(now)["items"]["0050"]["status"],"HISTORY_UNVERIFIED")

    def test_atomic_restore_duplicate_expiry_and_day_change(self):
        now = datetime.fromisoformat("2026-11-13T09:31:00+08:00")
        with tempfile.TemporaryDirectory() as root:
            store = ob.ObservationStore(root)
            record = ob.blank(now, "QUOTE_UNAVAILABLE")
            record.update(bucket=ob.slot_at(now), calculated_at=now.isoformat())
            record["items"]["0050"] = dict(status="OBSERVED", score=55.1,
                quote_as_of=now.isoformat(), source="MIS_Z", trading_date="2026-11-13")
            self.assertTrue(store.save(record))
            self.assertFalse(store.save({**record, "items": {}}))
            restored = ob.ObservationStore(root)
            self.assertEqual(restored.public(now)["items"]["0050"]["score"],55.1)
            self.assertEqual(restored.public(now+timedelta(minutes=8))["items"]["0050"]["status"],"QUOTE_STALE")
            self.assertEqual(restored.public(now.replace(hour=14))["items"]["0050"]["status"],"OFF_SESSION")
            self.assertEqual(restored.public(now+timedelta(days=3))["items"]["0050"]["status"],"QUOTE_UNAVAILABLE")
            with patch("backend.c4_observation.os.replace",side_effect=OSError("fixture")):
                with self.assertRaises(OSError):
                    store.save({**record,"bucket":ob.slot_at(now+timedelta(minutes=5))})
            self.assertEqual(restored.load(),record)

    def test_fallback_conflict_and_missing_do_not_reject_neighbor(self):
        now = datetime.fromisoformat("2026-11-13T09:31:00+08:00")
        base = dict(ex="tse",d="20261113",t="09:30:51",z="-",pz="-",y="95",o="93",h="96",l="91",v="20")
        raw = [{**base,"c":"0050"},{**base,"c":"00757"},{**base,"c":"00935","z":"94"}]
        from backend.fugle_quotes import FugleObservation
        def backup(symbol, instant):
            return FugleObservation(symbol,"2026-11-13" if symbol=="0050" else "2026-11-12",
                                    94,instant-timedelta(seconds=1),"FRESH",None)
        with patch("backend.c4_observation.fetch_fugle_quote",side_effect=AssertionError):
            self.assertEqual(set(ob.live_rows(now,batch=lambda _:raw,clock=lambda:now)),{"00935"})
        result = ob.live_rows(now,batch=lambda _:raw,fallback=backup,clock=lambda:now,fallback_enabled=True)
        self.assertEqual(set(result),{"0050","00935"})
        self.assertEqual(result["0050"]["quote_source"],"FUGLE_LAST_TRADE")
