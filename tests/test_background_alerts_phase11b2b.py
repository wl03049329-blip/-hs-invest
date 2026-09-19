from __future__ import annotations
import json, tempfile, unittest
from datetime import datetime, timezone
from pathlib import Path
from backend.background_alerts import BackgroundAlertError, ENGINE_VERSION, RULES_VERSION, run_bridge, validate_rules, finalized_context, BackgroundAlertEvaluator
from backend.push_service import ALERT_PAYLOAD_VERSION, PushConfig, PushService
from backend.push_store import PushSubscriptionStore

SUB={"endpoint":"https://fcm.googleapis.com/fcm/send/b2b","keys":{"p256dh":"A"*87,"auth":"B"*22}}
CONFIG=PushConfig("B"+"A"*86,"private-test-only","https://example.test")
RULE={"cross_level":True,"downward_cross":True,"levels":"ALL","score_enabled":True,"score_threshold":40,"distance":2,"percentile_enabled":True,"percentiles":[85,90,95],"data_status":True,"data_recovery":True}
PREF={"version":"HS_RADAR_ALERT_RULES_V1","global":RULE,"etfs":{}}

def row(symbol,score,date): return {"symbol":symbol,"final_core_score":score,"display_score":int(score),"trading_date":date,"core_score_version":"FINAL_CORE_WEIGHT_V1"}
def bridge_transition(before,after,rules=RULE,research=None):
    base=run_bridge({"preferences":{"version":"HS_RADAR_ALERT_RULES_V1","global":rules,"etfs":{}},"state":None,"symbols":[{"symbol":"00830","current":row("00830",before,"2026-09-18"),"previous":row("00830",before,"2026-09-18"),"research_path":research}]})
    return run_bridge({"preferences":{"version":"HS_RADAR_ALERT_RULES_V1","global":rules,"etfs":{}},"state":base["state"],"symbols":[{"symbol":"00830","current":row("00830",after,"2026-09-19"),"previous":row("00830",before,"2026-09-18"),"research_path":research}]})
def artifact(scores):
    dates=[f"2026-09-{17+i:02d}" for i in range(len(scores))]
    return {"schema_version":1,"core_score_version":"FINAL_CORE_WEIGHT_V1","snapshots":[{"date":date,"snapshot_type":"FINALIZED_CLOSE","finalized":True,"rows":[{"symbol":"00830","final_core_score":score,"core_score_version":"FINAL_CORE_WEIGHT_V1"},{"symbol":"009815","final_core_score":None,"status":"WAIT_NATIVE"}]} for date,score in zip(dates,scores)]}

class BackgroundAlertTests(unittest.TestCase):
    def test_01_engine_version(self): self.assertEqual(ENGINE_VERSION,"HS_BACKGROUND_ALERT_ENGINE_V1")
    def test_02_29_to_30_parity(self): self.assertIn("CROSS_LEVEL",[a["rule_type"] for a in bridge_transition(29,30)["alerts"]])
    def test_03_39_to_40_parity(self): self.assertIn("CROSS_LEVEL",[a["rule_type"] for a in bridge_transition(39,40)["alerts"]])
    def test_04_44_to_45_parity(self): self.assertIn("CROSS_LEVEL",[a["rule_type"] for a in bridge_transition(44,45)["alerts"]])
    def test_05_49_to_50_parity(self): self.assertIn("CROSS_LEVEL",[a["rule_type"] for a in bridge_transition(49,50)["alerts"]])
    def test_06_downward_46_to_43(self): self.assertIn("CROSS_LEVEL",[a["rule_type"] for a in bridge_transition(46,43)["alerts"]])
    def test_07_score_threshold_display_floor(self): self.assertNotIn("SCORE_THRESHOLD",[a["rule_type"] for a in bridge_transition(39,39.9)["alerts"]])
    def test_08_distance_trigger(self): self.assertIn("NEXT_LEVEL",[a["rule_type"] for a in bridge_transition(36,38)["alerts"]])
    def test_09_same_etf_bundles_once(self):
        result=bridge_transition(39,40); self.assertEqual(len(result["bundles"]),1); self.assertGreaterEqual(len(result["bundles"][0]["alerts"]),2)
    def test_10_rule_validation_accepts_valid(self): self.assertEqual(validate_rules(PREF,{"00830"})["version"],"HS_RADAR_ALERT_RULES_V1")
    def test_11_invalid_score_rejected(self):
        bad=json.loads(json.dumps(PREF));bad["global"]["score_threshold"]="40"
        with self.assertRaises(BackgroundAlertError): validate_rules(bad,{"00830"})
    def test_12_invalid_distance_rejected(self):
        bad=json.loads(json.dumps(PREF));bad["global"]["distance"]=3
        with self.assertRaises(BackgroundAlertError): validate_rules(bad,{"00830"})
    def test_13_unknown_etf_rejected(self):
        bad=json.loads(json.dumps(PREF));bad["etfs"]={"HACK":{"mode":"inherit","rules":RULE}}
        with self.assertRaises(BackgroundAlertError): validate_rules(bad,{"00830"})
    def test_14_new_subscription_baseline_zero(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root,"final.json");path.write_text(json.dumps(artifact([39])),encoding="utf-8");sent=[];service=PushService(PushSubscriptionStore(root),config=CONFIG,sender=lambda **kw:sent.append(kw));sid=service.subscribe(SUB,user_agent="Chrome")["subscription_id"];result=BackgroundAlertEvaluator(service,finalized_path=path).sync_rules(sid,PREF);self.assertEqual(result["pending_push_count"],0);self.assertEqual(sent,[])
    def test_15_same_fingerprint_no_duplicate(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root,"final.json");path.write_text(json.dumps(artifact([39])),encoding="utf-8");sent=[];service=PushService(PushSubscriptionStore(root),config=CONFIG,sender=lambda **kw:sent.append(kw));sid=service.subscribe(SUB,user_agent="Chrome")["subscription_id"];e=BackgroundAlertEvaluator(service,finalized_path=path);e.sync_rules(sid,PREF);self.assertEqual(e.evaluate_once()["bundle_count"],0);self.assertEqual(sent,[])
    def test_16_new_finalized_sends_one_bundle_and_restart_dedups(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root,"final.json");path.write_text(json.dumps(artifact([39])),encoding="utf-8");sent=[];store=PushSubscriptionStore(root);service=PushService(store,config=CONFIG,sender=lambda **kw:sent.append(kw));sid=service.subscribe(SUB,user_agent="Chrome")["subscription_id"];e=BackgroundAlertEvaluator(service,finalized_path=path,enabled=True);e.sync_rules(sid,PREF);e.evaluate_once();path.write_text(json.dumps(artifact([39,40])),encoding="utf-8");self.assertEqual(e.evaluate_once()["push_success_count"],1);restarted=BackgroundAlertEvaluator(PushService(PushSubscriptionStore(root),config=CONFIG,sender=lambda **kw:sent.append(kw)),finalized_path=path,enabled=True);self.assertEqual(restarted.evaluate_once()["bundle_count"],0);self.assertEqual(len(sent),1)
    def test_17_payload_preserves_ids_and_route(self):
        captured={}
        with tempfile.TemporaryDirectory() as root:
            service=PushService(PushSubscriptionStore(root),config=CONFIG,sender=lambda **kw:captured.update(kw));sid=service.subscribe(SUB,user_agent="Chrome")["subscription_id"];bundle=bridge_transition(39,40)["bundles"][0];service.send_alert_bundle(sid,bundle,now=datetime(2026,9,19,tzinfo=timezone.utc))
        payload=json.loads(captured["data"]);self.assertEqual(payload["version"],ALERT_PAYLOAD_VERSION);self.assertEqual(payload["route"],"?radarEtf=00830");self.assertEqual(set(payload["alert_ids"]),{a["alert_id"] for a in bundle["alerts"]})
    def test_18_simulation_uses_test_namespace(self):
        captured={}
        with tempfile.TemporaryDirectory() as root:
            service=PushService(PushSubscriptionStore(root),config=CONFIG,sender=lambda **kw:captured.update(kw));sid=service.subscribe(SUB,user_agent="Chrome")["subscription_id"];service.send_alert_simulation(sid,now=datetime(2026,9,19,tzinfo=timezone.utc))
        payload=json.loads(captured["data"]);self.assertEqual(payload["type"],"TEST_ETF_ALERT_BUNDLE");self.assertTrue(payload["alert_ids"][0].startswith("TEST:"))
    def test_19_transient_push_retries_once(self):
        calls=[]
        class TemporaryError(RuntimeError):
            status_code=503
        def sender(**kw):
            calls.append(kw)
            if len(calls)==1: raise TemporaryError()
        with tempfile.TemporaryDirectory() as root:
            service=PushService(PushSubscriptionStore(root),config=CONFIG,sender=sender);sid=service.subscribe(SUB,user_agent="Chrome")["subscription_id"];service.send_alert_bundle(sid,bridge_transition(39,40)["bundles"][0])
        self.assertEqual(len(calls),2)
    def test_20_two_etfs_bundle_separately(self):
        base=run_bridge({"preferences":PREF,"state":None,"symbols":[{"symbol":s,"current":row(s,39,"2026-09-18"),"previous":row(s,39,"2026-09-18"),"research_path":None} for s in ("0050","00830")]})
        result=run_bridge({"preferences":PREF,"state":base["state"],"symbols":[{"symbol":s,"current":row(s,40,"2026-09-19"),"previous":row(s,39,"2026-09-18"),"research_path":None} for s in ("0050","00830")]})
        self.assertEqual({bundle["etf"] for bundle in result["bundles"]},{"0050","00830"})

if __name__=="__main__": unittest.main(verbosity=2)
