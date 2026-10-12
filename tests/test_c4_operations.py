from __future__ import annotations
import copy
import os
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch
from backend.live_quotes import REQUIRED_SYMBOLS, TAIPEI
from scripts.check_c4_operations import evaluate, publication_verification, collect, artifact_at_ref, API, SafeRedirect, get_json

NOW = datetime(2026, 10, 13, 10, 5, tzinfo=TAIPEI)
VERSION = "FINAL_CORE_WEIGHT_V1"


def evidence():
    stamp = (NOW - timedelta(seconds=60)).isoformat()
    snapshot = {"schema_version": 1, "snapshot_type": "INTRADAY_CORE", "status": "SUCCESS",
        "trading_date": "2026-10-13", "slot": "10:00", "market_as_of": stamp,
        "calculated_at": stamp, "source_completeness": "5/5", "score_version": VERSION,
        "source": {"input_fingerprint": "a"*64, "quote_sources": {s:"MIS_Z" for s in REQUIRED_SYMBOLS}},
        "items": {s: {"status": "SUCCESS", "score": 24.25, "display_score": 24,
            "market_as_of": stamp, "score_version": VERSION, "freshness": "FRESH"} for s in REQUIRED_SYMBOLS}}
    artifact = {"snapshots": [snapshot]}
    return {"health": {"http": 200, "body": {"scheduler": {"status": "HEALTHY"},
                "data_status": "CURRENT", "publication_status": "DISPATCH_ACCEPTED",
                "input_fingerprint": "a"*64, "last_successful_live_snapshot_at": stamp}},
        "live": {"http": 200, "body": {"schema_version":1,"status":"AVAILABLE","market_state":"OPEN",
            "trading_date":"2026-10-13","completeness":"5/5","c4_version":VERSION,"as_of":stamp,
            "tickers":{**{s:{**snapshot["items"][s],"status":"AVAILABLE","quote_as_of":stamp,"quote_source":"MIS_Z"}
                       for s in REQUIRED_SYMBOLS},"009815":{"status":"WAIT_NATIVE","freshness":"WAIT_NATIVE","score":None}}}},
        "repo_artifact": copy.deepcopy(artifact),
        "public_artifact": copy.deepcopy(artifact), "deployed_artifact": copy.deepcopy(artifact),
        "artifact_commit_sha": "b"*40, "pages": {"state": "success", "sha": "c"*40, "commit_included": True},
        "schedule_runs": [{"event": "schedule", "created_at": stamp}]}


class OperationsTests(unittest.TestCase):
    def test_complete_publication_requires_all_three_links(self):
        e = evidence()
        self.assertEqual(publication_verification(e), "PUBLISHED_VERIFIED")
        self.assertEqual(evaluate(e, NOW, "TRADING_DAY")["alerts"], [])
        for field in ("artifact_commit_sha", "pages", "deployed_artifact", "public_artifact"):
            bad = copy.deepcopy(e)
            bad.pop(field)
            self.assertNotEqual(publication_verification(bad), "PUBLISHED_VERIFIED", field)
        bad = copy.deepcopy(e)
        bad["pages"]["commit_included"] = False
        self.assertEqual(publication_verification(bad), "PAGES_DEPLOYMENT_UNVERIFIED")
        bad = copy.deepcopy(e)
        bad["public_artifact"]["snapshots"][0]["items"]["0050"]["score"] = 99
        self.assertEqual(publication_verification(bad), "PUBLIC_ARTIFACT_UNVERIFIED")
        bad = copy.deepcopy(e)
        bad["repo_artifact"]["snapshots"][0]["items"]["0050"]["score"] = None
        self.assertEqual(publication_verification(bad), "ARTIFACT_CONTRACT_INVALID")

    def test_http_scheduler_and_github_schedule_failures_are_independent(self):
        for name, code in (("health", 404), ("live", 500)):
            e = evidence()
            e[name]["http"] = code
            self.assertIn(name.upper()+"_ENDPOINT_UNAVAILABLE", evaluate(e, NOW, "TRADING_DAY")["alerts"])
        e = evidence()
        e["health"]["body"]["scheduler"]["status"] = "STALLED"
        e["schedule_runs"] = []
        alerts = evaluate(e, NOW, "TRADING_DAY")["alerts"]
        self.assertIn("SCHEDULER_STOPPED", alerts)
        self.assertIn("GITHUB_SCHEDULE_DELAY_OR_MISSING", alerts)

    def test_invalid_quotes_fail_closed_without_fabricating_prices(self):
        for invalid in ("old", "null", "incomplete", "version", "source_date", "source"):
            e = evidence()
            s = e["public_artifact"]["snapshots"][0]
            if invalid == "old":
                for row in s["items"].values():
                    row["market_as_of"] = (NOW-timedelta(seconds=601)).isoformat()
            elif invalid == "null": s["items"]["0050"]["score"] = None
            elif invalid == "incomplete": s["items"].pop("0050")
            elif invalid == "version": s["score_version"] = "UNKNOWN"
            elif invalid == "source_date": s["trading_date"] = "2026-10-08"
            else: s["source"]["quote_sources"]["0050"] = "UNVERIFIED_PROVIDER"
            before = copy.deepcopy(e)
            self.assertIn("NO_VALID_SNAPSHOT_OVER_600S", evaluate(e, NOW, "TRADING_DAY")["alerts"], invalid)
            self.assertEqual(e, before)

    def test_closed_holiday_unknown_and_opening_grace(self):
        e = evidence()
        e["public_artifact"] = {}
        self.assertNotIn("NO_VALID_SNAPSHOT_OVER_600S", evaluate(e, NOW.replace(hour=16), "TRADING_DAY")["alerts"])
        self.assertNotIn("NO_VALID_SNAPSHOT_OVER_600S", evaluate(e, NOW, "HOLIDAY")["alerts"])
        self.assertIn("TRADING_CALENDAR_UNKNOWN", evaluate(e, NOW, "UNKNOWN")["alerts"])
        self.assertNotIn("NO_VALID_SNAPSHOT_OVER_600S", evaluate(e, NOW.replace(hour=9, minute=5), "TRADING_DAY")["alerts"])

    def test_accepted_dispatch_cannot_hide_a_continuously_stale_repo(self):
        e = evidence()
        e["repo_artifact"]["snapshots"][0]["calculated_at"] = (NOW-timedelta(minutes=15)).isoformat()
        e["repo_artifact"]["snapshots"][0]["source"]["input_fingerprint"] = "d"*64
        self.assertIn("DISPATCH_WITHOUT_ARTIFACT_COMMIT", evaluate(e, NOW, "TRADING_DAY")["alerts"])

    def test_free_or_serverless_profile_never_sends_keepalive_probes(self):
        for profile in ("", "free", "serverless"):
            with patch.dict(os.environ, {"HS_OPS_RUNTIME_PROFILE": profile}), patch("scripts.check_c4_operations.get_json") as fetch:
                with self.assertRaisesRegex(RuntimeError, "MONITOR_PROFILE_NOT_APPROVED"):
                    collect(None)
                fetch.assert_not_called()

    def test_existing_github_fallback_provenance_contract_is_supported(self):
        e = evidence()
        s = e["public_artifact"]["snapshots"][0]
        s["source"].pop("quote_sources")
        s["source"].update(provider="TWSE_MIS", required_symbols="5/5")
        self.assertNotIn("NO_VALID_SNAPSHOT_OVER_600S", evaluate(e, NOW, "TRADING_DAY")["alerts"])
        s["source"]["provider"] = "UNKNOWN"
        self.assertIn("NO_VALID_SNAPSHOT_OVER_600S", evaluate(e, NOW, "TRADING_DAY")["alerts"])

    def test_large_tracked_archive_uses_immutable_blob_without_download_url(self):
        import base64, json
        artifact=evidence()["repo_artifact"]
        blob="d"*40
        responses=[
            {"http":200,"body":{"encoding":"none","size":6425561,"sha":blob,"download_url":"https://untrusted.invalid/"}},
            {"http":200,"body":{"encoding":"base64","content":base64.b64encode(json.dumps(artifact).encode()).decode()}},
        ]
        with patch("scripts.check_c4_operations.get_json",side_effect=responses) as fetch:
            self.assertEqual(artifact_at_ref("main","fixture-token"),artifact)
            self.assertEqual(fetch.call_args_list[1].args,(API+"/git/blobs/"+blob,"fixture-token"))
            self.assertTrue(all(call.args[0].startswith(API) for call in fetch.call_args_list))
        with patch("scripts.check_c4_operations.get_json",return_value={"body":{"encoding":"none","sha":"../other"}}) as fetch:
            self.assertEqual(artifact_at_ref("main","fixture-token"),{})
            self.assertEqual(fetch.call_count,1)

    def test_monitor_rejects_the_same_missing_display_asof_native_contract_as_frontend(self):
        for missing in ("display_score", "as_of", "native"):
            e=evidence()
            if missing=="display_score": e["live"]["body"]["tickers"]["0050"]["display_score"]=None
            elif missing=="as_of": e["live"]["body"]["as_of"]=None
            else: e["live"]["body"]["tickers"].pop("009815")
            self.assertIn("LIVE_API_DATA_INVALID",evaluate(e,NOW,"TRADING_DAY")["alerts"],missing)

    def test_monitor_credentials_do_not_follow_cross_origin_redirects(self):
        from urllib.request import Request
        request=Request(API+"/contents/file",headers={"Authorization":"Bearer fixture-token","Cookie":"private-fixture","Proxy-Authorization":"proxy-fixture"})
        handler=SafeRedirect()
        other=handler.redirect_request(request,None,302,"redirect",{},"https://other.invalid/file")
        self.assertIsNone(other.get_header("Authorization"))
        self.assertIsNone(other.get_header("Cookie"))
        self.assertIsNone(other.get_header("Proxy-authorization"))
        same=handler.redirect_request(request,None,302,"redirect",{},API+"/contents/renamed")
        self.assertEqual(same.get_header("Authorization"),"Bearer fixture-token")
        with self.assertRaises(ValueError): get_json("https://other.invalid/file","fixture-token")


if __name__ == "__main__":
    unittest.main()
